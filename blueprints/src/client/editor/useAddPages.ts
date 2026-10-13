// "Add pages": uploads the chosen files one after another into a plan, with
// a progress row per file. Each finished upload hands its new pages to the
// plan's editor straight away (they show up as "Preparing…" and the editor
// polls until they're rendered).
//
// The queue lives in this module, not in the editor: leaving the plan
// mid-way doesn't drop the files still waiting. They keep going one by one,
// and a toast says how each went — naming the plan once the owner is no
// longer in it. Coming back to the plan shows the rows still in progress.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ApiError, uploadFile, type UploadHandle } from "../api";
import type { PageRow } from "../../shared/types";
import { notify } from "../ui/notify";
import type { PlanStore } from "../sync";
import { openEditorStore } from "./actions";
import { checkUploadFile, plural } from "./format";

export interface UploadItem {
  id: number;
  name: string;
  /** 0..1 while sending; null while waiting in line or while the server checks the file. */
  progress: number | null;
  phase: "waiting" | "sending" | "checking";
}

export interface AddPages {
  items: UploadItem[];
  busy: boolean;
  addFiles(files: File[]): void;
  cancel(id: number): void;
}

/** What the queues need from the outside (tests pass fakes). */
export interface UploadDeps {
  upload(file: File, planId: string, onProgress: (fraction: number) => void): UploadHandle;
  /** The store of the editor that has this plan open (null: none is). */
  storeFor(planId: string): PlanStore | null;
  notify(message: string, kind: "ok" | "error"): void;
}

interface PlanQueue {
  planId: string;
  /** For the toasts once the owner has left the plan. */
  planName: string | null;
  /** Immutable: replaced on every change (useSyncExternalStore compares references). */
  items: UploadItem[];
  jobs: { id: number; file: File }[];
  current: { id: number; handle: UploadHandle } | null;
  listeners: Set<() => void>;
  /** The open editor's "pages arrived" callbacks. */
  added: Set<(pages: PageRow[]) => void>;
}

const NO_ITEMS: UploadItem[] = [];

export function createUploadQueues(deps: UploadDeps) {
  const queues = new Map<string, PlanQueue>();
  let seq = 0;

  const queueFor = (planId: string): PlanQueue => {
    let q = queues.get(planId);
    if (!q) {
      q = { planId, planName: null, items: NO_ITEMS, jobs: [], current: null, listeners: new Set(), added: new Set() };
      queues.set(planId, q);
    }
    return q;
  };

  const setItems = (q: PlanQueue, items: UploadItem[]) => {
    q.items = items;
    q.listeners.forEach((l) => l());
  };
  const patch = (q: PlanQueue, id: number, p: Partial<UploadItem>) => setItems(q, q.items.map((it) => (it.id === id ? { ...it, ...p } : it)));
  const drop = (q: PlanQueue, id: number) => setItems(q, q.items.filter((it) => it.id !== id));

  /** " to “Spring concert”" when the owner isn't in that plan's editor any more. */
  const where = (q: PlanQueue, store: PlanStore | null) => (store || !q.planName ? "" : ` to “${q.planName}”`);

  function next(q: PlanQueue) {
    if (q.current) return;
    const job = q.jobs.shift();
    if (!job) return;
    const { id, file } = job;
    const handle = deps.upload(file, q.planId, (f) => {
      // every byte sent: the server is still checking the file and counting its pages
      patch(q, id, f >= 1 ? { phase: "checking", progress: null } : { phase: "sending", progress: f });
    });
    q.current = { id, handle };
    patch(q, id, { phase: "sending", progress: 0 });
    handle.promise.then(
      (res) => {
        q.current = null;
        drop(q, id);
        const store = deps.storeFor(q.planId);
        if (store) store.mergePages(res.pages);
        q.added.forEach((fn) => fn(res.pages));
        deps.notify(`Added ${plural(res.pages.length, "page")} from “${file.name}”${where(q, store)}.`, "ok");
        next(q);
      },
      (err: unknown) => {
        q.current = null;
        drop(q, id);
        const cancelled = err instanceof ApiError && err.status === 0 && err.message === "Upload cancelled.";
        if (!cancelled) {
          const why = err instanceof ApiError && err.message ? err.message : "The upload didn't finish.";
          deps.notify(`“${file.name}” wasn't added${where(q, deps.storeFor(q.planId))}. ${why}`, "error");
        }
        next(q);
      },
    );
  }

  return {
    items: (planId: string): UploadItem[] => queues.get(planId)?.items ?? NO_ITEMS,

    subscribe(planId: string, fn: () => void): () => void {
      const q = queueFor(planId);
      q.listeners.add(fn);
      return () => q.listeners.delete(fn);
    },

    /** The editor hears about each file's new pages (after they're in its store). */
    onAdded(planId: string, fn: (pages: PageRow[]) => void): () => void {
      const q = queueFor(planId);
      q.added.add(fn);
      return () => q.added.delete(fn);
    },

    add(planId: string, files: File[], planName: string | null) {
      const q = queueFor(planId);
      if (planName) q.planName = planName;
      const fresh: UploadItem[] = [];
      for (const file of files) {
        const problem = checkUploadFile(file);
        if (problem) {
          deps.notify(problem, "error");
          continue;
        }
        const id = ++seq;
        q.jobs.push({ id, file });
        fresh.push({ id, name: file.name || "Blueprint", progress: null, phase: "waiting" });
      }
      if (!fresh.length) return;
      setItems(q, [...q.items, ...fresh]);
      next(q);
    },

    cancel(planId: string, id: number) {
      const q = queues.get(planId);
      if (!q) return;
      if (q.current?.id === id) {
        q.current.handle.abort(); // the rejection handler moves on to the next file
        return;
      }
      q.jobs = q.jobs.filter((j) => j.id !== id);
      drop(q, id);
    },
  };
}

export type UploadQueues = ReturnType<typeof createUploadQueues>;

/** The app's queues: real uploads, the open editor's store, real toasts. */
const queues = createUploadQueues({
  upload: (file, planId, onProgress) => uploadFile(file, { planId }, onProgress),
  storeFor: openEditorStore,
  notify: (message, kind) => void notify(message, kind),
});

export function useAddPages(store: PlanStore, planId: string, onAdded?: (pages: PageRow[]) => void): AddPages {
  const subscribe = useCallback((fn: () => void) => queues.subscribe(planId, fn), [planId]);
  const getItems = useCallback(() => queues.items(planId), [planId]);
  const items = useSyncExternalStore(subscribe, getItems, getItems);

  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  useEffect(() => queues.onAdded(planId, (pages) => onAddedRef.current?.(pages)), [planId]);

  const addFiles = useCallback((files: File[]) => queues.add(planId, files, store.getState().plan?.name ?? null), [planId, store]);
  const cancel = useCallback((id: number) => queues.cancel(planId, id), [planId]);

  // stable while nothing changes: the (memoized) sidebar takes this object as a prop
  return useMemo(() => ({ items, busy: items.length > 0, addFiles, cancel }), [items, addFiles, cancel]);
}
