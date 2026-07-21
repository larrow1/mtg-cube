/**
 * Game board: opponent zone (face-down hand fan, battlefield rows), shared
 * middle strip (stack, phase ribbon), your battlefield rows + hand fan, side
 * rail (life/poison/mana/piles/log). Every interaction is exactly one
 * `gameAction` emit — no optimistic local mutation; rejected actions toast.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type {
  ActivatedSearchAbility,
  CardData,
  CardScript,
  GameAction,
  GameCard,
  GameState,
  GameView,
  PlayerGameState,
  RoomState,
  SearchFilter,
  SpawnZone,
  TargetRef,
  TriggerEffect,
  ZoneName,
} from "@mtg-cube/shared";
import { canPayFor, effectNeedsTarget, effectTargetKinds, hasInstantSpeed, scriptFor } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp, type Session } from "../store";
import { classifyRow, compareByCmcName, nameOf, randomSeed, type RowKind } from "../lib/cards";
import { Card, CardBack } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { ContextMenu, type ContextMenuState, type MenuItem } from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { LifeCounter } from "../components/LifeCounter";
import { ManaPool } from "../components/ManaPool";
import { ManaSymbol } from "../components/ManaSymbol";
import { PhaseRibbon } from "../components/PhaseRibbon";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { RankBadge } from "../components/RankBadge";
import { StackPanel } from "../components/StackPanel";
import { TargetArrows, type ArrowSpec } from "../components/TargetArrows";
import { ZonePile } from "../components/ZonePile";

// ---------------------------------------------------------------------------
// Local (non-authoritative) per-game memory: mulligan bookkeeping only.
// ---------------------------------------------------------------------------

interface MullMemory {
  kept: boolean;
  mulls: number;
}

const mullMemory = new Map<string, MullMemory>();

function gameEpochKey(view: GameView): string {
  return `${view.gameId}:${view.state.log[0]?.ts ?? 0}`;
}

function getMull(view: GameView): MullMemory {
  const key = gameEpochKey(view);
  let m = mullMemory.get(key);
  if (!m) {
    m = { kept: false, mulls: 0 };
    mullMemory.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortRow(cards: GameCard[]): GameCard[] {
  return [...cards].sort((a, b) => a.sortIndex - b.sortIndex || a.instanceId.localeCompare(b.instanceId));
}

/**
 * v11: the effective TriggerEffect for a stack entry. Real triggers carry one
 * directly; a plain spell card resolves straight from its onResolve script
 * (no more synthetic effect entry), so it can also need a resolution-time
 * target when cast without a pre-chosen one.
 */
function stackEffectOf(gc: GameCard, cards: Record<string, CardData>): TriggerEffect | undefined {
  if (gc.isTrigger) return gc.triggerEffect;
  const data = cards[gc.cardId];
  if (!data) return undefined;
  const effects = scriptFor(data)?.onResolve?.effects;
  if (!effects || effects.length === 0) return undefined;
  return effects.length === 1 ? effects[0] : { kind: "seq", effects };
}

function splitRows(battlefield: GameCard[], cards: Record<string, CardData>): Record<RowKind, GameCard[]> {
  const rows: Record<RowKind, GameCard[]> = { lands: [], creatures: [], other: [] };
  for (const gc of battlefield) rows[classifyRow(gc, cards[gc.cardId])].push(gc);
  rows.lands = sortRow(rows.lands);
  rows.creatures = sortRow(rows.creatures);
  rows.other = sortRow(rows.other);
  return rows;
}

interface DragPayload {
  instanceId: string;
  from: ZoneName;
}

function setDragPayload(e: DragEvent, payload: DragPayload): void {
  e.dataTransfer.setData("text/plain", JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "move";
}

/** WUBRG+C display order for produced-mana pips. */
const MANA_ORDER = ["W", "U", "B", "R", "G", "C"] as const;

const MANA_COLOR_NAMES: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};

/** Anchor rect (viewport space) for the tap-for-mana color picker. */
interface ManaPickerState {
  instanceId: string;
  colors: string[];
  anchor: { left: number; right: number; top: number; bottom: number };
}

function readDragPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<DragPayload>;
    if (typeof p.instanceId === "string" && typeof p.from === "string") {
      return { instanceId: p.instanceId, from: p.from as ZoneName };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Card scripts (shared inference) — memoized per Scryfall card id so the
// battlefield render loop doesn't re-parse oracle text on every render.
// ---------------------------------------------------------------------------

const scriptCache = new Map<string, CardScript | null>();

function cachedScript(data: CardData | undefined): CardScript | null {
  if (!data) return null;
  let script = scriptCache.get(data.id);
  if (script === undefined) {
    script = scriptFor(data);
    scriptCache.set(data.id, script);
  }
  return script;
}

/**
 * Client-side mirror of the engine's pendingSearch eligibility check — for
 * DISPLAY filtering only; the engine re-validates the chosen card.
 */
function matchesSearchFilter(data: CardData | undefined, filter: SearchFilter): boolean {
  if (!data) return false;
  const tl = data.typeLine;
  if (filter.kind === "any") return true;
  if (filter.kind === "basicLand") return tl.includes("Basic") && tl.includes("Land");
  return filter.subtypes.some((s) => tl.includes(s));
}

// ---------------------------------------------------------------------------
// Admin engine sandbox toolbar (v4.1) — rendered only when room.sandbox
// ---------------------------------------------------------------------------

const SPAWN_ZONES: { value: SpawnZone; label: string }[] = [
  { value: "hand", label: "Hand" },
  { value: "battlefield", label: "Battlefield" },
  { value: "stack", label: "Stack" },
  { value: "library", label: "Library (top)" },
  { value: "graveyard", label: "Graveyard" },
  { value: "exile", label: "Exile" },
];

function SandboxToolbar({ meId, oppId, oppName }: { meId: string; oppId: string; oppName: string }): JSX.Element {
  const { state, dispatch, pushToast } = useApp();
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [zone, setZone] = useState<SpawnZone>("hand");
  const [target, setTarget] = useState<"me" | "opp">("me");
  const [busy, setBusy] = useState(false);

  const addCard = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    const r = await call("sandboxAddCard", {
      name: trimmed,
      zone,
      playerId: target === "me" ? meId : oppId,
    });
    setBusy(false);
    if (r.ok && r.data) {
      pushToast(`Conjured ${r.data.cardName}`, "success");
      setName("");
    } else {
      pushToast(r.error ?? "Could not conjure that card");
    }
  };

  const switchSeat = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const r = await call("sandboxSwitchSeat");
    setBusy(false);
    const session = state.session;
    if (r.ok && r.data && session) {
      dispatch({
        type: "sessionEstablished",
        session: { roomId: session.roomId, playerId: r.data.playerId, token: r.data.token, name: r.data.name },
      });
      pushToast(`Now playing as ${r.data.name}`, "info");
    } else {
      pushToast(r.error ?? "Could not switch seats");
    }
  };

  return (
    <div className="fixed left-2 top-14 z-[70] w-60 animate-fade-in rounded-xl border border-purple-400/40 bg-felt-950/95 shadow-card-lg">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-purple-300"
        onClick={() => setOpen((o) => !o)}
      >
        Engine sandbox
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <input
            className="input !py-1.5 !text-xs"
            placeholder="Card name (any card)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addCard();
            }}
          />
          <div className="flex gap-2">
            <select
              className="input flex-1 !py-1.5 !text-xs"
              value={zone}
              onChange={(e) => setZone(e.target.value as SpawnZone)}
            >
              {SPAWN_ZONES.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
            <select
              className="input flex-1 !py-1.5 !text-xs"
              value={target}
              onChange={(e) => setTarget(e.target.value as "me" | "opp")}
            >
              <option value="me">For me</option>
              <option value="opp">For {oppName}</option>
            </select>
          </div>
          <button
            type="button"
            className="btn-primary !py-1.5 !text-xs"
            disabled={busy || name.trim().length === 0}
            onClick={() => void addCard()}
          >
            Conjure card
          </button>
          <button type="button" className="btn-ghost !py-1.5 !text-xs" disabled={busy} onClick={() => void switchSeat()}>
            Switch seat → {oppName}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

interface GameProps {
  /** Supplies a local game state for visual UI work; game actions are disabled. */
  demoView?: GameView;
  demoRoom?: RoomState;
  demoSession?: Session;
}

export function Game({ demoView, demoRoom, demoSession }: GameProps = {}): JSX.Element {
  const { state, dispatch, pushToast } = useApp();
  const view = demoView ?? state.game;
  const room = demoRoom ?? state.room;
  const session = demoSession ?? state.session;
  const isDemo = demoView !== undefined;

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [selectedHand, setSelectedHand] = useState<string | null>(null);
  const [browse, setBrowse] = useState<{ playerId: string; zone: "graveyard" | "exile" } | null>(null);
  const [scryCount, setScryCount] = useState<number | null>(null);
  const [concedeOpen, setConcedeOpen] = useState(false);
  const [endMatchOpen, setEndMatchOpen] = useState(false);
  const [drawOverrideOpen, setDrawOverrideOpen] = useState(false);
  const [londonOpen, setLondonOpen] = useState(false);
  const [attachSource, setAttachSource] = useState<string | null>(null);
  const [blockSource, setBlockSource] = useState<string | null>(null);
  const [manaPicker, setManaPicker] = useState<ManaPickerState | null>(null);
  const [logOpen, setLogOpen] = useState(true);
  const [autoMode, setAutoMode] = useState(false);
  const lastAutoSeq = useRef(-1);
  /** v6: instanceId of the top-of-stack trigger awaiting a target choice. */
  const [targetingTrigger, setTargetingTrigger] = useState<string | null>(null);
  /** v8: a targeted spell waiting for its cast-time target (CR 601.2c). */
  const [pendingCast, setPendingCast] = useState<{
    instanceId: string;
    name: string;
    kinds: TargetRef["kind"][];
    override?: boolean;
  } | null>(null);
  const [, forceRender] = useState(0);

  // Esc cancels attach/block targeting modes, the mana picker and the hand selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setAttachSource(null);
        setBlockSource(null);
        setManaPicker(null);
        setSelectedHand(null);
        setTargetingTrigger(null);
        setPendingCast(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matchId = useMemo(() => {
    if (!view) return "";
    const active = room?.matches.find(
      (m) => !m.finished && session != null && m.playerIds.includes(session.playerId)
    );
    return active?.id ?? view.gameId;
  }, [room, session, view]);

  /**
   * v5 Auto mode (CR 500.2-inspired house rule): with nothing castable at
   * instant speed (CR 117.1a instants, CR 702.8a flash) and an empty stack,
   * the active player's non-decision steps advance themselves and the
   * non-active player passes priority back. Suspended by anything on the
   * stack, a pending search, the mulligan window, or a rejected action.
   */
  useEffect(() => {
    if (!autoMode || !view || !session) return;
    const gs = view.state;
    const cards = view.cards;
    if (gs.finished || gs.pendingSearch) return;
    const me = gs.players.find((p) => p.playerId === session.playerId);
    const opp = gs.players.find((p) => p.playerId !== session.playerId);
    if (!me || !opp) return;
    if (lastAutoSeq.current >= gs.seq) return;

    // Mulligan window: same conditions the keep/mull banner uses.
    const boardEmpty =
      me.zones.battlefield.length === 0 &&
      opp.zones.battlefield.length === 0 &&
      me.zones.graveyard.length === 0;
    if (gs.turnNumber === 1 && gs.step === "untap" && boardEmpty && !getMull(view).kept) return;

    const canActNow = me.zones.hand.some((gc) => {
      const d = cards[gc.cardId];
      return d !== undefined && hasInstantSpeed(d) && canPayFor(d, me, cards);
    });
    const isUntappedCreature = (gc: GameCard): boolean => {
      if (gc.tapped) return false;
      const tl = gc.isToken
        ? gc.tokenTypeLine ?? ""
        : cards[gc.cardId]?.faces?.[0]?.typeLine ?? cards[gc.cardId]?.typeLine ?? "";
      return /\bCreature\b/i.test(tl);
    };

    // v6: any possible action at all, for main-phase auto-advance — a castable
    // card of any speed, an available land drop, or an activatable ability.
    const hasAnyAction = (): boolean => {
      for (const gc of me.zones.hand) {
        const d = cards[gc.cardId];
        if (!d) continue;
        const tl = d.faces?.[0]?.typeLine ?? d.typeLine;
        if (/\bLand\b/i.test(tl)) {
          if (me.landsPlayedThisTurn < 1) return true;
        } else if (canPayFor(d, me, cards)) {
          return true;
        }
      }
      for (const gc of me.zones.battlefield) {
        if (gc.isToken || gc.faceDown) continue;
        const d = cards[gc.cardId];
        if (!d) continue;
        const activated = scriptFor(d)?.activated ?? [];
        if (activated.some((a) => !a.costTap || !gc.tapped)) return true;
      }
      return false;
    };

    let action: GameAction | null = null;
    if (gs.stack.length > 0) {
      // v12: the top of the stack resolves automatically the instant both
      // players have passed in succession (CR 117.4) — the engine does this
      // as part of the second passPriority action itself. Auto mode just
      // needs to pass when holding priority with nothing to respond with;
      // an entry still awaiting a fresh target choice stops the engine's
      // auto-resolve too, and waits for that controller's manual pick.
      if (gs.priorityPlayerId === me.playerId && !canActNow) {
        action = { type: "passPriority" };
      }
    } else if (gs.activePlayerId === me.playerId) {
      if (!canActNow) {
        const AUTO_STEPS = ["untap", "upkeep", "draw", "beginCombat", "endCombat", "end", "cleanup"];
        if (AUTO_STEPS.includes(gs.step)) action = { type: "nextStep" };
        else if (gs.step === "declareAttackers" && !me.zones.battlefield.some(isUntappedCreature)) {
          action = { type: "nextStep" };
        } else if (gs.step === "declareBlockers" && !opp.zones.battlefield.some(isUntappedCreature)) {
          action = { type: "nextStep" };
        } else if (gs.step === "combatDamage") {
          action = { type: "nextStep" };
        } else if ((gs.step === "main1" || gs.step === "main2") && !hasAnyAction()) {
          // v6: truly nothing to do — main phases pass too, so empty turns
          // hand themselves over completely.
          action = { type: "nextStep" };
        }
      }
    } else if (gs.priorityPlayerId === me.playerId && !canActNow) {
      action = { type: "passPriority" };
    }
    if (!action) return;

    const chosen = action;
    const seq = gs.seq;
    // Short beat so triggers/log stay readable as steps flow past.
    const timer = window.setTimeout(() => {
      lastAutoSeq.current = seq;
      void call("gameAction", { matchId, action: chosen }).then((r) => {
        if (!r.ok) setAutoMode(false); // engine disagreed — hand control back
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [autoMode, view, session, matchId]);

  // v6: cancel target selection whenever the trigger being targeted stops
  // being the top of the stack (resolved elsewhere, countered, superseded).
  useEffect(() => {
    if (!targetingTrigger) return;
    const top = view?.state.stack[view.state.stack.length - 1];
    if (!top || top.instanceId !== targetingTrigger) setTargetingTrigger(null);
  }, [view, targetingTrigger]);

  if (!view || !session) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel px-6 py-4 text-sm text-zinc-400">Loading game…</div>
      </div>
    );
  }

  const gs = view.state;
  const cards = view.cards;
  const ranked = room?.ranked ?? false;
  const [p0, p1] = gs.players;
  const viewerIsPlayer = p0.playerId === session.playerId || p1.playerId === session.playerId;
  const me: PlayerGameState = p0.playerId === session.playerId ? p0 : p1.playerId === session.playerId ? p1 : p1;
  const opp: PlayerGameState = me === p0 ? p1 : p0;

  const nameFor = (playerId: string): string =>
    room?.players.find((p) => p.id === playerId)?.name ?? (playerId === session.playerId ? session.name : "Opponent");

  const isMyTurn = gs.activePlayerId === me.playerId && viewerIsPlayer;
  const haveIPriority = gs.priorityPlayerId === me.playerId && viewerIsPlayer;
  const canAct = viewerIsPlayer && !gs.finished;
  const canAttackToggle = canAct && isMyTurn && (gs.step === "declareAttackers" || gs.step === "beginCombat");
  const canBlockToggle = canAct && !isMyTurn && (gs.step === "declareBlockers" || gs.step === "combatDamage");

  // v4 pendingSearch: mine opens the blocking search modal; anyone else's
  // (opponent, or either player for spectators) shows the searching chip.
  const pendingSearch = gs.pendingSearch ?? null;
  const myPendingSearch =
    pendingSearch && viewerIsPlayer && !gs.finished && pendingSearch.playerId === me.playerId
      ? pendingSearch
      : null;

  const send = (action: GameAction): void => {
    if (isDemo) {
      pushToast("Demo table — interactions are disabled", "info");
      return;
    }
    if (!viewerIsPlayer) {
      pushToast("Spectators cannot act", "info");
      return;
    }
    void call("gameAction", { matchId, action }).then((r) => {
      if (!r.ok) pushToast(r.error ?? "Action rejected");
    });
  };

  const openMenu = (e: ReactMouseEvent, items: MenuItem[]): void => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length > 0) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // v6/v7: targeted resolution — the controller picks a target (battlefield
  // card, a player button, or a highlighted stack spell) then resolves.
  // v8: entries carrying a cast-time target resolve without a new pick.
  // v11: a plain spell card can also need one (resolution applies its effect
  // directly — no more synthetic effect entry), not just trigger entries.
  const topOfStack = gs.stack[gs.stack.length - 1];
  const topEffect = topOfStack ? stackEffectOf(topOfStack, cards) : undefined;
  const topNeedsTarget =
    topOfStack !== undefined && effectNeedsTarget(topEffect) && topOfStack.chosenTarget === undefined;
  const iControlTop = topOfStack !== undefined && topOfStack.controllerId === me.playerId;
  const topTargetKinds = topNeedsTarget ? effectTargetKinds(topEffect) : [];

  // v8: cast-time targeting (CR 601.2c) — targeted spells pick their target
  // BEFORE the cast; the choice rides on the stack entry.
  const spellTargetKinds = (data: CardData | undefined): TargetRef["kind"][] => {
    const effects = data ? scriptFor(data)?.onResolve?.effects ?? [] : [];
    const kinds = new Set<TargetRef["kind"]>();
    for (const e of effects) for (const k of effectTargetKinds(e)) kinds.add(k);
    return [...kinds];
  };
  const castWithTarget = (target: TargetRef): void => {
    if (!pendingCast) return;
    send({
      type: "moveCard",
      instanceId: pendingCast.instanceId,
      from: "hand",
      to: "stack",
      override: pendingCast.override === true ? true : undefined,
      target,
    });
    setPendingCast(null);
  };
  /** True when the cast was intercepted for target selection first. */
  const beginCast = (gc: GameCard, override = false): boolean => {
    const kinds = spellTargetKinds(cards[gc.cardId]);
    if (kinds.length === 0) return false;
    setPendingCast({ instanceId: gc.instanceId, name: nameOf(gc, cards[gc.cardId]), kinds, override });
    return true;
  };

  // v8.1: drag-to-target — dropping a targeted hand spell onto a battlefield
  // card, a player avatar, or a stack spell casts it AT that target.
  const dropCastOnTarget = (target: TargetRef) => (e: DragEvent<HTMLElement>): void => {
    const payload = readDragPayload(e);
    if (!payload || payload.from !== "hand" || !canAct) return;
    const gc = me.zones.hand.find((c) => c.instanceId === payload.instanceId);
    if (!gc) return;
    const kinds = spellTargetKinds(cards[gc.cardId]);
    if (!kinds.includes(target.kind)) return; // not this spell's kind of target — zone drops may still apply
    e.preventDefault();
    e.stopPropagation();
    send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "stack", target });
    setPendingCast(null);
    setSelectedHand(null);
  };
  /** Player avatars glow while a player-legal target is being chosen. */
  const playerTargetMode = pendingCast
    ? pendingCast.kinds.includes("player")
    : targetingTrigger !== null && topTargetKinds.includes("player");
  const pickPlayerTarget = (playerId: string): void => {
    const target: TargetRef = { kind: "player", playerId };
    if (pendingCast) castWithTarget(target);
    else if (targetingTrigger) resolveWithTarget(target);
  };

  const resolveWithTarget = (target: TargetRef): void => {
    send({ type: "resolveTopOfStack", target });
    setTargetingTrigger(null);
  };

  // All permanents by instanceId, for attachment-name lookups.
  const permanents = new Map<string, GameCard>();
  for (const p of gs.players) for (const gc of p.zones.battlefield) permanents.set(gc.instanceId, gc);

  const attachedNameOf = (gc: GameCard): string | undefined => {
    if (!gc.attachedTo) return undefined;
    const target = permanents.get(gc.attachedTo);
    return target ? nameOf(target, cards[target.cardId]) : undefined;
  };

  /**
   * Colors this battlefield card can tap for (WUBRG+C order). Tokens have no
   * CardData and face-down cards must not leak their identity — both produce
   * nothing here and keep the plain tap toggle.
   */
  const producedColorsOf = (gc: GameCard): string[] => {
    if (gc.isToken || gc.faceDown) return [];
    const produced = cards[gc.cardId]?.producedMana;
    if (!produced || produced.length === 0) return [];
    return MANA_ORDER.filter((c) => produced.includes(c));
  };

  const tapForMana = (gc: GameCard, color: string): void => {
    send({ type: "tapForMana", instanceId: gc.instanceId, color });
    setManaPicker(null);
  };

  /**
   * v4 activated abilities (fetch-style searches) from the shared card
   * scripts. Tokens have no CardData and face-down cards must not leak their
   * identity — both report none.
   */
  const activatedOf = (gc: GameCard): ActivatedSearchAbility[] => {
    if (gc.isToken || gc.faceDown) return [];
    return cachedScript(cards[gc.cardId])?.activated ?? [];
  };

  const activationMenuItems = (gc: GameCard, abilities: ActivatedSearchAbility[], separator = false): MenuItem[] => {
    const items: MenuItem[] = [{ label: "Activate", heading: true, separator }];
    abilities.forEach((ability, abilityIndex) => {
      items.push({
        label: ability.description,
        onClick: () => send({ type: "activateAbility", instanceId: gc.instanceId, abilityIndex }),
      });
    });
    return items;
  };

  // -------------------------------------------------------------------------
  // Context-menu builders (my cards only — opponent cards are untouchable v1)
  // -------------------------------------------------------------------------

  const counterMenuItems = (gc: GameCard): MenuItem[] => {
    const items: MenuItem[] = [{ label: "Counters", heading: true, separator: true }];
    const types = new Set<string>(["+1/+1", "charge"]);
    const data = cards[gc.cardId];
    if (data?.typeLine.includes("Planeswalker") || gc.tokenTypeLine?.includes("Planeswalker")) types.add("loyalty");
    for (const t of Object.keys(gc.counters)) types.add(t);
    for (const t of types) {
      const cur = gc.counters[t] ?? 0;
      items.push({
        label: `${t}: ${cur}  (+1)`,
        onClick: () => send({ type: "setCounters", instanceId: gc.instanceId, counterType: t, count: cur + 1 }),
      });
      if (cur > 0) {
        items.push({
          label: `${t}: ${cur}  (−1)`,
          onClick: () => send({ type: "setCounters", instanceId: gc.instanceId, counterType: t, count: cur - 1 }),
        });
      }
    }
    return items;
  };

  const moveMenuItems = (gc: GameCard, from: ZoneName, skip: ZoneName[] = []): MenuItem[] => {
    const items: MenuItem[] = [{ label: "Move to", heading: true, separator: true }];
    const targets: { zone: ZoneName; label: string; toBottom?: boolean }[] = [
      { zone: "hand", label: "Hand" },
      { zone: "battlefield", label: "Battlefield" },
      { zone: "graveyard", label: "Graveyard" },
      { zone: "exile", label: "Exile" },
      { zone: "library", label: "Top of library" },
      { zone: "library", label: "Bottom of library", toBottom: true },
    ];
    for (const t of targets) {
      if (t.zone === from && t.zone !== "library") continue;
      if (skip.includes(t.zone) && !t.toBottom) continue;
      items.push({
        label: t.label,
        onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from, to: t.zone, toBottom: t.toBottom }),
      });
    }
    return items;
  };

  const battlefieldMenu = (gc: GameCard): MenuItem[] => {
    const data = cards[gc.cardId];
    const items: MenuItem[] = [
      {
        label: gc.tapped ? "Untap" : "Tap",
        onClick: () => send({ type: "tapCard", instanceId: gc.instanceId, tapped: !gc.tapped }),
      },
    ];
    if (!gc.tapped) {
      for (const color of producedColorsOf(gc)) {
        items.push({
          label: `Tap for ${MANA_COLOR_NAMES[color] ?? color}`,
          icon: <ManaSymbol symbol={color} className="pointer-events-none h-3.5 w-3.5" />,
          onClick: () => tapForMana(gc, color),
        });
      }
    }
    const abilities = activatedOf(gc);
    if (abilities.length > 0) items.push(...activationMenuItems(gc, abilities, true));
    if (canAttackToggle) {
      items.push({
        label: gc.attacking ? "Remove from combat" : "Attack",
        onClick: () => send({ type: "setAttacking", instanceId: gc.instanceId, attacking: !gc.attacking }),
      });
    }
    if (canBlockToggle) {
      if (gc.blocking) {
        items.push({
          label: "Stop blocking",
          onClick: () => send({ type: "setBlocking", instanceId: gc.instanceId, blocking: null }),
        });
      } else {
        items.push({ label: "Block… (then click an attacker)", onClick: () => setBlockSource(gc.instanceId) });
      }
    }
    if (data?.faces && data.faces.length > 1) {
      items.push({
        label: "Flip / transform",
        onClick: () => send({ type: "flipCard", instanceId: gc.instanceId, faceIndex: (gc.faceIndex + 1) % (data.faces?.length ?? 2) }),
      });
    }
    items.push({
      label: gc.faceDown ? "Turn face up" : "Turn face down",
      onClick: () =>
        send({ type: "moveCard", instanceId: gc.instanceId, from: "battlefield", to: "battlefield", faceDown: !gc.faceDown }),
    });
    items.push({
      label: gc.attachedTo ? "Unattach" : "Attach to… (then click a permanent)",
      onClick: () => {
        if (gc.attachedTo) send({ type: "attach", instanceId: gc.instanceId, targetInstanceId: null });
        else setAttachSource(gc.instanceId);
      },
    });
    items.push(...counterMenuItems(gc));
    items.push({ label: "Damage", heading: true, separator: true });
    items.push({ label: `Damage: ${gc.damage}  (+1)`, onClick: () => send({ type: "setDamage", instanceId: gc.instanceId, damage: gc.damage + 1 }) });
    if (gc.damage > 0) {
      items.push({ label: `Damage: ${gc.damage}  (−1)`, onClick: () => send({ type: "setDamage", instanceId: gc.instanceId, damage: gc.damage - 1 }) });
      items.push({ label: "Clear damage", onClick: () => send({ type: "setDamage", instanceId: gc.instanceId, damage: 0 }) });
    }
    items.push(...moveMenuItems(gc, "battlefield"));
    return items;
  };

  const handMenu = (gc: GameCard): MenuItem[] => {
    const tl = cards[gc.cardId]?.faces?.[0]?.typeLine ?? cards[gc.cardId]?.typeLine ?? "";
    const isLand = /\bLand\b/i.test(tl);
    return [
      // v7: nonland "plays" are casts — the server routes them through the
      // stack regardless, so only lands offer the direct battlefield item.
      ...(isLand
        ? [{ label: "Play to battlefield", onClick: () => send({ type: "moveCard" as const, instanceId: gc.instanceId, from: "hand" as const, to: "battlefield" as const }) }]
        : []),
      { label: "Play face down", onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "battlefield", faceDown: true }) },
      { label: "Cast (put on stack)", onClick: () => { if (!beginCast(gc)) send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "stack" }); } },
      // v5 escape hatches: additional-land effects / alternative & reduced costs.
      isLand
        ? { label: "Play as additional land (override)", onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "battlefield", override: true }) }
        : { label: "Cast without paying (override)", onClick: () => { if (!beginCast(gc, true)) send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "stack", override: true }); } },
      { label: "Discard", separator: true, onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "graveyard" }) },
      { label: "Exile", onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "exile" }) },
      { label: "Top of library", onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "library" }) },
      { label: "Bottom of library", onClick: () => send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to: "library", toBottom: true }) },
    ];
  };

  const libraryMenu = (): MenuItem[] => {
    const top = me.zones.library[0];
    const items: MenuItem[] = [
      { label: "Shuffle", onClick: () => send({ type: "shuffleLibrary" }) },
      // v4: free draws are engine-rejected; the only manual path is the
      // confirmed override below (for manually-resolved card text).
      { label: "Draw (manual override)…", onClick: () => setDrawOverrideOpen(true) },
    ];
    items.push({ label: "Scry", heading: true, separator: true });
    for (const n of [1, 2, 3, 5]) {
      items.push({
        label: `Scry ${n}`,
        disabled: me.zones.library.length === 0,
        onClick: () => {
          send({ type: "scry", count: n });
          setScryCount(Math.min(n, me.zones.library.length));
        },
      });
    }
    if (top) {
      items.push({
        label: "Mill top card",
        separator: true,
        onClick: () => send({ type: "moveCard", instanceId: top.instanceId, from: "library", to: "graveyard" }),
      });
    }
    return items;
  };

  const browsePileMenu = (gc: GameCard, zone: "graveyard" | "exile"): MenuItem[] => moveMenuItems(gc, zone);

  // -------------------------------------------------------------------------
  // Click handlers
  // -------------------------------------------------------------------------

  const clickMyBattlefieldCard = (gc: GameCard, e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!canAct) return;
    if (pendingCast && pendingCast.kinds.includes("permanent")) {
      castWithTarget({ kind: "permanent", instanceId: gc.instanceId });
      return;
    }
    if (targetingTrigger && topTargetKinds.includes("permanent")) {
      resolveWithTarget({ kind: "permanent", instanceId: gc.instanceId });
      return;
    }
    if (attachSource) {
      if (attachSource !== gc.instanceId) {
        send({ type: "attach", instanceId: attachSource, targetInstanceId: gc.instanceId });
      }
      setAttachSource(null);
      return;
    }
    // Untapped mana producers tap for mana on plain click: one color goes
    // straight through, several open the color picker. Tapped cards untap as
    // before; the plain tap toggle stays reachable via the context menu.
    const produced = gc.tapped ? [] : producedColorsOf(gc);
    const only = produced[0];
    if (produced.length === 1 && only !== undefined) {
      tapForMana(gc, only);
      return;
    }
    if (produced.length > 1) {
      const r = e.currentTarget.getBoundingClientRect();
      setManaPicker({
        instanceId: gc.instanceId,
        colors: produced,
        anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      });
      return;
    }
    send({ type: "tapCard", instanceId: gc.instanceId, tapped: !gc.tapped });
  };

  const clickOppBattlefieldCard = (gc: GameCard): void => {
    if (pendingCast && canAct && pendingCast.kinds.includes("permanent")) {
      castWithTarget({ kind: "permanent", instanceId: gc.instanceId });
      return;
    }
    if (targetingTrigger && canAct && topTargetKinds.includes("permanent")) {
      resolveWithTarget({ kind: "permanent", instanceId: gc.instanceId });
      return;
    }
    if (blockSource && gc.attacking) {
      send({ type: "setBlocking", instanceId: blockSource, blocking: gc.instanceId });
      setBlockSource(null);
    }
  };

  const lastHandPlay = useRef(0);
  const playFromHand = (gc: GameCard): void => {
    if (!canAct) return;
    // After a play the fan re-lays out and another card slides under the
    // cursor; a stray second dblclick from the same gesture must not play it.
    if (Date.now() - lastHandPlay.current < 300) return;
    lastHandPlay.current = Date.now();
    const tl = (cards[gc.cardId]?.typeLine ?? "").toLowerCase();
    const to: ZoneName = tl.includes("land") ? "battlefield" : "stack";
    // v8: targeted spells pick their target first; the cast follows the click.
    if (to === "stack" && beginCast(gc)) {
      setSelectedHand(null);
      return;
    }
    send({ type: "moveCard", instanceId: gc.instanceId, from: "hand", to });
    setSelectedHand(null);
  };

  const dropTo = (to: ZoneName, toBottom = false) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const payload = readDragPayload(e);
    if (!payload || !canAct) return;
    if (payload.from === to && to !== "library") return;
    send({ type: "moveCard", instanceId: payload.instanceId, from: payload.from, to, toBottom: toBottom || undefined });
  };

  // -------------------------------------------------------------------------
  // Mulligan
  // -------------------------------------------------------------------------

  const mull = getMull(view);
  const boardEmpty =
    me.zones.battlefield.length === 0 &&
    opp.zones.battlefield.length === 0 &&
    me.zones.graveyard.length === 0 &&
    gs.stack.length === 0;
  const showMulligan = viewerIsPlayer && !gs.finished && gs.turnNumber === 1 && gs.step === "untap" && boardEmpty && !mull.kept;
  const expectedBottom = Math.max(0, me.zones.hand.length - (7 - mull.mulls));

  const keepHand = (): void => {
    if (expectedBottom === 0) {
      send({ type: "keepHand", bottomCount: 0, bottomInstanceIds: [] });
      mull.kept = true;
      forceRender((n) => n + 1);
    } else {
      setLondonOpen(true);
    }
  };

  const takeMulligan = (): void => {
    send({ type: "mulligan" });
    mull.mulls += 1;
    forceRender((n) => n + 1);
  };

  // -------------------------------------------------------------------------
  // Rows / fans
  // -------------------------------------------------------------------------

  const myRows = splitRows(me.zones.battlefield, cards);
  const oppRows = splitRows(opp.zones.battlefield, cards);
  const myHand = me.zones.hand;
  const oppHandCount = opp.zones.hand.length;

  const renderRow = (rowCards: GameCard[], mine: boolean, label: string): JSX.Element => (
    <div
      className={`zone-row ${mine && canAct ? "hover:border-brass-400/30" : ""}`}
      onDragOver={mine ? (e) => e.preventDefault() : undefined}
      onDrop={mine ? dropTo("battlefield") : undefined}
    >
      {rowCards.length === 0 ? (
        <span className="self-center px-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-500/70">{label}</span>
      ) : (
        rowCards.map((gc) => (
          <div
            key={gc.instanceId}
            data-battlefield-id={gc.instanceId}
            onDragOver={(e) => e.preventDefault()}
            onDrop={dropCastOnTarget({ kind: "permanent", instanceId: gc.instanceId })}
          >
          <Card
            gameCard={gc}
            data={cards[gc.cardId]}
            size="sm"
            variant="artTile"
            attachedName={attachedNameOf(gc)}
            selected={attachSource === gc.instanceId || blockSource === gc.instanceId}
            highlight={gc.attacking ? "attack" : gc.blocking ? "block" : null}
            dimmed={!mine && blockSource !== null && !gc.attacking}
            draggable={mine && canAct}
            onDragStart={(e) => setDragPayload(e, { instanceId: gc.instanceId, from: "battlefield" })}
            onClick={mine ? (e) => clickMyBattlefieldCard(gc, e) : () => clickOppBattlefieldCard(gc)}
            onContextMenu={mine && canAct ? (e) => openMenu(e, battlefieldMenu(gc)) : (e) => e.preventDefault()}
            activateHint={
              mine && canAct && activatedOf(gc).length > 0
                ? {
                    title: "Activate ability",
                    onClick: (e) => openMenu(e, activationMenuItems(gc, activatedOf(gc))),
                  }
                : undefined
            }
            // Landscape tile rotated 90° overhangs vertically (not horizontally
            // like the old portrait cards) — trade margin axes accordingly.
            className={gc.tapped ? "my-4 -mx-2" : ""}
          />
          </div>
        ))
      )}
    </div>
  );

  // v8.1: targeting arrows — persistent ones from each stack entry to its
  // chosen target, plus a live cursor arrow while a target is being chosen.
  const arrowSpecs: ArrowSpec[] = [];
  for (const entry of gs.stack) {
    const t = entry.chosenTarget;
    if (!t) continue;
    arrowSpecs.push({
      id: `t-${entry.instanceId}`,
      from: `[data-stack-id="${entry.instanceId}"]`,
      to:
        t.kind === "player"
          ? `[data-player-avatar="${t.playerId}"]`
          : t.kind === "stack"
            ? `[data-stack-id="${t.instanceId}"]`
            : `[data-battlefield-id="${t.instanceId}"]`,
    });
  }
  if (pendingCast) {
    arrowSpecs.push({ id: "live", from: `[data-hand-id="${pendingCast.instanceId}"]` });
  } else if (targetingTrigger && topOfStack) {
    arrowSpecs.push({ id: "live", from: `[data-stack-id="${topOfStack.instanceId}"]` });
  }

  const winnerName = gs.winnerId ? nameFor(gs.winnerId) : null;

  // Ranked: the viewer's rating delta from the finished match record, if any.
  const myRatingDelta =
    ranked && viewerIsPlayer
      ? room?.matches.find((m) => m.finished && m.playerIds.includes(session.playerId) && m.ratingDeltas)
          ?.ratingDeltas?.[session.playerId]
      : undefined;
  const acct = state.account;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="game-scene mx-auto flex h-full max-w-[120rem] flex-col gap-2 overflow-hidden p-2 lg:p-3">
      {/* Admin engine sandbox controls */}
      {room?.sandbox && viewerIsPlayer && (
        <SandboxToolbar meId={me.playerId} oppId={opp.playerId} oppName={nameFor(opp.playerId)} />
      )}

      {/* v8.1: targeting arrows overlay */}
      <TargetArrows specs={arrowSpecs} />

      {/* v8: cast-time target picker — choose, then the spell is cast */}
      {pendingCast && (
        <div className="fixed left-1/2 top-2 z-[60] flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-red-400/50 bg-felt-900 px-4 py-1.5 text-xs font-semibold text-red-200 shadow-card-lg">
          <span>
            {pendingCast.kinds.includes("stack")
              ? `Choose a spell for ${pendingCast.name} to counter — click a highlighted spell on the stack`
              : `Choose a target for ${pendingCast.name} — click any battlefield card, or:`}
          </span>
          {pendingCast.kinds.includes("player") && (
            <>
              <button
                type="button"
                className="rounded-full border border-red-400/50 bg-red-500/15 px-2.5 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/30"
                onClick={() => castWithTarget({ kind: "player", playerId: opp.playerId })}
              >
                {nameFor(opp.playerId)}
              </button>
              <button
                type="button"
                className="rounded-full border border-red-400/50 bg-red-500/15 px-2.5 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/30"
                onClick={() => castWithTarget({ kind: "player", playerId: me.playerId })}
              >
                yourself
              </button>
            </>
          )}
          <button
            type="button"
            className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20"
            onClick={() => setPendingCast(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* v6/v7: target picker for the resolving trigger / spell effect */}
      {targetingTrigger && !pendingCast && topOfStack && (
        <div className="fixed left-1/2 top-2 z-[60] flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-red-400/50 bg-felt-900 px-4 py-1.5 text-xs font-semibold text-red-200 shadow-card-lg">
          <span>
            {topTargetKinds.includes("stack")
              ? `Choose a spell for ${cards[topOfStack.cardId]?.name ?? "the effect"} to counter — click a highlighted spell on the stack`
              : `Choose a target for ${cards[topOfStack.cardId]?.name ?? "the trigger"} — click any battlefield card, or:`}
          </span>
          {topTargetKinds.includes("player") && (
            <>
              <button
                type="button"
                className="rounded-full border border-red-400/50 bg-red-500/15 px-2.5 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/30"
                onClick={() => resolveWithTarget({ kind: "player", playerId: opp.playerId })}
              >
                {nameFor(opp.playerId)}
              </button>
              <button
                type="button"
                className="rounded-full border border-red-400/50 bg-red-500/15 px-2.5 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/30"
                onClick={() => resolveWithTarget({ kind: "player", playerId: me.playerId })}
              >
                yourself
              </button>
            </>
          )}
          <button
            type="button"
            className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20"
            onClick={() => setTargetingTrigger(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Mode hints */}
      {(attachSource || blockSource) && (
        <div className="fixed left-1/2 top-2 z-[60] flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-brass-400/50 bg-felt-900 px-4 py-1.5 text-xs font-semibold text-brass-300 shadow-card-lg">
          {attachSource ? "Click a permanent to attach to" : "Click an attacking creature to block"}
          <button
            type="button"
            className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20"
            onClick={() => {
              setAttachSource(null);
              setBlockSource(null);
            }}
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        {/* Main board */}
        <div className="scrollbar-slim flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {/* Opponent hand */}
          <div className="flex items-center justify-center gap-3 pt-1">
            <div className="flex items-center">
              {Array.from({ length: Math.min(oppHandCount, 10) }).map((_, i) => (
                <div
                  key={i}
                  className="-ml-8 h-[72px] w-[52px] first:ml-0"
                  style={{ transform: `rotate(${(i - (Math.min(oppHandCount, 10) - 1) / 2) * -3}deg) translateY(${Math.abs(i - (Math.min(oppHandCount, 10) - 1) / 2) * 2}px)` }}
                >
                  <CardBack />
                </div>
              ))}
              {oppHandCount === 0 && <span className="text-[10px] uppercase tracking-wider text-zinc-500/70">Empty hand</span>}
            </div>
            <span className="chip" title="Opponent hand size">
              {nameFor(opp.playerId)} · {oppHandCount} card{oppHandCount === 1 ? "" : "s"}
            </span>
          </div>

          {/* Opponent battlefield (creatures nearest the middle) */}
          <div className="space-y-1.5">
            {renderRow(oppRows.lands, false, "opponent lands")}
            {renderRow(oppRows.other, false, "opponent artifacts & enchantments")}
            {renderRow(oppRows.creatures, false, "opponent creatures")}
          </div>

          {/* Middle strip */}
          <div className="flex items-stretch gap-2">
            <StackPanel
              stack={gs.stack}
              cards={cards}
              nameFor={nameFor}
              viewerId={viewerIsPlayer ? me.playerId : undefined}
              onResolve={() => {
                if (topNeedsTarget) {
                  if (iControlTop && topOfStack) setTargetingTrigger(topOfStack.instanceId);
                } else {
                  send({ type: "resolveTopOfStack" });
                }
              }}
              onDecline={(instanceId) => send({ type: "declineTrigger", instanceId })}
              disabled={!canAct || gs.stack.length === 0}
              resolveDisabled={(topNeedsTarget && !iControlTop) || gs.priorityPasses < 2}
              resolveTitle={
                gs.priorityPasses < 2
                  ? "Both players must pass priority before this resolves (CR 117.4)"
                  : topNeedsTarget
                    ? iControlTop
                      ? "Choose a target, then it resolves"
                      : "The trigger's controller chooses its target"
                    : undefined
              }
              targetableIds={
                targetingTrigger && topTargetKinds.includes("stack")
                  ? new Set(gs.stack.filter((c) => !c.isTrigger).map((c) => c.instanceId))
                  : pendingCast?.kinds.includes("stack")
                    ? new Set(
                        gs.stack
                          .filter((c) => !c.isTrigger && c.instanceId !== pendingCast.instanceId)
                          .map((c) => c.instanceId)
                      )
                    : undefined
              }
              onPickTarget={(instanceId) =>
                pendingCast
                  ? castWithTarget({ kind: "stack", instanceId })
                  : resolveWithTarget({ kind: "stack", instanceId })
              }
              targetLabelFor={(t) => {
                if (t.kind === "player") return nameFor(t.playerId);
                const c =
                  t.kind === "stack"
                    ? gs.stack.find((x) => x.instanceId === t.instanceId)
                    : permanents.get(t.instanceId);
                return c ? nameOf(c, cards[c.cardId]) : "(target gone)";
              }}
              onDropOnEntry={(instanceId, e) => {
                const entry = gs.stack.find((c) => c.instanceId === instanceId);
                if (!entry || entry.isTrigger) return;
                dropCastOnTarget({ kind: "stack", instanceId })(e);
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
              <div className="flex items-center justify-center gap-2">
                {ranked && (
                  <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">
                    RANKED
                  </span>
                )}
                {viewerIsPlayer && !gs.finished && (
                  <button
                    type="button"
                    onClick={() => setAutoMode((a) => !a)}
                    className={`chip transition-colors duration-150 ${
                      autoMode
                        ? "border-emerald-400/60 font-black tracking-widest text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.25)]"
                        : "border-white/15 font-semibold tracking-widest text-zinc-400 hover:text-zinc-200"
                    }`}
                    title="Auto mode: steps advance and priority passes by themselves whenever you have no possible play — even main phases (and whole turns) pass when you have nothing castable, no land drop, and no ability to activate"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${autoMode ? "animate-pulse bg-emerald-400" : "bg-zinc-600"}`} />
                    AUTO {autoMode ? "ON" : "OFF"}
                  </button>
                )}
              </div>
              {pendingSearch && !myPendingSearch && (
                <span className="chip animate-pop-in self-center border-sky-400/50 font-semibold text-sky-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                  {nameFor(pendingSearch.playerId)} is searching their library…
                </span>
              )}
              <PhaseRibbon
                step={gs.step}
                turnNumber={gs.turnNumber}
                activePlayerName={nameFor(gs.activePlayerId)}
                isMyTurn={isMyTurn}
                haveIPriority={haveIPriority}
                priorityPlayerName={nameFor(gs.priorityPlayerId)}
                finished={gs.finished}
                onNextStep={() => send({ type: "nextStep" })}
                onNextTurn={() => send({ type: "nextTurn" })}
                onPassPriority={() => send({ type: "passPriority" })}
              />
            </div>
          </div>

          {/* My battlefield */}
          <div className="space-y-1.5">
            {renderRow(myRows.creatures, true, "your creatures")}
            {renderRow(myRows.other, true, "your artifacts & enchantments")}
            {renderRow(myRows.lands, true, "your lands")}
          </div>

          {/* My hand fan (with the floating mana strip docked just above it) */}
          <div className="relative mt-auto">
            {viewerIsPlayer && (
              <FloatingManaStrip
                pool={me.manaPool}
                editable={canAct}
                onSpend={(color) => send({ type: "addMana", color, amount: -1 })}
              />
            )}
            <div
              className="flex min-h-[9.5rem] items-end justify-center pb-1"
              onDragOver={(e) => e.preventDefault()}
              onDrop={dropTo("hand")}
            >
              {myHand.length === 0 ? (
                <span className="pb-6 text-[10px] uppercase tracking-wider text-zinc-500/70">Your hand is empty</span>
              ) : (
                <div className="flex items-end">
                  {myHand.map((gc, i) => {
                    const n = myHand.length;
                    const angle = (i - (n - 1) / 2) * Math.min(4, 36 / n);
                    const lift = Math.abs(i - (n - 1) / 2) * Math.min(3, 24 / n);
                    return (
                      <div
                        key={gc.instanceId}
                        data-hand-id={gc.instanceId}
                        className="-ml-7 transition-transform duration-150 first:ml-0 hover:z-20 hover:-translate-y-4"
                        style={{ transform: `rotate(${angle}deg) translateY(${lift}px)`, zIndex: selectedHand === gc.instanceId ? 30 : 10 }}
                      >
                        <Card
                          gameCard={gc}
                          data={cards[gc.cardId]}
                          size="sm"
                          selected={selectedHand === gc.instanceId}
                          draggable={canAct}
                          onDragStart={(e) => setDragPayload(e, { instanceId: gc.instanceId, from: "hand" })}
                          onClick={() => setSelectedHand((cur) => (cur === gc.instanceId ? null : gc.instanceId))}
                          onDoubleClick={() => playFromHand(gc)}
                          onContextMenu={canAct ? (e) => openMenu(e, handMenu(gc)) : undefined}
                          className={selectedHand === gc.instanceId ? "-translate-y-3" : ""}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Side rail */}
        <aside className="scrollbar-slim flex w-64 shrink-0 flex-col gap-2 overflow-y-auto">
          {/* Opponent panel */}
          <div className="flex items-center gap-2">
            <PlayerAvatar
              playerId={opp.playerId}
              name={nameFor(opp.playerId)}
              targetable={playerTargetMode && canAct}
              onPick={() => pickPlayerTarget(opp.playerId)}
              onDropCard={dropCastOnTarget({ kind: "player", playerId: opp.playerId })}
            />
            <div className="min-w-0 flex-1">
          <LifeCounter
            name={nameFor(opp.playerId)}
            life={opp.life}
            poison={opp.poison}
            connected={room?.players.find((p) => p.id === opp.playerId)?.connected ?? true}
            isActiveTurn={gs.activePlayerId === opp.playerId}
            hasPriority={gs.priorityPlayerId === opp.playerId}
            hasLost={opp.hasLost}
            editable={false}
            onLife={() => undefined}
            onPoison={() => undefined}
          />
            </div>
          </div>
          <ManaPool pool={opp.manaPool} editable={false} onAdd={() => undefined} onEmpty={() => undefined} />
          <div className="flex justify-around">
            <ZonePile label="Library" count={opp.zones.library.length} faceDown accent="emerald" />
            <ZonePile
              label="Graveyard"
              count={opp.zones.graveyard.length}
              topCard={opp.zones.graveyard[opp.zones.graveyard.length - 1]}
              topCardData={(() => {
                const top = opp.zones.graveyard[opp.zones.graveyard.length - 1];
                return top ? cards[top.cardId] : undefined;
              })()}
              onClick={() => setBrowse({ playerId: opp.playerId, zone: "graveyard" })}
            />
            <ZonePile
              label="Exile"
              count={opp.zones.exile.length}
              topCard={opp.zones.exile[opp.zones.exile.length - 1]}
              topCardData={(() => {
                const top = opp.zones.exile[opp.zones.exile.length - 1];
                return top ? cards[top.cardId] : undefined;
              })()}
              accent="purple"
              onClick={() => setBrowse({ playerId: opp.playerId, zone: "exile" })}
            />
          </div>

          <div className="my-0.5 border-t border-amber-100/[0.08]" />

          {/* My panel */}
          <div className="flex items-center gap-2">
            <PlayerAvatar
              playerId={me.playerId}
              name={nameFor(me.playerId)}
              targetable={playerTargetMode && canAct}
              onPick={() => pickPlayerTarget(me.playerId)}
              onDropCard={dropCastOnTarget({ kind: "player", playerId: me.playerId })}
            />
            <div className="min-w-0 flex-1">
          <LifeCounter
            name={`${nameFor(me.playerId)}${viewerIsPlayer ? " (you)" : ""}`}
            life={me.life}
            poison={me.poison}
            connected
            isActiveTurn={gs.activePlayerId === me.playerId}
            hasPriority={gs.priorityPlayerId === me.playerId}
            hasLost={me.hasLost}
            editable={canAct}
            onLife={(next) => send({ type: "setLife", playerId: me.playerId, life: next })}
            onPoison={(next) => send({ type: "setPoison", playerId: me.playerId, poison: next })}
          />
            </div>
          </div>
          <ManaPool
            pool={me.manaPool}
            editable={canAct}
            onAdd={(color, amount) => send({ type: "addMana", color, amount })}
            onEmpty={() => send({ type: "emptyManaPool" })}
          />
          <div className="flex justify-around">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={dropTo("library")}
            >
              <ZonePile
                label="Library"
                count={me.zones.library.length}
                faceDown
                accent="emerald"
                onContextMenu={canAct ? (e) => openMenu(e, libraryMenu()) : undefined}
              />
            </div>
            <div onDragOver={(e) => e.preventDefault()} onDrop={dropTo("graveyard")}>
              <ZonePile
                label="Graveyard"
                count={me.zones.graveyard.length}
                topCard={me.zones.graveyard[me.zones.graveyard.length - 1]}
                topCardData={(() => {
                  const top = me.zones.graveyard[me.zones.graveyard.length - 1];
                  return top ? cards[top.cardId] : undefined;
                })()}
                onClick={() => setBrowse({ playerId: me.playerId, zone: "graveyard" })}
              />
            </div>
            <div onDragOver={(e) => e.preventDefault()} onDrop={dropTo("exile")}>
              <ZonePile
                label="Exile"
                count={me.zones.exile.length}
                topCard={me.zones.exile[me.zones.exile.length - 1]}
                topCardData={(() => {
                  const top = me.zones.exile[me.zones.exile.length - 1];
                  return top ? cards[top.cardId] : undefined;
                })()}
                accent="purple"
                onClick={() => setBrowse({ playerId: me.playerId, zone: "exile" })}
              />
            </div>
          </div>

          {/* v8: no quick-action buttons — untapping happens at the untap
              step, tokens come from scripted effects/amass, and free draws
              stay behind the library menu's confirmed override. */}
          <button
            type="button"
            className="btn-ghost w-full !py-1.5 !text-[11px]"
            onClick={() => dispatch({ type: "dismissGame", gameId: view.gameId })}
            title="Leave the table — the game stays live and you can rejoin from the room"
          >
            Back to room
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`btn-danger !py-1.5 !text-[11px] ${ranked ? "col-span-2" : ""}`}
              disabled={!canAct}
              onClick={() => setConcedeOpen(true)}
            >
              Concede
            </button>
            {/* Ranked matches always play to a result — the server rejects endMatch anyway. */}
            {!ranked && (
              <button type="button" className="btn-ghost !py-1.5 !text-[11px]" disabled={!canAct} onClick={() => setEndMatchOpen(true)}>
                End match
              </button>
            )}
          </div>

          {/* Game log */}
          <div className="panel flex min-h-0 flex-1 flex-col">
            <button
              type="button"
              className="flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400 transition-colors duration-150 hover:text-zinc-200"
              onClick={() => setLogOpen((v) => !v)}
            >
              Game log
              <svg viewBox="0 0 24 24" className={`h-3 w-3 fill-current transition-transform duration-150 ${logOpen ? "rotate-90" : ""}`}>
                <path d="M9 5l7 7-7 7V5Z" />
              </svg>
            </button>
            {logOpen && (
              <div className="scrollbar-slim min-h-[6rem] flex-1 space-y-1 overflow-y-auto border-t border-amber-100/[0.08] p-2.5">
                {gs.log.length === 0 ? (
                  <div className="text-[10px] text-zinc-500">All quiet so far — go make some history.</div>
                ) : (
                  [...gs.log].reverse().map((entry, i) => (
                    // seq alone is not unique: one action can append several log lines.
                    <div key={`${entry.seq}:${i}`} className="text-[10px] leading-snug text-zinc-400">
                      {entry.playerId && <span className="font-bold text-zinc-300">{nameFor(entry.playerId)} </span>}
                      {entry.message}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Context menu */}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {/* Tap-for-mana color picker */}
      {manaPicker && (
        <ManaPickerPopover
          colors={manaPicker.colors}
          anchor={manaPicker.anchor}
          onPick={(color) => {
            send({ type: "tapForMana", instanceId: manaPicker.instanceId, color });
            setManaPicker(null);
          }}
          onClose={() => setManaPicker(null)}
        />
      )}

      {/* Mulligan overlay */}
      {showMulligan && !londonOpen && (
        <div className="fixed inset-0 z-[75] flex flex-col items-center justify-center gap-5 bg-black/80 p-6 backdrop-blur-sm">
          <div className="text-center">
            <h2 className="text-2xl font-black text-zinc-50">Opening hand</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {mull.mulls === 0 ? "Keep these seven, or mulligan?" : `Mulligan ${mull.mulls} — you will keep ${Math.max(0, 7 - mull.mulls)} cards.`}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {myHand.map((gc) => (
              <Card key={gc.instanceId} gameCard={gc} data={cards[gc.cardId]} size="md" />
            ))}
            {myHand.length === 0 && <div className="text-sm text-zinc-500">No cards — awaiting the deal…</div>}
          </div>
          <div className="flex gap-3">
            <button type="button" className="btn-gold !px-8" onClick={keepHand}>
              Keep
            </button>
            <button type="button" className="btn-ghost !px-6" onClick={takeMulligan} disabled={myHand.length === 0}>
              Mulligan
            </button>
          </div>
        </div>
      )}

      {/* London bottom-selection */}
      {londonOpen && (
        <LondonModal
          hand={myHand}
          cards={cards}
          bottomCount={expectedBottom}
          onCancel={() => setLondonOpen(false)}
          onConfirm={(ids) => {
            send({ type: "keepHand", bottomCount: ids.length, bottomInstanceIds: ids });
            mull.kept = true;
            setLondonOpen(false);
            forceRender((n) => n + 1);
          }}
        />
      )}

      {/* Browse graveyard/exile */}
      {browse && (
        <Modal
          title={`${nameFor(browse.playerId)} — ${browse.zone}`}
          onClose={() => setBrowse(null)}
          width="lg"
          noFooter
        >
          {(() => {
            const owner = browse.playerId === me.playerId ? me : opp;
            const zoneCards = owner.zones[browse.zone];
            const mine = browse.playerId === me.playerId && canAct;
            if (zoneCards.length === 0) {
              return <div className="py-8 text-center text-sm text-zinc-500">This zone is empty.</div>;
            }
            return (
              <div className="flex flex-wrap gap-2">
                {[...zoneCards].reverse().map((gc) => (
                  <Card
                    key={gc.instanceId}
                    gameCard={gc}
                    data={cards[gc.cardId]}
                    size="sm"
                    draggable={mine}
                    onDragStart={(e) => setDragPayload(e, { instanceId: gc.instanceId, from: browse.zone })}
                    onContextMenu={mine ? (e) => openMenu(e, browsePileMenu(gc, browse.zone)) : (e) => e.preventDefault()}
                    onClick={
                      mine
                        ? () => send({ type: "moveCard", instanceId: gc.instanceId, from: browse.zone, to: "hand" })
                        : undefined
                    }
                    title={mine ? "Click: return to hand · right-click: more" : undefined}
                  />
                ))}
              </div>
            );
          })()}
          {browse.playerId === me.playerId && (
            <p className="mt-3 text-[11px] text-zinc-500">Click a card to return it to your hand; right-click or drag it out for other zones.</p>
          )}
        </Modal>
      )}

      {/* Scry */}
      {scryCount !== null && (
        <ScryModal
          count={scryCount}
          library={me.zones.library}
          cards={cards}
          onCancel={() => setScryCount(null)}
          onConfirm={(keep, bottom) => {
            send({ type: "reorderLibraryTop", instanceIds: keep, toBottom: bottom });
            setScryCount(null);
          }}
        />
      )}

      {/* Token dialog */}

      {/* Concede confirm */}
      {concedeOpen && (
        <Modal
          title="Concede the game?"
          onClose={() => setConcedeOpen(false)}
          onConfirm={() => {
            send({ type: "concede" });
            setConcedeOpen(false);
          }}
          confirmLabel="Concede"
          danger
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            Your opponent will be declared the winner. This cannot be undone.
            {ranked && " Conceding counts as a ranked loss."}
          </p>
        </Modal>
      )}

      {/* End-match confirm */}
      {endMatchOpen && (
        <Modal
          title="End the match?"
          onClose={() => setEndMatchOpen(false)}
          onConfirm={() => {
            send({ type: "endMatch" });
            setEndMatchOpen(false);
          }}
          confirmLabel="End match"
          danger
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            The game ends for both players with no winner recorded. To leave the table without
            ending the game, use "Back to room" instead.
          </p>
        </Modal>
      )}

      {/* Draw override confirm */}
      {drawOverrideOpen && (
        <Modal
          title="Draw (manual override)"
          onClose={() => setDrawOverrideOpen(false)}
          onConfirm={() => {
            send({ type: "drawCard", count: 1, override: true });
            setDrawOverrideOpen(false);
          }}
          confirmLabel="Draw 1"
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            Draws normally come from the draw step and card effects. Use this only to execute
            manually-resolved card text — it is logged as an override.
          </p>
        </Modal>
      )}

      {/* Library search (fetch activation) — blocks until completeSearch */}
      {myPendingSearch && (
        <SearchLibraryModal
          pending={myPendingSearch}
          library={me.zones.library}
          cards={cards}
          onComplete={(instanceId) => send({ type: "completeSearch", instanceId })}
        />
      )}

      {/* Winner banner */}
      {gs.finished && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm">
          <div className="panel sparkle-field w-full max-w-md animate-pop-in border-brass-400/40 p-8 text-center shadow-[0_0_40px_rgba(251,191,36,0.25)]">
            <svg viewBox="0 0 24 24" className="mx-auto mb-3 h-12 w-12 animate-trophy fill-brass-300 drop-shadow-[0_0_10px_rgba(251,191,36,0.6)]"><path d="M5 3h14v2h3v4a5 5 0 0 1-4.5 4.97A6.5 6.5 0 0 1 13 17.4V19h3v2H8v-2h3v-1.6a6.5 6.5 0 0 1-4.5-3.43A5 5 0 0 1 2 9V5h3V3Zm0 4H4v2a3 3 0 0 0 1.6 2.66A11 11 0 0 1 5 7Zm15 0h-1a11 11 0 0 1-.6 4.66A3 3 0 0 0 20 9V7Z" /></svg>
            <h2 className="text-2xl font-black text-zinc-50">
              {winnerName ? `${winnerName} wins!` : "Game over"}
            </h2>
            {me.hasLost && me.lossReason && <p className="mt-1 text-sm text-zinc-400">{me.lossReason}</p>}
            {opp.hasLost && opp.lossReason && <p className="mt-1 text-sm text-zinc-400">{opp.lossReason}</p>}
            {myRatingDelta !== undefined && (
              <div className="mx-auto mt-4 flex w-fit items-center gap-2.5 rounded-xl border border-amber-100/10 bg-felt-950/70 px-4 py-2.5">
                {acct && <RankBadge rank={acct.rating.rank} />}
                <span
                  className={`text-lg font-black tabular-nums ${
                    myRatingDelta > 0 ? "text-emerald-300" : myRatingDelta < 0 ? "text-red-300" : "text-zinc-300"
                  }`}
                  title="Ranked rating change"
                >
                  {myRatingDelta > 0 ? `+${myRatingDelta}` : `${myRatingDelta}`}
                </span>
                {acct && (
                  <span className="text-xs text-zinc-400">
                    rating <span className="font-bold tabular-nums text-zinc-200">{acct.rating.rating}</span>
                  </span>
                )}
              </div>
            )}
            <div className="mt-6 flex justify-center gap-2">
              {viewerIsPlayer && !ranked && (
                <button type="button" className="btn-primary" onClick={() => send({ type: "restartGame", seed: randomSeed() })}>
                  Rematch
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={() => dispatch({ type: "dismissGame", gameId: view.gameId })}>
                Back to room
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tap-for-mana color picker — a small anchored popover with one pip per
// produced color. Closes on pick, click-away or Esc (ContextMenu-style).
// ---------------------------------------------------------------------------

interface ManaPickerPopoverProps {
  colors: string[];
  anchor: { left: number; right: number; top: number; bottom: number };
  onPick: (color: string) => void;
  onClose: () => void;
}

function ManaPickerPopover({ colors, anchor, onPick, onClose }: ManaPickerPopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Center above the card; flip below when cramped; clamp into the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = (anchor.left + anchor.right) / 2 - rect.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4));
    let top = anchor.top - rect.height - 8;
    if (top < 4) top = Math.min(anchor.bottom + 8, window.innerHeight - rect.height - 4);
    setPos({ left, top });
  }, [anchor]);

  useLayoutEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening click doesn't instantly close it.
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.left, top: -9999 }}
      className="fixed z-[90] animate-pop-in rounded-full border border-amber-300/30 bg-felt-850/95 px-2 py-1.5 shadow-card-lg backdrop-blur-sm"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onPick(color)}
            title={`Tap for ${MANA_COLOR_NAMES[color] ?? color}`}
            className="flex h-8 w-8 items-center justify-center rounded-full shadow-card transition-all duration-150 hover:scale-110 active:scale-95"
          >
            <ManaSymbol symbol={color} className="pointer-events-none h-8 w-8" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating mana strip — docked above the hand fan whenever your pool holds
// mana. Mirrors the side-rail ManaPool; clicking a pip spends one.
// ---------------------------------------------------------------------------

interface FloatingManaStripProps {
  pool: Record<string, number>;
  editable: boolean;
  onSpend: (color: string) => void;
}

function FloatingManaStrip({ pool, editable, onSpend }: FloatingManaStripProps): JSX.Element {
  const entries = MANA_ORDER.map((c) => [c, pool[c] ?? 0] as const).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  // Always mounted, absolutely positioned: pops in/out via CSS transitions
  // without shifting the hand fan.
  return (
    <div
      className={`absolute bottom-full left-1/2 z-30 mb-1 -translate-x-1/2 transition-all duration-200 ease-out ${
        total > 0 ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-2 scale-75 opacity-0"
      }`}
      aria-hidden={total === 0}
    >
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-felt-950/85 px-3 py-1.5 shadow-[0_0_18px_rgba(251,191,36,0.22),0_8px_24px_rgba(8,6,30,0.5)] backdrop-blur-sm">
          {entries.map(([color, n]) => (
            <button
              key={color}
              type="button"
              disabled={!editable}
              onClick={() => onSpend(color)}
              title={editable ? `${n} ${MANA_COLOR_NAMES[color] ?? color} — click to spend one` : `${n} ${MANA_COLOR_NAMES[color] ?? color}`}
              className={`relative flex h-9 w-9 animate-pop-in items-center justify-center rounded-full shadow-[0_0_10px_rgba(251,191,36,0.35)] transition-all duration-150 disabled:cursor-default ${
                editable ? "hover:scale-110 active:scale-95" : ""
              }`}
            >
              <ManaSymbol symbol={color} className="pointer-events-none h-9 w-9" />
              <span
                key={n}
                className="animate-count-pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-felt-950 px-1 text-[10px] font-bold text-brass-300 ring-1 ring-amber-200/40"
              >
                {n}
              </span>
            </button>
          ))}
        </div>
        <span className="rounded-full bg-felt-950/70 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
          Empties at end of step
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// London bottom-selection modal
// ---------------------------------------------------------------------------

interface LondonModalProps {
  hand: GameCard[];
  cards: Record<string, CardData>;
  bottomCount: number;
  onCancel: () => void;
  onConfirm: (bottomIds: string[]) => void;
}

function LondonModal({ hand, cards, bottomCount, onCancel, onConfirm }: LondonModalProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (id: string): void => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < bottomCount ? [...cur, id] : cur));
  };

  return (
    <Modal
      title={`Put ${bottomCount} card${bottomCount === 1 ? "" : "s"} on the bottom`}
      onClose={onCancel}
      onConfirm={() => onConfirm(selected)}
      confirmLabel={`Keep ${hand.length - selected.length}`}
      confirmDisabled={selected.length !== bottomCount}
      width="lg"
    >
      <p className="mb-3 text-xs text-zinc-400">
        London mulligan: choose {bottomCount} card{bottomCount === 1 ? "" : "s"} to put on the bottom of your library.
        Selected {selected.length}/{bottomCount}.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {hand.map((gc) => (
          <Card
            key={gc.instanceId}
            gameCard={gc}
            data={cards[gc.cardId]}
            size="sm"
            selected={selected.includes(gc.instanceId)}
            dimmed={selected.includes(gc.instanceId)}
            onClick={() => toggle(gc.instanceId)}
          />
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Scry modal — renders from the viewer's (redacted) library order. Card data
// appears for entries revealed by the preceding `scry` action, otherwise each
// row shows "Card N" with a back.
// ---------------------------------------------------------------------------

interface ScryModalProps {
  count: number;
  library: GameCard[];
  cards: Record<string, CardData>;
  onCancel: () => void;
  onConfirm: (keepInOrder: string[], toBottom: string[]) => void;
}

function ScryModal({ count, library, cards, onCancel, onConfirm }: ScryModalProps): JSX.Element {
  const [order, setOrder] = useState<string[]>(() => library.slice(0, count).map((gc) => gc.instanceId));
  const [bottomSet, setBottomSet] = useState<ReadonlySet<string>>(new Set());

  const byId = new Map(library.map((gc) => [gc.instanceId, gc]));
  const kept = order.filter((id) => !bottomSet.has(id));
  const bottomed = order.filter((id) => bottomSet.has(id));

  const move = (id: string, dir: -1 | 1): void => {
    setOrder((cur) => {
      const i = cur.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      const a = next[i];
      const b = next[j];
      if (a === undefined || b === undefined) return cur;
      next[i] = b;
      next[j] = a;
      return next;
    });
  };

  const toggleBottom = (id: string): void => {
    setBottomSet((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      title={`Scry ${count}`}
      onClose={onCancel}
      onConfirm={() => onConfirm(kept, bottomed)}
      confirmLabel="Done"
      width="md"
    >
      <p className="mb-3 text-xs text-zinc-400">
        Reorder the top of your library; send cards to the bottom. The first card in the list ends up on top.
      </p>
      <div className="space-y-1.5">
        {order.map((id, i) => {
          const gc = byId.get(id);
          const data = gc ? cards[gc.cardId] : undefined;
          const revealed = gc !== undefined && gc.cardId !== "hidden" && data !== undefined;
          const isBottom = bottomSet.has(id);
          return (
            <div key={id} className={`flex items-center gap-2.5 rounded-lg p-1.5 ${isBottom ? "bg-red-500/5 opacity-70" : "bg-white/[0.03]"}`}>
              <div className="w-[52px] shrink-0">
                {revealed && gc ? <Card gameCard={gc} data={data} size="xs" className="!w-full" /> : <div className="aspect-[5/7]"><CardBack /></div>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-zinc-100">
                  {revealed && gc ? nameOf(gc, data) : `Card ${i + 1}`}
                </div>
                <div className="text-[10px] text-zinc-500">{isBottom ? "to the bottom" : `stays on top (position ${kept.indexOf(id) + 1})`}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" className="btn-ghost !px-2 !py-1 !text-[10px]" disabled={i === 0} onClick={() => move(id, -1)} aria-label="Move up">
                  ↑
                </button>
                <button type="button" className="btn-ghost !px-2 !py-1 !text-[10px]" disabled={i === order.length - 1} onClick={() => move(id, 1)} aria-label="Move down">
                  ↓
                </button>
                <button
                  type="button"
                  className={`btn-ghost !px-2 !py-1 !text-[10px] ${isBottom ? "!border-red-400/40 !text-red-300" : ""}`}
                  onClick={() => toggleBottom(id)}
                >
                  {isBottom ? "Keep" : "Bottom"}
                </button>
              </div>
            </div>
          );
        })}
        {order.length === 0 && <div className="py-6 text-center text-sm text-zinc-500">Library is empty.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Library search modal (v4 fetch activation) — deliberately NOT the shared
// Modal: it must block (no backdrop close, no Esc, no X) until the player
// either picks an eligible card or fails to find. Driven purely by server
// state: it disappears when the view's pendingSearch clears; a rejected ack
// toasts and the modal stays.
// ---------------------------------------------------------------------------

interface SearchLibraryModalProps {
  pending: NonNullable<GameState["pendingSearch"]>;
  library: GameCard[];
  cards: Record<string, CardData>;
  onComplete: (instanceId: string | null) => void;
}

function SearchLibraryModal({ pending, library, cards, onComplete }: SearchLibraryModalProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);

  // The view reveals our library during the search; show ONLY eligible cards,
  // sorted for browsing (never in library order — no free peeks at the top).
  const eligible = library
    .filter((gc) => gc.cardId !== "hidden" && matchesSearchFilter(cards[gc.cardId], pending.filter))
    .sort((a, b) => compareByCmcName(cards[a.cardId], cards[b.cardId]));

  const destLabel =
    pending.destination === "hand"
      ? "put it into your hand"
      : pending.entersTapped
        ? "put it onto the battlefield tapped"
        : "put it onto the battlefield";
  const confirmLabel =
    pending.destination === "hand"
      ? "Put into hand"
      : pending.entersTapped
        ? "Put onto battlefield tapped"
        : "Put onto battlefield";

  return (
    // z-[65]: above the board and mode hints (z-60), below the hover-preview
    // layer (z-70) so card previews still work inside the search grid.
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="panel flex max-h-[88vh] w-full max-w-3xl animate-pop-in flex-col overflow-hidden border-brass-400/30">
        <div className="border-b border-amber-100/[0.08] px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-200">
            Search your library — {pending.sourceName}
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-400">Choose an eligible card to {destLabel}, or fail to find.</p>
        </div>
        <div className="scrollbar-slim flex-1 overflow-y-auto p-4">
          {eligible.length === 0 ? (
            <div className="py-10 text-center text-sm text-zinc-500">No eligible cards in your library.</div>
          ) : (
            <CardGrid min={100}>
              {eligible.map((gc) => (
                <Card
                  key={gc.instanceId}
                  gameCard={gc}
                  data={cards[gc.cardId]}
                  size="sm"
                  selected={selected === gc.instanceId}
                  onClick={() => setSelected((cur) => (cur === gc.instanceId ? null : gc.instanceId))}
                />
              ))}
            </CardGrid>
          )}
          {pending.shuffle && (
            <p className="mt-3 text-center text-[11px] text-zinc-500">Your library will be shuffled.</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-amber-100/[0.08] px-4 py-3">
          <button type="button" className="btn-ghost" onClick={() => onComplete(null)}>
            Fail to find
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) onComplete(selected);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
