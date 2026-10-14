// Circles over the blueprint, in one SVG the size of the viewport.
//
// Two coordinate layers (DeployMap's split): circle bodies live in a world
// group scaled with the page (their strokes use non-scaling-stroke so they
// stay 2–3 px), while the selection ring, resize handles, move grip and the
// add-mode preview are drawn in plain screen px so they keep a constant,
// finger-sized look at every zoom. Nothing here takes pointer events — hit
// testing is done by math in the controller (hitTest.ts), from the same
// constants, so what's drawn is exactly what a press finds.
//
// Zooming must not re-render every circle (a plan can have hundreds, and a
// pinch changes the scale every frame). The circle components don't depend
// on the scale at all; the two things that do — the 10 px minimum drawn
// radius and the constant-size number badge — are written straight onto
// the DOM by sizeMarks() once per zoom frame.

import { memo, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";
import { CIRCLE_COLORS, DEFAULT_CIRCLE_COLOR } from "../../../shared/constants";
import { circleWorld, longSide, worldToScreen, type View } from "../../../shared/geometry";
import type { CircleColor, CircleRow, PageRow } from "../../../shared/types";
import {
  GRIP_HIT_R,
  GRIP_R,
  HANDLE_DIRS,
  HANDLE_DOT_R,
  HANDLE_HIT_R,
  HANDLE_RING_MIN,
  MIN_DRAW_R,
  drawRadius,
  handlePoint,
  handleRing,
} from "./hitTest";
import type { CanvasMode } from "./types";
import type { Size } from "./viewMath";

type Palette = (typeof CIRCLE_COLORS)[CircleColor];

const palette = (c: string): Palette => CIRCLE_COLORS[c as CircleColor] ?? CIRCLE_COLORS[DEFAULT_CIRCLE_COLOR];

/** The palette fill made a bit stronger for the lit look (same hue, ~1.8× the alpha). */
const LIT_FILL: Record<string, string> = Object.fromEntries(
  Object.entries(CIRCLE_COLORS).map(([k, p]) => [k, p.fill.replace(/[\d.]+\)\s*$/, (a) => `${Math.min(0.4, parseFloat(a) * 1.8).toFixed(3)})`)]),
);

/** Badge chip width (screen px) for a label of n characters (Montserrat's figures run wide). */
const badgeWidth = (n: number) => Math.max(18, 9 + n * 7);
/** On the selected circle the badge rides above the N handle and the dashed ring instead of under them. */
const SELECTED_BADGE_LIFT = 22;
/**
 * Half the side of the grip's square chip (screen px): its corners stay
 * inside the grip's smallest hit radius (a mouse's), so what's drawn is
 * what a press finds.
 */
const GRIP_HALF = Math.min(GRIP_R, Math.floor(GRIP_HIT_R.mouse / Math.SQRT2));
/** Feather's "move" glyph (four arrows), centred on 0,0, 14 px across. */
const GRIP_GLYPH = "M0 -7V7M-7 0H7M-2.6 -4.4L0 -7L2.6 -4.4M-2.6 4.4L0 7L2.6 4.4M-4.4 -2.6L-7 0L-4.4 2.6M4.4 -2.6L7 0L4.4 2.6";

interface MarkProps {
  cx: number;
  cy: number;
  /** World radius. */
  r: number;
  color: string;
  num: number;
  lit: boolean;
  selected: boolean;
}

/**
 * One circle, in world px. Props are primitives and independent of the zoom,
 * so pans and zooms re-render none of them. The radius React writes is the
 * true one; sizeMarks() raises it to the 10 px minimum and places the badge.
 */
const CircleMark = memo(function CircleMark({ cx, cy, r, color, num, lit, selected }: MarkProps) {
  const p = palette(color);
  const label = num > 0 ? String(num) : "•";
  const bw = badgeWidth(label.length);
  const lift = selected ? SELECTED_BADGE_LIFT : 0;
  return (
    <g className={`bp-anno${lit ? " lit" : ""}${selected ? " sel" : ""}`} data-color={color}>
      <circle className="bp-anno-glow" cx={cx} cy={cy} r={r} stroke={p.glow} />
      <circle className="bp-anno-body" cx={cx} cy={cy} r={r} fill={lit ? LIT_FILL[color] ?? p.fill : p.fill} stroke={p.stroke} />
      {/* number badge: a black chip with gold figures on the circle's top edge, constant screen size (transform: sizeMarks; colours: canvas.css) */}
      <g className="bp-badge">
        <rect x={-bw / 2} y={-9 - lift} width={bw} height={18} />
        <text x={0} y={-lift} dy="0.35em" textAnchor="middle">
          {label}
        </text>
      </g>
    </g>
  );
});

/**
 * The zoom-dependent part of every circle, applied to the DOM directly:
 * the drawn radius (never under 10 screen px) and the badge, which sits on
 * the drawn top edge at a constant screen size (on the selected circle, on
 * its handle ring, which a small circle pushes out). `list` is in DOM order.
 */
function sizeMarks(world: SVGGElement, list: readonly CircleRow[], page: PageRow, scale: number, selectedId: string | null, ringMin: number) {
  const ls = longSide(page);
  const inv = 1 / scale;
  const minR = MIN_DRAW_R * inv;
  const ringMinW = ringMin * inv;
  const marks = world.children;
  for (let i = 0; i < list.length && i < marks.length; i++) {
    const c = list[i];
    const [glow, body, badge] = marks[i].children;
    const rw = c.r * ls;
    const R = rw < minR ? minR : rw;
    const rs = String(R);
    // React only rewrites r when the circle's own radius changes, and this runs after it
    if (body.getAttribute("r") !== rs) {
      glow.setAttribute("r", rs);
      body.setAttribute("r", rs);
    }
    const top = c.id === selectedId && R < ringMinW ? ringMinW : R;
    badge.setAttribute("transform", `translate(${c.x * page.width} ${c.y * page.height - top}) scale(${inv})`);
  }
}

/** A rendered circle element and the inputs it was made from. */
interface MarkEntry {
  c: CircleRow;
  lit: boolean;
  sel: boolean;
  el: ReactElement;
}

export interface AnnotationLayerProps {
  page: PageRow;
  circles: CircleRow[];
  view: View;
  size: Size;
  selectedId: string | null;
  /** Lit ids: hovered, the editor's litId. */
  hoverId: string | null;
  litId: string | null;
  draft: { id: string; x: number; y: number; r: number } | null;
  addPreview: { x: number; y: number; r: number } | null;
  coarse: boolean;
  /** The grip only means something in move mode. */
  mode: CanvasMode;
}

function AnnotationLayer({ page, circles, view, size, selectedId, hoverId, litId, draft, addPreview, coarse, mode }: AnnotationLayerProps) {
  // Bigger circles first, so a small one inside a big one is drawn on top
  // (and is what a tap picks — see hitTest).
  const ordered = useMemo(() => {
    const list = draft ? circles.map((c) => (c.id === draft.id ? { ...c, x: draft.x, y: draft.y, r: draft.r } : c)) : circles;
    return [...list].sort((a, b) => b.r - a.r);
  }, [circles, draft]);

  const selected = selectedId ? ordered.find((c) => c.id === selectedId) : undefined;
  const ls = longSide(page);

  // The same element list every frame while only the view moves, so React
  // skips the whole subtree; and while one circle is dragged, every other
  // circle keeps its element (cached by row identity) — O(1) work per frame.
  const cacheRef = useRef({ dims: "", map: new Map<string, MarkEntry>() });
  const marks = useMemo(() => {
    const dims = `${page.width}x${page.height}`;
    const prev = cacheRef.current.dims === dims ? cacheRef.current.map : new Map<string, MarkEntry>();
    const next = new Map<string, MarkEntry>();
    const els = ordered.map((c) => {
      const lit = c.id === selectedId || c.id === hoverId || c.id === litId;
      const sel = c.id === selectedId;
      const hit = prev.get(c.id);
      const entry =
        hit && hit.c === c && hit.lit === lit && hit.sel === sel
          ? hit
          : {
              c,
              lit,
              sel,
              el: <CircleMark key={c.id} cx={c.x * page.width} cy={c.y * page.height} r={c.r * ls} color={c.color} num={c.num} lit={lit} selected={sel} />,
            };
      next.set(c.id, entry);
      return entry.el;
    });
    cacheRef.current = { dims, map: next };
    return els;
  }, [ordered, page.width, page.height, ls, selectedId, hoverId, litId]);

  const worldRef = useRef<SVGGElement>(null);
  const ringMin = coarse ? HANDLE_RING_MIN.coarse : HANDLE_RING_MIN.fine;
  useLayoutEffect(() => {
    if (worldRef.current) sizeMarks(worldRef.current, ordered, page, view.scale, selectedId, ringMin);
  }, [ordered, page, view.scale, selectedId, ringMin]);

  return (
    <svg className="bp-annos" width={size.w} height={size.h} aria-hidden="true">
      <g ref={worldRef} transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
        {marks}
      </g>
      {selected && <SelectionMarks c={selected} page={page} view={view} coarse={coarse} grip={mode === "move"} />}
      {addPreview && <AddPreview p={addPreview} />}
    </svg>
  );
}

/**
 * Dashed outer ring, four resize handles and the move grip, in screen px.
 * On a small circle the handles move out past the rim, leaving the middle
 * to the grip; a short stalk ties each to the ring, which keeps hugging the
 * circle so its real size still shows.
 */
function SelectionMarks({ c, page, view, coarse, grip }: { c: CircleRow; page: PageRow; view: View; coarse: boolean; grip: boolean }) {
  const w = circleWorld(c, page);
  const centre = worldToScreen(view, { x: w.cx, y: w.cy });
  const R = drawRadius(w.r, view.scale);
  const ring = handleRing(R, coarse);
  const stalk = ring - HANDLE_DOT_R > R + 7;
  // ink, whatever the circle's colour (canvas.css): a dashed ring, white square handles, a black grip
  return (
    <g className="bp-selection">
      <circle className="bp-sel-ring" cx={centre.x} cy={centre.y} r={R + 7} />
      {HANDLE_DIRS.map((dir) => {
        const h = handlePoint(centre, ring, dir);
        const s = stalk ? handlePoint(centre, R + 7, dir) : null;
        return (
          <g key={dir} className={`bp-handle bp-handle-${dir}`}>
            {s && <line className="bp-handle-stalk" x1={s.x} y1={s.y} x2={h.x} y2={h.y} />}
            <circle className="bp-handle-hit" cx={h.x} cy={h.y} r={coarse ? HANDLE_HIT_R.touch : HANDLE_HIT_R.mouse} />
            <rect className="bp-handle-dot" x={h.x - HANDLE_DOT_R} y={h.y - HANDLE_DOT_R} width={HANDLE_DOT_R * 2} height={HANDLE_DOT_R * 2} />
          </g>
        );
      })}
      {grip && (
        <g className="bp-grip" transform={`translate(${centre.x} ${centre.y})`}>
          <circle className="bp-grip-hit" r={coarse ? GRIP_HIT_R.touch : GRIP_HIT_R.mouse} />
          <rect className="bp-grip-chip" x={-GRIP_HALF} y={-GRIP_HALF} width={GRIP_HALF * 2} height={GRIP_HALF * 2} />
          <path className="bp-grip-glyph" d={GRIP_GLYPH} />
        </g>
      )}
    </g>
  );
}

function AddPreview({ p }: { p: { x: number; y: number; r: number } }) {
  const pal = palette(DEFAULT_CIRCLE_COLOR);
  return (
    <g className="bp-add-preview">
      <circle cx={p.x} cy={p.y} r={Math.max(p.r, 1)} fill={pal.fill} stroke={pal.stroke} />
      <circle className="bp-add-centre" cx={p.x} cy={p.y} r={2.5} fill={pal.stroke} />
    </g>
  );
}

export default memo(AnnotationLayer);
