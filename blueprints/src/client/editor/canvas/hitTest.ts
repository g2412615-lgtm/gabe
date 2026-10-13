// Hit testing by math (world distances), not by DOM targets: it works the
// same for a captured pointer, under a wheel zoom and for tiny circles whose
// touch target is bigger than what's drawn.

import { circleWorld, worldToScreen, type Pt, type View } from "../../../shared/geometry";
import type { CircleRow, PageRow } from "../../../shared/types";
import type { PointerKind } from "./types";

/** Circles are never drawn smaller than this many screen px in radius. */
export const MIN_DRAW_R = 10;
/** Smallest hit radius (screen px): a fingertip needs more room than a cursor. */
export const MIN_HIT_R = { touch: 22, mouse: 12, pen: 12 } as const;
/** Resize handles: 12 px dots, 44 px targets on touch. */
export const HANDLE_DOT_R = 6;
export const HANDLE_HIT_R = { touch: 22, mouse: 11, pen: 14 } as const;

export type HandleDir = "n" | "e" | "s" | "w";
export const HANDLE_DIRS: readonly HandleDir[] = ["n", "e", "s", "w"];

export type Hit =
  | { kind: "handle"; id: string; dir: HandleDir }
  | { kind: "circle"; id: string; selected: boolean }
  /** Empty paper, or the dark canvas around the page (`onPage` false). */
  | { kind: "paper"; onPage: boolean };

type CircleGeom = Pick<CircleRow, "id" | "x" | "y" | "r">;
type PageDims = Pick<PageRow, "width" | "height">;

/** Drawn radius in screen px. */
export function drawRadius(rWorld: number, scale: number): number {
  return Math.max(rWorld * scale, MIN_DRAW_R);
}

/** Screen positions of the four resize handles around a circle drawn at `c` with screen radius `R`. */
export function handlePoint(c: Pt, R: number, dir: HandleDir): Pt {
  switch (dir) {
    case "n":
      return { x: c.x, y: c.y - R };
    case "e":
      return { x: c.x + R, y: c.y };
    case "s":
      return { x: c.x, y: c.y + R };
    case "w":
      return { x: c.x - R, y: c.y };
  }
}

export function isOnPage(view: View, page: PageDims, pt: Pt): boolean {
  const x = (pt.x - view.tx) / view.scale;
  const y = (pt.y - view.ty) / view.scale;
  return x >= 0 && y >= 0 && x <= page.width && y <= page.height;
}

export interface HitContext {
  view: View;
  page: PageDims;
  circles: readonly CircleGeom[];
  selectedId: string | null;
  pointerType: PointerKind;
}

/**
 * What's under screen point `pt`: the selected circle's handles first, then
 * the smallest circle containing the point (so a small circle inside a big
 * one stays reachable), else paper.
 */
export function hitTest(pt: Pt, ctx: HitContext): Hit {
  const { view, page, circles, selectedId, pointerType } = ctx;

  if (selectedId) {
    const sel = circles.find((c) => c.id === selectedId);
    if (sel) {
      const w = circleWorld(sel, page);
      const c = worldToScreen(view, { x: w.cx, y: w.cy });
      const R = drawRadius(w.r, view.scale);
      const reach = HANDLE_HIT_R[pointerType];
      const toCentre = Math.hypot(pt.x - c.x, pt.y - c.y);
      let best: HandleDir | null = null;
      let bestD = Infinity;
      for (const dir of HANDLE_DIRS) {
        const h = handlePoint(c, R, dir);
        const d = Math.hypot(pt.x - h.x, pt.y - h.y);
        // On a small circle the handle targets overlap its body: whichever
        // is nearer wins, so the middle still moves it and the rim resizes.
        if (d <= reach && d < bestD && d < toCentre) {
          best = dir;
          bestD = d;
        }
      }
      if (best) return { kind: "handle", id: sel.id, dir: best };
    }
  }

  const minHit = MIN_HIT_R[pointerType];
  let hitId: string | null = null;
  let hitR = Infinity;
  for (const c of circles) {
    const w = circleWorld(c, page);
    const sx = w.cx * view.scale + view.tx;
    const sy = w.cy * view.scale + view.ty;
    const R = Math.max(w.r * view.scale, MIN_DRAW_R, minHit);
    const dx = pt.x - sx;
    const dy = pt.y - sy;
    if (dx > R || dx < -R || dy > R || dy < -R) continue;
    // `<=`: of equal sizes the later one (drawn on top) wins
    if (dx * dx + dy * dy <= R * R && w.r <= hitR) {
      hitId = c.id;
      hitR = w.r;
    }
  }
  if (hitId) return { kind: "circle", id: hitId, selected: hitId === selectedId };
  return { kind: "paper", onPage: isOnPage(view, page, pt) };
}
