/**
 * Responsive grid of cards (draft pack, browse modals).
 */
import type { ReactNode } from "react";

interface CardGridProps {
  children: ReactNode;
  /** Minimum column width in px (defaults to draft-pack size). */
  min?: number;
  className?: string;
}

export function CardGrid({ children, min = 150, className = "" }: CardGridProps): JSX.Element {
  return (
    <div
      className={`grid justify-items-center gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {children}
    </div>
  );
}
