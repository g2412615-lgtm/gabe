// Home: "Event plans" — DeployMap's events list, for blueprints. A page head
// with the one primary action (Upload blueprint), a search + sort bar, and a
// list of plan rows. Dropping a file anywhere on the page starts an upload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { goToLogin } from "../router";
import { startBackgroundSave } from "../sync";
import type { PlanSummary } from "../../shared/types";
import AppHeader from "../ui/AppHeader";
import { confirmDialog } from "../ui/Dialog";
import EmptyArt from "../ui/EmptyArt";
import { IconAlert, IconRefresh, IconSearch, IconUpload, IconX } from "../ui/icons";
import { notify } from "../ui/notify";
import { isOverlayOpen } from "../ui/layers";
import PlanRow from "./PlanRow";
import UploadDialog from "./UploadDialog";
import { actionError } from "./format";
import { usePlanList } from "./usePlanList";

type SortKey = "recent" | "name" | "newest";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recently edited" },
  { key: "name", label: "Name" },
  { key: "newest", label: "Newest" },
];
const SORT_STORE = "bpn-home-sort";

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORE);
    if (v === "recent" || v === "name" || v === "newest") return v;
  } catch {
    /* storage off: default */
  }
  return "recent";
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
// case- and accent-insensitive search
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

export default function HomePage() {
  const { plans, status, error, reload, setPlans } = usePlanList();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>(readSort);
  const [upload, setUpload] = useState<{ open: boolean; file: File | null; extra: number }>({ open: false, file: null, extra: 0 });
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

  // send changes an editor left on this device (closed while offline) without reopening that plan
  useEffect(() => startBackgroundSave(), []);

  // keep "edited 5 min ago" honest
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const changeSort = (key: SortKey) => {
    setSort(key);
    try {
      localStorage.setItem(SORT_STORE, key);
    } catch {
      /* not remembered: fine */
    }
  };

  const openUpload = useCallback((files: File[] = []) => {
    setUpload({ open: true, file: files[0] ?? null, extra: Math.max(0, files.length - 1) });
  }, []);
  const closeUpload = useCallback(() => setUpload({ open: false, file: null, extra: 0 }), []);

  // ── drop a file anywhere on the page ──
  const uploadOpen = upload.open;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (!uploadOpen) setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // allow the drop (and stop the browser from opening the file instead)
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      // a Dropzone already took it
      if (e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length && !uploadOpen) openUpload(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadOpen, openUpload]);

  // "/" focuses the search, like most list pages
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isOverlayOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── rename / delete / undo ──
  const renamePlan = useCallback(
    async (plan: PlanSummary, name: string) => {
      const before = plan.name;
      setPlans((list) => list.map((p) => (p.id === plan.id ? { ...p, name } : p)));
      try {
        const row = await api.patchPlan(plan.id, { name });
        setPlans((list) => list.map((p) => (p.id === plan.id ? { ...p, name: row.name, updatedAt: row.updatedAt } : p)));
      } catch (err) {
        setPlans((list) => list.map((p) => (p.id === plan.id ? { ...p, name: before } : p)));
        if (err instanceof ApiError && err.signedOut) return goToLogin();
        notify(actionError(err, "The new name wasn't saved"), "error");
      }
    },
    [setPlans],
  );

  const restorePlan = useCallback(
    async (plan: PlanSummary) => {
      try {
        await api.patchPlan(plan.id, { deleted: false });
        // back in place at once; the reload brings the server's numbers
        setPlans((list) => (list.some((p) => p.id === plan.id) ? list : [...list, plan]));
        notify(`“${plan.name}” is back.`, "ok");
        void reload();
      } catch (err) {
        if (err instanceof ApiError && err.signedOut) return goToLogin();
        notify(actionError(err, `“${plan.name}” wasn't restored`), "error");
      }
    },
    [setPlans, reload],
  );

  const deletePlan = useCallback(
    async (plan: PlanSummary) => {
      const ok = await confirmDialog({
        title: `Delete “${plan.name}”?`,
        body: "Its pages, circles and comments go with it. You can undo this right after.",
        confirmLabel: "Delete plan",
        danger: true,
      });
      if (!ok) return;
      setLeaving((s) => new Set(s).add(plan.id));
      try {
        await api.patchPlan(plan.id, { deleted: true });
        setPlans((list) => list.filter((p) => p.id !== plan.id));
        notify(`Deleted “${plan.name}”.`, "ok", { action: { label: "Undo", run: () => void restorePlan(plan) } });
      } catch (err) {
        if (err instanceof ApiError && err.signedOut) return goToLogin();
        notify(actionError(err, `“${plan.name}” wasn't deleted`), "error");
      } finally {
        setLeaving((s) => {
          const next = new Set(s);
          next.delete(plan.id);
          return next;
        });
      }
    },
    [setPlans, restorePlan],
  );

  // ── what to show ──
  const shown = useMemo(() => {
    const q = fold(query.trim());
    const list = q ? plans.filter((p) => fold(p.name).includes(q)) : plans.slice();
    if (sort === "name") list.sort((a, b) => byName.compare(a.name, b.name));
    else if (sort === "newest") list.sort((a, b) => b.createdAt - a.createdAt);
    else list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [plans, query, sort]);

  const uploadButton = (
    <button type="button" className="primary" onClick={() => openUpload()}>
      <IconUpload size={14} /> Upload blueprint
    </button>
  );

  return (
    <>
      <AppHeader wide />
      <main className="page wide home">
        <div className="page-head">
          <div>
            <h1>Event plans</h1>
            <p className="subtitle">Upload a blueprint, circle the spots that matter, and keep your notes right on them.</p>
          </div>
          <div className="page-actions">{uploadButton}</div>
        </div>

        {error && (
          <div className="banner banner-danger" role="alert">
            <IconAlert size={15} />
            <span>{actionError(error, "Your event plans didn't load")}</span>
            <button type="button" className="small banner-action" onClick={() => void reload()}>
              <IconRefresh size={13} /> Retry
            </button>
          </div>
        )}

        {status === "loading" && (
          <div className="home-skeleton" aria-busy="true" aria-label="Loading event plans">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        )}

        {status === "ready" && plans.length === 0 && !error && (
          <div className="empty">
            <EmptyArt />
            <h3>No event plans yet</h3>
            <p>Upload a blueprint PDF to start. Each page becomes a sheet you can mark up with circles and comments.</p>
            <div className="empty-actions">{uploadButton}</div>
          </div>
        )}

        {status === "ready" && plans.length > 0 && (
          <>
            <div className="home-bar">
              <div className="home-search">
                <IconSearch size={14} />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  placeholder="Search plans"
                  aria-label="Search event plans by name"
                  autoComplete="off"
                  enterKeyHint="search"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.preventDefault();
                      setQuery("");
                    }
                  }}
                />
                {query && (
                  <button type="button" className="ghost small icon-btn search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                    <IconX size={13} />
                  </button>
                )}
              </div>
              {query && (
                <span className="home-count" aria-live="polite">
                  {shown.length} of {plans.length}
                </span>
              )}
              <label className="sort-pick">
                Sort
                <select value={sort} onChange={(e) => changeSort(e.target.value as SortKey)}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {shown.length > 0 ? (
              <div className="event-list">
                {shown.map((p) => (
                  <PlanRow key={p.id} plan={p} now={now} leaving={leaving.has(p.id)} onRename={renamePlan} onDelete={deletePlan} />
                ))}
              </div>
            ) : (
              <p className="home-none">
                No event plans match “{query.trim()}”.{" "}
                <button type="button" className="link" onClick={() => setQuery("")}>
                  Show all
                </button>
              </p>
            )}
          </>
        )}
      </main>

      {dragging && (
        <div className="home-drop" aria-hidden="true">
          <div className="home-drop-box">
            <span className="dz-icon">
              <IconUpload size={22} />
            </span>
            Drop to upload a blueprint
          </div>
        </div>
      )}

      <UploadDialog open={upload.open} initialFile={upload.file} extraFiles={upload.extra} onClose={closeUpload} />
    </>
  );
}
