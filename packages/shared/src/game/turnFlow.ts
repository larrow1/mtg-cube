/**
 * v15: the turn structure as DATA.
 *
 * Every fact about a step lives in ONE record here — which phase it belongs
 * to, whether players receive priority in it, and how it is labelled. Before
 * v15 this knowledge was spread across three hardcoded lists that had to be
 * kept in sync by hand: the engine's `TRANSIT_STEPS`, the client's
 * `COMBAT_STEPS`, and Auto mode's `step === "untap" || step === "end"`
 * if-chain.
 *
 * The important correction (CR 500.3, 502.4, 514.3): the ONLY steps in which
 * no player receives priority are untap and (normally) cleanup. v12's
 * "transit steps" — upkeep, draw, beginCombat, endCombat — are ordinary
 * priority-granting steps that players merely tend to have nothing to do in.
 * Modelling them as priority-less made it impossible to cast an instant in
 * your own upkeep or respond before attackers were declared. v15 gives every
 * step its real priority window and skips the boring ones with auto-pass
 * (CR 732 shortcuts) instead.
 */
import { TURN_STEPS, type GameState, type TurnStep } from "../types.js";

export type TurnPhase = "beginning" | "precombatMain" | "combat" | "postcombatMain" | "ending";

/** Grouping for the client's Arena-style phase ribbon. */
export type StepGroup = "beginning" | "main1" | "attack" | "block" | "damage" | "main2" | "ending";

export interface StepInfo {
  phase: TurnPhase;
  /**
   * CR 500.3: "A step in which no players receive priority ends when all
   * specified actions that take place during that step are completed. The
   * only such steps are the untap step and certain cleanup steps."
   */
  grantsPriority: boolean;
  group: StepGroup;
  /** Two-letter ribbon label. */
  short: string;
  /** Human-readable step name. */
  full: string;
}

export const STEP_INFO: Record<TurnStep, StepInfo> = {
  untap: { phase: "beginning", grantsPriority: false, group: "beginning", short: "UN", full: "Untap" },
  upkeep: { phase: "beginning", grantsPriority: true, group: "beginning", short: "UP", full: "Upkeep" },
  draw: { phase: "beginning", grantsPriority: true, group: "beginning", short: "DR", full: "Draw" },
  main1: { phase: "precombatMain", grantsPriority: true, group: "main1", short: "M1", full: "First main" },
  beginCombat: { phase: "combat", grantsPriority: true, group: "attack", short: "BC", full: "Begin combat" },
  declareAttackers: { phase: "combat", grantsPriority: true, group: "attack", short: "AT", full: "Declare attackers" },
  declareBlockers: { phase: "combat", grantsPriority: true, group: "block", short: "BL", full: "Declare blockers" },
  combatDamage: { phase: "combat", grantsPriority: true, group: "damage", short: "DM", full: "Combat damage" },
  endCombat: { phase: "combat", grantsPriority: true, group: "damage", short: "EC", full: "End of combat" },
  main2: { phase: "postcombatMain", grantsPriority: true, group: "main2", short: "M2", full: "Second main" },
  end: { phase: "ending", grantsPriority: true, group: "ending", short: "EN", full: "End step" },
  cleanup: { phase: "ending", grantsPriority: false, group: "ending", short: "CL", full: "Cleanup" },
};

/** The seven slots of the Arena-style phase ribbon, in display order. */
export const PHASE_RIBBON: { group: StepGroup; label: string; steps: TurnStep[] }[] = [
  { group: "beginning", label: "Beginning", steps: ["untap", "upkeep", "draw"] },
  { group: "main1", label: "First main", steps: ["main1"] },
  { group: "attack", label: "Attackers", steps: ["beginCombat", "declareAttackers"] },
  { group: "block", label: "Blockers", steps: ["declareBlockers"] },
  { group: "damage", label: "Damage", steps: ["combatDamage", "endCombat"] },
  { group: "main2", label: "Second main", steps: ["main2"] },
  { group: "ending", label: "End", steps: ["end", "cleanup"] },
];

/** CR 505: is this one of the two main phases? */
export function isMainPhase(step: TurnStep): boolean {
  return step === "main1" || step === "main2";
}

/**
 * The step that follows `step` in the printed order, or null at the end of
 * the turn (cleanup). Pure ordering — skips are applied by `nextStepFrom`.
 */
export function followingStep(step: TurnStep): TurnStep | null {
  const idx = TURN_STEPS.indexOf(step);
  return TURN_STEPS[idx + 1] ?? null;
}

/**
 * The next step to actually enter from `s.step`, honouring skips.
 *
 * CR 508.8: "If no creatures are declared as attackers or put onto the
 * battlefield attacking, skip the declare blockers and combat damage steps."
 * Note this is decided by what was DECLARED, not by what is still attacking —
 * killing the lone attacker in response does not un-skip the steps.
 *
 * Returns null when the turn is over (cleanup).
 */
export function nextStepFrom(s: GameState): TurnStep | null {
  if (s.step === "declareAttackers" && (s.combat?.attackersThisCombat ?? 0) === 0) {
    return "endCombat";
  }
  return followingStep(s.step);
}
