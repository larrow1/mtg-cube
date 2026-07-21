# CLAUDE.md — working guide for this repo

MTG Cube: upload a cube → draft with friends or ranked matchmaking → Arena-style
deck building → 1v1 matches with a server-enforced rules engine.
Live: https://mtg-cube-production-89d4.up.railway.app (Railway, project "mtg-cube").

## Golden rules

1. **SPEC.md is the contract.** Every feature round appends a section there
   first; engine/server/client are built against it. Read it before changing
   `packages/shared`.
2. **The server is authoritative.** All game mutations flow through the pure
   `applyAction` in `packages/shared/src/game/engine.ts` (throws `EngineError`,
   never mutates input). Hidden info (hands, libraries, draft packs) never
   leaves the server except via per-player redacted views (`game/view.ts`).
   Never emit full `GameState`/`DraftState` to clients.
3. **Card logic grows in ONE place**: `packages/shared/src/cardScripts.ts`.
   Order of preference: oracle-text inference template → `CARD_OVERRIDES`
   entry (declarative, per-card) → `manual` trigger (still appears on the
   stack) → `UNSUPPORTED_TRIGGER_CARDS` (documented omission, never silent).
   Wrong automation is worse than manual — when unsure, use `manual`.
4. **`git fetch origin` and check `origin/master` BEFORE committing.** A
   collaborator ships PRs (see PR #1). Merge their work; prefer their
   established patterns on conflict (e.g. mana symbols).
5. **Mana symbols** = the PNG `ManaSymbol` component
   (`apps/web/src/components/ManaSymbol.tsx`, assets in `apps/web/public/mana/`).
   The `mana-font` package is used ONLY for keyword-ability glyphs
   (`ms ms-ability-*`) on battlefield tiles. Do not reintroduce letter pips.

## Commands

```bash
npm run dev          # server :3001 (tsx watch) + web :5173 (vite)
npm run typecheck    # all three workspaces — must be green before commit
npm test             # shared engine suite (vitest) — must be green before commit
npm run build --workspace=@mtg-cube/web   # includes tsc
npm run build:prod   # web + esbuild-bundled server (mirrors Dockerfile)
```

Release gate = typecheck + test + web build, then commit, push, deploy.

## Deploy (Railway)

- `railway up --detach` from repo root (CLI, logged in as the owner).
  **Never enable GitHub auto-deploy** — redeploys drop in-memory rooms/games;
  deploy at quiet moments.
- Health: GET /health → `{"ok":true,...}`. After deploy, poll until `uptime`
  is small (old container serves during build).
- SQLite persists on the volume at /app/data (accounts/cubes/ratings survive;
  live games don't). Env: `ADMIN_USERNAMES` (comma list → admin on next
  sign-in), `RANKED_*` + `MM_TICK_MS` test overrides — see DEPLOY.md.
- Platform volumes mount root-owned: the Dockerfile chowns /app/data at
  startup then drops to the node user via su-exec. Keep that CMD.

## Verification patterns

- Full-flow test: create room → paste ~16 real card names → seats 2 / packs 1 /
  cards 8 / timer off → draft vs bot → deckbuild → pair match with a scripted
  socket.io second player (register/joinRoom/keepHand bot — write it in the
  session scratchpad, don't commit it).
- Ranked E2E locally: run the server with RANKED_SEATS=4 RANKED_PACKS=1
  RANKED_CARDS=5 RANKED_PICK_SECONDS=8 RANKED_DECKBUILD_SECONDS=25 MM_TICK_MS=2000.
- The in-app browser pane's screenshot capture is flaky under load — fall back
  to DOM/CSS audits and say so honestly.
- Native HTML5 drag can't be driven synthetically — verify drop handlers by
  dispatching real DragEvents with a shared DataTransfer, and flag that a
  human should sanity-check real-mouse drag.

## Current state (2026-07-21)

Shipped: rooms/draft/deckbuild/match core; accounts + saved cubes + admin
portal (system cubes = ranked pool, user management); ranked matchmaking with
Elo/ranks; card scripts v1–v4 (9 trigger events, LSV cube audited to 0 gaps);
draw restrictions + fetch-land searches; admin engine sandbox (v4.1:
sandboxStart/sandboxAddCard/sandboxSwitchSeat, spawnCard action); v5
casting-cost enforcement (mana.ts parser/auto-tapper, pool-first payment,
override escape hatches), one-land-per-turn enforcement, client Auto mode
(auto step-advance / priority-pass when nothing castable at instant speed;
v6: main phases and whole turns pass too when no action exists at all); v6
targeting v1 (damageAnyTarget trigger effect, controller picks the target at
resolution, client target-picker banner), opponentDraws observer event
(Bowmasters-style, draw-step first draw exempt), amass (CR 701.47a) and seq
composite effects — Orcish Bowmasters fully automated; v7 stack-first
casting (nonland hand->battlefield redirects through the stack for a real
response window), counterTarget + stack TargetRef (Counterspell and
Lightning Bolt fully scripted via inference); v8 cast-time targets
(chosenTarget rides the stack entry, stale targets fizzle per CR 608.2b),
Counter/Untap-all/Create-token/Reveal-hand buttons removed (card-driven
play); v9 Arena-GRE architecture (engine emits GameEvents, ONE matching pass
turns declarative TriggerConditions into stack triggers — landfall,
other-enters/dies, begin-of-combat, team attacks, becameTapped,
draw/discard watchers now expressible; UNSUPPORTED_TRIGGER_CARDS 79→46) +
scriptFor golden-snapshot blast-radius audit (test/scriptAudit.test.ts,
regenerate with UPDATE_SCRIPT_AUDIT=1 and review the diff card-by-card);
v10 whiteboard effect pipeline (effects compile to EffectTask lists →
interceptTasks hook → executor; single arriveOnBattlefield choke point;
entersTapped/entersWithCounters replacement rules — tap-lands just work);
v11 real engine-enforced stack priority (`GameState.priorityPasses`;
resolveTopOfStack/counterTopOfStack throw until both players pass in
succession, CR 117.4-117.5; casting grants the caster priority) and direct
spell-effect resolution (an instant/sorcery's onResolve effect applies in
the SAME resolveTopOfStack action, CR 608 — no more synthetic effect entry;
Auto mode reads priorityPasses instead of guessing from the log);
v12 timing guardrails & transit automation (lands/sorcery-speed casts only
in your own main phases with an empty stack, CR 305.1/117.1a, override
escape hatch; setAttacking/setBlocking locked to their steps with untapped
checks, attackers auto-tap unless Vigilance, CR 508/509; transit steps
untap/upkeep/draw/beginCombat/endCombat/cleanup auto-advance while the
stack is empty — manual play lives in main1/combat/main2/end, turn-pass
lands the opponent in main1 with upkeep+draw automated);
310+ shared tests;
Arena-style UI (draft lanes/drag-to-pick, deck builder, battlefield art
tiles with color frames + keyword chips, mana symbols).

The MTG Comprehensive Rules live in `docs/rules/` (plain text, split by
section) — query them via the `mtg-rules` subagent instead of guessing rules.

Roadmap (rough priority): extend targeting beyond damageAnyTarget (target
creature/permanent effects — unlocks automating most remaining manual
triggers) → task-level interception rules (draw substitution, damage
prevention, trigger doubling — the interceptTasks hook is ready) → richer
EventCardFilter (power/toughness predicates: Vaultborn Tyrant, Sword of the
Meek) → per-turn counters (Nth-spell/Nth-draw conditions) → account
management (password change) → spectator mode → Redis persistence for live
games / multi-instance (see DEPLOY.md).

Known nits: pre-existing setState-in-render warning from `apps/web/src/store.tsx`;
mana sources always produce exactly 1 (Sol Ring pays 1 toward auto-payment).
