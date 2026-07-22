/**
 * v15: what the ONE contextual action button says and does.
 *
 * Arena shows a single control bottom-right whose label is derived entirely
 * from game state — "Next / To Combat", "No Attacks", "All Attack",
 * "1 Attacker / To Blockers", "Cancel Attacks". Before v15 this repo had
 * three fixed buttons (Pass / Next step / Next turn) and the client decided
 * on its own when each was meaningful.
 *
 * Deriving the descriptor here rather than in the component keeps the button
 * honest: it can only ever offer an action the engine will accept, and the
 * label comes from the same turn-structure table the engine advances through.
 */
import type { CardData, GameAction, GameCard, GameState, TurnStep } from "../types.js";

export type PromptKind =
  /** Someone else's decision — the button is disabled. */
  | "waiting"
  /** The opening-hand UI owns the screen. */
  | "mulligan"
  /** A library search is in progress. */
  | "searching"
  /** This player must pick a target before the stack can resolve. */
  | "chooseTarget"
  /** The attacker declaration window is open for this player. */
  | "declareAttackers"
  /** The blocker declaration window is open for this player. */
  | "declareBlockers"
  /** This player holds priority with something on the stack. */
  | "respond"
  /** This player holds priority with an empty stack. */
  | "advance"
  /** The game is over. */
  | "finished";

export interface PromptButton {
  label: string;
  action: GameAction;
}

export interface ActionPrompt {
  kind: PromptKind;
  /** Primary button label. */
  label: string;
  /** Small second line under the primary label ("To Combat"). */
  sublabel?: string;
  /** What the primary button sends; null when there is nothing to send. */
  action: GameAction | null;
  /** Optional alternative ("All Attack", "Cancel Attacks"). */
  secondary?: PromptButton;
  /** False renders the button disabled (waiting on the opponent). */
  enabled: boolean;
  /** Centre-of-board banner, Arena-style ("Choose attackers."). */
  banner?: string;
}

/** Where passing priority in this step will take you next. */
const NEXT_STOP: Record<TurnStep, string> = {
  untap: "To Upkeep",
  upkeep: "To Draw",
  draw: "To Main Phase",
  main1: "To Combat",
  beginCombat: "To Attacks",
  declareAttackers: "To Blockers",
  declareBlockers: "To Damage",
  combatDamage: "To End of Combat",
  endCombat: "To Second Main",
  main2: "To End Step",
  end: "End Turn",
  cleanup: "End Turn",
};

function typeLineOf(card: GameCard, cards: Record<string, CardData>): string | undefined {
  if (card.isToken) return card.tokenTypeLine;
  const data = cards[card.cardId];
  return data?.faces?.[0]?.typeLine ?? data?.typeLine;
}

/** Creature check; false when the card data isn't loaded. */
export function isCreatureCard(card: GameCard, cards: Record<string, CardData>): boolean {
  const tl = typeLineOf(card, cards);
  return tl !== undefined && /\bCreature\b/i.test(tl);
}

/** Creatures this player could still add to the attack (CR 508.1a). */
export function eligibleAttackers(
  s: GameState,
  playerId: string,
  cards: Record<string, CardData>
): GameCard[] {
  const p = s.players.find((x) => x.playerId === playerId);
  if (!p) return [];
  return p.zones.battlefield.filter((c) => !c.tapped && !c.attacking && isCreatureCard(c, cards));
}

/**
 * Describe the action button for `viewerId`. `cards` is only needed to count
 * attackers for the "All Attack" shortcut — everything else is pure state.
 */
export function describePrompt(
  s: GameState,
  viewerId: string,
  cards: Record<string, CardData> = {}
): ActionPrompt {
  const disabled = (kind: PromptKind, label: string, banner?: string): ActionPrompt => ({
    kind,
    label,
    action: null,
    enabled: false,
    ...(banner !== undefined ? { banner } : {}),
  });

  if (s.finished) return disabled("finished", "Game over");
  if (s.turnNumber === 1 && s.step === "untap" && (s.openingHandKept?.length ?? 0) < 2) {
    return disabled(
      "mulligan",
      "Opening hand",
      (s.openingHandKept ?? []).includes(viewerId) ? "Waiting for your opponent to keep…" : undefined
    );
  }
  if (s.pendingSearch) {
    return disabled(
      "searching",
      "Searching…",
      s.pendingSearch.playerId === viewerId ? undefined : "Your opponent is searching their library…"
    );
  }

  const isActive = s.activePlayerId === viewerId;
  const combat = s.combat;

  // --- Declaration windows (CR 508.1 / 509.1) ------------------------------
  if (s.step === "declareAttackers" && combat && !combat.attackersDeclared) {
    if (!isActive) return disabled("waiting", "Waiting…", "Your opponent is choosing attackers.");
    const attacking = attackerCount(s, viewerId);
    const eligible = eligibleAttackers(s, viewerId, cards);
    if (attacking === 0) {
      return {
        kind: "declareAttackers",
        label: "No Attacks",
        action: { type: "commitAttackers" },
        enabled: true,
        banner: "Choose attackers.",
        ...(eligible.length > 0
          ? { secondary: { label: "All Attack", action: { type: "declareAllAttackers" } } }
          : {}),
      };
    }
    return {
      kind: "declareAttackers",
      label: `${attacking} Attacker${attacking === 1 ? "" : "s"}`,
      sublabel: "To Blockers",
      action: { type: "commitAttackers" },
      enabled: true,
      banner: "Choose attackers.",
      secondary: { label: "Cancel Attacks", action: { type: "clearAttackers" } },
    };
  }

  if (s.step === "declareBlockers" && combat && !combat.blockersDeclared) {
    if (isActive) return disabled("waiting", "Waiting…", "Your opponent is choosing blockers.");
    const blocking = blockerCount(s, viewerId);
    return {
      kind: "declareBlockers",
      label: blocking === 0 ? "No Blocks" : `${blocking} Blocker${blocking === 1 ? "" : "s"}`,
      ...(blocking === 0 ? {} : { sublabel: "To Damage" }),
      action: { type: "commitBlockers" },
      enabled: true,
      banner: "Choose blockers.",
    };
  }

  // --- Ordinary priority ---------------------------------------------------
  if (s.priorityPlayerId !== viewerId) {
    return disabled("waiting", "Waiting…");
  }
  if (s.stack.length > 0) {
    const top = s.stack[s.stack.length - 1]!;
    return {
      kind: "respond",
      label: "Pass",
      sublabel: s.priorityPasses >= 1 ? "Resolve" : "To Opponent",
      action: { type: "passPriority" },
      enabled: true,
      ...(top.controllerId === viewerId ? {} : { banner: undefined }),
    };
  }
  return {
    kind: "advance",
    label: "Next",
    sublabel: NEXT_STOP[s.step],
    action: { type: "passPriority" },
    enabled: true,
  };
}

function attackerCount(s: GameState, playerId: string): number {
  const p = s.players.find((x) => x.playerId === playerId);
  return p ? p.zones.battlefield.filter((c) => c.attacking).length : 0;
}

function blockerCount(s: GameState, playerId: string): number {
  const p = s.players.find((x) => x.playerId === playerId);
  return p ? p.zones.battlefield.filter((c) => c.blocking !== null).length : 0;
}
