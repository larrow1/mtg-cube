# MTG Cube

Upload a Magic: The Gathering cube list, draft it live with friends (bots fill
empty seats), build decks, and play 1v1 matches — all in the browser.

## Quick start

```bash
npm install
npm run dev        # server on :3001, web on :5173
```

Open http://localhost:5173, create a room, share the 6-character code.

## How it works

| Package | Role |
| --- | --- |
| `packages/shared` | Pure, deterministic game logic: cube list parsing, seeded pack generation, the draft state machine, the match-state engine, and per-player view redaction. Fully unit-tested. |
| `apps/server` | Node + Socket.IO. Authoritative state: every draft pick and game action is validated and applied through the shared engines; clients only ever receive redacted per-player views (your opponent's hand and both libraries never leave the server). Card data resolved from Scryfall on cube upload. |
| `apps/web` | React + Vite + Tailwind. Lobby, live draft, deck builder, and the 1v1 game board. |

### Rules-engine scope (v1)

The engine strictly enforces the *framework* of a game — zones, turn/phase
structure, priority, the stack, mulligans, mana pool, counters, tokens,
attachments, combat flags, and state-based losses (life, poison, empty draw,
concession). Individual card *effects* are resolved by explicit player actions
(move, tap, counter, token, …) with guardrails, tabletop-style. Per-card
automation can be layered onto the same action system later.

## Scripts

```bash
npm test           # shared engine test suite (vitest)
npm run typecheck  # all workspaces
npm run build      # production web build
```

See [SPEC.md](SPEC.md) for the full architecture contract.
