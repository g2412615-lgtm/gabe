// The multi-pointer gesture state machine (report-canvas.md §7.2), free of
// React and the DOM so it can be unit-tested with synthetic pointers.
//
// Rules that make it feel right on an iPad:
//   - every pointer is tracked by id (a second finger lifting never ends the
//     first finger's gesture);
//   - pan and pinch are computed from the view and pointer positions at the
//     START of the gesture (base + total), never by adding up per-event
//     deltas, so nothing drifts;
//   - when a pinch loses a finger the remaining one re-baselines into a pan
//     from where everything is now, so lifting a finger never jumps;
//   - a second finger cancels whatever the first one was doing and no tap
//     fires until every finger is up;
//   - a drag pans unless it starts on something meant to be dragged: the
//     selected circle's grip (moves it), a handle (resizes), or the body of
//     a selected circle small enough that the grip covers most of it anyway.
//     A big selected circle never takes the blueprint away from the owner.

import { DEFAULT_CIRCLE_SCREEN_R, MAX_CIRCLE_R, MIN_CIRCLE_R } from "../../../shared/constants";
import { clamp, clamp01, longSide, screenToWorld, worldToScreen, type Pt, type View } from "../../../shared/geometry";
import type { PageRow } from "../../../shared/types";
import { drawRadius, isOnPage, type HandleDir, type Hit } from "./hitTest";
import type { CanvasGestureEvent, CanvasMode, PointerKind } from "./types";

/** Movement (screen px) below which a press is still a tap. */
export const TAP_SLOP: Record<PointerKind, number> = { touch: 10, mouse: 4, pen: 4 };
/**
 * Handles and the move grip have no tap meaning, so a drag starts almost at
 * once — but not on the jitter of a resting fingertip.
 */
export const HANDLE_SLOP: Record<PointerKind, number> = { touch: 5, mouse: 2, pen: 3 };
export const TAP_MAX_MS = 600;
export const LONG_PRESS_MS = 500;
/** Second tap must land within this long after the first lifted… */
export const DOUBLE_TAP_MS = 400;
/** …and this close to it (screen px). */
export const DOUBLE_TAP_DIST: Record<PointerKind, number> = { touch: 40, mouse: 10, pen: 20 };
/** A drag-to-size shorter than this (screen px) gets the default size instead. */
export const MIN_DRAG_ADD_R = 6;

export interface PointerSample {
  id: number;
  type: PointerKind;
  x: number;
  y: number;
  /** PointerEvent.button (0 left/touch/pen contact, 1 middle, 2 right). */
  button?: number;
  /** PointerEvent.buttons (0 = nothing pressed). */
  buttons?: number;
  isPrimary?: boolean;
}

export interface CircleGeom {
  x: number;
  y: number;
  r: number;
}

export type Activity = "idle" | "press" | "pan" | "pinch" | "move" | "resize" | "add" | "held";

/** Everything the machine needs from the canvas (BlueprintCanvas's controller implements it). */
export interface GestureHost {
  view(): View;
  setView(v: View): void;
  limits(): { min: number; max: number };
  mode(): CanvasMode;
  page(): Pick<PageRow, "width" | "height">;
  hitTest(pt: Pt, type: PointerKind): Hit;
  /** Current normalized geometry of a circle (null if it's gone). */
  circle(id: string): CircleGeom | null;
  /** Animated zoom by `factor` around screen point `at`. */
  zoomBy(at: Pt, factor: number, ms: number): void;

  select(id: string | null, how: "tap" | "click"): void;
  add(c: CircleGeom, at: Pt, via: "tap" | "drag" | "hold"): void;
  gesture(e: CanvasGestureEvent): void;
  /** Live geometry of the circle being moved/resized (drawn without waiting for the editor), or null. */
  draft(d: ({ id: string } & CircleGeom) | null): void;
  /** Add-mode drag preview in screen px, or null. */
  addPreview(p: { x: number; y: number; r: number } | null): void;
  /** The long press fired: show the expanding ring. */
  holdFeedback(at: Pt): void;
  /** The gesture changed (cursor, and "the view settled" when it goes idle). */
  activity(a: Activity, dir?: HandleDir): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Tracked {
  type: PointerKind;
  x: number;
  y: number;
}

type State =
  | { k: "idle" }
  /** Down, not yet a tap or a drag. */
  | { k: "press"; pid: number; type: PointerKind; start: Pt; t0: number; hit: Hit; hold: unknown }
  /** The long press already added a circle; wait for the finger to lift. */
  | { k: "held"; pid: number }
  | { k: "pan"; pid: number; start: Pt; base: View }
  | { k: "pinch"; a: number; b: number; startDist: number; startMid: Pt; base: View }
  /** grab = circle centre − pointer, in world px (so the circle doesn't jump to the finger). */
  | { k: "move"; pid: number; id: string; grab: Pt; cur: CircleGeom }
  /** offset = drawn radius − pointer distance at the start, in screen px. */
  | { k: "resize"; pid: number; id: string; dir: HandleDir; offset: number; cur: CircleGeom }
  | { k: "add"; pid: number; start: Pt; r: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class GestureMachine {
  private pointers = new Map<number, Tracked>();
  private s: State = { k: "idle" };
  /** A second finger landed: no tap until every finger is up. */
  private multi = false;
  private lastTap: { t: number; x: number; y: number; type: PointerKind } | null = null;

  constructor(
    private host: GestureHost,
    private clock: Clock = defaultClock,
  ) {}

  get activity(): Activity {
    return this.s.k;
  }

  /** True while a finger or pencil is down (Safari trackpad gesture events are ignored then). */
  hasTouch(): boolean {
    for (const p of this.pointers.values()) if (p.type !== "mouse") return true;
    return false;
  }

  isDown(pointerId: number): boolean {
    return this.pointers.has(pointerId);
  }

  get pressedCount(): number {
    return this.pointers.size;
  }

  // ── events ────────────────────────────────────────────────────────────

  down(p: PointerSample): void {
    if (p.type !== "mouse" && p.isPrimary) {
      // The first finger (or pencil) of a new touch: any of its kind we still
      // track missed its pointerup (iOS drops one now and then). Forget it,
      // or this one would start a pinch with a ghost. (isPrimary is per
      // type, so a pencil says nothing about fingers and vice versa.)
      for (const [id, t] of this.pointers) if (t.type === p.type) this.forget(id);
      // …and whatever the ghost was part of no longer holds back the next tap
      if (this.contacts().length === 0) this.multi = false;
    }
    this.pointers.set(p.id, { type: p.type, x: p.x, y: p.y });

    const contacts = this.contacts();
    if (p.type !== "mouse" && contacts.length >= 2) {
      this.multi = true;
      if (this.s.k !== "pinch") {
        this.abortSingle();
        this.startPinch(contacts[0], contacts[1]);
      }
      return; // a third finger is ignored
    }
    if (this.s.k !== "idle") return; // e.g. a mouse button while a finger pans

    const pt = { x: p.x, y: p.y };
    if (p.type === "mouse" && (p.button ?? 0) !== 0) {
      // middle or right drag pans, like DeployMap
      this.s = { k: "pan", pid: p.id, start: pt, base: this.host.view() };
      this.host.activity("pan");
      return;
    }

    const hit = this.host.hitTest(pt, p.type);
    let hold: unknown = null;
    // Long press adds wherever a drag would pan (paper, any circle body that doesn't move).
    if (p.type !== "mouse" && this.host.mode() === "move" && (hit.kind === "paper" || (hit.kind === "circle" && !hit.grab))) {
      hold = this.clock.setTimeout(() => this.longPress(p.id), LONG_PRESS_MS);
    }
    this.s = { k: "press", pid: p.id, type: p.type, start: pt, t0: this.clock.now(), hit, hold };
    this.host.activity("press");
  }

  /** Returns false when the pointer isn't down (a hovering mouse or pencil: the caller does hover). */
  move(p: PointerSample): boolean {
    const t = this.pointers.get(p.id);
    if (!t) return false;
    if (p.type === "mouse" && p.buttons === 0) {
      // the button came up outside the window and we never heard about it
      this.up(p, false);
      return false;
    }
    t.x = p.x;
    t.y = p.y;
    const s = this.s;
    const pt = { x: p.x, y: p.y };

    if (s.k === "pinch") {
      if (p.id === s.a || p.id === s.b) this.pinchTo(s);
      return true;
    }
    if (!("pid" in s) || s.pid !== p.id) return true;

    switch (s.k) {
      case "press": {
        const slop = s.hit.kind === "handle" || s.hit.kind === "grip" ? HANDLE_SLOP[s.type] : TAP_SLOP[s.type];
        if (dist(pt, s.start) < slop) return true;
        this.clearHold(s);
        this.lastTap = null;
        const h = s.hit;
        if (h.kind === "handle") this.startResize(s, h.id, h.dir, pt);
        else if (this.host.mode() === "add" && isOnPage(this.host.view(), this.host.page(), s.start)) {
          this.s = { k: "add", pid: s.pid, start: s.start, r: 0 };
          this.host.activity("add");
          this.addTo(this.s, pt);
        } else if (this.host.mode() === "move" && (h.kind === "grip" || (h.kind === "circle" && h.grab))) this.startMove(s, h.id, pt);
        // Everything else pans — including a big selected circle's body, so
        // there's always somewhere to grab the blueprint.
        else this.startPan(s.pid, s.start, pt);
        return true;
      }
      case "pan":
        this.host.setView({ scale: s.base.scale, tx: s.base.tx + (pt.x - s.start.x), ty: s.base.ty + (pt.y - s.start.y) });
        return true;
      case "move":
        this.moveTo(s, pt);
        return true;
      case "resize":
        this.resizeTo(s, pt);
        return true;
      case "add":
        this.addTo(s, pt);
        return true;
      default:
        return true;
    }
  }

  /** pointerup (`cancelled` false) or pointercancel / lost capture (true). */
  up(p: PointerSample, cancelled: boolean): void {
    if (!this.pointers.has(p.id)) return;
    this.pointers.delete(p.id);
    const s = this.s;

    if (s.k === "pinch") {
      if (p.id === s.a || p.id === s.b) {
        const rest = this.contacts();
        if (rest.length >= 2) this.startPinch(rest[0], rest[1]);
        else if (rest.length === 1) {
          // hand over to a pan from exactly where things are now: no jump
          const id = rest[0];
          const t = this.pointers.get(id)!;
          this.s = { k: "pan", pid: id, start: { x: t.x, y: t.y }, base: this.host.view() };
          this.host.activity("pan");
        } else this.toIdle();
      }
    } else if ("pid" in s && s.pid === p.id) {
      const pt = { x: p.x, y: p.y };
      switch (s.k) {
        case "press":
          this.clearHold(s);
          if (!cancelled && !this.multi) this.tap(s, pt);
          break;
        case "move":
          this.host.draft(null);
          if (cancelled) this.host.gesture({ phase: "cancel", id: s.id, kind: "move" });
          else this.host.gesture({ phase: "end", id: s.id, kind: "move", x: s.cur.x, y: s.cur.y });
          break;
        case "resize":
          this.host.draft(null);
          if (cancelled) this.host.gesture({ phase: "cancel", id: s.id, kind: "resize" });
          else this.host.gesture({ phase: "end", id: s.id, kind: "resize", r: s.cur.r });
          break;
        case "add":
          this.host.addPreview(null);
          if (!cancelled) this.finishAdd(s);
          break;
      }
      this.toIdle();
    }
    if (this.pointers.size === 0) this.multi = false;
  }

  /**
   * The view changed under the pointers (wheel, trackpad pinch, an
   * animation). Re-anchor a pan, and re-apply a move/resize so the circle
   * stays under the stationary pointer.
   */
  viewChanged(): void {
    const s = this.s;
    if (s.k === "pan") {
      const t = this.pointers.get(s.pid);
      if (t) this.s = { ...s, start: { x: t.x, y: t.y }, base: this.host.view() };
    } else if (s.k === "pinch") {
      this.startPinch(s.a, s.b);
    } else if (s.k === "move" || s.k === "resize") {
      const t = this.pointers.get(s.pid);
      if (!t) return;
      if (s.k === "move") this.moveTo(s, t);
      else this.resizeTo(s, t);
    }
  }

  /**
   * Drop everything (the canvas is going away). A move/resize in progress is
   * committed rather than thrown away: never lose the owner's work.
   */
  reset(): void {
    const s = this.s;
    if (s.k === "press") this.clearHold(s);
    if (s.k === "move" || s.k === "resize") {
      this.host.draft(null);
      this.host.gesture({ phase: "end", id: s.id, kind: s.k, ...(s.k === "move" ? { x: s.cur.x, y: s.cur.y } : { r: s.cur.r }) });
    }
    if (s.k === "add") this.host.addPreview(null);
    this.pointers.clear();
    this.multi = false;
    this.lastTap = null;
    this.s = { k: "idle" };
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** Pointer ids that count for a pinch (fingers and pencils, in press order). */
  private contacts(): number[] {
    const out: number[] = [];
    for (const [id, t] of this.pointers) if (t.type !== "mouse") out.push(id);
    return out;
  }

  /**
   * A pointer whose pointerup never came. Whatever it was doing ended when
   * the finger lifted, so a move or resize is kept (like reset()), not
   * cancelled: the owner saw it land and already let go.
   */
  private forget(id: number) {
    const s = this.s;
    const involved = (s.k === "pinch" && (s.a === id || s.b === id)) || ("pid" in s && s.pid === id);
    this.pointers.delete(id);
    if (!involved) return;
    switch (s.k) {
      case "press":
        this.clearHold(s);
        break;
      case "move":
      case "resize":
        this.host.draft(null);
        this.host.gesture({ phase: "end", id: s.id, kind: s.k, ...(s.k === "move" ? { x: s.cur.x, y: s.cur.y } : { r: s.cur.r }) });
        break;
      case "add":
        this.host.addPreview(null);
        break;
    }
    this.lastTap = null;
    this.toIdle();
  }

  private toIdle() {
    this.s = { k: "idle" };
    this.host.activity("idle");
  }

  private clearHold(s: Extract<State, { k: "press" }>) {
    if (s.hold !== null) this.clock.clearTimeout(s.hold);
    s.hold = null;
  }

  /** A second finger landed (or a finger went missing): undo the single-pointer action. */
  private abortSingle() {
    const s = this.s;
    switch (s.k) {
      case "press":
        this.clearHold(s);
        break;
      case "move":
      case "resize":
        this.host.draft(null);
        this.host.gesture({ phase: "cancel", id: s.id, kind: s.k });
        break;
      case "add":
        this.host.addPreview(null);
        break;
    }
    this.lastTap = null;
  }

  private startPinch(a: number, b: number) {
    const pa = this.pointers.get(a)!;
    const pb = this.pointers.get(b)!;
    this.s = { k: "pinch", a, b, startDist: Math.max(1, dist(pa, pb)), startMid: mid(pa, pb), base: this.host.view() };
    this.host.activity("pinch");
  }

  private pinchTo(s: Extract<State, { k: "pinch" }>) {
    const pa = this.pointers.get(s.a);
    const pb = this.pointers.get(s.b);
    if (!pa || !pb) return;
    const m = mid(pa, pb);
    const { min, max } = this.host.limits();
    const scale = clamp(s.base.scale * (dist(pa, pb) / s.startDist), min, max);
    // Keep the world point that was under the starting midpoint under the
    // current midpoint: zoom and two-finger pan in one formula.
    const wx = (s.startMid.x - s.base.tx) / s.base.scale;
    const wy = (s.startMid.y - s.base.ty) / s.base.scale;
    this.host.setView({ scale, tx: m.x - wx * scale, ty: m.y - wy * scale });
  }

  private startPan(pid: number, start: Pt, pt: Pt) {
    const base = this.host.view();
    this.s = { k: "pan", pid, start, base };
    this.host.activity("pan");
    this.host.setView({ scale: base.scale, tx: base.tx + (pt.x - start.x), ty: base.ty + (pt.y - start.y) });
  }

  private startMove(s: Extract<State, { k: "press" }>, id: string, pt: Pt) {
    const c = this.host.circle(id);
    if (!c) return this.startPan(s.pid, s.start, pt);
    const page = this.host.page();
    const w = screenToWorld(this.host.view(), s.start);
    const grab = { x: c.x * page.width - w.x, y: c.y * page.height - w.y };
    const next: Extract<State, { k: "move" }> = { k: "move", pid: s.pid, id, grab, cur: { ...c } };
    this.s = next;
    this.host.gesture({ phase: "start", id, kind: "move", x: c.x, y: c.y });
    this.host.activity("move");
    this.moveTo(next, pt);
  }

  private moveTo(s: Extract<State, { k: "move" }>, pt: Pt) {
    const page = this.host.page();
    const w = screenToWorld(this.host.view(), pt);
    const x = clamp01((w.x + s.grab.x) / Math.max(1, page.width));
    const y = clamp01((w.y + s.grab.y) / Math.max(1, page.height));
    if (x === s.cur.x && y === s.cur.y) return;
    s.cur = { x, y, r: s.cur.r };
    this.host.draft({ id: s.id, ...s.cur });
    this.host.gesture({ phase: "update", id: s.id, kind: "move", x, y });
  }

  private startResize(s: Extract<State, { k: "press" }>, id: string, dir: HandleDir, pt: Pt) {
    const c = this.host.circle(id);
    if (!c) return this.startPan(s.pid, s.start, pt);
    const v = this.host.view();
    const page = this.host.page();
    const centre = worldToScreen(v, { x: c.x * page.width, y: c.y * page.height });
    // Grab the rim where it's drawn: the handle stays under the finger.
    const offset = drawRadius(c.r * longSide(page), v.scale) - dist(s.start, centre);
    const next: Extract<State, { k: "resize" }> = { k: "resize", pid: s.pid, id, dir, offset, cur: { ...c } };
    this.s = next;
    this.host.gesture({ phase: "start", id, kind: "resize", r: c.r });
    this.host.activity("resize", dir);
    this.resizeTo(next, pt);
  }

  private resizeTo(s: Extract<State, { k: "resize" }>, pt: Pt) {
    const v = this.host.view();
    const page = this.host.page();
    const centre = worldToScreen(v, { x: s.cur.x * page.width, y: s.cur.y * page.height });
    const screenR = Math.max(0, dist(pt, centre) + s.offset);
    const r = clamp(screenR / v.scale / longSide(page), MIN_CIRCLE_R, MAX_CIRCLE_R);
    if (r === s.cur.r) return;
    s.cur = { ...s.cur, r };
    this.host.draft({ id: s.id, ...s.cur });
    this.host.gesture({ phase: "update", id: s.id, kind: "resize", r });
  }

  private addTo(s: Extract<State, { k: "add" }>, pt: Pt) {
    s.r = dist(pt, s.start);
    this.host.addPreview({ x: s.start.x, y: s.start.y, r: s.r });
  }

  private finishAdd(s: Extract<State, { k: "add" }>) {
    const r = s.r < MIN_DRAG_ADD_R ? null : s.r;
    this.addAt(s.start, r, "drag");
  }

  /** Add a circle centred at screen point `at` with screen radius `screenR` (null = default size). */
  private addAt(at: Pt, screenR: number | null, via: "tap" | "drag" | "hold") {
    const v = this.host.view();
    const page = this.host.page();
    if (!isOnPage(v, page, at)) return;
    const w = screenToWorld(v, at);
    const r = clamp((screenR ?? DEFAULT_CIRCLE_SCREEN_R) / v.scale / longSide(page), MIN_CIRCLE_R, MAX_CIRCLE_R);
    this.host.add({ x: clamp01(w.x / Math.max(1, page.width)), y: clamp01(w.y / Math.max(1, page.height)), r }, at, via);
  }

  private longPress(pid: number) {
    const s = this.s;
    if (s.k !== "press" || s.pid !== pid || this.multi) return;
    s.hold = null;
    if (!isOnPage(this.host.view(), this.host.page(), s.start)) return;
    this.s = { k: "held", pid };
    this.lastTap = null;
    this.host.activity("held");
    this.addAt(s.start, null, "hold");
    this.host.holdFeedback(s.start);
  }

  private tap(s: Extract<State, { k: "press" }>, upAt: Pt) {
    const now = this.clock.now();
    if (now - s.t0 > TAP_MAX_MS) return;
    const how = s.type === "mouse" ? "click" : "tap";
    const h = s.hit;
    if (h.kind === "handle") return; // already selected; nothing to do
    if (this.host.mode() === "add") {
      this.addAt(s.start, null, "tap");
      return;
    }
    const id = h.kind === "paper" ? null : h.id;
    // Paper and the already-selected circle's body can be double-tapped to
    // zoom (a big selected circle may be all there is on screen). A tap on
    // another circle just selects it.
    if (h.kind === "grip" || (h.kind === "circle" && !h.selected)) {
      this.lastTap = null;
      this.host.select(id, how);
      return;
    }
    const lt = this.lastTap;
    if (lt && lt.type === s.type && s.t0 - lt.t <= DOUBLE_TAP_MS && dist(lt, s.start) <= DOUBLE_TAP_DIST[s.type]) {
      this.lastTap = null;
      this.host.zoomBy(s.start, 2, 180);
      return;
    }
    // Select/deselect fires now; a second tap only adds the zoom.
    this.lastTap = { t: now, x: upAt.x, y: upAt.y, type: s.type };
    this.host.select(id, how);
  }
}
