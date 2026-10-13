// Opening a plan: the first load, restoring the device outbox (including
// creates that never reached the server), and loads that fail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxKey } from "../../src/client/sync/outbox";
import { DEBOUNCE_MS, LOAD_RETRY_MS, ME_POLL_MS, MSG } from "../../src/client/sync/store";
import { device, FakeServer, MemoryStorage, settle } from "./fakes";

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

describe("load", () => {
  it("loads the plan with everything derived and nothing to save", async () => {
    const server = new FakeServer({ pages: 3 });
    const d = device(server);
    expect(d.store.getState()).toMatchObject({ loaded: false, loadError: null, notFound: false, plan: null, pages: [] });
    await d.store.load();
    const s = d.store.getState();
    expect(s.loaded).toBe(true);
    expect(s.plan!.name).toBe(server.plan.name);
    expect(s.pages.map((p) => p.label)).toEqual(["Page 1", "Page 2", "Page 3"]);
    expect(s.save).toEqual({ state: "saved", pending: 0, message: null });
    expect(s.canUndo).toBe(false);
    await tick(DEBOUNCE_MS * 4);
    expect(d.net.calls.sync).toBe(0);
  });

  it("ignores edits before the plan has loaded", () => {
    const d = device(new FakeServer());
    d.store.addCircle({ pageId: "x", x: 0.5, y: 0.5, r: 0.1 });
    d.store.renamePlan("Nope");
    expect(d.store.getState().circleById.size).toBe(0);
    expect(d.storage.writes).toBe(0);
  });

  it("restores unsaved changes from the outbox: creates that never reached the server, and edits merged with the other device's", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();

    // Session 1, offline at the stadium: edit, then the tab is killed.
    const a = device(server, { storage });
    await a.store.load();
    const pageId = a.store.getState().pages[0].id;
    a.store.addCircle({ pageId, x: 0.1, y: 0.1, r: 0.05 }); // makes num 1 exist on the server…
    await a.store.flushNow();
    const existing = [...server.circles.keys()][0];
    a.net.failWith = 0;
    const offlineCircle = a.store.addCircle({ pageId, x: 0.6, y: 0.6, r: 0.05, color: "blue" });
    const offlineComment = a.store.addComment(offlineCircle, "Overflow parking marshal");
    a.store.updateCircle(existing, { x: 0.15 });
    a.store.renamePage(pageId, "Field level");
    await tick(DEBOUNCE_MS);
    expect(a.store.getState().save.state).toBe("offline");
    // (no dispose: iPad Safari just kills the page)

    // Meanwhile the other device recolours the existing circle.
    server.edit("circle", existing, { color: "green" });

    // Session 2 (same device, back online).
    const b = device(server, { storage });
    await b.store.load();
    let s = b.store.getState();
    expect(s.circleById.get(existing)).toMatchObject({ x: 0.15, color: "green" }); // both edits
    expect(s.circleById.get(offlineCircle)).toMatchObject({ num: 0, color: "blue" });
    expect(s.commentsByCircle.get(offlineCircle)!.map((m) => m.body)).toEqual(["Overflow parking marshal"]);
    expect(s.pages[0].label).toBe("Field level");

    await settle();
    expect(b.toasts).toEqual([]); // deferred so the Toaster is listening
    await tick(0);
    expect(b.toasts).toEqual([{ message: MSG.restored(4), kind: "info" }]);

    s = b.store.getState();
    expect(s.save.state).toBe("saved");
    expect(server.circles.get(offlineCircle)!.num).toBe(2);
    expect(server.circles.get(existing)).toMatchObject({ x: 0.15, color: "green" });
    expect(server.comments.get(offlineComment)!.circleId).toBe(offlineCircle);
    expect(server.pages.get(pageId)!.label).toBe("Field level");
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
  });

  it("an outbox entry whose keepalive did land is recognised and not counted again", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = device(server, { storage });
    await a.store.load();
    const pageId = a.store.getState().pages[0].id;
    a.net.loseNextReply = true; // the request arrives, the page dies before the reply
    const id = a.store.addCircle({ pageId, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`]).toMatchObject({ base: null, sent: { x: 0.3, y: 0.3, deletedAt: null } });

    const b = device(server, { storage });
    await b.store.load();
    await tick(0);
    expect(b.store.getState().circleById.get(id)!.num).toBe(1);
    expect(b.store.getState().save.state).toBe("saved");
    expect(b.toasts).toEqual([]);
    expect(b.net.calls.sync).toBe(0);
  });

  it("a restored create whose page was purged meanwhile is refused and dropped, with a message", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = device(server, { storage });
    await a.store.load();
    const pageId = a.store.getState().pages[1].id;
    a.net.failWith = 0;
    const id = a.store.addCircle({ pageId, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);
    server.pages.delete(pageId);

    const b = device(server, { storage });
    await b.store.load();
    await tick(0);
    expect(b.store.getState().circleById.has(id)).toBe(false);
    expect(b.store.getState().save.message).toMatch(/page no longer exists/);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
  });

  it("offline at open with an outbox: says so, retries every 5 s, then opens and saves", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = device(server, { storage });
    await a.store.load();
    a.net.failWith = 0;
    const id = a.store.addCircle({ pageId: a.store.getState().pages[0].id, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);

    const b = device(server, { storage });
    b.net.failWith = 0;
    await b.store.load();
    expect(b.store.getState()).toMatchObject({ loaded: false, loadError: MSG.offlineLoad });
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`]).toBeTruthy(); // untouched
    await tick(LOAD_RETRY_MS);
    expect(b.net.calls.getPlan).toBe(2);
    b.net.failWith = null;
    await tick(LOAD_RETRY_MS);
    expect(b.store.getState()).toMatchObject({ loaded: true, loadError: null });
    expect(server.circles.has(id)).toBe(true);
  });

  it("coming back online / to the tab retries a failed load right away", async () => {
    const server = new FakeServer();
    const d = device(server);
    d.net.failWith = 0;
    await d.store.load();
    expect(d.store.getState().loadError).toBe(MSG.offlineLoad);
    d.net.failWith = null;
    d.env.online();
    await settle();
    expect(d.store.getState().loaded).toBe(true);
  });

  it("a server error at open says the server isn't answering", async () => {
    const d = device(new FakeServer());
    d.net.failWith = 502;
    await d.store.load();
    expect(d.store.getState().loadError).toBe(MSG.serverDownLoad);
  });

  it("a deleted or unknown plan → notFound (no retries)", async () => {
    const server = new FakeServer();
    server.plan.deletedAt = Date.now();
    const d = device(server);
    await d.store.load();
    expect(d.store.getState()).toMatchObject({ loaded: false, notFound: true, loadError: null });
    await tick(60_000);
    expect(d.net.calls.getPlan).toBe(1);
  });

  it("signed out at open → signedOut, then opens once the session is back", async () => {
    const server = new FakeServer();
    const d = device(server);
    d.net.signedIn = false;
    await d.store.load();
    expect(d.store.getState()).toMatchObject({ loaded: false, loadError: MSG.signedOutLoad });
    expect(d.store.getState().save.state).toBe("signedOut");
    d.net.signedIn = true;
    await tick(ME_POLL_MS);
    expect(d.store.getState()).toMatchObject({ loaded: true, loadError: null });
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("leaving before the first load finishes: no toast, no save, the outbox waits for the next visit", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = device(server, { storage });
    await a.store.load();
    a.net.failWith = 0;
    const id = a.store.addCircle({ pageId: a.store.getState().pages[0].id, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);

    const b = device(server, { storage });
    const loading = b.store.load();
    b.store.dispose(); // the owner went back to the plan list straight away
    await loading;
    await tick(1000);
    expect(b.toasts).toEqual([]);
    expect(b.net.calls.sync).toBe(0);
    expect(server.circles.has(id)).toBe(false);
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`]).toBeTruthy();
  });

  it("load() after dispose() revives the store (React effects can run twice)", async () => {
    const server = new FakeServer();
    const d = device(server);
    const first = d.store.load();
    d.store.dispose();
    await d.store.load();
    await first;
    expect(d.store.getState().loaded).toBe(true);
    expect(d.env.handlers).not.toBeNull();
    const id = d.store.addCircle({ pageId: d.store.getState().pages[0].id, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(server.circles.has(id)).toBe(true);
  });
});
