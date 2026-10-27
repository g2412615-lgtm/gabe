// Event plans: list, create-by-upload, read, rename/delete/restore, page
// polling, adding files, the autosave endpoint and "Download PDF".

import fs from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { MAX_PLAN_NAME_CHARS } from "../../shared/constants";
import type { PlanDoc } from "../../shared/types";
import type { AppDeps } from "../context";
import { EXPORT_MSG, ExportCancelled, ExportFailed, exportPlanPdf, parseExportRequest } from "../export";
import { cleanName, contentDisposition, HttpError, idParam, isRecord, MSG, readJson } from "../http";
import { circlesOfPlan, commentsOfPlan, getPlan, pagesOfPlan, planSummaries } from "../repo";
import { applySync, MAX_SYNC_BYTES, MAX_SYNC_OPS } from "../sync";
import { handleUpload, type UploadContext } from "../uploads";

export function planRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono();
  const uploadCtx: UploadContext = {
    db,
    dataDir: config.dataDir,
    maxUploadBytes: config.maxUploadBytes,
    maxPagesPerFile: config.maxPagesPerFile,
    inspectTimeoutMs: config.inspectTimeoutMs,
    minFreeBytes: config.minFreeBytes,
  };

  /** A plan the owner can open (exists and isn't deleted). */
  const livePlan = (id: string) => {
    const plan = getPlan(db, id);
    if (!plan || plan.deletedAt !== null) throw new HttpError(404, MSG.planNotFound);
    return plan;
  };

  r.get("/plans", (c) => c.json({ plans: planSummaries(db) }));

  r.post("/plans/upload", async (c) => {
    const res = await handleUpload(c.req.raw, uploadCtx, { newPlanName: c.req.query("name") ?? null }, c.req.query("filename"));
    deps.kickRender();
    return c.json(res, 201);
  });

  r.get("/plans/:id", (c) => {
    const plan = livePlan(idParam(c, "id", MSG.planNotFound));
    const doc: PlanDoc = {
      plan,
      plans: [plan],
      pages: pagesOfPlan(db, plan.id),
      circles: circlesOfPlan(db, plan.id),
      comments: commentsOfPlan(db, plan.id),
      serverTime: Date.now(),
    };
    return c.json(doc);
  });

  // Rename, delete or restore from the home page. Works on deleted plans so Undo can bring one back.
  r.patch("/plans/:id", async (c) => {
    const id = idParam(c, "id", MSG.planNotFound);
    const plan = getPlan(db, id);
    if (!plan) throw new HttpError(404, MSG.planNotFound);
    const body = await readJson(c, 16 * 1024);
    if (!isRecord(body)) throw new HttpError(400, MSG.badRequest);

    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const now = Date.now();
    if (body.name !== undefined) {
      const name = cleanName(body.name, MAX_PLAN_NAME_CHARS);
      if (name === null) throw new HttpError(400, MSG.badRequest);
      if (!name) throw new HttpError(400, "Give the event plan a name.");
      if (name !== plan.name) {
        sets.push("name = ?");
        values.push(name);
      }
    }
    if (body.deleted !== undefined) {
      if (typeof body.deleted !== "boolean") throw new HttpError(400, MSG.badRequest);
      if (body.deleted && plan.deletedAt === null) {
        sets.push("deleted_at = ?");
        values.push(now);
      } else if (!body.deleted && plan.deletedAt !== null) {
        sets.push("deleted_at = NULL");
      }
    }
    if (sets.length) db.prepare(`UPDATE plans SET ${sets.join(", ")}, rev = rev + 1, updated_at = ? WHERE id = ?`).run(...values, now, id);
    // A deleted plan's pages stop rendering; a restored one's go back in line.
    if (body.deleted !== undefined) deps.kickRender();
    return c.json(getPlan(db, id));
  });

  // Polled by the editor while pages render.
  r.get("/plans/:id/pages", (c) => {
    const plan = livePlan(idParam(c, "id", MSG.planNotFound));
    return c.json({ pages: pagesOfPlan(db, plan.id) });
  });

  r.post("/plans/:id/files", async (c) => {
    const id = idParam(c, "id", MSG.planNotFound);
    const res = await handleUpload(c.req.raw, uploadCtx, { planId: id }, c.req.query("filename"));
    deps.kickRender();
    return c.json(res, 201);
  });

  r.post("/plans/:id/sync", async (c) => {
    const id = idParam(c, "id", MSG.planNotFound);
    // A deleted (not yet purged) plan still accepts saves: an edit made on the
    // iPad just before the plan was deleted elsewhere comes back with Undo.
    if (!getPlan(db, id)) throw new HttpError(404, MSG.planNotFound);
    const body = await readJson(c, MAX_SYNC_BYTES);
    if (!isRecord(body) || !Array.isArray(body.ops)) throw new HttpError(400, MSG.badRequest);
    if (body.ops.length > MAX_SYNC_OPS) throw new HttpError(413, "Too many changes in one save.");
    const res = applySync(db, id, body.ops);
    // Pages (or the plan) may have been deleted or restored: the render queue re-checks what it should work on.
    if (body.ops.some((op) => isRecord(op) && (op.kind === "page" || op.kind === "plan"))) deps.kickRender();
    return c.json(res);
  });

  // The chosen pages as one PDF, circles drawn on (export.ts). The PDF is made
  // in full before anything is sent, so a failure is still a plain message.
  r.post("/plans/:id/export", async (c) => {
    // first, before anything is awaited: it only reports a dropped connection from when it's first asked for
    const gone = c.req.raw.signal;
    const plan = livePlan(idParam(c, "id", MSG.planNotFound));
    const opts = parseExportRequest(await readJson(c, 256 * 1024));
    let res;
    try {
      res = await exportPlanPdf({ db, config }, plan, opts, gone);
    } catch (e) {
      if (e instanceof ExportCancelled) return c.body(null, 204); // nobody to tell
      if (!(e instanceof ExportFailed)) throw e;
      config.log.error(`export of plan ${plan.id} failed`, e.message);
      throw new HttpError(500, EXPORT_MSG.failed);
    }
    const file = res.file;
    const remove = () => fs.rm(file, { force: true }, () => {});
    if (gone.aborted) {
      remove();
      return c.body(null, 204);
    }
    const stream = fs.createReadStream(file);
    // sent, or the download stopped half way: the file goes
    const stop = () => stream.destroy();
    gone.addEventListener("abort", stop, { once: true });
    stream.once("close", () => {
      gone.removeEventListener("abort", stop);
      remove();
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(res.bytes),
        "Content-Disposition": contentDisposition(res.fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  return r;
}
