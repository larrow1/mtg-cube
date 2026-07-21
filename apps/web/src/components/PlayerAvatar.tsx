/**
 * v8.1 player avatar — a placeholder portrait (hue derived from the player
 * name, planeswalker silhouette + initial) that doubles as the face-damage
 * TARGET: it carries `data-player-avatar` for the arrow overlay, accepts
 * clicks while a player-legal target is being chosen, and accepts a dragged
 * hand card as a drop target. Swap the inner art for a real picture later.
 */
import type { DragEvent } from "react";

interface PlayerAvatarProps {
  playerId: string;
  name: string;
  /** Highlighted + clickable while a player target is being chosen. */
  targetable?: boolean;
  onPick?: () => void;
  onDropCard?: (e: DragEvent<HTMLButtonElement>) => void;
}

/** Stable placeholder hue per name so each player looks distinct. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function PlayerAvatar({ playerId, name, targetable, onPick, onDropCard }: PlayerAvatarProps): JSX.Element {
  const hue = hueOf(name);
  return (
    <button
      type="button"
      data-player-avatar={playerId}
      className={`relative h-11 w-11 shrink-0 overflow-hidden rounded-full border-2 transition-all duration-150 ${
        targetable
          ? "cursor-crosshair border-red-400/90 shadow-[0_0_14px_rgba(248,113,113,0.6)] hover:scale-110"
          : "cursor-default border-amber-100/20"
      }`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 55% 18%))` }}
      onClick={targetable && onPick ? onPick : undefined}
      onDragOver={onDropCard ? (e) => e.preventDefault() : undefined}
      onDrop={onDropCard}
      title={targetable ? `Target ${name}` : name}
      aria-label={targetable ? `Target ${name}` : `${name}'s avatar`}
    >
      {/* Placeholder portrait: planeswalker silhouette + initial */}
      <svg viewBox="0 0 44 44" className="absolute inset-0 h-full w-full">
        <circle cx="22" cy="16" r="8" fill="rgba(255,255,255,0.28)" />
        <path d="M6 44c1.5-11 8-16 16-16s14.5 5 16 16Z" fill="rgba(255,255,255,0.22)" />
      </svg>
      <span className="absolute inset-x-0 bottom-0.5 text-center text-[10px] font-black text-white/90 drop-shadow">
        {name.slice(0, 1).toUpperCase()}
      </span>
    </button>
  );
}
