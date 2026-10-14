// The autosave engine: diffing and coalescing, timing, in-flight edits,
// offline/backoff, signed out, refusals, keepalive and replays.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, KEEPALIVE_MAX_BYTES, MAX_OPS_PER_REQUEST, MAX_WAIT_MS, ME_POLL_MS, MSG, RETRY_MS } from "../../src/client/sync/store";
import { outboxKey } from "../../src/client/sync/outbox";
import { device, FakeServer, settle, testId, type Device } from "./fakes";

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

async function open(server = new FakeServer(), opts: Parameters<typeof device>[1] = {}): Promise<Device & { server: FakeServer; pageId: string }> {
  const d = device(server, opts);
  await d.store.load();
  await settle();
  return { ...d, server, pageId: d.store.getState().pages[0].id };
}

/** A circle that already exists on the server (and on the device). */
async function savedCircle(d: Awaited<ReturnType<typeof open>>, over: { x?: number; y?: number } = {}) {
  const id = d.store.addCircle({ pageId: d.pageId, x: over.x ?? 0.2, y: over.y ?? 0.3, r: 0.05 });
  await d.store.flushNow();
  await settle();
  return id;
}

describe("saving", () => {
  it("a new circle shows num 0 until the server numbers it; the reply's num is adopted", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.25, y: 0.5, r: 0.04 });
    let s = d.store.getState();
    expect(s.circleById.get(id)).toMatchObject({ num: 0, color: "gold", title: "", x: 0.25 });
    expect(s.save).toEqual({ state: "pending", pending: 1, message: null });
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`].base).toBeNull();

    await tick(DEBOUNCE_MS);
    s = d.store.getState();
    expect(d.server.circles.get(id)!.num).toBe(1);
    expect(s.circleById.get(id)!.num).toBe(1);
    expect(s.circleById.get(id)!.rev).toBe(1);
    expect(s.save).toEqual({ state: "saved", pending: 0, message: null });
    expect(d.storage.data.has(outboxKey(d.server.planId))).toBe(false);
    expect(d.store.hasUnsaved()).toBe(false);
  });

  it("rapid edits coalesce into one op per row carrying the latest values", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.1, y: 0.1, r: 0.05 });
    for (let i = 1; i <= 5; i++) {
      d.store.updateCircle(id, { x: 0.1 + i * 0.1 });
      await tick(100);
    }
    d.store.updateCircle(id, { color: "red", title: "Gate A mag line" });
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs).toHaveLength(1);
    expect(d.net.syncs[0].ops).toEqual([
      {
        kind: "circle",
        id,
        base: null,
        data: expect.objectContaining({ x: 0.6, y: 0.1, color: "red", title: "Gate A mag line", pageId: d.pageId, deletedAt: null }),
      },
    ]);

    // the next change is diffed against the server copy
    d.store.updateCircle(id, { r: 0.08 });
    await tick(DEBOUNCE_MS);
    const op = d.net.syncs[1].ops[0];
    expect(op.base).toEqual({ x: 0.6, y: 0.1, r: 0.05, color: "red", title: "Gate A mag line", deletedAt: null });
    expect(op.data).toEqual({ x: 0.6, y: 0.1, r: 0.08, color: "red", title: "Gate A mag line", deletedAt: null });
    expect(d.server.circles.get(id)!.r).toBe(0.08);
  });

  it("an edit that goes back to the saved value is not sent", async () => {
    const d = await open();
    const id = await savedCircle(d);
    const before = d.net.syncs.length;
    d.store.updateCircle(id, { color: "green" });
    d.store.updateCircle(id, { color: "gold" });
    expect(d.store.getState().save.state).toBe("saved");
    await tick(MAX_WAIT_MS);
    expect(d.net.syncs.length).toBe(before);
  });

  it("debounces 500 ms but never waits more than 2.5 s while edits keep coming", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.1, y: 0.1, r: 0.05 });
    // an edit every 300 ms: the 500 ms debounce never gets to fire
    for (let i = 1; i <= 8; i++) {
      await tick(300);
      d.store.updateCircle(id, { x: 0.1 + i * 0.01 });
    }
    expect(d.net.syncs).toHaveLength(0); // 2.4 s in
    await tick(MAX_WAIT_MS - 2400 - 1);
    expect(d.net.syncs).toHaveLength(0);
    await tick(1); // 2.5 s after the first unsaved change
    expect(d.net.syncs).toHaveLength(1);
    expect(d.net.syncs[0].ops[0].data.x).toBeCloseTo(0.18);

    // and a lone edit goes out 500 ms after it was made
    await tick(MAX_WAIT_MS);
    d.store.updateCircle(id, { y: 0.5 });
    await tick(DEBOUNCE_MS - 1);
    expect(d.net.syncs).toHaveLength(1);
    await tick(1);
    expect(d.net.syncs).toHaveLength(2);
  });

  it("edits made while a request is out survive the reply, then go out in the next one", async () => {
    const d = await open();
    d.net.hold = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const commentId = d.store.addComment(id, "Two staff at the");
    await tick(DEBOUNCE_MS);
    expect(d.net.held).toHaveLength(1);
    expect(d.store.getState().save.state).toBe("saving");

    // keep editing while the request is out
    d.store.updateCircle(id, { x: 0.7 });
    d.store.updateComment(commentId, "Two staff at the gate");
    d.net.held[0].reply();
    await settle();

    let s = d.store.getState();
    expect(s.circleById.get(id)).toMatchObject({ x: 0.7, num: 1 });
    expect(s.commentsByCircle.get(id)![0].body).toBe("Two staff at the gate");
    expect(s.save.pending).toBe(2);

    d.net.hold = false;
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs[1].ops.map((o) => [o.kind, o.base === null])).toEqual([
      ["circle", false],
      ["comment", false],
    ]);
    expect(d.server.circles.get(id)!.x).toBe(0.7);
    expect(d.server.comments.get(commentId)!.body).toBe("Two staff at the gate");
    s = d.store.getState();
    expect(s.save).toEqual({ state: "saved", pending: 0, message: null });
  });

  it("only one request is out at a time; a save asked for meanwhile runs right after", async () => {
    const d = await open();
    d.net.hold = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.updateCircle(id, { y: 0.9 });
    await tick(MAX_WAIT_MS * 2);
    expect(d.net.held).toHaveLength(1); // still waiting on the first
    d.net.held[0].reply();
    await settle();
    expect(d.net.held).toHaveLength(2); // the timer fired while it was out → straight on
    d.net.held[1].reply();
    await settle();
    expect(d.server.circles.get(id)!.y).toBe(0.9);
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("splits more than 500 changes into several requests, circles before their comments", async () => {
    const d = await open();
    const ids: string[] = [];
    for (let i = 0; i < 700; i++) ids.push(d.store.addCircle({ pageId: d.pageId, x: (i % 100) / 100, y: 0.5, r: 0.01 }));
    for (let i = 0; i < 400; i++) d.store.addComment(ids[i], `note ${i}`);
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs.map((s) => s.ops.length)).toEqual([MAX_OPS_PER_REQUEST, MAX_OPS_PER_REQUEST, 100]);
    expect(d.net.syncs[0].ops.every((o) => o.kind === "circle")).toBe(true);
    expect(d.server.circles.size).toBe(700);
    expect(d.server.comments.size).toBe(400);
    expect(d.store.getState().save.state).toBe("saved");
    expect(Math.max(...[...d.server.circles.values()].map((c) => c.num))).toBe(700);
  });

  it("flushNow saves straight away (Cmd+S, tapping the pill)", async () => {
    const d = await open();
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await d.store.flushNow();
    expect(d.net.syncs).toHaveLength(1);
    expect(d.store.getState().save.state).toBe("saved");
  });
});

describe("network trouble", () => {
  it("offline: keeps everything on the device, retries with backoff, saves when the connection is back", async () => {
    const d = await open();
    d.net.failWith = 0;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    let s = d.store.getState();
    expect(s.save.state).toBe("offline");
    expect(s.save.pending).toBe(1);
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`]).toBeTruthy();

    // backoff: 1, 2, 4, 8, 15, 30, 30 s…
    const attemptsAt: number[] = [];
    const start = d.net.calls.sync;
    let elapsed = 0;
    for (const step of [1000, 2000, 4000, 8000, 15000, 30000, 30000]) {
      await tick(step - 1);
      expect(d.net.calls.sync - start).toBe(attemptsAt.length);
      await tick(1);
      elapsed += step;
      attemptsAt.push(elapsed);
      expect(d.net.calls.sync - start).toBe(attemptsAt.length);
    }
    expect(RETRY_MS).toEqual([1000, 2000, 4000, 8000, 15000, 30000]);

    d.net.failWith = null;
    await tick(30_000);
    s = d.store.getState();
    expect(s.save.state).toBe("saved");
    expect(d.server.circles.get(id)!.num).toBe(1);
    expect(d.storage.data.has(outboxKey(d.server.planId))).toBe(false);
  });

  it("server errors (5xx) count as offline too", async () => {
    const d = await open();
    d.net.failWith = 503;
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save.state).toBe("offline");
    d.net.failWith = null;
    await tick(1000);
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("the online event retries at once instead of waiting out the backoff", async () => {
    const d = await open();
    d.net.failWith = 0;
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    for (const ms of [1000, 2000, 4000, 8000]) await tick(ms); // next retry is 15 s away
    d.net.failWith = null;
    d.env.online();
    await settle();
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("a lost reply is harmless: the replayed create keeps its number and nothing is duplicated", async () => {
    const d = await open();
    d.net.loseNextReply = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.num).toBe(1); // it got there…
    expect(d.store.getState().save.state).toBe("offline"); // …but the device never heard
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`].sent).toMatchObject({ x: 0.2, deletedAt: null }); // went out: may be there
    await tick(1000);
    expect(d.net.syncs[1].ops[0].base).toBeNull(); // replayed as a create
    expect(d.server.circleSeq).toBe(1);
    expect(d.server.circles.get(id)!.rev).toBe(1); // replay changed nothing
    expect(d.store.getState().circleById.get(id)!.num).toBe(1);
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("a circle deleted after its create's reply was lost is still deleted on the server", async () => {
    const d = await open();
    d.net.loseNextReply = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.deleteCircle(id);
    expect(d.store.getState().save.pending).toBe(1); // it may exist there, so the delete must go
    await tick(1000);
    expect(d.server.circles.get(id)!.deletedAt).not.toBeNull();
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("a hanging request that times out is retried; edits made meanwhile are kept", async () => {
    const d = await open();
    d.net.hold = true;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.store.updateCircle(id, { title: "North gate" });
    d.net.held[0].fail({ applied: true, status: 408 }); // the 15 s abort in api.ts
    await settle();
    expect(d.store.getState().save.state).toBe("offline");
    d.net.hold = false;
    await tick(1000);
    expect(d.server.circles.get(id)).toMatchObject({ num: 1, title: "North gate" });
    expect(d.store.getState().save.state).toBe("saved");
  });
});

describe("signed out", () => {
  it("401 → signedOut: keeps everything, polls the session every 10 s and resumes saving after sign-in", async () => {
    const d = await open();
    d.net.signedIn = false;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    let s = d.store.getState();
    expect(s.save.state).toBe("signedOut");
    expect(s.save.message).toMatch(/signed out/i);

    // more edits don't hammer the server while signed out
    d.store.updateCircle(id, { color: "red" });
    const syncCalls = d.net.calls.sync;
    await tick(5000);
    expect(d.net.calls.sync).toBe(syncCalls);
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`].local.color).toBe("red");

    await tick(ME_POLL_MS);
    expect(d.net.calls.me).toBe(1);
    expect(d.store.getState().save.state).toBe("signedOut");

    d.net.signedIn = true; // signed in again (e.g. in another tab)
    await tick(ME_POLL_MS);
    s = d.store.getState();
    expect(s.save.state).toBe("saved");
    expect(d.server.circles.get(id)).toMatchObject({ color: "red", num: 1 });
  });

  it("coming back to the tab checks the session straight away", async () => {
    const d = await open();
    d.net.signedIn = false;
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    d.net.signedIn = true;
    d.env.show();
    await settle();
    expect(d.store.getState().save.state).toBe("saved");
  });
});

describe("refusals", () => {
  it("another 4xx → error with the server's message; the outbox is kept and tapping the pill retries", async () => {
    const d = await open();
    d.net.failWith = 400;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    let s = d.store.getState();
    expect(s.save.state).toBe("error");
    expect(s.save.message).toBe("Failed with 400.");
    const calls = d.net.calls.sync;
    d.store.updateCircle(id, { x: 0.3 });
    await tick(5000);
    expect(d.net.calls.sync).toBe(calls); // no hammering
    expect(d.storage.json(outboxKey(d.server.planId))).toBeTruthy();

    d.net.failWith = null;
    await d.store.flushNow();
    s = d.store.getState();
    expect(s.save).toEqual({ state: "saved", pending: 0, message: null });
    expect(d.server.circles.get(id)!.x).toBe(0.3);
  });

  it("a refused create is removed (its page is gone) and the owner is told", async () => {
    const d = await open();
    const page2 = d.store.getState().pages[1].id;
    const id = d.store.addCircle({ pageId: page2, x: 0.2, y: 0.2, r: 0.05 });
    const commentId = d.store.addComment(id, "Fire lane");
    const keep = d.store.addCircle({ pageId: d.pageId, x: 0.4, y: 0.4, r: 0.05 });
    d.server.pages.delete(page2); // purged on the server
    await tick(DEBOUNCE_MS);
    const s = d.store.getState();
    expect(s.circleById.has(id)).toBe(false);
    expect(s.circleById.get(keep)!.num).toBe(1);
    expect(s.save.state).toBe("saved");
    expect(s.save.message).toMatch(/page no longer exists/);
    expect(d.toasts.map((t) => t.message)).toContain("That circle's page no longer exists, so the circle wasn't saved.");
    expect(d.server.comments.has(commentId)).toBe(false);
    expect(d.store.hasUnsaved()).toBe(false);
  });

  it("an op the server neither confirms nor refuses turns the pill red instead of looping", async () => {
    const server = new FakeServer();
    const d = await open(server);
    const real = d.net.transport.sync;
    d.net.transport.sync = async (planId, body, opts) => {
      const res = await real(planId, body, opts);
      return { ...res, rows: { plans: [], pages: [], circles: [], comments: [] } };
    };
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save).toMatchObject({ state: "error", message: MSG.unconfirmed, pending: 1 });
    const calls = d.net.calls.sync;
    await tick(10_000);
    expect(d.net.calls.sync).toBe(calls);
  });

  it("a garbled 200 reply (captive portal) counts as offline, not as saved", async () => {
    const d = await open();
    const real = d.net.transport.sync;
    let garble = true;
    d.net.transport.sync = async (planId, body, opts) => {
      if (garble) return "<html>Sign in to Stadium Wi-Fi</html>" as never;
      return real(planId, body, opts);
    };
    d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save.state).toBe("offline");
    garble = false;
    await tick(1000);
    expect(d.store.getState().save.state).toBe("saved");
  });
});

describe("leaving the page", () => {
  it("hidden/pagehide sends everything at once with keepalive (one request for both events)", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.env.hide(); // visibilitychange → hidden
    d.env.handlers!.hidden(); // pagehide right after
    await settle();
    expect(d.net.syncs).toHaveLength(1);
    expect(d.net.syncs[0].keepalive).toBe(true);
    expect(d.server.circles.has(id)).toBe(true);
    expect(d.store.getState().save.state).toBe("saved");
    await tick(DEBOUNCE_MS * 10);
    expect(d.net.syncs).toHaveLength(1);
  });

  it("a body too big for keepalive goes as a normal request", async () => {
    const d = await open();
    const id = await savedCircle(d);
    for (let i = 0; i < 8; i++) d.store.addComment(id, "x".repeat(9000));
    d.env.hide();
    await settle();
    const last = d.net.syncs[d.net.syncs.length - 1];
    expect(JSON.stringify({ ops: last.ops }).length).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
    expect(last.keepalive).toBe(false);
    expect(d.server.comments.size).toBe(8);
  });

  it("a keepalive that fails leaves the changes pending and they save when the page is back", async () => {
    const d = await open();
    d.net.failWith = 0;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.env.hide();
    await settle();
    expect(d.store.getState().save.pending).toBe(1);
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`].sent).toMatchObject({ x: 0.2 });
    d.net.failWith = null;
    d.env.show();
    await settle();
    expect(d.store.getState().save.state).toBe("saved");
  });

  it("dispose() flushes with keepalive and stops every timer", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.dispose();
    await settle();
    expect(d.net.syncs).toHaveLength(1);
    expect(d.net.syncs[0].keepalive).toBe(true);
    expect(d.server.circles.has(id)).toBe(true);
    const calls = { ...d.net.calls };
    await tick(120_000);
    expect(d.net.calls).toEqual(calls);
    expect(d.env.handlers).toBeNull();
  });

  it("dispose() while offline leaves the outbox for the next visit", async () => {
    const d = await open();
    d.net.failWith = 0;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.dispose();
    await settle();
    expect(d.storage.json(outboxKey(d.server.planId)).entries[`circle:${id}`]).toBeTruthy();
  });

  it("keeps working when localStorage refuses writes, and says the device has no copy while unsaved", async () => {
    const d = await open();
    d.storage.failWrites = true;
    d.net.failWith = 0;
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.store.getState().save).toEqual({ state: "offline", pending: 1, message: MSG.noDeviceCopy });
    d.net.failWith = null;
    await tick(1000);
    expect(d.server.circles.get(id)!.num).toBe(1);
    expect(d.store.getState().save).toEqual({ state: "saved", pending: 0, message: null });
    d.store.updateCircle(id, { x: 0.3 });
    expect(d.store.getState().save.message).toBe(MSG.noDeviceCopy);
  });
});

describe("local-only rows", () => {
  it("an add undone before it was saved never reaches the server (no gap in the numbers)", async () => {
    const d = await open();
    const oops = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    d.store.undo();
    expect(d.store.getState().circleById.has(oops)).toBe(false);
    expect(d.store.getState().save.state).toBe("saved");
    await tick(MAX_WAIT_MS);
    expect(d.net.syncs).toHaveLength(0);
    const real = d.store.addCircle({ pageId: d.pageId, x: 0.3, y: 0.3, r: 0.05 });
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(real)!.num).toBe(1);
    expect(d.server.circles.has(oops)).toBe(false);
  });

  it("a comment on an unsaved circle waits for the circle; deleting the circle first sends neither; undo sends both", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(id, "Check the turnstiles");
    d.store.deleteCircle(id);
    await tick(MAX_WAIT_MS);
    expect(d.net.syncs).toHaveLength(0);
    expect(d.store.hasUnsaved()).toBe(false);

    d.store.undo(); // the circle is back, with its comment
    expect(d.store.getState().commentsByCircle.get(id)!.map((c) => c.id)).toEqual([m]);
    await tick(DEBOUNCE_MS);
    expect(d.net.syncs[0].ops.map((o) => o.kind)).toEqual(["circle", "comment"]);
    expect(d.server.comments.get(m)!.circleId).toBe(id);
  });

  it("a circle created in this session and immediately dragged doesn't strand its comment", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 0.2, y: 0.2, r: 0.05 });
    const m = d.store.addComment(id, "Bag check");
    d.store.beginGesture();
    d.store.updateCircle(id, { x: 0.3 }, { live: true });
    await tick(MAX_WAIT_MS * 2);
    // the circle is mid-drag (held back) so its comment waits too — nothing refused
    expect(d.server.comments.has(m)).toBe(false);
    expect(d.toasts).toEqual([]);
    d.store.endGesture();
    await tick(DEBOUNCE_MS);
    expect(d.server.circles.get(id)!.x).toBe(0.3);
    expect(d.server.comments.get(m)!.body).toBe("Bag check");
  });
});

describe("misc", () => {
  it("ids come from the injected factory", async () => {
    const server = new FakeServer();
    const ids = ["fixed-1", "fixed-2"];
    const d = await open(server, { options: { newId: () => ids.shift() ?? testId() } });
    expect(d.store.addCircle({ pageId: d.pageId, x: 0, y: 0, r: 0.01 })).toBe("fixed-1");
    expect(d.store.addComment("fixed-1", "a")).toBe("fixed-2");
  });

  it("cleans values like the server does (clamped geometry, unknown colour ignored)", async () => {
    const d = await open();
    const id = d.store.addCircle({ pageId: d.pageId, x: 1.4, y: -2, r: 5, color: "pink" as never });
    expect(d.store.getState().circleById.get(id)).toMatchObject({ x: 1, y: 0, r: 0.5, color: "gold" });
    d.store.updateCircle(id, { color: "hotpink" as never, x: Number.NaN });
    expect(d.store.getState().circleById.get(id)).toMatchObject({ x: 1, color: "gold" });
    expect(d.store.getState().canUndo).toBe(true);
  });
});
