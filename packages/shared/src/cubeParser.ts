/**
 * Parse a raw cube list. Supported line formats (case-insensitive, blank lines
 * and lines starting with # or // ignored):
 *   Lightning Bolt
 *   1 Lightning Bolt
 *   4x Lightning Bolt
 *   1 Fire // Ice          (split card names pass through as-is)
 * Set/collector suffixes like "(M10) 146" are stripped.
 */

export interface ParsedCubeLine {
  count: number;
  name: string;
}

export function parseCubeList(raw: string): ParsedCubeLine[] {
  const out: ParsedCubeLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = /^(\d+)\s*[xX]?\s+(.+)$/.exec(line);
    let count = 1;
    let name = line;
    if (m) {
      count = parseInt(m[1]!, 10);
      name = m[2]!;
    }
    // Strip trailing set/collector info like "(M10) 146" or "[M10]"
    name = name.replace(/\s*[([][A-Za-z0-9]{2,6}[)\]]\s*\d*\s*$/, "").trim();
    if (!name || count < 1 || count > 99) continue;
    out.push({ count, name });
  }
  return out;
}

/** Collapse duplicate names, summing counts. Preserves first-seen order. */
export function normalizeCubeLines(lines: ParsedCubeLine[]): ParsedCubeLine[] {
  const byName = new Map<string, ParsedCubeLine>();
  for (const l of lines) {
    const key = l.name.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.count += l.count;
    else byName.set(key, { ...l });
  }
  return [...byName.values()];
}
