/**
 * Responsive grid of cards (draft pack, browse modals).
 */
import type { ReactNode } from "react";

interface CardGridProps {
  children: ReactNode;
  /** Minimum column width in px (defaults to draft-pack size). */
  min?: number;
  /** Fixed column count when a screen needs a stable grid shape. */
  columns?: number;
  className?: string;
}

export function CardGrid({ children, min = 150, columns, className = "" }: CardGridProps): JSX.Element {
  return (
    <div
      className={`grid justify-center justify-items-center gap-3 ${className}`}
      style={{ gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, ${min}px))` : `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {children}
    </div>
  );
}
