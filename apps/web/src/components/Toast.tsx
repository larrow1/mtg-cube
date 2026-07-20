/**
 * Toast stack rendered top-right; each toast auto-dismisses after 4.5s.
 */
import { useEffect } from "react";
import { useApp, type ToastItem } from "../store";

function ToastCard({ toast }: { toast: ToastItem }): JSX.Element {
  const { dispatch } = useApp();

  useEffect(() => {
    const id = window.setTimeout(() => dispatch({ type: "dismissToast", id: toast.id }), 4500);
    return () => window.clearTimeout(id);
  }, [toast.id, dispatch]);

  const accent =
    toast.kind === "error"
      ? "border-red-500/50 text-red-200"
      : toast.kind === "success"
        ? "border-emerald-500/50 text-emerald-200"
        : "border-sky-500/50 text-sky-200";

  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "dismissToast", id: toast.id })}
      className={`panel pointer-events-auto flex max-w-xs animate-slide-in items-start gap-2 border-l-2 px-3 py-2.5 text-left text-xs leading-snug shadow-card-lg ${accent}`}
    >
      {toast.kind === "error" ? (
        <svg viewBox="0 0 24 24" className="mt-px h-3.5 w-3.5 shrink-0 fill-red-400"><path d="M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V9h2v4Z" /></svg>
      ) : toast.kind === "success" ? (
        <svg viewBox="0 0 24 24" className="mt-px h-3.5 w-3.5 shrink-0 fill-emerald-400"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" className="mt-px h-3.5 w-3.5 shrink-0 fill-sky-400"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z" /></svg>
      )}
      <span className="text-zinc-200">{toast.message}</span>
    </button>
  );
}

export function ToastLayer(): JSX.Element {
  const { state } = useApp();
  return (
    <div className="pointer-events-none fixed right-3 top-14 z-[100] flex flex-col gap-2">
      {state.toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
