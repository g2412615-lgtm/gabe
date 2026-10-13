// The editor for one event plan (SPEC §7.6):
//
//   header.ed-header      back · plan name · page switcher · modes · undo/redo · save · help
//   div.ed-body
//     aside.ed-left       Pages | Notes (rail when collapsed; a drawer below 900 px)
//     main.ed-stage       the blueprint (or a placeholder) + the floating comments panel
//
// The plan store is the single source of truth for the plan's rows and
// autosaves every change; this component holds only view state: which page
// is open, which circle is selected or hovered, the tool, the sidebar.
//
// The comments panel follows the pointer on a desktop: it shows a hovered
// circle (unless the owner is busy in the panel) and falls back to the
// selected one 700 ms after the hover ends. Moving into the panel keeps the
// hovered circle — for good once the owner does something there.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { APP_NAME } from "../../shared/constants";
import type { View } from "../../shared/geometry";
import type { CircleRow, PageRow } from "../../shared/types";
import { addLeaveGuard, goToLogin, replaceQuery } from "../router";
import { setToastOffset } from "../ui/notify";
import { useMediaQuery } from "../ui/media";
import { createPlanStore, usePlanState } from "../sync";
import BlueprintCanvas, { type CanvasGestureEvent, type CanvasHandle, type CanvasMode } from "./canvas/BlueprintCanvas";
import { deleteCircleWithUndo, retryPage } from "./actions";
import CommentsPanel from "./CommentsPanel";
import EditorHeader from "./EditorHeader";
import PageSidebar, { type SidebarTab } from "./PageSidebar";
import { PREF_LEFT_COLLAPSED, readPref, writePref } from "./prefs";
import { EditorLoading, EditorMessage, FailedCard, NoPagesCard, PreparingCard } from "./StageStates";
import { useAddPages } from "./useAddPages";
import { useEditorKeys } from "./useEditorKeys";

export interface EditorPageProps {
  planId: string;
  initialPageId: string | null;
  initialCircleId: string | null;
}

/** Width of the floating comments panel (keep in step with editor.css). */
const PANEL_W = 340;
/** How long the panel keeps showing a circle after the pointer leaves it. */
const HOVER_LINGER_MS = 700;
/** The panel's slide-out, before its content goes. */
const PANEL_OUT_MS = 180;
/** Toasts sit this far up, clear of the canvas's zoom bar (px from the bottom). */
const ZOOM_CLEAR = { mouse: 66, touch: 82 };
/** How often page render status is polled while pages are being prepared. */
const POLL_MS = 1500;

const NO_CIRCLES: CircleRow[] = [];

const viewable = (p: PageRow | null): p is PageRow => !!p && (p.status === "preview" || p.status === "ready");
const preparing = (p: PageRow) => p.status === "queued" || p.status === "rendering" || p.status === "preview";

export default function EditorPage({ planId, initialPageId, initialCircleId }: EditorPageProps) {
  const store = useMemo(() => createPlanStore(planId), [planId]);
  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);

  // Cleared in the layout phase of unmounting, before any passive cleanup
  // (the store's dispose, a closing comment draft): child components ask
  // it before writing to a store that's on its way out.
  const aliveRef = useRef(true);
  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const editorAlive = useCallback(() => aliveRef.current, []);

  // ── store state ──────────────────────────────────────────────────────
  const loaded = usePlanState(store, (s) => s.loaded);
  const loadError = usePlanState(store, (s) => s.loadError);
  const notFound = usePlanState(store, (s) => s.notFound);
  const plan = usePlanState(store, (s) => s.plan);
  const pages = usePlanState(store, (s) => s.pages);
  const pageById = usePlanState(store, (s) => s.pageById);
  const circleById = usePlanState(store, (s) => s.circleById);
  const circlesByPage = usePlanState(store, (s) => s.circlesByPage);
  const save = usePlanState(store, (s) => s.save);
  const canUndo = usePlanState(store, (s) => s.canUndo);
  const canRedo = usePlanState(store, (s) => s.canRedo);

  // ── view state ───────────────────────────────────────────────────────
  const [pageId, setPageId] = useState<string | null>(initialPageId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The circle the pointer is on (or just left: kept for HOVER_LINGER_MS). */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** A Notes row under the pointer lights its circle. */
  const [notesLit, setNotesLit] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>("move");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tab, setTab] = useState<SidebarTab>("pages");
  const [collapsed, setCollapsed] = useState(() => readPref(PREF_LEFT_COLLAPSED) === "1");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const narrow = useMediaQuery("(max-width: 899px)");
  const sheet = useMediaQuery("(max-width: 699px)");

  // what makes the panel "busy" (it then ignores hover)
  const [typingInPanel, setTypingInPanel] = useState(false);
  const [pointerInPanel, setPointerInPanel] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  const views = useRef(new Map<string, View>());
  /** Zoom to this circle once its page's canvas is up. */
  const pendingFocus = useRef<{ pageId: string; circleId: string } | null>(null);
  /** The circle that should get the composer's focus when its panel opens (added with a mouse). */
  const composerFocusFor = useRef<string | null>(null);
  const lastPointer = useRef<string>("mouse");
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Hovered circle kept by moving into the panel; undone if the pointer leaves without doing anything. */
  const tentativePin = useRef<{ id: string; prev: string | null } | null>(null);
  const lastPageIndex = useRef(0);
  const initDone = useRef(false);

  const page = (pageId && pageById.get(pageId)) || null;
  const pageIndex = page ? pages.indexOf(page) : -1;

  // ── first load: the page and circle from the URL ─────────────────────
  useEffect(() => {
    if (!loaded) return;
    if (!initDone.current) {
      initDone.current = true;
      const st = store.getState();
      let pid = initialPageId && st.pageById.has(initialPageId) ? initialPageId : null;
      const c = initialCircleId ? st.circleById.get(initialCircleId) : undefined;
      if (c) {
        pid = c.pageId;
        setSelectedId(c.id);
        pendingFocus.current = { pageId: c.pageId, circleId: c.id };
      }
      setPageId(pid ?? st.pages[0]?.id ?? null);
      return;
    }
    // The open page went away (deleted here, undone, or on the other
    // device): open the one that took its place in the list.
    if (pageId && pageById.has(pageId)) {
      lastPageIndex.current = pages.findIndex((p) => p.id === pageId);
      return;
    }
    const next = pages[Math.min(Math.max(lastPageIndex.current, 0), pages.length - 1)] ?? null;
    if ((next?.id ?? null) !== pageId) setPageId(next?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, pageId, pageById, pages]);

  // A plan opened while signed out: sign in first (nothing here yet to keep).
  useEffect(() => {
    if (!loaded && save.state === "signedOut") goToLogin();
  }, [loaded, save.state]);

  // The selection belongs to the open page and must still exist.
  useEffect(() => {
    if (!selectedId) return;
    const c = circleById.get(selectedId);
    if (!c || c.pageId !== pageId) setSelectedId(null);
  }, [selectedId, circleById, pageId]);

  // ── what the comments panel shows ────────────────────────────────────
  const selected = (selectedId && circleById.get(selectedId)) || null;
  const hovered = (hoverId && circleById.get(hoverId)) || null;
  const open0 = !!(selected || hovered);
  const busy = open0 && (typingInPanel || pointerInPanel || drafting);
  const shown: CircleRow | null = (!busy && hovered && hovered.pageId === pageId ? hovered : null) ?? selected;
  const shownId = shown?.id ?? null;

  // Keep the last circle on screen while the panel slides out.
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const prevShown = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevShown.current;
    prevShown.current = shownId;
    if (shownId || !prev) {
      setOutgoing(null);
      return;
    }
    setOutgoing(prev);
    const t = setTimeout(() => setOutgoing(null), PANEL_OUT_MS);
    return () => clearTimeout(t);
  }, [shownId]);
  const panelCircle = shown ?? (outgoing ? circleById.get(outgoing) ?? null : null);
  const panelOpen = !!shown;

  // A different circle in the panel (or none) closes any comment being
  // edited, and re-reads where focus and the pointer are: a focused field
  // that's removed from the page doesn't always report its blur.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setEditingId(null);
    const a = document.activeElement;
    setTypingInPanel(!!shownId && !!asideRef.current?.contains(a) && isTextField(a));
    if (!shownId) setPointerInPanel(false);
  }, [shownId]);

  // The panel floats over the blueprint: fit/zoom and the zoom buttons keep
  // clear of it, and so do the toasts.
  const rightInset = panelOpen && !sheet ? PANEL_W : 0;
  const coarse = useMediaQuery("(pointer: coarse)");
  useEffect(() => {
    // above the zoom bar (bottom right of the stage), and left of the panel when it's out
    const bottom = coarse ? ZOOM_CLEAR.touch : ZOOM_CLEAR.mouse;
    if (panelOpen && sheet) setToastOffset({ bottom: Math.round(window.innerHeight * 0.6) + 12 });
    else setToastOffset({ right: panelOpen ? PANEL_W + 20 : 20, bottom });
  }, [panelOpen, sheet, coarse]);
  useEffect(() => () => setToastOffset(null), []);

  // ── canvas callbacks (stable: the canvas is memoized) ────────────────
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const onHover = useCallback((id: string | null) => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = null;
    if (id) setHoverId(id);
    else lingerTimer.current = setTimeout(() => setHoverId(null), HOVER_LINGER_MS);
  }, []);
  useEffect(() => () => void (lingerTimer.current && clearTimeout(lingerTimer.current)), []);

  const onSelect = useCallback((id: string | null) => {
    tentativePin.current = null;
    setSelectedId(id);
  }, []);

  const onAdd = useCallback(
    (c: { x: number; y: number; r: number }) => {
      const pid = pageIdRef.current;
      if (!pid) return;
      const id = store.addCircle({ pageId: pid, x: c.x, y: c.y, r: c.r });
      tentativePin.current = null;
      setSelectedId(id);
      setHoverId(null);
      setMode("move");
      // with a mouse the keyboard is right there: start the first comment
      if (lastPointer.current === "mouse") composerFocusFor.current = id;
    },
    [store],
  );

  const onGesture = useCallback(
    (e: CanvasGestureEvent) => {
      switch (e.phase) {
        case "start":
          store.beginGesture();
          break;
        case "update":
          store.updateCircle(e.id, e.kind === "move" ? { x: e.x, y: e.y } : { r: e.r }, { live: true });
          break;
        case "end":
          store.endGesture();
          break;
        case "cancel":
          store.cancelGesture();
          break;
      }
    },
    [store],
  );

  const onViewChange = useCallback((v: View) => {
    const pid = pageIdRef.current;
    if (pid) views.current.set(pid, v);
  }, []);

  const cancelAdd = useCallback(() => setMode("move"), []);

  // Zoom to a circle once the right canvas is mounted (a page switch remounts it).
  const canvasPageId = viewable(page) ? page.id : null;
  useEffect(() => {
    const f = pendingFocus.current;
    if (!f || f.pageId !== canvasPageId || !canvasRef.current) return;
    pendingFocus.current = null;
    canvasRef.current.focusCircle(f.circleId);
  });

  // ── navigation ───────────────────────────────────────────────────────
  const openPage = useCallback(
    (id: string) => {
      if (id !== pageIdRef.current) {
        setPageId(id);
        setSelectedId(null);
        setHoverId(null);
        setNotesLit(null);
      }
      if (narrow) setDrawerOpen(false);
    },
    [narrow],
  );

  const stepPage = useCallback(
    (delta: -1 | 1) => {
      const list = store.getState().pages;
      const i = list.findIndex((p) => p.id === pageIdRef.current);
      const next = list[i + delta];
      if (i >= 0 && next) openPage(next.id);
    },
    [store, openPage],
  );

  const openCircle = useCallback(
    (c: CircleRow) => {
      tentativePin.current = null;
      setPageId(c.pageId);
      setSelectedId(c.id);
      setHoverId(null);
      setNotesLit(null);
      pendingFocus.current = { pageId: c.pageId, circleId: c.id };
      if (narrow) setDrawerOpen(false);
    },
    [narrow],
  );

  const toggleSidebar = useCallback(() => {
    if (narrow) {
      setDrawerOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      writePref(PREF_LEFT_COLLAPSED, c ? null : "1");
      return !c;
    });
  }, [narrow]);

  const showPages = useCallback(() => {
    setTab("pages");
    if (narrow) setDrawerOpen(true);
    else if (collapsed) {
      setCollapsed(false);
      writePref(PREF_LEFT_COLLAPSED, null);
    }
  }, [narrow, collapsed]);

  // The drawer only exists on narrow screens.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  // Leaving add mode's stage or the page: forget a lingering hover.
  useEffect(() => {
    if (mode === "add") setHoverId(null);
  }, [mode]);

  // ── the panel's busy signals and the hover pin ───────────────────────
  const onPanelPointerEnter = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    setPointerInPanel(true);
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = null;
    // keep the hovered circle: it becomes the selection (for now)
    if (shownId && shownId !== selectedId) {
      tentativePin.current = { id: shownId, prev: selectedId };
      setSelectedId(shownId);
    }
    setHoverId(null);
  };
  const onPanelPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    setPointerInPanel(false);
    // only looked: go back to what was selected before
    const t = tentativePin.current;
    tentativePin.current = null;
    if (t && selectedRef.current === t.id) setSelectedId(t.prev);
  };
  const confirmPin = () => {
    tentativePin.current = null;
  };
  const onPanelFocus = (e: FocusEvent) => {
    confirmPin();
    setTypingInPanel(isTextField(e.target));
  };
  const onPanelBlur = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !e.currentTarget.contains(next)) setTypingInPanel(false);
  };

  const closePanel = useCallback(() => {
    tentativePin.current = null;
    setSelectedId(null);
    setHoverId(null);
  }, []);

  const takeComposerFocus = useCallback((circleId: string) => {
    if (composerFocusFor.current !== circleId) return false;
    composerFocusFor.current = null;
    return true;
  }, []);

  // ── uploads ("Add pages") ────────────────────────────────────────────
  const uploads = useAddPages(store, planId, (added) => {
    // a plan with no open page yet: show the first new one
    if (!pageIdRef.current && added[0]) setPageId(added[0].id);
  });

  // ── polling while pages are being prepared ───────────────────────────
  const needsPoll = loaded && pages.some(preparing);
  useEffect(() => {
    if (!needsPoll) return;
    let inFlight = false;
    const t = setInterval(() => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void store.refreshPages().finally(() => {
        inFlight = false;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [needsPoll, store]);

  // ── URL, title, leaving ──────────────────────────────────────────────
  useEffect(() => {
    if (!loaded || !initDone.current) return;
    replaceQuery({ page: pageId, circle: selectedId });
  }, [loaded, pageId, selectedId]);

  useEffect(() => {
    document.title = plan ? `${plan.name} · ${APP_NAME}` : APP_NAME;
  }, [plan]);

  // Never block leaving: start a save; the device outbox keeps anything unsent.
  useEffect(
    () =>
      addLeaveGuard(() => {
        void store.flushNow();
        return true;
      }),
    [store],
  );

  // ── keyboard ─────────────────────────────────────────────────────────
  const state = { mode, editingId, selectedId, drawerOpen, narrow };
  const stateRef = useRef(state);
  stateRef.current = state;

  useEditorKeys({
    moveMode: () => setMode("move"),
    addMode: () => setMode("add"),
    escape: () => {
      const s = stateRef.current;
      if (s.mode === "add") setMode("move");
      else if (s.editingId) setEditingId(null);
      else if (s.selectedId) closePanel();
      else if (s.narrow && s.drawerOpen) setDrawerOpen(false);
      else setHoverId(null);
    },
    deleteSelected: () => {
      const id = stateRef.current.selectedId;
      const c = id ? store.getState().circleById.get(id) : undefined;
      if (!c) return false;
      deleteCircleWithUndo(store, c);
      return true;
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    save: () => void store.flushNow(),
    zoomIn: () => canvasRef.current?.zoomIn(),
    zoomOut: () => canvasRef.current?.zoomOut(),
    fit: () => canvasRef.current?.fit(),
    prevPage: () => stepPage(-1),
    nextPage: () => stepPage(1),
    focusSelected: () => {
      const id = stateRef.current.selectedId;
      if (id) canvasRef.current?.focusCircle(id);
    },
  });

  // ── header callbacks ─────────────────────────────────────────────────
  const onRename = useCallback((name: string) => store.renamePlan(name), [store]);
  const onUndo = useCallback(() => store.undo(), [store]);
  const onRedo = useCallback(() => store.redo(), [store]);
  const onSaveNow = useCallback(() => void store.flushNow(), [store]);
  const onMode = useCallback((m: CanvasMode) => setMode(m), []);

  // ── render ───────────────────────────────────────────────────────────
  if (notFound)
    return (
      <EditorMessage title="This event plan isn't here">
        <p>It may have been deleted, or the link isn't quite right.</p>
      </EditorMessage>
    );

  if (!loaded) {
    if (!loadError || save.state === "signedOut") return <EditorLoading />;
    return (
      <EditorMessage title="This plan can't be opened right now" busy action={<button type="button" onClick={() => void store.load()}>Try now</button>}>
        <p>{loadError}</p>
        <p className="ed-card-note">Trying again by itself…</p>
      </EditorMessage>
    );
  }

  const sidebarShown = narrow ? drawerOpen : !collapsed;
  const litId = notesLit ?? (panelOpen && shownId !== selectedId ? shownId : null);

  let stage: ReactNode;
  if (pages.length === 0) stage = <NoPagesCard uploads={uploads} />;
  else if (!page) stage = null; // a page is being chosen this very moment
  else if (page.status === "failed") stage = <FailedCard page={page} onRetry={() => void retryPage(store, page)} />;
  else if (!viewable(page)) stage = <PreparingCard page={page} />;
  else
    stage = (
      <BlueprintCanvas
        key={page.id}
        ref={canvasRef}
        page={page}
        circles={circlesByPage.get(page.id) ?? NO_CIRCLES}
        selectedId={selectedId}
        litId={litId}
        mode={mode}
        initialView={views.current.get(page.id) ?? null}
        onViewChange={onViewChange}
        onHover={onHover}
        onSelect={onSelect}
        onAdd={onAdd}
        onGesture={onGesture}
        onCancelAdd={cancelAdd}
        rightInset={rightInset}
      />
    );

  return (
    <div className={`ed-root${sheet ? " is-sheet" : ""}`}>
      <EditorHeader
        plan={plan}
        pages={pages}
        pageIndex={pageIndex}
        sidebarOpen={sidebarShown}
        mode={mode}
        canUndo={canUndo}
        canRedo={canRedo}
        save={save}
        onRename={onRename}
        onToggleSidebar={toggleSidebar}
        onShowPages={showPages}
        onPage={stepPage}
        onMode={onMode}
        onUndo={onUndo}
        onRedo={onRedo}
        onSaveNow={onSaveNow}
      />

      {save.state === "signedOut" && (
        <div className="editor-banner" role="alert">
          <span>
            <b>Signed out</b> — your changes are kept on this device. Sign in to finish saving.
          </span>
          <button type="button" className="small" onClick={goToLogin}>
            Sign in
          </button>
        </div>
      )}

      <div className="ed-body">
        <PageSidebar
          store={store}
          currentPageId={pageId}
          selectedId={selectedId}
          tab={tab}
          onTab={setTab}
          collapsed={collapsed}
          drawer={narrow}
          open={drawerOpen}
          onToggle={toggleSidebar}
          onOpenPage={openPage}
          onOpenCircle={openCircle}
          onLit={setNotesLit}
          uploads={uploads}
        />
        {narrow && <div className={`ed-scrim${drawerOpen ? " on" : ""}`} onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

        <main
          className={`ed-stage${panelOpen ? " panel-open" : ""}`}
          onPointerDownCapture={(e) => {
            lastPointer.current = e.pointerType;
          }}
        >
          {stage}

          <aside
            ref={asideRef}
            className={`ed-right${panelOpen ? " open" : ""}${sheet ? " sheet" : ""}`}
            aria-label={panelCircle ? "Circle comments" : undefined}
            aria-hidden={panelOpen ? undefined : true}
            inert={!panelOpen || undefined}
            onPointerEnter={onPanelPointerEnter}
            onPointerLeave={onPanelPointerLeave}
            onPointerDown={confirmPin}
            onKeyDown={confirmPin}
            onFocus={onPanelFocus}
            onBlur={onPanelBlur}
          >
            {panelCircle && (
              <CommentsPanel
                key={panelCircle.id}
                store={store}
                circle={panelCircle}
                editingId={editingId}
                onEditingChange={setEditingId}
                onClose={closePanel}
                onDraftingChange={setDrafting}
                takeComposerFocus={takeComposerFocus}
                editorAlive={editorAlive}
              />
            )}
          </aside>
        </main>
      </div>
    </div>
  );
}

/** A field the owner types in (the panel then holds still while the pointer wanders). */
function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === "text");
}
