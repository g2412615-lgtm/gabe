// Saving what earlier visits left on this device. A plan's outbox is
// normally sent by its editor (on every change, on leaving, on the next
// visit). But an editor closed while offline leaves its outbox behind, and
// nothing would send it until that same plan is opened on this device again
// — meanwhile the other device doesn't see those notes. So the home page
// sends every stored outbox in the background (when it opens, and when the
// connection comes back), each through a short-lived store: it restores the
// outbox exactly as the editor would (same rules about what may already be
// on the server), saves, and lets go.

import { notify as defaultNotify } from "../ui/notify";
import { browserEnv, browserStorage } from "./env";
import { hasOutbox, listOutboxPlans, readStored, type ListableStorage } from "./outbox";
import { createPlanStore, isPlanOpen } from "./store";
import type { Notifier, PlanStoreOptions, SyncEnv } from "./types";

/** Wait this long after the home page opens: the editor just closed may still be hearing back about its last save. */
export const BACKGROUND_DELAY_MS = 3000;

export interface LeftoverResult {
  planId: string;
  /** The plan's name (from the server, or as stored with the outbox when offline). */
  name: string | null;
  /** Something is still only on this device. */
  unsaved: boolean;
  signedOut: boolean;
  /** The plan is gone (deleted); its outbox is kept in case it's restored. */
  notFound: boolean;
  /** Changes the server refused (the reason, in plain words). */
  refused: string[];
}

export interface FlushStoredOptions extends Pick<PlanStoreOptions, "transport" | "now" | "timers" | "newId"> {
  /** Defaults to window.localStorage. */
  storage?: ListableStorage | null;
  /** Defaults to a quiet browser env (no listeners, never "visible": no pulls). */
  env?: SyncEnv;
}

let running: Promise<LeftoverResult[]> | null = null;
let again = false;

/**
 * Send every plan's outbox stored on this device, one plan at a time,
 * except plans with an editor open in this tab (it saves them itself).
 * A call while a run is going joins it (and makes it go round once more).
 */
export function flushStoredOutboxes(opts: FlushStoredOptions = {}): Promise<LeftoverResult[]> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let results: LeftoverResult[];
      do {
        again = false;
        results = await flushAll(opts);
      } while (again);
      return results;
    } finally {
      running = null;
    }
  })();
  return running;
}

async function flushAll(opts: FlushStoredOptions): Promise<LeftoverResult[]> {
  const storage = opts.storage !== undefined ? opts.storage : (browserStorage() as ListableStorage | null);
  const results: LeftoverResult[] = [];
  for (const planId of listOutboxPlans(storage)) {
    if (isPlanOpen(planId) || !hasOutbox(storage, planId)) continue;
    results.push(await flushOne(planId, storage!, opts));
  }
  return results;
}

async function flushOne(planId: string, storage: ListableStorage, opts: FlushStoredOptions): Promise<LeftoverResult> {
  const refused: string[] = [];
  const quiet: SyncEnv = opts.env ?? { isVisible: () => false, isOnline: browserEnv().isOnline, listen: () => () => {} };
  const store = createPlanStore(planId, {
    transport: opts.transport,
    storage,
    now: opts.now,
    timers: opts.timers,
    newId: opts.newId,
    env: quiet,
    // the "saving them now" note is for the editor; refusals are reported by the caller, with the plan's name
    notify: (message, kind) => {
      if (kind === "error" && !refused.includes(message)) refused.push(message);
    },
  });
  try {
    await store.load();
    if (store.getState().loaded) await store.flushNow();
  } catch (err) {
    console.error(err);
  }
  const s = store.getState();
  // not loaded (offline, signed out…): the outbox wasn't touched
  const unsaved = s.loaded ? store.hasUnsaved() : hasOutbox(storage, planId);
  const name = s.plan?.name ?? readStored(storage, planId).name;
  store.dispose();
  return { planId, name, unsaved, signedOut: s.save.state === "signedOut", notFound: s.notFound, refused };
}

const quote = (name: string | null) => (name ? `“${name}”` : "an event plan");

/** "Changes to “A” …", "… to “A” and “B” …", "… to “A”, “B” and 2 more plans …". */
export function leftoverMessage(names: (string | null)[]): string {
  const q = names.map(quote);
  const list = q.length <= 2 ? q.join(" and ") : `${q.slice(0, 2).join(", ")} and ${q.length - 2} more ${q.length - 2 === 1 ? "plan" : "plans"}`;
  return `Changes to ${list} made on this device haven't reached the server yet. They're kept here and will be saved when the connection is back.`;
}

/** Plans already reported this session (not repeated on every visit to the home page while still offline). */
const told = new Set<string>();

/** Tell the owner what's still only on this device, and what the server refused. */
// a long sentence: give it time to be read
const defaultSay: Notifier = (m, k) => void defaultNotify(m, k, k === "info" ? { duration: 9000 } : {});

export function reportLeftovers(results: LeftoverResult[], say: Notifier = defaultSay) {
  for (const r of results) {
    if (!r.unsaved) told.delete(r.planId);
    for (const reason of r.refused.slice(0, 2)) say(`${quote(r.name)}: ${reason}`, "error");
  }
  // signed out: the sign-in screen takes over, and the home page tries again after
  const fresh = results.filter((r) => r.unsaved && !r.signedOut && !r.notFound && !told.has(r.planId));
  for (const r of fresh) told.add(r.planId);
  if (fresh.length) say(leftoverMessage(fresh.map((r) => r.name)), "info");
}

/**
 * For the home page: send leftover outboxes shortly after it opens, when
 * the connection comes back and when the app returns to the foreground
 * (iPad Safari may not say `online` to a page that was asleep). Returns the
 * cleanup for useEffect.
 */
export function startBackgroundSave(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    void flushStoredOutboxes().then(
      (results) => {
        if (!stopped) reportLeftovers(results);
      },
      (err) => console.error(err),
    );
  };
  const soon = (ms: number) => {
    if (timer === null && !stopped) timer = setTimeout(run, ms);
  };
  const onOnline = () => soon(0);
  const onVisibility = () => {
    if (document.visibilityState === "visible") soon(0);
  };
  soon(BACKGROUND_DELAY_MS);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
