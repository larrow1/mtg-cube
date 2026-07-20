/**
 * Mana-curve bar chart in pure divs, buckets 0–7+.
 */
import { CMC_BUCKET_LABELS } from "../lib/cards";

interface CurveChartProps {
  /** Counts per cmc bucket, index 0..7 ("7+"). */
  counts: number[];
}

export function CurveChart({ counts }: CurveChartProps): JSX.Element {
  const max = Math.max(1, ...counts);
  return (
    <div className="panel-inset p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Mana curve</div>
      <div className="flex h-24 items-end gap-1.5">
        {CMC_BUCKET_LABELS.map((label, i) => {
          const n = counts[i] ?? 0;
          const pct = Math.round((n / max) * 100);
          return (
            <div key={label} className="flex flex-1 flex-col items-center gap-1" title={`${n} card${n === 1 ? "" : "s"} at cmc ${label}`}>
              <span className={`text-[10px] font-bold tabular-nums ${n > 0 ? "text-amber-300" : "text-zinc-600"}`}>{n}</span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t transition-all duration-300 ${n > 0 ? "bg-gradient-to-t from-amber-600 to-amber-300" : "bg-white/[0.05]"}`}
                  style={{ height: `${Math.max(n > 0 ? 8 : 2, pct)}%` }}
                />
              </div>
              <span className="text-[9px] font-semibold text-zinc-500">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
