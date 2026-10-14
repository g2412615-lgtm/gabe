// The autosave endpoint (POST /api/plans/:id/sync), plan rename/delete/
// restore, the home list, purge and backups.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CIRCLE_R, MAX_TITLE_CHARS, MIN_CIRCLE_R } from "../../src/shared/constants";
import type { CircleRow, PageRow, PlanDoc, PlanSummary, SyncOp, SyncResponse } from "../../src/shared/types";
import { backupNow, BACKUPS_KEPT, purgeNow } from "../../src/server/maintenance";
import { makePdf, signedInClient, startTestServer, type Client, type TestServer } from "./helpers";

let server: TestServer;
let c: Client;
let idSeq = 0;
const newId = () => `t${Date.now().toString(36)}${(idSeq++).toString(36)}-circle`;

beforeAll(async () => {
  // Rendering is irrelevant here; pages stay 'queued'.
  server = await startTestServer({ render: false });
  c = await signedInClient(server);
});

afterAll(async () => {
  await server?.stop();
});

async function newPlan(pages = 2, name = "Sync plan") {
  const r = await c.upload(await makePdf({ pages }), { filename: "sync.pdf", name });
  expect(r.status).toBe(201);
  return { planId: r.json.plan.id, pages: r.json.pages as PageRow[] };
}

const sync = (planId: string, ops: SyncOp[]) => c.post<SyncResponse>(`/api/plans/${planId}/sync`, { ops });
const getDoc = async (planId: string) => (await c.get<PlanDoc>(`/api/plans/${planId}`)).json;
const summary = async (planId: string) => (await c.get<{ plans: PlanSummary[] }>("/api/plans")).json.plans.find((p) => p.id === planId);

function circleCreate(pageId: string, over: Partial<CircleRow> = {}): SyncOp {
  const id = over.id ?? newId();
  return {
    kind: "circle",
    id,
    base: null,
    data: { pageId, x: 0.25, y: 0.5, r: 0.02, color: "gold", title: "", createdAt: Date.now(), deletedAt: null, ...over },
  };
}

const editable = (r: CircleRow) => ({ x: r.x, y: r.y, r: r.r, color: r.color, title: r.title, deletedAt: r.deletedAt });

describe("creating circles", () => {
  it("assigns per-plan numbers 1, 2, 3… and keeps them on replay", async () => {
    const { planId, pages } = await newPlan();
    const a = circleCreate(pages[0].id);
    const b = circleCreate(pages[1].id, { color: "blue", title: "Gate A mag line" });
    const r1 = await sync(planId, [a, b]);
    expect(r1.status).toBe(200);
    expect(r1.json.rejected).toEqual([]);
    expect(r1.json.rows.circles.map((x) => [x.id, x.num])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
    const cb = r1.json.rows.circles[1];
    expect(cb).toMatchObject({ planId, pageId: pages[1].id, color: "blue", title: "Gate A mag line", rev: 1, deletedAt: null });
    expect(typeof r1.json.serverTime).toBe("number");

    // the reply to a create was lost: the device sends it again
    const r2 = await sync(planId, [a, b]);
    expect(r2.json.rows.circles.map((x) => [x.num, x.rev])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    const third = await sync(planId, [circleCreate(pages[0].id)]);
    expect(third.json.rows.circles[0].num).toBe(3);
    // numbers are per plan
    const other = await newPlan(1, "Other plan");
    expect((await sync(other.planId, [circleCreate(other.pages[0].id)])).json.rows.circles[0].num).toBe(1);
  });

  it("uses the device's createdAt only when it is believable", async () => {
    const { planId, pages } = await newPlan(1);
    const now = Date.now();
    const recent = circleCreate(pages[0].id, { createdAt: now - 3 * 86_400_000 });
    const ancient = circleCreate(pages[0].id, { createdAt: now - 90 * 86_400_000 });
    const future = circleCreate(pages[0].id, { createdAt: now + 5 * 86_400_000 });
    const r = await sync(planId, [recent, ancient, future]);
    const byId = new Map(r.json.rows.circles.map((x) => [x.id, x]));
    expect(byId.get(recent.id)!.createdAt).toBe(now - 3 * 86_400_000);
    expect(Math.abs(byId.get(ancient.id)!.createdAt - r.json.serverTime)).toBeLessThan(5);
    expect(Math.abs(byId.get(future.id)!.createdAt - r.json.serverTime)).toBeLessThan(5);
  });

  it("refuses circles with no usable page or non-numeric geometry", async () => {
    const { planId, pages } = await newPlan(1);
    const noPage = circleCreate("no-such-page");
    const nan = circleCreate(pages[0].id, { x: "left" as unknown as number });
    const r = await sync(planId, [noPage, nan]);
    expect(r.json.rows.circles).toEqual([]);
    expect(r.json.rejected).toEqual([
      { kind: "circle", id: noPage.id, reason: "That circle's page no longer exists, so the circle wasn't saved." },
      { kind: "circle", id: nan.id, reason: "That circle's position or size wasn't a number, so it wasn't saved." },
    ]);
  });
});

describe("editing", () => {
  it("merges field by field: a move on one device and a recolour on another both win", async () => {
    const { planId, pages } = await newPlan(1);
    const create = circleCreate(pages[0].id);
    const created = (await sync(planId, [create])).json.rows.circles[0];
    const base = editable(created);

    // desktop moves it; iPad (same base) recolours it
    const move: SyncOp = { kind: "circle", id: created.id, base, data: { ...base, x: 0.7, y: 0.1 } };
    const recolour: SyncOp = { kind: "circle", id: created.id, base, data: { ...base, color: "red" } };
    const r1 = await sync(planId, [move]);
    expect(r1.json.rows.circles[0]).toMatchObject({ x: 0.7, y: 0.1, color: "gold", rev: 2 });
    const r2 = await sync(planId, [recolour]);
    expect(r2.json.rows.circles[0]).toMatchObject({ x: 0.7, y: 0.1, color: "red", rev: 3 });

    // replaying either changes nothing
    const r3 = await sync(planId, [move, recolour]);
    expect(r3.json.rows.circles[0]).toMatchObject({ x: 0.7, y: 0.1, color: "red", rev: 3 });
    expect(r3.json.rows.circles[0].updatedAt).toBe(r2.json.rows.circles[0].updatedAt);
  });

  it("ignores fields that aren't editable (num, pageId, planId, rev)", async () => {
    const { planId, pages } = await newPlan(2);
    const created = (await sync(planId, [circleCreate(pages[0].id)])).json.rows.circles[0];
    const r = await sync(planId, [
      { kind: "circle", id: created.id, base: null, data: { ...editable(created), num: 99, pageId: pages[1].id, planId: "x", rev: 50, createdAt: 1 } },
    ]);
    expect(r.json.rows.circles[0]).toMatchObject({ num: created.num, pageId: pages[0].id, planId, rev: 1, createdAt: created.createdAt });
  });

  it("cleans values instead of refusing them", async () => {
    const { planId, pages } = await newPlan(1);
    const created = (await sync(planId, [circleCreate(pages[0].id, { x: 1.7, y: -3, r: 5, color: "pink" as never, title: "x".repeat(500) })])).json.rows
      .circles[0];
    expect(created).toMatchObject({ x: 1, y: 0, r: MAX_CIRCLE_R, color: "gold" });
    expect(created.title).toHaveLength(MAX_TITLE_CHARS);

    const base = editable(created);
    const r = await sync(planId, [
      { kind: "circle", id: created.id, base, data: { ...base, x: "abc", y: Infinity, r: 0, color: "chartreuse", title: "Gate A ", deletedAt: "yes" } },
    ]);
    const after = r.json.rows.circles[0];
    // bad numbers keep the current value, r is clamped, an unknown colour keeps the current one,
    // titles are not trimmed (they autosave while being typed), a non-number deletedAt is ignored
    expect(after).toMatchObject({ x: 1, y: 0, r: MIN_CIRCLE_R, color: "gold", title: "Gate A ", deletedAt: null });
    expect(r.json.rejected).toEqual([]);

    // page labels and plan names are trimmed and collapsed; a blank one keeps the old value
    const page = pages[0];
    const pr = await sync(planId, [
      { kind: "page", id: page.id, base: null, data: { label: "  A-101 \n Seating   bowl ", sortOrder: "first", deletedAt: null } },
      { kind: "plan", id: planId, base: null, data: { name: "   ", deletedAt: null } },
    ]);
    expect(pr.json.rows.pages[0]).toMatchObject({ label: "A-101 Seating bowl", sortOrder: page.sortOrder });
    expect(pr.json.rows.plans[0].name).toBe("Sync plan");
    const blank = await sync(planId, [{ kind: "page", id: page.id, base: null, data: { label: "" } }]);
    expect(blank.json.rows.pages[0].label).toBe("A-101 Seating bowl");
    // control characters are stripped from text
    const ctl = await sync(planId, [{ kind: "page", id: page.id, base: null, data: { label: "B\u0000-2\u0007" } }]);
    expect(ctl.json.rows.pages[0].label).toBe("B-2");
  });

  it("renames and reorders pages and renames the plan through sync", async () => {
    const { planId, pages } = await newPlan(2, "Before");
    const r = await sync(planId, [
      { kind: "plan", id: planId, base: { name: "Before", deletedAt: null }, data: { name: "After", deletedAt: null } },
      { kind: "page", id: pages[1].id, base: null, data: { label: "Concourse", sortOrder: 0.5, deletedAt: null } },
    ]);
    expect(r.json.rows.plans[0]).toMatchObject({ name: "After", rev: 2 });
    expect(r.json.rows.pages[0]).toMatchObject({ label: "Concourse", sortOrder: 0.5, rev: 2 });
    const doc = await getDoc(planId);
    expect(doc.pages.map((p) => p.id)).toEqual([pages[1].id, pages[0].id]);
  });

  it("refuses ops for pages and plans that don't exist (those come from uploads only)", async () => {
    const { planId } = await newPlan(1);
    const r = await sync(planId, [
      { kind: "page", id: "ghost-page", base: null, data: { label: "Ghost" } },
      { kind: "plan", id: planId + "x", base: null, data: { name: "Ghost" } },
    ]);
    expect(r.json.rejected).toEqual([
      { kind: "plan", id: planId + "x", reason: "That change belongs to a different event plan, so it wasn't saved." },
      { kind: "page", id: "ghost-page", reason: "That page no longer exists, so the change wasn't saved." },
    ]);
    expect(r.json.rows).toEqual({ plans: [], pages: [], circles: [], comments: [] });
  });

  it("reports malformed ops without failing the batch", async () => {
    const { planId, pages } = await newPlan(1);
    const good = circleCreate(pages[0].id);
    const r = await sync(planId, [
      { kind: "circle", id: "bad id with spaces", base: null, data: {} },
      { kind: "circle", id: "ok-id-1", base: null, data: "nope" as never },
      { kind: "spaceship" as never, id: "x", base: null, data: {} },
      good,
    ]);
    expect(r.status).toBe(200);
    expect(r.json.rows.circles.map((x) => x.id)).toEqual([good.id]);
    expect(r.json.rejected.map((x) => x.id)).toEqual(["bad id with spaces", "ok-id-1"]);
  });
});

// Before the Kilowatt Events rebrand the palette had "amber" and "purple"
// (now "gold" and "black"). A tab left open on the old app, or a device's
// unsaved outbox, still sends those names; they save as the colour meant.
describe("pre-rebrand colour names", () => {
  it("a create in amber or purple is saved as gold or black", async () => {
    const { planId, pages } = await newPlan(1);
    const amber = circleCreate(pages[0].id, { color: "amber" as never });
    const purple = circleCreate(pages[0].id, { color: "purple" as never });
    const r = await sync(planId, [amber, purple]);
    expect(r.json.rejected).toEqual([]);
    const byId = new Map(r.json.rows.circles.map((x) => [x.id, x]));
    expect(byId.get(amber.id)).toMatchObject({ color: "gold", rev: 1 });
    expect(byId.get(purple.id)).toMatchObject({ color: "black", rev: 1 });
  });

  it("a recolour to an old name lands as the new colour; an old name for the stored colour is no change", async () => {
    const { planId, pages } = await newPlan(1);
    const created = (await sync(planId, [circleCreate(pages[0].id, { color: "red" })])).json.rows.circles[0];
    const base = editable(created);

    const toPurple = await sync(planId, [{ kind: "circle", id: created.id, base, data: { ...base, color: "purple" } }]);
    expect(toPurple.json.rows.circles[0]).toMatchObject({ color: "black", rev: 2 });

    // the old app thinks the circle is purple and only moves it: the colour stands
    const oldBase = { ...editable(toPurple.json.rows.circles[0]), color: "purple" };
    const move = await sync(planId, [{ kind: "circle", id: created.id, base: oldBase, data: { ...oldBase, x: 0.9 } }]);
    expect(move.json.rows.circles[0]).toMatchObject({ x: 0.9, color: "black", rev: 3 });

    // sending "purple" for a black circle (no base: every field counts) changes nothing — no rev bump
    const same = await sync(planId, [{ kind: "circle", id: created.id, base: null, data: { ...oldBase, x: 0.9 } }]);
    expect(same.json.rows.circles[0]).toMatchObject({ x: 0.9, color: "black", rev: 3 });
    expect(same.json.rows.circles[0].updatedAt).toBe(move.json.rows.circles[0].updatedAt);

    const toAmber = await sync(planId, [{ kind: "circle", id: created.id, base: oldBase, data: { ...oldBase, x: 0.9, color: "amber" } }]);
    expect(toAmber.json.rows.circles[0]).toMatchObject({ x: 0.9, color: "gold", rev: 4 });
    expect((await getDoc(planId)).circles.find((x) => x.id === created.id)).toMatchObject({ color: "gold", rev: 4 });
  });

  it("an unknown name still keeps the current colour (or the default for a new circle)", async () => {
    const { planId, pages } = await newPlan(1);
    const fresh = (await sync(planId, [circleCreate(pages[0].id, { color: "orange" as never })])).json.rows.circles[0];
    expect(fresh.color).toBe("gold");
    const created = (await sync(planId, [circleCreate(pages[0].id, { color: "blue" })])).json.rows.circles[0];
    const base = editable(created);
    for (const color of ["Amber", "constructor", "__proto__", 7, null]) {
      const r = await sync(planId, [{ kind: "circle", id: created.id, base, data: { ...base, color } }]);
      expect(r.json.rows.circles[0], String(color)).toMatchObject({ color: "blue", rev: 1 });
    }
  });
});

describe("comments", () => {
  it("can follow their new circle in the same batch, and edit/delete/undelete like any row", async () => {
    const { planId, pages } = await newPlan(1);
    const circle = circleCreate(pages[0].id);
    const comment: SyncOp = {
      kind: "comment",
      id: newId().replace("circle", "comment"),
      base: null,
      data: { circleId: circle.id, body: "Two staff here at doors open.\n", createdAt: Date.now(), deletedAt: null },
    };
    // comment listed first: the server still processes circles before comments
    const r = await sync(planId, [comment, circle]);
    expect(r.json.rejected).toEqual([]);
    expect(r.json.rows.comments[0]).toMatchObject({ id: comment.id, circleId: circle.id, body: "Two staff here at doors open.\n", rev: 1 });

    const base = { body: r.json.rows.comments[0].body, deletedAt: null };
    const edit = await sync(planId, [{ kind: "comment", id: comment.id, base, data: { body: "Three staff.", deletedAt: null } }]);
    expect(edit.json.rows.comments[0]).toMatchObject({ body: "Three staff.", rev: 2 });

    const del = await sync(planId, [{ kind: "comment", id: comment.id, base: { body: "Three staff.", deletedAt: null }, data: { body: "Three staff.", deletedAt: 123 } }]);
    const deletedAt = del.json.rows.comments[0].deletedAt!;
    expect(Math.abs(deletedAt - del.json.serverTime)).toBeLessThan(5); // the server's clock, not the device's
    expect((await summary(planId))!.commentCount).toBe(0);

    const undel = await sync(planId, [{ kind: "comment", id: comment.id, base: { deletedAt }, data: { deletedAt: null } }]);
    expect(undel.json.rows.comments[0].deletedAt).toBeNull();
    expect((await summary(planId))!.commentCount).toBe(1);
  });

  it("needs a circle of this plan", async () => {
    const { planId } = await newPlan(1);
    const r = await sync(planId, [{ kind: "comment", id: "lonely-comment", base: null, data: { circleId: "missing-circle", body: "hi" } }]);
    expect(r.json.rejected[0]).toEqual({ kind: "comment", id: "lonely-comment", reason: "That comment's circle no longer exists, so the comment wasn't saved." });
  });
});

describe("deleting and restoring", () => {
  it("timestamps deletes with the server clock and replays them as no-ops", async () => {
    const { planId, pages } = await newPlan(1);
    const created = (await sync(planId, [circleCreate(pages[0].id)])).json.rows.circles[0];
    const base = editable(created);
    const delOp: SyncOp = { kind: "circle", id: created.id, base, data: { ...base, deletedAt: 1 } };
    const d1 = (await sync(planId, [delOp])).json.rows.circles[0];
    expect(d1.deletedAt).not.toBeNull();
    expect(d1.rev).toBe(2);
    const d2 = (await sync(planId, [delOp])).json.rows.circles[0];
    expect(d2).toEqual(d1);
    // GET returns tombstones too
    expect((await getDoc(planId)).circles.find((x) => x.id === created.id)!.deletedAt).toBe(d1.deletedAt);

    const restore: SyncOp = { kind: "circle", id: created.id, base: editable(d1), data: { ...editable(d1), deletedAt: null } };
    const d3 = (await sync(planId, [restore])).json.rows.circles[0];
    expect(d3).toMatchObject({ deletedAt: null, rev: 3, num: created.num });
  });

  it("hides circles and comments of a deleted page from the counts, and brings them back on undo", async () => {
    const { planId, pages } = await newPlan(2);
    const c1 = circleCreate(pages[0].id);
    const c2 = circleCreate(pages[0].id);
    const c3 = circleCreate(pages[1].id);
    const comments: SyncOp[] = [c1, c1, c3].map((cc, i) => ({
      kind: "comment",
      id: `cmt-${i}-${cc.id}`,
      base: null,
      data: { circleId: cc.id, body: `note ${i}`, createdAt: Date.now(), deletedAt: null },
    }));
    await sync(planId, [c1, c2, c3, ...comments]);
    expect(await summary(planId)).toMatchObject({ pageCount: 2, circleCount: 3, commentCount: 3, pendingPages: 2 });

    // delete page 1: its two circles and their two comments disappear from the counts; the rows are untouched
    const page = pages[0];
    await sync(planId, [{ kind: "page", id: page.id, base: { deletedAt: null }, data: { deletedAt: 1 } }]);
    expect(await summary(planId)).toMatchObject({ pageCount: 1, circleCount: 1, commentCount: 1, pendingPages: 1 });
    const doc = await getDoc(planId);
    expect(doc.circles.filter((x) => x.pageId === page.id).every((x) => x.deletedAt === null)).toBe(true);
    expect(doc.pages.find((p) => p.id === page.id)!.deletedAt).not.toBeNull();

    // deleting just a circle hides its comments too
    const c3row = doc.circles.find((x) => x.id === c3.id)!;
    await sync(planId, [{ kind: "circle", id: c3.id, base: editable(c3row), data: { ...editable(c3row), deletedAt: 1 } }]);
    expect(await summary(planId)).toMatchObject({ circleCount: 0, commentCount: 0 });

    // undo the page delete
    const deleted = doc.pages.find((p) => p.id === page.id)!;
    await sync(planId, [{ kind: "page", id: page.id, base: { deletedAt: deleted.deletedAt }, data: { deletedAt: null } }]);
    expect(await summary(planId)).toMatchObject({ pageCount: 2, circleCount: 2, commentCount: 2 });
    // circles can still be added to a deleted page (it may come back with undo)
    await sync(planId, [{ kind: "page", id: page.id, base: null, data: { deletedAt: 1 } }]);
    expect((await sync(planId, [circleCreate(page.id)])).json.rejected).toEqual([]);
  });
});

describe("plan isolation", () => {
  it("never lets an op touch or reveal another plan's rows", async () => {
    const a = await newPlan(1, "Plan A");
    const b = await newPlan(1, "Plan B");
    const circleA = (await sync(a.planId, [circleCreate(a.pages[0].id, { title: "secret A" })])).json.rows.circles[0];
    const commentA: SyncOp = { kind: "comment", id: "comment-in-a", base: null, data: { circleId: circleA.id, body: "A only" } };
    await sync(a.planId, [commentA]);

    const r = await sync(b.planId, [
      { kind: "circle", id: circleA.id, base: null, data: { ...editable(circleA), title: "hijacked" } }, // A's circle via B
      circleCreate(a.pages[0].id), // a new circle in B on A's page
      { kind: "comment", id: "comment-from-b", base: null, data: { circleId: circleA.id, body: "x" } }, // on A's circle
      { kind: "page", id: a.pages[0].id, base: null, data: { label: "renamed from B" } },
      { kind: "plan", id: a.planId, base: null, data: { name: "renamed from B" } },
      { kind: "comment", id: commentA.id, base: null, data: { body: "edited from B" } },
    ]);
    expect(r.json.rows).toEqual({ plans: [], pages: [], circles: [], comments: [] });
    expect(r.json.rejected).toHaveLength(6);
    for (const x of r.json.rejected) expect(x.reason).toBe("That change belongs to a different event plan, so it wasn't saved.");

    const docA = await getDoc(a.planId);
    expect(docA.plan.name).toBe("Plan A");
    expect(docA.pages[0].label).toBe("Page 1");
    expect(docA.circles[0].title).toBe("secret A");
    expect(docA.comments.map((x) => x.body)).toEqual(["A only"]);
    expect((await getDoc(b.planId)).circles).toEqual([]);
  });
});

describe("plan updatedAt and the home list", () => {
  it("bumps updatedAt on a real change only, and lists newest edits first", async () => {
    const older = await newPlan(1, "Older");
    await new Promise((r) => setTimeout(r, 5));
    const newer = await newPlan(1, "Newer");
    let list = (await c.get<{ plans: PlanSummary[] }>("/api/plans")).json.plans.map((p) => p.id);
    expect(list.indexOf(newer.planId)).toBeLessThan(list.indexOf(older.planId));

    const before = (await getDoc(older.planId)).plan.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    // a no-op batch (label unchanged) does not count as an edit
    await sync(older.planId, [{ kind: "page", id: older.pages[0].id, base: null, data: { label: "Page 1" } }]);
    expect((await getDoc(older.planId)).plan.updatedAt).toBe(before);
    // a real edit does
    await sync(older.planId, [circleCreate(older.pages[0].id)]);
    expect((await getDoc(older.planId)).plan.updatedAt).toBeGreaterThan(before);
    list = (await c.get<{ plans: PlanSummary[] }>("/api/plans")).json.plans.map((p) => p.id);
    expect(list[0]).toBe(older.planId);
  });
});

describe("PATCH /api/plans/:id", () => {
  it("renames, deletes and restores", async () => {
    const { planId } = await newPlan(1, "Season opener");
    const renamed = await c.patch(`/api/plans/${planId}`, { name: "  Season   opener (final) " });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ id: planId, name: "Season opener (final)", deletedAt: null, rev: 2 });

    const del = await c.patch(`/api/plans/${planId}`, { deleted: true });
    expect(del.json.deletedAt).not.toBeNull();
    expect((await c.get(`/api/plans/${planId}`)).status).toBe(404);
    expect((await c.get(`/api/plans/${planId}/pages`)).status).toBe(404);
    expect((await c.get<{ plans: PlanSummary[] }>("/api/plans")).json.plans.some((p) => p.id === planId)).toBe(false);
    // deleting again is a no-op
    expect((await c.patch(`/api/plans/${planId}`, { deleted: true })).json.rev).toBe(del.json.rev);

    const restored = await c.patch(`/api/plans/${planId}`, { deleted: false });
    expect(restored.json.deletedAt).toBeNull();
    expect((await c.get(`/api/plans/${planId}`)).status).toBe(200);
  });

  it("validates the body", async () => {
    const { planId } = await newPlan(1);
    expect((await c.patch(`/api/plans/${planId}`, { name: "   " })).json.error).toBe("Give the event plan a name.");
    expect((await c.patch(`/api/plans/${planId}`, { name: 42 })).status).toBe(400);
    expect((await c.patch(`/api/plans/${planId}`, { deleted: "yes" })).status).toBe(400);
    expect((await c.patch(`/api/plans/${planId}`, [1, 2])).status).toBe(400);
    expect((await c.patch(`/api/plans/does-not-exist`, { name: "x" })).status).toBe(404);
  });
});

describe("sync request validation", () => {
  it("answers 404 for unknown plans and 400/413 for bad bodies", async () => {
    const { planId } = await newPlan(1);
    expect((await sync("no-such-plan", [])).status).toBe(404);
    expect((await c.post(`/api/plans/${planId}/sync`, { nope: true })).status).toBe(400);
    expect((await c.req("POST", `/api/plans/${planId}/sync`, { body: "{not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    const many = Array.from({ length: 2001 }, (_, i) => ({ kind: "circle", id: `c${i}`, base: null, data: {} }));
    expect((await c.post(`/api/plans/${planId}/sync`, { ops: many })).status).toBe(413);
    const big = await c.post(`/api/plans/${planId}/sync`, { ops: [], pad: "x".repeat(2 * 1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect((await sync(planId, [])).json).toMatchObject({ rows: { plans: [], pages: [], circles: [], comments: [] }, rejected: [] });
  });

  it("still accepts saves for a deleted plan (Undo brings them back)", async () => {
    const { planId, pages } = await newPlan(1);
    await c.patch(`/api/plans/${planId}`, { deleted: true });
    const r = await sync(planId, [circleCreate(pages[0].id)]);
    expect(r.status).toBe(200);
    expect(r.json.rows.circles).toHaveLength(1);
  });
});

describe("purge", () => {
  it("hard-deletes old tombstones with their children and files, keeps recent ones, never reuses numbers", async () => {
    const s = await startTestServer({ render: true });
    try {
      const sc = await signedInClient(s);
      const keepPlan = (await sc.upload(await makePdf({ pages: 2 }), { filename: "keep.pdf" })).json;
      const dropPlan = (await sc.upload(await makePdf({ pages: 1 }), { filename: "drop.pdf" })).json;
      await s.queue.whenIdle();
      const [pKeep, pDrop] = keepPlan.pages;
      const call = (planId: string, ops: SyncOp[]) => sc.post<SyncResponse>(`/api/plans/${planId}/sync`, { ops });

      const c1 = circleCreate(pKeep.id); // stays
      const c2 = circleCreate(pKeep.id); // deleted long ago → purged
      const c3 = circleCreate(pDrop.id); // on a page deleted long ago → purged with it
      const c4 = circleCreate(pKeep.id); // deleted just now → kept
      await call(keepPlan.plan.id, [c1, c2, c3, c4]);
      const cm: SyncOp = { kind: "comment", id: "purge-comment", base: null, data: { circleId: c3.id, body: "gone" } };
      const cmKeep: SyncOp = { kind: "comment", id: "keep-comment-old-deleted", base: null, data: { circleId: c1.id, body: "deleted comment" } };
      await call(keepPlan.plan.id, [cm, cmKeep]);
      await call(keepPlan.plan.id, [
        { kind: "circle", id: c2.id, base: null, data: { deletedAt: 1 } },
        { kind: "circle", id: c4.id, base: null, data: { deletedAt: 1 } },
        { kind: "page", id: pDrop.id, base: null, data: { deletedAt: 1 } },
        { kind: "comment", id: cmKeep.id, base: null, data: { deletedAt: 1 } },
      ]);
      await sc.patch(`/api/plans/${dropPlan.plan.id}`, { deleted: true });

      // age the old tombstones by 31 days (c4 stays recent)
      const old = Date.now() - 31 * 86_400_000;
      s.db.prepare("UPDATE circles SET deleted_at = ? WHERE id = ?").run(old, c2.id);
      s.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").run(old, pDrop.id);
      s.db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").run(old, cmKeep.id);
      s.db.prepare("UPDATE plans SET deleted_at = ? WHERE id = ?").run(old, dropPlan.plan.id);

      const dropPageDir = path.join(s.dataDir, "assets", pDrop.id);
      const dropPlanPageDir = path.join(s.dataDir, "assets", dropPlan.pages[0].id);
      const dropSource = path.join(s.dataDir, "uploads", `${dropPlan.source.id}.pdf`);
      const keepSource = path.join(s.dataDir, "uploads", `${keepPlan.source.id}.pdf`);
      for (const f of [dropPageDir, dropPlanPageDir, dropSource, keepSource]) expect(fs.existsSync(f), f).toBe(true);

      const result = purgeNow(s.db, s.dataDir);
      expect(result).toEqual({ plans: 1, pages: 1, circles: 1, comments: 1, sources: 1 });

      expect(fs.existsSync(dropPageDir)).toBe(false);
      expect(fs.existsSync(dropPlanPageDir)).toBe(false);
      expect(fs.existsSync(dropSource)).toBe(false);
      expect(fs.existsSync(keepSource)).toBe(true); // still used by the kept page
      expect(fs.existsSync(path.join(s.dataDir, "assets", pKeep.id))).toBe(true);

      const doc = (await sc.get<PlanDoc>(`/api/plans/${keepPlan.plan.id}`)).json;
      expect(doc.pages.map((p) => p.id)).toEqual([pKeep.id]);
      expect(doc.circles.map((x) => x.id).sort()).toEqual([c1.id, c4.id].sort()); // c3 went with its page
      expect(doc.comments).toEqual([]); // "gone" went with c3; the old deleted one was purged
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM plans WHERE id = ?").get(dropPlan.plan.id)).toEqual({ n: 0 });

      // the highest number (c4 = 4) is still there; purge c4 too and numbers still don't go back
      s.db.prepare("UPDATE circles SET deleted_at = ? WHERE id = ?").run(old, c4.id);
      purgeNow(s.db, s.dataDir);
      const next = (await call(keepPlan.plan.id, [circleCreate(pKeep.id)])).json.rows.circles[0];
      expect(next.num).toBe(5);
      // running it again finds nothing
      expect(purgeNow(s.db, s.dataDir)).toEqual({ plans: 0, pages: 0, circles: 0, comments: 0, sources: 0 });
    } finally {
      await s.stop();
    }
  });
});

describe("backups", () => {
  it("writes a readable snapshot and keeps the newest 14", async () => {
    const dir = path.join(server.dataDir, "backups");
    const start = Date.UTC(2026, 0, 1);
    let last = "";
    for (let i = 0; i < BACKUPS_KEPT + 3; i++) last = backupNow(server.db, server.dataDir, start + i * 86_400_000);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(BACKUPS_KEPT);
    expect(files[0]).toBe("app-20260104T000000Z.db");
    expect(path.basename(last)).toBe("app-20260117T000000Z.db");
    const { DatabaseSync } = await import("node:sqlite");
    const copy = new DatabaseSync(last, { readOnly: true });
    const plans = copy.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
    copy.close();
    expect(plans.n).toBeGreaterThan(0);
  });
});
