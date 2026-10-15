// SQLite through Node's built-in driver (node:sqlite, synchronous). One
// connection for the whole process: every request handler runs its queries
// and transactions to completion without awaiting in between, so nothing
// interleaves. Render workers (separate processes) never touch the database
// — they post results back and the server writes them.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Schema migrations, applied in order at boot. `PRAGMA user_version` holds
 * how many have run. Never edit a shipped entry — append a new one.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE plans (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- the last circle number handed out in this plan; numbers are never reused,
    -- even after the highest-numbered circle is purged
    circle_seq  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    rev         INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE sources (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('pdf', 'image')),
    ext           TEXT NOT NULL CHECK (ext IN ('pdf', 'png', 'jpg')),
    bytes         INTEGER NOT NULL,
    page_count    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX sources_plan ON sources(plan_id);

  CREATE TABLE pages (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_index  INTEGER NOT NULL,
    label         TEXT NOT NULL,
    sort_order    REAL NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'rendering', 'preview', 'ready', 'failed')),
    error         TEXT,
    width         INTEGER NOT NULL DEFAULT 0,
    height        INTEGER NOT NULL DEFAULT 0,
    preview_w     INTEGER NOT NULL DEFAULT 0,
    preview_h     INTEGER NOT NULL DEFAULT 0,
    tile_size     INTEGER NOT NULL DEFAULT 0,
    max_level     INTEGER NOT NULL DEFAULT 0,
    min_level     INTEGER NOT NULL DEFAULT 0,
    tile_format   TEXT NOT NULL DEFAULT '',
    asset_key     TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER,
    rev           INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX pages_plan_sort ON pages(plan_id, sort_order);
  CREATE INDEX pages_source ON pages(source_id);
  CREATE INDEX pages_status ON pages(status);

  CREATE TABLE circles (
    id          TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    r           REAL NOT NULL,
    color       TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    num         INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    rev         INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX circles_plan ON circles(plan_id);
  CREATE INDEX circles_page ON circles(page_id);

  CREATE TABLE comments (
    id          TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    circle_id   TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    rev         INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX comments_plan ON comments(plan_id);
  CREATE INDEX comments_circle ON comments(circle_id);
  `,
  // 2 — renders started for a page since it last rendered (or was retried).
  // A page whose renderer keeps getting killed — out of memory, or the whole
  // server going down with it — is given up on instead of retried forever.
  `
  ALTER TABLE pages ADD COLUMN render_attempts INTEGER NOT NULL DEFAULT 0;
  `,
  // 3 — circle colours moved to the Kilowatt Events palette: amber → gold,
  // purple → black (red, blue and green keep their names). A renamed circle
  // gets a new rev, as any change does, so every older copy of it counts as
  // older; updated_at is left alone (nobody edited it). Changes still
  // carrying the old names are mapped on the way in (LEGACY_CIRCLE_COLORS).
  `
  UPDATE circles SET color = 'gold', rev = rev + 1 WHERE color = 'amber';
  UPDATE circles SET color = 'black', rev = rev + 1 WHERE color = 'purple';
  `,
  // 4 — colour labels ("what each colour means"), per event plan. Only new
  // columns: no page, circle or comment is touched, and existing plans keep
  // their rev (nobody edited them) — they simply get the defaults: green is
  // "General notes", the other colours are empty, to be assigned.
  `
  ALTER TABLE plans ADD COLUMN legend_gold  TEXT NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN legend_black TEXT NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN legend_red   TEXT NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN legend_blue  TEXT NOT NULL DEFAULT '';
  ALTER TABLE plans ADD COLUMN legend_green TEXT NOT NULL DEFAULT 'General notes';
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** `schema` (tests only): stop at that version, as an older app would have left the database. */
export function openDatabase(file: string, opts: { schema?: number } = {}): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL"); // safe with WAL: a power cut can lose the last commit, never corrupt
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, file, opts.schema ?? MIGRATIONS.length);
  return db;
}

/**
 * backups/app-before-schema-<n>-<UTC stamp>.db next to the database: a
 * consistent copy (VACUUM INTO) of everything as the previous version left
 * it. The migrations themselves run in transactions and never delete
 * anything; this is the belt to their braces. A copy that can't be written
 * (disk full) is reported, not fatal: the app must still start.
 */
function backupBeforeMigrating(db: Db, file: string, from: number, to: number) {
  try {
    const dir = path.join(path.dirname(file), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    let out = path.join(dir, `app-before-schema-${to}-from-${from}-${stamp}.db`);
    for (let i = 1; fs.existsSync(out); i++) out = path.join(dir, `app-before-schema-${to}-from-${from}-${stamp}-${i}.db`);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } catch (e) {
    console.error("[migrate] couldn't write the copy before migrating — migrating anyway", e);
  }
}

function migrate(db: Db, file: string, target: number) {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`The database is newer (schema ${current}) than this app (schema ${MIGRATIONS.length}). Deploy the newer app version.`);
  }
  // An existing database about to change shape: a full copy first, kept for good (the daily snapshots are pruned, this isn't).
  if (current > 0 && current < target) backupBeforeMigrating(db, file, current, target);
  for (let v = current; v < target; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function userVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Run `fn` inside one write transaction (BEGIN IMMEDIATE takes the write
 * lock up front, so a busy database waits instead of failing halfway).
 * `fn` must be synchronous — nothing else can run on this connection
 * while it holds the transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}
