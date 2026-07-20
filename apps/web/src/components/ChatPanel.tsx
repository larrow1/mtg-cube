/**
 * Room chat: message list + input. Enter sends.
 */
import { useEffect, useRef, useState } from "react";
import { sendChat } from "../socket";
import { useApp } from "../store";

export function ChatPanel({ className = "" }: { className?: string }): JSX.Element {
  const { state } = useApp();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const myId = state.session?.playerId;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat.length]);

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    sendChat(text);
    setDraft("");
  };

  return (
    <div className={`panel flex flex-col ${className}`}>
      <div className="border-b border-amber-100/[0.08] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
        Table talk
      </div>
      <div ref={listRef} className="scrollbar-slim flex-1 space-y-1.5 overflow-y-auto p-3">
        {state.chat.length === 0 ? (
          <div className="flex h-full min-h-[4rem] flex-col items-center justify-center gap-1 text-center">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-indigo-400/50"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-6 4V6a2 2 0 0 1 2-2Z" /></svg>
            <span className="text-[10px] text-zinc-500">No messages yet — go on, break the ice</span>
          </div>
        ) : (
          state.chat.map((m, i) => (
            <div key={`${m.ts}-${i}`} className="text-xs leading-snug">
              <span className={`font-bold ${m.playerId === myId ? "text-brass-300" : "text-sky-300"}`}>
                {m.playerName}
              </span>
              <span className="text-zinc-600"> · {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <div className="text-zinc-300">{m.message}</div>
            </div>
          ))
        )}
      </div>
      <div className="flex gap-1.5 border-t border-amber-100/[0.08] p-2">
        <input
          className="input !py-1.5 text-xs"
          placeholder="Message…"
          value={draft}
          maxLength={400}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="btn-primary !px-3 !py-1.5" onClick={send} disabled={draft.trim().length === 0} aria-label="Send">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="m2 21 21-9L2 3v7l15 2-15 2v7Z" /></svg>
        </button>
      </div>
    </div>
  );
}
