/**
 * v8.1 targeting arrows: a fixed SVG overlay that draws curved arrows between
 * live DOM anchors (stack entries, battlefield cards, player avatars) located
 * by data-attribute selectors. A spec without `to` follows the mouse (the
 * "choosing a target" arrow, dashed).
 *
 * Measurement is EVENT-driven, not rAF-driven: rAF is throttled to zero in
 * background/embedded tabs, which would freeze the arrows entirely. Instead
 * positions recompute on spec changes, on every mousemove (which also feeds
 * the live arrow), on scroll/resize, and on a coarse interval for layout
 * drift.
 */
import { useEffect, useRef, useState } from "react";

export interface ArrowSpec {
  id: string;
  /** CSS selector for the source element (e.g. `[data-stack-id="x"]`). */
  from: string;
  /** CSS selector for the target element; omit to follow the mouse. */
  to?: string;
}

interface ArrowPath {
  id: string;
  d: string;
  live: boolean;
}

function centerOf(selector: string): { x: number; y: number } | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function TargetArrows({ specs }: { specs: ArrowSpec[] }): JSX.Element | null {
  const [paths, setPaths] = useState<ArrowPath[]>([]);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const lastSerialized = useRef("");
  const specsKey = JSON.stringify(specs);

  useEffect(() => {
    const recompute = (): void => {
      const next: ArrowPath[] = [];
      for (const spec of specs) {
        const from = centerOf(spec.from);
        if (!from) continue;
        let to: { x: number; y: number } | null;
        let live = false;
        if (spec.to) {
          to = centerOf(spec.to);
        } else {
          to = mouse.current;
          live = true;
        }
        if (!to) continue;
        // Quadratic curve that bows upward — reads as a thrown targeting line.
        const midX = (from.x + to.x) / 2;
        const midY = Math.min(from.y, to.y) - 46;
        next.push({
          id: spec.id,
          d: `M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`,
          live,
        });
      }
      const serialized = JSON.stringify(next);
      if (serialized !== lastSerialized.current) {
        lastSerialized.current = serialized;
        setPaths(next);
      }
    };

    if (specs.length === 0) {
      lastSerialized.current = "";
      setPaths([]);
      return;
    }
    const onMove = (e: MouseEvent): void => {
      mouse.current = { x: e.clientX, y: e.clientY };
      recompute();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    const interval = window.setInterval(recompute, 250); // layout drift catch-all
    recompute();
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey]);

  if (paths.length === 0) return null;
  return (
    <svg className="pointer-events-none fixed inset-0 z-[55] h-full w-full" aria-hidden="true">
      <defs>
        <marker
          id="target-arrowhead"
          markerWidth="9"
          markerHeight="9"
          refX="7"
          refY="4.5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L9,4.5 L0,9 Z" fill="#f87171" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path
          key={p.id}
          d={p.d}
          fill="none"
          stroke="#f87171"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={p.live ? "7 7" : undefined}
          markerEnd="url(#target-arrowhead)"
          opacity={0.92}
          style={{ filter: "drop-shadow(0 0 6px rgba(248,113,113,0.55))" }}
        />
      ))}
    </svg>
  );
}
