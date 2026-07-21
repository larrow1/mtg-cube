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
  type Dispatch,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { CardData, GameCard } from "@mtg-cube/shared";
import {
  activeFace,
  colorBucket,
  frameClasses,
  nameOf,
  parseManaCost,
  powerToughnessOf,
} from "../lib/cards";
import { ManaSymbol } from "./ManaSymbol";

export type CardSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<CardSize, string> = {
  xs: "w-[64px]",
  sm: "w-[92px]",
  md: "w-[130px]",
  lg: "w-[244px]",
};

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

export interface PreviewValue {
  data?: CardData;
  gameCard?: GameCard;
  faceIndex: number;
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
    // Prefer the right side of the hovered card; flip left when cramped.
    let left = a.right + PREVIEW_GAP;
    if (left + PREVIEW_WIDTH > vw - PREVIEW_MARGIN) {
      left = a.left - PREVIEW_GAP - PREVIEW_WIDTH;
    }
    left = Math.max(PREVIEW_MARGIN, Math.min(left, vw - PREVIEW_WIDTH - PREVIEW_MARGIN));
    // Center vertically on the card, clamped into the viewport.
    let top = (a.top + a.bottom) / 2 - height / 2;
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
  selected?: boolean;
  highlight?: "attack" | "block" | "autopick" | null;
  dimmed?: boolean;
  /** Name of the permanent this card is attached to (renders a chip). */
  attachedName?: string;
  onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  className?: string;
  disablePreview?: boolean;
  title?: string;
}

export function Card(props: CardProps): JSX.Element {
  const {
    data,
    gameCard,
    faceIndex,
    back = false,
    size = "md",
    selected = false,
    highlight = null,
    dimmed = false,
    attachedName,
    onClick,
    onDoubleClick,
    onContextMenu,
    draggable,
    onDragStart,
    className = "",
    disablePreview = false,
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
  const imgSrc =
    size === "xs" || size === "sm"
      ? (faceImageSmall ?? faceImageNormal ?? data?.imageSmall ?? data?.imageNormal)
      : (faceImageNormal ?? faceImageSmall ?? data?.imageNormal ?? data?.imageSmall);

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

  let body: JSX.Element;
  if (showBack) {
    body = <CardBack />;
  } else if (isToken && gameCard) {
    body = (
      <TextFrame
        name={gameCard.tokenName ?? "Token"}
        typeLine={gameCard.tokenTypeLine}
        pt={powerToughnessOf(gameCard, undefined)}
        bucket="C"
        compact={size === "xs" || size === "sm"}
      />
    );
  } else if (imgSrc && !imageFailed) {
    body = (
      <img
        src={imgSrc}
        alt={name}
        loading="lazy"
        draggable={false}
        onError={() => setImageFailed(true)}
        className="h-full w-full rounded-[6%] object-cover"
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
          const v = { ...previewValue, anchor };
          lastPreviewSet.current = v;
          setPreview(v);
        } else if (isFaceDown && data) {
          const v = { data, gameCard, faceIndex: shownFaceIndex, anchor };
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
      className={`relative shrink-0 select-none ${SIZE_CLASSES[size]} ${className} ${onClick || onDoubleClick || onContextMenu ? "cursor-pointer" : ""}`}
    >
      <div
        className={`relative aspect-[5/7] w-full rounded-[6%] transition-all duration-150 ${ring} ${tapped ? "rotate-90" : ""} ${dimmed ? "opacity-50" : ""} ${onClick || onDoubleClick ? "hover:-translate-y-1 hover:scale-[1.03]" : ""}`}
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
        {counters.length > 0 && (
          <div className="absolute bottom-1 left-1 right-1 flex flex-wrap gap-0.5">
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
