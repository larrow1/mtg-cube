/**
 * A stacked zone pile (library / graveyard / exile) with count badge,
 * optional top-card face, and click / context handlers.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import type { CardData, GameCard } from "@mtg-cube/shared";
import { Card, CardBack } from "./Card";

interface ZonePileProps {
  label: string;
  count: number;
  /** Show this card's face on top of the pile (graveyard / exile). */
  topCard?: GameCard;
  topCardData?: CardData;
  /** Render the pile as face-down backs (library). */
  faceDown?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  accent?: "emerald" | "zinc" | "purple";
  className?: string;
}

export function ZonePile(props: ZonePileProps): JSX.Element {
  const { label, count, topCard, topCardData, faceDown = false, onClick, onContextMenu, accent = "zinc", className = "" } = props;

  const accentText =
    accent === "emerald" ? "text-emerald-300" : accent === "purple" ? "text-purple-300" : "text-zinc-300";

  return (
    <div
      className={`group flex w-[64px] shrink-0 flex-col items-center gap-1 ${onClick || onContextMenu ? "cursor-pointer" : ""} ${className}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${label}: ${count}`}
    >
      <div className="relative aspect-[5/7] w-full">
        {count === 0 ? (
          <div className="flex h-full w-full items-center justify-center rounded-[6%] border border-dashed border-white/15 bg-black/20 text-[9px] uppercase tracking-wide text-zinc-600 transition-colors duration-150 group-hover:border-white/30">
            Empty
          </div>
        ) : (
          <>
            {count > 2 && <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-[6%] bg-black/60" />}
            {count > 1 && <div className="absolute inset-0 translate-x-[1.5px] translate-y-[1.5px] rounded-[6%] bg-black/80 ring-1 ring-white/5" />}
            <div className="absolute inset-0 transition-transform duration-150 group-hover:-translate-y-0.5">
              {faceDown || !topCard ? (
                <CardBack />
              ) : (
                <Card gameCard={topCard} data={topCardData} size="xs" disablePreview={false} className="!w-full" />
              )}
            </div>
            <span className={`absolute -right-1.5 -top-1.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full border border-white/15 bg-felt-950 px-1 text-[10px] font-bold shadow-card ${accentText}`}>
              {count}
            </span>
          </>
        )}
      </div>
      <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
    </div>
  );
}
