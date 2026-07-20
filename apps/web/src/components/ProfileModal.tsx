/**
 * Profile modal: rating + rank badge, W/L/D record, games played and the last
 * 20 ranked matches (opponent, result, rating delta, date). Fetched via
 * `getProfile` on open.
 */
import { useEffect, useState } from "react";
import type { Account, RankedMatchRecord, RatingInfo } from "@mtg-cube/shared";
import { call } from "../socket";
import { Modal } from "./Modal";
import { RankBadge } from "./RankBadge";

interface ProfileData {
  account: Account;
  rating: RatingInfo;
  history: RankedMatchRecord[];
}

const RESULT_CHIP: Record<RankedMatchRecord["result"], { label: string; classes: string }> = {
  win: { label: "Win", classes: "border-emerald-400/40 text-emerald-300" },
  loss: { label: "Loss", classes: "border-red-400/40 text-red-300" },
  draw: { label: "Draw", classes: "border-zinc-400/40 text-zinc-300" },
};

function deltaClasses(delta: number): string {
  if (delta > 0) return "text-emerald-300";
  if (delta < 0) return "text-red-300";
  return "text-zinc-300";
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ProfileModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void call("getProfile").then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setData(r.data);
      else setError(r.error ?? "Could not load your profile");
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Modal title="Profile" onClose={onClose} width="md" noFooter>
      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      ) : !data ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brass-400" />
          Consulting the ladder…
        </div>
      ) : (
        <>
          {/* Rating hero */}
          <div className="panel-inset mb-3 flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="truncate text-lg font-black text-zinc-50">{data.account.username}</div>
              <div className="mt-1"><RankBadge rank={data.rating.rank} size="md" /></div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Rating</div>
              <div className="text-3xl font-black tabular-nums text-brass-300">{data.rating.rating}</div>
            </div>
          </div>

          {/* Record */}
          <div className="mb-4 grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-emerald-500/10 px-2 py-2">
              <div className="text-lg font-black tabular-nums text-emerald-300">{data.rating.wins}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Wins</div>
            </div>
            <div className="rounded-lg bg-red-500/10 px-2 py-2">
              <div className="text-lg font-black tabular-nums text-red-300">{data.rating.losses}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Losses</div>
            </div>
            <div className="rounded-lg bg-white/[0.05] px-2 py-2">
              <div className="text-lg font-black tabular-nums text-zinc-300">{data.rating.draws}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Draws</div>
            </div>
            <div className="rounded-lg bg-white/[0.05] px-2 py-2">
              <div className="text-lg font-black tabular-nums text-zinc-100">{data.rating.gamesPlayed}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Games</div>
            </div>
          </div>

          {/* History */}
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Recent ranked matches</h3>
          {data.history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-amber-100/15 py-8 text-center text-xs text-zinc-400">
              No ranked matches yet — your legend is still unwritten.
              <div className="mt-1 text-[11px] text-zinc-500">Hit “Find opponent” on the home screen to start the climb.</div>
            </div>
          ) : (
            <ul className="space-y-1">
              {data.history.map((m) => {
                const chip = RESULT_CHIP[m.result];
                return (
                  <li key={m.id} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2">
                    <span className={`chip w-12 justify-center ${chip.classes}`}>{chip.label}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-200">
                      vs {m.opponentUsername}
                    </span>
                    <span className={`text-xs font-black tabular-nums ${deltaClasses(m.ratingDelta)}`}>
                      {formatDelta(m.ratingDelta)}
                    </span>
                    <span className="w-12 text-right text-[10px] tabular-nums text-zinc-500" title={`Rating after: ${m.ratingAfter}`}>
                      {m.ratingAfter}
                    </span>
                    <span className="w-14 text-right text-[10px] text-zinc-500">{formatDate(m.ts)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
