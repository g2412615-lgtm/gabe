// The left sidebar: Pages | Notes tabs (DeployMap's .evtabs, with the KWE gold underline).
//
//  - Pages: a thumbnail per page with its label, circle count and render
//    status; a ⋯ menu to rename, reorder and delete; "Add pages" uploads
//    more files into the plan, with a progress row per file.
//  - Notes: NotesList.
//
// On a wide screen it sits beside the blueprint and collapses to a 56 px
// rail of page numbers; below 900 px it's a drawer over the blueprint that
// closes once a page is chosen (the editor owns those states).

import { memo, useState } from "react";
import { assetUrl } from "../api";
import { MAX_LABEL_CHARS } from "../../shared/constants";
import type { CircleRow, PageRow } from "../../shared/types";
import { confirmDialog } from "../ui/Dialog";
import Dropzone from "../ui/Dropzone";
import InlineRename from "../ui/InlineRename";
import Menu from "../ui/Menu";
import Progress from "../ui/Progress";
import Spinner from "../ui/Spinner";
import { IconChevron, IconEdit, IconLayers, IconList, IconMore, IconSidebar, IconTrash, IconUpload, IconX } from "../ui/icons";
import { usePlanState, type PlanStore } from "../sync";
import { deletePageWithUndo, retryPage } from "./actions";
import { plural } from "./format";
import NotesList from "./NotesList";
import type { AddPages, UploadItem } from "./useAddPages";

export type SidebarTab = "pages" | "notes";

export interface PageSidebarProps {
  store: PlanStore;
  currentPageId: string | null;
  selectedId: string | null;
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  /** Wide screens: shrunk to the rail of page numbers. */
  collapsed: boolean;
  /** Narrow screens: the sidebar is a drawer over the blueprint… */
  drawer: boolean;
  /** …and this says whether it's out. */
  open: boolean;
  /** Collapse/expand (wide) or close (drawer). */
  onToggle(): void;
  onOpenPage(id: string): void;
  onOpenCircle(c: CircleRow): void;
  onLit(id: string | null): void;
  uploads: AddPages;
}

const NONE: CircleRow[] = [];

function PageSidebar(p: PageSidebarProps) {
  const pages = usePlanState(p.store, (s) => s.pages);
  const circlesByPage = usePlanState(p.store, (s) => s.circlesByPage);
  const circleCount = usePlanState(p.store, (s) => s.circleById.size);
  const rail = p.collapsed && !p.drawer;
  const hidden = p.drawer && !p.open;

  const cls = ["ed-left", rail && "rail", p.drawer && "drawer", p.drawer && p.open && "open"].filter(Boolean).join(" ");

  if (rail) {
    return (
      <aside className={cls} aria-label="Pages">
        <button type="button" className="ghost icon-btn ps-expand" onClick={p.onToggle} aria-label="Show pages and notes" title="Show pages and notes">
          <IconSidebar size={16} />
        </button>
        <ol className="ps-rail">
          {pages.map((page, i) => {
            const active = page.id === p.currentPageId;
            return (
              <li key={page.id}>
                <button
                  type="button"
                  className={`ps-rail-btn${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  aria-label={`Page ${i + 1}: ${page.label}`}
                  title={page.label}
                  onClick={() => p.onOpenPage(page.id)}
                >
                  {i + 1}
                  {(page.status === "queued" || page.status === "rendering") && <span className="ps-rail-flag busy" aria-hidden="true" />}
                  {page.status === "failed" && <span className="ps-rail-flag failed" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ol>
      </aside>
    );
  }

  return (
    <aside className={cls} aria-label="Pages and notes" inert={hidden || undefined} aria-hidden={hidden || undefined}>
      <div className="ps-top">
        <div className="evtabs ps-tabs" role="tablist" aria-label="Sidebar">
          <button
            type="button"
            role="tab"
            id="ps-tab-pages"
            aria-controls="ps-panel"
            aria-selected={p.tab === "pages"}
            className="evtab"
            onClick={() => p.onTab("pages")}
          >
            <IconLayers size={14} />
            Pages
            <span className="evtab-badge">{pages.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="ps-tab-notes"
            aria-controls="ps-panel"
            aria-selected={p.tab === "notes"}
            className="evtab"
            onClick={() => p.onTab("notes")}
          >
            <IconList size={14} />
            Notes
            <span className="evtab-badge">{circleCount}</span>
          </button>
        </div>
        <button
          type="button"
          className="ghost icon-btn ps-collapse"
          onClick={p.onToggle}
          aria-label={p.drawer ? "Close pages and notes" : "Collapse the sidebar"}
          title={p.drawer ? "Close" : "Collapse the sidebar"}
        >
          {p.drawer ? <IconX size={16} /> : <IconSidebar size={16} />}
        </button>
      </div>

      <div className="ps-body" role="tabpanel" id="ps-panel" aria-labelledby={p.tab === "pages" ? "ps-tab-pages" : "ps-tab-notes"}>
        {p.tab === "pages" ? (
          <>
            <ol className="ps-pages">
              {pages.map((page, i) => (
                <PageItem
                  key={page.id}
                  store={p.store}
                  page={page}
                  index={i}
                  count={pages.length}
                  active={page.id === p.currentPageId}
                  circles={circlesByPage.get(page.id) ?? NONE}
                  onOpen={p.onOpenPage}
                />
              ))}
            </ol>
            {pages.length === 0 && <p className="ps-none">No pages yet. Add a blueprint below.</p>}
          </>
        ) : (
          <NotesList store={p.store} currentPageId={p.currentPageId} selectedId={p.selectedId} onLit={p.onLit} onOpen={p.onOpenCircle} />
        )}
      </div>

      {p.tab === "pages" && (
        <div className="ps-foot">
          {p.uploads.items.map((it) => (
            <UploadRow key={it.id} item={it} onCancel={() => p.uploads.cancel(it.id)} />
          ))}
          <Dropzone
            compact
            multiple
            onFiles={p.uploads.addFiles}
            icon={<IconUpload size={16} />}
            title="Add pages"
            hint="PDF, PNG or JPG"
            className="ps-add"
          />
        </div>
      )}
    </aside>
  );
}

export default memo(PageSidebar);

// ── one page ───────────────────────────────────────────────────────────

interface PageItemProps {
  store: PlanStore;
  page: PageRow;
  index: number;
  count: number;
  active: boolean;
  circles: CircleRow[];
  onOpen(id: string): void;
}

const PageItem = memo(function PageItem({ store, page, index, count, active, circles, onOpen }: PageItemProps) {
  const [renaming, setRenaming] = useState(false);

  const askDelete = async () => {
    const st = store.getState();
    const nComments = circles.reduce((n, c) => n + (st.commentsByCircle.get(c.id)?.length ?? 0), 0);
    const ok = await confirmDialog({
      title: `Delete page “${page.label}”?`,
      body:
        circles.length > 0
          ? `Its ${plural(circles.length, "circle")} and ${plural(nComments, "comment")} go with it. You can undo this right after.`
          : "You can undo this right after.",
      confirmLabel: "Delete page",
      danger: true,
    });
    if (!ok) return;
    deletePageWithUndo(store, page, () => onOpen(page.id));
  };

  const status = <PageStatusLine page={page} circles={circles.length} />;

  return (
    <li className={`ps-page${active ? " active" : ""}${page.status === "failed" ? " failed" : ""}`}>
      {renaming ? (
        <div className="ps-open renaming">
          <PageThumb page={page} />
          <span className="ps-text">
            <InlineRename
              value={page.label}
              editing
              onEditingChange={setRenaming}
              onCommit={(label) => store.renamePage(page.id, label)}
              commitWhileTyping
              ariaLabel="Page name"
              maxLength={MAX_LABEL_CHARS}
              className="ps-rename"
            />
            {status}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="ps-open"
          onClick={() => onOpen(page.id)}
          onDoubleClick={() => setRenaming(true)}
          aria-current={active ? "page" : undefined}
          title={`${page.label} — double-click to rename`}
        >
          <PageThumb page={page} />
          <span className="ps-text">
            <span className="ps-label">
              <span className="ps-index">{index + 1}</span>
              {page.label}
            </span>
            {status}
          </span>
        </button>
      )}
      <div className="ps-acts">
        <Menu
          label={<IconMore size={16} />}
          ariaLabel={`More for “${page.label}”`}
          title="Rename, move or delete"
          buttonClassName="ghost small icon-btn ps-more"
          align="right"
          items={[
            { label: "Rename", icon: <IconEdit size={14} />, onSelect: () => setRenaming(true) },
            {
              label: "Move up",
              icon: <IconChevron size={14} className="rot-up" />,
              disabled: index === 0,
              onSelect: () => store.movePage(page.id, index - 1),
            },
            {
              label: "Move down",
              icon: <IconChevron size={14} className="rot-down" />,
              disabled: index >= count - 1,
              onSelect: () => store.movePage(page.id, index + 1),
            },
            "separator",
            { label: "Delete page…", icon: <IconTrash size={14} />, danger: true, onSelect: () => void askDelete() },
          ]}
        />
        {page.status === "failed" && (
          <button type="button" className="small ps-retry" onClick={() => void retryPage(store, page)}>
            Retry
          </button>
        )}
      </div>
    </li>
  );
});

function PageStatusLine({ page, circles }: { page: PageRow; circles: number }) {
  if (page.status === "queued" || page.status === "rendering")
    return (
      <span className="ps-meta">
        <Spinner size={10} /> Preparing…
      </span>
    );
  if (page.status === "failed")
    return (
      <span className="ps-meta ps-failed" title={page.error ?? undefined}>
        Couldn't prepare this page
      </span>
    );
  return (
    <span className="ps-meta">
      {plural(circles, "circle")}
      {page.status === "preview" && <span className="ps-sharpen"> · Sharpening…</span>}
    </span>
  );
}

/** The page on white; a placeholder until an image exists. */
function PageThumb({ page }: { page: PageRow }) {
  // The thumbnail is written just after the preview: while the page is at
  // "preview", the preview image is the one that certainly exists.
  const src = page.assetKey ? (page.status === "ready" ? assetUrl.thumb(page) : page.status === "preview" ? assetUrl.preview(page) : null) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && failedSrc !== src)
    return (
      <span className="ps-thumb">
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedSrc(src)} />
      </span>
    );
  return (
    <span className="ps-thumb placeholder" aria-hidden="true">
      {page.status === "queued" || page.status === "rendering" ? <Spinner size={14} /> : <IconLayers size={18} />}
    </span>
  );
}

function UploadRow({ item, onCancel }: { item: UploadItem; onCancel: () => void }) {
  const label =
    item.phase === "waiting" ? `Waiting · ${item.name}` : item.phase === "checking" ? `Checking ${item.name}…` : `Uploading ${item.name}…`;
  return (
    <div className="ps-upload">
      <Progress
        value={item.phase === "sending" ? item.progress : item.phase === "waiting" ? 0 : null}
        label={label}
        showPercent={item.phase === "sending"}
      />
      <button
        type="button"
        className="ghost small icon-btn"
        onClick={onCancel}
        disabled={item.phase === "checking"}
        aria-label={`Cancel ${item.name}`}
        title={item.phase === "checking" ? "Almost done — the server is checking the file" : "Cancel"}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
