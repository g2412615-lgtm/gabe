// The undo/redo stacks on their own (store-level undo is in store.history.test.ts).

import { describe, expect, it } from "vitest";
import { COALESCE_IDLE_MS, History, MAX_HISTORY } from "../../src/client/sync/history";

const ch = (id: string, before: Record<string, unknown>, after: Record<string, unknown>) => ({ kind: "comment" as const, id, before, after });

describe("History", () => {
  it("undoes and redoes in order and a new step clears redo", () => {
    const h = new History();
    h.push([ch("a", { body: "" }, { body: "1" })], 0);
    h.push([ch("a", { body: "1" }, { body: "2" })], 10_000);
    expect(h.takeUndo()!.changes[0].after).toEqual({ body: "2" });
    expect(h.canRedo).toBe(true);
    expect(h.takeRedo()!.changes[0].after).toEqual({ body: "2" });
    h.takeUndo();
    h.push([ch("b", { body: "" }, { body: "x" })], 20_000);
    expect(h.canRedo).toBe(false);
  });

  it("coalesces a typing run with the same tag; the earliest before and the latest after win", () => {
    const h = new History();
    h.push([ch("a", { deletedAt: 5 }, { deletedAt: null })], 0, "comment:a");
    h.push([ch("a", { body: "H" }, { body: "He" })], 500, "comment:a");
    h.push([ch("a", { body: "He" }, { body: "Hey" })], 1000, "comment:a");
    const step = h.takeUndo()!;
    expect(step.changes).toEqual([ch("a", { deletedAt: 5, body: "H" }, { deletedAt: null, body: "Hey" })]);
    expect(h.canUndo).toBe(false);
  });

  it("starts a new step after the idle gap, for another tag, or after seal()", () => {
    const h = new History();
    h.push([ch("a", { body: "" }, { body: "1" })], 0, "comment:a");
    h.push([ch("a", { body: "1" }, { body: "12" })], COALESCE_IDLE_MS + 1, "comment:a");
    h.push([ch("b", { body: "" }, { body: "x" })], COALESCE_IDLE_MS + 2, "comment:b");
    h.seal();
    h.push([ch("b", { body: "x" }, { body: "xy" })], COALESCE_IDLE_MS + 3, "comment:b");
    let n = 0;
    while (h.takeUndo()) n++;
    expect(n).toBe(4);
  });

  it("does not merge into a step that is no longer on top (after an undo)", () => {
    const h = new History();
    h.push([ch("a", { body: "" }, { body: "1" })], 0, "comment:a");
    h.takeUndo();
    h.push([ch("a", { body: "" }, { body: "2" })], 100, "comment:a");
    expect(h.takeUndo()!.changes[0].after).toEqual({ body: "2" });
    expect(h.takeUndo()).toBeNull();
  });

  it("keeps at most MAX_HISTORY steps", () => {
    const h = new History();
    for (let i = 0; i < MAX_HISTORY + 20; i++) h.push([ch("a", { body: String(i) }, { body: String(i + 1) })], i * 10_000);
    let n = 0;
    while (h.takeUndo()) n++;
    expect(n).toBe(MAX_HISTORY);
  });
});
