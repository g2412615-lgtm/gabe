// The device outbox: every row changed on this device that the server hasn't
// confirmed yet, kept in localStorage so nothing is lost when iPad Safari
// kills the tab, the battery dies or the session expires.
//
//   key   bpn-outbox:<planId>
//   value { v: 2, name, entries: { "<kind>:<id>": { local, base, sent? } } }
//
// `local` is the whole row as the device has it, `base` the editable fields
// of the last server copy it saw (null for a row the server may not have).
// `sent` holds the editable fields as they went out in a request that got no
// answer: the server may already have them (the reply was lost, or the tab
// was closed before it came back). Restoring needs to know, or it would
// replay a change that already landed over a newer one from the other device
// (or bring back a circle deleted there). `name` is the plan's name, for
// messages shown outside the editor.
//
// Several stores can share one key (two tabs, or an editor that was just
// closed and one just opened), so a store never rewrites the whole outbox:
// it reads what's there, sets its own pending rows and removes only entries
// it wrote itself that nobody has rewritten since (see store.ts).
//
// v1 (before `sent` existed) is still read; every v1 entry counts as sent,
// since there's no telling whether it was.
//
// Every storage access may throw (private mode, a full quota, blocked
// storage): the editor works without it, it just can't survive a reload.

import { DEFAULT_CIRCLE_COLOR, LEGEND_FIELD, MAX_CIRCLE_R, MIN_CIRCLE_R } from "../../shared/constants";
import { editableOf, sameValue } from "../../shared/merge";
import { EDITABLE, type CircleRow, type CommentRow, type EntityKind, type PageRow, type PlanRow, type RowByKind } from "../../shared/types";
import { clamp, isColor, isFiniteNumber, toColor } from "./clean";
import type { StorageLike } from "./types";

export const OUTBOX_VERSION = 2;
export const OUTBOX_PREFIX = "bpn-outbox:";
export const outboxKey = (planId: string) => `${OUTBOX_PREFIX}${planId}`;

export type AnyRow = RowByKind[EntityKind];

export interface OutboxEntry {
  kind: EntityKind;
  id: string;
  local: AnyRow;
  base: Record<string, unknown> | null;
  /** Editable fields as last sent in a request that got no answer (they may be on the server); null when these values never left the device. */
  sent: Record<string, unknown> | null;
}

/** What's stored for one plan: each entry with its exact stored text, which tells whether anyone has rewritten it since. */
export interface StoredOutbox {
  entries: Map<string, { entry: OutboxEntry; json: string }>;
  name: string | null;
}

/** localStorage, as far as listing keys goes. */
export interface ListableStorage extends StorageLike {
  readonly length: number;
  key(index: number): string | null;
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
      const row = { id, name: str(raw.name), createdAt: common.createdAt, updatedAt: common.updatedAt, deletedAt: common.deletedAt, rev: common.rev } as PlanRow;
      // Colour labels only when the entry has them: an entry written before
      // they existed must not blank the plan's labels (restoreRow leaves
      // fields the entry doesn't have to the server).
      for (const f of Object.values(LEGEND_FIELD)) if (typeof raw[f] === "string") (row as unknown as Record<string, unknown>)[f] = raw[f];
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
        color: toColor(raw.color) ?? DEFAULT_CIRCLE_COLOR, // "amber"/"purple" from before the rebrand → gold/black
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

/**
 * Stored editable fields with a pre-rebrand colour name ("amber", "purple")
 * read as today's (gold, black), as the server renamed its rows: an outbox
 * left by the previous version must compare with them, not against them.
 */
function currentColor(fields: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!fields || isColor(fields.color)) return fields;
  const c = toColor(fields.color);
  return c ? { ...fields, color: c } : fields;
}

/** Parse an outbox's stored text (anything unreadable counts as empty). */
export function parseStored(planId: string, text: string | null): StoredOutbox {
  const out: StoredOutbox = { entries: new Map(), name: null };
  if (!text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObj(parsed) || (parsed.v !== 1 && parsed.v !== OUTBOX_VERSION) || !isObj(parsed.entries)) return out;
  const v1 = parsed.v === 1;
  out.name = typeof parsed.name === "string" ? parsed.name : null;
  for (const [key, e] of Object.entries(parsed.entries)) {
    const k = parseKey(key);
    if (!k || !isObj(e)) continue;
    const local = normalizeRow(k.kind, k.id, planId, e.local);
    if (!local) continue;
    const base = currentColor(isObj(e.base) ? e.base : null);
    const sent = v1 ? editableOf(k.kind, local) : currentColor(isObj(e.sent) ? e.sent : null);
    const entry: OutboxEntry = { kind: k.kind, id: k.id, local, base, sent };
    // v2: the text exactly as written (a store compares it with what it wrote); v1: converted
    out.entries.set(key, { entry, json: v1 ? entryJson(entry) : JSON.stringify(e) });
  }
  return out;
}

/** The outbox's stored text, or null (none, or storage refused). */
export function readStoredText(storage: StorageLike | null, planId: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(outboxKey(planId));
  } catch {
    return null;
  }
}

export function readStored(storage: StorageLike | null, planId: string): StoredOutbox {
  return parseStored(planId, readStoredText(storage, planId));
}

export function readOutbox(storage: StorageLike | null, planId: string): OutboxEntry[] {
  return [...readStored(storage, planId).entries.values()].map((x) => x.entry);
}

/** One entry as stored. */
export function entryJson(e: Pick<OutboxEntry, "local" | "base" | "sent">): string {
  return JSON.stringify(e.sent ? { local: e.local, base: e.base, sent: e.sent } : { local: e.local, base: e.base });
}

/**
 * Write the outbox from entry texts (or remove it when empty). Returns the
 * text written ("" when removed), or null when storage refused.
 */
export function writeStored(storage: StorageLike | null, planId: string, entries: ReadonlyMap<string, string>, name: string | null): string | null {
  if (!storage) return null;
  try {
    if (!entries.size) {
      storage.removeItem(outboxKey(planId));
      return "";
    }
    const parts: string[] = [];
    for (const [key, json] of entries) parts.push(`${JSON.stringify(key)}:${json}`);
    const text = `{"v":${OUTBOX_VERSION},"name":${JSON.stringify(name)},"entries":{${parts.join(",")}}}`;
    storage.setItem(outboxKey(planId), text);
    return text;
  } catch {
    return null;
  }
}

/** Replace the whole outbox with these entries (tests, tools). Returns false when storage refused. */
export function writeOutbox(storage: StorageLike | null, planId: string, entries: readonly OutboxEntry[], name: string | null = null): boolean {
  return writeStored(storage, planId, new Map(entries.map((e) => [`${e.kind}:${e.id}`, entryJson(e)])), name) !== null;
}

/** True when an outbox with at least one entry is stored for this plan. */
export function hasOutbox(storage: StorageLike | null, planId: string): boolean {
  return readStored(storage, planId).entries.size > 0;
}

/** The plans with an outbox stored on this device. */
export function listOutboxPlans(storage: ListableStorage | null): string[] {
  if (!storage) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(OUTBOX_PREFIX) && key.length > OUTBOX_PREFIX.length) out.push(key.slice(OUTBOX_PREFIX.length));
    }
  } catch {
    /* storage refused: nothing to list */
  }
  return out;
}

/**
 * Put an outbox entry back on top of the server's current copy of its row
 * (the plan is being opened again). For each editable field this device
 * changed (local differs from base; every field when there's no base):
 *
 *  - a value that never left the device is an unsent change: it wins, the
 *    same as any pending edit does when it's saved;
 *  - a value that went out in a request with no answer may be on the server
 *    already, and the other device may have changed it since. It goes back
 *    only when the server still has the base value (so it surely never
 *    landed); otherwise the server's copy stands — it has this value, or a
 *    newer one. For a create (no base), that means a row that reached the
 *    server is taken as the server has it now (deleted there → stays deleted).
 */
export function restoreRow<T extends AnyRow>(kind: EntityKind, e: Pick<OutboxEntry, "local" | "base" | "sent">, server: T): T {
  const out: Record<string, unknown> = { ...(server as unknown as Record<string, unknown>) };
  const l = e.local as unknown as Record<string, unknown>;
  for (const f of EDITABLE[kind] as readonly string[]) {
    if (!(f in l)) continue;
    // A field the entry's base doesn't have: the entry was written by an
    // older version of the app, which couldn't edit it (its row may still
    // carry a stale copy it was sent) — the server's value stands. Entries
    // written now always have every editable field in their base.
    if (e.base && !(f in e.base)) continue;
    const v = l[f];
    if (sameValue(v, out[f])) continue;
    if (e.base && sameValue(v, e.base[f] ?? null)) continue; // not changed here: the server's value stands
    const wentOut = e.sent !== null && sameValue(v, e.sent[f] ?? null);
    if (wentOut && !(e.base && sameValue(out[f], e.base[f] ?? null))) continue;
    out[f] = v;
  }
  return out as unknown as T;
}
