import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import {
  isVisualThemeId,
  readStoredVisualTheme,
  VISUAL_THEME_STORAGE_KEY,
  type VisualThemeId,
} from "../lib/visualThemes";

interface VisualThemeContextValue {
  theme: VisualThemeId;
  setTheme: (theme: VisualThemeId) => void;
}

const VisualThemeContext = createContext<VisualThemeContextValue | null>(null);

export function VisualThemeProvider({ children }: PropsWithChildren): JSX.Element {
  const [theme, setThemeState] = useState<VisualThemeId>(readStoredVisualTheme);

  const setTheme = useCallback((nextTheme: VisualThemeId): void => {
    setThemeState(nextTheme);
    try {
      localStorage.setItem(VISUAL_THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The selection still works for this visit when storage is unavailable.
    }
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.visualTheme = theme;
  }, [theme]);

  useEffect(() => {
    const syncThemeAcrossTabs = (event: StorageEvent): void => {
      if (event.key === VISUAL_THEME_STORAGE_KEY && isVisualThemeId(event.newValue)) {
        setThemeState(event.newValue);
      }
    };
    window.addEventListener("storage", syncThemeAcrossTabs);
    return () => window.removeEventListener("storage", syncThemeAcrossTabs);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
  return <VisualThemeContext.Provider value={value}>{children}</VisualThemeContext.Provider>;
}

export function useVisualTheme(): VisualThemeContextValue {
  const value = useContext(VisualThemeContext);
  if (!value) throw new Error("useVisualTheme must be used inside VisualThemeProvider");
  return value;
}
