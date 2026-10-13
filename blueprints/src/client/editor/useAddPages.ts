// "Add pages": uploads the chosen files one after another into the open
// plan, with a progress row per file. Each finished upload hands its new
// pages to the store straight away (they show up as "Preparing…" and the
// editor polls until they're rendered). Lives at the editor level, so
// closing the sidebar mid-upload doesn't lose track of it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, uploadFile, type UploadHandle } from "../api";
import type { PageRow } from "../../shared/types";
import { notify } from "../ui/notify";
import type { PlanStore } from "../sync";
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

let seq = 0;

export function useAddPages(store: PlanStore, planId: string, onAdded?: (pages: PageRow[]) => void): AddPages {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<{ id: number; file: File }[]>([]);
  const current = useRef<{ id: number; handle: UploadHandle } | null>(null);
  const alive = useRef(true);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  useEffect(() => {
    alive.current = true;
    return () => {
      // Leaving the editor doesn't stop an upload that's on its way: the
      // server adds the pages either way, and they appear next time.
      alive.current = false;
    };
  }, []);

  const patch = (id: number, p: Partial<UploadItem>) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));
  const drop = (id: number) => setItems((list) => list.filter((it) => it.id !== id));

  const next = useCallback(() => {
    if (current.current || !alive.current) return;
    const job = queue.current.shift();
    if (!job) return;
    const { id, file } = job;
    const handle = uploadFile(file, { planId }, (f) => {
      if (!alive.current) return;
      // every byte sent: the server is still checking the file and counting its pages
      patch(id, f >= 1 ? { phase: "checking", progress: null } : { phase: "sending", progress: f });
    });
    current.current = { id, handle };
    patch(id, { phase: "sending", progress: 0 });
    handle.promise.then(
      (res) => {
        current.current = null;
        if (!alive.current) return;
        drop(id);
        store.mergePages(res.pages);
        const n = res.pages.length;
        notify(`Added ${plural(n, "page")} from “${file.name}”.`, "ok");
        onAddedRef.current?.(res.pages);
        next();
      },
      (err: unknown) => {
        current.current = null;
        if (!alive.current) return;
        drop(id);
        const cancelled = err instanceof ApiError && err.status === 0 && err.message === "Upload cancelled.";
        if (!cancelled) {
          const why = err instanceof ApiError && err.message ? err.message : "The upload didn't finish.";
          notify(`“${file.name}” wasn't added. ${why}`, "error");
        }
        next();
      },
    );
  }, [planId, store]);

  const addFiles = useCallback(
    (files: File[]) => {
      const fresh: UploadItem[] = [];
      for (const file of files) {
        const problem = checkUploadFile(file);
        if (problem) {
          notify(problem, "error");
          continue;
        }
        const id = ++seq;
        queue.current.push({ id, file });
        fresh.push({ id, name: file.name || "Blueprint", progress: null, phase: "waiting" });
      }
      if (!fresh.length) return;
      setItems((list) => [...list, ...fresh]);
      next();
    },
    [next],
  );

  const cancel = useCallback((id: number) => {
    if (current.current?.id === id) {
      current.current.handle.abort(); // the rejection handler moves on to the next file
      return;
    }
    queue.current = queue.current.filter((j) => j.id !== id);
    drop(id);
  }, []);

  // stable while nothing changes: the (memoized) sidebar takes this object as a prop
  return useMemo(() => ({ items, busy: items.length > 0, addFiles, cancel }), [items, addFiles, cancel]);
}
