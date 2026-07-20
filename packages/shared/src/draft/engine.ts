/**
 * Draft engine — pure functions over DraftState.
 *
 * All functions return NEW state (structuredClone) and never mutate inputs.
 * All randomness flows through the seeded Rng so drafts are reproducible.
 *
 * Seat assignment note: createDraft initializes every seat with
 * `playerId: null, isBot: true`. The server flips `isBot`/`playerId` for the
 * seats humans claim before the draft loop starts.
 */
import type { CardData, Cube, DraftCard, DraftConfig, DraftSeat, DraftState, DraftView, Pack } from "../types.js";
import { createRng, shuffle, type Rng } from "../rng.js";

/**
 * Shuffle the cube and deal seatCount * packsPerPlayer packs of cardsPerPack.
 * Round 1 packs go straight into each seat's packQueue; later rounds wait in
 * state.unopened (indexed by seat). Throws if the cube is too small.
 */
export function createDraft(cube: Cube, config: DraftConfig): DraftState {
  const { seatCount, packsPerPlayer, cardsPerPack } = config;
  if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > 8) {
    throw new Error(`seatCount must be an integer between 2 and 8 (got ${seatCount})`);
  }
  if (!Number.isInteger(packsPerPlayer) || packsPerPlayer < 1) {
    throw new Error(`packsPerPlayer must be a positive integer (got ${packsPerPlayer})`);
  }
  if (!Number.isInteger(cardsPerPack) || cardsPerPack < 1) {
    throw new Error(`cardsPerPack must be a positive integer (got ${cardsPerPack})`);
  }
  const needed = seatCount * packsPerPlayer * cardsPerPack;
  if (cube.cardIds.length < needed) {
    throw new Error(
      `Cube "${cube.name}" has ${cube.cardIds.length} cards but ${needed} are needed ` +
        `(${seatCount} seats x ${packsPerPlayer} packs x ${cardsPerPack} cards).`
    );
  }

  const rng = createRng(config.seed);
  const shuffled = shuffle(cube.cardIds, rng);

  let dealt = 0;
  const nextCard = (): DraftCard => {
    const cardId = shuffled[dealt];
    if (cardId === undefined) throw new Error("Internal error: ran out of cards while dealing");
    dealt += 1;
    return { instanceId: `d${dealt}`, cardId };
  };

  const seats: DraftSeat[] = [];
  const unopened: Pack[][] = [];
  for (let s = 0; s < seatCount; s++) {
    const packs: Pack[] = [];
    for (let r = 1; r <= packsPerPlayer; r++) {
      const cards: DraftCard[] = [];
      for (let c = 0; c < cardsPerPack; c++) cards.push(nextCard());
      packs.push({ id: `p${s}r${r}`, cards });
    }
    const first = packs.shift();
    seats.push({
      seatIndex: s,
      playerId: null,
      isBot: true,
      picks: [],
      packQueue: first ? [first] : [],
    });
    unopened.push(packs);
  }

  return {
    id: `draft-${config.seed}`,
    config: { ...config },
    seats,
    packNumber: 1,
    complete: false,
    unopened,
  };
}

/**
 * Open the next round of packs: gives every seat its next unopened pack and
 * bumps packNumber. If no unopened packs remain, marks the draft complete
 * instead. (createDraft already opens round 1; applyPick calls this
 * automatically when a round is exhausted.)
 */
export function openNextPacks(state: DraftState): DraftState {
  const s = structuredClone(state);
  openNextPacksInPlace(s);
  return s;
}

function openNextPacksInPlace(s: DraftState): void {
  const anyLeft = s.unopened.some((packs) => packs.length > 0);
  if (!anyLeft) {
    s.complete = true;
    return;
  }
  s.packNumber += 1;
  for (const seat of s.seats) {
    const packs = s.unopened[seat.seatIndex];
    const next = packs?.shift();
    if (next) seat.packQueue.push(next);
  }
}

/**
 * Seat picks `instanceId` out of its head pack. The rest of the pack passes
 * to the left neighbor (seatIndex+1) on odd pack rounds, right on even.
 * Empty packs are discarded. When every pack of the round is exhausted the
 * next round is opened (or the draft is marked complete).
 */
export function applyPick(state: DraftState, seatIndex: number, instanceId: string): DraftState {
  const s = structuredClone(state);
  applyPickInPlace(s, seatIndex, instanceId);
  return s;
}

function applyPickInPlace(s: DraftState, seatIndex: number, instanceId: string): void {
  if (s.complete) throw new Error("Draft is already complete");
  const seat = s.seats[seatIndex];
  if (!seat) throw new Error(`No seat at index ${seatIndex}`);
  const pack = seat.packQueue[0];
  if (!pack) throw new Error(`Seat ${seatIndex} has no pack waiting`);
  const cardIdx = pack.cards.findIndex((c) => c.instanceId === instanceId);
  if (cardIdx === -1) {
    throw new Error(`Card ${instanceId} is not in seat ${seatIndex}'s current pack`);
  }

  const [card] = pack.cards.splice(cardIdx, 1);
  if (card) seat.picks.push(card);
  seat.packQueue.shift();

  if (pack.cards.length > 0) {
    const n = s.seats.length;
    const passLeft = s.packNumber % 2 === 1;
    const neighborIdx = passLeft ? (seatIndex + 1) % n : (seatIndex - 1 + n) % n;
    const neighbor = s.seats[neighborIdx];
    if (!neighbor) throw new Error(`Internal error: no neighbor seat ${neighborIdx}`);
    neighbor.packQueue.push(pack);
  }
  // else: empty pack is discarded.

  const roundExhausted = s.seats.every((st) => st.packQueue.length === 0);
  if (roundExhausted) openNextPacksInPlace(s);
}

/**
 * Loop: every bot seat with a pack in front of it makes a pick, until no bot
 * has a waiting pack (i.e. everyone waiting is human, or the draft is done).
 *
 * Heuristic: count colors among the bot's existing picks; each pack card
 * scores the sum of those counts over its own colors (colorless cards get a
 * small constant so they are never dead last), plus a small rng jitter for
 * deterministic tiebreaks. Highest score wins.
 *
 * `cards` (optional) supplies CardData for color lookups; without it the bot
 * falls back to pure rng picks. Determinism: only the passed Rng is used.
 */
export function runBotPicks(state: DraftState, rng: Rng, cards?: Record<string, CardData>): DraftState {
  let s = structuredClone(state);
  for (;;) {
    if (s.complete) break;
    const seat = s.seats.find((st) => st.isBot && st.packQueue.length > 0);
    if (!seat) break;
    const pack = seat.packQueue[0];
    if (!pack || pack.cards.length === 0) break; // defensive; should not happen
    const pickId = chooseBotPick(seat, pack, rng, cards);
    applyPickInPlace(s, seat.seatIndex, pickId);
  }
  return s;
}

function chooseBotPick(seat: DraftSeat, pack: Pack, rng: Rng, cards?: Record<string, CardData>): string {
  const colorCounts: Record<string, number> = {};
  if (cards) {
    for (const pick of seat.picks) {
      const data = cards[pick.cardId];
      if (!data) continue;
      for (const color of data.colors) colorCounts[color] = (colorCounts[color] ?? 0) + 1;
    }
  }

  let best: { instanceId: string; score: number } | null = null;
  for (const card of pack.cards) {
    let score = 0;
    const data = cards?.[card.cardId];
    if (data) {
      if (data.colors.length === 0) {
        score = 0.5; // colorless is always slightly playable
      } else {
        for (const color of data.colors) score += colorCounts[color] ?? 0;
      }
    }
    score += rng() * 0.1; // deterministic jitter / tiebreak
    if (!best || score > best.score) best = { instanceId: card.instanceId, score };
  }
  if (!best) throw new Error("Internal error: bot tried to pick from an empty pack");
  return best.instanceId;
}

/** Build the redacted per-seat view: your pack + picks, public info for others. */
export function getDraftView(
  state: DraftState,
  seatIndex: number,
  playerNames: (string | null)[],
  pickDeadline: number | null
): DraftView {
  const seat = state.seats[seatIndex];
  if (!seat) throw new Error(`No seat at index ${seatIndex}`);
  const head = seat.packQueue[0];
  return {
    draftId: state.id,
    seatIndex,
    packNumber: state.packNumber,
    packsPerPlayer: state.config.packsPerPlayer,
    cardsPerPack: state.config.cardsPerPack,
    currentPack: head ? structuredClone(head) : null,
    queuedPacks: Math.max(0, seat.packQueue.length - 1),
    picks: structuredClone(seat.picks),
    seats: state.seats.map((st) => ({
      seatIndex: st.seatIndex,
      playerName: playerNames[st.seatIndex] ?? null,
      isBot: st.isBot,
      pickCount: st.picks.length,
      queuedPacks: st.packQueue.length,
    })),
    complete: state.complete,
    pickDeadline,
  };
}
