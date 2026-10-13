// The home page's list of event plans: load once, poll every 4 s while any
// plan still has pages being prepared, reload when the tab comes back into
// view. A 401 sends the browser to sign in.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { goToLogin } from "../router";
import type { PlanSummary } from "../../shared/types";

const POLL_MS = 4000;

export type ListStatus = "loading" | "ready" | "error";

export interface PlanList {
  plans: PlanSummary[];
  status: ListStatus;
  /** Set when the last load failed (the list keeps what it had). */
  error: ApiError | null;
  reload: () => Promise<void>;
  /** Local edits (rename, delete, restore) before the server confirms them. */
  setPlans: (update: (plans: PlanSummary[]) => PlanSummary[]) => void;
}

export function usePlanList(): PlanList {
  const [plans, setPlansState] = useState<PlanSummary[]>([]);
  const [status, setStatus] = useState<ListStatus>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const hasLoaded = useRef(false);

  // Bumped by every local edit: a list fetched before the edit would undo it
  // on screen (e.g. bring a just-deleted plan back for a moment), so such a
  // response is dropped and the list fetched again.
  const editSeq = useRef(0);

  const reload = useCallback((): Promise<void> => {
    // one request at a time; callers share it
    if (inFlight.current) return inFlight.current;
    const startedAt = editSeq.current;
    let stale = false;
    const p = (async () => {
      try {
        const res = await api.listPlans();
        if (!alive.current) return;
        if (startedAt !== editSeq.current) {
          stale = true;
          return;
        }
        hasLoaded.current = true;
        setPlansState(res.plans);
        setError(null);
        setStatus("ready");
      } catch (err) {
        if (!alive.current) return;
        const e = err instanceof ApiError ? err : new ApiError("That didn't work.", 0);
        if (e.signedOut) {
          goToLogin();
          return;
        }
        setError(e);
        // keep showing the list if there was one; otherwise the error state
        setStatus(hasLoaded.current ? "ready" : "error");
      } finally {
        inFlight.current = null;
      }
    })().then(() => (stale && alive.current ? reload() : undefined));
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  // Poll while pages are being prepared, so thumbnails and the
  // "Preparing…" pills update by themselves.
  const preparing = plans.some((p) => p.pendingPages > 0);
  useEffect(() => {
    if (!preparing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await reload();
        if (!cancelled) tick();
      }, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preparing, reload]);

  const setPlans = useCallback((update: (plans: PlanSummary[]) => PlanSummary[]) => {
    editSeq.current += 1;
    setPlansState(update);
  }, []);

  return { plans, status, error, reload, setPlans };
}
