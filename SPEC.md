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
