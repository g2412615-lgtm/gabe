// Daily housekeeping, on wall-clock stamp files in DATA_DIR (a Fly machine
// that is suspended when idle freezes timers, so "every 24 h" means "when
// the last run is more than a day old", checked at boot and every 10 min):
//
//  - backup: VACUUM INTO DATA_DIR/backups/app-<UTC stamp>.db, newest 14 kept
//    (boot.sh copies them off-site);
//  - purge: tombstones older than PURGE_AFTER_DAYS are deleted for good,
//    with their children and files.

import fs from "node:fs";
import path from "node:path";
import { PURGE_AFTER_DAYS } from "../shared/constants";
import { tx, type Db } from "./db";
import type { Logger } from "./log";

const DAY = 86_400_000;
export const BACKUPS_KEPT = 14;
const CHECK_EVERY_MS = 10 * 60_000;

function readStamp(file: string): number {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeStamp(file: string, now: number) {
  fs.writeFileSync(file, `${now}\n`);
}

/** 2026-10-13T17:22:05Z → 20261013T172205Z (sorts by time, no characters a shell or URL cares about). */
function utcStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// ── backups ──────────────────────────────────────────────────────────────

/** Writes a consistent copy of the live database and keeps the newest 14. Returns the new file. */
export function backupNow(db: Db, dataDir: string, now = Date.now()): string {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `app-${utcStamp(now)}.db`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `app-${utcStamp(now)}-${i}.db`);
  // VACUUM INTO writes a compact, transactionally consistent snapshot without stopping writes for long
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs
    .readdirSync(dir)
    .filter((n) => /^app-\d{8}T\d{6}Z(-\d+)?\.db$/.test(n))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

// ── purge ────────────────────────────────────────────────────────────────

export interface PurgeResult {
  plans: number;
  pages: number;
  circles: number;
  comments: number;
  sources: number;
}

/**
 * Hard-delete tombstones older than `days`. Children go with their parents
 * (foreign keys cascade); asset folders of every removed page and source
 * files no page points at any more are deleted after the transaction commits.
 */
export function purgeNow(db: Db, dataDir: string, now = Date.now(), days = PURGE_AFTER_DAYS): PurgeResult {
  const cutoff = now - days * DAY;
  const { result, pageIds, sourceFiles } = tx(db, () => {
    // pages about to disappear, directly or with their plan
    const pageIds = (
      db
        .prepare(
          `SELECT g.id FROM pages g JOIN plans p ON p.id = g.plan_id
           WHERE (g.deleted_at IS NOT NULL AND g.deleted_at < ?) OR (p.deleted_at IS NOT NULL AND p.deleted_at < ?)`,
        )
        .all(cutoff, cutoff) as { id: string }[]
    ).map((r) => r.id);
    // sources of plans about to go (the plan delete cascades to their rows)
    const planSources = db
      .prepare("SELECT s.id, s.ext FROM sources s JOIN plans p ON p.id = s.plan_id WHERE p.deleted_at IS NOT NULL AND p.deleted_at < ?")
      .all(cutoff) as { id: string; ext: string }[];

    const comments = Number(db.prepare("DELETE FROM comments WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
    const circles = Number(db.prepare("DELETE FROM circles WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
    const pages = Number(db.prepare("DELETE FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);
    const plans = Number(db.prepare("DELETE FROM plans WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff).changes);

    // sources (uploaded originals) that no page uses any more
    const orphans = db.prepare("SELECT id, ext FROM sources s WHERE NOT EXISTS (SELECT 1 FROM pages g WHERE g.source_id = s.id)").all() as {
      id: string;
      ext: string;
    }[];
    const delSource = db.prepare("DELETE FROM sources WHERE id = ?");
    for (const s of orphans) delSource.run(s.id);
    const gone = [...planSources, ...orphans];
    return {
      result: { plans, pages, circles, comments, sources: gone.length },
      pageIds,
      sourceFiles: gone.map((s) => path.join(dataDir, "uploads", `${s.id}.${s.ext}`)),
    };
  });
  // Files only after the commit: a rolled-back purge must not lose a blueprint.
  for (const id of pageIds) fs.rmSync(path.join(dataDir, "assets", id), { recursive: true, force: true });
  for (const f of sourceFiles) fs.rmSync(f, { force: true });
  return result;
}

/** Leftovers of uploads/renders cut off by a crash (nothing is in flight at boot). */
export function clearTmp(dataDir: string) {
  const dir = path.join(dataDir, "tmp");
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

// ── scheduler ────────────────────────────────────────────────────────────

export function startMaintenance(db: Db, dataDir: string, log: Logger): { stop(): void } {
  const check = () => {
    const now = Date.now();
    const backupStamp = path.join(dataDir, ".last-backup");
    if (now - readStamp(backupStamp) >= DAY) {
      try {
        const file = backupNow(db, dataDir, now);
        writeStamp(backupStamp, now);
        log.info(`[backup] wrote ${path.basename(file)}`);
      } catch (e) {
        log.error("[backup] FAILED — will retry in 10 minutes", e);
      }
    }
    const purgeStamp = path.join(dataDir, ".last-purge");
    if (now - readStamp(purgeStamp) >= DAY) {
      try {
        const r = purgeNow(db, dataDir, now);
        writeStamp(purgeStamp, now);
        const total = r.plans + r.pages + r.circles + r.comments + r.sources;
        if (total) log.info(`[purge] removed ${r.plans} plans, ${r.pages} pages, ${r.circles} circles, ${r.comments} comments, ${r.sources} files`);
      } catch (e) {
        log.error("[purge] FAILED — will retry in 10 minutes", e);
      }
    }
  };
  // a moment after boot, so a restart answers requests first
  const first = setTimeout(check, 5_000);
  const timer = setInterval(check, CHECK_EVERY_MS);
  first.unref();
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
