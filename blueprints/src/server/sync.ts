// POST /api/plans/:id/sync — applies a batch of field-level changes in one
// transaction (SPEC §4). The rules that keep two devices from clobbering
// each other and make replays harmless:
//
//  - a field is applied only when the client changed it (data[f] !== base[f],
//    or there is no base), so a desktop moving a circle and an iPad
//    recolouring it both win;
//  - values are cleaned, never rejected (clamped, capped, unknown colour →
//    keep the current one; a pre-rebrand colour name → its new colour), so
//    one odd value can't block the whole batch;
//  - a field whose cleaned value equals the stored one is not a change: no
//    rev bump, no updatedAt — replaying a batch changes nothing.

import { circleColorOf, DEFAULT_CIRCLE_COLOR, MAX_CIRCLE_R, MAX_COMMENT_CHARS, MAX_LABEL_CHARS, MAX_PLAN_NAME_CHARS, MAX_TITLE_CHARS, MIN_CIRCLE_R } from "../shared/constants";
import { cleanLegend } from "../shared/labels";
import { sameValue } from "../shared/merge";
import { EDITABLE, type EntityKind, type ID, type PlanRows, type SyncResponse } from "../shared/types";
import { tx, type Db } from "./db";
import { cleanName, cleanText, isId, isRecord } from "./http";
import { toCircle, toComment, toPage, toPlan } from "./repo";

export const MAX_SYNC_OPS = 2000;
export const MAX_SYNC_BYTES = 2 * 1024 * 1024;

const KIND_ORDER: readonly EntityKind[] = ["plan", "page", "circle", "comment"];
const TABLE: Record<EntityKind, string> = { plan: "plans", page: "pages", circle: "circles", comment: "comments" };
/** API field → column, for every editable field. */
const COLUMN: Record<string, string> = {
  name: "name",
  label: "label",
  sortOrder: "sort_order",
  x: "x",
  y: "y",
  r: "r",
  color: "color",
  title: "title",
  body: "body",
  legendGold: "legend_gold",
  legendBlack: "legend_black",
  legendRed: "legend_red",
  legendBlue: "legend_blue",
  legendGreen: "legend_green",
  deletedAt: "deleted_at",
};
const TO_ROW = { plan: toPlan, page: toPage, circle: toCircle, comment: toComment } as const;

const REASON = {
  malformed: "That change wasn't understood, so it wasn't saved.",
  otherPlan: "That change belongs to a different event plan, so it wasn't saved.",
  noPlan: "That event plan no longer exists.",
  noPage: "That page no longer exists, so the change wasn't saved.",
  circleNoPage: "That circle's page no longer exists, so the circle wasn't saved.",
  circleBadNumbers: "That circle's position or size wasn't a number, so it wasn't saved.",
  commentNoCircle: "That comment's circle no longer exists, so the comment wasn't saved.",
} as const;

const DAY = 86_400_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The client's createdAt when believable (last 30 days, at most a day ahead), else the server's now. */
function createdAtFrom(v: unknown, now: number): number {
  return isFiniteNumber(v) && v >= now - 30 * DAY && v <= now + DAY ? Math.round(v) : now;
}

/**
 * The value to store for one editable field, or `undefined` to leave the
 * field alone. `current` is the stored value (for deletedAt: an existing
 * tombstone keeps its original time, so a replayed delete is not a change).
 */
function cleanField(field: string, v: unknown, current: unknown, now: number): unknown {
  switch (field) {
    case "deletedAt":
      if (v === null) return null;
      if (isFiniteNumber(v)) return current ?? now; // the server's clock decides when
      return undefined;
    case "x":
    case "y":
      return isFiniteNumber(v) ? clamp(v, 0, 1) : undefined;
    case "r":
      return isFiniteNumber(v) ? clamp(v, MIN_CIRCLE_R, MAX_CIRCLE_R) : undefined;
    case "color":
      return circleColorOf(v); // "amber"/"purple" from an old device → "gold"/"black"; unknown → left alone
    case "sortOrder":
      return isFiniteNumber(v) ? v : undefined;
    case "title":
      return cleanText(v, MAX_TITLE_CHARS) ?? undefined;
    case "body":
      return cleanText(v, MAX_COMMENT_CHARS) ?? undefined;
    case "label":
      return cleanName(v, MAX_LABEL_CHARS) || undefined; // an empty label keeps the old one
    case "name":
      return cleanName(v, MAX_PLAN_NAME_CHARS) || undefined;
    case "legendGold":
    case "legendBlack":
    case "legendRed":
    case "legendBlue":
    case "legendGreen":
      return cleanLegend(v) ?? undefined; // "" is a label too: not assigned
    default:
      return undefined;
  }
}

interface ParsedOp {
  kind: EntityKind;
  id: ID;
  base: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

export function applySync(db: Db, planId: string, rawOps: unknown[], now = Date.now()): SyncResponse {
  const rejected: SyncResponse["rejected"] = [];
  const reject = (kind: EntityKind, id: string, reason: string) => rejected.push({ kind, id, reason });

  // Shape check first; anything malformed is reported and skipped.
  const ops: ParsedOp[] = [];
  for (const raw of rawOps) {
    if (!isRecord(raw) || !KIND_ORDER.includes(raw.kind as EntityKind)) continue; // nothing to report it against
    const kind = raw.kind as EntityKind;
    if (!isId(raw.id)) {
      reject(kind, typeof raw.id === "string" ? raw.id.slice(0, 64) : "", REASON.malformed);
      continue;
    }
    const base = raw.base === null || raw.base === undefined ? null : isRecord(raw.base) ? raw.base : undefined;
    if (!isRecord(raw.data) || base === undefined) {
      ops.push({ kind, id: raw.id, base: null, data: {} });
      reject(kind, raw.id, REASON.malformed);
      continue;
    }
    ops.push({ kind, id: raw.id, base, data: raw.data });
  }
  // Plans, then pages, circles, comments: a comment may follow its brand-new circle in the same batch.
  const ordered = KIND_ORDER.flatMap((k) => ops.filter((o) => o.kind === k));
  const malformed = new Set(rejected.map((r) => `${r.kind}:${r.id}`));

  return tx(db, () => {
    /** Rows of this plan that some op referenced; returned so the client can adopt the server copy. */
    const referenced = new Map<string, { kind: EntityKind; id: string }>();
    let changedAny = false;

    for (const op of ordered) {
      const key = `${op.kind}:${op.id}`;
      const table = TABLE[op.kind];
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(op.id) as Record<string, unknown> | undefined;
      const rowPlan = row ? (op.kind === "plan" ? row.id : row.plan_id) : null;

      if (row && rowPlan !== planId) {
        // never echo another plan's row back
        if (!malformed.has(key)) reject(op.kind, op.id, REASON.otherPlan);
        continue;
      }
      if (row) referenced.set(key, { kind: op.kind, id: op.id });
      if (malformed.has(key)) continue;

      if (!row) {
        if (op.kind === "plan") reject(op.kind, op.id, op.id === planId ? REASON.noPlan : REASON.otherPlan);
        else if (op.kind === "page") reject(op.kind, op.id, REASON.noPage);
        else {
          const reason = op.kind === "circle" ? createCircle(db, planId, op, now) : createComment(db, planId, op, now);
          if (reason) reject(op.kind, op.id, reason);
          else {
            changedAny = true;
            referenced.set(key, { kind: op.kind, id: op.id });
          }
        }
        continue;
      }

      // Existing row: field-level merge.
      const current = TO_ROW[op.kind](row) as unknown as Record<string, unknown>;
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const f of EDITABLE[op.kind] as readonly string[]) {
        if (!(f in op.data)) continue;
        if (op.base && sameValue(op.data[f], op.base[f])) continue; // the client didn't change it
        const value = cleanField(f, op.data[f], current[f], now);
        if (value === undefined || sameValue(value, current[f])) continue;
        sets.push(`${COLUMN[f]} = ?`);
        values.push(value as string | number | null);
      }
      if (sets.length) {
        db.prepare(`UPDATE ${table} SET ${sets.join(", ")}, rev = rev + 1, updated_at = ? WHERE id = ?`).run(...values, now, op.id);
        changedAny = true;
      }
    }

    // The home list sorts by the plan's updatedAt: any edit inside counts.
    if (changedAny) db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, planId);

    const rows: PlanRows = { plans: [], pages: [], circles: [], comments: [] };
    for (const { kind, id } of referenced.values()) {
      const r = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!r) continue;
      if (kind === "plan") rows.plans.push(toPlan(r));
      else if (kind === "page") rows.pages.push(toPage(r));
      else if (kind === "circle") rows.circles.push(toCircle(r));
      else rows.comments.push(toComment(r));
    }
    return { rows, rejected, serverTime: now };
  });
}

/** First save of a circle made on a device. Returns a rejection reason, or null when inserted. */
function createCircle(db: Db, planId: string, op: ParsedOp, now: number): string | null {
  const d = op.data;
  if (!isId(d.pageId)) return REASON.circleNoPage;
  const page = db.prepare("SELECT plan_id FROM pages WHERE id = ?").get(d.pageId) as { plan_id: string } | undefined;
  if (!page) return REASON.circleNoPage;
  if (page.plan_id !== planId) return REASON.otherPlan; // deleted pages are fine: undo brings them back
  if (!isFiniteNumber(d.x) || !isFiniteNumber(d.y) || !isFiniteNumber(d.r)) return REASON.circleBadNumbers;

  // Numbers count up per plan and are never reused (circle_seq survives purges).
  const seq = db
    .prepare("SELECT MAX(p.circle_seq, IFNULL((SELECT MAX(num) FROM circles WHERE plan_id = p.id), 0)) AS n FROM plans p WHERE p.id = ?")
    .get(planId) as { n: number };
  const num = Number(seq.n) + 1;
  db.prepare("UPDATE plans SET circle_seq = ? WHERE id = ?").run(num, planId);

  db.prepare(
    `INSERT INTO circles (id, plan_id, page_id, x, y, r, color, title, num, created_at, updated_at, deleted_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    op.id,
    planId,
    d.pageId,
    clamp(d.x, 0, 1),
    clamp(d.y, 0, 1),
    clamp(d.r, MIN_CIRCLE_R, MAX_CIRCLE_R),
    circleColorOf(d.color) ?? DEFAULT_CIRCLE_COLOR,
    cleanText(d.title, MAX_TITLE_CHARS) ?? "",
    num,
    createdAtFrom(d.createdAt, now),
    now,
    isFiniteNumber(d.deletedAt) ? now : null, // made and deleted before it ever reached the server
  );
  return null;
}

/** First save of a comment made on a device. */
function createComment(db: Db, planId: string, op: ParsedOp, now: number): string | null {
  const d = op.data;
  if (!isId(d.circleId)) return REASON.commentNoCircle;
  const circle = db.prepare("SELECT plan_id FROM circles WHERE id = ?").get(d.circleId) as { plan_id: string } | undefined;
  if (!circle) return REASON.commentNoCircle;
  if (circle.plan_id !== planId) return REASON.otherPlan;
  db.prepare(
    `INSERT INTO comments (id, plan_id, circle_id, body, created_at, updated_at, deleted_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(op.id, planId, d.circleId, cleanText(d.body, MAX_COMMENT_CHARS) ?? "", createdAtFrom(d.createdAt, now), now, isFiniteNumber(d.deletedAt) ? now : null);
  return null;
}
