// Derived state: ordering, cascade hiding and structural sharing.

import { describe, expect, it } from "vitest";
import { createDeriver, type DocView } from "../../src/client/sync/derive";
import type { CircleRow, CommentRow, PageRow } from "../../src/shared/types";

const page = (id: string, sortOrder: number, over: Partial<PageRow> = {}): PageRow =>
  ({ id, planId: "p", sortOrder, label: id, createdAt: 1, sourceIndex: 0, deletedAt: null, rev: 1, ...over }) as PageRow;
const circle = (id: string, pageId: string, num: number, over: Partial<CircleRow> = {}): CircleRow => ({
  id,
  planId: "p",
  pageId,
  x: 0.5,
  y: 0.5,
  r: 0.05,
  color: "amber",
  title: "",
  num,
  createdAt: 100 + num,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  ...over,
});
const comment = (id: string, circleId: string, createdAt: number, over: Partial<CommentRow> = {}): CommentRow => ({
  id,
  planId: "p",
  circleId,
  body: id,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  rev: 1,
  ...over,
});

/** A tiny mutable doc like the engine's (maps + version counters). */
function makeDoc(pages: PageRow[], circles: CircleRow[], comments: CommentRow[]) {
  const d = {
    pages: new Map(pages.map((p) => [p.id, p])),
    circles: new Map(circles.map((c) => [c.id, c])),
    comments: new Map(comments.map((m) => [m.id, m])),
    ver: { page: 0, circle: 0, comment: 0 },
  };
  return {
    view: d as DocView,
    setPage(p: PageRow) {
      d.pages.set(p.id, p);
      d.ver.page++;
    },
    setCircle(c: CircleRow) {
      d.circles.set(c.id, c);
      d.ver.circle++;
    },
    setComment(m: CommentRow) {
      d.comments.set(m.id, m);
      d.ver.comment++;
    },
  };
}

describe("derived plan state", () => {
  it("sorts live pages by sortOrder and hides deleted ones", () => {
    const doc = makeDoc([page("b", 2), page("a", 1), page("gone", 1.5, { deletedAt: 5 }), page("c", 3)], [], []);
    const d = createDeriver()(doc.view);
    expect(d.pages.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect([...d.pageById.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("orders circles by number, unnumbered (new) ones last, and comments oldest first", () => {
    const doc = makeDoc(
      [page("a", 1)],
      [circle("c3", "a", 3), circle("new2", "a", 0, { createdAt: 900 }), circle("c1", "a", 1), circle("new1", "a", 0, { createdAt: 800 })],
      [comment("m2", "c1", 20), comment("m1", "c1", 10), comment("m3", "c1", 30)],
    );
    const d = createDeriver()(doc.view);
    expect(d.circlesByPage.get("a")!.map((c) => c.id)).toEqual(["c1", "c3", "new1", "new2"]);
    expect(d.commentsByCircle.get("c1")!.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(d.commentsByCircle.get("c3")).toEqual([]);
  });

  it("cascades visibility: a deleted page hides its circles and their comments, and restoring brings them back", () => {
    const doc = makeDoc(
      [page("a", 1), page("b", 2)],
      [circle("c1", "a", 1), circle("c2", "b", 2), circle("cDel", "b", 3, { deletedAt: 9 })],
      [comment("m1", "c1", 1), comment("m2", "c2", 2), comment("m3", "cDel", 3), comment("mDel", "c2", 4, { deletedAt: 9 })],
    );
    const derive = createDeriver();
    let d = derive(doc.view);
    expect([...d.circleById.keys()].sort()).toEqual(["c1", "c2"]);
    expect(d.commentsByCircle.get("c2")!.map((m) => m.id)).toEqual(["m2"]);
    expect(d.commentsByCircle.has("cDel")).toBe(false);

    doc.setPage(page("b", 2, { deletedAt: 50 }));
    d = derive(doc.view);
    expect([...d.circleById.keys()]).toEqual(["c1"]);
    expect(d.circlesByPage.has("b")).toBe(false);
    expect(d.commentsByCircle.has("c2")).toBe(false);

    doc.setPage(page("b", 2));
    d = derive(doc.view);
    expect([...d.circleById.keys()].sort()).toEqual(["c1", "c2"]);
    expect(d.commentsByCircle.get("c2")!.map((m) => m.id)).toEqual(["m2"]);
  });

  it("returns the same object when nothing changed", () => {
    const doc = makeDoc([page("a", 1)], [circle("c1", "a", 1)], [comment("m1", "c1", 1)]);
    const derive = createDeriver();
    const d1 = derive(doc.view);
    expect(derive(doc.view)).toBe(d1);
  });

  it("dragging one circle keeps the other pages' arrays and the comments map (memoized components skip work)", () => {
    const doc = makeDoc(
      [page("a", 1), page("b", 2)],
      [circle("c1", "a", 1), circle("c2", "a", 2), circle("c3", "b", 3)],
      [comment("m1", "c1", 1), comment("m3", "c3", 2)],
    );
    const derive = createDeriver();
    const d1 = derive(doc.view);
    doc.setCircle({ ...doc.view.circles.get("c1")!, x: 0.9 });
    const d2 = derive(doc.view);
    expect(d2.circlesByPage.get("a")).not.toBe(d1.circlesByPage.get("a"));
    expect(d2.circlesByPage.get("a")![0].x).toBe(0.9);
    expect(d2.circlesByPage.get("b")).toBe(d1.circlesByPage.get("b"));
    expect(d2.circleById.get("c2")).toBe(d1.circleById.get("c2"));
    expect(d2.commentsByCircle).toBe(d1.commentsByCircle);
    expect(d2.pages).toBe(d1.pages);

    // a comment edit leaves the circles alone
    doc.setComment({ ...doc.view.comments.get("m1")!, body: "edited" });
    const d3 = derive(doc.view);
    expect(d3.circlesByPage).toBe(d2.circlesByPage);
    expect(d3.commentsByCircle.get("c1")![0].body).toBe("edited");
    expect(d3.commentsByCircle.get("c3")).toBe(d2.commentsByCircle.get("c3"));
  });

  it("a page rename re-derives pages but reuses the circle arrays", () => {
    const doc = makeDoc([page("a", 1), page("b", 2)], [circle("c1", "a", 1)], []);
    const derive = createDeriver();
    const d1 = derive(doc.view);
    doc.setPage(page("a", 1, { label: "Concourse" }));
    const d2 = derive(doc.view);
    expect(d2.pages[0].label).toBe("Concourse");
    expect(d2.circlesByPage).toBe(d1.circlesByPage);
    expect(d2.circleById).toBe(d1.circleById);
  });
});
