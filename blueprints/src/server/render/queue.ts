// The render queue lives in the database: every page with status 'queued' is
// waiting. One page renders at a time (a 1-CPU host has nothing to gain from
// more, and each render holds a few hundred MB), each in a fresh worker
// process. Status moves queued → rendering → preview (viewable) → ready, or
// → failed with a plain-language error and a Retry button in the editor.
//
// A page whose renderer keeps dying (out of memory — or the whole server
// going down with it) is tried MAX_RENDER_ATTEMPTS times, then marked failed:
// it can never put the server into a crash loop. Pages that are deleted, or
// belong to a deleted plan, are not rendered (an Undo brings them back into
// the queue); deleting the page being rendered stops its render.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tx, type Db } from "../db";
import type { Logger } from "../log";
import { freeBytes, STORAGE_FULL } from "../storage";
import type { FinalMessage } from "./protocol";
import { runWorker, WorkerCrashError, WorkerTimeoutError, type WorkerRun } from "./run-worker";

export const RENDER_ERRORS = {
  timeout: "This page took too long to prepare.",
  failed: "This page couldn't be prepared. Try uploading the file again.",
  missing: "The original file for this page is missing. Upload it again.",
  tooLarge: "This page is too large or complex to prepare. Try exporting it as a smaller PDF.",
  storageFull: STORAGE_FULL.render,
} as const;

/** Renders started for one page without finishing (a killed worker, or a server restart) before it is marked failed. */
export const MAX_RENDER_ATTEMPTS = 2;

export interface RenderQueueOptions {
  db: Db;
  dataDir: string;
  timeoutMs: number;
  /** No page is rendered while the data volume has less than this free. */
  minFreeBytes: number;
  log: Logger;
}

interface Job {
  pageId: string;
  assetKey: string;
  file: string;
  kind: "pdf" | "image";
  pageIndex: number;
  /** Including this one. */
  attempts: number;
}

interface Current {
  job: Job;
  run: WorkerRun;
  done: Promise<void>;
  /** The preview and thumbnail are on disk: the page is viewable whatever happens to the tiles. */
  previewed: boolean;
  /** Set when the queue killed the worker itself. */
  stoppedFor: "shutdown" | "abandoned" | null;
}

/** A fresh asset key: part of every asset URL, so a re-render never collides with a cached copy. */
export const newAssetKey = () => randomUUID().replace(/-/g, "");

export class RenderQueue {
  private running = false;
  private stopping = false;
  private current: Current | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: RenderQueueOptions) {}

  /**
   * At boot: a page left 'rendering' or 'preview' was cut off — by a restart,
   * or because rendering it took the server down. Queue it again, unless it
   * has already had its attempts: then keep it viewable if its preview was
   * made, else mark it failed. Never retried automatically after that.
   */
  recover() {
    const { db, dataDir, log } = this.opts;
    const cut = db.prepare("SELECT id, status, asset_key, render_attempts FROM pages WHERE status IN ('rendering', 'preview')").all() as {
      id: string;
      status: string;
      asset_key: string;
      render_attempts: number;
    }[];
    tx(db, () => {
      for (const p of cut) {
        const job = { pageId: p.id, assetKey: p.asset_key };
        if (Number(p.render_attempts) < MAX_RENDER_ATTEMPTS) this.requeue(job, false);
        else if (p.status === "preview" && fs.existsSync(path.join(dataDir, "assets", p.id, p.asset_key, "preview.webp"))) this.previewOnly(job);
        else this.fail(job, RENDER_ERRORS.tooLarge);
      }
    });
    for (const p of cut) {
      if (Number(p.render_attempts) >= MAX_RENDER_ATTEMPTS) log.error(`[render] page ${p.id}: rendering was cut off ${p.render_attempts} times; not retrying it`);
    }
  }

  /**
   * Start working through the queue if it isn't already, and drop the page
   * in progress if it has been deleted. Safe to call any time: after uploads,
   * retries, and deletes or restores of pages and plans.
   */
  kick() {
    this.abandonIfDeleted();
    if (this.running || this.stopping) return;
    this.running = true;
    void this.loop();
  }

  /** Resolves when nothing is queued or rendering (tests, and handy for scripts). */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get busy() {
    return this.running;
  }

  /**
   * Shutdown: take no new pages, give the current one `graceMs` to finish,
   * then stop its worker (the page goes back to 'queued' at next boot).
   */
  async stop(graceMs: number) {
    this.stopping = true;
    const cur = this.current;
    if (!cur) return;
    // A deploy cutting the render short isn't the page's fault: hand back its
    // attempt now, in case this process is killed before the grace runs out.
    this.opts.db
      .prepare("UPDATE pages SET render_attempts = MAX(render_attempts - 1, 0) WHERE id = ? AND asset_key = ?")
      .run(cur.job.pageId, cur.job.assetKey);
    const finished = await Promise.race([cur.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref())]);
    if (!finished) {
      cur.stoppedFor = "shutdown";
      await cur.run.terminate();
      await cur.done; // let the bookkeeping finish before the database closes
    }
  }

  private async loop() {
    try {
      while (!this.stopping) {
        const job = this.claimNext();
        if (!job) break;
        await this.render(job);
      }
    } catch (e) {
      this.opts.log.error("[render] queue loop stopped", e);
    } finally {
      this.running = false;
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  /** The oldest queued page that is still wanted (it and its plan not deleted), marked 'rendering' with a fresh asset key. */
  private claimNext(): Job | null {
    const { db } = this.opts;
    const row = db
      .prepare(
        `SELECT g.id, g.source_index, g.render_attempts, s.id AS source_id, s.kind, s.ext
         FROM pages g JOIN sources s ON s.id = g.source_id JOIN plans p ON p.id = g.plan_id
         WHERE g.status = 'queued' AND g.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY g.created_at, g.sort_order, g.id
         LIMIT 1`,
      )
      .get() as { id: string; source_index: number; render_attempts: number; source_id: string; kind: string; ext: string } | undefined;
    if (!row) return null;
    const assetKey = newAssetKey();
    // counted before the render starts: if it takes the server down, the next boot knows
    db.prepare(
      "UPDATE pages SET status = 'rendering', error = NULL, asset_key = ?, render_attempts = render_attempts + 1, updated_at = ?, rev = rev + 1 WHERE id = ?",
    ).run(assetKey, Date.now(), row.id);
    return {
      pageId: row.id,
      assetKey,
      file: path.join(this.opts.dataDir, "uploads", `${row.source_id}.${row.ext}`),
      kind: row.kind === "image" ? "image" : "pdf",
      pageIndex: Number(row.source_index),
      attempts: Number(row.render_attempts) + 1,
    };
  }

  private async render(job: Job) {
    const { dataDir, log } = this.opts;
    const started = Date.now();
    const outDir = this.outDir(job);
    const workDir = path.join(dataDir, "tmp", `render-${job.assetKey}`);

    if (!fs.existsSync(job.file)) {
      this.fail(job, RENDER_ERRORS.missing);
      log.error(`[render] page ${job.pageId}: source file missing (${job.file})`);
      return;
    }
    if (freeBytes(dataDir) < this.opts.minFreeBytes) {
      this.fail(job, RENDER_ERRORS.storageFull);
      log.error(`[render] page ${job.pageId}: not rendered, the data volume is (nearly) full`);
      return;
    }

    const cur = { job, previewed: false, stoppedFor: null } as Current;
    try {
      cur.run = this.startWorker(cur, outDir, workDir);
    } catch (e) {
      this.fail(job, RENDER_ERRORS.failed);
      log.error(`[render] page ${job.pageId}: couldn't start a worker`, e);
      return;
    }
    // The worker process is gone by the time either branch runs, so nothing
    // writes into the work folder any more.
    cur.done = cur.run.promise.then(
      (m) => {
        fs.rmSync(workDir, { recursive: true, force: true }); // normally gone already
        this.finish(cur, m, started);
      },
      (err) => {
        fs.rmSync(workDir, { recursive: true, force: true });
        this.failed(cur, err);
      },
    );
    this.current = cur;
    await cur.done;
    this.current = null;
  }

  private startWorker(cur: Current, outDir: string, workDir: string): WorkerRun {
    const { db } = this.opts;
    const { job } = cur;
    return runWorker(
      { task: "render", file: job.file, kind: job.kind, pageIndex: job.pageIndex, outDir, workDir },
      {
        timeoutMs: this.opts.timeoutMs,
        onMessage: (m) => {
          if (m.type !== "preview") return;
          cur.previewed = true;
          // The page is viewable from here on; tiles keep rendering.
          db.prepare(
            `UPDATE pages SET status = 'preview', width = ?, height = ?, preview_w = ?, preview_h = ?, updated_at = ?, rev = rev + 1
             WHERE id = ? AND asset_key = ? AND status = 'rendering'`,
          ).run(m.width, m.height, m.previewW, m.previewH, Date.now(), job.pageId, job.assetKey);
        },
      },
    );
  }

  private finish(cur: Current, m: FinalMessage, started: number) {
    const { db, dataDir, log } = this.opts;
    const { job } = cur;
    if (m.type !== "done") {
      const message = m.type === "error" ? m.message : m.type;
      if (cur.previewed) {
        // the tiles failed, but the page can still be seen and marked up
        this.previewOnly(job);
        log.error(`[render] page ${job.pageId}: tiles failed, keeping the preview: ${message}`);
        return;
      }
      const full = (m.type === "error" && m.code === "nospace") || freeBytes(dataDir) < this.opts.minFreeBytes;
      this.fail(job, full ? RENDER_ERRORS.storageFull : RENDER_ERRORS.failed);
      log.error(`[render] page ${job.pageId} failed: ${message}`);
      return;
    }
    const res = db
      .prepare(
        `UPDATE pages SET status = 'ready', error = NULL, tile_size = ?, max_level = ?, min_level = ?, tile_format = ?, render_attempts = 0,
           updated_at = ?, rev = rev + 1
         WHERE id = ? AND asset_key = ?`,
      )
      .run(m.tileSize, m.maxLevel, m.minLevel, m.tileFormat, Date.now(), job.pageId, job.assetKey);
    if (Number(res.changes) === 0) {
      // purged (or re-queued) while rendering: these files belong to nobody
      this.removeOutDir(job);
      return;
    }
    this.removeStaleRenders(job);
    log.info(`[render] page ${job.pageId} ready in ${Date.now() - started} ms (${m.tileFormat} tiles)`);
  }

  /** The worker died, timed out, or was stopped by the queue. */
  private failed(cur: Current, err: unknown) {
    const { log } = this.opts;
    const { job } = cur;
    if (cur.stoppedFor === "shutdown") return; // left 'rendering': the next boot queues it again
    if (cur.stoppedFor === "abandoned") {
      // deleted while rendering: back in the queue in case an Undo brings it back
      this.requeue(job, true);
      log.info(`[render] page ${job.pageId} was deleted; stopped rendering it`);
      return;
    }
    if (cur.previewed) {
      // tiles didn't make it, but the preview did: keep the page viewable
      this.previewOnly(job);
      log.error(`[render] page ${job.pageId}: no tiles (${err instanceof Error ? err.message : String(err)}), keeping the preview`);
      return;
    }
    if (err instanceof WorkerTimeoutError) {
      this.fail(job, RENDER_ERRORS.timeout);
      log.error(`[render] page ${job.pageId} timed out`);
    } else if (err instanceof WorkerCrashError) {
      // almost always the kernel killing it for memory: one more try, then give up
      if (job.attempts >= MAX_RENDER_ATTEMPTS) this.fail(job, RENDER_ERRORS.tooLarge);
      else this.requeue(job, false);
      log.error(`[render] page ${job.pageId}: attempt ${job.attempts} of ${MAX_RENDER_ATTEMPTS} failed: ${err.message}`);
    } else {
      this.fail(job, RENDER_ERRORS.failed);
      log.error(`[render] page ${job.pageId}: worker failed`, err);
    }
  }

  /** Kill the render in progress if its page — or the page's plan — has been deleted (or purged). */
  private abandonIfDeleted() {
    const cur = this.current;
    if (!cur || cur.stoppedFor) return;
    const row = this.opts.db
      .prepare("SELECT g.deleted_at AS page_deleted, p.deleted_at AS plan_deleted FROM pages g JOIN plans p ON p.id = g.plan_id WHERE g.id = ?")
      .get(cur.job.pageId) as { page_deleted: number | null; plan_deleted: number | null } | undefined;
    if (row && row.page_deleted === null && row.plan_deleted === null) return;
    cur.stoppedFor = "abandoned";
    void cur.run.terminate();
  }

  // ── outcomes (each only touches the row while it still belongs to this render) ──

  private fail(job: Pick<Job, "pageId" | "assetKey">, message: string) {
    this.opts.db
      .prepare("UPDATE pages SET status = 'failed', error = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND asset_key = ?")
      .run(message, Date.now(), job.pageId, job.assetKey);
    this.removeOutDir(job);
  }

  /** Back to 'queued'; `refund` hands back the attempt when the render's end wasn't the page's fault. */
  private requeue(job: Pick<Job, "pageId" | "assetKey">, refund: boolean) {
    this.opts.db
      .prepare(
        `UPDATE pages SET status = 'queued', error = NULL, render_attempts = MAX(render_attempts - ?, 0), updated_at = ?, rev = rev + 1
         WHERE id = ? AND asset_key = ?`,
      )
      .run(refund ? 1 : 0, Date.now(), job.pageId, job.assetKey);
    this.removeOutDir(job);
  }

  /** Ready without deep-zoom tiles: the editor shows the (2048 px) preview at every zoom. */
  private previewOnly(job: Pick<Job, "pageId" | "assetKey">) {
    const res = this.opts.db
      .prepare(
        `UPDATE pages SET status = 'ready', error = NULL, tile_size = 0, max_level = 0, min_level = 0, tile_format = '', render_attempts = 0,
           updated_at = ?, rev = rev + 1
         WHERE id = ? AND asset_key = ?`,
      )
      .run(Date.now(), job.pageId, job.assetKey);
    if (Number(res.changes) === 0) return this.removeOutDir(job);
    fs.rmSync(path.join(this.outDir(job), "tiles"), { recursive: true, force: true }); // a pyramid that never got recorded
    this.removeStaleRenders(job);
  }

  // ── files ──

  private outDir(job: Pick<Job, "pageId" | "assetKey">) {
    return path.join(this.opts.dataDir, "assets", job.pageId, job.assetKey);
  }

  /** This render's folder (and the page's folder, when nothing else is left in it). */
  private removeOutDir(job: Pick<Job, "pageId" | "assetKey">) {
    fs.rmSync(this.outDir(job), { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(this.outDir(job)));
    } catch {
      /* not empty (an earlier render is still in use), or already gone */
    }
  }

  /** Earlier renders of this page (a retry, or one cut off by a restart) are stale once this one is in use. */
  private removeStaleRenders(job: Pick<Job, "pageId" | "assetKey">) {
    const pageDir = path.join(this.opts.dataDir, "assets", job.pageId);
    for (const name of safeReaddir(pageDir)) {
      if (name !== job.assetKey) fs.rmSync(path.join(pageDir, name), { recursive: true, force: true });
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
