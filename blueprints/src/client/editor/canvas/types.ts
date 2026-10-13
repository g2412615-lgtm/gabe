// Public types of the blueprint canvas (SPEC §7.5). BlueprintCanvas.tsx
// re-exports them, so the editor imports everything from one place.

import type { View } from "../../../shared/geometry";
import type { CircleRow, PageRow } from "../../../shared/types";

export type CanvasMode = "move" | "add";

/** What a finger, mouse or Apple Pencil is (PointerEvent.pointerType, normalized). */
export type PointerKind = "mouse" | "pen" | "touch";

export interface CanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  /** Pan/zoom so the circle is centred and comfortably sized. */
  focusCircle(id: string): void;
  getView(): View;
}

/**
 * A move or resize of one circle. `start` carries the circle's values before
 * the gesture, `update`/`end` the new ones (x,y for a move, r for a resize),
 * `cancel` none (the editor restores the pre-gesture state).
 */
export interface CanvasGestureEvent {
  phase: "start" | "update" | "end" | "cancel";
  id: string;
  kind: "move" | "resize";
  x?: number;
  y?: number;
  r?: number;
}

export interface BlueprintCanvasProps {
  /** Status is "preview" or "ready" (the editor shows placeholders otherwise). */
  page: PageRow;
  /** Live circles on this page. */
  circles: CircleRow[];
  selectedId: string | null;
  /** Circle the editor wants lit (e.g. hovered in the notes list). */
  litId: string | null;
  mode: CanvasMode;
  /** Restore the last view of this page (else fit). */
  initialView?: View | null;
  /** Throttled (≤ 4/s) and on gesture end. */
  onViewChange?(v: View): void;
  /** Circle under a hovering mouse/pencil (never touch). */
  onHover(id: string | null, pointerType: "mouse" | "pen"): void;
  /** Tap/click on a circle (id) or on empty paper (null). */
  onSelect(id: string | null, how: "tap" | "click"): void;
  /** A new circle, normalized like CircleRow; the editor creates it. */
  onAdd(c: { x: number; y: number; r: number }): void;
  onGesture(e: CanvasGestureEvent): void;
  /** Cancel button in the add-mode hint (the editor owns the mode). */
  onCancelAdd?(): void;
  /** Px covered by floating UI (the right panel): fit/focus keep content clear of it. */
  topInset?: number;
  rightInset?: number;
}
