// Store state plumbing: notifications, identity, memoized slices, and a
// performance guard for big plans.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS } from "../../src/client/sync/store";
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

describe("state plumbing", () => {
  it("notifies once per action and keeps the same state object when nothing changed", async () => {
    const server = new FakeServer();
    const d = device(server);
    await d.store.load();
    const pageId = d.store.getState().pages[0].id;
    let calls = 0;
    const off = d.store.subscribe(() => calls++);
    const s0 = d.store.getState();
    expect(d.store.getState()).toBe(s0);

    d.store.addCircle({ pageId, x: 0.5, y: 0.5, r: 0.05 });
    expect(calls).toBe(1);
    const s1 = d.store.getState();
    expect(s1).not.toBe(s0);
    expect(s1.pages).toBe(s0.pages); // untouched slices keep their identity
    expect(d.store.getState()).toBe(s1);

    d.store.renamePlan(s1.plan!.name); // no change → no notification
    expect(calls).toBe(1);
    off();
    d.store.addCircle({ pageId, x: 0.2, y: 0.2, r: 0.05 });
    expect(calls).toBe(1);
  });

  it("save info keeps its identity while it doesn't change", async () => {
    const server = new FakeServer();
    const d = device(server);
    await d.store.load();
    const pageId = d.store.getState().pages[0].id;
    const id = d.store.addCircle({ pageId, x: 0.5, y: 0.5, r: 0.05 });
    const save1 = d.store.getState().save;
    d.store.updateCircle(id, { x: 0.6 });
    expect(d.store.getState().save).toBe(save1); // still pending, 1 row
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save).not.toBe(save1);
  });

  it("a listener that throws doesn't break the engine", async () => {
    const server = new FakeServer();
    const d = device(server);
    await d.store.load();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    d.store.subscribe(() => {
      throw new Error("render bug");
    });
    const id = d.store.addCircle({ pageId: d.store.getState().pages[0].id, x: 0.5, y: 0.5, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(id)!.num).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("big plans", () => {
  it("dragging one circle among 1,500 stays cheap and leaves other pages' arrays alone", async () => {
    const server = new FakeServer({ pages: 6 });
    const d = device(server);
    await d.store.load();
    const pages = d.store.getState().pages;
    let target = "";
    for (let i = 0; i < 1500; i++) {
      const id = d.store.addCircle({ pageId: pages[i % 6].id, x: (i % 50) / 50, y: Math.floor(i / 50) / 30, r: 0.01 });
      if (i < 3) d.store.addComment(id, `note ${i}`);
      if (i === 0) target = id;
    }
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save.state).toBe("saved");

    const before = d.store.getState();
    d.store.beginGesture();
    const t0 = performance.now();
    for (let f = 0; f < 240; f++) {
      d.store.updateCircle(target, { x: 0.1 + f / 1000 }, { live: true });
      d.store.getState(); // what a render would read each frame
    }
    const ms = performance.now() - t0;
    d.store.endGesture();
    const after = d.store.getState();
    // ~4 s of 60 fps dragging must cost far less than the frames themselves
    expect(ms).toBeLessThan(1500);
    expect(after.circlesByPage.get(pages[1].id)).toBe(before.circlesByPage.get(pages[1].id));
    expect(after.commentsByCircle).toBe(before.commentsByCircle);
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs[d.net.syncs.length - 1].ops).toHaveLength(1);
  });
});
