// Sending outboxes that editors left on this device (review finding #7):
// the home page's background save, which must follow the same restore rules
// as the editor and must never race an editor open for the same plan.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushStoredOutboxes, leftoverMessage, reportLeftovers, type LeftoverResult } from "../../src/client/sync/background";
import { outboxKey } from "../../src/client/sync/outbox";
import { isPlanOpen } from "../../src/client/sync/store";
import type { SyncTransport } from "../../src/client/sync/types";
import { device, FakeEnv, FakeNet, FakeServer, MemoryStorage, settle, type Device } from "./fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** One transport for several plans (each on its own fake server). */
function router(...nets: FakeNet[]): SyncTransport {
  const net = (planId: string) => nets.find((n) => n.server.planId === planId) ?? nets[0];
  return {
    getPlan: (id) => net(id).transport.getPlan(id),
    getPages: (id) => net(id).transport.getPages(id),
    me: () => nets[0].transport.me(),
    sync: (id, body, opts) => net(id).transport.sync(id, body, opts),
  };
}

/** An editor closed while offline: its changes stay in `storage`. */
async function leaveOffline(server: FakeServer, storage: MemoryStorage, edit: (d: Device, pageId: string) => void) {
  const d = device(server, { storage });
  await d.store.load();
  await settle();
  d.net.failWith = 0;
  edit(d, d.store.getState().pages[0].id);
  d.store.dispose();
  await settle();
  expect(storage.data.has(outboxKey(server.planId))).toBe(true);
  return d;
}

const run = (net: FakeNet, storage: MemoryStorage) => flushStoredOutboxes({ storage, transport: net.transport, env: new FakeEnv() });

describe("flushStoredOutboxes", () => {
  it("sends what an editor closed offline left behind, without opening that plan", async () => {
    const server = new FakeServer({ name: "Home opener" });
    const storage = new MemoryStorage();
    let circle = "";
    let comment = "";
    await leaveOffline(server, storage, (d, pageId) => {
      circle = d.store.addCircle({ pageId, x: 0.4, y: 0.4, r: 0.05 });
      comment = d.store.addComment(circle, "Bag check here");
    });

    const net = new FakeNet(server); // back online
    const results = await run(net, storage);
    expect(results).toEqual([{ planId: server.planId, name: "Home opener", unsaved: false, signedOut: false, notFound: false, refused: [] }]);
    expect(server.circles.get(circle)!.num).toBe(1);
    expect(server.comments.get(comment)!.body).toBe("Bag check here");
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
    expect(isPlanOpen(server.planId)).toBe(false); // its short-lived store let go
  });

  it("handles every plan with an outbox on this device, and nothing else", async () => {
    const a = new FakeServer({ name: "Gate plan" });
    const b = new FakeServer({ name: "Concourse" });
    const idle = new FakeServer({ name: "Untouched" });
    const storage = new MemoryStorage();
    await leaveOffline(a, storage, (d, pageId) => d.store.renamePage(pageId, "Field"));
    await leaveOffline(b, storage, (d) => d.store.renamePlan("Concourse — final"));
    storage.setItem("bpn-home-sort", "name");

    const nets = [new FakeNet(a), new FakeNet(b), new FakeNet(idle)];
    const results = await flushStoredOutboxes({ storage, transport: router(...nets), env: new FakeEnv() });
    expect(results.map((r) => [r.planId, r.unsaved]).sort()).toEqual([[a.planId, false], [b.planId, false]].sort());
    expect([...a.pages.values()][0].label).toBe("Field");
    expect(b.plan.name).toBe("Concourse — final");
    expect(nets[2].calls.getPlan).toBe(0);
    expect(storage.data.size).toBe(1); // only the sort preference is left
  });

  it("leaves a plan whose editor is open in this tab to that editor", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    await leaveOffline(server, storage, (d, pageId) => d.store.renamePage(pageId, "Field"));
    const editor = device(server, { storage });
    editor.net.failWith = 0; // the editor can't load yet (still offline): it's open all the same
    void editor.store.load();
    expect(isPlanOpen(server.planId)).toBe(true);

    const net = new FakeNet(server);
    expect(await run(net, storage)).toEqual([]);
    expect(net.calls.getPlan).toBe(0);

    editor.store.dispose();
    expect(isPlanOpen(server.planId)).toBe(false);
    expect((await run(net, storage))[0].unsaved).toBe(false);
  });

  it("still offline: says so (with the plan's name, kept with the outbox) and keeps everything", async () => {
    const server = new FakeServer({ name: "Home opener" });
    const storage = new MemoryStorage();
    await leaveOffline(server, storage, (d, pageId) => d.store.renamePage(pageId, "Field"));
    const before = storage.data.get(outboxKey(server.planId));

    const net = new FakeNet(server);
    net.failWith = 0;
    const results = await run(net, storage);
    expect(results).toEqual([{ planId: server.planId, name: "Home opener", unsaved: true, signedOut: false, notFound: false, refused: [] }]);
    expect(storage.data.get(outboxKey(server.planId))).toBe(before);

    const toasts: string[] = [];
    reportLeftovers(results, (m) => toasts.push(m));
    expect(toasts).toEqual([leftoverMessage(["Home opener"])]);
    expect(toasts[0]).toContain("“Home opener”");
    reportLeftovers(results, (m) => toasts.push(m)); // the next visit to the home page, still offline: not repeated
    expect(toasts).toHaveLength(1);

    net.failWith = null;
    expect((await run(net, storage))[0].unsaved).toBe(false);
    expect([...server.pages.values()][0].label).toBe("Field");
  });

  it("follows the editor's restore rules: an edit that already landed isn't replayed over the other device's", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = device(server, { storage, options: { timers: { setTimeout: () => 0, clearTimeout: () => {} } } });
    await ipad.store.load();
    await settle();
    const id = ipad.store.addCircle({ pageId: ipad.store.getState().pages[0].id, x: 0.2, y: 0.2, r: 0.05 });
    await ipad.store.flushNow();
    ipad.store.updateCircle(id, { x: 0.6 });
    ipad.net.hold = true;
    ipad.env.hide();
    ipad.net.held[0].arrive(); // landed; the tab was killed before the reply
    ipad.net.failWith = 0;
    ipad.store.dispose(); // (the killed tab is gone: it no longer counts as open; nothing more is sent)
    expect(ipad.net.syncs).toHaveLength(2);
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].sent).toMatchObject({ x: 0.6 });
    server.edit("circle", id, { x: 0.9 }); // the desktop moved it afterwards

    const results = await run(new FakeNet(server), storage);
    expect(results[0].unsaved).toBe(false);
    expect(server.circles.get(id)!.x).toBe(0.9);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
  });

  it("reports changes the server refused, naming the plan", async () => {
    const server = new FakeServer({ name: "Home opener" });
    const storage = new MemoryStorage();
    let pageId = "";
    await leaveOffline(server, storage, (d, p) => {
      pageId = p;
      d.store.addCircle({ pageId: p, x: 0.4, y: 0.4, r: 0.05 });
    });
    server.pages.delete(pageId); // purged meanwhile
    const results = await run(new FakeNet(server), storage);
    expect(results[0]).toMatchObject({ unsaved: false, refused: ["That circle's page no longer exists, so the circle wasn't saved."] });
    const toasts: { m: string; k?: string }[] = [];
    reportLeftovers(results, (m, k) => toasts.push({ m, k }));
    expect(toasts).toEqual([{ m: "“Home opener”: That circle's page no longer exists, so the circle wasn't saved.", k: "error" }]);
  });

  it("an editor opened for the plan while the background save runs: both finish, nothing doubled or lost", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    let circle = "";
    await leaveOffline(server, storage, (d, pageId) => {
      circle = d.store.addCircle({ pageId, x: 0.4, y: 0.4, r: 0.05 });
      d.store.addComment(circle, "Radio check");
    });
    const net = new FakeNet(server);
    const background = run(net, storage);
    const editor = device(server, { storage });
    await Promise.all([background, editor.store.load()]);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(server.circles.size).toBe(1);
    expect(server.circles.get(circle)!.num).toBe(1);
    expect(server.comments.size).toBe(1);
    expect(editor.store.hasUnsaved()).toBe(false);
    expect(editor.store.getState().circleById.get(circle)!.num).toBe(1);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
    editor.store.dispose();
  });

  it("a second call while one runs joins it", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    await leaveOffline(server, storage, (d, pageId) => d.store.renamePage(pageId, "Field"));
    const net = new FakeNet(server);
    const first = run(net, storage);
    const second = run(net, storage);
    expect(second).toBe(first);
    await first;
    expect(net.calls.getPlan).toBe(1); // the second round found nothing left to send
  });
});

describe("messages", () => {
  it("names the plans", () => {
    expect(leftoverMessage(["Gate plan"])).toBe(
      "Changes to “Gate plan” made on this device haven't reached the server yet. They're kept here and will be saved when the connection is back.",
    );
    expect(leftoverMessage(["A", "B"])).toContain("Changes to “A” and “B” made");
    expect(leftoverMessage(["A", "B", "C"])).toContain("Changes to “A”, “B” and 1 more plan made");
    expect(leftoverMessage(["A", "B", "C", "D"])).toContain("and 2 more plans");
    expect(leftoverMessage([null])).toContain("Changes to an event plan made");
  });

  it("stays quiet when everything was saved, or when signed out (the sign-in screen takes over)", () => {
    const toasts: string[] = [];
    const r = (over: Partial<LeftoverResult>): LeftoverResult => ({ planId: "p", name: "P", unsaved: false, signedOut: false, notFound: false, refused: [], ...over });
    reportLeftovers([r({}), r({ planId: "q", unsaved: true, signedOut: true }), r({ planId: "z", unsaved: true, notFound: true })], (m) => toasts.push(m));
    expect(toasts).toEqual([]);
  });
});
