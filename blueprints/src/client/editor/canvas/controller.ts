// The canvas controller: owns the view (the source of truth, in a plain
// field — never React state), the DOM listeners, the gesture machine, hover,
// animations and the one-requestAnimationFrame-per-frame commit. React reads
// a snapshot of it through useSyncExternalStore, so a pointermove costs no
// React work at all; the frame callback publishes at most once per frame.

import { clamp, zoomAt, type Pt, type View } from "../../../shared/geometry";
import { GestureMachine, type Activity, type CircleGeom, type GestureHost } from "./gestures";
import { hitTest, type HandleDir, type Hit } from "./hitTest";
import type { BlueprintCanvasProps, CanvasGestureEvent, CanvasHandle, PointerKind } from "./types";
import {
  easeOutCubic,
  fitInsets,
  focusView,
  interpolateView,
  isSensibleView,
  sameView,
  scaleLimits,
  usableCentre,
  wheelFactor,
  type Insets,
  type Size,
} from "./viewMath";

export interface Snapshot {
  ready: boolean;
  view: View;
  size: Size;
  /** Live geometry of the circle being moved/resized. */
  draft: ({ id: string } & CircleGeom) | null;
  /** Add-mode drag preview, screen px. */
  addPreview: { x: number; y: number; r: number } | null;
  /** Circle under a hovering mouse/pencil. */
  hoverId: string | null;
  /** Long-press feedback rings (screen px). */
  holds: { id: number; x: number; y: number }[];
}

/** Safari's non-standard GestureEvent (Mac trackpad pinch, iPad Magic Keyboard trackpad). */
interface SafariGestureEvent extends UIEvent {
  scale: number;
  clientX?: number;
  clientY?: number;
}

const VIEW_EMIT_MS = 250; // onViewChange at most 4×/s while moving
const WHEEL_SETTLE_MS = 160;
const HOLD_RING_MS = 650;
const FOCUS_WAIT_MS = 3000;

const kindOf = (t: string): PointerKind => (t === "touch" ? "touch" : t === "pen" ? "pen" : "mouse");

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Touching the canvas on an iPad doesn't take focus from a text field, so the
 * keyboard would stay up over the blueprint. A mouse click blurs by itself.
 */
function blurTextField() {
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) a.blur();
}

function resizeCursor(dir: HandleDir) {
  return dir === "n" || dir === "s" ? "ns-resize" : "ew-resize";
}

export class CanvasController implements GestureHost {
  private props: BlueprintCanvasProps;
  private v: View = { scale: 1, tx: 0, ty: 0 };
  private sz: Size = { w: 0, h: 0 };
  private ready = false;
  private alive = false;
  private surface: HTMLElement | null = null;
  private machine: GestureMachine;

  private snap: Snapshot;
  private subs = new Set<() => void>();
  private raf = 0;
  private inFrame = false;
  /** Emit onViewChange now (bypassing the throttle) at the next frame: a gesture ended. */
  private settle = false;

  private anim: { from: View; to: View; t0: number; ms: number } | null = null;
  private lastFit: View | null = null;
  private pendingFocus: { id: string; until: number } | null = null;
  private pendingUpdate: CanvasGestureEvent | null = null;
  private draftV: Snapshot["draft"] = null;
  private addPrev: Snapshot["addPreview"] = null;
  private holds: Snapshot["holds"] = [];
  private holdSeq = 0;
  private hoverId: string | null = null;
  private hoverPt: (Pt & { type: "mouse" | "pen" }) | null = null;
  private resizeDir: HandleDir = "e";
  private safari: { base: View; at: Pt } | null = null;

  private emitted: View | null = null;
  private emittedAt = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(props: BlueprintCanvasProps) {
    this.props = props;
    this.machine = new GestureMachine(this);
    this.snap = this.makeSnapshot();
  }

  // ── React glue ────────────────────────────────────────────────────────

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  getSnapshot = (): Snapshot => this.snap;

  readonly handle: CanvasHandle = {
    zoomIn: () => this.zoomButton(1.3),
    zoomOut: () => this.zoomButton(1 / 1.3),
    fit: () => this.fit(true),
    focusCircle: (id) => this.focusCircle(id),
    getView: () => ({ ...this.v }),
  };

  setProps(p: BlueprintCanvasProps) {
    const prev = this.props;
    this.props = p;
    if (!this.ready) return;
    if (p.page.width !== prev.page.width || p.page.height !== prev.page.height) this.fit(false);
    if (p.circles !== prev.circles || p.selectedId !== prev.selectedId || p.mode !== prev.mode) this.refreshHover();
    if (this.pendingFocus) this.tryPendingFocus();
  }

  /** Wire up the gesture surface; returns the cleanup. */
  attach(el: HTMLElement): () => void {
    this.surface = el;
    this.alive = true;
    const active: AddEventListenerOptions = { passive: false };
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onCancel);
    el.addEventListener("lostpointercapture", this.onLost);
    el.addEventListener("pointerleave", this.onLeave);
    el.addEventListener("wheel", this.onWheel, active);
    el.addEventListener("gesturestart", this.onGestureStart, active);
    el.addEventListener("gesturechange", this.onGestureChange, active);
    el.addEventListener("gestureend", this.onGestureEnd, active);
    el.addEventListener("contextmenu", this.onContextMenu);
    const ro = new ResizeObserver(() => this.measure());
    ro.observe(el);
    this.measure();
    this.updateCursor();
    return () => {
      ro.disconnect();
      el.removeEventListener("pointerdown", this.onDown);
      el.removeEventListener("pointermove", this.onMove);
      el.removeEventListener("pointerup", this.onUp);
      el.removeEventListener("pointercancel", this.onCancel);
      el.removeEventListener("lostpointercapture", this.onLost);
      el.removeEventListener("pointerleave", this.onLeave);
      el.removeEventListener("wheel", this.onWheel, active);
      el.removeEventListener("gesturestart", this.onGestureStart, active);
      el.removeEventListener("gesturechange", this.onGestureChange, active);
      el.removeEventListener("gestureend", this.onGestureEnd, active);
      el.removeEventListener("contextmenu", this.onContextMenu);
      this.stop();
      this.surface = null;
    };
  }

  /** Unmount: settle everything. A move/resize in progress is committed, not lost. */
  private stop() {
    this.alive = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.anim = null;
    this.safari = null;
    this.machine.reset();
    this.flushUpdate();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.emitTimer = this.wheelTimer = null;
    this.maybeEmitView(true);
    this.holds = [];
    this.draftV = null;
    this.addPrev = null;
    if (this.hoverId && this.hoverPt) this.props.onHover(null, this.hoverPt.type);
    this.hoverId = null;
    this.hoverPt = null;
  }

  // ── sizing and the initial view ───────────────────────────────────────

  private measure() {
    const el = this.surface;
    if (!el) return;
    this.resize(el.clientWidth, el.clientHeight);
  }

  private resize(w: number, h: number) {
    const prev = this.sz;
    if (w === prev.w && h === prev.h) return;
    this.sz = { w, h };
    if (w <= 0 || h <= 0) return this.commitNow(); // hidden for now: keep the view
    if (!this.ready) {
      const iv = this.props.initialView;
      if (isSensibleView(iv, this.props.page, this.sz)) this.v = { ...iv };
      else this.v = this.lastFit = fitInsets(this.props.page, this.sz, this.insets());
      this.emitted = { ...this.v };
      this.ready = true;
      this.tryPendingFocus();
    } else if (this.isAtFit()) {
      // untouched since the last fit (e.g. the iPad rotated): fit again
      this.anim = null;
      this.v = this.lastFit = fitInsets(this.props.page, this.sz, this.insets());
    } else if (prev.w > 0 && prev.h > 0) {
      // keep what's in the middle of the screen in the middle
      const base = this.anim?.to ?? this.v;
      this.anim = null;
      this.v = { scale: base.scale, tx: base.tx + (w - prev.w) / 2, ty: base.ty + (h - prev.h) / 2 };
    }
    this.machine.viewChanged();
    this.commitNow();
    this.settle = true;
    this.requestFrame();
  }

  private isAtFit() {
    return !!this.lastFit && (sameView(this.v, this.lastFit) || (!!this.anim && sameView(this.anim.to, this.lastFit)));
  }

  private insets(): Insets {
    return { top: this.props.topInset ?? 0, right: this.props.rightInset ?? 0 };
  }

  // ── frames ────────────────────────────────────────────────────────────

  private requestFrame() {
    if (!this.raf && this.alive && !this.inFrame) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (!this.alive) return;
    this.inFrame = true;
    let again = false;
    if (this.anim) {
      const a = this.anim;
      const t = clamp((performance.now() - a.t0) / a.ms, 0, 1);
      this.v = t >= 1 ? a.to : interpolateView(a.from, a.to, easeOutCubic(t));
      if (t >= 1) {
        this.anim = null;
        this.settle = true;
      } else again = true;
    }
    this.flushUpdate();
    this.refreshHover();
    this.publish();
    this.inFrame = false;
    this.maybeEmitView(this.settle);
    this.settle = false;
    if (again) this.requestFrame();
  };

  /** Publish right away (sizing, first paint) instead of waiting for a frame. */
  private commitNow() {
    this.refreshHover();
    this.publish();
  }

  private makeSnapshot(): Snapshot {
    return {
      ready: this.ready,
      view: this.v,
      size: this.sz,
      draft: this.draftV,
      addPreview: this.addPrev,
      hoverId: this.hoverId,
      holds: this.holds,
    };
  }

  private publish() {
    this.snap = this.makeSnapshot();
    for (const fn of this.subs) fn();
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** onViewChange: throttled to 4/s while moving, immediate when a gesture settles. */
  private maybeEmitView(force: boolean) {
    const cb = this.props.onViewChange;
    if (!cb || !this.ready || sameView(this.v, this.emitted, 0.01)) return;
    const now = performance.now();
    const wait = VIEW_EMIT_MS - (now - this.emittedAt);
    if (force || wait <= 0) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emitted = { ...this.v };
      this.emittedAt = now;
      cb({ ...this.v });
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.maybeEmitView(true);
      }, wait);
    }
  }

  // ── view changes from buttons and the editor ──────────────────────────

  private animateTo(target: View, ms: number) {
    if (!this.ready) return;
    if (ms <= 0 || reducedMotion()) {
      this.anim = null;
      this.v = target;
      this.settle = true;
    } else {
      this.anim = { from: { ...this.v }, to: target, t0: performance.now(), ms };
    }
    this.requestFrame();
  }

  private stopAnimation() {
    if (!this.anim) return;
    this.anim = null;
    this.settle = true;
  }

  private zoomButton(factor: number) {
    if (!this.ready) return;
    const { min, max } = this.limits();
    // repeated presses compound from where the running animation is headed
    const base = this.anim?.to ?? this.v;
    this.animateTo(zoomAt(base, usableCentre(this.sz, this.insets()), factor, min, max), 160);
  }

  private fit(animated: boolean) {
    if (!this.ready) return;
    const target = fitInsets(this.props.page, this.sz, this.insets());
    this.lastFit = target;
    this.animateTo(target, animated ? 200 : 0);
  }

  private focusCircle(id: string) {
    const c = this.props.circles.find((x) => x.id === id);
    if (!this.ready || !c) {
      // the canvas is still measuring, or the circle arrives with the next props
      this.pendingFocus = { id, until: performance.now() + FOCUS_WAIT_MS };
      return;
    }
    this.pendingFocus = null;
    const target = focusView(this.props.page, c, this.sz, this.insets(), this.anim?.to ?? this.v, this.limits());
    this.animateTo(target, 250);
  }

  private tryPendingFocus() {
    const pf = this.pendingFocus;
    if (!pf || !this.ready) return;
    if (performance.now() > pf.until) this.pendingFocus = null;
    else if (this.props.circles.some((c) => c.id === pf.id)) this.focusCircle(pf.id);
  }

  // ── GestureHost ───────────────────────────────────────────────────────

  view() {
    return this.v;
  }

  setView(v: View) {
    this.v = v;
    this.requestFrame();
  }

  limits() {
    return scaleLimits(this.props.page, this.sz);
  }

  mode() {
    return this.props.mode;
  }

  page() {
    return this.props.page;
  }

  hitTest(pt: Pt, type: PointerKind): Hit {
    return hitTest(pt, { view: this.v, page: this.props.page, circles: this.props.circles, selectedId: this.props.selectedId, pointerType: type });
  }

  circle(id: string): CircleGeom | null {
    const c = this.props.circles.find((x) => x.id === id);
    return c ? { x: c.x, y: c.y, r: c.r } : null;
  }

  zoomBy(at: Pt, factor: number, ms: number) {
    const { min, max } = this.limits();
    this.animateTo(zoomAt(this.anim?.to ?? this.v, at, factor, min, max), ms);
  }

  select(id: string | null, how: "tap" | "click") {
    this.props.onSelect(id, how);
  }

  add(c: CircleGeom) {
    this.props.onAdd({ x: c.x, y: c.y, r: c.r });
  }

  /** Live updates go out once per frame (the editor re-renders per update); start/end/cancel at once, in order. */
  gesture(e: CanvasGestureEvent) {
    if (e.phase === "update") {
      this.pendingUpdate = e;
      this.requestFrame();
      return;
    }
    if (e.phase === "cancel") this.pendingUpdate = null;
    else this.flushUpdate();
    this.props.onGesture(e);
  }

  private flushUpdate() {
    const u = this.pendingUpdate;
    if (!u) return;
    this.pendingUpdate = null;
    this.props.onGesture(u);
  }

  draft(d: Snapshot["draft"]) {
    this.draftV = d;
    this.requestFrame();
  }

  addPreview(p: Snapshot["addPreview"]) {
    this.addPrev = p;
    this.requestFrame();
  }

  holdFeedback(at: Pt) {
    const id = ++this.holdSeq;
    this.holds = [...this.holds, { id, x: at.x, y: at.y }];
    // a tick where the hardware can (Android); iPad has no web vibration
    navigator.vibrate?.(12);
    this.requestFrame();
    this.later(() => {
      this.holds = this.holds.filter((h) => h.id !== id);
      this.requestFrame();
    }, HOLD_RING_MS);
  }

  activity(a: Activity, dir?: HandleDir) {
    if (dir) this.resizeDir = dir;
    if (a === "idle") {
      this.settle = true;
      this.requestFrame();
    }
    this.updateCursor();
  }

  // ── hover and cursor ──────────────────────────────────────────────────

  /** Re-run the hover hit test at the last mouse/pencil position (after it moved or the view changed). */
  private refreshHover() {
    const hp = this.hoverPt;
    if (!hp || !this.ready || this.machine.pressedCount > 0) return this.updateCursor();
    const hit = this.hitTest(hp, hp.type);
    // In add mode a click adds rather than selects, so nothing lights up.
    this.setHover(hit.kind === "paper" || this.props.mode === "add" ? null : hit.id, hp.type);
    this.updateCursor(hit);
  }

  private setHover(id: string | null, type: "mouse" | "pen") {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.props.onHover(id, type);
    this.requestFrame();
  }

  private updateCursor(hit?: Hit) {
    const el = this.surface;
    if (!el) return;
    const a = this.machine.activity;
    let c: string;
    if (a === "pan" || a === "pinch" || a === "move") c = "grabbing";
    else if (a === "resize") c = resizeCursor(this.resizeDir);
    else if (a === "add") c = "crosshair";
    else {
      const h = hit ?? (this.hoverPt && this.ready ? this.hitTest(this.hoverPt, this.hoverPt.type) : null);
      if (h?.kind === "handle") c = resizeCursor(h.dir);
      else if (this.props.mode === "add") c = "crosshair";
      else if (h?.kind === "circle") c = h.selected ? "move" : "pointer";
      else c = "grab";
    }
    if (el.dataset.cursor !== c) el.dataset.cursor = c;
  }

  // ── DOM events ────────────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.surface!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    if (!this.ready) return;
    const type = kindOf(e.pointerType);
    if (type === "mouse" && e.button > 2) return; // back/forward buttons
    if (type === "mouse" && e.button === 1) e.preventDefault(); // no autoscroll
    if (type !== "mouse") blurTextField();
    this.stopAnimation();
    try {
      this.surface?.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    const pt = this.local(e);
    this.machine.down({ id: e.pointerId, type, x: pt.x, y: pt.y, button: e.button, buttons: e.buttons, isPrimary: e.isPrimary });
    this.updateCursor();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.ready) return;
    const type = kindOf(e.pointerType);
    const pt = this.local(e);
    if (this.machine.move({ id: e.pointerId, type, x: pt.x, y: pt.y, buttons: e.buttons })) return;
    if (type === "touch") return;
    this.hoverPt = { x: pt.x, y: pt.y, type };
    this.refreshHover();
  };

  private onUp = (e: PointerEvent) => {
    const type = kindOf(e.pointerType);
    const pt = this.local(e);
    this.machine.up({ id: e.pointerId, type, x: pt.x, y: pt.y }, false);
    if (type !== "touch") {
      this.hoverPt = { x: pt.x, y: pt.y, type };
      this.refreshHover();
    }
  };

  private onCancel = (e: PointerEvent) => {
    const pt = this.local(e);
    this.machine.up({ id: e.pointerId, type: kindOf(e.pointerType), x: pt.x, y: pt.y }, true);
  };

  /** Capture lost without a pointerup (the element moved, the system took the touch): treat as cancel. */
  private onLost = (e: PointerEvent) => {
    if (this.machine.isDown(e.pointerId)) this.onCancel(e);
  };

  private onLeave = (e: PointerEvent) => {
    const type = kindOf(e.pointerType);
    if (type === "touch" || this.machine.isDown(e.pointerId)) return;
    this.hoverPt = null;
    this.setHover(null, type);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault(); // the page itself never scrolls or zooms
    if (!this.ready) return;
    if (this.safari && e.ctrlKey) return; // Safari already reports this pinch as gesture events
    this.stopAnimation();
    const pt = this.local(e);
    const { min, max } = this.limits();
    this.setView(zoomAt(this.v, pt, wheelFactor(e, this.sz.h), min, max));
    this.machine.viewChanged();
    if (this.machine.pressedCount === 0) this.hoverPt = { x: pt.x, y: pt.y, type: "mouse" };
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.settle = true;
      this.requestFrame();
    }, WHEEL_SETTLE_MS);
  };

  private onGestureStart = (e: Event) => {
    e.preventDefault();
    // On an iPad a finger pinch fires these too; pointer events handle that one.
    if (!this.ready || this.machine.hasTouch()) {
      this.safari = null;
      return;
    }
    this.stopAnimation();
    const g = e as SafariGestureEvent;
    const at =
      typeof g.clientX === "number" && typeof g.clientY === "number"
        ? this.local({ clientX: g.clientX, clientY: g.clientY })
        : { x: this.sz.w / 2, y: this.sz.h / 2 };
    this.safari = { base: { ...this.v }, at };
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    const s = this.safari;
    if (!s || this.machine.hasTouch()) return;
    const { min, max } = this.limits();
    // e.scale is cumulative since gesturestart: base × scale, never compounding
    const scale = clamp(s.base.scale * ((e as SafariGestureEvent).scale || 1), min, max);
    const k = scale / s.base.scale;
    this.setView({ scale, tx: s.at.x - k * (s.at.x - s.base.tx), ty: s.at.y - k * (s.at.y - s.base.ty) });
    this.machine.viewChanged();
  };

  private onGestureEnd = (e: Event) => {
    e.preventDefault();
    if (!this.safari) return;
    this.safari = null;
    this.settle = true;
    this.requestFrame();
  };

  private onContextMenu = (e: Event) => {
    // right-drag pans; a long press must not open a callout
    e.preventDefault();
  };
}
