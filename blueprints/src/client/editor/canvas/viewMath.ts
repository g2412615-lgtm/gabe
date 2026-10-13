// Pure view math for the canvas: limits, fit with floating-UI insets,
// fly-to targets, animation interpolation and the deep-zoom tile grid.
// World units are the page's full-resolution raster pixels (see geometry.ts).

import { circleWorld, clamp, fitView, levelSize, screenToWorld, type Pt, type View } from "../../../shared/geometry";
import type { CircleRow, PageRow } from "../../../shared/types";

export interface Size {
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
}

type PageDims = Pick<PageRow, "width" | "height">;

/** Zoom range, relative to "whole page fits" so the blueprint can't be lost off-screen or zoomed to a speck. */
export function scaleLimits(page: PageDims, size: Size): { min: number; max: number; fit: number } {
  const fit = fitView(page, Math.max(1, size.w), Math.max(1, size.h)).scale;
  return { min: fit * 0.5, max: Math.max(fit * 12, 3), fit };
}

/**
 * The area not covered by floating UI. A right inset that would leave less
 * than 40% of the width is ignored (on a narrow screen the panel is a sheet
 * over the content anyway, and squeezing the page into a sliver helps no one).
 */
export function usableArea(size: Size, insets: Insets) {
  const right = size.w - insets.right < size.w * 0.4 ? 0 : Math.max(0, insets.right);
  const top = size.h - insets.top < size.h * 0.4 ? 0 : Math.max(0, insets.top);
  return { x: 0, y: top, w: Math.max(1, size.w - right), h: Math.max(1, size.h - top) };
}

/** Whole page centred in the uncovered area. */
export function fitInsets(page: PageDims, size: Size, insets: Insets): View {
  const a = usableArea(size, insets);
  const v = fitView(page, a.w, a.h);
  return { scale: v.scale, tx: v.tx + a.x, ty: v.ty + a.y };
}

/** Centre of the uncovered area (zoom buttons zoom around it). */
export function usableCentre(size: Size, insets: Insets): Pt {
  const a = usableArea(size, insets);
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
  const a = usableArea(size, insets);
  let scale = (0.35 * Math.min(a.w, a.h)) / Math.max(2 * r, 1e-6);
  scale = Math.max(scale, current.scale / 2);
  scale = clamp(scale, limits.min, limits.max);
  return { scale, tx: a.x + a.w / 2 - cx * scale, ty: a.y + a.h / 2 - cy * scale };
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
