// The comments panel's decisions that don't need React (unit-tested):
// when the panel holds still instead of following the pointer, and whether
// a circle sits under the panel where the owner can't see it.

import { circleWorld, type View } from "../../shared/geometry";
import type { CircleRow, PageRow } from "../../shared/types";

/** What can make the panel hold still while the pointer wanders over other circles. */
export interface PanelHold {
  /** The mouse or pencil is over the panel. */
  pointerInPanel: boolean;
  /** A comment is open in the inline editor. */
  editing: boolean;
  /** A focused text field in the panel (the circle's name, the composer) holds typing. */
  typing: boolean;
}

/**
 * Busy: hovering another circle doesn't switch the panel, because that would
 * take away typing in progress. Focus alone doesn't count — the composer
 * takes focus by itself after a circle or comment is added with a mouse, and
 * hover must keep working then.
 */
export const panelBusy = (h: PanelHold): boolean => h.pointerInPanel || h.editing || h.typing;

/** A text field holds typing that switching away would disrupt: it has focus and isn't blank. */
export const holdsTyping = (focused: boolean, text: string): boolean => focused && text.trim() !== "";

/** Circles under this many screen px across are drawn at it (the canvas's minimum). */
const MIN_DRAWN_R = 5;

/**
 * Is any part of the circle, as drawn, under the floating panel? `size` is
 * the stage's; `cover` is what the panel takes at the right (desktop, iPad)
 * and at the bottom (the phone's sheet). A circle off screen isn't "under" it.
 */
export function underCover(
  c: Pick<CircleRow, "x" | "y" | "r">,
  page: Pick<PageRow, "width" | "height">,
  view: View,
  size: { w: number; h: number },
  cover: { right: number; bottom: number },
): boolean {
  const { cx, cy, r } = circleWorld(c, page);
  const R = Math.max(r * view.scale, MIN_DRAWN_R);
  const sx = cx * view.scale + view.tx;
  const sy = cy * view.scale + view.ty;
  if (sx + R < 0 || sx - R > size.w || sy + R < 0 || sy - R > size.h) return false;
  return (cover.right > 0 && sx + R > size.w - cover.right) || (cover.bottom > 0 && sy + R > size.h - cover.bottom);
}
