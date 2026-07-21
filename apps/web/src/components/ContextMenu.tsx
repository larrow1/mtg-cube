/**
 * Right-click context menu, clamped to the viewport. Closes on click-away,
 * Esc, scroll, or another context-menu open.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a divider above this item. */
  separator?: boolean;
  /** Non-interactive heading row. */
  heading?: boolean;
  /** Optional leading icon node (e.g. a mana symbol). */
  icon?: ReactNode;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface ContextMenuProps extends ContextMenuState {
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(4, left), top: Math.max(4, top) });
  }, [x, y]);

  useLayoutEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening right-click doesn't instantly close it.
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[90] min-w-[176px] animate-pop-in rounded-xl border border-amber-200/15 bg-felt-850 py-1 shadow-card-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separator && <div className="mx-2 my-1 border-t border-white/10" />}
          {item.heading ? (
            <div className="px-3 pb-0.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              {item.label}
            </div>
          ) : (
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick?.();
                  onClose();
                }
              }}
              className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "text-red-400 hover:bg-red-500/15"
                  : "text-zinc-200 hover:bg-amber-400/15"
              }`}
            >
              {item.icon}
              <span className="min-w-0 flex-1">{item.label}</span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
