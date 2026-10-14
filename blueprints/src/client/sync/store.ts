// The plan store: the editor's single source of truth for one open plan, and
// the engine that autosaves it (SPEC §4, §7.4).
//
// The model, in short:
//
//   doc     – every row as this device has it (tombstones included)
//   synced  – the last server copy of each row this device has seen
//
// A row is *pending* when its editable fields differ from `synced` (or it has
// never been confirmed). Saving is diffing: each flush sends one op per
// pending row with `data` = the device's fields and `base` = the server copy
// they were made against, so rapid edits coalesce on their own and the server
// applies only the fields this device actually changed (two devices editing
// different fields of one circle both win).
//
// Rules that keep the owner's work safe:
//
//  - Every local change is written to the device outbox (localStorage)
//    before anything else happens; the outbox is only trimmed once the
//    server has confirmed a row — also when the reply lands after the editor
//    was closed. Before a request goes out, its rows are marked as sent, so
//    the next visit can tell a change that may already be on the server
//    (never replayed over a newer one) from one that never left the device.
//  - The outbox is shared (two tabs, an editor just closed and one just
//    opened): a store only rewrites its own pending rows and removes only
//    entries it wrote that nobody has rewritten since.
//  - One request at a time. A reply is merged field by field against what
//    was *sent* (merge3(sent, docNow, server)), so edits made while the
//    request was out survive and server-assigned values (num, cleaned text)
//    arrive.
//  - Server rows are adopted only when they are at least as new (rev) as the
//    copy already seen, so a slow, stale reply can never roll a row back.
//  - Ops are idempotent and creates carry everything needed to insert the
//    row, so replaying a batch whose reply was lost is harmless.
//  - Network trouble keeps everything and retries with backoff; a 401 keeps
//    everything and resumes once the session is back; nothing is dropped
//    except a change the server explicitly refused (and the owner is told).

import { DEFAULT_CIRCLE_COLOR, MAX_CIRCLE_R, MAX_COMMENT_CHARS, MAX_TITLE_CHARS, MIN_CIRCLE_R } from "../../shared/constants";
import { editableOf, merge3, sameEditable, sameValue } from "../../shared/merge";
import {
  CREATE_FIELDS,
  type CircleRow,
  type CommentRow,
  type EntityKind,
  type ID,
  type PageRow,
  type PlanDoc,
  type PlanRow,
  type SyncOp,
  type SyncResponse,
} from "../../shared/types";
import { newId as defaultNewId } from "../api";
import { notify as defaultNotify } from "../ui/notify";
import { clamp, cleanPatch, cleanText, isColor, isFiniteNumber, utf8Length } from "./clean";
import { createDeriver } from "./derive";
import { apiTransport, browserEnv, browserStorage, globalTimers } from "./env";
import { History, type RowChange, type Step } from "./history";
import { entryJson, parseKey, parseStored, readStoredText, restoreRow, writeStored, type AnyRow } from "./outbox";
import type { CirclePatch, PastedCircle, PlanState, PlanStore, PlanStoreOptions, SaveInfo, SaveState } from "./types";

export type { CircleCopy, CirclePatch, PastedCircle, PlanState, PlanStore, PlanStoreOptions, SaveInfo, SaveState, StorageLike, SyncEnv, SyncTransport, Timers } from "./types";

// ── tuning (SPEC §7.4) ──────────────────────────────────────────────────────

export const DEBOUNCE_MS = 500;
export const MAX_WAIT_MS = 2500;
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000] as const;
/** After a refusal we can't explain (other 4xx), try again now and then; tapping the pill retries at once. */
export const ERROR_RETRY_MS = 60_000;
export const ME_POLL_MS = 10_000;
export const PULL_EVERY_MS = 30_000;
export const LOAD_RETRY_MS = 5_000;
export const MAX_OPS_PER_REQUEST = 500;
/**
 * A request's body stays under this, well clear of the server's 2 MB limit
 * (MAX_SYNC_BYTES, answered with 413): 500 long comments (a copy of many
 * noted circles onto many pages) would be more than that.
 */
export const MAX_REQUEST_BYTES = 1_500_000;
/**
 * A gesture with no live update for this long is ended for the caller. A
 * lost pointer event must not hold a circle's changes back from saving.
 */
export const GESTURE_IDLE_MS = 15_000;
/** keepalive request bodies are capped near 64 KB by browsers. */
export const KEEPALIVE_MAX_BYTES = 60_000;
/** Radius for a new circle given a nonsense radius (fraction of the page's long side). */
const FALLBACK_R = 0.02;

export const MSG = {
  offlineLoad: "You're offline — this plan will open when the connection is back.",
  serverDownLoad: "The server isn't answering right now — this plan will open as soon as it's back.",
  signedOutLoad: "You've been signed out — sign in to open this plan.",
  loadFailed: "This plan couldn't be opened.",
  unconfirmed: "Some changes weren't confirmed by the server.",
  noDeviceCopy: "This device couldn't keep a copy of your unsaved changes — keep this page open until they're saved.",
  refused: "That change wasn't saved.",
  restored: (n: number) =>
    n === 1
      ? "1 change made on this device hadn't reached the server — saving it now."
      : `${n} changes made on this device hadn't reached the server — saving them now.`,
} as const;

type Key = string;
type Mode = "ok" | "offline" | "error" | "signedOut";

const KIND_RANK: Record<EntityKind, number> = { plan: 0, page: 1, circle: 2, comment: 3 };
const KINDS: readonly EntityKind[] = ["plan", "page", "circle", "comment"];
const keyOf = (kind: EntityKind, id: ID): Key => `${kind}:${id}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Plans with a store open in this tab (load() called, not disposed). The
 * background save on the home page leaves those to their editor.
 */
const openPlans = new Map<string, number>();
export function isPlanOpen(planId: string): boolean {
  return (openPlans.get(planId) ?? 0) > 0;
}

/** HTTP status of a failed call; 0 = no connection, timeout, or a reply that wasn't what the API promises. */
function errorStatus(e: unknown): number {
  const s = isObj(e) ? e.status : undefined;
  return typeof s === "number" ? s : 0;
}
const isTransient = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message && errorStatus(e) !== 0 ? e.message : fallback;
}

/** Shallow equality of two flat rows. */
function sameRow(a: object, b: object): boolean {
  if (a === b) return true;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) if (!sameValue(ra[k], rb[k])) return false;
  return true;
}

function isPlanDoc(d: unknown): d is PlanDoc {
  return isObj(d) && isObj(d.plan) && Array.isArray(d.pages) && Array.isArray(d.circles) && Array.isArray(d.comments);
}
function isSyncReply(r: unknown): r is SyncResponse {
  return isObj(r) && isObj(r.rows) && (r.rejected === undefined || Array.isArray(r.rejected));
}

interface PendingRow {
  key: Key;
  kind: EntityKind;
  id: ID;
}

interface Gesture {
  /** Per row: the editable values before the gesture's first live update (only the fields it touched). */
  before: Map<Key, Record<string, unknown>>;
}

export function createPlanStore(planId: string, options: PlanStoreOptions = {}): PlanStore {
  const transport = options.transport ?? apiTransport;
  const storage = options.storage !== undefined ? options.storage : browserStorage();
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? globalTimers;
  const env = options.env ?? browserEnv();
  const say = options.notify ?? ((message: string, kind?: "info" | "ok" | "error") => void defaultNotify(message, kind));
  const makeId = options.newId ?? defaultNewId;

  // ── rows ──────────────────────────────────────────────────────────────────

  const doc: Record<EntityKind, Map<ID, AnyRow>> = { plan: new Map(), page: new Map(), circle: new Map(), comment: new Map() };
  const synced: Record<EntityKind, Map<ID, AnyRow>> = { plan: new Map(), page: new Map(), circle: new Map(), comment: new Map() };
  /** Bumped whenever a kind's rows change (drives the derived-state memo). */
  const ver = { plan: 0, page: 0, circle: 0, comment: 0 };
  /** Rows that may be pending; re-checked lazily. Rows with no server copy stay here until they get one. */
  const candidates = new Map<Key, { kind: EntityKind; id: ID }>();
  let pendingCache: PendingRow[] | null = null;
  /** Creates that went out in a request: the server may have them even though no reply said so. */
  const maybeOnServer = new Set<Key>();
  /**
   * Per row, the data of the last request that carried it and got no answer
   * yet (it may have landed). Kept in the outbox as `sent`.
   */
  const unconfirmed = new Map<Key, Record<string, unknown>>();
  /** The outbox entries this store wrote (or restored), as the exact text: it may remove only those, and only while unchanged. */
  const written = new Map<Key, string>();
  /** The outbox text this store last wrote or read, parsed (so an unchanged outbox isn't parsed again on every keystroke). */
  let outboxCache: { text: string; entries: Map<Key, string> } | null = null;

  const history = new History();
  let gesture: Gesture | null = null;

  // ── status ────────────────────────────────────────────────────────────────

  let loaded = false;
  let loadError: string | null = null;
  let notFound = false;
  let mode: Mode = "ok";
  let message: string | null = null;
  /** The last outbox write was refused by the browser (quota, blocked storage). */
  let outboxFailed = false;
  let localRev = 0;
  /** Bumped on every applied sync reply (dedupes keepalive flushes). */
  let replyEpoch = 0;

  let currentFlush: Promise<void> | null = null;
  /** A flush was asked for while one was running: run another round when it ends. */
  let flushAgain = false;
  /** keepalive requests out (sent while the page was being hidden). */
  let sideRequests = 0;
  let retryIdx = 0;
  let lastHideStamp = "";
  let loadInFlight: Promise<void> | null = null;
  let pulling: Promise<void> | null = null;
  let checkingMe = false;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  let registered = false;

  // ── timers ────────────────────────────────────────────────────────────────

  function slot() {
    let handle: unknown = null;
    return {
      get active() {
        return handle !== null;
      },
      set(ms: number, fn: () => void) {
        this.clear();
        if (disposed) return;
        handle = timers.setTimeout(() => {
          handle = null;
          fn();
        }, ms);
      },
      clear() {
        if (handle !== null) timers.clearTimeout(handle);
        handle = null;
      },
    };
  }
  const debounce = slot();
  const maxWait = slot();
  const retry = slot();
  const mePoll = slot();
  const pullTick = slot();
  const loadRetry = slot();
  const gestureIdle = slot();
  const allSlots = [debounce, maxWait, retry, mePoll, pullTick, loadRetry, gestureIdle];

  // ── subscription & state ──────────────────────────────────────────────────

  const listeners = new Set<() => void>();
  let batchDepth = 0;
  let emitQueued = false;
  let stateDirty = true;
  let state: PlanState | null = null;
  let saveInfo: SaveInfo = { state: "saved", pending: 0, message: null };
  const derive = createDeriver();

  function emit() {
    stateDirty = true;
    if (batchDepth > 0) {
      emitQueued = true;
      return;
    }
    for (const l of [...listeners]) {
      try {
        l();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /** Run `fn` and notify subscribers once at the end. */
  function batch<T>(fn: () => T): T {
    batchDepth++;
    try {
      return fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0 && emitQueued) {
        emitQueued = false;
        emit();
      }
    }
  }

  function saveState(pending: number): SaveState {
    if (mode === "signedOut") return "signedOut";
    const busy = currentFlush !== null || sideRequests > 0;
    if (pending === 0 && !busy) return "saved";
    if (mode === "offline") return "offline";
    if (mode === "error") return "error";
    return busy ? "saving" : "pending";
  }

  function getState(): PlanState {
    if (state && !stateDirty) return state;
    stateDirty = false;
    const d = derive({ pages: doc.page as Map<ID, PageRow>, circles: doc.circle as Map<ID, CircleRow>, comments: doc.comment as Map<ID, CommentRow>, ver });
    const pending = pendingRows().length;
    const st = saveState(pending);
    // "kept on this device" must be true: say so when the browser refused the copy
    const msg = outboxFailed && pending > 0 ? MSG.noDeviceCopy : message;
    if (saveInfo.state !== st || saveInfo.pending !== pending || saveInfo.message !== msg) saveInfo = { state: st, pending, message: msg };
    const next: PlanState = {
      loaded,
      loadError,
      notFound,
      plan: (doc.plan.get(planId) as PlanRow | undefined) ?? null,
      pages: d.pages,
      pageById: d.pageById,
      circlesByPage: d.circlesByPage,
      commentsByCircle: d.commentsByCircle,
      circleById: d.circleById,
      save: saveInfo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      rev: localRev,
    };
    if (state && (Object.keys(next) as (keyof PlanState)[]).every((k) => state![k] === next[k])) return state;
    state = next;
    return state;
  }

  // ── row helpers ───────────────────────────────────────────────────────────

  function touch(kind: EntityKind, id: ID) {
    candidates.set(keyOf(kind, id), { kind, id });
    pendingCache = null;
  }
  function putRow(kind: EntityKind, id: ID, row: AnyRow) {
    doc[kind].set(id, row);
    ver[kind]++;
    touch(kind, id);
  }
  function putSynced(kind: EntityKind, id: ID, row: AnyRow) {
    synced[kind].set(id, row);
    touch(kind, id);
  }
  /** Forget a row entirely (a create the server refused). */
  function dropRow(kind: EntityKind, id: ID) {
    const key = keyOf(kind, id);
    doc[kind].delete(id);
    synced[kind].delete(id);
    maybeOnServer.delete(key);
    unconfirmed.delete(key);
    gesture?.before.delete(key);
    ver[kind]++;
    candidates.delete(key);
    pendingCache = null;
  }

  /**
   * A row that was made on this device, never left it, and is deleted (or is
   * a comment on such a circle): there is nothing to tell the server, so it
   * isn't pending. Not sending it keeps circle numbers free of gaps when an
   * accidental add is undone straight away.
   */
  function isLocalOnly(kind: EntityKind, row: AnyRow): boolean {
    if (synced[kind].has(row.id) || maybeOnServer.has(keyOf(kind, row.id))) return false;
    if (kind === "circle") return row.deletedAt !== null;
    if (kind === "comment") {
      if (row.deletedAt !== null) return true;
      const circle = doc.circle.get((row as CommentRow).circleId);
      return !!circle && isLocalOnly("circle", circle);
    }
    return false;
  }

  /** The pending rows: plans first, then pages, circles, comments (the order the server applies them in). */
  function pendingRows(): PendingRow[] {
    if (pendingCache) return pendingCache;
    const out: PendingRow[] = [];
    for (const [key, { kind, id }] of candidates) {
      const row = doc[kind].get(id);
      if (!row) {
        candidates.delete(key);
        continue;
      }
      const s = synced[kind].get(id);
      if (s) {
        if (sameEditable(kind, row, s)) candidates.delete(key);
        else out.push({ key, kind, id });
      } else if (!isLocalOnly(kind, row)) out.push({ key, kind, id });
    }
    out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    pendingCache = out;
    return out;
  }

  /**
   * Apply a patch of editable fields to a row (cleaned like the server
   * would). Returns what actually changed, or null when nothing did.
   */
  function patchRow(kind: EntityKind, id: ID, patch: Record<string, unknown>): RowChange | null {
    const row = doc[kind].get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const clean = cleanPatch(kind, patch);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    let any = false;
    for (const [f, v] of Object.entries(clean)) {
      if (sameValue(row[f], v)) continue;
      before[f] = row[f];
      after[f] = v;
      any = true;
    }
    if (!any) return null;
    putRow(kind, id, { ...row, ...after, updatedAt: now() } as unknown as AnyRow);
    return { kind, id, before, after };
  }

  // ── outbox ────────────────────────────────────────────────────────────────

  /** The outbox entries stored right now (another tab or store may have written since this one did). */
  function storedEntries(): Map<Key, string> {
    const text = readStoredText(storage, planId) ?? "";
    if (outboxCache && outboxCache.text === text) return new Map(outboxCache.entries);
    const entries = new Map<Key, string>();
    for (const [key, { json }] of parseStored(planId, text).entries) entries.set(key, json);
    outboxCache = { text, entries: new Map(entries) };
    return entries;
  }

  /**
   * Bring the device outbox up to date: write this store's pending rows, and
   * remove the entries it wrote whose rows the server has since confirmed
   * (or that were undone) — unless someone else has rewritten them since
   * (another tab, or a newer editor for this plan: theirs now). Other
   * entries are left exactly as they are.
   *
   * Once disposed (the editor was closed, a newer store may own the plan
   * now), it only removes: a late reply still trims what it confirmed, but
   * nothing stale is written back.
   */
  function persistOutbox() {
    // never before the first load (it would mix up what the last session left)
    if (!loaded || !storage) return;
    const stored = storedEntries();
    const next = new Map(stored);
    const nextWritten = new Map(written);
    const pending = pendingRows();
    const pendingKeys = new Set(pending.map((p) => p.key));
    if (!disposed) {
      for (const { key, kind, id } of pending) {
        const s = synced[kind].get(id);
        const sent = unconfirmed.get(key);
        const json = entryJson({ local: doc[kind].get(id)!, base: s ? editableOf(kind, s) : null, sent: sent ? editableOf(kind, sent) : null });
        next.set(key, json);
        nextWritten.set(key, json);
      }
    }
    for (const [key, json] of written) {
      if (pendingKeys.has(key)) continue; // written above (or, once disposed, left as it is)
      if (next.get(key) === json) next.delete(key);
      nextWritten.delete(key);
    }
    // a row back in sync: what went out for it no longer matters
    for (const key of [...unconfirmed.keys()]) if (!pendingKeys.has(key)) unconfirmed.delete(key);

    let same = next.size === stored.size;
    if (same) for (const [key, json] of next) if (stored.get(key) !== json) same = false;
    let ok = true;
    if (!same) {
      const plan = doc.plan.get(planId) as PlanRow | undefined;
      const text = writeStored(storage, planId, next, plan?.name ?? null);
      if (text === null) ok = false;
      else outboxCache = { text, entries: next };
    }
    // refused: keep claiming what's still on disk, so a later write can remove it
    if (ok) {
      written.clear();
      for (const [key, json] of nextWritten) written.set(key, json);
    }
    const failed = !ok && pending.length > 0 && !disposed;
    if (failed !== outboxFailed) {
      outboxFailed = failed;
      emit();
    }
  }

  // ── local changes ─────────────────────────────────────────────────────────

  /** After every change made on this device: outbox, save timer, subscribers. */
  function afterLocalChange(opts: { save?: boolean } = {}) {
    localRev++;
    if (opts.save !== false) {
      persistOutbox();
      scheduleFlush();
    }
    emit();
  }

  function commit(changes: (RowChange | null)[], tag: string | null = null) {
    const real = changes.filter((c): c is RowChange => c !== null);
    if (!real.length) return;
    history.push(real, now(), tag);
    afterLocalChange();
  }

  /** Put one side of an undo step back. Returns true when anything changed. */
  function applyStep(step: Step, side: "before" | "after"): boolean {
    let changed = false;
    for (const c of step.changes) if (patchRow(c.kind, c.id, c[side])) changed = true;
    return changed;
  }

  // ── merging server rows ───────────────────────────────────────────────────

  /**
   * Take a server row in (pull, page polling, upload reply): adopt it when
   * this device has no pending change for the row, else merge field by field
   * against the previous server copy.
   */
  function rebaseRow(kind: EntityKind, remote: AnyRow) {
    const id = remote.id;
    const s = synced[kind].get(id);
    if (s && remote.rev < s.rev) return; // older than a copy already seen
    const local = doc[kind].get(id);
    let next: AnyRow = remote;
    // a row with no server copy yet is always merged (base null: the device's fields win)
    if (local && (!s || !sameEditable(kind, local, s))) next = merge3(kind, s ?? null, local, remote);
    if (!local || !sameRow(local, next)) putRow(kind, id, next);
    if (!s || !sameRow(s, remote)) putSynced(kind, id, remote);
  }

  function rowsOf(d: { plans?: unknown; pages?: unknown; circles?: unknown; comments?: unknown }): [EntityKind, AnyRow][] {
    const out: [EntityKind, AnyRow][] = [];
    const lists: [EntityKind, unknown][] = [
      ["plan", d.plans],
      ["page", d.pages],
      ["circle", d.circles],
      ["comment", d.comments],
    ];
    for (const [kind, list] of lists) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!isObj(r) || typeof r.id !== "string") continue;
        // never take in another plan's rows
        if (kind === "plan" ? r.id !== planId : r.planId !== planId) continue;
        out.push([kind, r as unknown as AnyRow]);
      }
    }
    return out;
  }

  /**
   * Merge a sync reply. `sent` is what each op carried; edits made since keep
   * their local values (merge3 against what was sent).
   */
  function applyReply(sent: Map<Key, SyncOp>, res: SyncResponse): { unconfirmed: number; reasons: string[] } {
    replyEpoch++;
    const rejected = new Map<Key, string>();
    for (const r of res.rejected ?? []) {
      if (!isObj(r) || !KINDS.includes(r.kind as EntityKind) || typeof r.id !== "string") continue;
      rejected.set(keyOf(r.kind as EntityKind, r.id), typeof r.reason === "string" && r.reason ? r.reason : MSG.refused);
    }
    const seen = new Set<Key>();
    for (const [kind, remote] of rowsOf(res.rows)) {
      const key = keyOf(kind, remote.id);
      seen.add(key);
      const s = synced[kind].get(remote.id);
      const local = doc[kind].get(remote.id);
      const op = sent.get(key);
      if (s && remote.rev < s.rev) {
        // A newer server copy already arrived (a pull or a concurrent
        // request). This reply still proves the server dealt with what was
        // sent, so fields untouched since then follow that newer copy (all
        // of them when the op was refused).
        if (local && op) {
          const next = rejected.has(key) ? s : merge3(kind, op.data, local, s);
          if (!sameRow(local, next)) putRow(kind, remote.id, next);
        }
        continue;
      }
      let next: AnyRow = remote;
      // refused: the server's copy stands (the local change is dropped)
      if (local && !rejected.has(key)) next = merge3(kind, op ? op.data : s ? editableOf(kind, s) : null, local, remote);
      if (!local || !sameRow(local, next)) putRow(kind, remote.id, next);
      if (!s || !sameRow(s, remote)) putSynced(kind, remote.id, remote);
    }
    const reasons: string[] = [];
    for (const [key, reason] of rejected) {
      const op = sent.get(key);
      if (!op) continue;
      if (!reasons.includes(reason)) reasons.push(reason);
      if (seen.has(key)) continue;
      const s = synced[op.kind].get(op.id);
      if (s) putRow(op.kind, op.id, s); // drop the local change, keep the last server copy
      else dropRow(op.kind, op.id); // a create the server refused never existed there
    }
    let unanswered = 0;
    for (const [key, op] of sent) {
      if (!seen.has(key) && !rejected.has(key)) unanswered++;
      // answered: no longer "may have landed" (unless a later request carried other data)
      else if (unconfirmed.get(key) === op.data) unconfirmed.delete(key);
    }
    return { unconfirmed: unanswered, reasons };
  }

  // ── saving ────────────────────────────────────────────────────────────────

  /**
   * The ops to send now. Rows in a gesture are held back until it ends (no
   * half-way drag positions on the wire), except for the keepalive flush when
   * the page is going away. A comment whose circle isn't on the server yet
   * waits for that circle's create.
   */
  function buildOps(includeGesture: boolean): SyncOp[] {
    const ops: SyncOp[] = [];
    const creatingCircles = new Set<ID>();
    for (const { key, kind, id } of pendingRows()) {
      if (!includeGesture && gesture?.before.has(key)) continue;
      const row = doc[kind].get(id)!;
      const s = synced[kind].get(id);
      if (!s) {
        if (kind === "plan" || kind === "page") continue; // only uploads create these
        if (kind === "comment") {
          const circleId = (row as CommentRow).circleId;
          if (doc.circle.has(circleId) && !synced.circle.has(circleId) && !creatingCircles.has(circleId)) continue;
        }
        if (kind === "circle") creatingCircles.add(id);
      }
      const data = editableOf(kind, row);
      if (!s && (kind === "circle" || kind === "comment")) {
        for (const f of CREATE_FIELDS[kind]) data[f] = (row as unknown as Record<string, unknown>)[f];
      }
      ops.push({ kind, id, base: s ? editableOf(kind, s) : null, data });
    }
    return ops;
  }

  function scheduleFlush() {
    if (!loaded || disposed) return;
    // signed out: the session check resumes saving; refused: the pill (or the slow retry) does
    if (mode === "signedOut" || mode === "error") return;
    debounce.set(DEBOUNCE_MS, fireFlush);
    if (!maxWait.active) maxWait.set(MAX_WAIT_MS, fireFlush);
  }

  function fireFlush() {
    debounce.clear();
    maxWait.clear();
    if (currentFlush) flushAgain = true;
    else void runFlush(false);
  }

  /** Start a flush (or join the running one). `force` also runs when signed out or after a refusal. */
  function runFlush(force: boolean): Promise<void> {
    if (currentFlush) {
      flushAgain = true;
      return currentFlush;
    }
    if (!loaded || disposed) return Promise.resolve();
    if (!force && (mode === "signedOut" || mode === "error")) return Promise.resolve();
    const run = (async () => {
      try {
        await flushLoop();
      } finally {
        currentFlush = null;
        batch(() => {
          afterFlush();
          emit();
        });
      }
    })();
    currentFlush = run;
    return run;
  }

  async function flushLoop() {
    // Bounded: a run normally ends after one request (or one per 500 ops).
    for (let round = 0; round < 100; round++) {
      debounce.clear();
      maxWait.clear();
      flushAgain = false;
      const ops = buildOps(false);
      if (!ops.length) return;
      const chunk = firstChunk(ops);
      emit(); // "Saving…"
      if (!(await send(chunk, false))) return;
      // more than one request's worth (the rest goes next: a comment never before its circle, ops are in that order), or a save was asked for while this one was out
      if (ops.length > chunk.length || flushAgain) continue;
      return;
    }
  }

  /** The ops for one request: at most MAX_OPS_PER_REQUEST and MAX_REQUEST_BYTES — always at least one (a single op is far smaller). */
  function firstChunk(ops: SyncOp[]): SyncOp[] {
    let n = 0;
    let bytes = 0;
    while (n < ops.length && n < MAX_OPS_PER_REQUEST) {
      const size = utf8Length(JSON.stringify(ops[n])) + 1;
      if (n > 0 && bytes + size > MAX_REQUEST_BYTES) break;
      bytes += size;
      n++;
    }
    return ops.slice(0, n);
  }

  /** Safety net after a flush: anything sendable left with no timer to pick it up gets one. */
  function afterFlush() {
    if (disposed || mode !== "ok" || debounce.active || maxWait.active) return;
    if (buildOps(false).length) scheduleFlush();
  }

  /** Send one request. Returns true when the server answered (even if it refused some ops). */
  async function send(chunk: SyncOp[], keepalive: boolean): Promise<boolean> {
    const sent = new Map<Key, SyncOp>(chunk.map((op) => [keyOf(op.kind, op.id), op]));
    // Remember (on the device too) what went out, before it does: if no
    // reply is ever handled (lost, or the tab is closed first), the next
    // visit must know this may already be on the server. When the browser
    // knows it's offline, nothing can land.
    if (env.isOnline?.() !== false) {
      for (const op of chunk) {
        const key = keyOf(op.kind, op.id);
        unconfirmed.set(key, op.data);
        if (op.base === null) maybeOnServer.add(key);
      }
      pendingCache = null;
      persistOutbox();
    }

    let res: SyncResponse;
    try {
      res = await transport.sync(planId, { ops: chunk }, keepalive ? { keepalive: true } : {});
      if (!isSyncReply(res)) throw new Error("unexpected reply");
    } catch (err) {
      batch(() => {
        if (keepalive) {
          // the page was going away; the regular machinery retries if it comes back
          if (errorStatus(err) === 401) enterSignedOut(errorMessage(err, MSG.signedOutLoad));
        } else syncFailed(err);
      });
      return false;
    }

    batch(() => {
      const { unconfirmed, reasons } = applyReply(sent, res);
      retryIdx = 0;
      retry.clear();
      if (mode !== "ok") {
        mode = "ok";
        mePoll.clear();
      }
      message = reasons.length ? reasons[0] : null;
      for (const r of reasons.slice(0, 3)) say(r, "error");
      if (unconfirmed > 0) {
        // the server answered but said nothing about some rows: don't spin, say so
        mode = "error";
        message = MSG.unconfirmed;
        retry.set(ERROR_RETRY_MS, () => void runFlush(true));
      }
      persistOutbox();
      emit();
    });
    return true;
  }

  function syncFailed(err: unknown) {
    const status = errorStatus(err);
    if (status === 401) {
      enterSignedOut(errorMessage(err, "You've been signed out — sign in again to keep working."));
      return;
    }
    if (isTransient(status)) {
      mode = "offline";
      message = err instanceof Error && err.message && err.message !== "unexpected reply" ? err.message : "No connection — your changes are kept on this device.";
      const ms = RETRY_MS[Math.min(retryIdx, RETRY_MS.length - 1)];
      retryIdx++;
      retry.set(ms, () => void runFlush(true));
    } else {
      mode = "error";
      message = errorMessage(err, MSG.refused);
      retry.set(ERROR_RETRY_MS, () => void runFlush(true));
      if (status === 404) void pull(); // the plan may be gone: the pull says so (notFound)
    }
    emit();
  }

  function enterSignedOut(msg: string) {
    mode = "signedOut";
    message = msg;
    debounce.clear();
    maxWait.clear();
    retry.clear();
    if (!mePoll.active && !checkingMe) mePoll.set(ME_POLL_MS, () => void checkMe());
    emit();
  }

  /** While signed out: is the session back? Then carry on where we left off. */
  async function checkMe() {
    if (checkingMe || disposed) return;
    checkingMe = true;
    mePoll.clear();
    let ok = false;
    try {
      await transport.me();
      ok = true;
    } catch {
      /* still signed out, or no connection */
    }
    checkingMe = false;
    if (disposed) return;
    if (!ok) {
      if (mode === "signedOut") mePoll.set(ME_POLL_MS, () => void checkMe());
      return;
    }
    if (mode !== "signedOut") return;
    batch(() => {
      mode = "ok";
      message = null;
      retryIdx = 0;
      emit();
    });
    if (!loaded) void attemptLoad();
    else {
      void runFlush(true);
      void pull();
    }
  }

  /**
   * The page is going away or to the background: write the outbox and send
   * everything pending as a keepalive request (it outlives the page). Too big
   * for keepalive → a normal request, best effort; the outbox has it anyway.
   */
  function hideFlush() {
    if (!loaded) return;
    persistOutbox();
    const ops = buildOps(true);
    if (!ops.length) return;
    // visibilitychange and pagehide fire back to back: one request is enough
    const stamp = `${localRev}:${replyEpoch}`;
    if (stamp === lastHideStamp) return;
    lastHideStamp = stamp;
    const chunk = ops.slice(0, MAX_OPS_PER_REQUEST);
    if (utf8Length(JSON.stringify({ ops: chunk })) <= KEEPALIVE_MAX_BYTES) {
      sideRequests++;
      emit();
      void send(chunk, true).finally(() => {
        sideRequests--;
        batch(() => {
          afterFlush();
          emit();
        });
      });
    } else if (!currentFlush) void runFlush(true);
  }

  // ── loading & pulling ─────────────────────────────────────────────────────

  function attemptLoad(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loadInFlight) return loadInFlight;
    loadRetry.clear();
    loadInFlight = (async () => {
      let d: PlanDoc;
      try {
        d = await transport.getPlan(planId);
        if (!isPlanDoc(d)) throw new Error("unexpected reply");
      } catch (err) {
        loadInFlight = null;
        batch(() => loadFailed(err));
        return;
      }
      loadInFlight = null;
      if (!loaded) batch(() => applyInitial(d));
    })();
    return loadInFlight;
  }

  function loadFailed(err: unknown) {
    const status = errorStatus(err);
    if (status === 404) {
      notFound = true;
      loadError = null;
    } else if (status === 401) {
      loadError = MSG.signedOutLoad;
      enterSignedOut(errorMessage(err, MSG.signedOutLoad));
    } else if (isTransient(status)) {
      loadError = status === 0 ? MSG.offlineLoad : MSG.serverDownLoad;
      loadRetry.set(LOAD_RETRY_MS, () => void attemptLoad());
    } else {
      loadError = errorMessage(err, MSG.loadFailed);
      loadRetry.set(LOAD_RETRY_MS * 6, () => void attemptLoad());
    }
    emit();
  }

  /** First successful GET: take the server's rows, then put this device's unsent changes back on top. */
  function applyInitial(d: PlanDoc) {
    const rows = rowsOf({ ...d, plans: Array.isArray(d.plans) && d.plans.length ? d.plans : [d.plan] });
    for (const [kind, r] of rows) {
      putRow(kind, r.id, r);
      putSynced(kind, r.id, r);
    }

    const restored: Key[] = [];
    for (const [key, { entry: e, json }] of parseStored(planId, readStoredText(storage, planId)).entries) {
      written.set(key, json); // this store answers for it now (removed once saved or moot)
      const server = synced[e.kind].get(e.id);
      if (server) {
        // the server may have this already, or a newer value from the other device (restoreRow says which wins)
        const merged = restoreRow(e.kind, e, server);
        if (!sameRow(merged, server)) putRow(e.kind, e.id, merged);
        if (e.sent) unconfirmed.set(key, e.sent);
      } else if (e.kind === "circle" || e.kind === "comment") {
        // a create that never reached the server (or reached it and its reply was lost)
        putRow(e.kind, e.id, e.local);
        if (e.sent) {
          maybeOnServer.add(key);
          unconfirmed.set(key, e.sent);
        }
      } else continue; // a page/plan the server no longer has
      restored.push(key);
    }

    loaded = true;
    loadError = null;
    notFound = false;
    if (disposed) {
      // unmounted while loading: keep the rows (a revived store carries on), but the outbox stays for the next visit
      emit();
      return;
    }
    const pending = new Set(pendingRows().map((p) => p.key));
    const restoredCount = restored.filter((k) => pending.has(k)).length;
    persistOutbox();
    schedulePullTick();
    // the Toaster may not be listening yet during the first render
    if (restoredCount > 0) timers.setTimeout(() => say(MSG.restored(restoredCount), "info"), 0);
    if (pending.size && mode !== "signedOut") void runFlush(true);
    emit();
  }

  /** GET the plan and rebase this device's rows onto it (picks up the other device's edits). */
  function pull(): Promise<void> {
    if (!loaded || disposed) return Promise.resolve();
    if (pulling) return pulling;
    pullTick.clear();
    pulling = (async () => {
      try {
        let d: PlanDoc;
        try {
          d = await transport.getPlan(planId);
          if (!isPlanDoc(d)) return;
        } catch (err) {
          const status = errorStatus(err);
          batch(() => {
            if (status === 401) enterSignedOut(errorMessage(err, MSG.signedOutLoad));
            else if (status === 404 && !notFound) {
              notFound = true; // deleted elsewhere; pending changes still save (the server keeps deleted plans for a while)
              emit();
            }
          });
          return;
        }
        batch(() => {
          for (const [kind, r] of rowsOf({ ...d, plans: Array.isArray(d.plans) && d.plans.length ? d.plans : [d.plan] })) rebaseRow(kind, r);
          if (notFound) notFound = false;
          persistOutbox();
          emit();
        });
      } finally {
        pulling = null;
        schedulePullTick();
      }
    })();
    return pulling;
  }

  /** Every 30 s while the tab is visible and nothing is waiting to save. */
  function schedulePullTick() {
    if (!loaded || disposed) return;
    pullTick.set(PULL_EVERY_MS, () => {
      const idle = mode === "ok" && !currentFlush && sideRequests === 0 && pendingRows().length === 0;
      if (env.isVisible() && idle) void pull();
      else schedulePullTick();
    });
  }

  // ── page lifecycle ────────────────────────────────────────────────────────

  function onVisible() {
    if (disposed) return;
    if (mode === "signedOut") {
      void checkMe();
      return;
    }
    if (!loaded) {
      if (loadError) void attemptLoad();
      return;
    }
    void pull();
    if (pendingRows().length) {
      retryIdx = 0;
      void runFlush(true);
    }
  }

  function onOnline() {
    if (disposed) return;
    if (mode === "signedOut") {
      void checkMe();
      return;
    }
    if (!loaded) {
      if (loadError) void attemptLoad();
      return;
    }
    if (pendingRows().length) {
      retryIdx = 0;
      void runFlush(true);
    }
  }

  function onHidden() {
    if (disposed) return;
    batch(() => hideFlush());
  }

  function startListening() {
    if (!unlisten) unlisten = env.listen({ online: onOnline, hidden: onHidden, visible: onVisible });
    if (!registered) {
      registered = true;
      openPlans.set(planId, (openPlans.get(planId) ?? 0) + 1);
    }
  }

  function stopListening() {
    unlisten?.();
    unlisten = null;
    if (registered) {
      registered = false;
      const n = (openPlans.get(planId) ?? 1) - 1;
      if (n > 0) openPlans.set(planId, n);
      else openPlans.delete(planId);
    }
  }

  // ── gestures ──────────────────────────────────────────────────────────────

  function endGestureInner() {
    const g = gesture;
    if (!g) return;
    gesture = null;
    gestureIdle.clear();
    const changes: RowChange[] = [];
    for (const [key, before] of g.before) {
      const c = parseKey(key);
      const row = c && (doc[c.kind].get(c.id) as Record<string, unknown> | undefined);
      if (!c || !row) continue;
      const b: Record<string, unknown> = {};
      const a: Record<string, unknown> = {};
      let any = false;
      for (const [f, v] of Object.entries(before)) {
        if (sameValue(v, row[f])) continue;
        b[f] = v;
        a[f] = row[f];
        any = true;
      }
      if (any) changes.push({ kind: c.kind, id: c.id, before: b, after: a });
    }
    pendingCache = null;
    if (changes.length) commit(changes);
    else if (g.before.size) {
      // moved and came back: nothing to undo, but the rows may need saving (a keepalive may have sent a mid-way value)
      persistOutbox();
      scheduleFlush();
      emit();
    }
  }

  // ── the public API ────────────────────────────────────────────────────────

  const store: PlanStore = {
    getState,

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    load() {
      if (disposed) {
        // revived (e.g. a React effect re-run after its cleanup)
        disposed = false;
        if (loaded) {
          startListening();
          schedulePullTick();
          void pull();
          if (pendingRows().length) void runFlush(true);
          return Promise.resolve();
        }
      }
      startListening();
      if (loaded) {
        void pull();
        return Promise.resolve();
      }
      return attemptLoad();
    },

    dispose() {
      if (disposed) return;
      batch(() => {
        if (gesture) endGestureInner();
        if (loaded) hideFlush();
      });
      disposed = true;
      for (const s of allSlots) s.clear();
      stopListening();
    },

    // ── circles ──

    addCircle(input) {
      const id = makeId();
      if (!loaded) return id;
      const t = now();
      const row: CircleRow = {
        id,
        planId,
        pageId: input.pageId,
        x: isFiniteNumber(input.x) ? clamp(input.x, 0, 1) : 0.5,
        y: isFiniteNumber(input.y) ? clamp(input.y, 0, 1) : 0.5,
        r: isFiniteNumber(input.r) ? clamp(input.r, MIN_CIRCLE_R, MAX_CIRCLE_R) : FALLBACK_R,
        color: isColor(input.color) ? input.color : DEFAULT_CIRCLE_COLOR,
        title: "",
        num: 0,
        createdAt: t,
        updatedAt: t,
        deletedAt: null,
        rev: 0,
      };
      batch(() => {
        putRow("circle", id, row);
        commit([{ kind: "circle", id, before: { deletedAt: t }, after: { deletedAt: null } }]);
      });
      return id;
    },

    pasteCircles(items) {
      if (!loaded || !Array.isArray(items)) return [];
      const ids: string[] = [];
      batch(() => {
        if (gesture) endGestureInner();
        const t = now();
        // a millisecond apart, so the copies (and each one's comments) keep their order until the server numbers them
        let tick = 0;
        const changes: RowChange[] = [];
        for (const item of items as readonly PastedCircle[]) {
          if (!item || typeof item !== "object") continue;
          const page = doc.page.get(item.pageId);
          if (!page || page.deletedAt !== null) continue;
          const id = makeId();
          const at = t + tick++;
          const row: CircleRow = {
            id,
            planId,
            pageId: page.id,
            x: isFiniteNumber(item.x) ? clamp(item.x, 0, 1) : 0.5,
            y: isFiniteNumber(item.y) ? clamp(item.y, 0, 1) : 0.5,
            r: isFiniteNumber(item.r) ? clamp(item.r, MIN_CIRCLE_R, MAX_CIRCLE_R) : FALLBACK_R,
            color: isColor(item.color) ? item.color : DEFAULT_CIRCLE_COLOR,
            title: typeof item.title === "string" ? cleanText(item.title, MAX_TITLE_CHARS) : "",
            num: 0,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
            rev: 0,
          };
          putRow("circle", id, row);
          changes.push({ kind: "circle", id, before: { deletedAt: t }, after: { deletedAt: null } });
          ids.push(id);
          for (const body of Array.isArray(item.comments) ? item.comments : []) {
            const text = typeof body === "string" ? cleanText(body, MAX_COMMENT_CHARS) : "";
            if (!text.trim()) continue;
            const cid = makeId();
            const cat = t + tick++;
            const comment: CommentRow = { id: cid, planId, circleId: id, body: text, createdAt: cat, updatedAt: cat, deletedAt: null, rev: 0 };
            putRow("comment", cid, comment);
            changes.push({ kind: "comment", id: cid, before: { deletedAt: t }, after: { deletedAt: null } });
          }
        }
        commit(changes);
      });
      return ids;
    },

    updateCircle(id, patch: CirclePatch, opts = {}) {
      if (!loaded) return;
      const fields: Record<string, unknown> = {};
      for (const f of ["x", "y", "r", "color", "title"] as const) if (patch[f] !== undefined) fields[f] = patch[f];
      batch(() => {
        const live = opts.live === true || (gesture !== null && opts.live !== false);
        const change = patchRow("circle", id, fields);
        if (!change) return;
        if (!live) {
          const titleOnly = Object.keys(change.after).length === 1 && "title" in change.after;
          history.push([change], now(), titleOnly ? `title:${id}` : null);
          afterLocalChange();
          return;
        }
        if (gesture) {
          // remember where the row started; the step is made at endGesture
          const key = keyOf("circle", id);
          const b = gesture.before.get(key) ?? {};
          for (const [f, v] of Object.entries(change.before)) if (!(f in b)) b[f] = v;
          gesture.before.set(key, b);
          gestureIdle.set(GESTURE_IDLE_MS, () => batch(() => endGestureInner()));
          afterLocalChange({ save: false });
        } else afterLocalChange(); // live without a gesture: no undo step, saved as usual
      });
    },

    beginGesture() {
      if (!loaded) return;
      batch(() => {
        if (gesture) endGestureInner();
        history.seal();
        gesture = { before: new Map() };
        gestureIdle.set(GESTURE_IDLE_MS, () => batch(() => endGestureInner()));
      });
    },

    endGesture() {
      batch(() => endGestureInner());
    },

    cancelGesture() {
      const g = gesture;
      if (!g) return;
      batch(() => {
        gesture = null;
        gestureIdle.clear();
        let changed = false;
        for (const [key, before] of g.before) {
          const c = parseKey(key);
          if (c && patchRow(c.kind, c.id, before)) changed = true;
        }
        pendingCache = null;
        if (changed) afterLocalChange();
        else emit();
      });
    },

    deleteCircle(id) {
      const row = doc.circle.get(id);
      if (!loaded || !row || row.deletedAt !== null) return;
      batch(() => commit([patchRow("circle", id, { deletedAt: now() })]));
    },

    restoreCircle(id) {
      const row = doc.circle.get(id);
      if (!loaded || !row || row.deletedAt === null) return;
      batch(() => commit([patchRow("circle", id, { deletedAt: null })]));
    },

    // ── comments ──

    addComment(circleId, body) {
      const id = makeId();
      if (!loaded) return id;
      const t = now();
      const row: CommentRow = {
        id,
        planId,
        circleId,
        body: cleanText(typeof body === "string" ? body : "", MAX_COMMENT_CHARS),
        createdAt: t,
        updatedAt: t,
        deletedAt: null,
        rev: 0,
      };
      batch(() => {
        putRow("comment", id, row);
        // the typing that follows (updateComment) joins this step: undo removes the whole comment
        commit([{ kind: "comment", id, before: { deletedAt: t }, after: { deletedAt: null } }], `comment:${id}`);
      });
      return id;
    },

    updateComment(id, body) {
      if (!loaded) return;
      batch(() => commit([patchRow("comment", id, { body })], `comment:${id}`));
    },

    deleteComment(id) {
      const row = doc.comment.get(id);
      if (!loaded || !row || row.deletedAt !== null) return;
      batch(() => commit([patchRow("comment", id, { deletedAt: now() })]));
    },

    restoreComment(id) {
      const row = doc.comment.get(id);
      if (!loaded || !row || row.deletedAt === null) return;
      batch(() => commit([patchRow("comment", id, { deletedAt: null })]));
    },

    // ── pages & plan ──

    renamePage(id, label) {
      if (!loaded) return;
      batch(() => commit([patchRow("page", id, { label })], `label:${id}`)); // typing a label is one undo step
    },

    movePage(id, toIndex) {
      if (!loaded) return;
      const pages = getState().pages;
      const from = pages.findIndex((p) => p.id === id);
      if (from < 0 || !isFiniteNumber(toIndex)) return;
      const rest = pages.filter((p) => p.id !== id);
      const to = clamp(Math.round(toIndex), 0, rest.length);
      if (to === from) return;
      const prev = rest[to - 1] as PageRow | undefined;
      const next = rest[to] as PageRow | undefined;
      const order = !prev ? next!.sortOrder - 1 : !next ? prev.sortOrder + 1 : (prev.sortOrder + next.sortOrder) / 2;
      batch(() => {
        if ((prev && !(order > prev.sortOrder)) || (next && !(order < next.sortOrder))) {
          // no room between the neighbours (equal orders, or float precision ran out): renumber them all, as one step
          const ordered = [...rest.slice(0, to), pages[from], ...rest.slice(to)];
          commit(ordered.map((p, i) => patchRow("page", p.id, { sortOrder: i })));
        } else commit([patchRow("page", id, { sortOrder: order })]);
      });
    },

    deletePage(id) {
      const row = doc.page.get(id);
      if (!loaded || !row || row.deletedAt !== null) return;
      batch(() => commit([patchRow("page", id, { deletedAt: now() })]));
    },

    restorePage(id) {
      const row = doc.page.get(id);
      if (!loaded || !row || row.deletedAt === null) return;
      batch(() => commit([patchRow("page", id, { deletedAt: null })]));
    },

    renamePlan(name) {
      if (!loaded) return;
      batch(() => commit([patchRow("plan", planId, { name })], "plan-name")); // typing the name is one undo step
    },

    mergePages(pages) {
      if (!loaded || !Array.isArray(pages)) return;
      batch(() => {
        for (const [kind, r] of rowsOf({ pages })) rebaseRow(kind, r);
        persistOutbox();
        emit();
      });
    },

    async refreshPages() {
      if (!loaded || disposed) return;
      let res: { pages: PageRow[] };
      try {
        res = await transport.getPages(planId);
      } catch (err) {
        const status = errorStatus(err);
        batch(() => {
          if (status === 401) enterSignedOut(errorMessage(err, MSG.signedOutLoad));
          else if (status === 404 && !notFound) {
            notFound = true;
            emit();
          }
        });
        return;
      }
      if (isObj(res) && Array.isArray(res.pages)) store.mergePages(res.pages);
    },

    pull,

    // ── history ──

    undo() {
      if (!loaded) return;
      batch(() => {
        if (gesture) endGestureInner();
        // skip steps that no longer change anything (e.g. their rows were refused)
        for (let step = history.takeUndo(); step; step = history.takeUndo()) {
          if (applyStep(step, "before")) {
            afterLocalChange();
            return;
          }
        }
        emit();
      });
    },

    redo() {
      if (!loaded) return;
      batch(() => {
        if (gesture) endGestureInner();
        for (let step = history.takeRedo(); step; step = history.takeRedo()) {
          if (applyStep(step, "after")) {
            afterLocalChange();
            return;
          }
        }
        emit();
      });
    },

    flushNow() {
      if (!loaded || disposed) return Promise.resolve();
      retryIdx = 0;
      if (mode === "signedOut") void checkMe();
      return runFlush(true);
    },

    hasUnsaved() {
      return pendingRows().length > 0;
    },
  };

  return store;
}
