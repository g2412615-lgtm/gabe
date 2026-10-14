// Copying circles onto other pages of the plan: the store's pasteCircles
// (one undo step, saved in one go, numbered in order) and the editor's
// helpers that decide what a copy carries and where it lands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circleClipFor, clearCircleClip, copyOf, NUDGE, placeCopies, setCircleClip } from "../../src/client/editor/copyCircles";
import type { CircleRow, CommentRow } from "../../src/shared/types";
import type { CircleCopy } from "../../src/client/sync";
import { DEBOUNCE_MS } from "../../src/client/sync/store";
import { device, FakeServer, settle } from "./fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearCircleClip();
});

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

async function open(server = new FakeServer({ pages: 3 })) {
  const d = device(server);
  await d.store.load();
  const pages = d.store.getState().pages;
  return { ...d, server, pages };
}

const copy = (over: Partial<CircleCopy> = {}): CircleCopy => ({ x: 0.3, y: 0.4, r: 0.02, color: "red", title: "Gate B", comments: [], ...over });

describe("pasteCircles", () => {
  it("makes the copies with their comments, saved in one request and numbered in order", async () => {
    const d = await open();
    const [, p2] = d.pages;
    const ids = d.store.pasteCircles([
      { ...copy({ title: "Gate B", comments: ["Mag line, 4 staff", "Barricade check"] }), pageId: p2.id },
      { ...copy({ x: 0.7, y: 0.2, color: "blue", title: "" }), pageId: p2.id },
    ]);
    expect(ids).toHaveLength(2);

    const st = d.store.getState();
    expect(st.circlesByPage.get(p2.id)!.map((c) => c.id)).toEqual(ids);
    expect(st.circleById.get(ids[0])).toMatchObject({ pageId: p2.id, x: 0.3, y: 0.4, r: 0.02, color: "red", title: "Gate B" });
    expect(st.circleById.get(ids[1])).toMatchObject({ x: 0.7, y: 0.2, color: "blue", title: "" });
    expect(st.commentsByCircle.get(ids[0])!.map((c) => c.body)).toEqual(["Mag line, 4 staff", "Barricade check"]);
    expect(st.commentsByCircle.get(ids[1])).toEqual([]);

    await tick(DEBOUNCE_MS);
    expect(d.server.received).toHaveLength(1);
    expect(d.server.received[0].map((op) => op.kind)).toEqual(["circle", "circle", "comment", "comment"]);
    expect(ids.map((id) => d.server.circles.get(id)!.num)).toEqual([1, 2]);
    expect([...d.server.comments.values()].filter((c) => c.circleId === ids[0]).map((c) => c.body)).toEqual(["Mag line, 4 staff", "Barricade check"]);
    expect(d.store.hasUnsaved()).toBe(false);
  });

  it("is one undo step: undo takes every copy away (nothing reaches the server), redo brings them back", async () => {
    const d = await open();
    const [, p2, p3] = d.pages;
    const ids = d.store.pasteCircles([
      { ...copy({ comments: ["Note"] }), pageId: p2.id },
      { ...copy({ comments: ["Note"] }), pageId: p3.id },
    ]);
    d.store.undo();
    let st = d.store.getState();
    expect(ids.some((id) => st.circleById.has(id))).toBe(false);
    expect(d.store.hasUnsaved()).toBe(false); // never sent: nothing to tell the server, no numbers used up
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.size).toBe(0);

    d.store.redo();
    st = d.store.getState();
    expect(ids.every((id) => st.circleById.has(id))).toBe(true);
    expect(st.commentsByCircle.get(ids[1])!.map((c) => c.body)).toEqual(["Note"]);
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.size).toBe(2);
    expect(d.server.comments.size).toBe(2);
    expect(d.server.circleSeq).toBe(2);
  });

  it("undo after the copies were saved deletes them on the server too", async () => {
    const d = await open();
    const ids = d.store.pasteCircles([{ ...copy(), pageId: d.pages[1].id }]);
    await tick(DEBOUNCE_MS);
    d.store.undo();
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(ids[0])!.deletedAt).not.toBeNull();
  });

  it("cleans what it's given and skips pages that aren't live", async () => {
    const d = await open();
    const [p1, p2, p3] = d.pages;
    d.store.deletePage(p3.id);
    const ids = d.store.pasteCircles([
      { ...copy({ x: 1.4, y: -2, r: 9, color: "nope" as never, title: "a\u0000b", comments: ["  ", "kept"] }), pageId: p2.id },
      { ...copy(), pageId: p3.id }, // deleted
      { ...copy(), pageId: "no-such-page" },
    ]);
    expect(ids).toHaveLength(1);
    const c = d.store.getState().circleById.get(ids[0])!;
    expect(c).toMatchObject({ x: 1, y: 0, r: 0.5, color: "gold", title: "ab" });
    expect(d.store.getState().commentsByCircle.get(ids[0])!.map((m) => m.body)).toEqual(["kept"]);
    expect(d.store.pasteCircles([])).toEqual([]);
    expect(d.store.getState().circlesByPage.get(p1.id)).toEqual([]);
  });

  it("ends a drag still open, so the copy is a step of its own", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pages[0].id, x: 0.1, y: 0.1, r: 0.02 });
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.2 }, { live: true });
    const [copyId] = d.store.pasteCircles([{ ...copy(), pageId: d.pages[1].id }]);
    d.store.undo(); // the copy
    expect(d.store.getState().circleById.has(copyId)).toBe(false);
    expect(d.store.getState().circleById.get(id)!.x).toBe(0.2);
    d.store.undo(); // the drag
    expect(d.store.getState().circleById.get(id)!.x).toBe(0.1);
  });
});

// ── the editor's helpers ───────────────────────────────────────────────

const circle = (over: Partial<CircleRow> = {}): CircleRow => ({
  id: "c1",
  planId: "p",
  pageId: "pg1",
  x: 0.3,
  y: 0.4,
  r: 0.02,
  color: "green",
  title: "Medical",
  num: 4,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  ...over,
});
const comment = (body: string): CommentRow => ({ id: body, planId: "p", circleId: "c1", body, createdAt: 1, updatedAt: 1, deletedAt: null, rev: 1 });

describe("copyOf", () => {
  it("carries place, size, colour, name and the comments' text (blank ones left out)", () => {
    expect(copyOf(circle(), [comment("First aid"), comment("  "), comment("AED by the door")], true)).toEqual({
      x: 0.3,
      y: 0.4,
      r: 0.02,
      color: "green",
      title: "Medical",
      comments: ["First aid", "AED by the door"],
    });
  });
  it("without comments when asked", () => {
    expect(copyOf(circle(), [comment("First aid")], false).comments).toEqual([]);
  });
});

describe("placeCopies", () => {
  const page = { id: "pg2", width: 7200, height: 4800 };

  it("keeps each copy's spot on a page with nothing in the way", () => {
    const placed = placeCopies([copy(), copy({ x: 0.8, y: 0.9 })], page, []);
    expect(placed.map((p) => [p.pageId, p.x, p.y])).toEqual([
      ["pg2", 0.3, 0.4],
      ["pg2", 0.8, 0.9],
    ]);
  });

  it("steps the whole group down and right, the same distance across and down, until none covers a circle", () => {
    const existing = [circle({ x: 0.3, y: 0.4 })];
    const placed = placeCopies([copy(), copy({ x: 0.5, y: 0.5 })], page, existing);
    const dx = NUDGE; // the long side is the width
    const dy = (NUDGE * 7200) / 4800;
    expect(placed[0].x).toBeCloseTo(0.3 + dx, 9);
    expect(placed[0].y).toBeCloseTo(0.4 + dy, 9);
    expect(placed[1].x).toBeCloseTo(0.5 + dx, 9); // the layout is kept
    expect(placed[1].y).toBeCloseTo(0.5 + dy, 9);

    // pasted a second time: two steps
    const again = placeCopies([copy()], page, [...existing, circle({ x: placed[0].x, y: placed[0].y })]);
    expect(again[0].x).toBeCloseTo(0.3 + 2 * dx, 9);
  });

  it("stays on the page", () => {
    const placed = placeCopies([copy({ x: 1, y: 1 })], page, [circle({ x: 1, y: 1 })]);
    expect(placed[0].x).toBeLessThanOrEqual(1);
    expect(placed[0].y).toBeLessThanOrEqual(1);
  });
});

describe("the ⌘C clipboard", () => {
  it("pastes only within its plan, and holds a snapshot", () => {
    const item = copy({ comments: ["a"] });
    setCircleClip({ planId: "plan-a", pageId: "pg1", items: [item] });
    item.comments.push("changed later");
    item.title = "changed later";
    expect(circleClipFor("plan-b")).toBeNull();
    expect(circleClipFor("plan-a")!.items).toEqual([copy({ comments: ["a"] })]);
  });
});
