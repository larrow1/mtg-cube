/**
 * Modal dialog. Esc closes, Enter confirms (when onConfirm given), backdrop
 * click closes.
 */
import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  title?: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  danger?: boolean;
  width?: "sm" | "md" | "lg" | "xl";
  /** Hide the footer entirely (browse-style modals). */
  noFooter?: boolean;
}

const WIDTHS: Record<NonNullable<ModalProps["width"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export function Modal(props: ModalProps): JSX.Element {
  const {
    title,
    children,
    onClose,
    onConfirm,
    confirmLabel = "Confirm",
    confirmDisabled = false,
    cancelLabel = "Cancel",
    danger = false,
    width = "md",
    noFooter = false,
  } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter" && onConfirm && !confirmDisabled) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onConfirm, confirmDisabled]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={`panel w-full ${WIDTHS[width]} max-h-[88vh] overflow-hidden animate-pop-in flex flex-col`}>
        {title && (
          <div className="flex items-center justify-between border-b border-amber-100/[0.08] px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-200">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-zinc-500 transition-colors duration-150 hover:bg-white/10 hover:text-zinc-200"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3 1.4 1.4Z" /></svg>
            </button>
          </div>
        )}
        <div className="scrollbar-slim flex-1 overflow-y-auto p-4">{children}</div>
        {!noFooter && (
          <div className="flex justify-end gap-2 border-t border-amber-100/[0.08] px-4 py-3">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {cancelLabel}
            </button>
            {onConfirm && (
              <button
                type="button"
                className={danger ? "btn-danger" : "btn-primary"}
                onClick={onConfirm}
                disabled={confirmDisabled}
              >
                {confirmLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
