/**
 * HTML5 drag-and-drop payload helpers.
 *
 * Two distinct payload channels keep drags unambiguous:
 *  - "text/plain"                 — an already-picked card's instanceId
 *                                   (lane-to-lane / zone-to-zone moves).
 *  - PACK_PICK_MIME (custom type) — a JSON {kind:"packPick", instanceId}
 *                                   payload set when dragging a card straight
 *                                   out of the current draft pack. Lane drop
 *                                   targets check this channel first, so
 *                                   pack drags never collide with move drags.
 */

export const PACK_PICK_MIME = "application/x-mtg-cube-pack-pick";

interface PackPickPayload {
  kind: "packPick";
  instanceId: string;
}

/** Mark a drag as "pick this card from the current pack". */
export function setPackPickData(dt: DataTransfer, instanceId: string): void {
  const payload: PackPickPayload = { kind: "packPick", instanceId };
  dt.setData(PACK_PICK_MIME, JSON.stringify(payload));
  dt.effectAllowed = "copyMove";
}

/** InstanceId from a pack-pick drag, or null when this drop isn't one. */
export function getPackPickInstanceId(dt: DataTransfer): string | null {
  const raw = dt.getData(PACK_PICK_MIME);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PackPickPayload> | null;
    if (p && p.kind === "packPick" && typeof p.instanceId === "string") return p.instanceId;
  } catch {
    // Malformed payload — treat as "not a pack pick".
  }
  return null;
}
