// Duplicating a page (the page ⋯ menu's "Duplicate page…"): a new page in
// the same plan, right after the original, showing the same sheet.
//
// A page that's ready gets its own copy of the rendered images: hard links
// to the same files, so the copy is instant and takes no extra space, while
// each page still owns its folder (the renderer and the purge remove a
// page's folder without asking who else uses it). A page that isn't ready
// (still being prepared, or failed) is rendered again from the same
// uploaded file.
//
// Circles and comments are copied by the device afterwards
// (store.addDuplicatedPage), from what the owner sees there — unsaved
// changes included — and undoing the duplicate is one step there.
//
// The device may name the copy's id (one per Duplicate dialog). A retry
// after a lost reply then gets the copy the first try made, instead of a
// second one without its circles.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_LABEL_CHARS } from "../shared/constants";
import { copyLabel } from "../shared/labels";
import { comparePages } from "../shared/order";
import type { PageRow } from "../shared/types";
import { tx, type Db } from "./db";
import { cleanName, HttpError, isId, MSG } from "./http";
import { newAssetKey } from "./render/queue";
import { getPage, getPlan, pagesOfPlan } from "./repo";

export interface DuplicateResult {
  page: PageRow;
  /** Every page of the plan, after the copy went in. */
  pages: PageRow[];
  /** The copy waits for a render (the original wasn't ready). */
  queued: boolean;
  /** False when the copy already existed (a retry with the same id). */
  created: boolean;
}

export const COPY_GONE = "That copy was deleted in the meantime. Close this and duplicate the page again.";
export const ID_TAKEN = "That copy can't be made with this id. Close this and duplicate the page again.";

export function duplicatePage(db: Db, dataDir: string, pageId: string, opts: { label?: unknown; id?: unknown } = {}): DuplicateResult {
  const wantedId = isId(opts.id) ? opts.id : null;
  // first: a retry finds its copy even if the original has been deleted since
  const existing = wantedId ? getPage(db, wantedId) : null;
  if (existing) return replay(db, existing, pageId, opts.label);
  const source = livePage(db, pageId);
  const id = wantedId ?? randomUUID();
  const wantedLabel = opts.label;
  const fromDir = path.join(dataDir, "assets", source.id, source.assetKey);
  const ready = source.status === "ready" && fs.existsSync(fromDir);
  const pageDir = path.join(dataDir, "assets", id);

  // The images first: the page row must never point at files that aren't there.
  if (ready) {
    // no page has this id: anything in its folder is left from a try cut off by a crash
    fs.rmSync(pageDir, { recursive: true, force: true });
    try {
      linkTree(fromDir, path.join(pageDir, source.assetKey));
    } catch (e) {
      fs.rmSync(pageDir, { recursive: true, force: true });
      throw e; // a full disk becomes "storage is full" (app.onError)
    }
  }

  try {
    const page = tx(db, () => {
      // again inside the transaction: it may have been deleted meanwhile
      const src = livePage(db, pageId);
      const now = Date.now();
      // in the order the device shows them
      const pages = pagesOfPlan(db, src.planId)
        .filter((p) => p.deletedAt === null)
        .sort(comparePages);
      const label = cleanName(wantedLabel, MAX_LABEL_CHARS) || copyLabel(src.label, pages.map((p) => p.label), MAX_LABEL_CHARS);
      const sortOrder = sortAfter(db, pages, src, now);
      if (ready) {
        db.prepare(
          `INSERT INTO pages (id, plan_id, source_id, source_index, label, sort_order, status, error, width, height, preview_w, preview_h,
                              tile_size, max_level, min_level, tile_format, asset_key, created_at, updated_at, deleted_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
        ).run(
          id,
          src.planId,
          src.sourceId,
          src.sourceIndex,
          label,
          sortOrder,
          src.width,
          src.height,
          src.previewW,
          src.previewH,
          src.tileSize,
          src.maxLevel,
          src.minLevel,
          src.tileFormat,
          source.assetKey,
          now,
          now,
        );
      } else {
        db.prepare(
          `INSERT INTO pages (id, plan_id, source_id, source_index, label, sort_order, status, error, asset_key, created_at, updated_at, deleted_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, NULL, 1)`,
        ).run(id, src.planId, src.sourceId, src.sourceIndex, label, sortOrder, newAssetKey(), now, now);
      }
      db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, src.planId);
      return getPage(db, id) as PageRow;
    });
    return { page, pages: pagesOfPlan(db, page.planId), queued: !ready, created: true };
  } catch (e) {
    fs.rmSync(pageDir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * A page with the id the device chose already exists: the copy an earlier
 * try of this duplicate made (its reply was lost). Hand it back — under the
 * name asked for now, if that changed. A page that isn't a copy of the same
 * sheet isn't ours to return.
 */
function replay(db: Db, existing: PageRow, pageId: string, wantedLabel: unknown): DuplicateResult {
  const src = getPage(db, pageId);
  const sameSheet =
    !!src &&
    existing.id !== src.id &&
    existing.planId === src.planId &&
    existing.sourceId === src.sourceId &&
    existing.sourceIndex === src.sourceIndex;
  if (!sameSheet) throw new HttpError(409, ID_TAKEN);
  const plan = getPlan(db, existing.planId);
  if (existing.deletedAt !== null || !plan || plan.deletedAt !== null) throw new HttpError(409, COPY_GONE);
  const label = cleanName(wantedLabel, MAX_LABEL_CHARS);
  if (label && label !== existing.label) {
    tx(db, () => {
      const now = Date.now();
      db.prepare("UPDATE pages SET label = ?, updated_at = ?, rev = rev + 1 WHERE id = ?").run(label, now, existing.id);
      db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, existing.planId);
    });
  }
  return { page: getPage(db, existing.id) as PageRow, pages: pagesOfPlan(db, existing.planId), queued: false, created: false };
}

/** The page, if it and its plan are live; else 404. */
function livePage(db: Db, pageId: string): PageRow {
  const page = getPage(db, pageId);
  const plan = page && getPlan(db, page.planId);
  if (!page || page.deletedAt !== null || !plan || plan.deletedAt !== null) throw new HttpError(404, MSG.pageNotFound);
  return page;
}

/**
 * A sort order right after `src` among the live pages (between it and the
 * next one). With no room left between them (equal orders, or float
 * precision used up), the live pages are renumbered 0, 1, 2… first.
 */
function sortAfter(db: Db, live: PageRow[], src: PageRow, now: number): number {
  const i = live.findIndex((p) => p.id === src.id);
  const next = live[i + 1];
  if (!next) return src.sortOrder + 1;
  const mid = (src.sortOrder + next.sortOrder) / 2;
  if (mid > src.sortOrder && mid < next.sortOrder) return mid;
  const renumber = db.prepare("UPDATE pages SET sort_order = ?, updated_at = ?, rev = rev + 1 WHERE id = ?");
  live.forEach((p, k) => {
    const order = k <= i ? k : k + 1; // a gap at i + 1 for the copy
    if (p.sortOrder !== order) renumber.run(order, now, p.id);
  });
  return i + 1;
}

/** Recreate the folder `from` at `to` with hard links (a plain copy where the file system can't link). */
function linkTree(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) linkTree(a, b);
    else if (e.isFile()) {
      try {
        fs.linkSync(a, b);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EMLINK") fs.copyFileSync(a, b);
        else throw err;
      }
    }
  }
}
