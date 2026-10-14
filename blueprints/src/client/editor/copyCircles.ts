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
// whole group steps down and to the right until it's clear.

import type { CircleRow, CommentRow, PageRow } from "../../shared/types";
import type { CircleCopy, PastedCircle } from "../sync";

/** One step when a copy would cover a circle: this share of the page's long side, down and right. */
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
 * The copies placed on `page`: where they were, or stepped down and right
 * together (keeping their layout) until none sits on a circle in `existing`.
 */
export function placeCopies(items: readonly CircleCopy[], page: Pick<PageRow, "id" | "width" | "height">, existing: readonly CircleRow[]): PastedCircle[] {
  const long = Math.max(page.width, page.height);
  const dx = page.width > 0 && long > 0 ? (NUDGE * long) / page.width : NUDGE;
  const dy = page.height > 0 && long > 0 ? (NUDGE * long) / page.height : NUDGE;
  const covers = (x: number, y: number) => existing.some((c) => Math.abs(c.x - x) < SAME_SPOT && Math.abs(c.y - y) < SAME_SPOT);
  let placed: PastedCircle[] = [];
  for (let k = 0; k <= MAX_NUDGES; k++) {
    placed = items.map((it) => ({ ...it, pageId: page.id, x: clamp01(it.x + k * dx), y: clamp01(it.y + k * dy) }));
    if (!placed.some((p) => covers(p.x, p.y))) break;
  }
  return placed;
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
