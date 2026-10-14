// The canvas's pure parts: the gesture state machine (with a fake host and
// clock), hit testing, the view math and the controller's view handling
// (with a fake surface). The real-browser behaviour is in
// tests/e2e/canvas.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CIRCLE_SCREEN_R, MAX_CIRCLE_R } from "../../src/shared/constants";
import { pickLevel, zoomAt, type Pt, type View } from "../../src/shared/geometry";
import type { CircleRow, PageRow } from "../../src/shared/types";
import { CanvasController } from "../../src/client/editor/canvas/controller";
import { GestureMachine, LONG_PRESS_MS, type Clock, type GestureHost, type PointerSample } from "../../src/client/editor/canvas/gestures";
import { HANDLE_RING_MIN, hitTest, type Hit } from "../../src/client/editor/canvas/hitTest";
import type { BlueprintCanvasProps, CanvasGestureEvent, CanvasMode, PointerKind } from "../../src/client/editor/canvas/types";
import {
  fitInsets,
  focusView,
  interpolateView,
  isSensibleView,
  planTiles,
  revealView,
  scaleLimits,
  usableArea,
  visibleArea,
  visibleTiles,
  type TileBox,
} from "../../src/client/editor/canvas/viewMath";

const PAGE = { width: 8000, height: 5000 };
const SIZE = { w: 1000, h: 700 };

function circle(id: string, x: number, y: number, r: number): CircleRow {
  return { id, planId: "p", pageId: "pg", x, y, r, color: "gold", title: "", num: 1, createdAt: 0, updatedAt: 0, deletedAt: null, rev: 1 };
}

class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  advance(ms: number) {
    this.t += ms;
    for (const [id, tm] of [...this.timers]) {
      if (tm.at <= this.t) {
        this.timers.delete(id);
        tm.fn();
      }
    }
  }
}

/** A canvas without a DOM: records what the machine asks for. `coarse`: an iPad's selection layout. */
function setup(opts: { mode?: CanvasMode; selectedId?: string | null; circles?: CircleRow[]; view?: View; coarse?: boolean } = {}) {
  const clock = new FakeClock();
  const state = {
    view: opts.view ?? { scale: 0.1, tx: 100, ty: 100 },
    mode: opts.mode ?? ("move" as CanvasMode),
    selectedId: opts.selectedId ?? null,
    circles: opts.circles ?? [circle("a", 0.5, 0.5, 0.02), circle("b", 0.2, 0.2, 0.05)],
  };
  const log = {
    select: [] as { id: string | null; how: string }[],
    add: [] as { x: number; y: number; r: number; via: string }[],
    gesture: [] as CanvasGestureEvent[],
    zoom: [] as { at: Pt; factor: number }[],
    holds: 0,
    /** The live (draft) geometry the canvas draws while a move/resize runs. */
    draft: null as { id: string; x: number; y: number; r: number } | null,
  };
  const host: GestureHost = {
    view: () => state.view,
    setView: (v) => void (state.view = v),
    limits: () => ({ min: 0.01, max: 10 }),
    mode: () => state.mode,
    page: () => PAGE,
    hitTest: (pt: Pt, type: PointerKind): Hit =>
      hitTest(pt, { view: state.view, page: PAGE, circles: state.circles, selectedId: state.selectedId, pointerType: type, coarse: opts.coarse }),
    circle: (id) => {
      const c = state.circles.find((x) => x.id === id);
      return c ? { x: c.x, y: c.y, r: c.r } : null;
    },
    zoomBy: (at, factor) => void log.zoom.push({ at, factor }),
    select: (id, how) => void log.select.push({ id, how }),
    add: (c, _at, via) => void log.add.push({ ...c, via }),
    gesture: (e) => {
      log.gesture.push(e);
      if (e.phase === "update") state.circles = state.circles.map((c) => (c.id === e.id ? { ...c, ...(e.kind === "move" ? { x: e.x!, y: e.y! } : { r: e.r! }) } : c));
    },
    draft: (d) => void (log.draft = d),
    addPreview: () => {},
    holdFeedback: () => void log.holds++,
    activity: () => {},
  };
  const m = new GestureMachine(host, clock);
  const p = (id: number, x: number, y: number, type: PointerKind = "touch", extra: Partial<PointerSample> = {}): PointerSample => ({
    id,
    type,
    x,
    y,
    button: 0,
    buttons: 1,
    isPrimary: id === 1,
    ...extra,
  });
  /** Screen position of a world point under the current view. */
  const screen = (wx: number, wy: number) => ({ x: wx * state.view.scale + state.view.tx, y: wy * state.view.scale + state.view.ty });
  return { m, state, log, clock, p, screen };
}

// The paper at world (1000, 4000): no circles there.
const PAPER = { x: 1000 * 0.1 + 100, y: 4000 * 0.1 + 100 };

describe("gesture machine", () => {
  it("a tap on paper deselects, on a circle selects; a mouse click says so", () => {
    const { m, log, p, screen, clock } = setup();
    m.down(p(1, PAPER.x, PAPER.y));
    clock.advance(80);
    m.up(p(1, PAPER.x + 3, PAPER.y + 2), false);
    const a = screen(4000, 2500);
    m.down(p(2, a.x, a.y, "mouse"));
    m.up(p(2, a.x, a.y, "mouse"), false);
    expect(log.select).toEqual([
      { id: null, how: "tap" },
      { id: "a", how: "click" },
    ]);
  });

  it("one finger pans by exactly the finger's travel, without a tap", () => {
    const { m, state, log, p } = setup();
    const v0 = state.view;
    m.down(p(1, PAPER.x, PAPER.y));
    for (let i = 1; i <= 10; i++) m.move(p(1, PAPER.x + 7 * i, PAPER.y - 4 * i));
    m.up(p(1, PAPER.x + 70, PAPER.y - 40), false);
    expect(state.view).toEqual({ scale: v0.scale, tx: v0.tx + 70, ty: v0.ty - 40 });
    expect(log.select).toEqual([]);
  });

  it("a press that moves less than the slop is still a tap", () => {
    const { m, log, p } = setup();
    m.down(p(1, PAPER.x, PAPER.y));
    m.move(p(1, PAPER.x + 6, PAPER.y + 6)); // 8.5 px < 10 px touch slop
    m.up(p(1, PAPER.x + 6, PAPER.y + 6), false);
    expect(log.select).toHaveLength(1);
  });

  it("pinch keeps the world point under the starting midpoint under the current one", () => {
    const { m, state, p } = setup();
    const v0 = state.view;
    const mid0 = { x: 500, y: 400 };
    const anchor = { x: (mid0.x - v0.tx) / v0.scale, y: (mid0.y - v0.ty) / v0.scale };
    m.down(p(1, 400, 400));
    m.down(p(2, 600, 400));
    let a = { x: 400, y: 400 };
    let b = { x: 600, y: 400 };
    for (let i = 1; i <= 20; i++) {
      a = { x: 400 - 9 * i + 2 * i, y: 400 + 3 * i };
      b = { x: 600 + 11 * i + 2 * i, y: 400 - 5 * i };
      m.move(p(1, a.x, a.y));
      m.move(p(2, b.x, b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const v = state.view;
      expect(anchor.x * v.scale + v.tx).toBeCloseTo(mid.x, 9);
      expect(anchor.y * v.scale + v.ty).toBeCloseTo(mid.y, 9);
    }
    expect(state.view.scale / v0.scale).toBeCloseTo(Math.hypot(b.x - a.x, b.y - a.y) / 200, 9);
  });

  it("lifting one pinch finger hands over to a pan without a jump", () => {
    const { m, state, p } = setup();
    m.down(p(1, 400, 400));
    m.down(p(2, 600, 400));
    m.move(p(2, 700, 420));
    const v1 = state.view;
    m.up(p(2, 700, 420), false);
    expect(state.view).toEqual(v1);
    m.move(p(1, 430, 380));
    expect(state.view).toEqual({ scale: v1.scale, tx: v1.tx + 30, ty: v1.ty - 20 });
    m.up(p(1, 430, 380), false);
  });

  it("a second finger cancels a move and suppresses the tap", () => {
    const a = circle("a", 0.5, 0.5, 0.02);
    const { m, log, p, screen } = setup({ selectedId: "a", circles: [a] });
    const c = screen(4000, 2500);
    m.down(p(1, c.x, c.y));
    m.move(p(1, c.x + 30, c.y));
    expect(log.gesture.map((e) => e.phase)).toEqual(["start", "update"]);
    m.down(p(2, c.x + 200, c.y + 50));
    expect(log.gesture.at(-1)).toEqual({ phase: "cancel", id: "a", kind: "move" });
    m.up(p(2, c.x + 200, c.y + 50), false);
    m.up(p(1, c.x + 30, c.y), false);
    expect(log.select).toEqual([]);
    expect(log.gesture.filter((e) => e.phase === "end")).toEqual([]);
  });

  it("moves the selected circle by the pointer's travel (grab point kept)", () => {
    const { m, log, p, screen, state } = setup({ selectedId: "a" });
    const c = screen(4000, 2500);
    m.down(p(1, c.x + 5, c.y - 5, "mouse"));
    m.move(p(1, c.x + 105, c.y + 45, "mouse"));
    m.up(p(1, c.x + 105, c.y + 45, "mouse"), false);
    const end = log.gesture.at(-1)!;
    expect(end.phase).toBe("end");
    expect(end.x).toBeCloseTo(0.5 + 100 / state.view.scale / PAGE.width, 12);
    expect(end.y).toBeCloseTo(0.5 + 50 / state.view.scale / PAGE.height, 12);
  });

  it("resizes from a handle; the radius is clamped", () => {
    const big = circle("a", 0.5, 0.5, 0.05); // 400 world px → 40 screen px
    const { m, log, p, screen } = setup({ selectedId: "a", circles: [big] });
    const c = screen(4000, 2500);
    m.down(p(1, c.x + 40, c.y, "mouse"));
    m.move(p(1, c.x + 70, c.y, "mouse"));
    expect(log.gesture[0]).toEqual({ phase: "start", id: "a", kind: "resize", r: 0.05 });
    expect(log.gesture.at(-1)!.r).toBeCloseTo(70 / 0.1 / 8000, 12);
    m.move(p(1, c.x + 5000, c.y, "mouse"));
    m.up(p(1, c.x + 5000, c.y, "mouse"), false);
    expect(log.gesture.at(-1)).toEqual({ phase: "end", id: "a", kind: "resize", r: MAX_CIRCLE_R });
  });

  it("dragging an unselected circle pans instead of moving it", () => {
    const { m, log, p, screen, state } = setup();
    const c = screen(4000, 2500);
    const v0 = state.view;
    m.down(p(1, c.x, c.y));
    m.move(p(1, c.x + 50, c.y));
    m.up(p(1, c.x + 50, c.y), false);
    expect(log.gesture).toEqual([]);
    expect(state.view.tx).toBe(v0.tx + 50);
  });

  it("long press adds a default-size circle; moving first or a mouse never does", () => {
    const { m, log, p, clock, state } = setup();
    m.down(p(1, PAPER.x, PAPER.y));
    clock.advance(LONG_PRESS_MS - 1);
    expect(log.add).toEqual([]);
    clock.advance(1);
    expect(log.add).toEqual([{ x: 1000 / 8000, y: 4000 / 5000, r: DEFAULT_CIRCLE_SCREEN_R / state.view.scale / 8000, via: "hold" }]);
    expect(log.holds).toBe(1);
    m.up(p(1, PAPER.x, PAPER.y), false);
    expect(log.select).toEqual([]); // the lift after a long press isn't a tap

    m.down(p(1, PAPER.x, PAPER.y));
    m.move(p(1, PAPER.x + 20, PAPER.y));
    clock.advance(1000);
    m.up(p(1, PAPER.x + 20, PAPER.y), false);
    m.down(p(3, PAPER.x, PAPER.y, "mouse"));
    clock.advance(1000);
    m.up(p(3, PAPER.x, PAPER.y, "mouse"), false);
    expect(log.add).toHaveLength(1);
  });

  it("add mode: a tap adds at the default size (even inside a circle), a drag sizes it", () => {
    const { m, log, p, screen, state } = setup({ mode: "add" });
    const c = screen(4000, 2500);
    m.down(p(1, c.x, c.y));
    m.up(p(1, c.x, c.y), false);
    expect(log.add[0]).toEqual({ x: 0.5, y: 0.5, r: DEFAULT_CIRCLE_SCREEN_R / 0.1 / 8000, via: "tap" });
    m.down(p(1, PAPER.x, PAPER.y));
    m.move(p(1, PAPER.x + 30, PAPER.y + 40));
    m.up(p(1, PAPER.x + 30, PAPER.y + 40), false);
    expect(log.add[1].r).toBeCloseTo(50 / state.view.scale / 8000, 12);
    expect(log.add[1].via).toBe("drag");
    expect(log.select).toEqual([]);
    // off the page: nothing
    m.down(p(1, 10, 10));
    m.up(p(1, 10, 10), false);
    expect(log.add).toHaveLength(2);
  });

  it("double-tap on paper zooms ×2 there; the first tap still deselects at once", () => {
    const { m, log, p, clock } = setup();
    m.down(p(1, PAPER.x, PAPER.y));
    m.up(p(1, PAPER.x, PAPER.y), false);
    expect(log.select).toEqual([{ id: null, how: "tap" }]);
    clock.advance(150);
    m.down(p(1, PAPER.x + 5, PAPER.y + 5));
    m.up(p(1, PAPER.x + 5, PAPER.y + 5), false);
    expect(log.zoom).toEqual([{ at: { x: PAPER.x + 5, y: PAPER.y + 5 }, factor: 2 }]);
    expect(log.select).toHaveLength(1);
    // too slow: two single taps
    clock.advance(1000);
    m.down(p(1, PAPER.x, PAPER.y));
    m.up(p(1, PAPER.x, PAPER.y), false);
    clock.advance(500);
    m.down(p(1, PAPER.x, PAPER.y));
    m.up(p(1, PAPER.x, PAPER.y), false);
    expect(log.zoom).toHaveLength(1);
  });

  it("recovers from a touch whose pointerup never arrived", () => {
    const { m, log, p } = setup();
    m.down(p(1, PAPER.x, PAPER.y));
    // …the up for pointer 1 is lost; the next finger is primary again
    m.down(p(7, PAPER.x, PAPER.y, "touch", { isPrimary: true }));
    m.up(p(7, PAPER.x, PAPER.y), false);
    expect(log.select).toEqual([{ id: null, how: "tap" }]); // a tap, not a pinch with a ghost
  });

  it("a mouse move with no buttons ends a drag whose pointerup was missed", () => {
    const { m, state, p } = setup();
    m.down(p(1, PAPER.x, PAPER.y, "mouse"));
    m.move(p(1, PAPER.x + 40, PAPER.y, "mouse"));
    expect(m.move(p(1, PAPER.x + 80, PAPER.y, "mouse", { buttons: 0 }))).toBe(false);
    expect(m.activity).toBe("idle");
    expect(state.view.tx).toBe(100 + 40);
  });

  it("reset commits a move in progress instead of dropping it", () => {
    const { m, log, p, screen } = setup({ selectedId: "a" });
    const c = screen(4000, 2500);
    m.down(p(1, c.x, c.y, "mouse"));
    m.move(p(1, c.x + 20, c.y, "mouse"));
    m.reset();
    expect(log.gesture.at(-1)!.phase).toBe("end");
  });

  // ── #10: a big selected circle must never stop the owner panning ──

  /** Selected circle "a", 240 px in radius on screen, centred at (500, 350). */
  const bigSelected = (coarse = true) =>
    setup({ selectedId: "a", circles: [circle("a", 0.5, 0.5, 0.03)], view: { scale: 1, tx: -3500, ty: -2150 }, coarse });

  for (const type of ["touch", "mouse"] as const) {
    it(`dragging a big selected circle's body pans; its grip moves it (${type}, #10)`, () => {
      const { m, log, p, state } = bigSelected(type === "touch");
      const v0 = state.view;
      m.down(p(1, 600, 400, type)); // inside the circle, 112 px from its centre
      for (let i = 1; i <= 5; i++) m.move(p(1, 600 - 50 * i, 400 - 30 * i, type));
      m.up(p(1, 350, 250, type), false);
      expect(log.gesture).toEqual([]);
      expect(state.view).toEqual({ scale: 1, tx: v0.tx - 250, ty: v0.ty - 150 });

      // the grip, now at (250, 200), moves it — grabbed a little off-centre, no jump
      m.down(p(1, 253, 198, type));
      for (let i = 1; i <= 4; i++) m.move(p(1, 253 + 25 * i, 198 + 12 * i, type));
      m.up(p(1, 353, 246, type), false);
      expect(log.gesture.map((e) => e.phase)).toEqual(["start", "update", "update", "update", "update", "end"]);
      const end = log.gesture.at(-1)!;
      expect(end.x).toBeCloseTo(0.5 + 100 / 8000, 12);
      expect(end.y).toBeCloseTo(0.5 + 48 / 5000, 12);
      expect(state.view.tx).toBe(v0.tx - 250); // moving it didn't pan
    });
  }

  it("a big selected circle: a tap keeps it selected, a double-tap zooms, a long press adds (#10)", () => {
    const { m, log, p, clock } = bigSelected();
    m.down(p(1, 600, 400));
    m.up(p(1, 600, 400), false);
    expect(log.select).toEqual([{ id: "a", how: "tap" }]);
    clock.advance(150);
    m.down(p(1, 604, 403));
    m.up(p(1, 604, 403), false);
    expect(log.zoom).toEqual([{ at: { x: 604, y: 403 }, factor: 2 }]);
    clock.advance(1000);
    m.down(p(1, 600, 400));
    clock.advance(LONG_PRESS_MS);
    m.up(p(1, 600, 400), false);
    expect(log.add).toHaveLength(1);
    expect(log.add[0].via).toBe("hold");
  });

  // ── #12: small selected circles ──

  it("a finger 7 px off a tiny selected circle's centre moves it rather than resizing it (#12)", () => {
    const { m, log, p, screen } = setup({ selectedId: "a", circles: [circle("a", 0.5, 0.5, 0.0005)], coarse: true }); // drawn at 10 px
    const c = screen(4000, 2500);
    m.down(p(1, c.x + 7, c.y));
    for (let i = 1; i <= 6; i++) m.move(p(1, c.x + 7 + 20 * i, c.y + 10 * i));
    m.up(p(1, c.x + 127, c.y + 60), false);
    expect(log.gesture[0]).toMatchObject({ phase: "start", kind: "move" });
    const end = log.gesture.at(-1)!;
    expect(end).toMatchObject({ phase: "end", kind: "move" });
    expect(end.x).toBeCloseTo(0.5 + 120 / 0.1 / 8000, 12);
    expect(end.y).toBeCloseTo(0.5 + 60 / 0.1 / 5000, 12);
  });

  it("a tap on a neighbour inside a selected circle's handle padding selects the neighbour (#12)", () => {
    const circles = [circle("a", 0.5, 0.5, 0.0005), circle("b", 0.5 + 260 / 8000, 0.5, 0.0005)];
    const { m, log, p, screen } = setup({ selectedId: "a", circles, coarse: true });
    const b = screen(4000 + 260, 2500);
    m.down(p(1, b.x, b.y));
    m.up(p(1, b.x + 2, b.y + 1), false);
    expect(log.select).toEqual([{ id: "b", how: "tap" }]);
    expect(log.gesture).toEqual([]);
  });

  it("a resting fingertip's jitter on a handle doesn't resize; a real drag does", () => {
    const { m, log, p, screen } = setup({ selectedId: "a", circles: [circle("a", 0.5, 0.5, 0.1)], coarse: true }); // R 80 px
    const c = screen(4000, 2500);
    m.down(p(1, c.x + 80, c.y));
    m.move(p(1, c.x + 83, c.y + 2)); // 3.6 px
    m.up(p(1, c.x + 83, c.y + 2), false);
    expect(log.gesture).toEqual([]);
    m.down(p(1, c.x + 80, c.y));
    m.move(p(1, c.x + 110, c.y));
    m.up(p(1, c.x + 110, c.y), false);
    expect(log.gesture.at(-1)).toMatchObject({ phase: "end", kind: "resize" });
    expect(log.gesture.at(-1)!.r).toBeCloseTo(110 / 0.1 / 8000, 12);
  });

  // ── #25: iOS dropped a pointerup ──

  it("a move whose pointerup never came is kept, not undone, and the next tap still works (#25)", () => {
    const { m, log, p, screen, clock } = setup({ selectedId: "a", circles: [circle("a", 0.5, 0.5, 0.02)] });
    const c = screen(4000, 2500);
    m.down(p(1, c.x, c.y));
    for (let i = 1; i <= 10; i++) m.move(p(1, c.x + 20 * i, c.y));
    // …the pointerup is lost; three seconds later a tap on paper
    clock.advance(3000);
    m.down(p(2, PAPER.x, PAPER.y, "touch", { isPrimary: true }));
    m.up(p(2, PAPER.x, PAPER.y), false);
    expect(log.gesture.filter((e) => e.phase === "cancel")).toEqual([]);
    const end = log.gesture.at(-1)!;
    expect(end).toMatchObject({ phase: "end", id: "a", kind: "move" });
    expect(end.x).toBeCloseTo(0.5 + 200 / 0.1 / 8000, 12);
    expect(log.draft).toBeNull();
    expect(log.select).toEqual([{ id: null, how: "tap" }]);
  });

  it("a resize whose pointerup never came is kept too (#25)", () => {
    const { m, log, p, screen, clock } = setup({ selectedId: "a", circles: [circle("a", 0.5, 0.5, 0.1)] }); // R 80 px
    const c = screen(4000, 2500);
    m.down(p(1, c.x + 80, c.y));
    m.move(p(1, c.x + 130, c.y));
    clock.advance(2000);
    m.down(p(2, PAPER.x, PAPER.y, "touch", { isPrimary: true }));
    expect(log.gesture.at(-1)).toMatchObject({ phase: "end", kind: "resize" });
    expect(log.gesture.at(-1)!.r).toBeCloseTo(130 / 0.1 / 8000, 12);
  });

  it("after a pinch whose last finger's pointerup was lost, the next tap isn't swallowed (#25)", () => {
    const { m, log, p } = setup();
    m.down(p(1, 400, 400));
    m.down(p(2, 600, 400));
    m.move(p(2, 650, 400));
    m.up(p(2, 650, 400), false);
    // …finger 1's pointerup is lost
    m.down(p(3, PAPER.x, PAPER.y, "touch", { isPrimary: true }));
    m.up(p(3, PAPER.x, PAPER.y), false);
    expect(log.select).toEqual([{ id: null, how: "tap" }]);
  });

  it("an Apple Pencil whose pointerup was lost doesn't turn the next one into a pinch (#25)", () => {
    const { m, log, p, state } = setup();
    m.down(p(1, PAPER.x, PAPER.y, "pen"));
    m.move(p(1, PAPER.x + 30, PAPER.y, "pen"));
    const v1 = state.view;
    // …its pointerup is lost
    m.down(p(5, PAPER.x, PAPER.y, "pen", { isPrimary: true }));
    m.up(p(5, PAPER.x, PAPER.y, "pen"), false);
    expect(state.view).toEqual(v1); // no pinch with the ghost
    expect(log.select).toEqual([{ id: null, how: "tap" }]);
  });
});

describe("hit testing", () => {
  const view: View = { scale: 0.1, tx: 0, ty: 0 };
  const ctx = (circles: CircleRow[], selectedId: string | null, pointerType: PointerKind = "mouse") => ({ view, page: PAGE, circles, selectedId, pointerType });

  it("the smallest circle containing the point wins", () => {
    const circles = [circle("big", 0.5, 0.5, 0.1), circle("small", 0.51, 0.5, 0.01)];
    expect(hitTest({ x: 408, y: 250 }, ctx(circles, null))).toEqual({ kind: "circle", id: "small", selected: false, grab: false });
    expect(hitTest({ x: 380, y: 250 }, ctx(circles, null))).toEqual({ kind: "circle", id: "big", selected: false, grab: false });
  });

  it("tiny circles get a finger-sized target on touch only", () => {
    const tiny = [circle("t", 0.5, 0.5, 0.0001)]; // 0.08 screen px
    expect(hitTest({ x: 418, y: 250 }, ctx(tiny, null, "touch")).kind).toBe("circle");
    expect(hitTest({ x: 418, y: 250 }, ctx(tiny, null, "mouse")).kind).toBe("paper");
  });

  it("handles and the grip of the selected circle come first; its body moves it while it's small", () => {
    const circles = [circle("a", 0.5, 0.5, 0.05)]; // centre (400, 250), R 40
    expect(hitTest({ x: 445, y: 250 }, ctx(circles, "a"))).toEqual({ kind: "handle", id: "a", dir: "e" });
    expect(hitTest({ x: 400, y: 212 }, ctx(circles, "a"))).toEqual({ kind: "handle", id: "a", dir: "n" });
    expect(hitTest({ x: 400, y: 250 }, ctx(circles, "a"))).toEqual({ kind: "grip", id: "a" });
    expect(hitTest({ x: 380, y: 262 }, ctx(circles, "a"))).toEqual({ kind: "circle", id: "a", selected: true, grab: true });
    expect(hitTest({ x: 445, y: 250 }, ctx(circles, null))).toEqual({ kind: "paper", onPage: true });
  });

  it("a big selected circle's body is for panning; only its grip and rim are for editing", () => {
    const circles = [circle("a", 0.5, 0.5, 0.0125)]; // centre (400, 250); at scale 1: R 100 > 90
    const big = { view: { scale: 1, tx: -3600, ty: -2250 }, page: PAGE, circles, selectedId: "a", pointerType: "touch" as const };
    expect(hitTest({ x: 400, y: 250 }, big)).toEqual({ kind: "grip", id: "a" });
    expect(hitTest({ x: 450, y: 250 }, big)).toEqual({ kind: "circle", id: "a", selected: true, grab: false });
    expect(hitTest({ x: 497, y: 250 }, big)).toEqual({ kind: "handle", id: "a", dir: "e" });
  });

  it("on a tiny selected circle the handles move out: a finger near the middle moves it (#12)", () => {
    // drawn at the 10 px minimum, like a circle added zoomed in, seen at Fit
    const tiny = [circle("a", 0.5, 0.5, 0.0005)];
    const touch = { ...ctx(tiny, "a", "touch"), coarse: true };
    for (const dx of [0, 5, 7, 12, 20]) expect(hitTest({ x: 400 + dx, y: 250 }, touch)).toEqual({ kind: "grip", id: "a" });
    expect(hitTest({ x: 400 + HANDLE_RING_MIN.coarse, y: 250 }, touch)).toEqual({ kind: "handle", id: "a", dir: "e" });
    expect(hitTest({ x: 400, y: 250 + HANDLE_RING_MIN.coarse + 10 }, touch)).toEqual({ kind: "handle", id: "a", dir: "s" });
    // a mouse on a desktop: a tighter ring, still clear of the grip
    expect(hitTest({ x: 412, y: 250 }, ctx(tiny, "a"))).toEqual({ kind: "grip", id: "a" });
    expect(hitTest({ x: 400 + HANDLE_RING_MIN.fine, y: 250 }, ctx(tiny, "a"))).toEqual({ kind: "handle", id: "a", dir: "e" });
  });

  it("a handle's or the grip's padding never steals a tap from another circle (#12)", () => {
    // B's centre is 26 px right of tiny selected A, inside A's grip and E-handle padding
    const circles = [circle("a", 0.5, 0.5, 0.0005), circle("b", 0.5 + 260 / 8000, 0.5, 0.0005)];
    const touch = { ...ctx(circles, "a", "touch"), coarse: true };
    expect(hitTest({ x: 426, y: 250 }, touch)).toEqual({ kind: "circle", id: "b", selected: false, grab: false });
    // …but right on the drawn dot or chip, they win
    expect(hitTest({ x: 400 + HANDLE_RING_MIN.coarse, y: 250 }, touch)).toEqual({ kind: "handle", id: "a", dir: "e" });
    expect(hitTest({ x: 410, y: 250 }, touch)).toEqual({ kind: "grip", id: "a" });
    // a zone the selected circle sits in doesn't take its handles away
    const zoned = [circle("zone", 0.5, 0.5, 0.1), circle("a", 0.5, 0.5, 0.0005)]; // zone: R 80 px
    const z = { ...ctx(zoned, "a", "touch"), coarse: true };
    expect(hitTest({ x: 400 + HANDLE_RING_MIN.coarse + 15, y: 250 }, z)).toEqual({ kind: "handle", id: "a", dir: "e" });
    expect(hitTest({ x: 400 + 18, y: 250 }, z)).toEqual({ kind: "grip", id: "a" });
  });
});

describe("view math", () => {
  it("interpolates a zoom about its fixed point exactly", () => {
    const a: View = { scale: 0.2, tx: 30, ty: -40 };
    const at = { x: 321, y: 123 };
    const b = zoomAt(a, at, 2, 0, 100);
    for (const t of [0.25, 0.5, 0.75]) {
      const v = interpolateView(a, b, t);
      expect(v.scale).toBeCloseTo(0.2 * Math.pow(2, t), 12);
      // the anchor never moves
      expect((at.x - v.tx) / v.scale).toBeCloseTo((at.x - a.tx) / a.scale, 9);
      expect((at.y - v.ty) / v.scale).toBeCloseTo((at.y - a.ty) / a.scale, 9);
    }
    expect(interpolateView(a, b, 1)).toEqual(b);
    const pan = interpolateView(a, { ...a, tx: 130 }, 0.5);
    expect(pan).toEqual({ scale: 0.2, tx: 80, ty: -40 });
  });

  it("limits are relative to fit", () => {
    const { min, max, fit } = scaleLimits(PAGE, SIZE);
    expect(fit).toBeCloseTo(Math.min(1000 / 8000, 700 / 5000) * 0.96, 12);
    expect(min).toBeCloseTo(fit / 2, 12);
    expect(max).toBe(3);
  });

  it("focus centres the circle in the uncovered area at ~35% of the short side", () => {
    const c = circle("a", 0.25, 0.75, 0.01); // r = 80 world px
    const v = focusView(PAGE, c, SIZE, { top: 0, right: 300 }, { scale: 0.1, tx: 0, ty: 0 }, { min: 0.05, max: 3 });
    expect(v.scale).toBeCloseTo((0.35 * 700) / 160, 9);
    expect(2000 * v.scale + v.tx).toBeCloseTo(350, 9);
    expect(3750 * v.scale + v.ty).toBeCloseTo(350, 9);
    // never zooms out more than 2× from where you are
    const huge = circle("h", 0.5, 0.5, 0.4);
    expect(focusView(PAGE, huge, SIZE, { top: 0, right: 0 }, { scale: 1, tx: 0, ty: 0 }, { min: 0.05, max: 3 }).scale).toBe(0.5);
  });

  it("a remembered view must still show the page", () => {
    expect(isSensibleView({ scale: 0.1, tx: 50, ty: 50 }, PAGE, SIZE)).toBe(true);
    expect(isSensibleView({ scale: 0.1, tx: 5000, ty: 50 }, PAGE, SIZE)).toBe(false);
    expect(isSensibleView({ scale: 100, tx: 0, ty: 0 }, PAGE, SIZE)).toBe(false);
    expect(isSensibleView(null, PAGE, SIZE)).toBe(false);
  });

  it("lists the tiles in view plus a margin, centre first", () => {
    const page = { ...PAGE, maxLevel: 4, tileSize: 512 };
    // full-res level (4) at scale 1: a 1000×700 window at the origin → cols 0–1, rows 0–1, plus a margin
    const tiles = visibleTiles(page, { scale: 1, tx: 0, ty: 0 }, SIZE, 4);
    expect(tiles.map((t) => t.key).sort()).toEqual(["4/0_0", "4/0_1", "4/0_2", "4/1_0", "4/1_1", "4/1_2", "4/2_0", "4/2_1", "4/2_2"]);
    expect(tiles[0].key).toBe("4/0_0"); // nearest the middle of the screen (500, 350)
    // edge tiles are cut to the level's size: level 0 is 500×313 px, one tile, 16× world px
    const one = visibleTiles(page, { scale: 0.1, tx: 0, ty: 0 }, SIZE, 0);
    expect(one).toEqual([{ key: "0/0_0", level: 0, col: 0, row: 0, x: 0, y: 0, w: 500 * 16, h: 313 * 16 }]);
  });

  // ── #2/#4/#11: revealing a circle from under the panel ──

  // page on screen: (100, 100)–(900, 600); a circle of r 0.005 is drawn at the 10 px minimum
  const V: View = { scale: 0.1, tx: 100, ty: 100 };
  const LIM = { min: 0.05, max: 3 };

  it("reveal pans a circle out from under the right panel by the least amount, same zoom", () => {
    const c = circle("c", 0.85, 0.5, 0.005); // screen (780, 350)
    const v = revealView(PAGE, c, SIZE, { top: 0, right: 340 }, V, LIM, false);
    // fine pointer: handles at 30 px, dots 6 px, then the 24 px margin → right edge 780 + 60 must be ≤ 660
    expect(v).toEqual({ scale: 0.1, tx: 100 - 180, ty: 100 });
    // a touch screen's handles sit further out (46 px), so it pans further
    expect(revealView(PAGE, c, SIZE, { top: 0, right: 340 }, V, LIM, true).tx).toBe(100 - 196);
    // already clear of the panel: the very same view (nothing to animate)
    const left = circle("l", 0.3, 0.5, 0.005);
    expect(revealView(PAGE, left, SIZE, { top: 0, right: 340 }, V, LIM, true)).toBe(V);
    // a circle off the left edge comes in from the left
    expect(revealView(PAGE, circle("o", 0, 0.5, 0.005), SIZE, { top: 0, right: 340 }, { ...V, tx: -50 }, LIM, false).tx).toBe(-50 + 110);
  });

  it("reveal keeps a circle above the phone's bottom sheet, badge included", () => {
    const c = circle("c", 0.5, 0.8, 0.005); // screen (500, 500)
    const v = revealView(PAGE, c, SIZE, { top: 0, right: 0, bottom: 420 }, V, LIM, true);
    // 280 px left above the sheet: bottom edge 500 + 52 + 24 → 280
    expect(v).toEqual({ scale: 0.1, tx: 100, ty: 100 - 296 });
    // the number badge rides 31 px above the handle ring: a circle near the top comes down to show it
    const top = revealView(PAGE, circle("t", 0.5, 0, 0.005), SIZE, { top: 0, right: 0 }, V, LIM, true);
    expect(top.ty).toBe(100 + (46 + 31 + 24 - 100));
  });

  it("reveal zooms out only when the circle can't fit, then centres it; never past the limits", () => {
    const big = circle("b", 0.5, 0.5, 0.05); // 400 px radius at scale 1
    const cur: View = { scale: 1, tx: -3500, ty: -2150 };
    const v = revealView(PAGE, big, SIZE, { top: 0, right: 340 }, cur, LIM, true);
    expect(v.scale).toBeLessThan(1);
    // its whole selection + margin now fits the 660 × 700 px left of the panel
    const R = 400 * v.scale;
    const sx = 4000 * v.scale + v.tx;
    const sy = 2500 * v.scale + v.ty;
    expect(sx - R - 7 - 24).toBeGreaterThanOrEqual(-1e-6);
    expect(sx + R + 7 + 24).toBeLessThanOrEqual(660 + 1e-6);
    expect(sy - R - 31 - 24).toBeGreaterThanOrEqual(-1e-6);
    expect(sy + R + 7 + 24).toBeLessThanOrEqual(700 + 1e-6);
    expect(sx).toBeCloseTo(330, 9); // centred across
    expect(revealView(PAGE, big, SIZE, { top: 0, right: 340 }, cur, { min: 0.9, max: 3 }, true).scale).toBe(0.9);
  });

  it("Fit ignores a bottom sheet that leaves under 40% of the height; focus and reveal don't", () => {
    const sheet = { top: 0, right: 0, bottom: 450 };
    expect(usableArea(SIZE, sheet)).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
    expect(fitInsets(PAGE, SIZE, sheet)).toEqual(fitInsets(PAGE, SIZE, { top: 0, right: 0 }));
    expect(visibleArea(SIZE, sheet)).toEqual({ x: 0, y: 0, w: 1000, h: 250 });
    const f = focusView(PAGE, circle("a", 0.5, 0.5, 0.01), SIZE, sheet, V, LIM);
    expect(2500 * f.scale + f.ty).toBeCloseTo(125, 9); // centred in the strip above the sheet
    // a smaller sheet counts for Fit too
    expect(usableArea(SIZE, { top: 0, right: 0, bottom: 200 })).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });

  // ── #26: a pinch fetches only the level it ends on ──

  const BIG_PAGE = {
    width: 8000,
    height: 5334,
    previewW: 2048,
    previewH: 1366,
    tileSize: 512,
    minLevel: 9,
    maxLevel: 13,
    status: "ready",
    assetKey: "k",
  } as PageRow;
  const STAGE = { w: 900, h: 764 };

  /** Mount tiles frame by frame like RasterLayer; every tile mounted unloaded is a request, and loads at once. */
  function runZoom(frames: View[], settleDuringBurst: boolean) {
    const loaded = new Set<string>();
    const requested: string[] = [];
    let held: number | null | undefined;
    frames.forEach((view, i) => {
      const settled = settleDuringBurst || i === 0 || i === frames.length - 1;
      const plan = planTiles(BIG_PAGE, view, STAGE, 2, settled, held, (t: TileBox) => (loaded.has(t.key) ? true : undefined));
      if (settled) held = plan.target;
      for (const t of plan.tiles) if (!loaded.has(t.key)) requested.push(t.key);
      for (const t of plan.tiles) loaded.add(t.key);
    });
    return { requested, final: frames.at(-1)! };
  }

  function pinch(fromScale: number, toScale: number, n = 60): View[] {
    const fit = fitInsets(BIG_PAGE, STAGE, { top: 0, right: 0 });
    const out: View[] = [];
    for (let i = 0; i <= n; i++) {
      const k = (fromScale * Math.pow(toScale / fromScale, i / n)) / fit.scale;
      out.push(zoomAt(fit, { x: 450, y: 382 }, k, 0, 100));
    }
    // the fingers stop: one more frame at the same view, after the settle delay
    out.push(out.at(-1)!);
    return out;
  }

  it("a pinch from Fit to 1000% fetches only the final level's tiles, not every level it passes", () => {
    const fit = fitInsets(BIG_PAGE, STAGE, { top: 0, right: 0 }).scale;
    const frames = pinch(fit, fit * 10);
    const before = runZoom(frames, true); // the old behaviour: the level followed every frame
    const after = runZoom(frames, false);
    const finalLevel = pickLevel(BIG_PAGE, before.final.scale, 2)!;
    const finalTiles = visibleTiles(BIG_PAGE, after.final, STAGE, finalLevel).map((t) => t.key);
    expect(new Set(after.requested.map((k) => k.split("/")[0]))).toEqual(new Set([String(finalLevel)]));
    expect(after.requested.sort()).toEqual([...finalTiles].sort());
    expect(before.requested.length).toBeGreaterThan(after.requested.length * 3);
  });

  it("zooming out fetches nothing mid-burst: the held level's loaded tiles stay up", () => {
    const fit = fitInsets(BIG_PAGE, STAGE, { top: 0, right: 0 }).scale;
    const frames = pinch(fit * 10, fit * 1.3);
    const after = runZoom(frames, false);
    const first = visibleTiles(BIG_PAGE, frames[0], STAGE, pickLevel(BIG_PAGE, frames[0].scale, 2)!).map((t) => t.key);
    const lastLevel = pickLevel(BIG_PAGE, frames.at(-1)!.scale, 2);
    const last = lastLevel === null ? [] : visibleTiles(BIG_PAGE, frames.at(-1)!, STAGE, lastLevel).map((t) => t.key);
    expect(after.requested.sort()).toEqual([...new Set([...first, ...last])].sort());
    // mid-burst, only the tiles already loaded are mounted
    const loaded = new Set(first);
    const mid = planTiles(BIG_PAGE, frames[30], STAGE, 2, false, 13, (t) => (loaded.has(t.key) ? true : undefined));
    expect(mid.target).toBe(13);
    expect(mid.tiles.every((t) => loaded.has(t.key))).toBe(true);
    expect(mid.complete).toBe(false);
  });
});

// ── the controller: revealCircle and insets (#2/#4/#11) ─────────────────

describe("canvas controller", () => {
  let frames: FrameRequestCallback[] = [];
  const saved: Record<string, unknown> = {};
  const g = globalThis as Record<string, unknown>;
  beforeEach(() => {
    frames = [];
    for (const k of ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "window"]) saved[k] = g[k];
    g.requestAnimationFrame = (fn: FrameRequestCallback) => frames.push(fn);
    g.cancelAnimationFrame = () => {};
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    // reduced motion: animations land at once, so a frame shows where they go
    g.window = { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) g[k] = v;
  });
  const flush = () => {
    for (let i = 0; i < 20 && frames.length; i++) frames.splice(0).forEach((f) => f(0));
  };

  const PG = { ...PAGE, previewW: 2048, previewH: 1280, tileSize: 512, minLevel: 0, maxLevel: 0, status: "ready", assetKey: "k" } as PageRow;
  function mount(circles: CircleRow[], extra: Partial<BlueprintCanvasProps> = {}) {
    let props: BlueprintCanvasProps = {
      page: PG,
      circles,
      selectedId: null,
      litId: null,
      mode: "move",
      onHover: () => {},
      onSelect: () => {},
      onAdd: () => {},
      onGesture: () => {},
      ...extra,
    };
    const ctl = new CanvasController(props);
    const el = {
      clientWidth: SIZE.w,
      clientHeight: SIZE.h,
      dataset: {} as Record<string, string>,
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    ctl.setCoarse(true); // an iPad: handles 46 px out
    ctl.attach(el as unknown as HTMLElement);
    flush();
    const set = (p: Partial<BlueprintCanvasProps>) => ctl.setProps((props = { ...props, ...p }));
    return { ctl, set, view: () => ctl.handle.getView() };
  }

  it("opening the panel (an inset change) never moves the view by itself", () => {
    const { set, view } = mount([circle("c", 0.85, 0.5, 0.005)]);
    const fit = view();
    set({ rightInset: 340, selectedId: "c" });
    flush();
    expect(view()).toEqual(fit);
    set({ rightInset: 0, bottomInset: 420 });
    flush();
    expect(view()).toEqual(fit);
  });

  it("revealCircle pans the selected circle out from under the panel, with the insets of the render that opened it", () => {
    const { ctl, set, view } = mount([circle("c", 0.85, 0.5, 0.005)]);
    const fit = view();
    // called before the panel's render reaches the canvas (e.g. from onAdd): it waits for the frame
    ctl.handle.revealCircle("c");
    set({ rightInset: 340, selectedId: "c" });
    flush();
    const v = view();
    expect(v.scale).toBe(fit.scale);
    expect(v.ty).toBe(fit.ty);
    const right = 0.85 * 8000 * v.scale + v.tx + 46 + 6 + 24;
    expect(right).toBeLessThanOrEqual(1000 - 340 + 1e-6);
    expect(right).toBeGreaterThan(1000 - 340 - 1); // the least pan that does it
    // already in view: nothing moves
    ctl.handle.revealCircle("c");
    flush();
    expect(view()).toEqual(v);
  });

  it("revealCircle waits for a circle that's still on its way", () => {
    const { ctl, set, view } = mount([]);
    const fit = view();
    ctl.handle.revealCircle("new");
    set({ rightInset: 340 });
    flush();
    expect(view()).toEqual(fit);
    set({ circles: [circle("new", 0.9, 0.5, 0.005)], selectedId: "new" });
    flush();
    expect(view().tx).toBeLessThan(fit.tx);
  });
});
