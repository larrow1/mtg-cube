/**
 * The shared stack: cards top-last in state, rendered top-first, with
 * resolve / counter controls (either player may use them).
 */
import type { CardData, GameCard } from "@mtg-cube/shared";
import { Card } from "./Card";
import { nameOf } from "../lib/cards";

interface StackPanelProps {
  stack: GameCard[];
  cards: Record<string, CardData>;
  nameFor: (playerId: string) => string;
  onResolve: () => void;
  onCounter: () => void;
  disabled: boolean;
}

export function StackPanel({ stack, cards, nameFor, onResolve, onCounter, disabled }: StackPanelProps): JSX.Element {
  const topLast = stack;
  const reversed = [...topLast].reverse(); // render top of stack first

  return (
    <div className="panel flex min-h-[9rem] w-56 shrink-0 flex-col p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">The Stack</span>
        {stack.length > 0 && <span className="chip">{stack.length}</span>}
      </div>
      {stack.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-amber-100/15 py-3 text-center">
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-indigo-400/50"><path d="M12 3 2 8l10 5 10-5-10-5Zm-10 9 10 5 10-5v3l-10 5-10-5v-3Z" /></svg>
          <span className="text-[10px] text-zinc-500">Stack is empty — cast something spicy</span>
        </div>
      ) : (
        <>
          <div className="scrollbar-slim flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
            {reversed.map((gc, i) => (
              <div key={gc.instanceId} className={`flex items-center gap-2 rounded-lg p-1 ${i === 0 ? "bg-amber-400/10 ring-1 ring-brass-400/40" : "bg-white/[0.04]"}`}>
                <Card gameCard={gc} data={cards[gc.cardId]} size="xs" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-zinc-100">{nameOf(gc, cards[gc.cardId])}</div>
                  <div className="truncate text-[9px] text-zinc-500">{nameFor(gc.controllerId)}</div>
                  {i === 0 && <div className="text-[9px] font-bold uppercase tracking-wide text-brass-300">top</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="btn-primary flex-1 !px-2 !py-1.5 !text-[11px]" onClick={onResolve} disabled={disabled} title="Resolve the top of the stack">
              Resolve
            </button>
            <button type="button" className="btn-ghost flex-1 !px-2 !py-1.5 !text-[11px]" onClick={onCounter} disabled={disabled} title="Counter the top of the stack (to graveyard)">
              Counter
            </button>
          </div>
        </>
      )}
    </div>
  );
}
