import type { CircleRow, PageRow } from "./types";

/** Screen pixels per world pixel, plus the world→screen translation. World = the page's full-res raster pixels. */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);

export function longSide(page: Pick<PageRow, "width" | "height">): number {
  return Math.max(1, page.width, page.height);
}

/** A circle's centre and radius in world pixels. */
export function circleWorld(c: Pick<CircleRow, "x" | "y" | "r">, page: Pick<PageRow, "width" | "height">) {
  return { cx: c.x * page.width, cy: c.y * page.height, r: c.r * longSide(page) };
}

export function screenToWorld(v: View, p: Pt): Pt {
  return { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
}

export function worldToScreen(v: View, p: Pt): Pt {
  return { x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty };
}

/** Zoom by `factor` keeping the screen point `at` fixed (deploymap's zoomAt). */
export function zoomAt(v: View, at: Pt, factor: number, minScale: number, maxScale: number): View {
  const scale = clamp(v.scale * factor, minScale, maxScale);
  const k = scale / v.scale;
  return { scale, tx: at.x - k * (at.x - v.tx), ty: at.y - k * (at.y - v.ty) };
}

/** The view that shows the whole page centred in a w×h box with a 4% margin. */
export function fitView(page: Pick<PageRow, "width" | "height">, w: number, h: number): View {
  const scale = Math.min(w / Math.max(1, page.width), h / Math.max(1, page.height)) * 0.96;
  return { scale, tx: (w - page.width * scale) / 2, ty: (h - page.height * scale) / 2 };
}

/**
 * The deep-zoom level whose resolution best matches the screen: the lowest
 * level that still has at least one tile pixel per device pixel. Returns
 * null when the preview image alone is sharp enough.
 */
export function pickLevel(page: PageRow, scale: number, dpr: number): number | null {
  if (!page.maxLevel || page.status !== "ready") return null;
  const need = scale * dpr; // tile pixels per world pixel we want, relative to full res (1 = full res)
  const previewRes = page.previewW / Math.max(1, page.width);
  if (need <= previewRes * 1.05) return null;
  // level L has resolution 2^(L - maxLevel) relative to full res
  const L = page.maxLevel + Math.ceil(Math.log2(Math.max(need, 1e-6)) - 1e-9);
  return clamp(L, page.minLevel, page.maxLevel);
}

/** Size of the deep-zoom level `level` in pixels. */
export function levelSize(page: PageRow, level: number) {
  const f = 2 ** (page.maxLevel - level);
  return { w: Math.ceil(page.width / f), h: Math.ceil(page.height / f), f };
}
