# MTG Cube — Architecture Spec

Upload a cube list → draft with friends (bots fill empty seats) → build decks → play 1v1 matches. Server is authoritative for ALL state; clients render views and send intents.

## Monorepo layout (npm workspaces)

- `packages/shared` (`@mtg-cube/shared`) — pure TS, no deps. Types (`src/types.ts`), socket contract (`src/events.ts`), seeded RNG, cube parser, **draft engine** (`src/draft/engine.ts`), **game engine** (`src/game/engine.ts`), **view redaction** (`src/game/view.ts`). Exports raw TS source (consumers compile it: tsx on server, Vite on web). Tests with vitest in `test/`.
- `apps/server` (`@mtg-cube/server`) — Node + Express + Socket.IO (port **3001**). Runs with `tsx watch`. In-memory state (Map of rooms). Resolves cube lists via Scryfall `POST /cards/collection` (batches of 75).
- `apps/web` (`@mtg-cube/web`) — Vite + React 18 + TypeScript + Tailwind (port **5173**, proxy not needed; socket.io-client connects to `http://localhost:3001` via `VITE_SERVER_URL` fallback).

## Invariants (the "dependable" contract)

1. Only the server mutates state, and only through the pure functions in `@mtg-cube/shared`. Every game mutation is a `GameAction` applied by `applyAction`; invalid actions throw `EngineError` and the server acks `{ok:false,error}` without state change.
2. Hidden information never leaves the server: `buildGameView(state, viewerId, cards)` replaces opponent hand + both libraries with placeholder cards (`cardId: "hidden"`), preserving counts and instanceIds ONLY for the viewer's own cards. Draft views show only your own current pack.
3. All shuffles/pack generation use `createRng(seed)` — deterministic and testable.
4. `GameState.seq` increments on every applied action; clients ignore stale views (lower seq).
5. Reconnect: client stores `{roomId, playerId, token}` in localStorage; `joinRoom` with token reclaims the seat and the server re-emits current room/draft/game views.

## Draft engine (packages/shared/src/draft/engine.ts) — signatures

```ts
createDraft(cube: Cube, config: DraftConfig): DraftState  // shuffles cube, deals seatCount*packsPerPlayer packs of cardsPerPack; throws if cube too small
openNextPacks(state: DraftState): DraftState              // called at round start
applyPick(state: DraftState, seatIndex: number, instanceId: string): DraftState
  // removes card from seat's head pack into picks; passes pack (left on odd packNumber, right on even);
  // when all packs in a round are empty → advance packNumber or mark complete
runBotPicks(state: DraftState, rng: Rng): DraftState      // every bot seat with a waiting pack picks (heuristic: prefer colors it has most picks in, weight by cmc curve; random tiebreak)
getDraftView(state: DraftState, seatIndex: number, playerNames: (string|null)[], pickDeadline: number|null): DraftView
```
All pure (return new state). Pick timer enforcement lives on the server (auto-pick random on expiry).

## Game engine (packages/shared/src/game/engine.ts) — signatures

```ts
createGame(id: string, players: [{playerId, deck: GameCard[] (library, already built)}, ...], seed: string): GameState
  // shuffle libraries, roll starting player from seed, draw 7 each, life 20
applyAction(state: GameState, actorId: string, action: GameAction): GameState  // pure; throws EngineError on invalid
```
Rules the engine ENFORCES: zone integrity (a card is in exactly one zone), turn/step order (`nextStep` walks TURN_STEPS; untap step auto-untaps active player's permanents; draw step auto-draws except first turn for starting player; cleanup clears damage + empties mana pools; `nextTurn` swaps active player), priority tracking, mulligans (shuffle hand back, draw one fewer, London bottom via `keepHand`), token cleanup (tokens cease to exist when leaving battlefield), attachment cleanup (detach on zone change), state-based checks after every action (player at ≤0 life or ≥10 poison loses; game.finished + winnerId set; drawing from empty library loses), concede.
Card EFFECTS are manual: players move cards, tap, add counters/mana, create tokens via explicit actions. The stack is a real zone: casting = `moveCard` to `stack`; `resolveTopOfStack` moves top to battlefield (permanents by typeLine) or graveyard (instants/sorceries) — engine decides by typeLine; `counterTopOfStack` → graveyard.
Permission checks: you may only manipulate cards you control/own (opponent's cards untouchable except via nothing — v1 has no forced actions), only set your own life/mana; either player may use `setLife` on themselves only; `nextStep`/`nextTurn` only by active player; `resolveTopOfStack`/`counterTopOfStack` by either.

`src/game/view.ts`: `buildGameView(state, viewerId, cards)` per invariant 2, plus `revealHand` flag handling.

## Server responsibilities

Rooms (6-char code), host controls (upload cube, start draft, pair matches). Draft loop: after every human pick or timer expiry, `runBotPicks`, broadcast fresh `DraftView` to each seat. Deckbuild: server holds each player's picks; `submitDeck` validates every main/side instanceId belongs to that player's picks, injects basic lands (fetch the 5 basics from Scryfall at boot, or hardcode their CardData). Matches: multiple concurrent 1v1 games per room; spectators get a redacted view with BOTH hands hidden. Persist nothing (v1, in-memory).

## Web app screens

1. **Home** — create room / join by code, player name.
2. **Lobby** — player list, cube upload (paste textarea + file), unresolved-lines warning, draft config, start (host).
3. **Draft** — current pack grid (card images, hover zoom), your picks tray grouped by color/cmc, seat status strip, timer.
4. **Deckbuild** — picks pool ↔ deck drag/click, basic-land stepper, curve chart, submit.
5. **Game board** — two-sided battlefield (lands/creatures/other rows), hand fan, library/graveyard/exile piles with counts + browse modals, stack panel, life/poison/mana controls, phase ribbon with step advance, attack/block toggles, token dialog, scry/reveal dialogs, game log, concede. Context menu (right-click) on cards for actions. Card hover = large preview.

Dark, polished "tabletop" aesthetic. Tailwind. No component library required; keep deps light. Card images come from `CardData.imageNormal`/`imageSmall` (Scryfall CDN) with a styled text fallback.

## Accounts, saved cubes & ranked matchmaking (v2)

**Persistence**: SQLite via Node built-in `node:sqlite` (`DatabaseSync`), no native deps. `DB_PATH` env (default `apps/server/data/mtg-cube.db`; production `/app/data/mtg-cube.db` on a Railway volume). All SQL lives in `apps/server/src/db.ts` (DAL) with idempotent boot migrations. Tables: users(id, username UNIQUE COLLATE NOCASE, password_hash, created_at), sessions(token_hash PK, user_id, created_at, expires_at), cubes(id, owner_id, name, list_text, cards_json, card_count, unresolved_json, ranked_eligible, created_at, updated_at), ratings(user_id PK, rating, wins, losses, draws), ranked_matches(id, user_a, user_b, winner_user_id NULL, delta_a, delta_b, ts).

**Auth**: bcryptjs (cost 10). Usernames 3-20 chars `[A-Za-z0-9_]`, case-insensitive unique; passwords 8-100 chars. Session tokens nanoid(32), stored SHA-256 hashed, 90-day expiry, verified per socket via `authenticate`. In-memory rate limit: 10 failed logins per username+IP per 15 min. A socket has at most one bound account; account state also rides on the existing room reconnect flow.

**Saved cubes**: `saveCube` re-resolves the list via Scryfall and stores both raw text and resolved CardData JSON. Limits: 30 cubes/account, list <= 500KB. `loadCubeIntoRoom` = host+lobby only, uses stored resolved JSON (no Scryfall hit).

**Elo & ranks** (pure, in `packages/shared/src/ranked.ts`, unit-tested): start 1200, K=32, standard expected-score formula, draw = 0.5. `eloDelta(ratingA, ratingB, scoreA)` returns rounded delta for A (B gets the negative). `rankFor(rating)`: Bronze <1100, Silver <1250, Gold <1400, Platinum <1550, Diamond <1700, Mythic >= 1700.

**Matchmaking queue** (in-memory, authenticated players only): tick every 5s; pair the two closest-rated eligible players. Eligibility window = +/-100 widening by +50 per 10s waited, cap +/-500. On pairing: create a ranked Room (no host: hostId=""), pick a random cube from ranked-eligible saved cubes + the bundled default cube (apps/server/src/defaultCube.ts, ~360 well-known cube staples resolved via Scryfall at first use and cached in the DB as a system cube), config: seatCount = min(8, max(4, floor(cubeSize/45))) with 2 humans + bots, packs 3 x 15 cards, pickTimerSeconds 60 (forced). Emit queueMatched; both clients joinRoom; draft auto-starts once both matched players are in the room (60s deadline - a no-show aborts the room and requeues/notifies the other). Deckbuild: 5-minute deadline then auto-submit (all picks main + 17 basics split by picked colors). Match auto-starts when both decks are in. Ranked rules: endMatch rejected, concede = loss, restartGame rejected; on finish apply Elo, record ranked_matches, update ratings, emit fresh accountState to both.

**Env overrides for testing**: RANKED_SEATS, RANKED_PACKS, RANKED_CARDS, RANKED_PICK_SECONDS, MM_TICK_MS override ranked draft config; document in DEPLOY.md.

**Client**: Home gains sign in / register + a "Play Ranked" panel (queue status, rank badge, cancel). Lobby cube panel gains "Save to my cubes" (with ranked-eligible toggle) and a "My cubes" picker (host). Profile modal: rating, rank, W/L/D, last 20 ranked matches. Ranked rooms render with a ranked banner, no host controls, and visible timers. Account token in localStorage ("mtg-cube-account"), authenticate on connect.

## Admin portal & preloaded ranked cubes (v2.1)

**Admin bootstrap**: `ADMIN_USERNAMES` env (comma-separated, case-insensitive). On register/login/authenticate, if the username matches, persist `is_admin=1` (idempotent; removing a name from the env does NOT revoke — revocation is a future concern). `Account.isAdmin` rides on every accountState. All admin socket events verify the flag server-side per call.

**System cubes**: rows in `cubes` with `owner_id='system'` plus new column `active INTEGER NOT NULL DEFAULT 1` (idempotent ALTER via pragma table_info check). The boot-seeded default cube becomes a system cube named "Classic Cube Staples" (active). Admin events: list/upload (Scryfall-resolved, same limits as saveCube minus the per-owner cap)/set-active/delete. Deleting the last active system cube is allowed only if at least one user-eligible cube exists OR another system cube is active — otherwise reject with a clear error (the ranked pool must never be empty).

**Ranked pool** (matchmaking cube choice): random among ACTIVE system cubes + user cubes with ranked_eligible=1, all filtered for feasibility (>= 4 seats * packs * cards after unresolved dropped).

**Admin portal UI**: new full-screen view reachable from the account dropdown ("Admin portal", only when isAdmin). Sections: (1) stats tiles (users, saved cubes, ranked matches, active rooms, players in queue, user-eligible cubes) via adminGetStats on open + refresh button; (2) system cube table: name, card count, unresolved badge, active toggle, delete (confirm), updated date; (3) upload form: name + paste textarea + .txt file + active-on-upload toggle, with resolve progress state and unresolved-lines report. Route: client-side only (state flag, not URL). Non-admins never see the entry point; server rejects regardless.

## Card scripts, triggers & mana (v3)

**Card scripts** (`packages/shared/src/cardScripts.ts`, pure + unit-tested): `scriptFor(card: CardData): CardScript | null` = `CARD_OVERRIDES[card.name] ?? inferScript(card)`. `inferScript` parses oracle text (front face for DFCs) with template regexes covering, at minimum: ETB/dies/upkeep clause detection ("When(ever) ~/this creature/CARDNAME enters( the battlefield)?", "... dies", "At the beginning of your upkeep"); effects: draw N ("draw a card"/"draw two cards"... number words one-ten), you gain N life, you lose N life, each opponent loses N life, ~ deals N damage to each opponent/any target -> damageOpponent, put N +1/+1 counter(s) on ~/itself, create N X/Y COLOR TYPE creature token(s) (name = subtype words, count words), scry N. "you may" -> optional:true. A detected trigger clause whose effect does not parse yields `{kind:"manual", note:<clause text>}`. Compound clauses ("draw a card, then discard a card") -> manual. Cards with no trigger clauses -> null. Registry starts with ~10 curated cube staples as overrides/examples. Trigger CONDITIONS with no supported event (landfall, "whenever another creature enters", saga chapters, ...) are documented per card in the exported `UNSUPPORTED_TRIGGER_CARDS` registry so the omission is explicit in code rather than silent.

**Engine** (`ActionContext` gains `cards?: Record<cardId, CardData>` and `scripts?: Record<cardId, CardScript>`; server builds scripts once per match and passes both on every applyAction):
- ETB: any card entering the battlefield via moveCard OR resolveTopOfStack pushes its etb triggers onto the stack (controller = card controller). Dies: battlefield->graveyard. Leaves: battlefield->any other zone; if the destination is the graveyard AND the script has a dies trigger, only dies fires (no double-fire). Upkeep: entering the upkeep step pushes upkeep triggers for the ACTIVE player's permanents (battlefield sortIndex order); eachUpkeep fires for BOTH players' permanents (controller = permanent's controller). EndStep: entering the end step, active player's permanents. Attack: setAttacking {attacking:true} (never on un-declaring or redundant re-declares). CastSpell: moveCard from hand/graveyard/exile/library to the stack fires castSpell triggers on the caster's OWN battlefield permanents, honoring each trigger's castFilter (any/instantOrSorcery/noncreature/creature/artifact) against the cast card's front-face typeLine; triggers land ABOVE the cast spell. CombatDamageToPlayer: entering the combatDamage step, each attacking creature of the active player with no opposing creature blocking it (counter the trigger when the damage was actually prevented). Trigger stack entries are pseudo-GameCards: instanceId `tr{seq}-{n}`, isTrigger, cardId = source card id (so the client can render the card), controllerId/ownerId = controller, triggerText/Effect/Optional/SourceId set.
- resolveTopOfStack on a trigger applies the effect mechanically (draw/life/damage/counters-on-source-if-still-on-battlefield/token/scry-log/manual-log) for its CONTROLLER, with normal state-based checks. counterTopOfStack on a trigger removes it (logged). declineTrigger: controller only, optional only, any position in the stack.
- tapForMana: card must be actor-controlled, on battlefield, untapped, and `color` must be in cards[cardId].producedMana (C allowed when produced); taps + adds 1 of color to pool, one log line.
- Mana pools now empty at EVERY step transition (nextStep and nextTurn), both players, matching "floating mana until end of step/phase"; cleanup no longer special-cases it. Existing tests updated accordingly.

**Client**: StackPanel renders triggers distinctly (source card thumbnail + ability text + Resolve / Decline-when-optional; pop-in animation + amber glow when a new trigger appears; resolve button gated to stack order). Tapping a land/mana source: single produced color -> one tapForMana click; multi -> small color picker popover; non-producers keep plain tap. Floating-mana display: when your pool is non-empty, a prominent glowing pip strip appears docked above your hand ("empties at end of step" hint), synced to the side-rail ManaPool.
