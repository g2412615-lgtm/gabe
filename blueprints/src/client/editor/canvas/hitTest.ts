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
/** The move grip at the selected circle's centre: a 26 px chip, 44 px target on touch. */
export const GRIP_R = 13;
export const GRIP_HIT_R = { touch: 22, mouse: 16, pen: 16 } as const;
/**
 * Handles never sit closer to the centre than this (screen px). On a small
 * circle they move out past the rim, so the grip's target and the four
 * handle targets never overlap (22 + 22 on a touch screen) and a finger on
 * the middle moves the circle instead of resizing it.
 */
export const HANDLE_RING_MIN = { coarse: 46, fine: 30 } as const;
/**
 * Dragging the selected circle's body (rather than its grip) moves it only
 * while it's drawn at most this big. A bigger one pans like paper: it can
 * cover the whole screen, and the owner must always be able to pan.
 */
export const BODY_MOVE_MAX_R = 90;
/** A press this close to a drawn dot or chip is on it, not on its padding (screen px). */
const EXACT_SLACK = 4;

export type HandleDir = "n" | "e" | "s" | "w";
export const HANDLE_DIRS: readonly HandleDir[] = ["n", "e", "s", "w"];

export type Hit =
  | { kind: "handle"; id: string; dir: HandleDir }
  /** The selected circle's move grip. */
  | { kind: "grip"; id: string }
  /** `grab`: a drag here moves the circle (the selected one, while small on screen); otherwise a drag pans. */
  | { kind: "circle"; id: string; selected: boolean; grab: boolean }
  /** Empty paper, or the dark canvas around the page (`onPage` false). */
  | { kind: "paper"; onPage: boolean };

type CircleGeom = Pick<CircleRow, "id" | "x" | "y" | "r">;
type PageDims = Pick<PageRow, "width" | "height">;

/** Drawn radius in screen px. */
export function drawRadius(rWorld: number, scale: number): number {
  return Math.max(rWorld * scale, MIN_DRAW_R);
}

/** Distance from the centre to the resize handles (screen px), for a circle drawn at screen radius `R`. */
export function handleRing(R: number, coarse: boolean): number {
  return Math.max(R, coarse ? HANDLE_RING_MIN.coarse : HANDLE_RING_MIN.fine);
}

/** Screen positions of the four resize handles around centre `c`, `R` px out. */
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
  /**
   * The screen's main pointer is a finger (`(pointer: coarse)`): handles sit
   * further out. Must match what AnnotationLayer draws. Default false.
   */
  coarse?: boolean;
}

/**
 * What's under screen point `pt`: the selected circle's grip and handles
 * first, then the smallest circle containing the point (so a small circle
 * inside a big one stays reachable), else paper.
 */
export function hitTest(pt: Pt, ctx: HitContext): Hit {
  const { view, page, circles, selectedId, pointerType } = ctx;

  const sel = selectedId ? circles.find((c) => c.id === selectedId) : undefined;
  let selR = 0;
  if (sel) {
    const w = circleWorld(sel, page);
    const c = worldToScreen(view, { x: w.cx, y: w.cy });
    selR = drawRadius(w.r, view.scale);
    const ring = handleRing(selR, ctx.coarse ?? false);
    // Grip and handles: whichever is nearest wins (they only overlap with a
    // touch on a fine-pointer screen, whose ring is tighter).
    let best: Hit | null = null;
    let bestD = Infinity;
    let exact = false;
    const toCentre = Math.hypot(pt.x - c.x, pt.y - c.y);
    if (toCentre <= GRIP_HIT_R[pointerType]) {
      best = { kind: "grip", id: sel.id };
      bestD = toCentre;
      exact = toCentre <= GRIP_R + EXACT_SLACK;
    }
    for (const dir of HANDLE_DIRS) {
      const h = handlePoint(c, ring, dir);
      const d = Math.hypot(pt.x - h.x, pt.y - h.y);
      if (d <= HANDLE_HIT_R[pointerType] && d < bestD) {
        best = { kind: "handle", id: sel.id, dir };
        bestD = d;
        exact = d <= HANDLE_DOT_R + EXACT_SLACK;
      }
    }
    if (best) {
      // The padding around a dot or the grip mustn't steal a press from
      // another circle that's really drawn there — except one the selected
      // circle sits inside (a zone around it), or its handles would be
      // nearly impossible to grab.
      const other = exact ? null : drawnCircleAt(pt, ctx, sel, c, w.r);
      return other ? { kind: "circle", id: other, selected: false, grab: false } : best;
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
  if (hitId) {
    const selected = hitId === selectedId;
    return { kind: "circle", id: hitId, selected, grab: selected && selR <= BODY_MOVE_MAX_R };
  }
  return { kind: "paper", onPage: isOnPage(view, page, pt) };
}

/**
 * The smallest other circle whose drawn body (not its padded touch target)
 * contains `pt`, ignoring circles at least as big as the selected one that
 * contain its centre.
 */
function drawnCircleAt(pt: Pt, ctx: HitContext, sel: CircleGeom, selCentre: Pt, selRWorld: number): string | null {
  const { view, page, circles } = ctx;
  let id: string | null = null;
  let best = Infinity;
  for (const c of circles) {
    if (c.id === sel.id) continue;
    const w = circleWorld(c, page);
    const s = worldToScreen(view, { x: w.cx, y: w.cy });
    const R = drawRadius(w.r, view.scale);
    if (Math.hypot(pt.x - s.x, pt.y - s.y) > R) continue;
    if (w.r >= selRWorld && Math.hypot(selCentre.x - s.x, selCentre.y - s.y) <= R) continue;
    if (w.r <= best) {
      id = c.id;
      best = w.r;
    }
  }
  return id;
}
