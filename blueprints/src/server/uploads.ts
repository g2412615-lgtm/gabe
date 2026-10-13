// Uploads: the raw request body (not multipart) is streamed to DATA_DIR/tmp
// with a hard byte limit, the bytes decide what the file is (never the name
// or the declared type), a PDF is opened inside a worker to count its pages,
// and only then is the file moved into uploads/ and the source + one queued
// page per sheet inserted in a single transaction. Rendering happens later,
// in the background.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import sharp from "sharp";
import { MAX_LABEL_CHARS, MAX_PLAN_NAME_CHARS } from "../shared/constants";
import type { PageRow, PlanRow, SourceRow, UploadResponse } from "../shared/types";
import { tx, type Db } from "./db";
import { cleanFileName, cleanName, HttpError, withoutExtension } from "./http";
import { newAssetKey } from "./render/queue";
import { runWorker } from "./render/run-worker";
import { getPlan, toPage, toSource } from "./repo";

export const UPLOAD_MSG = {
  tooBig: (mb: number) => `That file is over ${mb} MB. Export a smaller PDF or split the set.`,
  empty: "That file is empty.",
  wrongType: "That file isn't a PDF, PNG or JPG.",
  password: "That PDF is password-protected. Save an unlocked copy and upload that.",
  corrupt: "That PDF couldn't be read. Try exporting it again.",
  tooManyPages: (n: number, max: number) => `That PDF has ${n} pages — the limit is ${max} per file. Split the set and upload it in parts.`,
  badImage: "That image couldn't be read. Try saving it again as a PNG or JPG.",
  imageTooLarge: "That image is too large to open. Save it at a smaller size and try again.",
} as const;

/** sharp's default decode limit (≈ 16384 × 16384); larger images would fail at render time. */
const MAX_IMAGE_PIXELS = 268_402_689;

type Sniffed = "pdf" | "png" | "jpeg";

/** What the bytes really are. PDFs may carry a little junk before the header (the PDF spec allows 1 KB). */
export function sniff(head: Buffer): Sniffed | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 1024).includes("%PDF-", 0, "latin1")) return "pdf";
  return null;
}

export interface UploadContext {
  db: Db;
  dataDir: string;
  maxUploadBytes: number;
  maxPagesPerFile: number;
  inspectTimeoutMs: number;
}

/** Stream the request body to a temp file, stopping at the size limit. */
async function receive(req: Request, ctx: UploadContext): Promise<{ file: string; bytes: number; head: Buffer }> {
  const limitMb = Math.round(ctx.maxUploadBytes / (1024 * 1024));
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ctx.maxUploadBytes) throw new HttpError(413, UPLOAD_MSG.tooBig(limitMb));
  if (!req.body) throw new HttpError(400, UPLOAD_MSG.empty);

  const file = path.join(ctx.dataDir, "tmp", `upload-${randomUUID()}`);
  let bytes = 0;
  const headParts: Buffer[] = [];
  let headLen = 0;
  try {
    await pipeline(
      Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > ctx.maxUploadBytes) throw new HttpError(413, UPLOAD_MSG.tooBig(limitMb));
          if (headLen < 1024) {
            headParts.push(chunk);
            headLen += chunk.length;
          }
          yield chunk;
        }
      },
      fs.createWriteStream(file, { flags: "wx" }),
    );
  } catch (e) {
    await fsp.rm(file, { force: true });
    throw e;
  }
  if (bytes === 0) {
    await fsp.rm(file, { force: true });
    throw new HttpError(400, UPLOAD_MSG.empty);
  }
  return { file, bytes, head: Buffer.concat(headParts).subarray(0, 1024) };
}

/** Page count and default names of a PDF, read by mupdf inside a worker (never on the main thread). */
async function inspectPdf(file: string, ctx: UploadContext): Promise<(string | null)[]> {
  let m;
  try {
    m = await runWorker({ task: "inspect", file, maxPages: ctx.maxPagesPerFile }, { timeoutMs: ctx.inspectTimeoutMs }).promise;
  } catch {
    throw new HttpError(400, UPLOAD_MSG.corrupt);
  }
  if (m.type !== "inspected") throw new HttpError(400, UPLOAD_MSG.corrupt);
  if (m.needsPassword) throw new HttpError(400, UPLOAD_MSG.password);
  if (m.pageCount < 1) throw new HttpError(400, UPLOAD_MSG.corrupt);
  if (m.pageCount > ctx.maxPagesPerFile) throw new HttpError(400, UPLOAD_MSG.tooManyPages(m.pageCount, ctx.maxPagesPerFile));
  return m.labels;
}

/** Make sure an image decodes (sharp works off the main thread) and isn't absurdly large. */
async function checkImage(file: string): Promise<void> {
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(file).metadata();
  } catch {
    throw new HttpError(400, UPLOAD_MSG.badImage);
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new HttpError(400, UPLOAD_MSG.badImage);
  if (w * h > MAX_IMAGE_PIXELS) throw new HttpError(400, UPLOAD_MSG.imageTooLarge);
}

/**
 * Handle one upload. `target` is either a new plan (with the name the owner
 * typed, if any) or an existing plan to append pages to.
 */
export async function handleUpload(
  req: Request,
  ctx: UploadContext,
  target: { newPlanName: string | null } | { planId: string },
  rawFileName: string | undefined,
): Promise<UploadResponse> {
  const { db, dataDir } = ctx;
  if ("planId" in target) {
    // fail fast, before receiving 150 MB for a plan that's gone
    const plan = getPlan(db, target.planId);
    if (!plan || plan.deletedAt !== null) throw new HttpError(404, "That event plan doesn't exist or was deleted.");
  }
  const fileName = cleanFileName(rawFileName);
  const received = await receive(req, ctx);
  let stored: string | null = null;
  try {
    const type = sniff(received.head);
    if (!type) throw new HttpError(400, UPLOAD_MSG.wrongType);
    let labels: (string | null)[] = [null]; // an image is one page
    if (type === "pdf") labels = await inspectPdf(received.file, ctx);
    else await checkImage(received.file);

    const sourceId = randomUUID();
    const ext = type === "pdf" ? "pdf" : type === "png" ? "png" : "jpg";
    stored = path.join(dataDir, "uploads", `${sourceId}.${ext}`);
    await fsp.rename(received.file, stored);

    const now = Date.now();
    const result = tx(db, (): UploadResponse => {
      let planId: string;
      if ("planId" in target) {
        // re-check inside the transaction: the plan may have been deleted while the file streamed in
        const plan = getPlan(db, target.planId);
        if (!plan || plan.deletedAt !== null) throw new HttpError(404, "That event plan doesn't exist or was deleted.");
        planId = plan.id;
        db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, planId);
      } else {
        planId = randomUUID();
        const name =
          cleanName(target.newPlanName, MAX_PLAN_NAME_CHARS) || cleanName(withoutExtension(fileName), MAX_PLAN_NAME_CHARS) || "Untitled event plan";
        db.prepare("INSERT INTO plans (id, name, circle_seq, created_at, updated_at, deleted_at, rev) VALUES (?, ?, 0, ?, ?, NULL, 1)").run(
          planId,
          name,
          now,
          now,
        );
      }

      db.prepare(
        "INSERT INTO sources (id, plan_id, original_name, kind, ext, bytes, page_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(sourceId, planId, fileName, type === "pdf" ? "pdf" : "image", ext, received.bytes, labels.length, now);

      // New pages go after everything already there (tombstones included, so an undo never lands in between).
      const agg = db
        .prepare("SELECT MAX(sort_order) AS maxSort, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live FROM pages WHERE plan_id = ?")
        .get(planId) as { maxSort: number | null; live: number | null };
      const firstSort = agg.maxSort === null ? 1 : Math.floor(Number(agg.maxSort)) + 1;
      const liveBefore = Number(agg.live ?? 0);
      const imageLabel = cleanName(withoutExtension(fileName), MAX_LABEL_CHARS);

      const insert = db.prepare(
        `INSERT INTO pages (id, plan_id, source_id, source_index, label, sort_order, status, error, asset_key, created_at, updated_at, deleted_at, rev)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, NULL, 1)`,
      );
      const pageIds: string[] = [];
      labels.forEach((pdfLabel, i) => {
        const fallback = `Page ${liveBefore + i + 1}`;
        const label = type === "pdf" ? cleanName(pdfLabel, MAX_LABEL_CHARS) || fallback : imageLabel || fallback;
        const id = randomUUID();
        pageIds.push(id);
        insert.run(id, planId, sourceId, i, label, firstSort + i, newAssetKey(), now, now);
      });

      const plan = getPlan(db, planId) as PlanRow;
      const source = toSource(db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as Record<string, unknown>) as SourceRow;
      const pages: PageRow[] = pageIds.map((id) => toPage(db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as Record<string, unknown>));
      return { plan, source, pages };
    });
    stored = null; // committed: the file belongs to the source row now
    return result;
  } finally {
    await fsp.rm(received.file, { force: true });
    if (stored) await fsp.rm(stored, { force: true });
  }
}
