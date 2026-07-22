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
  /** Keep auto-filled columns at exactly `min` pixels instead of stretching. */
  fixedWidth?: boolean;
  className?: string;
}

export function CardGrid({ children, min = 150, columns, fixedWidth = false, className = "" }: CardGridProps): JSX.Element {
  return (
    <div
      className={`grid justify-center justify-items-center gap-3 ${className}`}
      style={{
        gridTemplateColumns: columns
          ? `repeat(${columns}, minmax(0, ${min}px))`
          : fixedWidth
            ? `repeat(auto-fill, ${min}px)`
            : `repeat(auto-fill, minmax(${min}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
