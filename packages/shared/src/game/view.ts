/**
 * View redaction — invariant 2: hidden information never leaves the server.
 *
 * `buildGameView(state, viewerId, cards)` deep-clones the state and replaces
 * every hidden card with a placeholder (`cardId: "hidden"`, neutral fields).
 * Hidden zones are: the opponent's hand and BOTH libraries. Placeholders keep
 * the original instanceId so counts and order survive redaction (index 0 of a
 * library = its top card, which is what drawCard / moveCard-from-library
 * target). The `cards` record is filtered down to card data the viewer may
 * see.
 *
 * A viewerId that matches neither player (a spectator) gets BOTH hands
 * hidden.
 *
 * `revealHand` is log-only in v1 (PlayerGameState carries no reveal flag), so
 * the view never un-hides an opponent hand.
 */
import type { CardData, GameCard, GameState, GameView } from "../types.js";

function hiddenPlaceholder(card: GameCard): GameCard {
  return {
    instanceId: card.instanceId,
    cardId: "hidden",
    ownerId: card.ownerId,
    controllerId: card.controllerId,
    tapped: false,
    faceDown: true,
    faceIndex: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    damage: 0,
    attacking: false,
    blocking: null,
    sortIndex: 0,
  };
}

export function buildGameView(
  state: GameState,
  viewerId: string,
  cards: Record<string, CardData>
): GameView {
  const s = structuredClone(state);
  const visibleCardIds = new Set<string>();

  for (const p of s.players) {
    // Both libraries are always hidden (counts + order only).
    p.zones.library = p.zones.library.map(hiddenPlaceholder);

    if (p.playerId === viewerId) {
      for (const c of p.zones.hand) visibleCardIds.add(c.cardId);
    } else {
      p.zones.hand = p.zones.hand.map(hiddenPlaceholder);
    }

    // Public zones (and sideboards, which v1 leaves visible).
    for (const zone of ["battlefield", "graveyard", "exile", "sideboard"] as const) {
      for (const c of p.zones[zone]) visibleCardIds.add(c.cardId);
    }
  }
  for (const c of s.stack) visibleCardIds.add(c.cardId);

  const filtered: Record<string, CardData> = {};
  for (const id of visibleCardIds) {
    const data = cards[id];
    if (data) filtered[id] = data;
  }

  return { gameId: s.id, viewerId, state: s, cards: filtered };
}
