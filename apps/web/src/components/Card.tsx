/**
 * Card rendering: image with lazy load + styled text-frame fallback, card
 * backs for hidden/face-down cards, tap rotation, counter/damage badges, and a
 * global hover-preview layer (CardPreviewProvider).
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { CardData, GameCard } from "@mtg-cube/shared";
// Mana icon font (SIL OFL / MIT) — supplies the Arena-style keyword ability
// glyphs for battlefield tile chips. Vite bundles the font files locally.
import "mana-font/css/mana.css";
import {
  activeFace,
  colorBucket,
  frameClasses,
  keywordAbilities,
  nameOf,
  parseManaCost,
  powerToughnessOf,
  type ColorBucket,
} from "../lib/cards";
import { ManaSymbol } from "./ManaSymbol";

export type CardSize = "xs" | "sm" | "md" | "lg";

/** "frame" = classic full-card scan; "artTile" = Arena-style battlefield tile. */
export type CardVariant = "frame" | "artTile";

const SIZE_CLASSES: Record<CardSize, string> = {
  xs: "w-[64px]",
  sm: "w-[92px]",
  md: "w-[130px]",
  lg: "w-[244px]",
};

// Art-tile widths run wider than the frame widths because the tile is
// landscape (4:3) — a sm tile is shorter than a sm frame card.
const ART_TILE_SIZE_CLASSES: Record<CardSize, string> = {
  xs: "w-[84px]",
  sm: "w-[116px]",
  md: "w-[150px]",
  lg: "w-[244px]",
};

/**
 * CSS crop of a full-card scan down to its art band. Modern frames paint the
 * art between roughly 11% and 55.5% of card height; the band is horizontally
 * centered. The scan fills the art window's width, and the band's vertical
 * center is pinned to the window's center (translateY percentages are of the
 * image's own height) — the window crops the frame above/below the band.
 * Tuned visually against real Scryfall scans.
 */
const ART_CROP_TOP = 0.115;
const ART_CROP_BOTTOM = 0.555;
const ART_BAND_CENTER = (ART_CROP_TOP + ART_CROP_BOTTOM) / 2;

const ART_IMG_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: "50%",
  width: "100%",
  maxWidth: "none",
  transform: `translateY(-${(ART_BAND_CENTER * 100).toFixed(2)}%)`,
};

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

export interface PreviewValue {
  data?: CardData;
  gameCard?: GameCard;
  faceIndex: number;
  placement?: "side" | "above";
  /** Viewport rect of the hovered card — the preview docks next to it. */
  anchor?: { left: number; right: number; top: number; bottom: number };
}

const PreviewContext = createContext<Dispatch<SetStateAction<PreviewValue | null>> | null>(null);

const PREVIEW_WIDTH = 248;
const PREVIEW_GAP = 12;
const PREVIEW_MARGIN = 8;

export function CardPreviewProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preview, setPreview] = useState<PreviewValue | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const face = preview ? activeFace(preview.data, preview.faceIndex) : undefined;
  const oracle = face && "oracleText" in face ? face.oracleText : undefined;

  // Position after render (we need the preview's measured height to clamp).
  useLayoutEffect(() => {
    if (!preview) {
      setPos(null);
      return;
    }
    const a = preview.anchor;
    const height = boxRef.current?.offsetHeight ?? 420;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!a) {
      setPos({ left: PREVIEW_MARGIN, top: vh - height - PREVIEW_MARGIN });
      return;
    }
    let left: number;
    let top: number;
    if (preview.placement === "above") {
      left = (a.left + a.right) / 2 - PREVIEW_WIDTH / 2;
      top = a.top - PREVIEW_GAP - height;
    } else {
      // Prefer the right side of the hovered card; flip left when cramped.
      left = a.right + PREVIEW_GAP;
      if (left + PREVIEW_WIDTH > vw - PREVIEW_MARGIN) {
        left = a.left - PREVIEW_GAP - PREVIEW_WIDTH;
      }
      // Center vertically on the card.
      top = (a.top + a.bottom) / 2 - height / 2;
    }
    left = Math.max(PREVIEW_MARGIN, Math.min(left, vw - PREVIEW_WIDTH - PREVIEW_MARGIN));
    top = Math.max(PREVIEW_MARGIN, Math.min(top, vh - height - PREVIEW_MARGIN));
    setPos({ left, top });
  }, [preview]);

  return (
    <PreviewContext.Provider value={setPreview}>
      {children}
      {preview && (preview.data || preview.gameCard?.isToken) && (
        <div
          ref={boxRef}
          className="pointer-events-none fixed z-[70] w-[248px] animate-fade-in"
          style={pos ? { left: pos.left, top: pos.top } : { left: PREVIEW_MARGIN, top: -9999 }}
        >
          <Card
            data={preview.data}
            gameCard={preview.gameCard?.isToken ? preview.gameCard : undefined}
            faceIndex={preview.faceIndex}
            size="lg"
            disablePreview
            className="shadow-card-lg"
          />
          {oracle && (
            <div className="panel mt-1.5 max-h-40 overflow-hidden whitespace-pre-line p-2.5 text-[11px] leading-snug text-zinc-300">
              {oracle}
            </div>
          )}
        </div>
      )}
    </PreviewContext.Provider>
  );
}

/**
 * Imperative access to the global hover-preview layer for non-Card elements
 * (e.g. list rows). Wires into the same PreviewContext used by <Card> hovers;
 * Card behavior is untouched.
 */
export function useCardPreview(): {
  showPreview: (data: CardData | undefined, anchor: NonNullable<PreviewValue["anchor"]>) => void;
  clearPreview: () => void;
} {
  const setPreview = useContext(PreviewContext);
  return useMemo(
    () => ({
      showPreview: (data: CardData | undefined, anchor: NonNullable<PreviewValue["anchor"]>): void => {
        if (!setPreview || !data) return;
        setPreview({ data, faceIndex: 0, anchor });
      },
      clearPreview: (): void => {
        setPreview?.(null);
      },
    }),
    [setPreview]
  );
}

// ---------------------------------------------------------------------------
// Text frame fallback
// ---------------------------------------------------------------------------

function ManaCost({ cost }: { cost: string | undefined }): JSX.Element | null {
  const symbols = parseManaCost(cost);
  if (symbols.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-[2px]">
      {symbols.map((s, i) => (
        <ManaSymbol key={`${s}-${i}`} symbol={s} className="h-4 w-4" />
      ))}
    </span>
  );
}

interface TextFrameProps {
  name: string;
  manaCost?: string;
  typeLine?: string;
  oracleText?: string;
  pt: string | null;
  bucket: ReturnType<typeof colorBucket>;
  compact: boolean;
}

function TextFrame({ name, manaCost, typeLine, oracleText, pt, bucket, compact }: TextFrameProps): JSX.Element {
  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden rounded-[6%] border bg-gradient-to-b to-felt-950 ${frameClasses(bucket)} bg-felt-900`}
    >
      <div className="flex items-start justify-between gap-1 px-1.5 pt-1.5">
        <span className={`font-semibold leading-tight text-zinc-100 ${compact ? "text-[10px]" : "text-xs"}`}>{name}</span>
        {!compact && <ManaCost cost={manaCost} />}
      </div>
      {typeLine && (
        <div className={`mt-0.5 px-1.5 leading-tight text-zinc-400 ${compact ? "text-[8px]" : "text-[10px]"}`}>
          {typeLine}
        </div>
      )}
      {!compact && oracleText && (
        <div className="mt-1 flex-1 overflow-hidden border-t border-white/10 px-1.5 pt-1 text-[9px] leading-snug text-zinc-300">
          {oracleText}
        </div>
      )}
      {pt && (
        <div className="mt-auto self-end rounded-tl-md border-l border-t border-white/10 bg-black/50 px-1.5 py-0.5 text-[10px] font-bold text-zinc-100">
          {pt}
        </div>
      )}
    </div>
  );
}

export function CardBack({ className = "" }: { className?: string }): JSX.Element {
  return (
    <div className={`card-back flex h-full w-full items-center justify-center ${className}`}>
      <div className="flex h-1/3 w-1/2 items-center justify-center rounded-full border border-indigo-400/40 bg-indigo-950/70">
        <span className="select-none text-[10px] font-black tracking-widest text-brass-300/90">MTG</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Art tile (Arena-style battlefield rendering)
// ---------------------------------------------------------------------------

/**
 * Arena-style frame treatment per color bucket: a ~2px gradient frame border
 * plus a matching tint for the name strip (top) and stat bar (bottom). Text
 * color flips per tint for contrast (dark on ivory/gold, light elsewhere).
 */
interface TileFrameStyle {
  /** Gradient painted on the 2px frame ring. */
  frame: string;
  /** Gradient for the name strip and bottom bar. */
  bar: string;
  /** Name text color (contrast-matched to `bar`). */
  text: string;
}

const TILE_FRAMES: Record<ColorBucket, TileFrameStyle> = {
  // White: ivory / parchment with a silvered edge.
  W: {
    frame: "linear-gradient(155deg, #f8f0da, #cfc19b 45%, #8f8264)",
    bar: "linear-gradient(#efe6cd, #d5c69f)",
    text: "#37301d",
  },
  // Blue: rich lapis.
  U: {
    frame: "linear-gradient(155deg, #8cc0ee, #2c62a2 45%, #123a6b)",
    bar: "linear-gradient(#20518a, #143764)",
    text: "#dcecfd",
  },
  // Black: charcoal with silver text.
  B: {
    frame: "linear-gradient(155deg, #63636c, #26262c 45%, #0d0d11)",
    bar: "linear-gradient(#2c2c33, #141418)",
    text: "#d6d6db",
  },
  // Red: ember red-orange.
  R: {
    frame: "linear-gradient(155deg, #f29c72, #b23e24 45%, #6d1c0f)",
    bar: "linear-gradient(#8f3220, #5c1f11)",
    text: "#ffe5d7",
  },
  // Green: forest.
  G: {
    frame: "linear-gradient(155deg, #86c481, #2f6d3b 45%, #14371c)",
    bar: "linear-gradient(#286034, #163e20)",
    text: "#dcf6df",
  },
  // Multicolor: gold.
  M: {
    frame: "linear-gradient(155deg, #f8e88f, #cda43e 45%, #86661d)",
    bar: "linear-gradient(#c39733, #94701f)",
    text: "#2a1e05",
  },
  // Colorless / artifact: steel with a bronze undertone.
  C: {
    frame: "linear-gradient(155deg, #ccd1d8, #8d959f 45%, #4d545e)",
    bar: "linear-gradient(#6d7580, #484f58)",
    text: "#eef1f4",
  },
  // Land: warm tan.
  L: {
    frame: "linear-gradient(155deg, #dcbf93, #a37e50 45%, #5e442a)",
    bar: "linear-gradient(#87663e, #5c4327)",
    text: "#f4e5cb",
  },
};

// ---------------------------------------------------------------------------
// Keyword ability icon chips
// ---------------------------------------------------------------------------

/**
 * Arena-style ability glyphs from the bundled Mana icon font (mana-font,
 * imported in this module — Vite inlines the woff/ttf). Every keyword in
 * KNOWN_KEYWORDS has a font glyph in mana-font 1.18, so no SVG fallback is
 * needed; if a keyword ever misses this map, its chip falls back to a shield.
 */
const KEYWORD_MS_CLASS: Record<string, string> = {
  flying: "ms-ability-flying",
  "first strike": "ms-ability-first-strike",
  "double strike": "ms-ability-double-strike",
  deathtouch: "ms-ability-deathtouch",
  lifelink: "ms-ability-lifelink",
  trample: "ms-ability-trample",
  haste: "ms-ability-haste",
  vigilance: "ms-ability-vigilance",
  menace: "ms-ability-menace",
  reach: "ms-ability-reach",
  hexproof: "ms-ability-hexproof",
  indestructible: "ms-ability-indestructible",
  flash: "ms-ability-flash",
  defender: "ms-ability-defender",
  ward: "ms-ability-ward",
  protection: "ms-ability-protection",
};

const MAX_KEYWORD_CHIPS = 4;

/** Small dark rounded-square chips, one per keyword, bottom-left of a tile. */
function KeywordChips({ keywords }: { keywords: string[] }): JSX.Element | null {
  if (keywords.length === 0) return null;
  const overflow = keywords.length > MAX_KEYWORD_CHIPS;
  const shown = overflow ? keywords.slice(0, MAX_KEYWORD_CHIPS - 1) : keywords;
  const hidden = keywords.slice(shown.length);
  return (
    <span className="pointer-events-auto flex items-center gap-[2px]">
      {shown.map((kw) => (
        <span
          key={kw}
          title={kw}
          className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-white/20 bg-black/75 shadow-[0_1px_2px_rgba(8,6,30,0.6)]"
        >
          <i
            aria-hidden
            className={`ms ${KEYWORD_MS_CLASS[kw] ?? "ms-ability-protection"}`}
            style={{ fontSize: "10px", color: "#f4f4f5" }}
          />
        </span>
      ))}
      {overflow && (
        <span
          title={hidden.join(", ")}
          className="flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] border border-white/20 bg-black/75 px-0.5 text-[8px] font-bold leading-none text-zinc-100 shadow-[0_1px_2px_rgba(8,6,30,0.6)]"
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

/** P/T plate anchored in the tile's bottom stat bar. */
function TilePtPlate({ pt }: { pt: string }): JSX.Element {
  return (
    <span className="pointer-events-none ml-auto rounded border border-white/25 bg-black/80 px-1 py-px text-[10px] font-black leading-tight tracking-tight text-zinc-50 shadow-[0_1px_3px_rgba(8,6,30,0.7)]">
      {pt}
    </span>
  );
}

interface ArtTileFrameProps {
  bucket: ColorBucket;
  name: string;
  pt: string | null;
  keywords: string[];
  /** Art-window content: cropped scan or fallback filler. */
  children: ReactNode;
}

/**
 * Arena-style mini card: color-tinted gradient frame ring, tinted name strip
 * across the top, art window in the middle, and a tinted bottom bar holding
 * keyword chips (left) and the P/T plate (right). The bottom bar collapses
 * when there is nothing to show (e.g. lands), giving the art the room back.
 */
function ArtTileFrame({ bucket, name, pt, keywords, children }: ArtTileFrameProps): JSX.Element {
  const f = TILE_FRAMES[bucket];
  const hasBottomBar = pt !== null || keywords.length > 0;
  return (
    <div
      className="absolute inset-0 rounded-lg p-[2px] shadow-[0_0_0_1px_rgba(8,6,30,0.65)]"
      style={{ background: f.frame }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-[5px] bg-felt-950">
        <div
          className="flex h-[15px] shrink-0 items-center border-b border-black/40 px-1"
          style={{ background: f.bar }}
        >
          <span className="truncate text-[9px] font-semibold leading-none" style={{ color: f.text }}>
            {name}
          </span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-felt-950">{children}</div>
        {hasBottomBar && (
          <div
            className="flex h-[18px] shrink-0 items-center border-t border-black/40 px-[3px]"
            style={{ background: f.bar }}
          >
            <KeywordChips keywords={keywords} />
            {pt && <TilePtPlate pt={pt} />}
          </div>
        )}
      </div>
    </div>
  );
}

interface ArtTileFallbackProps {
  name: string;
  typeLine?: string;
  pt: string | null;
  bucket: ColorBucket;
  keywords: string[];
}

/** Art-tile fallback for cards with no image (and for tokens): same frame,
 * with a tinted filler and the type line where the art would be. */
function ArtTileFallback({ name, typeLine, pt, bucket, keywords }: ArtTileFallbackProps): JSX.Element {
  return (
    <ArtTileFrame bucket={bucket} name={name} pt={pt} keywords={keywords}>
      <div
        className={`flex h-full w-full flex-col items-center justify-center bg-gradient-to-br to-felt-950 px-1.5 ${frameClasses(bucket)} bg-felt-900`}
      >
        {typeLine && (
          <span className="max-w-full truncate text-center text-[8px] leading-tight text-zinc-300/90">{typeLine}</span>
        )}
      </div>
    </ArtTileFrame>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardProps {
  data?: CardData;
  gameCard?: GameCard;
  /** Face override when no gameCard is given. */
  faceIndex?: number;
  /** Force a card back (e.g. opponent hand). */
  back?: boolean;
  size?: CardSize;
  /**
   * "frame" (default) renders the classic full-card look; "artTile" renders an
   * Arena-style landscape tile cropped to the card art (battlefield only).
   * The hover preview always shows the full "frame" rendering.
   */
  variant?: CardVariant;
  selected?: boolean;
  highlight?: "attack" | "block" | "autopick" | null;
  dimmed?: boolean;
  /** Name of the permanent this card is attached to (renders a chip). */
  attachedName?: string;
  onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /**
   * Gold spark chip in the top-right corner hinting an activatable ability
   * (v4 fetch searches). Clicking it is deliberate: propagation stops so the
   * plain click (tap / tap-for-mana) never fires.
   */
  activateHint?: { title: string; onClick: (e: ReactMouseEvent<HTMLElement>) => void };
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  className?: string;
  disablePreview?: boolean;
  /** Override where the enlarged hover preview opens. */
  previewPlacement?: "side" | "above";
  title?: string;
}

export function Card(props: CardProps): JSX.Element {
  const {
    data,
    gameCard,
    faceIndex,
    back = false,
    size = "md",
    variant = "frame",
    selected = false,
    highlight = null,
    dimmed = false,
    attachedName,
    onClick,
    onDoubleClick,
    onContextMenu,
    activateHint,
    draggable,
    onDragStart,
    className = "",
    disablePreview = false,
    previewPlacement = "side",
    title,
  } = props;

  const setPreview = useContext(PreviewContext);
  const [imageFailed, setImageFailed] = useState(false);
  // If this card set the current preview and then unmounts (e.g. it was played
  // from hand), mouseleave never fires — clear the preview on unmount instead.
  const lastPreviewSet = useRef<PreviewValue | null>(null);
  useEffect(
    () => () => {
      if (lastPreviewSet.current && setPreview) {
        setPreview((p) => (p === lastPreviewSet.current ? null : p));
      }
    },
    [setPreview]
  );

  const shownFaceIndex = gameCard ? gameCard.faceIndex : (faceIndex ?? 0);
  const isHidden = gameCard?.cardId === "hidden";
  const isFaceDown = gameCard?.faceDown === true;
  const isToken = gameCard?.isToken === true;
  const showBack = back || isHidden || isFaceDown;

  const face = activeFace(data, shownFaceIndex);
  const faceImageNormal = face && "imageNormal" in face ? face.imageNormal : undefined;
  const faceImageSmall = face && "imageSmall" in face ? face.imageSmall : undefined;
  const artTile = variant === "artTile";
  // Art tiles zoom into the scan's art band (~2.3x), so always prefer the
  // normal-resolution image there; small scans go blurry when cropped.
  const imgSrc =
    (size === "xs" || size === "sm") && !artTile
      ? (faceImageSmall ?? faceImageNormal ?? data?.imageSmall ?? data?.imageNormal)
      : (faceImageNormal ?? faceImageSmall ?? data?.imageNormal ?? data?.imageSmall);

  useEffect(() => {
    setImageFailed(false);
  }, [imgSrc]);

  const name = gameCard ? nameOf(gameCard, data) : (face?.name ?? data?.name ?? "Card");
  const pt = gameCard ? powerToughnessOf(gameCard, data) : (data ? (data.power !== undefined && data.toughness !== undefined ? `${data.power}/${data.toughness}` : null) : null);
  const tapped = gameCard?.tapped === true;

  const ring = selected
    ? "shadow-glow"
    : highlight === "attack"
      ? "shadow-glow-red"
      : highlight === "block"
        ? "shadow-glow-blue"
        : highlight === "autopick"
          ? "autopick-highlight"
          : "shadow-card hover:shadow-glow-soft";

  const counters = gameCard ? Object.entries(gameCard.counters).filter(([, n]) => n !== 0) : [];
  const damage = gameCard?.damage ?? 0;

  // Keyword ability chips (art tiles only; tokens carry no oracle text).
  const keywords = useMemo(
    () => (artTile && data && !isToken ? keywordAbilities(data) : []),
    [artTile, data, isToken]
  );

  let body: JSX.Element;
  if (showBack) {
    body = artTile ? (
      <div className="absolute inset-0 overflow-hidden rounded-lg">
        <CardBack className="!rounded-lg" />
      </div>
    ) : (
      <CardBack />
    );
  } else if (isToken && gameCard) {
    body = artTile ? (
      <ArtTileFallback
        name={gameCard.tokenName ?? "Token"}
        typeLine={gameCard.tokenTypeLine}
        pt={powerToughnessOf(gameCard, undefined)}
        bucket="C"
        keywords={keywords}
      />
    ) : (
      <TextFrame
        name={gameCard.tokenName ?? "Token"}
        typeLine={gameCard.tokenTypeLine}
        pt={powerToughnessOf(gameCard, undefined)}
        bucket="C"
        compact={size === "xs" || size === "sm"}
      />
    );
  } else if (imgSrc && !imageFailed) {
    body = artTile ? (
      <ArtTileFrame bucket={colorBucket(data)} name={name} pt={pt} keywords={keywords}>
        <img
          src={imgSrc}
          alt={name}
          loading={size === "md" || size === "lg" ? "eager" : "lazy"}
          draggable={false}
          onError={() => setImageFailed(true)}
          style={ART_IMG_STYLE}
        />
      </ArtTileFrame>
    ) : (
      <img
        src={imgSrc}
        alt={name}
        loading={size === "md" || size === "lg" ? "eager" : "lazy"}
        draggable={false}
        onError={() => setImageFailed(true)}
        className="h-full w-full rounded-[6%] object-cover"
      />
    );
  } else if (artTile) {
    body = (
      <ArtTileFallback
        name={name}
        typeLine={face?.typeLine ?? data?.typeLine}
        pt={pt}
        bucket={colorBucket(data)}
        keywords={keywords}
      />
    );
  } else {
    body = (
      <TextFrame
        name={name}
        manaCost={face && "manaCost" in face ? face.manaCost : data?.manaCost}
        typeLine={face?.typeLine ?? data?.typeLine}
        oracleText={face && "oracleText" in face ? face.oracleText : data?.oracleText}
        pt={pt}
        bucket={colorBucket(data)}
        compact={size === "xs" || size === "sm"}
      />
    );
  }

  const previewValue: PreviewValue | null =
    data || isToken ? { data, gameCard, faceIndex: shownFaceIndex } : null;

  return (
    <div
      title={title ?? name}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={(e) => {
        if (disablePreview || !setPreview) return;
        const r = e.currentTarget.getBoundingClientRect();
        const anchor = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        if (previewValue && !showBack) {
          const v = { ...previewValue, anchor, placement: previewPlacement };
          lastPreviewSet.current = v;
          setPreview(v);
        } else if (isFaceDown && data) {
          const v = { data, gameCard, faceIndex: shownFaceIndex, anchor, placement: previewPlacement };
          lastPreviewSet.current = v;
          setPreview(v);
        }
      }}
      onMouseLeave={() => {
        if (!disablePreview && setPreview) {
          lastPreviewSet.current = null;
          setPreview(null);
        }
      }}
      className={`relative shrink-0 select-none ${artTile ? ART_TILE_SIZE_CLASSES[size] : SIZE_CLASSES[size]} ${className} ${onClick || onDoubleClick || onContextMenu ? "cursor-pointer" : ""}`}
    >
      <div
        className={`relative w-full transition-all duration-150 ${artTile ? "aspect-[4/3] rounded-lg" : "aspect-[5/7] rounded-[6%]"} ${ring} ${tapped ? "rotate-90" : ""} ${dimmed ? "opacity-50" : ""} ${onClick || onDoubleClick ? "hover:-translate-y-1 hover:scale-[1.03]" : ""}`}
      >
        {body}
        {highlight === "autopick" && (
          <span className="absolute -right-1.5 -top-2 z-20 rounded-full border border-red-200/70 bg-gradient-to-b from-red-500 to-red-800 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-white shadow-[0_0_12px_rgba(248,113,113,0.65)]">
            Auto pick
          </span>
        )}
        {isFaceDown && !isHidden && (
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-zinc-300">
            Face down
          </span>
        )}
        {gameCard?.attacking && (
          <span className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] shadow-card" title="Attacking">
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-white"><path d="M6.9 2.3 17 12.4l2.1-2.1 2.6 6.9-6.9-2.6 2.1-2.1L6.8 2.4l.1-.1ZM3.5 17.7l2.8 2.8-1.4 1.4-2.8-2.8 1.4-1.4Zm3.2-3.2 2.8 2.8-2.1 2.1-2.8-2.8 2.1-2.1Z" /></svg>
          </span>
        )}
        {gameCard?.blocking && (
          <span className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 shadow-card" title="Blocking">
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-white"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z" /></svg>
          </span>
        )}
        {damage > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-700 px-1 text-[10px] font-bold text-white shadow-card" title={`${damage} damage marked`}>
            {damage}
          </span>
        )}
        {/* Shares the corner with the damage badge; damage (rare on these
            permanents) wins so the two never overlap. */}
        {activateHint && !showBack && damage === 0 && (
          <button
            type="button"
            title={activateHint.title}
            onClick={(e) => {
              e.stopPropagation();
              activateHint.onClick(e);
            }}
            className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-amber-200/70 bg-gradient-to-b from-amber-300 to-amber-500 text-amber-950 shadow-[0_0_8px_rgba(251,191,36,0.65)] transition-transform duration-150 hover:scale-110 active:scale-95"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current"><path d="M13 2 4.5 13.5H10L8.5 22 17.5 10H12L13 2Z" /></svg>
          </button>
        )}
        {/* On art tiles the bottom bar owns keyword chips + P/T, so counters
            stack vertically up the left edge just above it — clear of the
            damage badge (top-right) and attack badge (top-left). */}
        {counters.length > 0 && (
          <div
            className={`absolute flex gap-0.5 ${artTile ? "bottom-[22px] left-0.5 flex-col items-start" : "bottom-1 left-1 right-1 flex-wrap"}`}
          >
            {counters.map(([type, n]) => (
              <span key={type} className="rounded bg-amber-400 px-1 py-0.5 text-[9px] font-bold leading-none text-amber-950 shadow" title={`${n} ${type} counter${n === 1 ? "" : "s"}`}>
                {n} {type}
              </span>
            ))}
          </div>
        )}
      </div>
      {attachedName && (
        <div className="chip mt-0.5 max-w-full truncate" title={`Attached to ${attachedName}`}>
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 shrink-0 fill-brass-300"><path d="M10 6 8.6 7.4 13.2 12l-4.6 4.6L10 18l6-6-6-6Z" /></svg>
          <span className="truncate">{attachedName}</span>
        </div>
      )}
    </div>
  );
}
