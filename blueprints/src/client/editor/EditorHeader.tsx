// The editor's top bar: the Kilowatt Events gold band (docs/BRAND.md).
//
//   logo ← Plans ┃ plan name  ☰ ‹ Page 2 of 6 · "A-101 Seating bowl" › … [Move|Circle] [↶|↷] (Saved) (?)
//
// Below 1100 px the button labels give way to icons (names stay in
// aria-label/title); on narrow screens the bar wraps to two rows.

import { memo } from "react";
import { MAX_PLAN_NAME_CHARS } from "../../shared/constants";
import type { PageRow, PlanRow } from "../../shared/types";
import InlineRename from "../ui/InlineRename";
import SaveStatus from "../ui/SaveStatus";
import { IconChevron, IconChevronLeft, IconCircle, IconHand, IconRedo, IconSidebar, IconUndo } from "../ui/icons";
import type { SaveInfo } from "../sync";
import type { CanvasMode } from "./canvas/BlueprintCanvas";
import { isMac } from "./format";
import HeaderHome from "./HeaderHome";
import HelpMenu from "./HelpMenu";

export interface EditorHeaderProps {
  plan: PlanRow | null;
  pages: PageRow[];
  /** Index of the open page among `pages` (-1: none). */
  pageIndex: number;
  sidebarOpen: boolean;
  mode: CanvasMode;
  canUndo: boolean;
  canRedo: boolean;
  save: SaveInfo;
  onRename(name: string): void;
  onToggleSidebar(): void;
  onShowPages(): void;
  onPage(delta: -1 | 1): void;
  onMode(mode: CanvasMode): void;
  onUndo(): void;
  onRedo(): void;
  onSaveNow(): void;
}

function EditorHeader(p: EditorHeaderProps) {
  const page = p.pageIndex >= 0 ? p.pages[p.pageIndex] : null;
  const mod = isMac() ? "⌘" : "Ctrl+";
  const redoKey = isMac() ? "⌘⇧Z" : "Ctrl+Y";

  return (
    <header className="ed-header">
      <HeaderHome />

      <div className="ed-title">
        {p.plan && (
          <InlineRename
            value={p.plan.name}
            onCommit={p.onRename}
            commitWhileTyping
            ariaLabel="Event plan name"
            title="Rename this event plan"
            maxLength={MAX_PLAN_NAME_CHARS}
            className="ed-name"
          />
        )}
      </div>

      <div className="ed-pager">
        <button
          type="button"
          className={`ghost icon-btn ed-side-btn${p.sidebarOpen ? " on" : ""}`}
          onClick={p.onToggleSidebar}
          aria-label={p.sidebarOpen ? "Hide pages and notes" : "Show pages and notes"}
          aria-expanded={p.sidebarOpen}
          title={p.sidebarOpen ? "Hide pages and notes" : "Show pages and notes"}
        >
          <IconSidebar size={16} />
        </button>
        {p.pages.length > 0 && (
          <div className="ed-pages" role="group" aria-label="Page">
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => p.onPage(-1)}
              disabled={p.pageIndex <= 0}
              aria-label="Previous page"
              title="Previous page ([)"
            >
              <IconChevronLeft size={16} />
            </button>
            <button type="button" className="ed-page-name" onClick={p.onShowPages} title="Show all pages">
              {page ? (
                <span className="ed-page-num">
                  <span className="ed-pn-long">
                    Page {p.pageIndex + 1} of {p.pages.length}
                  </span>
                  <span className="ed-pn-short" aria-hidden="true">
                    {p.pageIndex + 1}/{p.pages.length}
                  </span>
                </span>
              ) : (
                <span className="ed-page-num">{p.pages.length === 1 ? "1 page" : `${p.pages.length} pages`}</span>
              )}
              {page && <span className="ed-page-label">{page.label}</span>}
            </button>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => p.onPage(1)}
              disabled={p.pageIndex < 0 || p.pageIndex >= p.pages.length - 1}
              aria-label="Next page"
              title="Next page (])"
            >
              <IconChevron size={16} />
            </button>
          </div>
        )}
      </div>

      <span className="ed-spacer" />
      {/* narrow screens: the bar wraps here into a second row */}
      <span className="ed-break" aria-hidden="true" />

      <div className="hdr-group ed-modes" role="group" aria-label="What a tap on the blueprint does">
        <button
          type="button"
          aria-pressed={p.mode === "move"}
          onClick={() => p.onMode("move")}
          aria-label="Move"
          title="Move — drag to look around, tap a circle to open it (V)"
        >
          <IconHand size={15} />
          <span className="lbl">Move</span>
        </button>
        <button
          type="button"
          aria-pressed={p.mode === "add"}
          onClick={() => p.onMode(p.mode === "add" ? "move" : "add")}
          aria-label="Circle"
          title="Circle — tap the blueprint to add a circle (C)"
        >
          <IconCircle size={15} />
          <span className="lbl">Circle</span>
        </button>
      </div>

      <div className="hdr-group ed-history" role="group" aria-label="Undo and redo">
        <button type="button" onClick={p.onUndo} disabled={!p.canUndo} aria-label="Undo" title={`Undo (${mod}Z)`}>
          <IconUndo size={15} />
        </button>
        <button type="button" onClick={p.onRedo} disabled={!p.canRedo} aria-label="Redo" title={`Redo (${redoKey})`}>
          <IconRedo size={15} />
        </button>
      </div>

      <SaveStatus state={p.save.state} pending={p.save.pending} message={p.save.message} onClick={p.onSaveNow} className="ed-save" />

      <HelpMenu />
    </header>
  );
}

export default memo(EditorHeader);
