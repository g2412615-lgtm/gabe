// Browser defaults for the engine's injectable dependencies. Every DOM or
// storage access is guarded so the engine also runs in Node (unit tests).

import { api } from "../api";
import type { StorageLike, SyncEnv, SyncTransport, Timers } from "./types";

export const apiTransport: SyncTransport = {
  getPlan: (planId) => api.getPlan(planId),
  sync: (planId, body, opts) => api.sync(planId, body, opts),
  getPages: (planId) => api.getPages(planId),
  me: () => api.me(),
};

/** Looked up at call time so test fake timers (which replace the globals) apply. */
export const globalTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function browserStorage(): StorageLike | null {
  try {
    // reading `localStorage` itself throws when site data is blocked
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Page lifecycle → engine hooks. iPad Safari ignores `beforeunload` and
 * doesn't reliably fire `blur`, so `visibilitychange` and `pagehide` are the
 * moments to save; `pageshow` with `persisted` is a return from the
 * back/forward cache (the page may be minutes stale).
 */
export function browserEnv(): SyncEnv {
  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  return {
    isVisible: () => !hasDom || document.visibilityState !== "hidden",
    listen(h) {
      if (!hasDom) return () => {};
      const onVisibility = () => (document.visibilityState === "hidden" ? h.hidden() : h.visible());
      const onPageHide = () => h.hidden();
      const onPageShow = (e: PageTransitionEvent) => {
        if (e.persisted) h.visible();
      };
      const onOnline = () => h.online();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("online", onOnline);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
        window.removeEventListener("online", onOnline);
      };
    },
  };
}
