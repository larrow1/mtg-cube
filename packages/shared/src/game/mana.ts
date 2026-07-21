/**
 * Mana costs & payment planning (v5).
 *
 * Grounding (docs/rules): a spell's total cost is paid with mana from the pool
 * (CR 106.4 — pool mana "can be used to pay costs immediately") plus mana
 * abilities activated during casting (CR 601.2g) before payment (CR 601.2h).
 * {0} costs need no resources (CR 118.5). Anything we cannot faithfully parse
 * (phyrexian, snow, ...) is treated as UNENFORCEABLE — the engine allows the
 * cast and logs that the cost was not checked, because wrong automation is
 * worse than none.
 *
 * Known limitation: every source produces exactly ONE mana per tap (mirrors
 * tapForMana) — Sol Ring pays 1 toward a plan, not 2.
 */
import type { CardData, PlayerGameState } from "../types.js";

export const PAYMENT_COLORS = ["W", "U", "B", "R", "G", "C"] as const;
export type PaymentColor = (typeof PAYMENT_COLORS)[number];

export interface ParsedManaCost {
  /** Generic component ({2}, {1}, ... summed). */
  generic: number;
  /** Fixed colored/colorless pips: color -> count. */
  pips: Partial<Record<PaymentColor, number>>;
  /** Two-option pips, e.g. {W/U} -> ["W","U"]; {2/W} -> ["2","W"] (2 = generic 2). */
  hybrids: string[][];
  /** Number of {X} symbols (X itself is chosen manually and counts as 0 here). */
  x: number;
}

/** Total converted size of the FIXED part (generic + pips + min hybrid cost). */
export function parsedCostSize(cost: ParsedManaCost): number {
  const pipCount = Object.values(cost.pips).reduce((a, b) => a + (b ?? 0), 0);
  return cost.generic + pipCount + cost.hybrids.length;
}

/**
 * Parse a Scryfall-style mana cost ("{2}{U}{U}") into its components.
 * Returns null when the cost is absent, empty, or contains any symbol we
 * cannot faithfully enforce (phyrexian {W/P}, snow {S}, unknown letters...).
 */
export function parseManaCost(raw: string | undefined): ParsedManaCost | null {
  if (!raw) return null;
  const symbols = raw.match(/\{[^{}]+\}/g);
  if (!symbols || symbols.join("") !== raw.replace(/\s+/g, "")) return null;
  const out: ParsedManaCost = { generic: 0, pips: {}, hybrids: [], x: 0 };
  for (const sym of symbols) {
    const body = sym.slice(1, -1).toUpperCase();
    if (/^\d+$/.test(body)) {
      out.generic += Number(body);
    } else if (body === "X") {
      out.x += 1;
    } else if ((PAYMENT_COLORS as readonly string[]).includes(body)) {
      const c = body as PaymentColor;
      out.pips[c] = (out.pips[c] ?? 0) + 1;
    } else if (/^(\d+|[WUBRGC])\/([WUBRGC])$/.test(body)) {
      // Two-option hybrid: {W/U} or monocolor hybrid {2/W}.
      out.hybrids.push(body.split("/"));
    } else {
      return null; // phyrexian, snow, half mana, anything else — unenforceable
    }
  }
  return out;
}

/** One untapped battlefield mana source available for auto-tapping. */
export interface ManaSource {
  instanceId: string;
  /** Colors (WUBRGC) this source can produce, per its CardData producedMana. */
  colors: PaymentColor[];
  /** Lands tap for mana more cheaply (in spirit) than dorks/rocks — sort key. */
  isLand: boolean;
}

/** Untapped, face-up battlefield cards of `player` that can produce mana. */
export function manaSourcesOf(
  player: PlayerGameState,
  cards: Record<string, CardData>
): ManaSource[] {
  const sources: ManaSource[] = [];
  for (const gc of player.zones.battlefield) {
    if (gc.tapped || gc.faceDown || gc.isToken) continue;
    const data = cards[gc.cardId];
    const produced = data?.producedMana ?? [];
    const colors = PAYMENT_COLORS.filter((c) => produced.includes(c));
    if (colors.length === 0) continue;
    sources.push({
      instanceId: gc.instanceId,
      colors,
      isLand: /\bLand\b/i.test(data?.faces?.[0]?.typeLine ?? data?.typeLine ?? ""),
    });
  }
  return sources;
}

export interface PaymentPlan {
  /** Mana to deduct from the pool: color -> count. */
  fromPool: Partial<Record<PaymentColor, number>>;
  /** Sources to tap, with the color each produces toward the cost. */
  taps: { instanceId: string; color: PaymentColor }[];
}

interface Wallet {
  pool: Partial<Record<PaymentColor, number>>;
  sources: ManaSource[];
}

/** Pay one pip of `color`: pool first (CR 106.4), then the tightest source. */
function payPip(color: PaymentColor, wallet: Wallet, plan: PaymentPlan): boolean {
  if ((wallet.pool[color] ?? 0) > 0) {
    wallet.pool[color]! -= 1;
    plan.fromPool[color] = (plan.fromPool[color] ?? 0) + 1;
    return true;
  }
  // Least-flexible matching source first; lands before dorks/rocks.
  const candidates = wallet.sources
    .filter((s) => s.colors.includes(color))
    .sort((a, b) => a.colors.length - b.colors.length || Number(b.isLand) - Number(a.isLand));
  const source = candidates[0];
  if (!source) return false;
  wallet.sources = wallet.sources.filter((s) => s !== source);
  plan.taps.push({ instanceId: source.instanceId, color });
  return true;
}

function clonePlan(plan: PaymentPlan): PaymentPlan {
  return { fromPool: { ...plan.fromPool }, taps: [...plan.taps] };
}

function cloneWallet(wallet: Wallet): Wallet {
  return { pool: { ...wallet.pool }, sources: [...wallet.sources] };
}

/**
 * Plan how to pay `cost` from floating mana + auto-taps. Colored pips are
 * matched most-constrained-first with backtracking over hybrid choices (small
 * search space: hybrid options are 2-way and real costs are short). Generic is
 * paid last from whatever remains, preferring colorless then least-flexible
 * sources. Returns null when the cost cannot be paid.
 */
export function planManaPayment(
  cost: ParsedManaCost,
  pool: Record<string, number>,
  sources: ManaSource[]
): PaymentPlan | null {
  const wallet: Wallet = {
    pool: {},
    sources: [...sources],
  };
  for (const c of PAYMENT_COLORS) {
    const n = pool[c] ?? 0;
    if (n > 0) wallet.pool[c] = n;
  }
  const plan: PaymentPlan = { fromPool: {}, taps: [] };

  // Fixed colored pips first — scarcest color first so duals stay flexible.
  const pipList: PaymentColor[] = [];
  for (const c of PAYMENT_COLORS) {
    for (let i = 0; i < (cost.pips[c] ?? 0); i++) pipList.push(c);
  }
  pipList.sort((a, b) => {
    const avail = (c: PaymentColor) =>
      (wallet.pool[c] ?? 0) + wallet.sources.filter((s) => s.colors.includes(c)).length;
    return avail(a) - avail(b);
  });
  for (const c of pipList) {
    if (!payPip(c, wallet, plan)) return null;
  }

  // Hybrids: try each option with backtracking (choices are 2-way).
  const finishHybrids = (idx: number, w: Wallet, p: PaymentPlan): { w: Wallet; p: PaymentPlan } | null => {
    if (idx >= cost.hybrids.length) return { w, p };
    for (const opt of cost.hybrids[idx]!) {
      const w2 = cloneWallet(w);
      const p2 = clonePlan(p);
      let ok: boolean;
      if (/^\d+$/.test(opt)) {
        ok = payGeneric(Number(opt), w2, p2);
      } else {
        ok = payPip(opt as PaymentColor, w2, p2);
      }
      if (!ok) continue;
      const done = finishHybrids(idx + 1, w2, p2);
      if (done) return done;
    }
    return null;
  };

  /** Pay N generic from anything: pool first (any color), then sources. */
  function payGeneric(n: number, w: Wallet, p: PaymentPlan): boolean {
    for (let i = 0; i < n; i++) {
      // Pool: colorless first, then whichever color is most plentiful.
      const poolColor = (["C", ...PAYMENT_COLORS.filter((c) => c !== "C")] as PaymentColor[])
        .filter((c) => (w.pool[c] ?? 0) > 0)
        .sort((a, b) => (a === "C" ? -1 : b === "C" ? 1 : (w.pool[b] ?? 0) - (w.pool[a] ?? 0)))[0];
      if (poolColor) {
        w.pool[poolColor]! -= 1;
        p.fromPool[poolColor] = (p.fromPool[poolColor] ?? 0) + 1;
        continue;
      }
      // Sources: colorless-capable and least-flexible first, lands first.
      const source = [...w.sources].sort(
        (a, b) =>
          Number(b.colors.includes("C")) - Number(a.colors.includes("C")) ||
          a.colors.length - b.colors.length ||
          Number(b.isLand) - Number(a.isLand)
      )[0];
      if (!source) return false;
      w.sources = w.sources.filter((s) => s !== source);
      p.taps.push({ instanceId: source.instanceId, color: source.colors[0]! });
      continue;
    }
    return true;
  }

  const afterHybrids = finishHybrids(0, wallet, plan);
  if (!afterHybrids) return null;
  if (!payGeneric(cost.generic, afterHybrids.w, afterHybrids.p)) return null;
  return afterHybrids.p;
}

/** Render a plan's pool component like "{U}{C}" for logs. */
export function describePoolSpend(fromPool: PaymentPlan["fromPool"]): string {
  let out = "";
  for (const c of PAYMENT_COLORS) {
    out += `{${c}}`.repeat(fromPool[c] ?? 0);
  }
  return out;
}

/**
 * Instant-speed check for auto-pass (CR 117.1a instants; CR 702.8a flash):
 * front-face type line contains Instant, or the oracle text grants Flash.
 */
export function hasInstantSpeed(data: CardData | undefined): boolean {
  if (!data) return false;
  const typeLine = data.faces?.[0]?.typeLine ?? data.typeLine;
  if (/\bInstant\b/i.test(typeLine)) return true;
  const oracle = data.faces?.[0]?.oracleText ?? data.oracleText ?? "";
  return /(^|\n)Flash\b/i.test(oracle) || /^Flash\b/i.test(oracle);
}

/**
 * Can `player` cast `data` right now given floating mana + untapped sources?
 * Unparseable costs count as castable — never auto-skip what we can't judge.
 */
export function canPayFor(
  data: CardData,
  player: PlayerGameState,
  cards: Record<string, CardData>
): boolean {
  const cost = parseManaCost(data.faces?.[0]?.manaCost ?? data.manaCost);
  if (!cost) return true;
  if (parsedCostSize(cost) === 0) return true;
  return planManaPayment(cost, player.manaPool, manaSourcesOf(player, cards)) !== null;
}
