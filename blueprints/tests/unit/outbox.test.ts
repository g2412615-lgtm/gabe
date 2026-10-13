// The device outbox format and its defences, plus client-side value cleaning.

import { describe, expect, it } from "vitest";
import { cleanName, cleanPatch, utf8Length } from "../../src/client/sync/clean";
import { normalizeRow, outboxKey, readOutbox, writeOutbox } from "../../src/client/sync/outbox";
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
  it("round-trips entries under bpn-outbox:<planId> in the v1 format", () => {
    const s = new MemoryStorage();
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: true }]);
    const raw = s.json(outboxKey("p1"));
    expect(raw).toEqual({ v: 1, entries: { "circle:c1": { local: circle, base: null, sent: true } } });
    expect(readOutbox(s, "p1")).toEqual([{ kind: "circle", id: "c1", local: circle, base: null, sent: true }]);
  });

  it("removes the key when nothing is pending", () => {
    const s = new MemoryStorage();
    writeOutbox(s, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: false }]);
    writeOutbox(s, "p1", []);
    expect(s.data.has(outboxKey("p1"))).toBe(false);
  });

  it("ignores broken, foreign-version and malformed data instead of throwing", () => {
    const s = new MemoryStorage();
    s.setItem(outboxKey("p1"), "{not json");
    expect(readOutbox(s, "p1")).toEqual([]);
    s.setItem(outboxKey("p1"), JSON.stringify({ v: 2, entries: {} }));
    expect(readOutbox(s, "p1")).toEqual([]);
    s.setItem(
      outboxKey("p1"),
      JSON.stringify({
        v: 1,
        entries: {
          "circle:c1": { local: circle, base: { x: 0.1 } },
          "circle:wrong-id": { local: circle, base: null },
          "circle:c2": { local: { ...circle, id: "c2", x: "left" }, base: null },
          "bogus:c3": { local: circle, base: null },
          nocolon: {},
        },
      }),
    );
    const entries = readOutbox(s, "p1");
    expect(entries.map((e) => e.id)).toEqual(["c1"]);
    expect(entries[0]).toMatchObject({ base: { x: 0.1 }, sent: false });
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
    expect(writeOutbox(throwing, "p1", [{ kind: "circle", id: "c1", local: circle, base: null, sent: false }])).toBe(false);
    expect(readOutbox(null, "p1")).toEqual([]);
  });

  it("normalizes stored rows (fills defaults, clamps, rejects rows missing their parent)", () => {
    const row = normalizeRow("circle", "c1", "p1", { ...circle, x: 3, r: 9, color: "pink", title: undefined }) as CircleRow;
    expect(row).toMatchObject({ x: 1, r: MAX_CIRCLE_R, color: "amber", title: "" });
    expect(normalizeRow("circle", "c1", "p1", { ...circle, pageId: undefined })).toBeNull();
    expect(normalizeRow("comment", "m1", "p1", { id: "m1", body: "x" })).toBeNull();
    expect(normalizeRow("comment", "m1", "p1", { id: "m1", circleId: "c1", body: "x", createdAt: 5 })).toMatchObject({ body: "x", deletedAt: null, planId: "p1" });
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
