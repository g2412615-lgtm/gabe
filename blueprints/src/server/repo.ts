// Row reading: database rows (snake_case) → API rows (camelCase, see
// src/shared/types.ts), plus the read queries the routes share.

import type { CircleColor, CircleRow, CommentRow, PageRow, PageStatus, PlanRow, PlanSummary, SourceRow } from "../shared/types";
import type { Db } from "./db";

type Raw = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const nullableNum = (v: unknown): number | null => (v == null ? null : num(v));

export function toPlan(r: Raw): PlanRow {
  return {
    id: str(r.id),
    name: str(r.name),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: nullableNum(r.deleted_at),
    rev: num(r.rev),
  };
}

export function toSource(r: Raw): SourceRow {
  return {
    id: str(r.id),
    planId: str(r.plan_id),
    originalName: str(r.original_name),
    kind: r.kind === "image" ? "image" : "pdf",
    bytes: num(r.bytes),
    pageCount: num(r.page_count),
    createdAt: num(r.created_at),
  };
}

export function toPage(r: Raw): PageRow {
  const fmt = str(r.tile_format);
  return {
    id: str(r.id),
    planId: str(r.plan_id),
    sourceId: str(r.source_id),
    sourceIndex: num(r.source_index),
    label: str(r.label),
    sortOrder: num(r.sort_order),
    status: str(r.status) as PageStatus,
    error: r.error == null ? null : str(r.error),
    width: num(r.width),
    height: num(r.height),
    previewW: num(r.preview_w),
    previewH: num(r.preview_h),
    tileSize: num(r.tile_size),
    maxLevel: num(r.max_level),
    minLevel: num(r.min_level),
    tileFormat: fmt === "png" || fmt === "jpeg" ? fmt : "",
    assetKey: str(r.asset_key),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: nullableNum(r.deleted_at),
    rev: num(r.rev),
  };
}

export function toCircle(r: Raw): CircleRow {
  return {
    id: str(r.id),
    planId: str(r.plan_id),
    pageId: str(r.page_id),
    x: num(r.x),
    y: num(r.y),
    r: num(r.r),
    color: str(r.color) as CircleColor,
    title: str(r.title),
    num: num(r.num),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: nullableNum(r.deleted_at),
    rev: num(r.rev),
  };
}

export function toComment(r: Raw): CommentRow {
  return {
    id: str(r.id),
    planId: str(r.plan_id),
    circleId: str(r.circle_id),
    body: str(r.body),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    deletedAt: nullableNum(r.deleted_at),
    rev: num(r.rev),
  };
}

// ── queries ─────────────────────────────────────────────────────────────

export function getPlan(db: Db, id: string): PlanRow | null {
  const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Raw | undefined;
  return r ? toPlan(r) : null;
}

export function getPage(db: Db, id: string): PageRow | null {
  const r = db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as Raw | undefined;
  return r ? toPage(r) : null;
}

export function getSource(db: Db, id: string): (SourceRow & { ext: string }) | null {
  const r = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Raw | undefined;
  return r ? { ...toSource(r), ext: str(r.ext) } : null;
}

export function pagesOfPlan(db: Db, planId: string): PageRow[] {
  return (db.prepare("SELECT * FROM pages WHERE plan_id = ? ORDER BY sort_order, created_at, id").all(planId) as Raw[]).map(toPage);
}

export function circlesOfPlan(db: Db, planId: string): CircleRow[] {
  return (db.prepare("SELECT * FROM circles WHERE plan_id = ? ORDER BY num, created_at, id").all(planId) as Raw[]).map(toCircle);
}

export function commentsOfPlan(db: Db, planId: string): CommentRow[] {
  return (db.prepare("SELECT * FROM comments WHERE plan_id = ? ORDER BY created_at, id").all(planId) as Raw[]).map(toComment);
}

/**
 * The home list: live plans, most recently edited first. Counts follow the
 * visibility cascade — a circle on a deleted page and a comment on a deleted
 * circle (or on a circle of a deleted page) don't count.
 */
export function planSummaries(db: Db): PlanSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM pages g WHERE g.plan_id = p.id AND g.deleted_at IS NULL) AS page_count,
        (SELECT COUNT(*) FROM circles c JOIN pages g ON g.id = c.page_id
           WHERE c.plan_id = p.id AND c.deleted_at IS NULL AND g.deleted_at IS NULL) AS circle_count,
        (SELECT COUNT(*) FROM comments m JOIN circles c ON c.id = m.circle_id JOIN pages g ON g.id = c.page_id
           WHERE m.plan_id = p.id AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND g.deleted_at IS NULL) AS comment_count,
        (SELECT COUNT(*) FROM pages g WHERE g.plan_id = p.id AND g.deleted_at IS NULL
           AND g.status IN ('queued', 'rendering', 'preview')) AS pending_pages
       FROM plans p
       WHERE p.deleted_at IS NULL
       ORDER BY p.updated_at DESC, p.created_at DESC, p.id`,
    )
    .all() as Raw[];
  const firstPage = db.prepare(
    `SELECT id, asset_key, status, preview_w, preview_h FROM pages
     WHERE plan_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id LIMIT 1`,
  );
  return rows.map((r) => {
    const fp = firstPage.get(str(r.id)) as Raw | undefined;
    return {
      id: str(r.id),
      name: str(r.name),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      pageCount: num(r.page_count),
      circleCount: num(r.circle_count),
      commentCount: num(r.comment_count),
      pendingPages: num(r.pending_pages),
      firstPage: fp
        ? {
            id: str(fp.id),
            assetKey: str(fp.asset_key),
            status: str(fp.status) as PageStatus,
            previewW: num(fp.preview_w),
            previewH: num(fp.preview_h),
          }
        : null,
    };
  });
}
