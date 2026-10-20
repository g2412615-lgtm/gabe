// Pure view math for the canvas: limits, fit with floating-UI insets,
// fly-to targets, animation interpolation and the deep-zoom tile grid.
// World units are the page's full-resolution raster pixels (see geometry.ts).

import { circleWorld, clamp, fitView, levelSize, pickLevel, screenToWorld, type Pt, type View } from "../../../shared/geometry";
import type { CircleRow, PageRow } from "../../../shared/types";
import { HANDLE_DOT_R, drawRadius, handleRing } from "./hitTest";

export interface Size {
  w: number;
  h: number;
}

/** Px of the stage covered by floating UI (the right panel, the phone's bottom sheet). */
export interface Insets {
  top: number;
  right: number;
  bottom?: number;
}

type PageDims = Pick<PageRow, "width" | "height">;

/** Zoom range, relative to "whole page fits" so the blueprint can't be lost off-screen or zoomed to a speck. */
export function scaleLimits(page: PageDims, size: Size): { min: number; max: number; fit: number } {
  const fit = fitView(page, Math.max(1, size.w), Math.max(1, size.h)).scale;
  return { min: fit * 0.5, max: Math.max(fit * 12, 3), fit };
}

/**
 * Where Fit puts the page: the area not covered by floating UI. An inset
 * that would leave less than 40% of the width or height is ignored (the
 * phone's bottom sheet covers 60%: squeezing the whole page into the sliver
 * above it helps no one).
 */
export function usableArea(size: Size, insets: Insets) {
  const right = size.w - insets.right < size.w * 0.4 ? 0 : Math.max(0, insets.right);
  const { top, bottom } = verticalInsets(size.h, insets, size.h * 0.4);
  return { x: 0, y: top, w: Math.max(1, size.w - right), h: Math.max(1, size.h - top - bottom) };
}

/**
 * The top and bottom insets, keeping at least `min` px between them. When
 * both can't stay, the top one (the small "circles hidden" chip) gives way
 * before the bottom one (the phone's comment sheet, far bigger); when even
 * the sheet alone leaves too little, it's ignored and the top one stays if
 * it fits.
 */
function verticalInsets(h: number, insets: Insets, min: number) {
  const top = Math.max(0, insets.top);
  const bottom = Math.max(0, insets.bottom ?? 0);
  if (h - top - bottom >= min) return { top, bottom };
  if (h - bottom >= min) return { top: 0, bottom };
  return { top: h - top >= min ? top : 0, bottom: 0 };
}

/** Below this many px an inset is ignored even for focus/reveal: the stage is too small for it to mean anything. */
const MIN_VISIBLE = 80;

/**
 * The part of the stage the owner can actually see, for putting one circle
 * in view (focus, reveal, the zoom buttons' centre): every inset counts, so
 * on a phone the circle lands above the bottom sheet, not under it.
 */
export function visibleArea(size: Size, insets: Insets) {
  const w = Math.max(1, size.w);
  const h = Math.max(1, size.h);
  const right = w - insets.right >= MIN_VISIBLE ? Math.max(0, insets.right) : 0;
  const { top, bottom } = verticalInsets(h, insets, MIN_VISIBLE);
  return { x: 0, y: top, w: Math.max(1, w - right), h: Math.max(1, h - top - bottom) };
}

/** Whole page centred in the uncovered area. */
export function fitInsets(page: PageDims, size: Size, insets: Insets): View {
  const a = usableArea(size, insets);
  const v = fitView(page, a.w, a.h);
  return { scale: v.scale, tx: v.tx + a.x, ty: v.ty + a.y };
}

/** Centre of the visible area (zoom buttons zoom around it). */
export function usableCentre(size: Size, insets: Insets): Pt {
  const a = visibleArea(size, insets);
  return { x: a.x + a.w / 2, y: a.y + a.h / 2 };
}

/**
 * Fly-to target for a circle: centred in the uncovered area, its diameter
 * about 35% of the area's shorter side — but never zooming out more than 2×
 * from where the owner is, and always inside the zoom limits.
 */
export function focusView(
  page: PageDims,
  c: Pick<CircleRow, "x" | "y" | "r">,
  size: Size,
  insets: Insets,
  current: View,
  limits: { min: number; max: number },
): View {
  const { cx, cy, r } = circleWorld(c, page);
  const a = visibleArea(size, insets);
  let scale = (0.35 * Math.min(a.w, a.h)) / Math.max(2 * r, 1e-6);
  scale = Math.max(scale, current.scale / 2);
  scale = clamp(scale, limits.min, limits.max);
  return { scale, tx: a.x + a.w / 2 - cx * scale, ty: a.y + a.h / 2 - cy * scale };
}

/** Breathing room kept around a revealed circle's selection (screen px). */
export const REVEAL_MARGIN = 24;
/** How far the selected circle's number badge rides above its handle ring: lift 22 + half its 18 px height. */
const BADGE_ABOVE_RING = 31;

/**
 * The selected circle's drawn extent around its centre (screen px) at
 * `scale`: rim + dashed ring, handles and, above, the number badge.
 */
function selectionExtent(rWorld: number, scale: number, coarse: boolean) {
  const R = drawRadius(rWorld, scale);
  const ring = handleRing(R, coarse);
  const side = Math.max(R + 7, ring + HANDLE_DOT_R);
  return { side, top: Math.max(side, ring + BADGE_ABOVE_RING) };
}

/**
 * Bring a circle out from under the floating UI: the smallest pan that puts
 * the circle (with its handles and badge) plus REVEAL_MARGIN inside the
 * visible area. Returns `current` unchanged when it's already in view. Zooms
 * only when it can't fit at the current scale — then out, just enough (never
 * past the limits), and centred.
 */
export function revealView(
  page: PageDims,
  c: Pick<CircleRow, "x" | "y" | "r">,
  size: Size,
  insets: Insets,
  current: View,
  limits: { min: number; max: number },
  coarse: boolean,
): View {
  const { cx, cy, r } = circleWorld(c, page);
  const a = visibleArea(size, insets);
  const M = REVEAL_MARGIN;
  const fits = (s: number) => {
    const e = selectionExtent(r, s, coarse);
    return 2 * (e.side + M) <= a.w + 1e-6 && e.top + e.side + 2 * M <= a.h + 1e-6;
  };

  let scale = current.scale;
  if (!fits(scale)) {
    // Too big at this zoom: a circle that big is drawn at its true size
    // (R = r·s, ring = R), so the extents are linear in s.
    const byW = (a.w / 2 - 7 - M) / Math.max(r, 1e-9);
    const byH = (a.h - 7 - BADGE_ABOVE_RING - 2 * M) / Math.max(2 * r, 1e-9);
    scale = clamp(Math.min(byW, byH, scale), limits.min, scale);
    const e = selectionExtent(r, scale, coarse);
    // centred: the box's middle (the badge makes the top taller) in the area's middle
    return {
      scale,
      tx: a.x + a.w / 2 - cx * scale,
      ty: a.y + a.h / 2 - cy * scale + (e.top - e.side) / 2,
    };
  }

  const e = selectionExtent(r, scale, coarse);
  const sx = cx * scale + current.tx;
  const sy = cy * scale + current.ty;
  const left = sx - e.side - M;
  const right = sx + e.side + M;
  const top = sy - e.top - M;
  const bottom = sy + e.side + M;
  let dx = 0;
  let dy = 0;
  if (left < a.x) dx = a.x - left;
  else if (right > a.x + a.w) dx = a.x + a.w - right;
  if (top < a.y) dy = a.y - top;
  else if (bottom > a.y + a.h) dy = a.y + a.h - bottom;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return current;
  return { scale, tx: current.tx + dx, ty: current.ty + dy };
}

/**
 * Is a remembered view still a sensible place to land? (The window may have
 * changed size since.) It must be inside the zoom limits and show a decent
 * piece of the page.
 */
export function isSensibleView(v: View | null | undefined, page: PageDims, size: Size): v is View {
  if (!v || !Number.isFinite(v.scale) || !Number.isFinite(v.tx) || !Number.isFinite(v.ty) || v.scale <= 0) return false;
  const { min, max } = scaleLimits(page, size);
  if (v.scale < min * 0.999 || v.scale > max * 1.001) return false;
  const left = Math.max(0, v.tx);
  const right = Math.min(size.w, v.tx + page.width * v.scale);
  const top = Math.max(0, v.ty);
  const bottom = Math.min(size.h, v.ty + page.height * v.scale);
  return right - left >= Math.min(80, size.w * 0.2) && bottom - top >= Math.min(80, size.h * 0.2);
}

export function sameView(a: View | null | undefined, b: View | null | undefined, eps = 0.25): boolean {
  if (!a || !b) return false;
  return Math.abs(a.scale - b.scale) <= a.scale * 1e-6 && Math.abs(a.tx - b.tx) <= eps && Math.abs(a.ty - b.ty) <= eps;
}

/**
 * The view a fraction `t` (0..1) of the way from `a` to `b`. Any pan+zoom
 * between two views is a zoom about one fixed screen point (when the scales
 * differ); interpolating the zoom geometrically about that point keeps the
 * zoom speed even and a pure zoom (double-tap, buttons) perfectly anchored —
 * no sideways swing. Equal scales are a plain pan.
 */
export function interpolateView(a: View, b: View, t: number): View {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ratio = b.scale / a.scale;
  if (Math.abs(ratio - 1) < 1e-9) {
    return { scale: a.scale, tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t };
  }
  // fixed point F: a.tx + a.s·w = b.tx + b.s·w = F  →  w = (a.tx − b.tx)/(b.s − a.s)
  const fx = a.tx + (a.scale * (a.tx - b.tx)) / (b.scale - a.scale);
  const fy = a.ty + (a.scale * (a.ty - b.ty)) / (b.scale - a.scale);
  const k = Math.pow(ratio, t);
  return { scale: a.scale * k, tx: fx - k * (fx - a.tx), ty: fy - k * (fy - a.ty) };
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Zoom factor for one wheel event (DeployMap's numbers: pinch-to-zoom on a trackpad arrives as ctrl+wheel and goes faster). */
export function wheelFactor(e: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey" | "metaKey">, pageHeight: number): number {
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 16; // lines
  else if (e.deltaMode === 2) delta *= Math.max(1, pageHeight); // pages
  const speed = e.ctrlKey || e.metaKey ? 0.01 : 0.0022;
  return clamp(Math.exp(-delta * speed), 0.5, 2);
}

// ── deep-zoom tiles ──────────────────────────────────────────────────────

export interface TileBox {
  key: string;
  level: number;
  col: number;
  row: number;
  /** Tile box in world px (edge tiles are smaller). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Hard cap so a bad level choice can never mount thousands of images. */
const MAX_TILES = 600;

/**
 * Tiles of `level` that intersect the viewport, plus `margin` tiles around it
 * (so a short pan finds them already loaded), nearest the viewport centre
 * first (the browser fetches roughly in DOM order).
 */
export function visibleTiles(
  page: Pick<PageRow, "width" | "height" | "maxLevel" | "tileSize">,
  view: View,
  size: Size,
  level: number,
  margin = 1,
): TileBox[] {
  const ts = page.tileSize > 0 ? page.tileSize : 512;
  const { w: lw, h: lh, f } = levelSize(page as PageRow, level);
  const cols = Math.ceil(lw / ts);
  const rows = Math.ceil(lh / ts);
  const span = ts * f; // world px per full tile
  const tl = screenToWorld(view, { x: 0, y: 0 });
  const br = screenToWorld(view, { x: size.w, y: size.h });
  const c0 = Math.max(0, Math.floor(tl.x / span) - margin);
  const c1 = Math.min(cols - 1, Math.floor(br.x / span) + margin);
  const r0 = Math.max(0, Math.floor(tl.y / span) - margin);
  const r1 = Math.min(rows - 1, Math.floor(br.y / span) + margin);
  if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > MAX_TILES) return [];
  const mid = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
  const out: (TileBox & { d: number })[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const x = col * span;
      const y = row * span;
      const w = Math.min(ts, lw - col * ts) * f;
      const h = Math.min(ts, lh - row * ts) * f;
      const d = Math.hypot(x + w / 2 - mid.x, y + h / 2 - mid.y);
      out.push({ key: `${level}/${col}_${row}`, level, col, row, x, y, w, h, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.map(({ d: _d, ...t }) => t);
}

// ── which tiles to mount ─────────────────────────────────────────────────

export interface TilePlan {
  /** The level shown (null: the preview alone is sharp enough). */
  target: number | null;
  /** Tiles of `target` to mount. */
  tiles: TileBox[];
  /** Every tile of `target` in view has loaded (it can be the fallback for the next level change). */
  complete: boolean;
}

/**
 * Which deep-zoom tiles to mount for this frame.
 *
 * While the zoom is moving (a pinch, a wheel burst, an animation —
 * `settled` false) nothing new is fetched: the level `held` from the last
 * settled frame keeps the tiles it already has on screen, and the preview
 * fills the rest. A pinch from Fit to 1000% would otherwise fetch every
 * level it passes through (and, zooming out, more and more tiles of a level
 * that's about to be dropped), leaving the final tiles queued behind
 * abandoned ones. Once the zoom settles, the level follows it again.
 */
export function planTiles(
  page: PageRow,
  view: View,
  size: Size,
  dpr: number,
  settled: boolean,
  /** The level from the last settled frame (undefined: none yet, e.g. a new page). */
  held: number | null | undefined,
  /** true loaded, false failed (finished all the same), undefined not yet. */
  status: (t: TileBox) => boolean | undefined,
): TilePlan {
  if (size.w <= 0 || size.h <= 0) return { target: null, tiles: [], complete: true };
  if (!settled && held !== undefined) {
    if (held === null) return { target: null, tiles: [], complete: true };
    return { target: held, tiles: visibleTiles(page, view, size, held, 0).filter((t) => status(t) === true), complete: false };
  }
  const target = pickLevel(page, view.scale, dpr);
  if (target === null) return { target, tiles: [], complete: true };
  const tiles = visibleTiles(page, view, size, target);
  return { target, tiles, complete: tiles.every((t) => status(t) !== undefined) };
}
