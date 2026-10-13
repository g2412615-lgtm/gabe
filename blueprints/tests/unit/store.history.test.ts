// Undo/redo through the store, gestures (drag/resize as one step), comment
// typing coalescing, and the page/plan actions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COALESCE_IDLE_MS } from "../../src/client/sync/history";
import { DEBOUNCE_MS, GESTURE_IDLE_MS, MAX_WAIT_MS } from "../../src/client/sync/store";
import { device, FakeServer, settle } from "./fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

async function open(server = new FakeServer({ pages: 4 })) {
  const d = device(server);
  await d.store.load();
  return { ...d, server, pageId: d.store.getState().pages[0].id };
}

const live = (d: Awaited<ReturnType<typeof open>>) => d.store.getState();

describe("undo / redo", () => {
  it("add → undo hides it → redo brings it back under the same id", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.num).toBe(1);
    d.store.undo();
    expect(live(d).circleById.has(id)).toBe(false);
    expect(live(d).canRedo).toBe(true);
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.deletedAt).not.toBeNull();
    d.store.redo();
    expect(live(d).circleById.get(id)!.num).toBe(1); // the server's number stays
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.deletedAt).toBeNull();
    expect(d.server.circleSeq).toBe(1);
  });

  it("move → undo → redo", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.updateCircle(id, { x: 0.5, y: 0.6 });
    d.store.updateCircle(id, { r: 0.1 });
    d.store.undo();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.5, y: 0.6, r: 0.05 });
    d.store.undo();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.2, y: 0.2 });
    d.store.redo();
    d.store.redo();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.5, y: 0.6, r: 0.1 });
    expect(live(d).canRedo).toBe(false);
  });

  it("delete → undo restores the circle with its comments; restoreCircle (toast Undo) does the same", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.addComment(id, "Medical tent");
    await tick(DEBOUNCE_MS);
    d.store.deleteCircle(id);
    expect(live(d).circleById.has(id)).toBe(false);
    expect(live(d).commentsByCircle.has(id)).toBe(false);
    d.store.undo();
    expect(live(d).commentsByCircle.get(id)!.map((m) => m.body)).toEqual(["Medical tent"]);
    d.store.deleteCircle(id);
    d.store.restoreCircle(id);
    expect(live(d).circleById.has(id)).toBe(true);
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.deletedAt).toBeNull();
  });

  it("a new action clears redo", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.updateCircle(id, { color: "red" });
    d.store.undo();
    d.store.updateCircle(id, { color: "blue" });
    expect(live(d).canRedo).toBe(false);
  });

  it("undo after a server merge keeps server-owned fields and the other device's edits", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.updateCircle(id, { x: 0.8 });
    await tick(DEBOUNCE_MS);
    d.server.edit("circle", id, { color: "purple", title: "VIP lot" }); // the iPad
    await d.store.pull();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.8, color: "purple", num: 1 });

    d.store.undo(); // undo the move only
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.2, color: "purple", title: "VIP lot", num: 1 });
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)).toMatchObject({ x: 0.2, color: "purple", title: "VIP lot" });
  });

  it("undo while a request is out, then the reply lands: the undone value is kept and saved next", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.net.hold = true;
    d.store.updateCircle(id, { x: 0.9 });
    await tick(DEBOUNCE_MS);
    d.store.undo();
    d.net.held[0].reply();
    await settle();
    expect(live(d).circleById.get(id)!.x).toBe(0.2);
    d.net.hold = false;
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.x).toBe(0.2);
    expect(live(d).save.state).toBe("saved");
  });

  it("steps whose row was refused are skipped", async () => {
    const d = await open();
    const page2 = live(d).pages[1].id;
    const a = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const doomed = d.store.addCircle({ pageId: page2, x: 0.2, y: 0.2, r: 0.05 });
    d.server.pages.delete(page2);
    await tick(DEBOUNCE_MS);
    d.store.undo(); // the doomed add is gone → this undoes the first add
    expect(live(d).circleById.has(a)).toBe(false);
    expect(live(d).circleById.has(doomed)).toBe(false);
  });
});

describe("gestures", () => {
  it("live updates between begin/end make one undo step and one save at the end", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    const saves = d.net.syncs.length;
    d.store.beginGesture();
    for (let i = 1; i <= 30; i++) {
      d.store.updateCircle(id, { x: 0.2 + i * 0.01, y: 0.2 + i * 0.005 }, { live: true });
      await tick(100);
    }
    expect(d.net.syncs.length).toBe(saves); // nothing half-way goes out
    expect(live(d).save.pending).toBe(1);
    d.store.endGesture();
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs.length).toBe(saves + 1);
    expect(d.server.circles.get(id)).toMatchObject({ x: 0.5, y: 0.35 });
    d.store.undo();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.2, y: 0.2 });
    d.store.undo(); // the add
    expect(live(d).circleById.has(id)).toBe(false);
  });

  it("a resize slider (begin/live/end) is one step too", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.beginGesture();
    for (const r of [0.06, 0.07, 0.08]) d.store.updateCircle(id, { r }, { live: true });
    d.store.endGesture();
    d.store.undo();
    expect(live(d).circleById.get(id)!.r).toBe(0.05);
  });

  it("cancelGesture puts the pre-gesture position back with no step and nothing to save", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.6 }, { live: true });
    d.store.cancelGesture(); // a second finger landed
    expect(live(d).circleById.get(id)!.x).toBe(0.2);
    expect(live(d).save.state).toBe("saved");
    d.store.undo(); // undoes the add, not a phantom move
    expect(live(d).circleById.has(id)).toBe(false);
  });

  it("a tap (begin/end with no movement) makes no step", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.beginGesture();
    d.store.endGesture();
    d.store.undo();
    expect(live(d).circleById.has(id)).toBe(false);
  });

  it("a sync reply landing mid-gesture keeps the live position and takes the server's number", async () => {
    const d = await open();
    d.net.hold = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.4 }, { live: true });
    d.net.held[0].reply();
    await settle();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.4, num: 1 });
    d.store.updateCircle(id, { x: 0.45 }, { live: true });
    d.store.endGesture();
    d.net.hold = false;
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.x).toBe(0.45);
    d.store.undo();
    expect(live(d).circleById.get(id)).toMatchObject({ x: 0.2, num: 1 });
  });

  it("a commit landing mid-gesture (blur on pointerdown) keeps the gesture's base", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(id, "Draft");
    d.store.beginGesture();
    d.store.updateComment(m, "Draft — final"); // the comment box blurs as the drag starts
    d.store.updateCircle(id, { x: 0.3 }, { live: true });
    d.store.updateCircle(id, { x: 0.35 }, { live: true });
    d.store.endGesture();
    d.store.undo(); // the drag
    expect(live(d).circleById.get(id)!.x).toBe(0.2);
    expect(live(d).commentsByCircle.get(id)![0].body).toBe("Draft — final");
  });

  it("undo during a gesture first commits the gesture, then undoes it", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.7 }, { live: true });
    d.store.undo();
    expect(live(d).circleById.get(id)!.x).toBe(0.2);
    d.store.redo();
    expect(live(d).circleById.get(id)!.x).toBe(0.7);
  });

  it("live updates without a gesture save but make no undo step", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.updateCircle(id, { r: 0.09 }, { live: true });
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.r).toBe(0.09);
    d.store.undo(); // the add
    expect(live(d).circleById.has(id)).toBe(false);
  });

  it("a gesture the canvas never ends (lost pointer event) ends by itself after 15 s idle and saves", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.4 }, { live: true });
    await tick(GESTURE_IDLE_MS - 1000);
    expect(d.server.circles.get(id)!.x).toBe(0.2); // still a gesture
    d.store.updateCircle(id, { x: 0.45 }, { live: true }); // activity resets the clock
    await tick(GESTURE_IDLE_MS - 1000);
    expect(d.server.circles.get(id)!.x).toBe(0.2);
    await tick(1000 + DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.x).toBe(0.45);
    d.store.undo();
    expect(live(d).circleById.get(id)!.x).toBe(0.2); // still one step
  });

  it("the page going away mid-drag still sends the live position", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.55 }, { live: true });
    d.env.hide();
    await settle();
    expect(d.server.circles.get(id)!.x).toBe(0.55);
  });
});

describe("comment typing", () => {
  it("typing into a new comment is one undo step; undo removes the whole comment", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(c, "G");
    for (const text of ["Ga", "Gat", "Gate", "Gate 4", "Gate 4 opens at 5"]) {
      await tick(200);
      d.store.updateComment(m, text);
    }
    expect(live(d).commentsByCircle.get(c)![0].body).toBe("Gate 4 opens at 5");
    d.store.undo();
    expect(live(d).commentsByCircle.get(c)).toEqual([]);
    expect(live(d).circleById.has(c)).toBe(true);
    d.store.redo();
    expect(live(d).commentsByCircle.get(c)![0].body).toBe("Gate 4 opens at 5");
  });

  it("a pause of 3 s or another action starts a new step", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(c, "One");
    await tick(500);
    d.store.updateComment(m, "One two");
    await tick(COALESCE_IDLE_MS + 10);
    d.store.updateComment(m, "One two three");
    d.store.undo();
    expect(live(d).commentsByCircle.get(c)![0].body).toBe("One two");

    const m2 = d.store.addComment(c, "Other");
    d.store.updateComment(m, "One two again"); // back to the first comment: new step
    d.store.undo();
    expect(live(d).commentsByCircle.get(c)!.map((x) => x.body)).toEqual(["One two", "Other"]);
    d.store.undo();
    expect(live(d).commentsByCircle.get(c)!.map((x) => x.id)).toEqual([m]);
    expect(m2).toBeTruthy();
  });

  it("delete / restore a comment", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(c, "Lost and found");
    await tick(DEBOUNCE_MS);
    d.store.deleteComment(m);
    expect(live(d).commentsByCircle.get(c)).toEqual([]);
    await tick(DEBOUNCE_MS);
    expect(d.server.comments.get(m)!.deletedAt).not.toBeNull();
    d.store.restoreComment(m);
    await tick(DEBOUNCE_MS);
    expect(d.server.comments.get(m)!.deletedAt).toBeNull();
  });

  it("a comment erased right after it was created never reaches the server", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    const m = d.store.addComment(c, "x");
    d.store.deleteComment(m);
    await tick(MAX_WAIT_MS);
    expect(d.server.comments.has(m)).toBe(false);
    expect(live(d).save.state).toBe("saved");
  });

  it("title typing coalesces too", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.updateCircle(c, { title: "N" });
    d.store.updateCircle(c, { title: "No" });
    d.store.updateCircle(c, { title: "North" });
    d.store.undo();
    expect(live(d).circleById.get(c)!.title).toBe("");
  });
});

describe("pages and plan", () => {
  it("movePage puts the page between its neighbours (first − 1, last + 1, midpoints)", async () => {
    const d = await open();
    const ids = live(d).pages.map((p) => p.id); // sortOrder 1, 2, 3, 4
    d.store.movePage(ids[3], 0);
    expect(live(d).pages.map((p) => p.id)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    expect(live(d).pageById.get(ids[3])!.sortOrder).toBe(0);
    d.store.movePage(ids[0], 3);
    expect(live(d).pageById.get(ids[0])!.sortOrder).toBe(4);
    d.store.movePage(ids[2], 1);
    expect(live(d).pages.map((p) => p.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(live(d).pageById.get(ids[2])!.sortOrder).toBe(1);
    d.store.movePage(ids[2], 1); // no-op
    d.store.undo();
    expect(live(d).pages.map((p) => p.id)).toEqual([ids[3], ids[1], ids[2], ids[0]]);
    await tick(DEBOUNCE_MS);
    expect([...d.server.pages.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id)).toEqual([ids[3], ids[1], ids[2], ids[0]]);
  });

  it("movePage renumbers when there's no room left between neighbours", async () => {
    const server = new FakeServer({ pages: 3 });
    for (const p of server.pages.values()) p.sortOrder = 1; // ties
    const d = await open(server);
    const ids = live(d).pages.map((p) => p.id);
    d.store.movePage(ids[2], 1);
    expect(live(d).pages.map((p) => p.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(live(d).pages.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
    d.store.undo(); // one step
    expect(live(d).pages.map((p) => p.sortOrder)).toEqual([1, 1, 1]);
  });

  it("deletePage hides its circles and comments; restorePage brings them back", async () => {
    const d = await open();
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.addComment(c, "Ramp");
    await tick(DEBOUNCE_MS);
    d.store.deletePage(d.pageId);
    expect(live(d).pages.map((p) => p.id)).not.toContain(d.pageId);
    expect(live(d).circleById.has(c)).toBe(false);
    await tick(DEBOUNCE_MS);
    expect(d.server.pages.get(d.pageId)!.deletedAt).not.toBeNull();
    expect(d.server.circles.get(c)!.deletedAt).toBeNull(); // children untouched
    d.store.restorePage(d.pageId);
    expect(live(d).circleById.has(c)).toBe(true);
    expect(live(d).commentsByCircle.get(c)!.length).toBe(1);
  });

  it("renamePage / renamePlan trim, ignore blanks and save", async () => {
    const d = await open();
    const originalName = live(d).plan!.name;
    d.store.renamePage(d.pageId, "  A-101   Seating bowl ");
    d.store.renamePage(d.pageId, "   ");
    d.store.renamePlan("Home opener — final");
    expect(live(d).pages[0].label).toBe("A-101 Seating bowl");
    expect(live(d).plan!.name).toBe("Home opener — final");
    await tick(DEBOUNCE_MS);
    expect(d.server.pages.get(d.pageId)!.label).toBe("A-101 Seating bowl");
    expect(d.server.plan.name).toBe("Home opener — final");
    d.store.undo();
    expect(live(d).plan!.name).toBe(originalName);
    d.store.undo(); // the blank rename was a no-op, so this undoes the label
    expect(live(d).pages[0].label).toBe("Page 1");
  });

  it("bumps rev on every local change, not on server merges", async () => {
    const d = await open();
    const r0 = live(d).rev;
    const c = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    expect(live(d).rev).toBe(r0 + 1);
    await tick(DEBOUNCE_MS);
    expect(live(d).rev).toBe(r0 + 1);
    d.store.updateCircle(c, { x: 0.3 });
    expect(live(d).rev).toBe(r0 + 2);
  });
});
