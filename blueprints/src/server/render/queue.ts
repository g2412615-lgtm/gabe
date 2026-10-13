// The render queue lives in the database: every page with status 'queued' is
// waiting. One page renders at a time (a 1-CPU host has nothing to gain from
// more, and each render holds a few hundred MB), each in a fresh worker
// thread. Status moves queued → rendering → preview (viewable) → ready, or
// → failed with a plain-language error and a Retry button in the editor.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db";
import type { Logger } from "../log";
import type { FinalMessage } from "./protocol";
import { runWorker, WorkerTimeoutError, type WorkerRun } from "./run-worker";

export const RENDER_ERRORS = {
  timeout: "This page took too long to prepare.",
  failed: "This page couldn't be prepared. Try uploading the file again.",
  missing: "The original file for this page is missing. Upload it again.",
} as const;

export interface RenderQueueOptions {
  db: Db;
  dataDir: string;
  timeoutMs: number;
  log: Logger;
}

interface Job {
  pageId: string;
  assetKey: string;
  file: string;
  kind: "pdf" | "image";
  pageIndex: number;
}

/** A fresh asset key: part of every asset URL, so a re-render never collides with a cached copy. */
export const newAssetKey = () => randomUUID().replace(/-/g, "");

export class RenderQueue {
  private running = false;
  private stopping = false;
  private current: { run: WorkerRun; done: Promise<void> } | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: RenderQueueOptions) {}

  /**
   * At boot: a page left 'rendering' or 'preview' was cut off by a restart —
   * queue it again (a fresh asset key is taken when it starts).
   */
  recover() {
    const now = Date.now();
    this.opts.db
      .prepare("UPDATE pages SET status = 'queued', error = NULL, updated_at = ?, rev = rev + 1 WHERE status IN ('rendering', 'preview')")
      .run(now);
  }

  /** Start working through the queue if it isn't already. Safe to call any time. */
  kick() {
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
    const finished = await Promise.race([cur.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref())]);
    if (!finished) {
      await cur.run.terminate().catch(() => {});
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

  /** The oldest queued page (live pages before deleted ones), marked 'rendering' with a fresh asset key. */
  private claimNext(): Job | null {
    const { db } = this.opts;
    const row = db
      .prepare(
        `SELECT g.id, g.source_index, s.id AS source_id, s.kind, s.ext
         FROM pages g JOIN sources s ON s.id = g.source_id
         WHERE g.status = 'queued'
         ORDER BY (g.deleted_at IS NOT NULL), g.created_at, g.sort_order, g.id
         LIMIT 1`,
      )
      .get() as { id: string; source_index: number; source_id: string; kind: string; ext: string } | undefined;
    if (!row) return null;
    const assetKey = newAssetKey();
    db.prepare("UPDATE pages SET status = 'rendering', error = NULL, asset_key = ?, updated_at = ?, rev = rev + 1 WHERE id = ?").run(
      assetKey,
      Date.now(),
      row.id,
    );
    return {
      pageId: row.id,
      assetKey,
      file: path.join(this.opts.dataDir, "uploads", `${row.source_id}.${row.ext}`),
      kind: row.kind === "image" ? "image" : "pdf",
      pageIndex: Number(row.source_index),
    };
  }

  private async render(job: Job) {
    const { db, dataDir, log } = this.opts;
    const started = Date.now();
    const outDir = path.join(dataDir, "assets", job.pageId, job.assetKey);
    const workDir = path.join(dataDir, "tmp", `render-${job.assetKey}`);

    if (!fs.existsSync(job.file)) {
      this.fail(job, RENDER_ERRORS.missing);
      log.error(`[render] page ${job.pageId}: source file missing (${job.file})`);
      return;
    }

    const run = runWorker(
      { task: "render", file: job.file, kind: job.kind, pageIndex: job.pageIndex, outDir, workDir },
      {
        timeoutMs: this.opts.timeoutMs,
        onMessage: (m) => {
          if (m.type !== "preview") return;
          // The page is viewable from here on; tiles keep rendering.
          db.prepare(
            `UPDATE pages SET status = 'preview', width = ?, height = ?, preview_w = ?, preview_h = ?, updated_at = ?, rev = rev + 1
             WHERE id = ? AND asset_key = ?`,
          ).run(m.width, m.height, m.previewW, m.previewH, Date.now(), job.pageId, job.assetKey);
        },
      },
    );
    const done = run.promise.then(
      (m) => {
        fs.rmSync(workDir, { recursive: true, force: true }); // normally gone already
        this.finish(job, m, started);
      },
      (err) => {
        fs.rmSync(workDir, { recursive: true, force: true });
        const timedOut = err instanceof WorkerTimeoutError;
        // Stopped by a shutdown: leave it 'rendering' so the next boot queues it again.
        if (this.stopping && !timedOut) return;
        this.fail(job, timedOut ? RENDER_ERRORS.timeout : RENDER_ERRORS.failed);
        log.error(`[render] page ${job.pageId} ${timedOut ? "timed out" : "worker failed"}`, err);
      },
    );
    this.current = { run, done };
    await done;
    this.current = null;
  }

  private finish(job: Job, m: FinalMessage, started: number) {
    const { db, dataDir, log } = this.opts;
    if (m.type !== "done") {
      this.fail(job, RENDER_ERRORS.failed);
      log.error(`[render] page ${job.pageId} failed: ${m.type === "error" ? m.message : m.type}`);
      return;
    }
    const res = db
      .prepare(
        `UPDATE pages SET status = 'ready', error = NULL, tile_size = ?, max_level = ?, min_level = ?, tile_format = ?, updated_at = ?, rev = rev + 1
         WHERE id = ? AND asset_key = ?`,
      )
      .run(m.tileSize, m.maxLevel, m.minLevel, m.tileFormat, Date.now(), job.pageId, job.assetKey);
    const pageDir = path.join(dataDir, "assets", job.pageId);
    if (Number(res.changes) === 0) {
      // purged (or re-queued) while rendering: these files belong to nobody
      fs.rmSync(path.join(pageDir, job.assetKey), { recursive: true, force: true });
      return;
    }
    // Earlier renders of this page (a retry, or one cut off by a restart) are now stale.
    for (const name of safeReaddir(pageDir)) {
      if (name !== job.assetKey) fs.rmSync(path.join(pageDir, name), { recursive: true, force: true });
    }
    log.info(`[render] page ${job.pageId} ready in ${Date.now() - started} ms`);
  }

  private fail(job: Job, message: string) {
    this.opts.db
      .prepare("UPDATE pages SET status = 'failed', error = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND asset_key = ?")
      .run(message, Date.now(), job.pageId, job.assetKey);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
