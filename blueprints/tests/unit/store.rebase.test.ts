// Pulling the server's copy and rebasing local changes onto it; two devices
// editing one plan; stale replies; page polling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, PULL_EVERY_MS } from "../../src/client/sync/store";
import { device, FakeServer, settle, type Device } from "./fakes";

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

async function open(server: FakeServer): Promise<Device> {
  const d = device(server);
  await d.store.load();
  await settle();
  return d;
}

/** Server with one page holding one saved circle and one comment. */
async function seeded() {
  const server = new FakeServer();
  const a = await open(server);
  const pageId = a.store.getState().pages[0].id;
  const circleId = a.store.addCircle({ pageId, x: 0.2, y: 0.2, r: 0.05 });
  const commentId = a.store.addComment(circleId, "Usher post");
  await a.store.flushNow();
  return { server, a, pageId, circleId, commentId };
}

describe("rebase on pull", () => {
  it("adopts the server's rows where nothing is pending, merges field by field where something is", async () => {
    const { server, a, pageId, circleId, commentId } = await seeded();
    // a pending local move, kept on the device (offline)
    a.net.failWith = 0;
    a.store.updateCircle(circleId, { x: 0.7 });
    await tick(DEBOUNCE_MS);
    // the other device: recolours the same circle, adds a circle, deletes the comment, renames the page
    server.edit("circle", circleId, { color: "red" });
    const other = { id: "other-device-circle", planId: server.planId, pageId, x: 0.9, y: 0.9, r: 0.02, color: "blue" as const, title: "", num: 9, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, rev: 1 };
    server.circles.set(other.id, other);
    server.edit("comment", commentId, { deletedAt: Date.now() });
    server.edit("page", pageId, { label: "Upper deck" });

    a.net.failWith = null;
    await a.store.pull();
    const s = a.store.getState();
    expect(s.circleById.get(circleId)).toMatchObject({ x: 0.7, color: "red" });
    expect(s.circleById.get(other.id)).toMatchObject({ num: 9, color: "blue" });
    expect(s.commentsByCircle.get(circleId)).toEqual([]);
    expect(s.pages[0].label).toBe("Upper deck");
    expect(s.save.pending).toBe(1);

    await tick(1000);
    expect(server.circles.get(circleId)).toMatchObject({ x: 0.7, color: "red" });
    expect(a.store.getState().save.state).toBe("saved");
  });

  it("rows created on this device and not yet saved stay through a pull", async () => {
    const server = new FakeServer();
    const a = await open(server);
    a.net.failWith = 0;
    const id = a.store.addCircle({ pageId: a.store.getState().pages[0].id, x: 0.5, y: 0.5, r: 0.05 });
    a.net.failWith = null;
    await a.store.pull();
    expect(a.store.getState().circleById.get(id)!.num).toBe(0);
    expect(a.store.hasUnsaved()).toBe(true);
  });

  it("a pull that changes nothing keeps every row object (no re-render storm every 30 s)", async () => {
    const { a } = await seeded();
    const before = a.store.getState();
    await a.store.pull();
    const after = a.store.getState();
    expect(after.circleById).toBe(before.circleById);
    expect(after.commentsByCircle).toBe(before.commentsByCircle);
    expect(after.pages).toBe(before.pages);
  });

  it("pulls every 30 s while visible and idle, and on return to the tab", async () => {
    const { server, a, circleId } = await seeded();
    const calls = a.net.calls.getPlan;
    server.edit("circle", circleId, { title: "From the iPad" });
    await tick(PULL_EVERY_MS);
    expect(a.net.calls.getPlan).toBe(calls + 1);
    expect(a.store.getState().circleById.get(circleId)!.title).toBe("From the iPad");

    // hidden: no polling
    a.env.visible = false;
    await tick(PULL_EVERY_MS * 3);
    expect(a.net.calls.getPlan).toBe(calls + 1);
    server.edit("circle", circleId, { title: "Again" });
    a.env.show();
    await settle();
    expect(a.net.calls.getPlan).toBe(calls + 2);
    expect(a.store.getState().circleById.get(circleId)!.title).toBe("Again");
  });

  it("doesn't poll while changes are waiting to be saved", async () => {
    const { a, circleId } = await seeded();
    a.net.failWith = 0;
    a.store.updateCircle(circleId, { x: 0.4 });
    const calls = a.net.calls.getPlan;
    await tick(PULL_EVERY_MS * 2);
    expect(a.net.calls.getPlan).toBe(calls);
  });

  it("the plan deleted elsewhere → notFound on the next pull; pending changes still go to the server", async () => {
    const { server, a, circleId } = await seeded();
    a.store.updateCircle(circleId, { title: "Last edit" });
    server.plan.deletedAt = Date.now();
    await a.store.pull();
    expect(a.store.getState().notFound).toBe(true);
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(circleId)!.title).toBe("Last edit");
  });
});

describe("pull during a gesture", () => {
  it("a pull landing mid-drag keeps the live position, takes the other device's recolour, and undo only reverts the drag", async () => {
    const { server, a, circleId } = await seeded();
    a.store.beginGesture();
    a.store.updateCircle(circleId, { x: 0.5 }, { live: true });
    server.edit("circle", circleId, { color: "red" });
    await a.store.pull();
    expect(a.store.getState().circleById.get(circleId)).toMatchObject({ x: 0.5, color: "red" });
    a.store.updateCircle(circleId, { x: 0.55 }, { live: true });
    a.store.endGesture();
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(circleId)).toMatchObject({ x: 0.55, color: "red" });
    a.store.undo();
    expect(a.store.getState().circleById.get(circleId)).toMatchObject({ x: 0.2, color: "red" });
  });

  it("cancelGesture after a pull restores only the dragged fields", async () => {
    const { server, a, circleId } = await seeded();
    a.store.beginGesture();
    a.store.updateCircle(circleId, { r: 0.2 }, { live: true });
    server.edit("circle", circleId, { title: "From the iPad" });
    await a.store.pull();
    a.store.cancelGesture();
    expect(a.store.getState().circleById.get(circleId)).toMatchObject({ r: 0.05, title: "From the iPad" });
    expect(a.store.hasUnsaved()).toBe(false);
  });
});

describe("two devices", () => {
  it("a move on one and a recolour on the other both win", async () => {
    const { server, a, circleId } = await seeded();
    const b = await open(server);
    a.store.updateCircle(circleId, { x: 0.6, y: 0.65 });
    b.store.updateCircle(circleId, { color: "green" });
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(circleId)).toMatchObject({ x: 0.6, y: 0.65, color: "green" });
    await a.store.pull();
    await b.store.pull();
    for (const d of [a, b]) {
      expect(d.store.getState().circleById.get(circleId)).toMatchObject({ x: 0.6, y: 0.65, color: "green" });
      expect(d.store.getState().save.state).toBe("saved");
    }
  });

  it("both add circles: each gets its own number", async () => {
    const server = new FakeServer();
    const a = await open(server);
    const b = await open(server);
    const pageId = a.store.getState().pages[0].id;
    const ca = a.store.addCircle({ pageId, x: 0.1, y: 0.1, r: 0.05 });
    const cb = b.store.addCircle({ pageId, x: 0.9, y: 0.9, r: 0.05 });
    await tick(DEBOUNCE_MS);
    await a.store.pull();
    expect(a.store.getState().circlesByPage.get(pageId)!.map((c) => [c.id, c.num])).toEqual([
      [ca, 1],
      [cb, 2],
    ]);
  });

  it("a circle deleted on one device while the other edits it offline stays deleted", async () => {
    const { server, a, circleId } = await seeded();
    const b = await open(server);
    b.net.failWith = 0;
    b.store.updateCircle(circleId, { title: "Edited offline" });
    await tick(DEBOUNCE_MS);
    a.store.deleteCircle(circleId);
    await tick(DEBOUNCE_MS);
    b.net.failWith = null;
    b.env.online();
    await settle();
    await b.store.pull();
    expect(server.circles.get(circleId)).toMatchObject({ title: "Edited offline" });
    expect(server.circles.get(circleId)!.deletedAt).not.toBeNull();
    expect(b.store.getState().circleById.has(circleId)).toBe(false);
  });

  it("the same field on both: the later save wins, and both devices converge", async () => {
    const { server, a, circleId } = await seeded();
    const b = await open(server);
    a.store.updateCircle(circleId, { title: "Desk A" });
    await tick(DEBOUNCE_MS);
    b.store.updateCircle(circleId, { title: "Desk B" });
    await tick(DEBOUNCE_MS);
    await a.store.pull();
    expect(a.store.getState().circleById.get(circleId)!.title).toBe("Desk B");
    expect(b.store.getState().circleById.get(circleId)!.title).toBe("Desk B");
  });
});

describe("stale and concurrent replies", () => {
  it("a slow reply older than a pull already applied doesn't roll the row back", async () => {
    const { server, a, circleId } = await seeded();
    a.net.hold = true;
    a.store.updateCircle(circleId, { x: 0.5 });
    await tick(DEBOUNCE_MS);
    a.net.held[0].arrive(); // the server applies the move (rev 2)…
    server.edit("circle", circleId, { color: "black" }); // …then the iPad recolours (rev 3)
    await a.store.pull(); // the device sees rev 3 first
    expect(a.store.getState().circleById.get(circleId)).toMatchObject({ x: 0.5, color: "black", rev: 3 });
    a.net.held[0].reply(); // the slow rev-2 reply
    await settle();
    expect(a.store.getState().circleById.get(circleId)).toMatchObject({ x: 0.5, color: "black", rev: 3 });
    expect(a.store.getState().save.state).toBe("saved");
  });

  it("a later edit from the other device that lands while our reply is slow wins (no stale re-send)", async () => {
    const { server, a, circleId } = await seeded();
    a.net.hold = true;
    a.store.updateCircle(circleId, { x: 0.5 });
    await tick(DEBOUNCE_MS);
    a.net.held[0].arrive(); // ours applied (x 0.5)
    server.edit("circle", circleId, { x: 0.9 }); // then the iPad moves it again
    await a.store.pull(); // pull first: our x still looks pending
    a.net.held[0].reply(); // then the reply proves ours was taken before the iPad's
    await settle();
    expect(a.store.getState().circleById.get(circleId)!.x).toBe(0.9);
    a.net.hold = false;
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(circleId)!.x).toBe(0.9);
    expect(a.store.hasUnsaved()).toBe(false);
  });

  it("a keepalive request racing a normal one converges (in-order arrival, replies reversed)", async () => {
    const { server, a, circleId } = await seeded();
    a.net.hold = true;
    a.store.updateCircle(circleId, { x: 0.3 });
    await tick(DEBOUNCE_MS); // normal request out (x 0.3)
    a.store.updateCircle(circleId, { x: 0.4 });
    a.env.hide(); // keepalive with x 0.4
    await settle();
    expect(a.net.held.map((h) => h.keepalive)).toEqual([false, true]);
    a.net.held[0].arrive();
    a.net.held[1].arrive();
    a.net.held[1].reply(); // keepalive answered first
    a.net.held[0].reply();
    await settle();
    expect(server.circles.get(circleId)!.x).toBe(0.4);
    expect(a.store.getState().circleById.get(circleId)!.x).toBe(0.4);
    expect(a.store.hasUnsaved()).toBe(false);
  });

  it("…and when the network reorders them, the device's newer value is re-sent", async () => {
    const { server, a, circleId } = await seeded();
    a.net.hold = true;
    a.store.updateCircle(circleId, { x: 0.3 });
    await tick(DEBOUNCE_MS);
    a.store.updateCircle(circleId, { x: 0.4 });
    a.env.hide();
    await settle();
    a.net.held[1].reply(); // the keepalive (x 0.4) gets there first…
    a.net.held[0].reply(); // …then the older request (x 0.3) overwrites it
    await settle();
    expect(server.circles.get(circleId)!.x).toBe(0.3);
    expect(a.store.getState().circleById.get(circleId)!.x).toBe(0.4); // the screen never went back
    expect(a.store.hasUnsaved()).toBe(true);
    a.net.hold = false;
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(circleId)!.x).toBe(0.4);
    expect(a.store.hasUnsaved()).toBe(false);
  });
});

describe("pages from uploads and polling", () => {
  it("mergePages: server-owned fields always win, new pages appear, a pending rename survives", async () => {
    const server = new FakeServer();
    const a = await open(server);
    const [p1] = a.store.getState().pages;
    a.net.failWith = 0;
    a.store.renamePage(p1.id, "Concourse");
    server.edit("page", p1.id, { status: "ready", assetKey: "fresh-key", width: 9000 });
    const added = server.addPage("Page 3", { status: "queued" });
    a.store.mergePages([...server.pages.values()].map((p) => structuredClone(p)));
    const s = a.store.getState();
    expect(s.pageById.get(p1.id)).toMatchObject({ label: "Concourse", assetKey: "fresh-key", width: 9000 });
    expect(s.pages.map((p) => p.id)).toContain(added.id);
    expect(s.circlesByPage.get(added.id)).toEqual([]);
    expect(s.save.pending).toBe(1);
  });

  it("refreshPages polls GET /pages and ignores stale copies", async () => {
    const server = new FakeServer();
    const a = await open(server);
    const pageId = a.store.getState().pages[0].id;
    server.edit("page", pageId, { status: "preview", assetKey: "k2" });
    await a.store.refreshPages();
    expect(a.store.getState().pageById.get(pageId)!.status).toBe("preview");
    const stale = { ...structuredClone(server.pages.get(pageId)!), status: "queued" as const, rev: 1 };
    a.store.mergePages([stale]);
    expect(a.store.getState().pageById.get(pageId)!.status).toBe("preview");
  });

  it("ignores rows that belong to another plan", async () => {
    const server = new FakeServer();
    const a = await open(server);
    const foreign = { ...structuredClone([...server.pages.values()][0]), id: "foreign", planId: "another-plan" };
    a.store.mergePages([foreign]);
    expect(a.store.getState().pageById.has("foreign")).toBe(false);
  });
});
