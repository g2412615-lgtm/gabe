// Data shapes shared by the server and the browser. Field names are the JSON
// the API sends and receives (camelCase); the database stores snake_case.
//
// Every row carries `rev` (bumped by the server on each change) and
// `deletedAt` (a tombstone: deleting is a soft delete so it can be undone
// and so another device learns about it). Tombstones are purged after
// 30 days.

export type ID = string;
/** Milliseconds since the epoch. */
export type Millis = number;

/** Kilowatt Events palette. Before the rebrand "gold" was "amber" and "black" was "purple" (see LEGACY_CIRCLE_COLORS). */
export type CircleColor = "gold" | "black" | "red" | "blue" | "green";

/**
 * queued    – waiting for the renderer
 * rendering – being rendered now
 * preview   – the preview image is ready (viewable); deep-zoom tiles still rendering
 * ready     – preview + tiles ready
 * failed    – could not be rendered (`error` says why in plain words)
 */
export type PageStatus = "queued" | "rendering" | "preview" | "ready" | "failed";

export interface PlanRow {
  id: ID;
  name: string;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  rev: number;
}

export interface SourceRow {
  id: ID;
  planId: ID;
  originalName: string;
  kind: "pdf" | "image";
  bytes: number;
  pageCount: number;
  createdAt: Millis;
}

export interface PageRow {
  id: ID;
  planId: ID;
  sourceId: ID;
  /** 0-based page index inside the source file. */
  sourceIndex: number;
  /** The owner's internal name for the page ("A-101 Seating bowl"). */
  label: string;
  /** Pages are shown in ascending sortOrder; a move sets a value between neighbours. */
  sortOrder: number;
  status: PageStatus;
  error: string | null;
  /** Full-resolution raster size in pixels (0 until rendered). This is the "world" coordinate space. */
  width: number;
  height: number;
  /** Preview image size in pixels (≤ 2048 on the long side). */
  previewW: number;
  previewH: number;
  /**
   * Deep-zoom pyramid (DZI layout): level `maxLevel` is full resolution,
   * level k is full / 2^(maxLevel − k). Tiles are `tileSize` px squares
   * (edge tiles smaller), no overlap. 0 / "" until tiles exist.
   */
  tileSize: number;
  maxLevel: number;
  /** Smallest level that exists (the "one tile" level). */
  minLevel: number;
  tileFormat: "png" | "jpeg" | "";
  /** Changes whenever the page is (re-)rendered; part of every asset URL so caches never go stale. */
  assetKey: string;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  rev: number;
}

export interface CircleRow {
  id: ID;
  planId: ID;
  pageId: ID;
  /** Centre, as a fraction of the page width (0..1). */
  x: number;
  /** Centre, as a fraction of the page height (0..1). */
  y: number;
  /** Radius, as a fraction of the page's LONG side (so it survives rotation). */
  r: number;
  color: CircleColor;
  /** Optional short name ("Mag line, Gate A"). */
  title: string;
  /** Per-plan number assigned by the server on first save (0 until then). Never reused. */
  num: number;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  rev: number;
}

export interface CommentRow {
  id: ID;
  planId: ID;
  circleId: ID;
  body: string;
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  rev: number;
}

export type EntityKind = "plan" | "page" | "circle" | "comment";

export interface RowByKind {
  plan: PlanRow;
  page: PageRow;
  circle: CircleRow;
  comment: CommentRow;
}

/**
 * Fields the browser may change through /sync. Everything else is owned by
 * the server (ids, parents, num, render status, sizes, timestamps, rev).
 * `deletedAt` is editable so that delete and undo-delete travel the same way.
 */
export const EDITABLE: { [K in EntityKind]: readonly (keyof RowByKind[K])[] } = {
  plan: ["name", "deletedAt"],
  page: ["label", "sortOrder", "deletedAt"],
  circle: ["x", "y", "r", "color", "title", "deletedAt"],
  comment: ["body", "deletedAt"],
};

/** Fields a create (first save of a client-made circle/comment) must carry. */
export const CREATE_FIELDS = {
  circle: ["pageId", "x", "y", "r", "color", "title", "createdAt"] as const,
  comment: ["circleId", "body", "createdAt"] as const,
};

/**
 * One change sent to POST /api/plans/:id/sync.
 *
 * `data` is the client's current copy of the row's editable fields (plus the
 * CREATE_FIELDS when the row may be new). `base` is the client's last-known
 * server copy of the same fields, or null if the client has never seen the
 * row on the server (a create, or a create whose reply was lost).
 *
 * The server applies only the fields where data[f] !== base[f] (all of them
 * when base is null) — a field-level merge, so a desktop moving a circle and
 * an iPad recolouring it both win. Applying the same op twice is harmless.
 */
export interface SyncOp {
  kind: EntityKind;
  id: ID;
  base: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

export interface SyncRequest {
  ops: SyncOp[];
}

export interface PlanRows {
  plans: PlanRow[];
  pages: PageRow[];
  circles: CircleRow[];
  comments: CommentRow[];
}

export interface SyncResponse {
  /** The current server copy of every row an op touched (accepted or not). */
  rows: PlanRows;
  /** Ops the server could not apply, with a plain-language reason. Their rows (if they exist) are still in `rows`. */
  rejected: { kind: EntityKind; id: ID; reason: string }[];
  serverTime: Millis;
}

/** GET /api/plans/:id — everything in one plan, tombstones included. */
export interface PlanDoc extends PlanRows {
  plan: PlanRow;
  serverTime: Millis;
}

/** One row of the home-page list (GET /api/plans). Deleted plans are left out. */
export interface PlanSummary {
  id: ID;
  name: string;
  createdAt: Millis;
  updatedAt: Millis;
  pageCount: number;
  circleCount: number;
  commentCount: number;
  /** Pages still queued/rendering/preview. */
  pendingPages: number;
  /** The first page (by sortOrder), for the thumbnail. */
  firstPage: Pick<PageRow, "id" | "assetKey" | "status" | "previewW" | "previewH"> | null;
}

/** POST /api/plans/upload and POST /api/plans/:id/files reply. */
export interface UploadResponse {
  plan: PlanRow;
  source: SourceRow;
  pages: PageRow[];
}

/** POST /api/pages/:id/duplicate → 201. */
export interface DuplicatePageResponse {
  /** The new page. */
  page: PageRow;
  /** Every page of the plan (a few may have been renumbered to make room). */
  pages: PageRow[];
}

export interface ApiError {
  error: string;
}
