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

## Action restrictions & fetch searches (v4)

**Draw restriction**: `drawCard` without `override:true` is rejected ("Draws come from the draw step or card effects..."). The draw step auto-draw and all scripted effects are engine-internal and unaffected. `override:true` works but logs `drew N card(s) (manual override)`. UI: the side-rail Draw button is removed; the library context menu keeps a buried "Draw (manual override)" with a confirm dialog explaining it is for manually-resolved card text.

**Spell resolution scripts**: `resolveTopOfStack` is now typeLine-aware via ctx.cards — instants/sorceries go to their owner's GRAVEYARD (not battlefield) and apply `script.onResolve.effects` mechanically (same TriggerEffect executor as triggers; effects resolve for the spell's controller). Inference: for instant/sorcery cards, parse standalone effect lines (Draw N / gain-lose life / each opponent loses / scry / token creation); ANY unparseable line -> onResolve undefined (whole-spell manual, log the resolution as before) — partial automation of a spell is worse than none. Permanents keep the existing battlefield+ETB path. moveCard stack->graveyard stays legal (manual fallback).

**Activated fetch searches**: cardScripts gains `activated: ActivatedSearchAbility[]` (inference templates: Evolving Wilds/Terramorphic "{T}, Sacrifice: search basic land, battlefield tapped, shuffle"; true fetches "Pay 1 life, Sacrifice: search for a X or Y card, battlefield [untapped], shuffle"; Prismatic Vista basic+1life; hand-destination tutors-to-hand variants if templated cleanly). `activateAbility` validates: source on actor's battlefield, ability exists, untapped if costTap; pays costs atomically (tap; sacrifice -> graveyard via the normal leaves/dies machinery incl. triggers; life loss with state-based check) then sets `GameState.pendingSearch`. While pendingSearch is set: the searching player may ONLY send completeSearch or concede; the opponent plays on normally; restartGame/endMatch clear it. `completeSearch`: null = fail to find (log + shuffle if configured); otherwise the chosen instanceId must be in the searcher's library AND match the filter via ctx.cards typeLine (basicLand = type line contains "Basic" and "Land"; landSubtype = contains any listed subtype word) -> move to destination (entersTapped applies for battlefield), shuffle (seeded rng from `${state.id}:search:${seq}`), clear pendingSearch, ETB triggers fire for battlefield arrivals.

**View redaction**: while pendingSearch belongs to the viewer, view.ts reveals the viewer's OWN library cards (real cardIds, order preserved) so the search modal can render; the cards record includes them. Opponent's view: pendingSearch metadata is visible (a "searching their library..." chip) but their library stays hidden as always.

**Client**: fetch lands get a gold "Activate" affordance (click opens context menu with the ability description; battlefield context menu lists activated abilities). Search modal: grid of ONLY eligible library cards (filter applied client-side for display, engine re-validates), "Fail to find" ghost button, blocks other interactions until resolved; opponent sees the searching chip near the phase ribbon. Side-rail Draw button removed per above.

## Admin engine sandbox (v4.1)

Purpose: let an admin instantly enter a live match and pull ANY card into it to observe how its script/triggers behave — no room setup, no draft, no deckbuild.

**Sandbox rooms**: `Room.sandbox: boolean` (default false, surfaced on `RoomState`). Created ONLY by `sandboxStart` (admin-verified per call, like the other admin events). The room skips straight to `phase: "playing"` with two players: the admin and a phantom opponent named "Goldfish" (a normal RoomPlayer with no socket, connected=false). Both decks are 30 basic lands (6 of each) so draw steps and searches work; the match starts immediately via the normal `createGame` path (shuffle, roll, draw 7). The admin is host. Hidden-information redaction is UNCHANGED (golden rule 2): the admin sees one seat's hand at a time and uses seat switching to inspect/drive the other side. Leaving a sandbox room tears it down immediately (the phantom can never keep it alive); ranked/matchmaking never touch sandbox rooms.

**`spawnCard` engine action** (`{ type: "spawnCard"; cardId; zone: SpawnZone }`, `SpawnZone = hand|battlefield|library|graveyard|exile|stack`): conjures a fresh GameCard (instanceId `sb{seq}`, owner/controller = actor) of a cardId that MUST be present in `ctx.cards` (the server registers the CardData first; a context-less engine rejects). Battlefield spawns land like any other arrival: sortIndex assigned and **etb triggers fire**; stack spawns sit on the shared stack and resolve through the normal `resolveTopOfStack` machinery (instant/sorcery -> graveyard + onResolve, permanent -> battlefield + etb); library spawns go on TOP. Loudly logged: "conjured X into their Y (sandbox)". The engine implements it generically; the SERVER gates it — `gameAction` rejects `spawnCard` unless the room is a sandbox (same pattern as ranked rejecting endMatch/restartGame).

**Socket events** (all require admin; the latter two also require being in a sandbox room):
- `sandboxStart(ack -> {roomId, playerId, token})`: leave current room, create the sandbox room + match, join it. The client establishes a normal session and lands on the Game screen.
- `sandboxAddCard({name, zone, playerId?}, ack -> {cardName})`: resolve `name` via the existing Scryfall resolution (cache + exact + fuzzy — any real card works, not just cube cards); register the CardData in `match.cardLookup` and its `scriptFor` script in `match.scripts`; then apply `spawnCard` AS `playerId` (must be one of the match players; default = the caller's current seat). Ack returns the resolved card name.
- `sandboxSwitchSeat(ack -> {playerId, token, name})`: rebind the admin's socket to the other sandbox seat (connected flags + socketId move too) and re-emit views. The client swaps its session to the returned identity — the whole Game UI simply re-renders from the other perspective, so both sides can be driven with zero new game-UI code.

**Client**: Home shows an admin-only "Engine sandbox" panel (one click -> sandboxStart -> Game screen). On the Game screen a sandbox toolbar (rendered only when `room.sandbox`) offers: card-name input + zone picker + target seat, wired to `sandboxAddCard`; and "Switch seat" wired to `sandboxSwitchSeat` (updates the stored session with the returned playerId/token). Everything else reuses the existing board UI, stack panel, context menus, and log.

## Casting-cost enforcement, land drops & auto-pass (v5)

Grounded in the Comprehensive Rules corpus now checked into `docs/rules/` (queried via the `mtg-rules` subagent, `.claude/agents/mtg-rules.md`): CR 305.1/305.2/305.4 + 505.6b (land plays), CR 601.2f-h + 106.4 + 118.5 (paying costs, pool mana, {0}), CR 117.1a + 702.8a + 500.2 (instant/flash timing, phases end on pass with empty stack).

**Mana module** (`packages/shared/src/game/mana.ts`, pure + unit-tested):
- `parseManaCost(cost?: string): ParsedManaCost | null` — parses `{2}{U}{U}` style strings into `{ generic, pips: Record<WUBRGC, n>, hybrids: string[][], x }`. Two-option hybrids (`{W/U}`, `{2/W}`) become choice lists. `{X}` counts as 0 (X chosen manually; log notes it). ANY other symbol (phyrexian, snow, ...) -> null = "unenforceable" (the cast is allowed and loudly logged as not cost-checked — wrong automation is worse than none). A missing/empty mana cost also returns null.
- `manaSourcesOf(player, cards)` — untapped, face-up battlefield cards whose CardData has producedMana (colors filtered to WUBRGC). Each source produces ONE mana per tap (known limitation: Sol Ring pays 1; same as tapForMana).
- `planManaPayment(cost, pool, sources)` -> `{ fromPool, taps: [{instanceId, color}] } | null` — pool mana is spent first (CR 106.4 "can be used to pay costs immediately"), then untapped sources are auto-tapped (the engine activating mana abilities on the caster's behalf, CR 601.2g). Colored pips are matched most-constrained-first with backtracking (dual lands never strand a payable cost); generic is paid from leftovers preferring colorless and least-flexible sources. null = cannot pay.

**Engine — casting pays (CR 601.2h)**: `moveCard` gains `override?: boolean`. When a card moves from HAND to STACK or HAND to BATTLEFIELD (the two cast paths) and its front-face type line is not a Land and `faceDown` is not being set (morph stays manual) and `override` is not true: parse its mana cost. Parseable -> `planManaPayment` against the actor's pool + sources; failure throws EngineError naming the unpaid cost; success deducts pool, taps the planned sources, and logs one line ("cast X paying {1}{U} — tapped Island, Plains; spent {U} from pool"). `{0}`/free after parse -> no payment, no log noise. Unparseable cost -> allowed, logged "(cost not auto-enforced)". Casts from graveyard/exile/library keep v4 behavior plus a "(cost not enforced)" log note. `override:true` skips payment and is loudly logged ("without paying its cost") — the escape hatch for alternative costs (CR 601.2b) and cost reducers.

**Engine — land drops (CR 305.2a-b)**: `moveCard` hand->battlefield of a front-face Land increments `landsPlayedThisTurn` and is REJECTED when the count is already >= 1 unless `override:true` ("additional land play" effects, CR 305.2; loudly logged). Only actual plays count: fetch-land `completeSearch`, `resolveTopOfStack`, and sandbox `spawnCard` arrivals are "put onto the battlefield" (CR 305.4) and neither count nor check. Counts reset on turn change (already) and on restartGame.

**Auto-pass ("Auto mode", client-side, CR 500.2/117.1a-inspired)**: castability is computable client-side from the viewer's own view (own hand + own pool + own producedMana), so the server stays unchanged. Shared helper `hasInstantSpeed(data)` (front-face type line contains Instant, or oracle text grants Flash). A hand card is "castable now" when its parsed cost is payable via `planManaPayment` (unparseable counts as castable — never auto-skip what we can't judge). Game screen gains an Auto toggle (per client, default off, persisted per game in memory):
- Active player, auto on: entering untap/upkeep/draw/beginCombat/endCombat/end/cleanup with an EMPTY stack, no pendingSearch, and no castable instant-speed card -> auto `nextStep` after a short delay (~700ms so log/triggers stay readable). declareAttackers auto-advances only when they control no untapped creature; declareBlockers only when the OPPONENT has no untapped creature (their block window). combatDamage auto-advances when the stack stays empty. Main phases NEVER auto-advance.
- Non-active player, auto on: holding priority with an empty stack and no castable instant-speed card -> auto `passPriority`.
- Any trigger/spell on the stack, a pendingSearch, mulligan not resolved, or game finished suspends auto. One auto action per seq (loop guard).

**Client**: hand-card context menu gains "Cast without paying (override)" and, for lands after the first, "Play as additional land (override)"; normal click/drag just auto-pays. Rejections surface as the server's EngineError toast. Auto toggle lives next to the phase ribbon with an active glow; flipping seats in the sandbox keeps it per-viewer.
