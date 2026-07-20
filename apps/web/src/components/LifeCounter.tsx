/**
 * Life + poison controls for one player.
 */
interface LifeCounterProps {
  name: string;
  life: number;
  poison: number;
  connected?: boolean;
  isActiveTurn?: boolean;
  hasPriority?: boolean;
  hasLost?: boolean;
  /** Whether the viewer may change these totals (own player only). */
  editable: boolean;
  onLife: (next: number) => void;
  onPoison: (next: number) => void;
}

function StepButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-amber-100/15 bg-white/[0.05] px-1.5 py-0.5 text-[11px] font-bold text-zinc-300 transition-colors duration-150 hover:border-amber-200/30 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {label}
    </button>
  );
}

export function LifeCounter(props: LifeCounterProps): JSX.Element {
  const { name, life, poison, connected = true, isActiveTurn = false, hasPriority = false, hasLost = false, editable, onLife, onPoison } = props;

  return (
    <div className={`panel-inset p-2.5 ${hasLost ? "opacity-60" : ""}`}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-400" : "bg-red-500"}`}
          title={connected ? "Connected" : "Disconnected"}
        />
        <span className="truncate text-xs font-bold text-zinc-100">{name}</span>
        {isActiveTurn && <span className="chip border-brass-400/40 text-brass-300">turn</span>}
        {hasPriority && <span className="chip border-amber-400/50 text-amber-300">priority</span>}
        {hasLost && <span className="chip border-red-400/40 text-red-300">lost</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <StepButton label="-5" onClick={() => onLife(life - 5)} disabled={!editable} />
          <StepButton label="-1" onClick={() => onLife(life - 1)} disabled={!editable} />
        </div>
        <span
          className={`min-w-[3rem] text-center text-3xl font-black tabular-nums text-shadow ${life <= 5 ? "text-red-400" : "text-zinc-50"}`}
        >
          {life}
        </span>
        <div className="flex items-center gap-1">
          <StepButton label="+1" onClick={() => onLife(life + 1)} disabled={!editable} />
          <StepButton label="+5" onClick={() => onLife(life + 5)} disabled={!editable} />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] text-zinc-400">
        <StepButton label="-" onClick={() => onPoison(Math.max(0, poison - 1))} disabled={!editable} />
        <span className={`font-semibold ${poison >= 7 ? "text-green-300" : ""}`} title="Poison counters">
          Poison {poison}
        </span>
        <StepButton label="+" onClick={() => onPoison(poison + 1)} disabled={!editable} />
      </div>
    </div>
  );
}
