/**
 * Turn/phase ribbon: all TURN_STEPS with the current one highlighted, whose
 * turn it is, priority indicator, and step/turn/priority controls.
 */
import { TURN_STEPS, type TurnStep } from "@mtg-cube/shared";

const STEP_LABELS: Record<TurnStep, { short: string; full: string }> = {
  untap: { short: "UN", full: "Untap" },
  upkeep: { short: "UP", full: "Upkeep" },
  draw: { short: "DR", full: "Draw" },
  main1: { short: "M1", full: "First main" },
  beginCombat: { short: "BC", full: "Begin combat" },
  declareAttackers: { short: "AT", full: "Declare attackers" },
  declareBlockers: { short: "BL", full: "Declare blockers" },
  combatDamage: { short: "DM", full: "Combat damage" },
  endCombat: { short: "EC", full: "End combat" },
  main2: { short: "M2", full: "Second main" },
  end: { short: "EN", full: "End step" },
  cleanup: { short: "CL", full: "Cleanup" },
};

const COMBAT_STEPS: ReadonlySet<TurnStep> = new Set<TurnStep>([
  "beginCombat",
  "declareAttackers",
  "declareBlockers",
  "combatDamage",
  "endCombat",
]);

interface PhaseRibbonProps {
  step: TurnStep;
  turnNumber: number;
  activePlayerName: string;
  isMyTurn: boolean;
  haveIPriority: boolean;
  priorityPlayerName: string;
  finished: boolean;
  onNextStep: () => void;
  onNextTurn: () => void;
  onPassPriority: () => void;
}

export function PhaseRibbon(props: PhaseRibbonProps): JSX.Element {
  const {
    step,
    turnNumber,
    activePlayerName,
    isMyTurn,
    haveIPriority,
    priorityPlayerName,
    finished,
    onNextStep,
    onNextTurn,
    onPassPriority,
  } = props;

  return (
    <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-brass-400/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-brass-300">
          Turn {turnNumber}
        </span>
        <span className="text-xs text-zinc-400">
          <span className={`font-bold ${isMyTurn ? "text-emerald-300" : "text-zinc-200"}`}>{activePlayerName}</span>
          {isMyTurn ? " (you)" : ""}
        </span>
      </div>

      <div className="flex flex-1 items-center justify-center gap-0.5">
        {TURN_STEPS.map((s) => {
          const current = s === step;
          const combat = COMBAT_STEPS.has(s);
          return (
            <span
              key={s}
              title={STEP_LABELS[s].full}
              className={`rounded px-1.5 py-1 text-[10px] font-bold transition-all duration-150 ${
                current
                  ? combat
                    ? "scale-110 bg-red-500/90 text-white shadow-card"
                    : "scale-110 bg-emerald-500/90 text-felt-950 shadow-card"
                  : "bg-white/[0.04] text-zinc-500"
              }`}
            >
              {STEP_LABELS[s].short}
            </span>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <span
          className={`chip ${haveIPriority ? "border-emerald-400/50 text-emerald-300" : "border-white/10 text-zinc-400"}`}
          title="Who holds priority"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${haveIPriority ? "bg-emerald-400" : "bg-zinc-500"}`} />
          {haveIPriority ? "Your priority" : `${priorityPlayerName} has priority`}
        </span>
        <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-xs" onClick={onPassPriority} disabled={!haveIPriority || finished} title="Pass priority">
          Pass
        </button>
        <button type="button" className="btn-ghost !px-2.5 !py-1.5 !text-xs" onClick={onNextStep} disabled={!isMyTurn || finished} title="Advance to the next step (active player only)">
          Next step
        </button>
        <button type="button" className="btn-primary !px-2.5 !py-1.5 !text-xs" onClick={onNextTurn} disabled={!isMyTurn || finished} title="End your turn (active player only)">
          Next turn
        </button>
      </div>
    </div>
  );
}
