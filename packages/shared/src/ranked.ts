/**
 * Ranked play math: Elo rating deltas and rank tiers. Pure, no deps.
 */
import type { RankTier } from "./types.js";

/** Every account starts here. */
export const STARTING_RATING = 1200;

/**
 * Rank bands in ascending order. A rating belongs to the highest band whose
 * `min` it meets; ratings below Silver's min are Bronze. Exported for UI use
 * (badges, progress bars).
 */
export const RANK_BANDS: readonly { tier: RankTier; min: number }[] = [
  { tier: "Bronze", min: 0 },
  { tier: "Silver", min: 1100 },
  { tier: "Gold", min: 1250 },
  { tier: "Platinum", min: 1400 },
  { tier: "Diamond", min: 1550 },
  { tier: "Mythic", min: 1700 },
];

/** Rank tier for a rating: Bronze <1100, Silver <1250, Gold <1400, Platinum <1550, Diamond <1700, Mythic >= 1700. */
export function rankFor(rating: number): RankTier {
  let tier: RankTier = "Bronze";
  for (const band of RANK_BANDS) {
    if (rating >= band.min) tier = band.tier;
  }
  return tier;
}

/**
 * Standard Elo: rating change for player A after a game against B.
 * scoreA is 1 for an A win, 0.5 for a draw, 0 for an A loss.
 * Returns the rounded integer delta for A; B's delta is the negative.
 */
export function eloDelta(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1, k = 32): number {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(k * (scoreA - expectedA));
}
