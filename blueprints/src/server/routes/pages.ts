// Page retry and duplicate, rendered page assets (preview, thumbnail,
// deep-zoom tiles) and the original uploaded file.

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import type { AppDeps } from "../context";
import { duplicatePage } from "../duplicate";
import { contentDisposition, HttpError, idParam, isId, isRecord, MSG, readJson } from "../http";
import { newAssetKey } from "../render/queue";
import { getPage, getPlan, getSource } from "../repo";
import { fileStream } from "../static";

/** Asset URLs contain the render's asset key, so a URL's bytes never change. */
const IMMUTABLE = "private, max-age=31536000, immutable";
const TILE_RE = /^(\d{1,5})_(\d{1,5})\.(png|jpeg)$/;

export function pageRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const r = new Hono();
  const assetsDir = path.join(config.dataDir, "assets");

  async function sendAsset(c: Context, parts: string[], type: string) {
    const file = path.join(assetsDir, ...parts);
    let data: Buffer;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new HttpError(404, MSG.notFound);
    }
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": type,
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
    });
  }

  /** The two path segments every asset URL starts with, validated (`[A-Za-z0-9_-]{1,64}`). */
  const assetBase = (c: Context) => {
    const id = c.req.param("id");
    const key = c.req.param("key");
    if (!isId(id) || !isId(key)) throw new HttpError(404, MSG.notFound);
    return [id, key];
  };

  r.get("/pages/:id/:key/preview.webp", (c) => sendAsset(c, [...assetBase(c), "preview.webp"], "image/webp"));
  r.get("/pages/:id/:key/thumb.webp", (c) => sendAsset(c, [...assetBase(c), "thumb.webp"], "image/webp"));
  r.get("/pages/:id/:key/tiles/:level/:tile", (c) => {
    const base = assetBase(c);
    const level = c.req.param("level");
    const m = TILE_RE.exec(c.req.param("tile"));
    if (!/^\d{1,2}$/.test(level) || Number(level) > 40 || !m) throw new HttpError(404, MSG.notFound);
    const [, col, row, ext] = m;
    // normalise "007" → "7": dzsave names tiles without leading zeros
    const name = `${Number(col)}_${Number(row)}.${ext}`;
    return sendAsset(c, [...base, "tiles", String(Number(level)), name], ext === "png" ? "image/png" : "image/jpeg");
  });

  // Re-queue a page that failed to render (a fresh asset key, so no stale
  // image can be cached). The owner asked for it, so it gets fresh attempts.
  r.post("/pages/:id/retry", (c) => {
    const id = idParam(c, "id", MSG.pageNotFound);
    const page = getPage(db, id);
    const plan = page && getPlan(db, page.planId);
    if (!page || !plan) throw new HttpError(404, MSG.pageNotFound);
    if (page.status === "failed") {
      db.prepare(
        "UPDATE pages SET status = 'queued', error = NULL, asset_key = ?, render_attempts = 0, updated_at = ?, rev = rev + 1 WHERE id = ?",
      ).run(
        newAssetKey(),
        Date.now(),
        id,
      );
      deps.kickRender();
    }
    return c.json({ page: getPage(db, id) });
  });

  // A copy of the page right after it: { id?, label? } → 201 { page, pages }
  // (200 with the same copy when a page with that id was already made by this duplicate).
  r.post("/pages/:id/duplicate", async (c) => {
    const id = idParam(c, "id", MSG.pageNotFound);
    const body = await readJson(c, 8 * 1024);
    const res = duplicatePage(db, config.dataDir, id, isRecord(body) ? { label: body.label, id: body.id } : {});
    if (res.queued) deps.kickRender();
    return c.json({ page: res.page, pages: res.pages }, res.created ? 201 : 200);
  });

  // The uploaded file exactly as it arrived.
  r.get("/sources/:id/original", (c) => {
    const id = idParam(c, "id");
    const source = getSource(db, id);
    if (!source) throw new HttpError(404, MSG.notFound);
    const file = path.join(config.dataDir, "uploads", `${source.id}.${source.ext}`);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      throw new HttpError(404, "The original file is missing.");
    }
    const type = source.ext === "pdf" ? "application/pdf" : source.ext === "png" ? "image/png" : "image/jpeg";
    const headers = {
      "Content-Type": type,
      "Content-Length": String(size),
      "Content-Disposition": contentDisposition(originalName(source.originalName, source.ext)),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    };
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(fileStream(file), { status: 200, headers });
  });

  return r;
}

/** attachment; filename="ascii fallback"; filename*=UTF-8''<the real name> (RFC 6266 / 5987). */
function originalName(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) || (ext === "jpg" && /\.jpe?g$/i.test(name)) ? name : `${name}.${ext}`;
}
