// Schema migrations: a database written by an older version of the app,
// after this version boots on it.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { CIRCLE_COLOR_ORDER } from "../../src/shared/constants";
import type { PlanDoc } from "../../src/shared/types";
import { openDatabase, SCHEMA_VERSION, userVersion } from "../../src/server/db";
import { signedInClient, startTestServer, tempDir } from "./helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function newDir() {
  const d = tempDir("bpn-migrate-");
  dirs.push(d);
  return d;
}

const T = 1_700_000_000_000;
const DELETED_AT = T + 5_000;

/** Circles as version 2 of the app stored them (its palette was amber, red, blue, green, purple). */
const OLD_CIRCLES: { id: string; color: string; deleted?: boolean }[] = [
  { id: "c-amber", color: "amber" },
  { id: "c-purple", color: "purple" },
  { id: "c-red", color: "red" },
  { id: "c-blue", color: "blue" },
  { id: "c-green", color: "green" },
  { id: "c-amber-deleted", color: "amber", deleted: true }, // undo-delete must bring it back in a colour that exists
];

/** Write a database the way version 2 of the app left it (schema 2): one plan, one page, a circle in each old colour. */
function writeSchema2Db(file: string) {
  const db = openDatabase(file, { schema: 2 });
  db.prepare("INSERT INTO plans (id, name, circle_seq, created_at, updated_at, deleted_at, rev) VALUES ('plan1', 'Old plan', ?, ?, ?, NULL, 7)").run(
    OLD_CIRCLES.length,
    T,
    T,
  );
  db.prepare(
    "INSERT INTO sources (id, plan_id, original_name, kind, ext, bytes, page_count, created_at) VALUES ('src1', 'plan1', 'old.pdf', 'pdf', 'pdf', 100, 1, ?)",
  ).run(T);
  db.prepare(
    `INSERT INTO pages (id, plan_id, source_id, source_index, label, sort_order, status, error, asset_key, created_at, updated_at, deleted_at, rev)
     VALUES ('page1', 'plan1', 'src1', 0, 'Page 1', 1, 'failed', 'gone', 'k1', ?, ?, NULL, 1)`,
  ).run(T, T);
  const insert = db.prepare(
    `INSERT INTO circles (id, plan_id, page_id, x, y, r, color, title, num, created_at, updated_at, deleted_at, rev)
     VALUES (?, 'plan1', 'page1', 0.5, 0.5, 0.02, ?, 'Gate A', ?, ?, ?, ?, 2)`,
  );
  OLD_CIRCLES.forEach((c, i) => insert.run(c.id, c.color, i + 1, T, T + i, c.deleted ? DELETED_AT : null));
  db.close();
}

type Stored = { id: string; color: string; rev: number; updated_at: number; deleted_at: number | null; title: string; num: number };
const readCircles = (file: string) => {
  const db = openDatabase(file);
  try {
    const rows = db.prepare("SELECT id, color, rev, updated_at, deleted_at, title, num FROM circles ORDER BY num").all() as unknown as Stored[];
    const plan = db.prepare("SELECT updated_at, rev FROM plans WHERE id = 'plan1'").get() as { updated_at: number; rev: number };
    return { version: userVersion(db), byId: new Map(rows.map((r) => [r.id, r])), plan };
  } finally {
    db.close();
  }
};

describe("migration 3: circle colours move to the Kilowatt Events palette", () => {
  it("renames amber → gold and purple → black, tombstones included; red, blue and green are untouched", () => {
    const file = path.join(newDir(), "app.db");
    writeSchema2Db(file);

    const { version, byId, plan } = readCircles(file);
    expect(version).toBe(SCHEMA_VERSION);
    expect(Object.fromEntries([...byId].map(([id, r]) => [id, r.color]))).toEqual({
      "c-amber": "gold",
      "c-purple": "black",
      "c-red": "red",
      "c-blue": "blue",
      "c-green": "green",
      "c-amber-deleted": "gold",
    });
    for (const r of byId.values()) expect(CIRCLE_COLOR_ORDER).toContain(r.color);

    // a renamed circle is a changed row (new rev); nobody edited it, so updated_at stays
    for (const [i, c] of OLD_CIRCLES.entries()) {
      const r = byId.get(c.id)!;
      const renamed = c.color === "amber" || c.color === "purple";
      expect(r.rev, c.id).toBe(renamed ? 3 : 2);
      expect(r.updated_at, c.id).toBe(T + i);
      expect(r.deleted_at, c.id).toBe(c.deleted ? DELETED_AT : null);
      expect(r).toMatchObject({ title: "Gate A", num: i + 1 });
    }
    // the plan isn't touched: the home list keeps its order
    expect(plan).toEqual({ updated_at: T, rev: 7 });
  });

  it("runs once: booting again changes nothing", () => {
    const file = path.join(newDir(), "app.db");
    writeSchema2Db(file);
    const first = readCircles(file);
    const second = readCircles(file);
    expect(second.version).toBe(SCHEMA_VERSION);
    expect([...second.byId.values()]).toEqual([...first.byId.values()]);
  });

  it("a server started on an old database serves the new colour names", async () => {
    const dataDir = newDir();
    writeSchema2Db(path.join(dataDir, "app.db"));
    const server = await startTestServer({ dataDir, render: false });
    try {
      const c = await signedInClient(server);
      const r = await c.get<PlanDoc>("/api/plans/plan1");
      expect(r.status).toBe(200);
      expect(Object.fromEntries(r.json.circles.map((x) => [x.id, x.color]))).toEqual({
        "c-amber": "gold",
        "c-purple": "black",
        "c-red": "red",
        "c-blue": "blue",
        "c-green": "green",
        "c-amber-deleted": "gold",
      });
    } finally {
      await server.stop(); // removes dataDir
    }
  });
});

// ── migration 4: colour labels ──────────────────────────────────────────

/** A database as the app before colour labels left it (schema 3): two plans, pages, circles in every colour, comments, tombstones. */
function writeSchema3Db(file: string) {
  const db = openDatabase(file, { schema: 3 });
  const plan = db.prepare("INSERT INTO plans (id, name, circle_seq, created_at, updated_at, deleted_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?)");
  plan.run("plan1", "Millrace — home opener", 6, T, T + 50, null, 12);
  plan.run("plan2", "Old deleted plan", 0, T, T, T + 1, 3);
  db.prepare(
    "INSERT INTO sources (id, plan_id, original_name, kind, ext, bytes, page_count, created_at) VALUES ('src1', 'plan1', 'event.pdf', 'pdf', 'pdf', 100, 2, ?)",
  ).run(T);
  const page = db.prepare(
    `INSERT INTO pages (id, plan_id, source_id, source_index, label, sort_order, status, error, width, height, asset_key, created_at, updated_at, deleted_at, rev)
     VALUES (?, 'plan1', 'src1', ?, ?, ?, 'ready', NULL, 7200, 4800, ?, ?, ?, ?, ?)`,
  );
  page.run("page1", 0, "A-101 Seating bowl", 1, "k1", T, T + 2, null, 4);
  page.run("page2", 1, "P-1", 2, "k2", T, T + 3, T + 9, 2);
  const circle = db.prepare(
    `INSERT INTO circles (id, plan_id, page_id, x, y, r, color, title, num, created_at, updated_at, deleted_at, rev)
     VALUES (?, 'plan1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  CIRCLE_COLOR_ORDER.forEach((color, i) => circle.run(`c-${color}`, "page1", 0.1 * (i + 1), 0.2, 0.02 + i / 100, color, `Spot ${i}`, i + 1, T, T + i, null, 3 + i));
  circle.run("c-gone", "page2", 0.5, 0.5, 0.05, "red", "On a deleted page", 6, T, T, T + 7, 2);
  const comment = db.prepare("INSERT INTO comments (id, plan_id, circle_id, body, created_at, updated_at, deleted_at, rev) VALUES (?, 'plan1', ?, ?, ?, ?, ?, ?)");
  comment.run("m1", "c-gold", "Mag line at Gate B — 4 staff", T, T, null, 1);
  comment.run("m2", "c-green", "Barricade check\nbefore doors", T + 1, T + 60_001, null, 3);
  comment.run("m3", "c-red", "Deleted note", T + 2, T + 2, T + 4, 2);
  db.close();
}

function dump(file: string) {
  const db = openDatabase(file, { schema: userVersionOf(file) });
  try {
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
    return { version: userVersion(db), plans: all("plans"), sources: all("sources"), pages: all("pages"), circles: all("circles"), comments: all("comments") };
  } finally {
    db.close();
  }
}
function userVersionOf(file: string): number {
  const db = new DatabaseSync(file);
  try {
    return userVersion(db);
  } finally {
    db.close();
  }
}
const LEGEND_COLUMNS = ["legend_gold", "legend_black", "legend_red", "legend_blue", "legend_green"];
const withoutLegend = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !LEGEND_COLUMNS.includes(k)));

describe("migration 4: colour labels", () => {
  it("adds the labels and changes nothing else — every page, circle and comment, tombstones included, stays exactly as it was", () => {
    const dir = newDir();
    const file = path.join(dir, "app.db");
    writeSchema3Db(file);
    const before = dump(file);
    expect(before.version).toBe(3);

    const db = openDatabase(file); // what the new app does at boot
    db.close();
    const after = dump(file);
    expect(after.version).toBe(SCHEMA_VERSION);

    expect(after.sources).toEqual(before.sources);
    expect(after.pages).toEqual(before.pages);
    expect(after.circles).toEqual(before.circles);
    expect(after.comments).toEqual(before.comments);
    // plans: the same in every column they had (rev and updated_at too: nobody edited them), plus the labels
    expect(after.plans.map(withoutLegend)).toEqual(before.plans);
    for (const p of after.plans) {
      expect(p).toMatchObject({ legend_gold: "", legend_black: "", legend_red: "", legend_blue: "", legend_green: "General notes" });
    }
  });

  it("keeps a full copy of the database as it was before, and makes none when there's nothing to migrate", () => {
    const dir = newDir();
    const file = path.join(dir, "app.db");
    writeSchema3Db(file);
    const before = dump(file);
    openDatabase(file).close();

    const backups = fs.readdirSync(path.join(dir, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^app-before-schema-4-from-3-\d{8}T\d{6}Z\.db$/);
    expect(dump(path.join(dir, "backups", backups[0]))).toEqual(before);

    // booting again: already migrated, no new copy, nothing changes
    const once = dump(file);
    openDatabase(file).close();
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(1);
    expect(dump(file)).toEqual(once);
  });

  it("a server on the migrated database serves the labels, saves new ones, and an older device's rename leaves them alone", async () => {
    const dataDir = newDir();
    writeSchema3Db(path.join(dataDir, "app.db"));
    const server = await startTestServer({ dataDir, render: false });
    try {
      const c = await signedInClient(server);
      const doc = (await c.get<PlanDoc>("/api/plans/plan1")).json;
      expect(doc.plan).toMatchObject({ name: "Millrace — home opener", legendGreen: "General notes", legendRed: "", legendGold: "" });
      expect(doc.circles.filter((x) => x.deletedAt === null)).toHaveLength(5);
      expect(doc.comments.filter((x) => x.deletedAt === null).map((x) => x.body)).toEqual(["Mag line at Gate B — 4 staff", "Barricade check\nbefore doors"]);

      const base = { name: doc.plan.name, legendGold: "", legendBlack: "", legendRed: "", legendBlue: "", legendGreen: "General notes", deletedAt: null };
      const set = await c.post("/api/plans/plan1/sync", {
        ops: [{ kind: "plan", id: "plan1", base, data: { ...base, legendRed: "Security\tposts\n", legendGreen: "" } }],
      });
      expect(set.status).toBe(200);
      expect(set.json.rows.plans[0]).toMatchObject({ legendRed: "Security posts ", legendGreen: "" }); // one line; "" = unassigned

      // a device still on the previous version knows only name and deletedAt
      const old = await c.post("/api/plans/plan1/sync", {
        ops: [{ kind: "plan", id: "plan1", base: { name: doc.plan.name, deletedAt: null }, data: { name: "Millrace — opener", deletedAt: null } }],
      });
      expect(old.json.rows.plans[0]).toMatchObject({ name: "Millrace — opener", legendRed: "Security posts ", legendGreen: "" });
    } finally {
      await server.stop();
    }
  });
});
