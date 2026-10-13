// The device outbox: every row changed on this device that the server hasn't
// confirmed yet, kept in localStorage so nothing is lost when iPad Safari
// kills the tab, the battery dies or the session expires.
//
//   key   bpn-outbox:<planId>
//   value { v: 1, entries: { "<kind>:<id>": { local, base, sent? } } }
//
// `local` is the whole row as the device has it, `base` the editable fields
// of the last server copy it saw (null for a row the server may not have).
// `sent` (an addition) marks a create that may have reached the server even
// though no reply came back — such a row must not be quietly dropped.
//
// Every storage access may throw (private mode, a full quota, blocked
// storage): the editor works without it, it just can't survive a reload.

import { DEFAULT_CIRCLE_COLOR, MAX_CIRCLE_R, MIN_CIRCLE_R } from "../../shared/constants";
import type { CircleRow, CommentRow, EntityKind, PageRow, PlanRow, RowByKind } from "../../shared/types";
import { clamp, isColor, isFiniteNumber } from "./clean";
import type { StorageLike } from "./types";

export const OUTBOX_VERSION = 1;
export const outboxKey = (planId: string) => `bpn-outbox:${planId}`;

export type AnyRow = RowByKind[EntityKind];

export interface OutboxEntry {
  kind: EntityKind;
  id: string;
  local: AnyRow;
  base: Record<string, unknown> | null;
  sent: boolean;
}

const KINDS: readonly EntityKind[] = ["plan", "page", "circle", "comment"];

export function parseKey(key: string): { kind: EntityKind; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i) as EntityKind;
  const id = key.slice(i + 1);
  if (!KINDS.includes(kind) || !id) return null;
  return { kind, id };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0) => (isFiniteNumber(v) ? v : d);
const tomb = (v: unknown) => (isFiniteNumber(v) ? v : null);

/**
 * Rebuild a stored row with every field present and typed, or null when it
 * can't be trusted (written by another version of the app, or tampered with).
 */
export function normalizeRow(kind: EntityKind, id: string, planId: string, raw: unknown): AnyRow | null {
  if (!isObj(raw) || raw.id !== id) return null;
  const common = { id, planId, createdAt: num(raw.createdAt, 0), updatedAt: num(raw.updatedAt, 0), deletedAt: tomb(raw.deletedAt), rev: num(raw.rev, 0) };
  switch (kind) {
    case "plan": {
      const row: PlanRow = { id, name: str(raw.name), createdAt: common.createdAt, updatedAt: common.updatedAt, deletedAt: common.deletedAt, rev: common.rev };
      return row;
    }
    case "page": {
      if (typeof raw.sourceId !== "string") return null;
      const row: PageRow = {
        ...common,
        sourceId: raw.sourceId,
        sourceIndex: num(raw.sourceIndex),
        label: str(raw.label),
        sortOrder: num(raw.sortOrder),
        status: (["queued", "rendering", "preview", "ready", "failed"] as const).find((s) => s === raw.status) ?? "queued",
        error: typeof raw.error === "string" ? raw.error : null,
        width: num(raw.width),
        height: num(raw.height),
        previewW: num(raw.previewW),
        previewH: num(raw.previewH),
        tileSize: num(raw.tileSize),
        maxLevel: num(raw.maxLevel),
        minLevel: num(raw.minLevel),
        tileFormat: raw.tileFormat === "png" || raw.tileFormat === "jpeg" ? raw.tileFormat : "",
        assetKey: str(raw.assetKey),
      };
      return row;
    }
    case "circle": {
      if (typeof raw.pageId !== "string" || !raw.pageId) return null;
      if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.r)) return null;
      const row: CircleRow = {
        ...common,
        pageId: raw.pageId,
        x: clamp(raw.x, 0, 1),
        y: clamp(raw.y, 0, 1),
        r: clamp(raw.r, MIN_CIRCLE_R, MAX_CIRCLE_R),
        color: isColor(raw.color) ? raw.color : DEFAULT_CIRCLE_COLOR,
        title: str(raw.title),
        num: num(raw.num),
      };
      return row;
    }
    case "comment": {
      if (typeof raw.circleId !== "string" || !raw.circleId) return null;
      const row: CommentRow = { ...common, circleId: raw.circleId, body: str(raw.body) };
      return row;
    }
  }
}

export function readOutbox(storage: StorageLike | null, planId: string): OutboxEntry[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(outboxKey(planId));
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObj(parsed) || parsed.v !== OUTBOX_VERSION || !isObj(parsed.entries)) return [];
  const out: OutboxEntry[] = [];
  for (const [key, e] of Object.entries(parsed.entries)) {
    const k = parseKey(key);
    if (!k || !isObj(e)) continue;
    const local = normalizeRow(k.kind, k.id, planId, e.local);
    if (!local) continue;
    const base = isObj(e.base) ? e.base : null;
    out.push({ kind: k.kind, id: k.id, local, base, sent: e.sent === true });
  }
  return out;
}

/** Write the outbox (or remove it when empty). Returns false when storage refused. */
export function writeOutbox(storage: StorageLike | null, planId: string, entries: readonly OutboxEntry[]): boolean {
  if (!storage) return false;
  try {
    if (!entries.length) {
      storage.removeItem(outboxKey(planId));
      return true;
    }
    const obj: Record<string, { local: AnyRow; base: Record<string, unknown> | null; sent?: true }> = {};
    for (const e of entries) obj[`${e.kind}:${e.id}`] = e.sent ? { local: e.local, base: e.base, sent: true } : { local: e.local, base: e.base };
    storage.setItem(outboxKey(planId), JSON.stringify({ v: OUTBOX_VERSION, entries: obj }));
    return true;
  } catch {
    return false;
  }
}

/** True when an outbox with at least one entry is stored for this plan. */
export function hasOutbox(storage: StorageLike | null, planId: string): boolean {
  return readOutbox(storage, planId).length > 0;
}
