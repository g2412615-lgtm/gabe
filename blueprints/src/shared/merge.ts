import { EDITABLE, type EntityKind } from "./types";

/**
 * Three-way merge of one row, field by field.
 *
 *   base   – the copy both sides started from (what the client last sent / last saw from the server)
 *   local  – the client's current copy
 *   remote – the server's current copy
 *
 * Editable fields the client changed since `base` keep the local value;
 * every other field (including all server-owned fields such as render status,
 * sizes, num, rev) takes the remote value. With no base (a row the client has
 * never synced) local editable fields win.
 */
export function merge3<T extends object>(kind: EntityKind, base: Partial<T> | null | undefined, local: T, remote: T): T {
  const out: Record<string, unknown> = { ...(remote as Record<string, unknown>) };
  const l = local as Record<string, unknown>;
  const b = base as Record<string, unknown> | null | undefined;
  for (const f of EDITABLE[kind] as readonly string[]) {
    const changedLocally = !b || !sameValue(l[f], b[f]);
    if (changedLocally && f in l) out[f] = l[f];
  }
  return out as T;
}

/** Equality for row field values (numbers, strings, null). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a === b;
}

/** Pick the editable fields of a row (what a SyncOp carries as base/data). */
export function editableOf(kind: EntityKind, row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const r = row as Record<string, unknown>;
  for (const f of EDITABLE[kind] as readonly string[]) out[f] = r[f] ?? null;
  return out;
}

/** True when the editable fields of two rows are identical. */
export function sameEditable(kind: EntityKind, a: object | null | undefined, b: object | null | undefined): boolean {
  if (!a || !b) return a === b;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const f of EDITABLE[kind] as readonly string[]) if (!sameValue(ra[f] ?? null, rb[f] ?? null)) return false;
  return true;
}
