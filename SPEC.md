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

## Targeted triggers, opponent-draw event & amass (v6)

Grounded in docs/rules: CR 115.4 ("any target" = creatures, players, planeswalkers, battles), CR 701.47a (amass), CR 121.2 (multi-card draws are N individual draws), CR 603.3d/608.2b (target timing/legality). DELIBERATE DEVIATION: real Magic chooses trigger targets when the ability goes on the stack (603.3d); this engine chooses them when the trigger RESOLVES — triggers enter the stack mid-action where no UI prompt is possible, and resolution-time choice matches the manual-first table feel. Target legality is validated at resolution (spirit of 608.2b).

**Types**: `TargetRef = { kind: "player"; playerId } | { kind: "permanent"; instanceId }`. `TriggerEvent` gains `opponentDraws`. `TriggerEffect` gains:
- `{ kind: "damageAnyTarget"; amount }` — needs a TargetRef at resolution; player -> lose that much life, permanent -> add marked damage (creature death stays manual as ever).
- `{ kind: "amass"; subtype; count }` — CR 701.47a mechanically: if the controller has no battlefield card whose (token)type line contains "Army", create a 0/0 black `<subtype> Army` token (`Token Creature — <subtype> Army`); then put `count` +1/+1 counters on the first Army (battlefield order). Subtype-addition to a non-matching Army is logged, not modeled.
- `{ kind: "seq"; effects: TriggerEffect[] }` — resolve sub-effects in order, sharing one TargetRef (Bowmasters: damage then amass).
`resolveTopOfStack` gains optional `target?: TargetRef`.

**Engine**:
- `effectNeedsTarget(effect)` exported (recurses seq). Resolving a trigger whose effect needs a target requires (a) actor === trigger controller ("the controller chooses targets"), (b) `action.target` present and legal (player exists / permanent on some battlefield) — EngineError otherwise. Non-targeted triggers resolve exactly as before, by either player.
- `opponentDraws` emission: whenever player X actually draws, each of the OTHER player's battlefield permanents fires its `opponentDraws` triggers once PER CARD drawn (CR 121.2). Exempt: the turn-based draw-step draw (the event is defined as "an opponent draws, except the first card of their draw step" — Bowmasters wording; documented on the event) and mulligan/setup draws. Emission sites: the `drawCard` override action and scripted `draw` effects (trigger + onResolve executors).
- Amass token ids reuse the spawnTokens machinery.

**cardScripts**:
- Inference change: "deals N damage to any target" now infers `damageAnyTarget` (was: damageOpponent shorthand). "deals N damage to each opponent" keeps damageOpponent. Existing override descriptions unaffected.
- `Orcish Bowmasters` override becomes fully scripted: etb trigger AND opponentDraws trigger, each `seq[damageAnyTarget 1, amass Orcs 1]`; removed from UNSUPPORTED_TRIGGER_CARDS.

**Client**:
- Resolving a targeted trigger (its controller only) enters target mode instead of resolving immediately: a banner prompts "choose a target", every battlefield card is clickable as a target, and the banner offers a button per player for face damage. Esc cancels. Non-controllers see the Resolve button disabled with a "controller chooses the target" hint.
- Auto mode (v5) extension: main1/main2 ALSO auto-advance when the player has no possible action there — no castable card in hand (any speed, auto-pay check), no land drop available (land in hand + none played), and no activatable ability on an untapped permanent. Combat decisions still stop the flow only when relevant (untapped creatures). Net effect: with truly nothing to do, auto passes entire turns.

## Stack-first casting, spell-effect entries & counterspells (v7)

Fixes the response window: every cast visibly sits on the stack before anything happens, so an opponent can respond (e.g. Counterspell) before a creature's ETB or a spell's effect ever occurs.

**Every nonland cast goes through the stack**: `moveCard` from HAND to BATTLEFIELD of a front-face NONLAND card (face-up) is REDIRECTED by the engine to the stack, logged ("nonland cards are cast — X goes to the stack first"). Cost payment (v5) and castSpell triggers apply as for any cast; the card only reaches the battlefield via `resolveTopOfStack` (which fires ETB there). Lands, face-down (morph) plays, and cards without data keep their direct path; sandbox `spawnCard`/fetch `completeSearch` are "puts" and unaffected. Client drops the "Play to battlefield" menu item for nonlands (drag still works — the server redirects).

**Instant/sorcery resolution becomes two-step (house model, per table feel)** — SUPERSEDED by v11 (which resolves the card and its effect in one step, CR 608-accurate): `resolveTopOfStack` on an instant/sorcery WITH an `onResolve` script now (1) moves the card to its owner's graveyard and (2) pushes a SPELL-EFFECT pseudo-entry onto the stack (`instanceId se{seq}-{n}`, isTrigger mechanics, controller = spell controller, cardId = the spell for art, triggerText = the card's oracle text). Resolving that entry applies the effects — including targeted ones via the v6 target picker. Spells with no onResolve keep the v4 "carry out by hand" path; permanents keep battlefield + ETB. (Rules-accurate Magic applies effects during resolution — CR 608 — but the explicit entry gives the table a confirm/inspect beat and reuses all trigger UX; noted as a deliberate house deviation.)

**Counterspells**: new `TriggerEffect { kind: "counterTarget" }` and new TargetRef kind `{ kind: "stack"; instanceId }`. Resolving an effect that needs a stack target validates the target is a NON-TRIGGER stack entry (spells only; abilities keep the manual Counter button). Applying it removes the spell from any stack position — owner's graveyard (tokens cease); fizzle-logged if the target left the stack. `effectTargetKinds(effect)` is exported so the client knows which picker to offer (player/permanent vs. stack).

**Spell templates** (parseSpellLine, BEFORE the blanket "target" reject): "counter target spell" -> counterTarget (Counterspell); "~/it deals N damage to any target" -> damageAnyTarget (Lightning Bolt). Everything else mentioning "target" still falls back to whole-spell manual.

**Flow example** — casting Orcish Bowmasters into open blue mana: cast (auto-pays, stack) -> opponent casts Counterspell in response (auto-pays, stack, above) -> resolve Counterspell -> its effect entry appears -> resolve it, picker highlights stack spells -> click Bowmasters -> Bowmasters to graveyard, never entering play. If instead the table resolves Bowmasters first, it lands and its ETB targeting flow (v6) runs.

## Admin grant/revoke toggle (v7.1)

`adminSetUserAdmin({userId, isAdmin}, ack)` — admin-only, verified per call. Grants or revokes the persisted `is_admin` flag (db `setUserAdmin` gains the boolean; revocation now exists, superseding the v2.1 "no revoke path" note). Guards: target must exist; an admin cannot demote THEMSELVES (someone else must — prevents locking the portal shut by accident). Any live sockets of the target immediately receive a fresh `accountState` so their UI gains/loses the admin affordances without a re-login. Interplay with `ADMIN_USERNAMES`: the env bootstrap still re-grants listed usernames on their next sign-in, so revoking someone who is in the env only lasts until then (logged in the handler).

**Admin portal UI**: each row in the Users table gains a Make admin / Revoke admin action (hidden on your own row), with a confirm dialog for revocation. The row's Admin chip reflects the change instantly.

## Cast-time targets, priority-driven stack & fewer manual buttons (v8)

**Targets are chosen when casting (CR 601.2c)**: `moveCard` gains `target?: TargetRef`. Casting a spell from hand with a target validates it (existence + kind against the spell's onResolve `effectTargetKinds` when the script is known) and stores it on the stack entry as `GameCard.chosenTarget`, logged ("targeting X") and shown on the stack panel. When the spell resolves, the effect entry INHERITS the chosen target and resolves without asking again — and since no choice remains, EITHER player may resolve it. If the chosen target is gone by then (permanent left the battlefield, spell left the stack), the effect fizzles with a log per CR 608.2b instead of blocking. Casting without a target still falls back to the v7 resolution-time picker; triggers (which enter the stack mid-action) keep resolution-time targeting.

**The stack is driven by cards + priority, not buttons**: the StackPanel's Counter button is REMOVED — countering happens by casting a counterspell (or activating an ability), exactly like the tabletop; the engine's `counterTopOfStack` action remains for house-rule emergencies but has no dedicated button. Auto mode now manages the stack instead of suspending on it: holding priority over a non-empty stack with no castable instant-speed response, the auto player PASSES priority; when the opponent's pass comes back (last log entry = their "passed priority"), the top of the stack auto-RESOLVES (CR 117.4). Entries still needing a target choice stop the flow for their controller's click. Manual players keep the Resolve button and the Pass control. SUPERSEDED by v11: this "opponent's pass comes back" check was a client-only log-string heuristic with no engine enforcement behind it — a manual player's Resolve button was NOT actually gated on priority at all. v11 makes both players passing in succession an engine-enforced precondition of resolution.

**Manual side-rail buttons removed**: "Untap all" (the untap step already untaps automatically), "Create token" (tokens come from scripted effects/amass), and "Reveal hand" (log-only theater) leave the UI. Their engine actions remain valid for compatibility but have no buttons; individual cards still tap/untap by click.

## Targeting arrows, player avatars & drag-to-target (v8.1)

Client-only layer over v8 targeting. Each player gets a placeholder avatar (hue hashed from their name, silhouette + initial — swap for real pictures later) beside their life counter; it anchors face-targeting: it glows while a player-legal target is being chosen (click to pick) and accepts a dragged hand card. Casting by DRAG now works end to end — drop a targeted spell onto a battlefield card, a player avatar, or (counterspells) a stack entry and it is cast AT that drop target through the normal moveCard+target path. An SVG overlay (`TargetArrows`) draws curved red arrows anchored to live DOM positions via data attributes (`data-stack-id`, `data-battlefield-id`, `data-player-avatar`, `data-hand-id`): a dashed arrow follows the cursor from the spell while its target is being chosen, and every stack entry with a `chosenTarget` keeps a solid arrow to its target until it resolves (arrows vanish naturally when either end leaves the board). Positions re-measure on an rAF loop so scrolling/layout track.

## Game events & declarative triggers (v9) — "the whiteboard, part 1"

Adopts the MTG Arena GRE architecture (per the "On Whiteboards, Naps, and Living Breakthrough" and Ben Finkel bug-story dev articles): the engine stays card-agnostic and emits a stream of generic **GameEvents**; triggered abilities become **declarative conditions matched against that stream** in ONE place, replacing the hard-coded per-event emission call sites. Adding a new trigger condition becomes data, not engine surgery.

**GameEvent** (transient — buffered per applyAction call, never stored on GameState or serialized; the log remains the player-facing record):

```ts
export type GameEvent =
  | { kind: "zoneChange"; instanceId; cardId; isToken: boolean; controllerId;
      from: ZoneName | null; to: ZoneName; died: boolean; typeLine?: string }
    // from=null for conjured/spawned arrivals and token creation; died = battlefield->graveyard.
    // typeLine = front-face type line (or tokenTypeLine) when known.
  | { kind: "draw"; playerId; drawStepFirst: boolean }   // one event PER CARD drawn (CR 121.2)
  | { kind: "discard"; playerId; instanceId }            // hand -> graveyard moveCard
  | { kind: "stepEntered"; step: TurnStep; activePlayerId }
  | { kind: "attackDeclared"; instanceId; controllerId; firstThisCombat: boolean }
  | { kind: "spellCast"; instanceId; cardId; casterId; typeLine?: string }
  | { kind: "becameTapped"; instanceId; controllerId }   // untapping never emits
  | { kind: "combatDamageToPlayer"; instanceId; controllerId };
```

Emission sites: every zone mutation (moveCard, resolveTopOfStack, counterTopOfStack skips — countered spells emit no zoneChange "arrival", completeSearch, spawnCard, spawnTokens, sacrifice costs), drawCards (EXCEPT mulligan/setup draws, which emit nothing — same exemption as today), enterStep, setAttacking(true, transition only), tapCard(true)/tapForMana/auto-payment taps/ability tap costs, the cast path, and the combatDamage-step unblocked-attacker scan. `GameState.attackDeclaredThisCombat: boolean` (new, reset entering beginCombat/endCombat and on turn advance) feeds `firstThisCombat`.

**TriggerCondition** — the declarative side. `CardTrigger` gains optional `when?: TriggerCondition`; the legacy `event: TriggerEvent` field REMAINS as sugar (every existing override, template, and test keeps working) and is normalized via `conditionForEvent(event, castFilter)`:

```ts
export interface EventCardFilter { types?: string[]; nontoken?: boolean; subtype?: string }
  // types match words in the type line ("Creature", "Land", "Artifact", ...)
export type TriggerCondition =
  | { on: "zoneChange"; which: "self" | "other" | "selfOrOther";
      move: "entersBattlefield" | "dies" | "leavesBattlefield";
      controller?: "you" | "opponent" | "any"; card?: EventCardFilter }
  | { on: "stepEntered"; step: TurnStep; whose: "yours" | "opponents" | "each" }
  | { on: "attackDeclared"; which: "self" | "team" }   // team = once per combat, on the FIRST declaration
  | { on: "spellCast"; caster: "you" | "opponent" | "any";
      castFilter?: "any" | "instantOrSorcery" | "noncreature" | "creature" | "artifact" }
  | { on: "draw"; who: "you" | "opponent"; exceptDrawStepFirst?: boolean }
  | { on: "discard"; who: "you" }
  | { on: "becameTapped"; which: "self" }
  | { on: "combatDamageToPlayer"; which: "self" };
```

Legacy mapping: etb → zoneChange/self/entersBattlefield; dies → zoneChange/self/dies; leaves → zoneChange/self/leavesBattlefield; upkeep → stepEntered/upkeep/yours; eachUpkeep → stepEntered/upkeep/each; endStep → stepEntered/end/yours; attack → attackDeclared/self; castSpell → spellCast/you (+castFilter); combatDamageToPlayer → combatDamageToPlayer/self; opponentDraws → draw/opponent/exceptDrawStepFirst.

**The matching pass** (replaces emitStepTriggers, emitOpponentDrawTriggers, and every inline pushTriggers call): after the action's primary mutation, one pass walks the event buffer IN ORDER. For each event: (1) **self conditions** — the event's subject card's own script is checked first, wherever the card now is (a card that just left the battlefield still sees its own zoneChange, exactly like today's dies/leaves); (2) **observer conditions** — battlefield permanents as of matching time, active player's first then opponent's, each in sortIndex order. Matching triggers push the SAME trigger pseudo-cards as today (`tr{seq}-{n}`, isTrigger, cardId = source, triggerText/Effect/Optional/SourceId) — the stack shape, client, and server are unchanged. Preserved rules: dies suppresses leaves on death when the script has both; castSpell triggers land above the cast spell (events precede matching, pushes append); "you" controller filters compare the observer's controller to the event subject's controller/caster/drawer. DEVIATION (documented): observers are evaluated on the battlefield-at-matching-time, not CR 603.3a "look back in time"; team-attack fires on the first attacker toggle of a combat, not on a formal declare-attackers commit.

**Newly expressible → cardScripts templates + UNSUPPORTED migration** (each with inference templates and honest effects — manual notes where the effect can't be automated): "Whenever ~ or another <filter> you control enters" (selfOrOther), "Whenever another creature you control enters" (Guide of Souls, Enduring Innocence, Kappa Cannoneer, Pyrogoyf, Vaultborn Tyrant halves...), landfall "Whenever a land you control enters" (Lotus Cobra, Bristly Bill, ...; also covers Fastbond/City of Traitors land-play triggers — noted deviation: "play" vs "enters"), "Whenever another creature you control dies" / "a nontoken creature you control dies" (Titania, Ajani via nontoken/subtype filters), "At the beginning of combat on your turn" (Luminarch Aspirant, Reckless Stormseeker, ~8 more), "At the beginning of each opponent's upkeep" (Abhorrent Oculus), "Whenever you attack" (team; Adeline, Raffine, Gut, Inti), "Whenever ~ becomes tapped" (Hawkeye), "Whenever you draw a card" (Sheoldred's first half; the opponent half via draw/opponent WITHOUT the exemption), "Whenever you discard a card" (Currency Converter, Ivora). Nth-draw/Nth-spell-per-turn counting conditions stay unsupported (no per-turn counts yet) and remain documented.

**Blast-radius audit** (the Ninja's Kunai lesson — regenerated card logic can silently change): new `test/scriptAudit.test.ts` golden-snapshot test. A fixture list of real cube card oracle texts runs through `scriptFor`; the resulting scripts are compared against a checked-in JSON snapshot. Any template change that alters ANY card's script fails with a readable per-card diff; intentional changes are committed by regenerating the snapshot (update script documented in the test header). The snapshot diff in the git history IS the release-to-release card-behavior changelog.

## Effect task pipeline & interception (v10) — "the whiteboard, part 2"

Resolution stops executing effects directly: it **compiles them into primitive task lists** that pass through an **interception pipeline** before a small executor runs them — the Arena whiteboard/nap: the engine writes a task list, registered card rules may rewrite it, the engine executes whatever survives without knowing who touched it.

```ts
export type EffectTask =
  | { task: "draw"; playerId }                       // one task per card (CR 121.2)
  | { task: "gainLife" | "loseLife"; playerId; amount }
  | { task: "damagePlayer"; playerId; amount }
  | { task: "damagePermanent"; instanceId; amount }
  | { task: "addCounters"; instanceId; counterType; count }
  | { task: "createToken"; controllerId; name; typeLine; power?; toughness?; tapped: boolean }  // one per token
  | { task: "counterSpell"; instanceId }
  | { task: "manualNote"; controllerId; note };
// Every task carries provenance: { sourceCardId?; sourceInstanceId?; label } — identity is never
// squashed out of the pipeline (the Kunai bug was exactly that loss).
```

`compileEffect(effect, controller, opponent, sourceId, target) → EffectTask[]` (seq flattens; draw N → N tasks; amass keeps its bespoke executor step but emits token/counter tasks). `runTasks(s, tasks, logs)` = intercept → execute → emit GameEvents (a scripted draw emits a draw event, so Sheoldred-style chains fire off scripted draws exactly like manual ones; created tokens emit zoneChange arrivals, so other-creature-enters observers see them — all matched in the same end-of-action pass).

**Single battlefield-arrival choke point**: every path that puts a card onto the battlefield (moveCard, resolveTopOfStack, completeSearch, spawnCard, token creation) now routes through one `arriveOnBattlefield(s, card, controller)` — it assigns sortIndex, applies arrival replacement rules, pushes, and emits the zoneChange event. Kills today's four divergent copies of that logic.

**Replacement rules** (`CardScript.replacements?: ReplacementRule[]`, applied at the choke point; initial honest vocabulary — self-arrival modifiers only):

```ts
export type ReplacementRule =
  | { kind: "entersTapped" }                                        // "~ enters the battlefield tapped."
  | { kind: "entersWithCounters"; counterType: string; count: number };  // "~ enters with N X counters."
```

Inference templates for both lines (huge cube payoff: tap-lands and charge/oil counters just work). The pipeline API is the point: future kinds (draw substitution, damage prevention, trigger doubling à la Panharmonicon) plug into interceptTasks/the matching pass as data, no engine surgery. Not built until a card needs them (wrong automation is worse than none).

**Executor refactor**: `applyEffect`'s switch becomes compileEffect + runTasks; trigger resolution and onResolve spells share it (as today). Behavior-identical for all existing effects (the 249-test suite is the proof); the only observable additions are the event emissions and replacement application.

## Real stack priority & direct spell resolution (v11)

Fixes two bugs in the v7/v8 stack model, worked out against Lightning Bolt and Counterspell: (1) resolving the top of the stack had NO real priority precondition — either player's Resolve button worked the instant something was cast, with no enforced response window; auto mode's "opponent just passed" check was a client-only log-string guess, not an engine rule. (2) resolving an instant/sorcery with an `onResolve` script pushed a SYNTHETIC spell-effect stack entry (v7) instead of applying the effect — Lightning Bolt visibly sat on the stack as a floating "Ability" after the real card was already in the graveyard, needing a second Resolve click to actually deal damage. Supersedes the v7 two-step instant/sorcery model and v8's log-heuristic Auto-mode check (both noted inline above). Layered on top of v9/v10's event-stream + whiteboard task pipeline: `runTriggerMatching` and `applyEffect`'s compile-then-run-tasks model are unchanged by this section — the priority gate wraps `resolveTopOfStack`/`counterTopOfStack` themselves, and the spell-effect fix simply calls the existing `applyEffect` directly instead of building a v7 synthetic entry.

**Engine-enforced priority passing (CR 117.4/117.5)**: `GameState` gains `priorityPasses: number` — consecutive `passPriority` actions since the stack's top last changed, capped at 2 (two players, so 2 always means both have passed in a row with nothing new on the stack since). `applyAction` centrally resets it to 0 whenever the stack's length grows during that action, checked AFTER `runTriggerMatching` (covers every cast, every trigger matched onto the stack, and the admin `spawnCard`-to-stack path in one place). Casting a spell (`moveCard` hand->stack) also sets `priorityPlayerId` to the caster (CR 117.3b/601.2i — the caster keeps priority after acting). `passPriority` increments `priorityPasses` alongside its existing flip. `resolveTopOfStack` THROWS unless `priorityPasses >= 2`; after popping, it resets `priorityPasses = 0` and hands `priorityPlayerId` to the active player (CR 117.5). `enterStep`/`advanceTurn`/`restartGame` also reset `priorityPasses = 0` alongside their existing `priorityPlayerId` reset (fresh priority round each step, CR 500.4). `counterTopOfStack`'s matching gate was REMOVED in v13 — see below.

**Deliberate, scoped deviations** (stated explicitly rather than left implicit):
- Casting itself is still NOT gated on already holding priority (unchanged permissive philosophy) — a player without priority can still cast, which simply seizes priority for them. Only *resolution* is newly gated.
- `priorityPasses` only resets when the STACK changes, not on every action (tapping mana, attaching, declining a trigger) — a narrower rule than strict CR 117.3d, but consistent with how mana abilities are already CR-exempt from voiding pass-succession, and it keeps the change scoped to the stack.
- `declineTrigger` is NOT gated by `priorityPasses` — it splices an arbitrary stack position (not just the top), so it isn't a drop-in twin of resolve/counter; it stays permissive like the rest of the engine's manual actions.
- `nextStep`/`nextTurn` still do not require an empty stack — unrelated pre-existing behavior, untouched here.

**Instant/sorcery resolution applies its effect directly (CR 608)**: `resolveTopOfStack` on an instant/sorcery with `onResolve` effects no longer builds the v7 synthetic `se{seq}-{n}` stack entry. It moves the card to its owner's graveyard AND calls the same `applyEffect` executor (v10's compile-then-run-tasks pipeline) triggers already use, in the SAME action — targeting included. A shared `resolveEffectTarget` helper (used by both the trigger branch and this new spell branch) resolves the TargetRef exactly as v6/v8 already did: a fresh `action.target` requires the actor to be the controller; a cast-time `chosenTarget` (v8) resolves for EITHER player, fizzling (logged, CR 608.2b) if it's no longer legal; with neither, only the controller may act, and must supply one. Casting Lightning Bolt into an open response window and resolving it is now ONE `resolveTopOfStack` action — card to graveyard and damage dealt together, no intermediate "Ability" ever appears. Counterspell resolves the same way.

**Client**: `StackPanel`'s Resolve button (both the trigger and plain-spell branches now share `resolveDisabled`/`resolveTitle`) is disabled until `gs.priorityPasses >= 2`, with a distinguishing tooltip ("both players must pass priority first" vs. a target-choice hint); Decline is untouched by this gate (per the `declineTrigger` deviation above). Auto mode's heuristic drops the log-string guess and reads `gs.priorityPasses >= 2` directly — SUPERSEDED by v13, where the pass itself resolves automatically and Auto mode no longer needs to decide when to click Resolve at all. The resolution-time target-choice UI (banner + highlightable stack/battlefield/player targets) now also triggers for a plain spell card sitting at the top of the stack with no `chosenTarget` (previously only synthetic effect entries could ask), covering casts made without a client-side pre-chosen target (e.g. a raw `spawnCard`-to-stack cast, which has no `target` field at all).

## Timing guardrails & transit-step automation (v12)

Manual play concentrates where decisions live — main1, combat, main2 — and the bookkeeping steps run themselves. Grounded in CR 305.1 (land timing), 117.1a (sorcery-speed timing), 508.1a/c (attacker declaration + tapping), 509.1a (blocker declaration), 502 (untap has no priority). Composes with v11: v11 gates when the stack RESOLVES (both players pass), v12 gates when actions may be TAKEN (timing/steps) and automates the bookkeeping steps.

**Timing gates (engine-enforced, `override:true` on moveCard bypasses BOTH timing and payment — the loudly-logged house escape hatch; a context-less engine — no `cards` in ActionContext — cannot classify cards and stays permissive for casts, exactly like cost enforcement):**
- **Land plays** (hand→battlefield, front-face Land): only the ACTIVE player, only during main1/main2, only with an EMPTY stack (CR 305.1) — on top of the existing one-per-turn rule.
- **Sorcery-speed casts** (hand→stack of a card that fails `hasInstantSpeed`: not an Instant, no Flash): only the active player, main1/main2, empty stack (CR 117.1a). Instant-speed casts stay open to EITHER player at any time (house response-window model — casting is not gated on holding priority, per the v11 deviation note; the cast seizes priority and the v11 pass gate governs resolution).
- **Attack declarations**: `setAttacking` only during declareAttackers, only by the active player; `{attacking:true}` additionally requires the creature UNTAPPED (CR 508.1c) and AUTO-TAPS the attacker unless its known oracle text has the Vigilance keyword (CR 508.1f/702.21) — unknown card data taps too (vigilance granted by other effects, or unknowable, is restored with a manual untap). Un-declaring is also declareAttackers-only.
- **Block declarations**: `setBlocking` only during declareBlockers, only by the NON-active player; the blocker must be untapped (CR 509.1a) and the blocked target must actually be attacking. Removing a block: same step.
- Untouched: manual zone moves outside the cast paths (resolving card effects by hand), tapForMana/activateAbility (mana-ability speed), resolve/counter/decline (either player, house model), drawCard override, sandbox spawnCard.

**Transit-step automation**: steps are either MANUAL (main1, declareAttackers, declareBlockers, combatDamage, main2, end) or TRANSIT (untap, upkeep, draw, beginCombat, endCombat, cleanup). Entering a transit step runs its turn-based actions and trigger emission as always, then — when the stack is EMPTY, no pendingSearch, game not finished — advances immediately to the next step (cleanup advances the TURN, flowing into the next player's untap→…). A transit step with triggers on the stack HOLDS for resolution; the stack-emptying actions (`resolveTopOfStack`, `counterTopOfStack`, `declineTrigger`, `completeSearch`) resume the advance when they leave the stack empty during a transit step. Net flow: one `nextStep` from main2 → end (STOP — the shared instant-speed window); `nextStep` from end → cleanup → turn passes → opponent auto-runs untap/upkeep/draw and lands in main1, pausing only where an upkeep/draw/beginCombat trigger needs resolving. `nextTurn` keeps its "end my turn now" meaning (advanceTurn → the same auto-run to the next player's main1). createGame still starts at untap: the starting player's first `nextStep` chains straight to their main1 (their draw is skipped as always). v11 interlock: a trigger held in a transit step still needs BOTH players to pass before it resolves (Auto mode absorbs the clicks); `enterStep` inside the auto-advance chain resets `priorityPasses` per step exactly as a manual step change would, and the v11 stack-growth reset runs after the chain completes.

**Client**: attack/block toggles render only in their legal steps; the Auto-mode step-advance logic for untap/upkeep/draw becomes vestigial (the server lands players in main1) but stays as a no-op guard; step ribbon unchanged. EngineError toasts keep surfacing rejected out-of-turn actions.

## Automatic stack resolution on the second pass (v13)

Closes the gap v11 left open: CR 117.4 says the top of the stack resolves the instant all players pass in succession — it isn't a separate player action. v11 modeled the "both passed" precondition correctly but still required an explicit `resolveTopOfStack` click afterward. v13 makes the second `passPriority` call perform the resolution itself, matching the tabletop. Independent of v12's timing guardrails/transit automation (different concern — v12 gates when actions may be TAKEN and automates bookkeeping steps; v13 changes what happens once the stack is allowed to RESOLVE) but touches the same `passPriority`/post-switch machinery, so see the integration note below.

**`passPriority` auto-resolves when possible**: after flipping `priorityPlayerId` and incrementing `priorityPasses` as in v11, if the stack is non-empty, `priorityPasses` just reached 2, AND the top entry does NOT need a fresh target choice, `passPriority` immediately calls the same resolution logic as `resolveTopOfStack` (extracted into `resolveStackTop(s, actorId, action, logs)`, shared by both). "Needs a fresh target choice" = `effectNeedsTarget(effect) && !chosenTarget` — checked by a new `topNeedsFreshTarget(s)` helper (and its effect-lookup twin `stackTopEffect(card)`, mirroring the client's `stackEffectOf`) against whichever is on top: a real trigger's `triggerEffect`, or a plain spell's `onResolve` script. If the top DOES need a fresh pick (no `chosenTarget` from cast time), auto-resolution is skipped and the stack sits at `priorityPasses === 2` until its controller manually resolves with a target — exactly the v8 cast-time-targeting fallback, unchanged. Casting Lightning Bolt (pre-targeted) into an open response window is now: cast → pass → pass → resolved, all in the SAME two `passPriority` actions; no `resolveTopOfStack` click ever needed for the common case.

**`counterTopOfStack` is no longer gated on `priorityPasses`**: with auto-resolution now firing inside the second `passPriority` call, gating the manual counter action behind the same 2-pass requirement would make it unreachable for any non-targeted stack entry (by the time `priorityPasses` reaches 2, `resolveStackTop` has already popped it). `counterTopOfStack` was always documented as a manual house-rule escape hatch with no dedicated button (v8); it now behaves like `declineTrigger` — usable any time there's something on the stack, regardless of pass count. The real "give both players a response window" guarantee lives entirely in the `resolveTopOfStack` gate (and, transitively, in auto-resolution going through that same gate); countering-in-response is still done by casting an actual counterspell, which resets the pass count like any other cast.

**Integrates with v12's transit automation**: `passPriority` is deliberately NOT added to `STACK_EMPTYING_ACTIONS` (most passes resolve nothing — holding priority over an empty stack is the common case — so blanket-including it there would re-run `autoAdvanceTransit` on every single pass, including ones sitting in an empty-stack transit step, incorrectly re-entering `enterStep` and resetting `priorityPlayerId` out from under the pass that just happened). Instead, `passPriority`'s own case calls `autoAdvanceTransit` directly, but ONLY inside the branch where its auto-resolve actually ran — so a trigger held during a transit step (v12) that auto-resolves via a pass still resumes the chain, without affecting the common no-op pass.

**Test-writer note**: `ActionContext` must be forwarded on BOTH `passPriority` calls of a "both pass" sequence whenever the top of stack is a plain spell with an `onResolve` script — the module-level `ctx` is set per `applyAction` call, and the auto-resolve check/execution inside `passPriority` needs it to see the card's script (for `frontTypeLine`, `onResolve.effects`, and the target-need check) exactly as production already does (the server passes full context on every action, `passPriority` included). A real trigger's `triggerEffect` is embedded on the pseudo-card itself and doesn't need this, but plain-spell resolution does.

**Client**: Auto mode simplifies to "pass when holding priority with nothing to respond with" — no more separate branch deciding whether to click Resolve, since passing IS resolving now when nothing blocks it. Manual players still just click Pass (unchanged control); the Resolve button remains for its one surviving purpose, opening the target-picker when the top needs a fresh choice — `resolveDisabled`/`resolveTitle` wiring is unchanged from v11 and still correct under the new engine behavior.

## Automatic step advance on the second pass over an empty stack (v14)

Extends v13's "both passed → act automatically" principle to the other half of CR 117.4/500.4: when all players pass in succession over an EMPTY stack, the current step or phase ends on its own — no explicit `nextStep`/`nextTurn` click is the ONLY way to move on anymore. Previously this held true only for v12's TRANSIT steps (which auto-advance on entry, before any real pass even happens); MANUAL steps (main1, declareAttackers, declareBlockers, combatDamage, main2, end) sat frozen until the active player explicitly called `nextStep`/`nextTurn`, even after both players had passed with nothing to do.

**`passPriority`'s empty-stack branch**: alongside v13's non-empty-stack auto-resolve branch, `passPriority` now also checks — once `priorityPasses` reaches 2 — whether the stack is empty (and the game isn't finished, has no `pendingSearch`, and nobody has lost). If so, it calls a new shared `advanceToNextStep(s, logs)` helper (the same body `nextStep`'s case used inline before this change: `cleanup` → `advanceTurn`, otherwise `enterStep` to the next entry in `TURN_STEPS`), then `autoAdvanceTransit(s, logs)` to chain through any transit steps that follow, exactly as `nextStep` already does. `nextStep`/`nextTurn` themselves are unchanged (still active-player-only explicit shortcuts that skip waiting for the second pass) — they now just call the same extracted `advanceToNextStep` helper instead of duplicating its body.

**Net effect**: a manual step now ends the moment both players decline to act in it, matching the tabletop, instead of requiring the active player to notice and click an extra button. `main1` with nothing to do: pass, pass → `beginCombat` (transit) → auto-chains into `declareAttackers`. `end` step: pass, pass → `cleanup` → turn passes → opponent auto-runs `untap`/`upkeep`/`draw` into their `main1`, same destination `nextStep` from `end` already reached.

**Test-writer note**: this makes `bothPass()` on a fresh/empty-stack game no longer a true no-op for the *turn structure* (it will walk through any TRANSIT steps in the way and stop at the next MANUAL one) — it remains a no-op for whichever assertions only care about priority/pass-count/active-player state, since `enterStep`/`advanceTurn` keep the active player and priority holder in sync throughout the chain.

**Client**: no changes required — Auto mode's existing explicit `nextStep` sends for "nothing to do" steps are now a slightly redundant but harmless fast path (they still fire before the opponent's second pass would), and the inactive player's existing `passPriority` send (when holding priority with nothing to respond to) now does useful work it didn't before.

## Turn flow, real priority everywhere & the contextual action button (v15)

Consolidates FOUR overlapping automation mechanisms — v12's `TRANSIT_STEPS`, v13's inline auto-resolve, v14's inline step advance, and the client's 700ms Auto-mode timer — into ONE flow driver in the engine, and fixes the rules bug at the root of v12. Supersedes v12's transit-step automation and the client half of v5/v6/v13's Auto mode entirely.

**The bug v12 encoded**: CR 503.1, 504.2, 507.2, 511.1 and 513.1 give the active player priority in the upkeep, draw, begin-combat, end-of-combat and end steps. The ONLY steps in which no player receives priority are untap (CR 502.4) and, normally, cleanup (CR 514.3). By modelling upkeep/draw/beginCombat/endCombat as priority-less "transit" steps that ran themselves, v12 made those windows unreachable: you could not cast an instant in your own upkeep, and the defending player could never respond between begin-combat and the attack declaration. Auto-passing through a quiet step is a legitimate player shortcut (CR 732), but it has to sit ON TOP of a real priority window, not replace it.

**The turn structure is data** (`packages/shared/src/game/turnFlow.ts`): `STEP_INFO: Record<TurnStep, StepInfo>` gives every step its phase, its `grantsPriority` flag, its ribbon group and its labels; `PHASE_RIBBON` is the seven-slot Arena strip; `nextStepFrom(state)` is the single place skips are applied. `TRANSIT_STEPS` (engine) and `COMBAT_STEPS` (PhaseRibbon) are both deleted — they were two hand-synced copies of this table.

**CR 508.8 skip**: declaring zero attackers now skips the declare-blockers AND combat-damage steps, keyed off `combat.attackersThisCombat` (what was DECLARED — killing the lone attacker in response does not un-skip them). Begin-combat and end-of-combat still happen with priority.

**Combat declaration windows** (`GameState.combat: CombatState`): declaring attackers and blockers are TURN-BASED actions (CR 508.1/509.1) that complete before anyone receives priority, so while a window is open nobody holds priority and the step cannot end — `passPriority` and `nextStep` both throw with a "commit first" message. The declaring player toggles freely with `setAttacking`/`setBlocking` (plus bulk `declareAllAttackers`/`clearAttackers`), then closes the window with `commitAttackers`/`commitBlockers`. Consequences: attack triggers now fire ONCE for the whole declaration at commit (CR 508.1m/508.2b) instead of per click — v12 double-fired "whenever this attacks" whenever a player changed their mind; the attack tap is reversible while the window is open (CR 508.1f — tapping to attack is not a cost); and priority after EITHER declaration goes to the ACTIVE player, including after blockers (CR 509.2).

**Auto-pass is engine state, on by default** (`GameState.autoPass: Record<playerId, boolean>`, `setAutoPass` action): the flow driver passes priority for a player who has no legal action, and auto-commits a declaration window that offers no decision at all. Turning it off is Arena's "hold full control". A player's own main phases are always a STOP even with nothing to do — that is what makes the single Next button meaningful (main1 → combat is a deliberate press). Auto-commit deliberately requires BOTH "nothing declared" and "nothing declarable": the tap happens as you click, so an all-tapped board must not be mistaken for "no decision" and confirm the attack out from under the player.

**`hasLegalAction(state, playerId, ctx)`** is the ONE definition of "can this player act now" — castable at the current timing, an unspent land drop, an activatable ability, or a target they owe. The client's duplicate copy is gone. It is deliberately CONSERVATIVE without card data (a context-less engine classifies nothing as castable and keeps the game flowing), mirroring how v5 cost enforcement stays permissive in the same situation.

**`runFlow(s, logs)`** replaces `autoAdvanceTransit` and runs after EVERY action: put triggers on the stack (CR 117.5) → complete a priority-less step (CR 500.3; a cleanup holding triggers grants priority per CR 514.3a) → close an empty declaration window → auto-pass for a player with nothing to do, which resolves the stack or ends the step exactly as v13/v14 did (both extracted into `passPriorityFor`). It holds entirely while the turn-1 mulligan window is open (`GameState.openingHandKept`, fed by `keepHand`), so nothing advances underneath the keep/mulligan UI.

**Untap restrictions** (CR 502.3 — "effects can keep one or more of a player's permanents from untapping"): `ReplacementRule` gains `{kind:"doesNotUntap"}`, inferred from the printed line "~ doesn't untap during your untap step"; and stun counters are honoured (CR 701.53a — remove a counter INSTEAD of untapping). Script-audit blast radius: exactly one card in the fixture cube changed, **Mana Vault**, which the engine previously untapped for free every turn.

**Log attribution**: engine log lines may now be `{playerId, message}` instead of a bare string. One action can advance several steps of the OTHER player's turn, and stamping every line with the actor produced "Bo moved to the upkeep step" during Ada's turn. Step, turn, untap and declaration lines name the player they are about; everything else still defaults to the actor.

**Client**: the 700ms Auto-mode effect is DELETED. `describePrompt(state, viewerId, cards)` (shared) returns the single contextual button — "Next / To Combat", "No Attacks" + "All Attack", "N Attackers / To Blockers" + "Cancel Attacks", "N Blockers / To Damage", "Pass / Resolve", "Waiting…" — plus the centre banner ("Choose attackers."). PhaseRibbon renders the seven-slot phase strip, the auto-pass toggle (`setAutoPass`, so both seats agree and it survives a reload), and that one button, replacing Pass / Next step / Next turn. Clicking your own creature during an open attack window toggles it into the attack, ahead of the tap-for-mana branch.

## Per-seat mulligan state (v15.1)

Bug fix. Mulligan bookkeeping ("have I kept?", "how many mulligans?") lived in a module-level `Map` in `Game.tsx` keyed by GAME (`gameId:firstLogTs`), not by seat. Keeping as one player therefore suppressed the keep/mulligan overlay for the OTHER player in the same browser tab. That was latent before v15 — you could still click "Next step" to start the game — but v15 holds the turn at untap until BOTH players keep and disables the action button while the window is open, so in the **admin sandbox** (where one client drives both seats via `sandboxSwitchSeat`) the second seat could never keep and the game could never start.

**Both facts move onto `GameState`**, per player: `openingHandKept` (added in v15) is now what the client reads for "have I kept", and a new `openingMulligans: Record<playerId, number>` replaces the client's count. `restartGame` resets both. The engine's own mulligan numbering stops scanning the log for `"took a mulligan"` — the log is NOT cleared by `restartGame`, so that scan kept climbing across restarts and would have driven a wrong London bottom-count once the client trusted it.

`keepHand` and `mulligan` now THROW for a player who has already kept. Keeping twice bottoms a second batch of cards, and a page reload used to make that reachable: the "have I kept?" memory lived only in the tab, so reloading resurrected an overlay the player had already dismissed. The client-side `mullMemory`/`getMull`/`gameEpochKey` machinery is deleted.

**Known gap (unchanged by v15, and now the most visible one)**: the combat-damage step still deals NO damage — CR 510.1/510.2 assignment and the CR 704.5g lethal-damage state-based action are not implemented, so life totals and creature deaths in combat remain manual. The steps now flow correctly around a hole where the damage should be. That is the next round's work.
