// The device outbox format and its defences, plus client-side value cleaning.

import { describe, expect, it } from "vitest";
import { cleanName, cleanPatch, utf8Length } from "../../src/client/sync/clean";
import { entryJson, hasOutbox, listOutboxPlans, normalizeRow, outboxKey, readOutbox, readStored, restoreRow, writeOutbox, writeStored } from "../../src/client/sync/outbox";
import { MAX_CIRCLE_R, MAX_TITLE_CHARS, MIN_CIRCLE_R } from "../../src/shared/constants";
import type { CircleRow } from "../../src/shared/types";
import { MemoryStorage } from "./fakes";

const circle: CircleRow = {
  id: "c1",
  planId: "p1",
  pageId: "g1",
  x: 0.2,
  y: 0.3,
  r: 0.05,
  color: "blue",
  title: "Gate A",
  num: 0,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
  rev: 0,
};

describe("outbox", () => {
  const sent = { x: 0.2, y: 0.3, r: 0.05, color: "blue", title: "Gate A", deletedAt: null };

  it("round-trips entries under bpn-outbox:<planId> in the v2 format (with the plan's name)", () => {
    const s = new MemoryStorage();
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent }], "Home opener");
    const raw = s.json(outboxKey("p1"));
    expect(raw).toEqual({ v: 2, name: "Home opener", entries: { "circle:c1": { local: circle, base: null, sent } } });
    expect(readOutbox(s, "p1")).toEqual([{ kind: "circle", id: "c1", local: circle, base: null, sent }]);
    expect(readStored(s, "p1").name).toBe("Home opener");
    // an entry whose values never left the device has no `sent`
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: null }]);
    expect(s.json(outboxKey("p1")).entries["circle:c1"]).toEqual({ local: circle, base: null });
    expect(readOutbox(s, "p1")[0].sent).toBeNull();
  });

  it("keeps each entry's exact stored text (a store compares it with what it wrote)", () => {
    const s = new MemoryStorage();
    const json = entryJson({ local: circle, base: { x: 0.1 }, sent: null });
    writeStored(s, "p1", new Map([["circle:c1", json]]), null);
    expect(readStored(s, "p1").entries.get("circle:c1")!.json).toBe(json);
  });

  it("reads a v1 outbox (from before `sent`), counting every entry as possibly sent", () => {
    const s = new MemoryStorage();
    s.setItem(outboxKey("p1"), JSON.stringify({ v: 1, entries: { "circle:c1": { local: circle, base: { x: 0.1 } } } }));
    const [e] = readOutbox(s, "p1");
    expect(e.sent).toEqual({ x: 0.2, y: 0.3, r: 0.05, color: "blue", title: "Gate A", deletedAt: null });
  });

  it("removes the key when nothing is pending", () => {
    const s = new MemoryStorage();
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: null }]);
    writeOutbox(s, "p1", []);
    expect(s.data.has(outboxKey("p1"))).toBe(false);
  });

  it("lists the plans with an outbox on this device", () => {
    const s = new MemoryStorage();
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: null }]);
    writeOutbox(s, "p2", [{ kind: "circle", id: "c1", local: { ...circle, planId: "p2" }, base: null, sent: null }]);
    s.setItem("bpn-home-sort", "name");
    s.setItem("bpn-outbox:", "{}");
    expect(listOutboxPlans(s).sort()).toEqual(["p1", "p2"]);
    expect(hasOutbox(s, "p1")).toBe(true);
    expect(hasOutbox(s, "p3")).toBe(false);
    expect(listOutboxPlans(null)).toEqual([]);
  });

  it("ignores broken, foreign-version and malformed data instead of throwing", () => {
    const s = new MemoryStorage();
    s.setItem(outboxKey("p1"), "{not json");
    expect(readOutbox(s, "p1")).toEqual([]);
    s.setItem(outboxKey("p1"), JSON.stringify({ v: 3, entries: { "circle:c1": { local: circle, base: null } } }));
    expect(readOutbox(s, "p1")).toEqual([]);
    s.setItem(
      outboxKey("p1"),
      JSON.stringify({
        v: 2,
        entries: {
          "circle:c1": { local: circle, base: { x: 0.1 }, sent: "yes" },
          "circle:wrong-id": { local: circle, base: null },
          "circle:c2": { local: { ...circle, id: "c2", x: "left" }, base: null },
          "bogus:c3": { local: circle, base: null },
          nocolon: {},
        },
      }),
    );
    const entries = readOutbox(s, "p1");
    expect(entries.map((e) => e.id)).toEqual(["c1"]);
    expect(entries[0]).toMatchObject({ base: { x: 0.1 }, sent: null });
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readOutbox(throwing, "p1")).toEqual([]);
    expect(writeOutbox(throwing, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: null }])).toBe(false);
    expect(readOutbox(null, "p1")).toEqual([]);
  });

  it("normalizes stored rows (fills defaults, clamps, rejects rows missing their parent)", () => {
    const row = normalizeRow("circle", "c1", "p1", { ...circle, x: 3, r: 9, color: "pink", title: undefined }) as CircleRow;
    expect(row).toMatchObject({ x: 1, r: MAX_CIRCLE_R, color: "gold", title: "" });
    expect(normalizeRow("circle", "c1", "p1", { ...circle, pageId: undefined })).toBeNull();
    expect(normalizeRow("comment", "m1", "p1", { id: "m1", body: "x" })).toBeNull();
    expect(normalizeRow("comment", "m1", "p1", { id: "m1", circleId: "c1", body: "x", createdAt: 5 })).toMatchObject({ body: "x", deletedAt: null, planId: "p1" });
  });

  it("reads an outbox saved before the rebrand with today's colour names (amber → gold, purple → black)", () => {
    const s = new MemoryStorage();
    const old = { local: { ...circle, color: "purple" }, base: { ...sent, color: "amber" }, sent: { ...sent, color: "purple" } };
    s.setItem(outboxKey("p1"), JSON.stringify({ v: 2, name: null, entries: { "circle:c1": old } }));
    expect(readOutbox(s, "p1")[0]).toMatchObject({ local: { color: "black" }, base: { color: "gold" }, sent: { color: "black" } });
    expect(normalizeRow("circle", "c1", "p1", { ...circle, color: "amber" })).toMatchObject({ color: "gold" });
    // an unknown colour still falls back to the default, and other fields are left as stored
    s.setItem(outboxKey("p1"), JSON.stringify({ v: 2, name: null, entries: { "circle:c1": { ...old, base: { ...sent, color: "pink" } } } }));
    expect(readOutbox(s, "p1")[0].base).toEqual({ ...sent, color: "pink" });
  });
});

describe("restoring an entry over the server's copy (restoreRow)", () => {
  // the server's row as it is when the plan is opened again
  const server = (over: Partial<CircleRow> = {}): CircleRow => ({ ...circle, x: 0.2, title: "", rev: 3, num: 4, ...over });
  const base = { x: 0.2, y: 0.3, r: 0.05, color: "blue", title: "", deletedAt: null };

  it("a change that never left the device wins, even over a newer server value (like any pending edit)", () => {
    const local = { ...circle, x: 0.6, title: "" };
    expect(restoreRow("circle", { local, base, sent: null }, server())).toMatchObject({ x: 0.6, num: 4, rev: 3 });
    expect(restoreRow("circle", { local, base, sent: null }, server({ x: 0.9 }))).toMatchObject({ x: 0.6 });
  });

  it("a change that went out wins only while the server still has the base value", () => {
    const local = { ...circle, x: 0.6, title: "" };
    const e = { local, base, sent: { ...base, x: 0.6 } };
    expect(restoreRow("circle", e, server()).x).toBe(0.6); // never landed: send it again
    expect(restoreRow("circle", e, server({ x: 0.6 })).x).toBe(0.6); // landed
    expect(restoreRow("circle", e, server({ x: 0.9, title: "Gate A" }))).toMatchObject({ x: 0.9, title: "Gate A" }); // landed, then the other device moved it
  });

  it("fields not changed here always follow the server", () => {
    const local = { ...circle, x: 0.6, title: "" };
    expect(restoreRow("circle", { local, base, sent: null }, server({ color: "green", deletedAt: 5 }))).toMatchObject({ x: 0.6, color: "green", deletedAt: 5 });
  });

  it("a create that reached the server is taken as the server has it (deleted there stays deleted)", () => {
    const local = { ...circle, x: 0.3 };
    const createSent = { ...base, x: 0.3, title: "Gate A" };
    const deleted = server({ x: 0.3, title: "Gate A", deletedAt: 99 });
    expect(restoreRow("circle", { local, base: null, sent: createSent }, deleted).deletedAt).toBe(99);
    // …but an edit made after the create went out is still this device's to save
    expect(restoreRow("circle", { local: { ...local, color: "red" }, base: null, sent: createSent }, deleted)).toMatchObject({ color: "red", deletedAt: 99 });
  });
});

describe("clean", () => {
  it("clamps geometry, drops invalid values and keeps only editable fields", () => {
    expect(cleanPatch("circle", { x: -1, y: 2, r: 0, color: "pink", title: "a\u0000b", num: 5, pageId: "x" })).toEqual({
      x: 0,
      y: 1,
      r: MIN_CIRCLE_R,
      title: "ab",
    });
    expect(cleanPatch("circle", { x: Number.NaN, deletedAt: "yes" })).toEqual({});
    expect(cleanPatch("circle", { deletedAt: 5 })).toEqual({ deletedAt: 5 });
  });

  it("caps text without trimming it (typing a space before the next word must survive)", () => {
    expect(cleanPatch("comment", { body: "Gate A " })).toEqual({ body: "Gate A " });
    expect((cleanPatch("circle", { title: "x".repeat(MAX_TITLE_CHARS + 5) }).title as string).length).toBe(MAX_TITLE_CHARS);
  });

  it("trims names and ignores empty ones (a page label can't be blank)", () => {
    expect(cleanPatch("page", { label: "  A-101   Seating  bowl " })).toEqual({ label: "A-101 Seating bowl" });
    expect(cleanPatch("page", { label: "   " })).toEqual({});
    expect(cleanPatch("plan", { name: "" })).toEqual({});
    expect(cleanName("\tHome  opener\n", 200)).toBe("Home opener");
  });

  it("measures UTF-8 bytes", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("—")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
  });
});
