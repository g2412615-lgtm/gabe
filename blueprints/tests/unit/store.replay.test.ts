// The device outbox across visits and tabs (review findings #0 and #20): a
// change the server already has must never be replayed over a newer one
// from the other device (or bring back a circle deleted there), a change
// that never left the device must still be saved, and two stores sharing
// one plan's outbox must not wipe each other's unsaved rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxKey } from "../../src/client/sync/outbox";
import { DEBOUNCE_MS, MSG } from "../../src/client/sync/store";
import { device, FakeServer, MemoryStorage, settle, type Device } from "./fakes";

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

async function open(server: FakeServer, storage = new MemoryStorage()): Promise<Device> {
  const d = device(server, { storage });
  await d.store.load();
  await settle();
  return d;
}

/**
 * A tab that iOS will kill without warning: its timers never fire, so once
 * the test stops driving it, it never runs again (saves happen only through
 * flushNow, hide and dispose).
 */
async function openMortal(server: FakeServer, storage: MemoryStorage): Promise<Device> {
  const d = device(server, { storage, options: { timers: { setTimeout: () => 0, clearTimeout: () => {} } } });
  await d.store.load();
  await settle();
  return d;
}

/** The other device (its own storage) makes a change and saves it. */
async function elsewhere(server: FakeServer, fn: (d: Device) => void) {
  const desk = await open(server);
  fn(desk);
  await desk.store.flushNow();
  await settle();
  desk.store.dispose();
  await settle();
}

/** A circle that's on the server already, made on `d`. */
async function savedCircle(d: Device, x = 0.2) {
  const id = d.store.addCircle({ pageId: d.store.getState().pages[0].id, x, y: 0.2, r: 0.05 });
  await d.store.flushNow();
  await settle();
  return id;
}

const restoredToasts = (d: Device) => d.toasts.filter((t) => t.message === MSG.restored(1) || /hadn't reached the server/.test(t.message));

describe("an outbox entry the server already has is never replayed", () => {
  it("leaving right after an edit: the save's reply lands after the editor closed and still clears the outbox", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await open(server, storage);
    const id = await savedCircle(ipad);

    // move it, then tap back to the plan list (leave guard → flushNow, then unmount → dispose)
    ipad.net.hold = true;
    ipad.store.updateCircle(id, { x: 0.6 });
    void ipad.store.flushNow();
    ipad.store.dispose();
    for (const h of ipad.net.held) h.reply();
    await settle();
    expect(server.circles.get(id)!.x).toBe(0.6);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);

    // the desktop moves and names it later
    await elsewhere(server, (desk) => desk.store.updateCircle(id, { x: 0.9, title: "Gate A" }));

    // days later the iPad opens the plan again
    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)).toMatchObject({ x: 0.9, title: "Gate A" });
    expect(again.store.getState().circleById.get(id)).toMatchObject({ x: 0.9, title: "Gate A" });
    expect(restoredToasts(again)).toEqual([]);
    expect(again.net.calls.sync).toBe(0);
  });

  it("a comment edited right before leaving keeps the other device's later wording", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await open(server, storage);
    const cid = await savedCircle(ipad);
    const com = ipad.store.addComment(cid, "Gate A needs 2 mags");
    await ipad.store.flushNow();
    ipad.store.updateComment(com, "Gate A needs 2 mags and a radio");
    ipad.store.dispose(); // before the debounce: dispose's keepalive saves it, its reply comes after
    await settle();
    expect(server.comments.get(com)!.body).toBe("Gate A needs 2 mags and a radio");

    await elsewhere(server, (desk) => desk.store.updateComment(com, "Gate A needs 3 mags and a radio"));
    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.comments.get(com)!.body).toBe("Gate A needs 3 mags and a radio");
    expect(restoredToasts(again)).toEqual([]);
  });

  it("the tab is killed after a keepalive landed (no reply handled): the entry is recognised as sent", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const id = await savedCircle(ipad);
    ipad.store.updateCircle(id, { x: 0.7 });
    ipad.net.hold = true;
    ipad.env.hide(); // keepalive goes out…
    expect(ipad.net.held).toHaveLength(1);
    ipad.net.held[0].arrive(); // …the server applies it, and iOS kills the page before the reply
    expect(server.circles.get(id)!.x).toBe(0.7);
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].sent).toMatchObject({ x: 0.7 });

    await elsewhere(server, (desk) => desk.store.updateCircle(id, { x: 0.4 }));

    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)!.x).toBe(0.4);
    expect(restoredToasts(again)).toEqual([]);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false); // nothing left to send
  });

  it("a circle and comment added just before leaving, then deleted on the other device, stay deleted", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await open(server, storage);
    const pageId = ipad.store.getState().pages[0].id;
    const id = ipad.store.addCircle({ pageId, x: 0.3, y: 0.3, r: 0.05 });
    const com = ipad.store.addComment(id, "Temp barrier");
    ipad.store.dispose();
    await settle();
    expect(server.circles.has(id)).toBe(true);

    await elsewhere(server, (desk) => {
      desk.store.deleteComment(com);
      desk.store.deleteCircle(id);
    });
    expect(server.circles.get(id)!.deletedAt).not.toBeNull();

    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)!.deletedAt).not.toBeNull();
    expect(server.comments.get(com)!.deletedAt).not.toBeNull();
    expect(again.store.getState().circleById.has(id)).toBe(false);
  });

  it("…also when the creates' reply was never handled (the page was killed)", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const pageId = ipad.store.getState().pages[0].id;
    ipad.net.hold = true;
    const id = ipad.store.addCircle({ pageId, x: 0.3, y: 0.3, r: 0.05 });
    const com = ipad.store.addComment(id, "Temp barrier");
    ipad.env.hide();
    ipad.net.held[0].arrive();
    expect(server.comments.has(com)).toBe(true);

    await elsewhere(server, (desk) => desk.store.deleteCircle(id));
    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)!.deletedAt).not.toBeNull();
    expect(server.circles.get(id)!.num).toBe(1); // never re-created
    expect(again.store.getState().circleById.has(id)).toBe(false);
  });

  it("an outbox left by the previous version (v1, nothing marked sent) isn't replayed over newer server values", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await open(server, storage);
    const id = await savedCircle(ipad);
    const row = { ...ipad.store.getState().circleById.get(id)! };
    ipad.store.dispose();
    server.edit("circle", id, { x: 0.6 }); // what the stale entry says (it did land)…
    server.edit("circle", id, { x: 0.9 }); // …then the desktop moved it
    storage.setItem(
      outboxKey(server.planId),
      JSON.stringify({ v: 1, entries: { [`circle:${id}`]: { local: { ...row, x: 0.6 }, base: { x: 0.2, y: 0.2, r: 0.05, color: "gold", title: "", deletedAt: null } } } }),
    );
    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)!.x).toBe(0.9);
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
  });
});

describe("a change that never reached the server is still saved on the next visit", () => {
  it("made offline (the browser knew), then the other device changed the same field: this device's change wins, as when online", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const id = await savedCircle(ipad);
    ipad.env.connected = false;
    ipad.net.failWith = 0;
    ipad.store.updateCircle(id, { x: 0.6 });
    await ipad.store.flushNow(); // tries, fails
    await ipad.store.flushNow();
    expect(ipad.store.getState().save.state).toBe("offline");
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].sent).toBeUndefined();
    // (the tab is killed)

    await elsewhere(server, (desk) => desk.store.updateCircle(id, { x: 0.9, color: "red" }));
    const again = await open(server, storage);
    await tick(0);
    expect(again.toasts).toContainEqual({ message: MSG.restored(1), kind: "info" });
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(id)).toMatchObject({ x: 0.6, color: "red" });
    expect(storage.data.has(outboxKey(server.planId))).toBe(false);
  });

  it("sent but never answered, while the other device changed other fields: both are kept", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const id = await savedCircle(ipad);
    ipad.net.failWith = 0; // the request goes out and the connection drops: it may or may not have landed
    ipad.store.updateCircle(id, { x: 0.6 });
    await ipad.store.flushNow();
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].sent).toMatchObject({ x: 0.6 });
    expect(server.circles.get(id)!.x).toBe(0.2);

    await elsewhere(server, (desk) => desk.store.updateCircle(id, { title: "Gate A" }));
    await open(server, storage);
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(id)).toMatchObject({ x: 0.6, title: "Gate A" });
  });

  it("an edit made after a request went out is this device's latest change: it wins", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const id = await savedCircle(ipad);
    ipad.net.hold = true;
    ipad.store.updateCircle(id, { x: 0.6 });
    void ipad.store.flushNow();
    ipad.net.held[0].arrive(); // x 0.6 landed, no reply yet
    ipad.store.updateCircle(id, { x: 0.7 }); // and the owner kept dragging
    // (the tab is killed before anything else happens)

    await elsewhere(server, (desk) => desk.store.updateCircle(id, { x: 0.9 }));
    await open(server, storage);
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(id)!.x).toBe(0.7);
  });
});

describe("stores sharing one plan's outbox", () => {
  it("two tabs: the one that saved (nothing pending) leaves the other tab's offline rows on the device", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = await openMortal(server, storage);
    const b = await open(server, storage);
    const pageId = a.store.getState().pages[0].id;
    a.net.failWith = 0;
    const id = a.store.addCircle({ pageId, x: 0.3, y: 0.3, r: 0.05 });
    const com = a.store.addComment(id, "Mag line here");
    await a.store.flushNow();

    b.store.renamePage(pageId, "Field");
    await tick(DEBOUNCE_MS);
    b.env.hide(); // nothing pending in b: it must not touch a's rows
    expect(server.pages.get(pageId)!.label).toBe("Field");
    const entries = storage.json(outboxKey(server.planId)).entries;
    expect(Object.keys(entries).sort()).toEqual([`circle:${id}`, `comment:${com}`].sort());

    // tab a is killed while still offline; the plan is opened again later
    await open(server, storage);
    await tick(DEBOUNCE_MS);
    expect(server.circles.has(id)).toBe(true);
    expect(server.comments.get(com)!.body).toBe("Mag line here");
  });

  it("a closed editor's late reply doesn't remove what a newer editor for the plan has written since", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const a = await open(server, storage);
    const id = await savedCircle(a);
    a.net.hold = true;
    a.store.updateCircle(id, { x: 0.6 });
    a.store.dispose(); // its keepalive is out, no reply yet

    // reopened at once: the new editor takes the row over (its save hangs) and the owner moves it again
    const b = device(server, { storage, options: { timers: { setTimeout: () => 0, clearTimeout: () => {} } } });
    b.net.hold = true;
    await b.store.load();
    await settle();
    b.store.updateCircle(id, { x: 0.7 });
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].local.x).toBe(0.7);

    a.net.held[0].reply(); // the old editor hears back about x 0.6
    await settle();
    expect(storage.json(outboxKey(server.planId)).entries[`circle:${id}`].local.x).toBe(0.7);

    // b is killed too; the next visit saves b's move
    await open(server, storage);
    await tick(DEBOUNCE_MS);
    expect(server.circles.get(id)!.x).toBe(0.7);
  });

  it("an editor with nothing pending never rewrites the outbox (no write on hide)", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const d = await open(server, storage);
    const writes = storage.writes;
    d.env.hide();
    d.env.show();
    await settle();
    d.store.dispose();
    expect(storage.writes).toBe(writes);
  });
});

describe("an outbox saved by the app before the rebrand (amber, purple)", () => {
  /** The stored outbox as the previous version wrote it: gold was "amber", black was "purple". */
  function makeLegacy(storage: MemoryStorage, planId: string) {
    const key = outboxKey(planId);
    storage.setItem(key, storage.getItem(key)!.replace(/"gold"/g, '"amber"').replace(/"black"/g, '"purple"'));
    return key;
  }

  it("restores the colours meant: a purple circle moved offline lands as black, moved", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const id = await savedCircle(ipad);
    ipad.store.updateCircle(id, { color: "black" });
    await ipad.store.flushNow();
    ipad.env.connected = false;
    ipad.net.failWith = 0;
    ipad.store.updateCircle(id, { x: 0.6 });
    await ipad.store.flushNow();
    // (the tab is killed; the app is updated)
    const key = makeLegacy(storage, server.planId);
    expect(storage.getItem(key)).toContain('"purple"');

    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(id)).toMatchObject({ x: 0.6, color: "black" });
    expect(again.store.getState().circleById.get(id)).toMatchObject({ x: 0.6, color: "black" });
    expect(storage.data.has(key)).toBe(false);
  });

  it("an unsent recolour to purple saves as black; an amber circle only moved here keeps the other device's recolour", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const ipad = await openMortal(server, storage);
    const recoloured = await savedCircle(ipad, 0.2);
    const moved = await savedCircle(ipad, 0.4);
    ipad.env.connected = false;
    ipad.net.failWith = 0;
    ipad.store.updateCircle(recoloured, { color: "black" });
    ipad.store.updateCircle(moved, { x: 0.7 });
    await ipad.store.flushNow();
    const key = makeLegacy(storage, server.planId);
    expect(storage.getItem(key)).toContain('"amber"');

    await elsewhere(server, (desk) => desk.store.updateCircle(moved, { color: "red" }));
    const again = await open(server, storage);
    await tick(DEBOUNCE_MS * 4);
    expect(server.circles.get(recoloured)).toMatchObject({ color: "black" });
    expect(server.circles.get(moved)).toMatchObject({ x: 0.7, color: "red" });
    expect(again.store.getState().circleById.get(moved)).toMatchObject({ x: 0.7, color: "red" });
    expect(storage.data.has(key)).toBe(false);
  });
});
