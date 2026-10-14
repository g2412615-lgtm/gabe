// merge3 / editableOf / sameEditable (src/shared/merge.ts): the field-level
// rule every sync decision rests on.

import { describe, expect, it } from "vitest";
import { editableOf, merge3, sameEditable, sameValue } from "../../src/shared/merge";
import type { CircleRow, CommentRow, PageRow } from "../../src/shared/types";

const circle = (over: Partial<CircleRow> = {}): CircleRow => ({
  id: "c1",
  planId: "p1",
  pageId: "g1",
  x: 0.2,
  y: 0.3,
  r: 0.05,
  color: "gold",
  title: "",
  num: 4,
  createdAt: 1000,
  updatedAt: 1000,
  deletedAt: null,
  rev: 1,
  ...over,
});

describe("merge3", () => {
  it("keeps fields changed locally and takes the server's for the rest", () => {
    const base = circle();
    const local = circle({ x: 0.6, y: 0.7 }); // moved here
    const remote = circle({ color: "red", rev: 2, updatedAt: 2000 }); // recoloured on the other device
    expect(merge3("circle", base, local, remote)).toEqual(circle({ x: 0.6, y: 0.7, color: "red", rev: 2, updatedAt: 2000 }));
  });

  it("lets the local value win when both sides changed the same field", () => {
    const merged = merge3("circle", circle(), circle({ title: "Gate A" }), circle({ title: "Gate B", rev: 2 }));
    expect(merged.title).toBe("Gate A");
    expect(merged.rev).toBe(2);
  });

  it("always takes server-owned fields from the server (num, rev, timestamps, parents)", () => {
    const local = circle({ num: 0, rev: 0, updatedAt: 5, pageId: "g-local" });
    const remote = circle({ num: 12, rev: 3, updatedAt: 9000, pageId: "g1" });
    const merged = merge3("circle", circle({ num: 0 }), local, remote);
    expect(merged).toMatchObject({ num: 12, rev: 3, updatedAt: 9000, pageId: "g1" });
  });

  it("with no base, every local editable field wins (a create the server echoed or a replayed create)", () => {
    const local = circle({ x: 0.9, color: "blue", num: 0 });
    const remote = circle({ x: 0.1, color: "green", num: 7 });
    const merged = merge3("circle", null, local, remote);
    expect(merged).toMatchObject({ x: 0.9, color: "blue", num: 7 });
  });

  it("treats deletedAt as editable both ways (delete and undo-delete)", () => {
    expect(merge3("circle", circle(), circle({ deletedAt: 50 }), circle({ rev: 2 })).deletedAt).toBe(50);
    expect(merge3("circle", circle({ deletedAt: 50 }), circle({ deletedAt: null }), circle({ deletedAt: 60, rev: 2 })).deletedAt).toBeNull();
    // deleted remotely, untouched here → deleted
    expect(merge3("circle", circle(), circle(), circle({ deletedAt: 70, rev: 2 })).deletedAt).toBe(70);
  });

  it("works for comments and pages", () => {
    const c: CommentRow = { id: "m", planId: "p", circleId: "c", body: "hi", createdAt: 1, updatedAt: 1, deletedAt: null, rev: 1 };
    expect(merge3("comment", c, { ...c, body: "hi there" }, { ...c, rev: 2, updatedAt: 3 })).toMatchObject({ body: "hi there", rev: 2, updatedAt: 3 });
    const p = { id: "g", label: "A-101", sortOrder: 1, status: "preview", assetKey: "k1", deletedAt: null, rev: 1 } as unknown as PageRow;
    const merged = merge3("page", p, { ...p, label: "A-101 Seating bowl" }, { ...p, status: "ready", assetKey: "k2", sortOrder: 5, rev: 2 });
    expect(merged).toMatchObject({ label: "A-101 Seating bowl", status: "ready", assetKey: "k2", sortOrder: 5 });
  });
});

describe("editableOf / sameEditable / sameValue", () => {
  it("picks only the editable fields, with null for missing ones", () => {
    expect(editableOf("circle", circle())).toEqual({ x: 0.2, y: 0.3, r: 0.05, color: "gold", title: "", deletedAt: null });
    expect(editableOf("comment", { body: "x" })).toEqual({ body: "x", deletedAt: null });
  });

  it("compares editable fields only", () => {
    expect(sameEditable("circle", circle(), circle({ num: 9, rev: 5, updatedAt: 1 }))).toBe(true);
    expect(sameEditable("circle", circle(), circle({ r: 0.06 }))).toBe(false);
    expect(sameEditable("circle", null, null)).toBe(true);
    expect(sameEditable("circle", circle(), null)).toBe(false);
  });

  it("treats NaN as equal to NaN", () => {
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
  });
});
