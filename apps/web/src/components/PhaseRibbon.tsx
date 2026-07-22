/**
 * v15: the Arena-style phase ribbon plus the ONE contextual action button.
 *
 * The seven ribbon slots and the button's label/action both come from shared
 * (`PHASE_RIBBON`, `describePrompt`) — this component only draws them. Before
 * v15 the client had three fixed buttons (Pass / Next step / Next turn) and
 * decided on its own when each was meaningful, which drifted from what the
 * engine would actually accept.
 */
import { PHASE_RIBBON, STEP_INFO, type ActionPrompt, type GameAction, type StepGroup, type TurnStep } from "@mtg-cube/shared";

interface PhaseRibbonProps {
  step: TurnStep;
  turnNumber: number;
  activePlayerName: string;
  isMyTurn: boolean;
  haveIPriority: boolean;
  priorityPlayerName: string;
  prompt: ActionPrompt;
  /** v15: this viewer's auto-pass setting (false = holding full control). */
  autoPass: boolean;
  onSend: (action: GameAction) => void;
  onToggleAutoPass: () => void;
}

/** Small mark for each ribbon slot, mirroring Arena's ◆ ▪ ⚔ 🛡 ★ ▪ ◆. */
function SlotIcon({ group, className }: { group: StepGroup; className: string }): JSX.Element {
  switch (group) {
    case "attack":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor">
          <path d="M6.9 2 4 4.9l9.1 9.1-1.6 1.6 1.4 1.4 1.6-1.6 2.2 2.2-1.1 1.1 1.4 1.4 3.6-3.6-1.4-1.4-1.1 1.1-2.2-2.2 1.6-1.6-1.4-1.4-1.6 1.6ZM4 17.7l1.4 1.4-1.1 1.1L5.7 22l3.6-3.6-1.4-1.4-1.1 1.1L5.4 16.7Z" />
        </svg>
      );
    case "block":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor">
          <path d="M12 2 4 5v6.5c0 4.6 3.4 8.9 8 10.5 4.6-1.6 8-5.9 8-10.5V5l-8-3Z" />
        </svg>
      );
    case "damage":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor">
          <path d="m12 2 2.9 6.2 6.6.9-4.8 4.6 1.2 6.6L12 17.2 6.1 20.3l1.2-6.6-4.8-4.6 6.6-.9L12 2Z" />
        </svg>
      );
    case "main1":
    case "main2":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor">
          <path d="m12 3 8 9-8 9-8-9 8-9Z" />
        </svg>
      );
  }
}

export function PhaseRibbon(props: PhaseRibbonProps): JSX.Element {
  const {
    step,
    turnNumber,
    activePlayerName,
    isMyTurn,
    haveIPriority,
    priorityPlayerName,
    prompt,
    autoPass,
    onSend,
    onToggleAutoPass,
  } = props;

  const currentGroup = STEP_INFO[step].group;

  return (
    <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-brass-400/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-brass-300">
          Turn {turnNumber}
        </span>
        <span className="text-xs text-zinc-400">
          <span className={`font-bold ${isMyTurn ? "text-brass-300" : "text-zinc-200"}`}>{activePlayerName}</span>
          {isMyTurn ? " (you)" : ""}
        </span>
      </div>

      {/* Phase strip — one slot per phase, combat split into attack/block/damage */}
      <div className="flex flex-1 items-center justify-center gap-1">
        {PHASE_RIBBON.map((slot) => {
          const current = slot.group === currentGroup;
          const combat = slot.group === "attack" || slot.group === "block" || slot.group === "damage";
          return (
            <span
              key={slot.group}
              title={current ? `${slot.label} — now: ${STEP_INFO[step].full}` : slot.label}
              className={`flex h-6 w-6 items-center justify-center rounded transition-all duration-150 ${
                current
                  ? combat
                    ? "scale-110 bg-red-500/90 text-white shadow-card"
                    : "scale-110 bg-gradient-to-b from-brass-300 to-brass-500 text-amber-950 shadow-card"
                  : "bg-white/[0.05] text-zinc-600"
              }`}
            >
              <SlotIcon group={slot.group} className="h-3.5 w-3.5" />
            </span>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <span
          className={`chip ${haveIPriority ? "border-amber-400/50 text-amber-300" : "border-white/10 text-zinc-400"}`}
          title="Who holds priority"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${haveIPriority ? "bg-amber-400" : "bg-zinc-500"}`} />
          {haveIPriority ? "Your priority" : `${priorityPlayerName} has priority`}
        </span>

        <button
          type="button"
          onClick={onToggleAutoPass}
          title={
            autoPass
              ? "Auto-pass is ON: steps you have no play in pass by themselves. Click to hold full control and stop at every priority window."
              : "Holding full control: every priority window stops for you. Click to turn auto-pass back on."
          }
          className={`chip transition-colors duration-150 ${
            autoPass
              ? "border-white/15 font-semibold tracking-wide text-zinc-400 hover:text-zinc-200"
              : "border-sky-400/60 font-black tracking-wide text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.25)]"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${autoPass ? "bg-zinc-600" : "animate-pulse bg-sky-400"}`} />
          {autoPass ? "AUTO" : "FULL CONTROL"}
        </button>

        {prompt.secondary && (
          <button
            type="button"
            className="btn-ghost !px-2.5 !py-1.5 !text-xs"
            onClick={() => prompt.secondary && onSend(prompt.secondary.action)}
          >
            {prompt.secondary.label}
          </button>
        )}

        <button
          type="button"
          className="btn-primary min-w-[7rem] !px-3 !py-1.5 leading-tight"
          disabled={!prompt.enabled || prompt.action === null}
          onClick={() => prompt.action && onSend(prompt.action)}
        >
          <span className="block text-xs font-black tracking-wide">{prompt.label}</span>
          {prompt.sublabel && (
            <span className="block text-[9px] font-semibold uppercase tracking-wider opacity-70">
              {prompt.sublabel}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
