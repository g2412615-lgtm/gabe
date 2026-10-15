// The plan store's public contract (SPEC §7.4). The editor codes against
// exactly these shapes; the engine behind them lives in store.ts.

import type { CircleColor, CircleRow, CommentRow, PageRow, PlanDoc, PlanRow, SyncRequest, SyncResponse } from "../../shared/types";

export type SaveState = "saved" | "pending" | "saving" | "offline" | "error" | "signedOut";

export interface SaveInfo {
  state: SaveState;
  /** Rows changed on this device that the server hasn't confirmed yet. */
  pending: number;
  /** The engine's last problem, in plain words (null when all is well). */
  message: string | null;
}

export interface PlanState {
  loaded: boolean;
  /** Plain sentence; set when the first load fails (and nothing is cached). */
  loadError: string | null;
  /** The plan was deleted or never existed. */
  notFound: boolean;
  plan: PlanRow | null;
  /** Live (not deleted) pages, sorted by sortOrder. */
  pages: PageRow[];
  /** Live pages by id (an addition to the spec: handy for lookups). */
  pageById: Map<string, PageRow>;
  /**
   * Live circles per live page, sorted by num then createdAt. Every live page
   * has an entry (possibly empty). Circles the server hasn't numbered yet
   * (num 0) sort after the numbered ones — they are the newest.
   */
  circlesByPage: Map<string, CircleRow[]>;
  /** Live comments per live circle, oldest first. Every live circle has an entry (possibly empty). */
  commentsByCircle: Map<string, CommentRow[]>;
  /** Live circles (a circle on a deleted page is not live). */
  circleById: Map<string, CircleRow>;
  save: SaveInfo;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumps on every local change (handy for effects). */
  rev: number;
}

export type CirclePatch = Partial<Pick<CircleRow, "x" | "y" | "r" | "color" | "title">>;

/**
 * A circle to make by copying (pasteCircles): where it sits on its new page
 * (the same fractions as CircleRow), how it looks, and its comments' text.
 */
export interface CircleCopy {
  x: number;
  y: number;
  r: number;
  color: CircleColor;
  title: string;
  /** Comment bodies, oldest first ([] for none). */
  comments: string[];
}

/** A copy and the page it goes on. */
export type PastedCircle = CircleCopy & { pageId: string };

export interface PlanStore {
  getState(): PlanState;
  subscribe(fn: () => void): () => void;
  /** GET the plan, restore the device outbox, rebase, start syncing. */
  load(): Promise<void>;
  /** Flush with keepalive, remove listeners/timers. */
  dispose(): void;

  // circles
  /** Returns the new id; one undo step. */
  addCircle(input: { pageId: string; x: number; y: number; r: number; color?: CircleColor }): string;
  updateCircle(id: string, patch: CirclePatch, opts?: { live?: boolean }): void;
  /** Start of a drag/resize: following live updates make ONE undo step. */
  beginGesture(): void;
  /** Commit the gesture as one undo step and schedule a save. */
  endGesture(): void;
  /** Restore the pre-gesture state (e.g. a second finger landed). */
  cancelGesture(): void;
  /**
   * Make copies of circles, with their comments, each on its live page: ONE
   * undo step for the lot. Returns the new circles' ids in `items` order
   * (the server numbers them in that order), leaving out any whose page
   * isn't live.
   */
  pasteCircles(items: readonly PastedCircle[]): string[];
  /**
   * A page the server has just made as a copy of another (api.duplicatePage):
   * take in the plan's pages from its reply and put `circles` on the new page
   * — the whole duplicate is ONE undo step (undo deletes the new page, redo
   * brings it back). Returns the new circles' ids ([] when the page isn't
   * there, or the store isn't loaded).
   */
  addDuplicatedPage(pages: PageRow[], pageId: string, circles: readonly CircleCopy[]): string[];
  /** Soft delete; one undo step. */
  deleteCircle(id: string): void;
  restoreCircle(id: string): void;

  // comments
  /** Returns the new id. */
  addComment(circleId: string, body: string): string;
  /** Typing: consecutive edits to the same comment coalesce into one undo step. */
  updateComment(id: string, body: string): void;
  deleteComment(id: string): void;
  restoreComment(id: string): void;

  // pages & plan
  renamePage(id: string, label: string): void;
  /** Index among live pages; sets sortOrder between neighbours. */
  movePage(id: string, toIndex: number): void;
  deletePage(id: string): void;
  restorePage(id: string): void;
  renamePlan(name: string): void;
  /** Server page rows from uploads/polling (server-owned fields always win; new pages appear). */
  mergePages(pages: PageRow[]): void;
  /** GET /pages and merge (used while rendering). */
  refreshPages(): Promise<void>;
  /** GET the plan and rebase onto it (an addition: the engine does this by itself on focus and every 30 s). */
  pull(): Promise<void>;

  undo(): void;
  redo(): void;
  /** Save immediately (Cmd/Ctrl+S, tapping the save pill, before leaving). */
  flushNow(): Promise<void>;
  hasUnsaved(): boolean;
}

// ── injectable dependencies (tests run the engine in Node with fakes) ────────

/** The four API calls the engine needs. Errors are ApiError-like: `{ status, message }` (status 0 = no connection). */
export interface SyncTransport {
  getPlan(planId: string): Promise<PlanDoc>;
  sync(planId: string, body: SyncRequest, opts?: { keepalive?: boolean }): Promise<SyncResponse>;
  getPages(planId: string): Promise<{ pages: PageRow[] }>;
  me(): Promise<unknown>;
}

/** The slice of localStorage the outbox uses. Every call may throw (private mode, quota). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Page lifecycle hooks. The browser version maps DOM events onto these. */
export interface SyncEnvHandlers {
  /** The connection came back (`online`). */
  online(): void;
  /** The page is going to the background or away (`visibilitychange` → hidden, `pagehide`). */
  hidden(): void;
  /** The page is back (`visibilitychange` → visible, `pageshow` from the back/forward cache). */
  visible(): void;
}

export interface SyncEnv {
  isVisible(): boolean;
  /**
   * False only when the browser knows there's no connection (a request
   * can't reach the server). Absent or true: it may.
   */
  isOnline?(): boolean;
  /** Start listening; returns a function that stops. */
  listen(handlers: SyncEnvHandlers): () => void;
}

export type Notifier = (message: string, kind?: "info" | "ok" | "error") => void;

export interface PlanStoreOptions {
  /** Defaults to the real API (src/client/api.ts). */
  transport?: SyncTransport;
  /** Defaults to window.localStorage when available; null disables the device outbox. */
  storage?: StorageLike | null;
  /** Clock for createdAt, deletedAt and typing coalescing. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to the global setTimeout/clearTimeout (looked up at call time, so fake timers work). */
  timers?: Timers;
  /** Page lifecycle events. Defaults to the browser's (a no-op outside a browser). */
  env?: SyncEnv;
  /** Toasts. Defaults to ui/notify. */
  notify?: Notifier;
  /** Id factory for new circles/comments. Defaults to newId() from api.ts. */
  newId?: () => string;
}
