// Copying circles to another page of the same event plan (the Copy circles
// dialog, and ⌘C / ⌘V on a selected circle).
//
// A copy keeps its circle's spot as a share of the page's width and height
// (the way circles are stored), its size as a share of the page's long side,
// its colour, its name and its comments' text. On another plot of the same
// venue at the same scale the copies line up with the same spots; on a sheet
// laid out differently they land in the same part of the page, ready to be
// dragged into place.
//
// A copy never lands exactly on top of a circle that's already there (a
// paste onto the page it came from, or the same copy pasted twice): the
// whole group steps aside together until it's clear — toward the side of
// the page with more room (down and right, or up and left near those
// edges), then the other way once that room is used up — and never further
// than the page has room for, so the group keeps its layout.

import type { CircleRow, CommentRow, PageRow } from "../../shared/types";
import type { CircleCopy, PastedCircle } from "../sync";

/** One step when a copy would cover a circle: this share of the page's long side, across and down. */
export const NUDGE = 0.02;
const MAX_NUDGES = 25;
/** Two circles closer than this (share of the page) count as on the same spot. */
const SAME_SPOT = 1e-4;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** What a copy of `circle` carries: its comments only when `withComments`, and never a blank one. */
export function copyOf(circle: CircleRow, comments: readonly CommentRow[] | undefined, withComments: boolean): CircleCopy {
  return {
    x: circle.x,
    y: circle.y,
    r: circle.r,
    color: circle.color,
    title: circle.title,
    comments: withComments ? (comments ?? []).map((c) => c.body).filter((b) => b.trim() !== "") : [],
  };
}

/**
 * The shifts to try along one axis for a group at `vs`, nearest first: in
 * steps toward the side with more room, up to that edge, then the other way.
 */
function shiftsAlong(vs: readonly number[], step: number): number[] {
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const sides: [number, number][] = 1 - hi >= lo ? [[1, 1 - hi], [-1, lo]] : [[-1, lo], [1, 1 - hi]];
  const out = [0];
  for (const [dir, room] of sides) {
    if (!(room > 0)) continue;
    for (let k = 1; k <= MAX_NUDGES; k++) {
      out.push(dir * Math.min(k * step, room));
      if (k * step >= room) break;
    }
  }
  return out;
}

/**
 * The copies placed on `page`: where they were, or moved together (keeping
 * their layout) until none sits on a circle in `existing` — or, with no
 * clear spot left (a group filling the page, pasted again and again), where
 * the fewest do.
 */
export function placeCopies(items: readonly CircleCopy[], page: Pick<PageRow, "id" | "width" | "height">, existing: readonly CircleRow[]): PastedCircle[] {
  if (!items.length) return [];
  const long = Math.max(page.width, page.height);
  const dx = page.width > 0 && long > 0 ? (NUDGE * long) / page.width : NUDGE;
  const dy = page.height > 0 && long > 0 ? (NUDGE * long) / page.height : NUDGE;
  const xs = items.map((it) => clamp01(it.x));
  const ys = items.map((it) => clamp01(it.y));
  const sx = shiftsAlong(xs, dx);
  const sy = shiftsAlong(ys, dy);
  const covers = (p: PastedCircle) => existing.some((c) => Math.abs(c.x - p.x) < SAME_SPOT && Math.abs(c.y - p.y) < SAME_SPOT);
  let best: PastedCircle[] = [];
  let bestCovered = Infinity;
  // both axes step together; one that has run out of shifts stays at its last
  for (let k = 0; k < Math.max(sx.length, sy.length); k++) {
    const ox = sx[Math.min(k, sx.length - 1)];
    const oy = sy[Math.min(k, sy.length - 1)];
    const placed = items.map((it, i) => ({ ...it, pageId: page.id, x: clamp01(xs[i] + ox), y: clamp01(ys[i] + oy) }));
    const covered = placed.filter(covers).length;
    if (covered === 0) return placed;
    if (covered < bestCovered) {
      best = placed;
      bestCovered = covered;
    }
  }
  return best;
}

// ── the clipboard (⌘C / ⌘V) ─────────────────────────────────────────────

export interface CircleClip {
  planId: string;
  /** The page the circles were copied from. */
  pageId: string;
  items: CircleCopy[];
}

let clip: CircleClip | null = null;

/** Remember circles for ⌘V. A snapshot: deleting or changing the originals afterwards doesn't change what's pasted. */
export function setCircleClip(c: CircleClip) {
  clip = { ...c, items: c.items.map((it) => ({ ...it, comments: [...it.comments] })) };
}

/** The copied circles, when they came from this plan (circles only paste within their event plan). */
export function circleClipFor(planId: string): CircleClip | null {
  return clip && clip.planId === planId ? clip : null;
}

/** Forget the copied circles (tests). */
export function clearCircleClip() {
  clip = null;
}
