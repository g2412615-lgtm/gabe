// Schema migrations: a database written by an older version of the app,
// after this version boots on it.

import fs from "node:fs";
import path from "node:path";
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
  const db = openDatabase(file);
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
  db.exec("PRAGMA user_version = 2");
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
    expect(SCHEMA_VERSION).toBe(3);
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
