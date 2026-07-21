/**
 * Mana-curve chart in pure divs, buckets 0–7+, styled like Arena's deck-editor
 * curve: slim vertical amber bars on a dark inset well, small count labels
 * above each bar (brightening on hover), no boxy grid. Used on both the
 * Deckbuild right rail and the Draft stats rail.
 */
import { CMC_BUCKET_LABELS } from "../lib/cards";

interface CurveChartProps {
  /** Counts per cmc bucket, index 0..7 ("7+"). */
  counts: number[];
}

export function CurveChart({ counts }: CurveChartProps): JSX.Element {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="panel-inset p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Mana curve</span>
        <span className="text-[10px] font-semibold tabular-nums text-zinc-500">{total} spells</span>
      </div>
      <div className="curve-chart-well flex h-28 items-end gap-1 rounded-lg bg-felt-950/70 px-2 pb-1.5 pt-2 shadow-[inset_0_1px_5px_rgba(8,6,30,0.65),inset_0_-1px_0_rgba(255,221,150,0.05)]">
        {CMC_BUCKET_LABELS.map((label, i) => {
          const n = counts[i] ?? 0;
          const pct = (n / max) * 100;
          return (
            <div
              key={label}
              className="group flex h-full flex-1 flex-col items-center justify-end gap-1"
              title={`${n} card${n === 1 ? "" : "s"} at cost ${label}`}
            >
              <span
                className={`text-[9px] font-bold tabular-nums leading-none transition-colors duration-150 ${
                  n > 0 ? "text-amber-300/80 group-hover:text-amber-100" : "text-zinc-700 group-hover:text-zinc-500"
                }`}
              >
                {n}
              </span>
              <div
                className={`w-2.5 rounded-full transition-all duration-300 ${
                  n > 0
                    ? "bg-gradient-to-t from-amber-700 via-brass-400 to-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.35)] group-hover:shadow-[0_0_12px_rgba(251,191,36,0.55)]"
                    : "bg-white/[0.06]"
                }`}
                style={{ height: `${Math.max(n > 0 ? 7 : 2.5, pct * 0.74)}%` }}
              />
              <span className="text-[9px] font-semibold leading-none text-zinc-500">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
