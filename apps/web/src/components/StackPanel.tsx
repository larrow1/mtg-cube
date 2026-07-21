/**
 * The shared stack: cards top-last in state, rendered top-first, with
 * resolve / counter controls (either player may use them). Triggered abilities
 * (`isTrigger` pseudo-cards) render distinctly: source-card thumbnail, the
 * ability text and an "Ability" chip, with a gold Resolve for the top entry
 * and a ghost Decline on your own optional triggers (any stack position).
 * Newly-appeared triggers pop in with an amber glow so a waiting confirmation
 * is unmissable.
 */
import { useEffect, useMemo, useRef } from "react";
import type { CardData, GameCard } from "@mtg-cube/shared";
import { Card } from "./Card";
import { nameOf } from "../lib/cards";

interface StackPanelProps {
  stack: GameCard[];
  cards: Record<string, CardData>;
  nameFor: (playerId: string) => string;
  /** The viewing player's id (undefined for spectators) — gates Decline. */
  viewerId?: string;
  onResolve: () => void;
  onCounter: () => void;
  onDecline: (instanceId: string) => void;
  disabled: boolean;
}

export function StackPanel({ stack, cards, nameFor, viewerId, onResolve, onCounter, onDecline, disabled }: StackPanelProps): JSX.Element {
  const reversed = [...stack].reverse(); // render top of stack first

  // Trigger entries not present in the previous view pop in with an amber
  // glow — "a trigger is waiting for confirmation". Pure render-side memory;
  // never mutates game state.
  const prevIds = useRef<ReadonlySet<string>>(new Set());
  const newTriggerIds = useMemo(() => {
    const fresh = new Set<string>();
    for (const gc of stack) {
      if (gc.isTrigger && !prevIds.current.has(gc.instanceId)) fresh.add(gc.instanceId);
    }
    return fresh;
  }, [stack]);
  useEffect(() => {
    prevIds.current = new Set(stack.map((gc) => gc.instanceId));
  }, [stack]);

  const top = stack[stack.length - 1];
  const topIsTrigger = top?.isTrigger === true;

  // Declining is legal at ANY position for your own optional triggers.
  const canDecline = (gc: GameCard): boolean =>
    gc.isTrigger === true &&
    gc.triggerOptional === true &&
    viewerId !== undefined &&
    gc.controllerId === viewerId &&
    !disabled;

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
            {reversed.map((gc, i) => {
              const isTop = i === 0;
              if (gc.isTrigger) {
                const data = cards[gc.cardId];
                const fresh = newTriggerIds.has(gc.instanceId);
                return (
                  <div
                    key={gc.instanceId}
                    className={`rounded-lg border border-amber-400/40 bg-amber-400/10 p-1.5 shadow-[0_0_14px_rgba(251,191,36,0.18)] ${
                      fresh ? "animate-trigger-pop" : ""
                    } ${isTop ? "ring-1 ring-brass-400/60" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="w-[44px] shrink-0">
                        {data ? (
                          <Card data={data} size="xs" className="!w-full" />
                        ) : (
                          <div className="flex aspect-[5/7] items-center justify-center rounded-md border border-amber-300/30 bg-felt-950/70" title="Triggered ability">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-brass-300"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2Z" /></svg>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="chip !border-amber-300/40 !bg-amber-400/15 !text-brass-300">Ability</span>
                          {isTop && <span className="text-[9px] font-bold uppercase tracking-wide text-brass-300">top</span>}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] font-semibold text-zinc-100">
                          {data?.name ?? "Triggered ability"}
                        </div>
                        {gc.triggerText && (
                          <div className="line-clamp-3 text-[9px] leading-snug text-zinc-300" title={gc.triggerText}>
                            {gc.triggerText}
                          </div>
                        )}
                        <div className="mt-0.5 flex items-center justify-between gap-1">
                          <span className="truncate text-[9px] text-zinc-500">{nameFor(gc.controllerId)}</span>
                          {!isTop && canDecline(gc) && (
                            <button
                              type="button"
                              className="btn-ghost !px-1.5 !py-0.5 !text-[9px]"
                              onClick={() => onDecline(gc.instanceId)}
                              title="Decline this optional trigger"
                            >
                              Decline
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div key={gc.instanceId} className={`flex items-center gap-2 rounded-lg p-1 ${isTop ? "bg-amber-400/10 ring-1 ring-brass-400/40" : "bg-white/[0.04]"}`}>
                  <Card gameCard={gc} data={cards[gc.cardId]} size="xs" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold text-zinc-100">{nameOf(gc, cards[gc.cardId])}</div>
                    <div className="truncate text-[9px] text-zinc-500">{nameFor(gc.controllerId)}</div>
                    {isTop && <div className="text-[9px] font-bold uppercase tracking-wide text-brass-300">top</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-1.5">
            {topIsTrigger && top ? (
              <>
                <button
                  type="button"
                  className="btn-gold flex-1 !px-2 !py-1.5 !text-[11px]"
                  onClick={onResolve}
                  disabled={disabled}
                  title="Resolve this triggered ability"
                >
                  Resolve
                </button>
                {canDecline(top) && (
                  <button
                    type="button"
                    className="btn-ghost flex-1 !px-2 !py-1.5 !text-[11px]"
                    onClick={() => onDecline(top.instanceId)}
                    title="Decline this optional trigger"
                  >
                    Decline
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" className="btn-primary flex-1 !px-2 !py-1.5 !text-[11px]" onClick={onResolve} disabled={disabled} title="Resolve the top of the stack">
                  Resolve
                </button>
                <button type="button" className="btn-ghost flex-1 !px-2 !py-1.5 !text-[11px]" onClick={onCounter} disabled={disabled} title="Counter the top of the stack (to graveyard)">
                  Counter
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
