// Derived, display-ready views of the plan's rows: live pages in order,
// circles per page, comments per circle. Recomputed only when the rows they
// depend on change, and structurally shared: an array or map whose contents
// didn't change keeps its identity, so memoized React components (one per
// circle, one per page) skip re-rendering while another circle is dragged.
//
// Visibility cascades without touching children (SPEC §2): a circle is
// hidden when it or its page is deleted; a comment when it, its circle or
// the circle's page is deleted.

import { comparePages } from "../../shared/order";
import type { CircleRow, CommentRow, ID, PageRow } from "../../shared/types";

/** The document as the engine keeps it, with a version counter per kind (bumped on every change). */
export interface DocView {
  pages: ReadonlyMap<ID, PageRow>;
  circles: ReadonlyMap<ID, CircleRow>;
  comments: ReadonlyMap<ID, CommentRow>;
  ver: { readonly page: number; readonly circle: number; readonly comment: number };
}

export interface Derived {
  pages: PageRow[];
  pageById: Map<ID, PageRow>;
  circleById: Map<ID, CircleRow>;
  circlesByPage: Map<ID, CircleRow[]>;
  commentsByCircle: Map<ID, CommentRow[]>;
}

const EMPTY_CIRCLES = Object.freeze([]) as unknown as CircleRow[];
const EMPTY_COMMENTS = Object.freeze([]) as unknown as CommentRow[];

export { comparePages };

/** By number; circles the server hasn't numbered yet (num 0) come last, oldest first. */
export function compareCircles(a: CircleRow, b: CircleRow): number {
  const na = a.num > 0 ? a.num : Number.POSITIVE_INFINITY;
  const nb = b.num > 0 ? b.num : Number.POSITIVE_INFINITY;
  if (na !== nb) return na < nb ? -1 : 1;
  return a.createdAt - b.createdAt || cmpStr(a.id, b.id);
}

export function compareComments(a: CommentRow, b: CommentRow): number {
  return a.createdAt - b.createdAt || cmpStr(a.id, b.id);
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sameArray<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameMap<K, V>(a: ReadonlyMap<K, V> | undefined, b: ReadonlyMap<K, V>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

function sameKeys<K>(a: ReadonlyMap<K, unknown> | undefined, b: ReadonlyMap<K, unknown>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const k of b.keys()) if (!a.has(k)) return false;
  return true;
}

/** Group rows into sorted arrays per parent, reusing the previous array for a parent whose rows didn't change. */
function groupInto<T>(
  parents: Iterable<ID>,
  rows: Iterable<T>,
  parentOf: (row: T) => ID | null,
  compare: (a: T, b: T) => number,
  prev: Map<ID, T[]> | undefined,
  empty: T[],
): Map<ID, T[]> {
  const groups = new Map<ID, T[]>();
  for (const p of parents) groups.set(p, empty);
  for (const row of rows) {
    const p = parentOf(row);
    if (p === null) continue;
    const g = groups.get(p);
    if (g === undefined) continue;
    if (g === empty) groups.set(p, [row]);
    else g.push(row);
  }
  let unchanged = !!prev && prev.size === groups.size;
  for (const [p, g] of groups) {
    if (g !== empty && g.length > 1) g.sort(compare);
    const old = prev?.get(p);
    if (old && (old === g || sameArray(old, g))) {
      groups.set(p, old);
    } else unchanged = false;
  }
  return unchanged && prev ? prev : groups;
}

/** A memoizing deriver: call it with the current doc on every state build. */
export function createDeriver(): (doc: DocView) => Derived {
  let pageVer = -1;
  let circleVer = -1;
  let commentVer = -1;
  let pages: PageRow[] = [];
  let pageById = new Map<ID, PageRow>();
  let circleById = new Map<ID, CircleRow>();
  let circlesByPage = new Map<ID, CircleRow[]>();
  let commentsByCircle = new Map<ID, CommentRow[]>();
  let result: Derived | null = null;

  return (doc) => {
    const { ver } = doc;
    let pagesChanged = false;
    if (ver.page !== pageVer) {
      pageVer = ver.page;
      const next: PageRow[] = [];
      for (const p of doc.pages.values()) if (p.deletedAt === null) next.push(p);
      next.sort(comparePages);
      if (!sameArray(pages, next)) {
        pages = next;
        const byId = new Map(next.map((p) => [p.id, p] as const));
        // the set of live pages decides which circles are visible; only a change there (or in a page row) matters below
        if (!sameMap(pageById, byId)) {
          pageById = byId;
          pagesChanged = true;
        }
      }
    }

    let circlesChanged = false;
    if (pagesChanged || ver.circle !== circleVer) {
      circleVer = ver.circle;
      const live = new Map<ID, CircleRow>();
      for (const c of doc.circles.values()) if (c.deletedAt === null && pageById.has(c.pageId)) live.set(c.id, c);
      const liveSetChanged = !sameKeys(circleById, live);
      if (!sameMap(circleById, live)) circleById = live;
      const nextByPage = groupInto(pageById.keys(), circleById.values(), (c) => c.pageId, compareCircles, circlesByPage, EMPTY_CIRCLES);
      circlesByPage = nextByPage;
      // comments only care which circles are live, not where they are
      circlesChanged = liveSetChanged;
    }

    if (circlesChanged || ver.comment !== commentVer) {
      commentVer = ver.comment;
      const liveComments: CommentRow[] = [];
      for (const m of doc.comments.values()) if (m.deletedAt === null && circleById.has(m.circleId)) liveComments.push(m);
      commentsByCircle = groupInto(circleById.keys(), liveComments, (m) => m.circleId, compareComments, commentsByCircle, EMPTY_COMMENTS);
    }

    if (
      !result ||
      result.pages !== pages ||
      result.pageById !== pageById ||
      result.circleById !== circleById ||
      result.circlesByPage !== circlesByPage ||
      result.commentsByCircle !== commentsByCircle
    ) {
      result = { pages, pageById, circleById, circlesByPage, commentsByCircle };
    }
    return result;
  };
}
