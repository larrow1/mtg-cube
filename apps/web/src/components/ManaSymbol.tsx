import { useState } from "react";
import { manaPipClasses } from "../lib/cards";

interface ManaSymbolProps {
  symbol: string;
  className?: string;
}

/**
 * Render a project-local Scryfall Manamoji. Hybrid symbols omit their slash
 * in filenames: {W/U} maps to mana-wu.png and {W/P} to mana-wp.png.
 */
export function ManaSymbol({ symbol, className = "h-4 w-4" }: ManaSymbolProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const normalizedSymbol = symbol.replaceAll("/", "").toLowerCase();
  const assetName = normalizedSymbol === "∞" ? "infinity" : normalizedSymbol === "½" ? "half" : normalizedSymbol;
  const label = `{${symbol}} mana`;

  if (failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none ${manaPipClasses(symbol)} ${className}`}
        aria-label={label}
        title={label}
      >
        {symbol}
      </span>
    );
  }

  return (
    <img
      src={`/mana/mana-${encodeURIComponent(assetName)}.png`}
      alt={label}
      title={label}
      className={`inline-block shrink-0 drop-shadow-[0_1px_1px_rgba(8,6,30,0.65)] ${className}`}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
