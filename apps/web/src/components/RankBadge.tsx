/**
 * Rank tier badge (Bronze → Mythic) used everywhere a rank shows: account
 * chip, profile, ranked panel, winner banner. Accepts any string (the contract
 * sends opponent ranks as plain strings) and falls back to a neutral look.
 */
import { RANK_TIERS, type RankTier } from "@mtg-cube/shared";

const TIER_CLASSES: Record<RankTier, string> = {
  Bronze: "border-amber-700/60 text-amber-700",
  Silver: "border-zinc-300/50 text-zinc-300",
  Gold: "border-brass-400/60 text-brass-400",
  Platinum: "border-cyan-200/50 text-cyan-200",
  Diamond: "border-sky-300/50 text-sky-300",
  Mythic: "border-fuchsia-400/60 text-fuchsia-400",
};

function isTier(rank: string): rank is RankTier {
  return (RANK_TIERS as readonly string[]).includes(rank);
}

export interface RankBadgeProps {
  rank: string;
  size?: "sm" | "md";
  className?: string;
}

export function RankBadge({ rank, size = "sm", className = "" }: RankBadgeProps): JSX.Element {
  const tint = isTier(rank) ? TIER_CLASSES[rank] : "border-zinc-500/40 text-zinc-400";
  const sizing = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[10px]";
  const icon = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border bg-felt-950/80 font-bold uppercase leading-none tracking-wide ${tint} ${sizing} ${className}`}
      title={`${rank} tier`}
    >
      <svg viewBox="0 0 24 24" className={`${icon} shrink-0 fill-current`} aria-hidden="true">
        <path d="M7 3h10l4 6-9 12L3 9l4-6Zm1.1 2L5.7 8.5h12.6L15.9 5H8.1ZM12 18.2 17.6 10.5H6.4L12 18.2Z" />
      </svg>
      {rank}
    </span>
  );
}
