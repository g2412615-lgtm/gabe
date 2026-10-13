// One way for any part of the app to tell the owner something: a small toast
// (Toaster.tsx, mounted once in App) — "Saved", "That change wasn't saved",
// or "Deleted “Gate plan”." with an Undo button.
//
// The toasts live in this module (not in React state), so a notify() made
// before the Toaster mounts still shows, and timers keep running whatever
// screen is open.

import { ApiError } from "../api";

export type ToastKind = "info" | "ok" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface NotifyOptions {
  /** A button on the toast (e.g. Undo). Choosing it runs `run` and closes the toast. */
  action?: ToastAction;
  /** Milliseconds before it closes by itself; 0 keeps it until dismissed. */
  duration?: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

const MAX_TOASTS = 4;
const DURATION = { info: 4000, ok: 4000, error: 7000, action: 8000 };

let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

type Timer = { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number };
const timers = new Map<number, Timer>();

function emit() {
  listeners.forEach((l) => l());
}

function startTimer(id: number, ms: number) {
  if (ms <= 0) return;
  timers.set(id, { handle: setTimeout(() => dismissToast(id), ms), remaining: ms, startedAt: Date.now() });
}

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t?.handle) clearTimeout(t.handle);
  timers.delete(id);
}

/**
 * Show a toast. Up to 4 at once (the oldest goes); a message that's already
 * showing is replaced rather than repeated. ok/info stay 4 s, errors 7 s,
 * toasts with an action 8 s. Returns the toast's id (for dismissToast).
 */
export function notify(message: string, kind: ToastKind = "info", opts: NotifyOptions = {}): number {
  if (!message) return 0;
  const id = ++seq;
  const kept = toasts.filter((t) => {
    if (t.message !== message) return true;
    clearTimer(t.id);
    return false;
  });
  const next = [...kept, { id, message, kind, action: opts.action }];
  while (next.length > MAX_TOASTS) clearTimer(next.shift()!.id);
  toasts = next;
  startTimer(id, opts.duration ?? (opts.action ? DURATION.action : DURATION[kind]));
  emit();
  return id;
}

/** An error toast from anything thrown: the server's sentence when there is one. */
export function notifyError(err: unknown, fallback = "That change wasn't saved."): number {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : "";
  return notify(msg || fallback, "error");
}

export function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  clearTimer(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Close the toast, then run its action (so a slow action never leaves it hanging). */
export function runToastAction(id: number) {
  const t = toasts.find((x) => x.id === id);
  dismissToast(id);
  try {
    t?.action?.run();
  } catch (err) {
    console.error(err);
  }
}

/** Hold the countdown while the pointer or keyboard focus is on a toast. */
export function pauseToast(id: number) {
  const t = timers.get(id);
  if (!t?.handle) return;
  clearTimeout(t.handle);
  t.handle = null;
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
}

export function resumeToast(id: number) {
  const t = timers.get(id);
  if (!t || t.handle) return;
  // a moment to read it again after the pointer leaves
  const ms = Math.max(t.remaining, 1500);
  t.startedAt = Date.now();
  t.remaining = ms;
  t.handle = setTimeout(() => dismissToast(id), ms);
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

/**
 * Move the toast stack clear of floating UI (e.g. the editor's right-hand
 * comments panel): distances in px from the right / bottom window edges.
 * Pass null to go back to the default 20 px.
 */
export function setToastOffset(offset: { right?: number; bottom?: number } | null) {
  if (typeof document === "undefined") return;
  const s = document.documentElement.style;
  if (offset?.right != null) s.setProperty("--toast-right", `${offset.right}px`);
  else s.removeProperty("--toast-right");
  if (offset?.bottom != null) s.setProperty("--toast-bottom", `${offset.bottom}px`);
  else s.removeProperty("--toast-bottom");
}
