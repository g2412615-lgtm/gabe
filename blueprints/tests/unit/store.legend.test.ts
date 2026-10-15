// Colour labels: saved like any plan edit (one undo step per label typed),
// cleaned the same on both sides, and never blanked by a change an older
// version of the app left waiting on a device.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRow, outboxKey } from "../../src/client/sync/outbox";
import { DEBOUNCE_MS } from "../../src/client/sync/store";
import { legendOf } from "../../src/shared/labels";
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

describe("setColorLabel", () => {
  it("saves the label for the plan; typing it is one undo step; green starts as General notes", async () => {
    const server = new FakeServer();
    const d = device(server);
    await d.store.load();
    const plan = () => d.store.getState().plan!;
    expect(legendOf(plan(), "green")).toBe("General notes");
    expect(legendOf(plan(), "red")).toBe("");

    for (const typed of ["S", "Se", "Sec", "Security"]) d.store.setColorLabel("red", typed);
    expect(plan().legendRed).toBe("Security");
    await tick(DEBOUNCE_MS);
    expect(server.plan.legendRed).toBe("Security");
    expect(server.plan.legendGreen).toBe("General notes"); // only what changed is sent

    d.store.setColorLabel("green", ""); // unassigned is a label too
    await tick(DEBOUNCE_MS);
    expect(server.plan.legendGreen).toBe("");

    d.store.undo(); // green back
    d.store.undo(); // the whole word typed into red
    expect(plan()).toMatchObject({ legendGreen: "General notes", legendRed: "" });
    await tick(DEBOUNCE_MS);
    expect(server.plan).toMatchObject({ legendGreen: "General notes", legendRed: "" });
  });

  it("keeps a label on one line and within the limit, as the server does", async () => {
    const server = new FakeServer();
    const d = device(server);
    await d.store.load();
    d.store.setColorLabel("blue", "Medical\tand\nfirst aid " + "x".repeat(80));
    const v = d.store.getState().plan!.legendBlue;
    expect(v.startsWith("Medical and first aid ")).toBe(true);
    expect(v.length).toBe(60);
    await tick(DEBOUNCE_MS);
    expect(server.plan.legendBlue).toBe(v); // the echo matches what's in the field
  });

  it("two devices labelling different colours both keep theirs", async () => {
    const server = new FakeServer();
    const a = device(server);
    const b = device(server);
    await a.store.load();
    await b.store.load();
    a.store.setColorLabel("red", "Security");
    b.store.setColorLabel("blue", "Medical");
    await tick(DEBOUNCE_MS);
    await a.store.pull();
    await b.store.pull();
    expect(server.plan).toMatchObject({ legendRed: "Security", legendBlue: "Medical" });
    expect(a.store.getState().plan).toMatchObject({ legendRed: "Security", legendBlue: "Medical" });
    expect(b.store.getState().plan).toMatchObject({ legendRed: "Security", legendBlue: "Medical" });
  });
});

describe("a change the previous version left on the device", () => {
  it("a waiting rename saves without touching the colour labels", async () => {
    const server = new FakeServer({ name: "Old name" });
    server.plan.legendRed = "Security"; // set on another device after the update
    const storage = new MemoryStorage();
    // the outbox as the app before colour labels wrote it: a plan entry knows only name and deletedAt
    const p = server.plan;
    const local = { id: p.id, name: "Renamed offline", createdAt: p.createdAt, updatedAt: p.updatedAt + 1, deletedAt: null, rev: p.rev };
    storage.setItem(
      outboxKey(server.planId),
      JSON.stringify({ v: 2, name: "Renamed offline", entries: { [`plan:${p.id}`]: { local, base: { name: "Old name", deletedAt: null } } } }),
    );
    const d = device(server, { storage });
    await d.store.load();
    await tick(DEBOUNCE_MS);
    expect(server.plan).toMatchObject({ name: "Renamed offline", legendRed: "Security", legendGreen: "General notes" });
    expect(d.store.getState().plan).toMatchObject({ name: "Renamed offline", legendRed: "Security", legendGreen: "General notes" });
    expect(d.store.hasUnsaved()).toBe(false);
  });

  it("an older tab's waiting rename carrying stale labels it was sent can't put them back over newer ones", async () => {
    const server = new FakeServer({ name: "Old name" });
    // what the older tab's row looks like: it pulled the plan after the update, so it holds the labels as they were then
    const p = server.plan;
    const local = { ...p, name: "Renamed offline", legendRed: "", legendGreen: "General notes", updatedAt: p.updatedAt + 1 };
    // since then, another device on the new version set two labels
    server.plan.legendRed = "Security";
    server.plan.legendGreen = "Staff posts";
    const storage = new MemoryStorage();
    for (const sent of [null, { name: "Renamed offline", deletedAt: null }]) {
      storage.setItem(
        outboxKey(server.planId),
        // the older version wrote base and sent with the fields it knew: name and deletedAt
        JSON.stringify({ v: 2, name: "Renamed offline", entries: { [`plan:${p.id}`]: { local, base: { name: "Old name", deletedAt: null }, sent } } }),
      );
      const d = device(server, { storage });
      await d.store.load();
      await tick(DEBOUNCE_MS);
      expect(server.plan).toMatchObject({ name: "Renamed offline", legendRed: "Security", legendGreen: "Staff posts" });
      expect(d.store.getState().plan).toMatchObject({ legendRed: "Security", legendGreen: "Staff posts" });
      d.store.dispose();
      server.plan.name = "Old name";
    }
  });

  it("normalizeRow keeps labels an entry has and invents none it doesn't", () => {
    const base = { id: "p1", name: "N", createdAt: 1, updatedAt: 2, deletedAt: null, rev: 3 };
    const old = normalizeRow("plan", "p1", "p1", base) as unknown as Record<string, unknown>;
    expect("legendGreen" in old).toBe(false);
    const now = normalizeRow("plan", "p1", "p1", { ...base, legendGreen: "", legendRed: "Security", legendBlue: 7 }) as unknown as Record<string, unknown>;
    expect(now).toMatchObject({ legendGreen: "", legendRed: "Security" });
    expect("legendBlue" in now).toBe(false);
  });
});
