export const VISUAL_THEME_STORAGE_KEY = "mtg-cube-visual-theme";

export const VISUAL_THEMES = [
  {
    id: "astral-archive",
    name: "Astral Archive",
    description: "A celestial library of sapphire light and ancient brass.",
  },
  {
    id: "emberforge",
    name: "Emberforge",
    description: "A volcanic citadel glowing with fire, iron, and molten gold.",
  },
  {
    id: "overgrown-reliquary",
    name: "Overgrown Reliquary",
    description: "An ancient jungle sanctuary reclaimed by roots and emerald magic.",
  },
  {
    id: "moonlit-necropolis",
    name: "Moonlit Necropolis",
    description: "A gothic city of silver moonlight, mist, and deep burgundy.",
  },
  {
    id: "etherium-vault",
    name: "Etherium Vault",
    description: "An arcane machine vault humming with cyan energy and brasswork.",
  },
  {
    id: "hearthbloom-vale",
    name: "Hearthbloom Vale",
    description: "A bright storybook village filled with flowers and golden sun.",
  },
  {
    id: "everglen-sanctuary",
    name: "Everglen Sanctuary",
    description: "A flourishing enchanted forest of turquoise water and vivid green.",
  },
] as const;

export type VisualThemeId = (typeof VISUAL_THEMES)[number]["id"];
export type VisualThemeScreen = "home" | "draft" | "deckbuilder" | "battlefield";

export const DEFAULT_VISUAL_THEME: VisualThemeId = "astral-archive";

const THEME_IDS = new Set<string>(VISUAL_THEMES.map((theme) => theme.id));

export function isVisualThemeId(value: string | null): value is VisualThemeId {
  return value !== null && THEME_IDS.has(value);
}

export function readStoredVisualTheme(): VisualThemeId {
  try {
    const stored = localStorage.getItem(VISUAL_THEME_STORAGE_KEY);
    return isVisualThemeId(stored) ? stored : DEFAULT_VISUAL_THEME;
  } catch {
    return DEFAULT_VISUAL_THEME;
  }
}

export function visualThemeAsset(theme: VisualThemeId, screen: VisualThemeScreen): string {
  return `/backgrounds/themes/${theme}/${screen}.jpg`;
}

export function visualThemePreview(theme: VisualThemeId): string {
  return `/backgrounds/themes/${theme}/preview.jpg`;
}
