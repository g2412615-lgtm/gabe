// The canvas's pure parts: the gesture state machine (with a fake host and
// clock), hit testing and the view math. The real-browser behaviour is in
// tests/e2e/canvas.spec.ts.

import { describe, expect, it } from "vitest";
import { DEFAULT_CIRCLE_SCREEN_R, MAX_CIRCLE_R } from "../../src/shared/constants";
import { zoomAt, type Pt, type View } from "../../src/shared/geometry";
import type { CircleRow } from "../../src/shared/types";
import { GestureMachine, LONG_PRESS_MS, type Clock, type GestureHost, type PointerSample } from "../../src/client/editor/canvas/gestures";
import { hitTest, type Hit } from "../../src/client/editor/canvas/hitTest";
import type { CanvasGestureEvent, CanvasMode, PointerKind } from "../../src/client/editor/canvas/types";
import { focusView, interpolateView, isSensibleView, scaleLimits, visibleTiles } from "../../src/client/editor/canvas/viewMath";

const PAGE = { width: 8000, height: 5000 };
const SIZE = { w: 1000, h: 700 };

function circle(id: string, x: number, y: number, r: number): CircleRow {
  return { id, planId: "p", pageId: "pg", x, y, r, color: "amber", title: "", num: 1, createdAt: 0, updatedAt: 0, deletedAt: null, rev: 1 };
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

/** A canvas without a DOM: records what the machine asks for. */
function setup(opts: { mode?: CanvasMode; selectedId?: string | null; circles?: CircleRow[]; view?: View } = {}) {
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
  };
  const host: GestureHost = {
    view: () => state.view,
    setView: (v) => void (state.view = v),
    limits: () => ({ min: 0.01, max: 10 }),
    mode: () => state.mode,
    page: () => PAGE,
    hitTest: (pt: Pt, type: PointerKind): Hit => hitTest(pt, { view: state.view, page: PAGE, circles: state.circles, selectedId: state.selectedId, pointerType: type }),
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
    draft: () => {},
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
});

describe("hit testing", () => {
  const view: View = { scale: 0.1, tx: 0, ty: 0 };
  const ctx = (circles: CircleRow[], selectedId: string | null, pointerType: PointerKind = "mouse") => ({ view, page: PAGE, circles, selectedId, pointerType });

  it("the smallest circle containing the point wins", () => {
    const circles = [circle("big", 0.5, 0.5, 0.1), circle("small", 0.51, 0.5, 0.01)];
    expect(hitTest({ x: 408, y: 250 }, ctx(circles, null))).toEqual({ kind: "circle", id: "small", selected: false });
    expect(hitTest({ x: 380, y: 250 }, ctx(circles, null))).toEqual({ kind: "circle", id: "big", selected: false });
  });

  it("tiny circles get a finger-sized target on touch only", () => {
    const tiny = [circle("t", 0.5, 0.5, 0.0001)]; // 0.08 screen px
    expect(hitTest({ x: 418, y: 250 }, ctx(tiny, null, "touch")).kind).toBe("circle");
    expect(hitTest({ x: 418, y: 250 }, ctx(tiny, null, "mouse")).kind).toBe("paper");
  });

  it("handles of the selected circle come first; its middle still moves it", () => {
    const circles = [circle("a", 0.5, 0.5, 0.05)]; // centre (400, 250), R 40
    expect(hitTest({ x: 445, y: 250 }, ctx(circles, "a"))).toEqual({ kind: "handle", id: "a", dir: "e" });
    expect(hitTest({ x: 400, y: 212 }, ctx(circles, "a"))).toEqual({ kind: "handle", id: "a", dir: "n" });
    expect(hitTest({ x: 400, y: 250 }, ctx(circles, "a"))).toEqual({ kind: "circle", id: "a", selected: true });
    expect(hitTest({ x: 445, y: 250 }, ctx(circles, null))).toEqual({ kind: "paper", onPage: true });
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
});
