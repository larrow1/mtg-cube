/**
 * WUBRG+C mana pool pips. Click adds one, right-click removes one.
 */
import { ManaSymbol } from "./ManaSymbol";

const MANA_ORDER = ["W", "U", "B", "R", "G", "C"] as const;

interface ManaPoolProps {
  pool: Record<string, number>;
  editable: boolean;
  onAdd: (color: string, amount: number) => void;
  onEmpty: () => void;
}

export function ManaPool({ pool, editable, onAdd, onEmpty }: ManaPoolProps): JSX.Element {
  const total = MANA_ORDER.reduce((sum, c) => sum + (pool[c] ?? 0), 0);
  return (
    <div className="panel-inset flex items-center gap-1 px-2 py-1.5">
      <div className="flex flex-1 items-center justify-between gap-0.5">
        {MANA_ORDER.map((color) => {
          const n = pool[color] ?? 0;
          return (
            <button
              key={color}
              type="button"
              disabled={!editable}
              onClick={() => onAdd(color, 1)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (editable && n > 0) onAdd(color, -1);
              }}
              title={editable ? `${color}: ${n} — click to add, right-click to remove` : `${color}: ${n}`}
              className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150 disabled:cursor-default ${n === 0 ? "opacity-35" : "shadow-card"} ${editable ? "hover:scale-110 active:scale-95" : ""}`}
            >
              <ManaSymbol symbol={color} className="pointer-events-none h-7 w-7" />
              {n > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-felt-950 px-0.5 text-[9px] font-bold text-brass-300 ring-1 ring-amber-200/30">
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {editable && (
        <button
          type="button"
          onClick={onEmpty}
          disabled={total === 0}
          title="Empty mana pool"
          className="ml-1 rounded-md border border-amber-100/15 p-1 text-zinc-400 transition-colors duration-150 hover:border-amber-200/30 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M6 7h12l-1 14H7L6 7Zm3-3h6l1 2h4v2H4V6h4l1-2Z" /></svg>
        </button>
      )}
    </div>
  );
}
