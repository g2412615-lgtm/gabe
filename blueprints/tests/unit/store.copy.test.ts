// Copying circles onto other pages of the plan: the store's pasteCircles
// (one undo step, saved in one go, numbered in order) and the editor's
// helpers that decide what a copy carries and where it lands.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circleClipFor, clearCircleClip, copyOf, NUDGE, placeCopies, setCircleClip } from "../../src/client/editor/copyCircles";
import type { CircleRow, CommentRow } from "../../src/shared/types";
import type { CircleCopy } from "../../src/client/sync";
import { utf8Length } from "../../src/client/sync/clean";
import { DEBOUNCE_MS, MAX_REQUEST_BYTES } from "../../src/client/sync/store";
import { MAX_SYNC_BYTES } from "../../src/server/sync";
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

  it("a big copy of long comments saves in requests the server takes (each under its 2 MB limit), comments after their circles", async () => {
    expect(MAX_REQUEST_BYTES).toBeLessThan(MAX_SYNC_BYTES);
    const d = await open();
    // 120 circles, each with a full-length note of 2-byte characters: ~2.4 MB in all, under 500 ops
    const note = "é".repeat(10_000);
    const items = Array.from({ length: 120 }, (_, i) => ({ ...copy({ x: (i % 12) / 12, y: Math.floor(i / 12) / 10, comments: [note] }), pageId: d.pages[1].id }));
    const ids = d.store.pasteCircles(items);
    await tick(DEBOUNCE_MS);
    for (let i = 0; i < 10 && d.store.hasUnsaved(); i++) await tick(10);

    const sizes = d.net.syncs.map((r) => utf8Length(JSON.stringify({ ops: r.ops })));
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(d.store.hasUnsaved()).toBe(false);
    expect(d.store.getState().save.state).toBe("saved");
    expect(ids.every((id) => d.server.circles.get(id)!.num > 0)).toBe(true);
    expect([...d.server.comments.values()].filter((c) => c.body === note)).toHaveLength(120);
    // a comment never goes out before its circle's create
    const sentAt = new Map<string, number>();
    d.net.syncs.forEach((r, i) => r.ops.forEach((op) => sentAt.set(op.id, i)));
    for (const c of d.server.comments.values()) expect(sentAt.get(c.id)!).toBeGreaterThanOrEqual(sentAt.get(c.circleId)!);
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

  it("in the bottom-right corner it steps up and left instead — still clear, still on the page", () => {
    const placed = placeCopies([copy({ x: 1, y: 1 })], page, [circle({ x: 1, y: 1 })]);
    expect(placed[0].x).toBeCloseTo(1 - NUDGE, 9);
    expect(placed[0].y).toBeCloseTo(1 - (NUDGE * 7200) / 4800, 9);
  });

  it("pasted again and again near an edge, every copy lands on a spot of its own", () => {
    const existing = [circle({ x: 0.99, y: 0.985 })];
    for (let i = 0; i < 4; i++) {
      const [p] = placeCopies([copy({ x: 0.99, y: 0.985 })], page, existing);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
      expect(existing.some((c) => Math.abs(c.x - p.x) < 1e-4 && Math.abs(c.y - p.y) < 1e-4)).toBe(false);
      existing.push(circle({ id: `c${i + 2}`, x: p.x, y: p.y }));
    }
  });

  it("a group filling the page, pasted onto it again and again: once one side's room is used up it tries the other", () => {
    const square = { id: "pg3", width: 1000, height: 1000 };
    // (a) room on both sides: +0.02, +0.04, +0.05, then −0.02, −0.04, −0.05 — six clear pastes
    const group = [copy({ x: 0.05, y: 0.05 }), copy({ x: 0.95, y: 0.95 }), copy({ x: 0.5, y: 0.3 })];
    const existing = group.map((g, i) => circle({ id: `a${i}`, x: g.x, y: g.y }));
    for (let n = 0; n < 6; n++) {
      const placed = placeCopies(group, square, existing);
      for (const p of placed) expect(existing.some((c) => Math.abs(c.x - p.x) < 1e-4 && Math.abs(c.y - p.y) < 1e-4)).toBe(false);
      placed.forEach((p, i) => existing.push(circle({ id: `a${n}-${i}`, x: p.x, y: p.y })));
    }
    // (b) a sliver of room on each side: the second paste uses the other sliver
    const edge = [copy({ x: 0.01, y: 0.01 }), copy({ x: 0.995, y: 0.995 })];
    const there = edge.map((g, i) => circle({ id: `b${i}`, x: g.x, y: g.y }));
    for (let n = 0; n < 2; n++) {
      const placed = placeCopies(edge, square, there);
      for (const p of placed) expect(there.some((c) => Math.abs(c.x - p.x) < 1e-4 && Math.abs(c.y - p.y) < 1e-4)).toBe(false);
      placed.forEach((p, i) => there.push(circle({ id: `b${n}-${i}`, x: p.x, y: p.y })));
    }
  });

  it("a group by the edge keeps its layout: it moves only as far as the page has room", () => {
    const group = [copy({ x: 0.985, y: 0.975 }), copy({ x: 0.3, y: 0.4 }), copy({ x: 0.5, y: 0.2 })];
    const existing = group.map((g, i) => circle({ id: `g${i}`, x: g.x, y: g.y }));
    const placed = placeCopies(group, page, existing);
    const sx = placed[0].x - group[0].x;
    const sy = placed[0].y - group[0].y;
    expect(Math.abs(sx) + Math.abs(sy)).toBeGreaterThan(0);
    placed.forEach((p, i) => {
      expect(p.x - group[i].x).toBeCloseTo(sx, 9);
      expect(p.y - group[i].y).toBeCloseTo(sy, 9);
    });
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
