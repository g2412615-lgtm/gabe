// The Notes tab: every circle in the plan, grouped by page in page order —
// colour, number, its name (or the start of its first comment) and how many
// comments it has. Hovering a row lights its circle on the blueprint;
// choosing one opens its page, selects it and zooms to it.

import { memo, useState, type PointerEvent } from "react";
import { CIRCLE_COLORS, DEFAULT_CIRCLE_COLOR } from "../../shared/constants";
import type { CircleRow, PageRow } from "../../shared/types";
import { IconComment } from "../ui/icons";
import { usePlanState, type PlanStore } from "../sync";
import { circleSummary, circleTag, plural } from "./format";
import { PREF_NOTES_SCOPE, readPref, writePref } from "./prefs";
import { paperSwatch } from "./swatch";

type Scope = "page" | "all";

export interface NotesListProps {
  store: PlanStore;
  currentPageId: string | null;
  selectedId: string | null;
  /** Light a circle on the canvas while its row is hovered (null: none). */
  onLit(id: string | null): void;
  onOpen(circle: CircleRow): void;
}

const NONE: CircleRow[] = [];

function NotesList({ store, currentPageId, selectedId, onLit, onOpen }: NotesListProps) {
  const pages = usePlanState(store, (s) => s.pages);
  const circlesByPage = usePlanState(store, (s) => s.circlesByPage);
  const commentsByCircle = usePlanState(store, (s) => s.commentsByCircle);
  const [scope, setScope] = useState<Scope>(() => (readPref(PREF_NOTES_SCOPE) === "page" ? "page" : "all"));

  const pick = (s: Scope) => {
    setScope(s);
    writePref(PREF_NOTES_SCOPE, s);
  };

  const groups: { page: PageRow; circles: CircleRow[] }[] = [];
  for (const page of pages) {
    if (scope === "page" && page.id !== currentPageId) continue;
    const circles = circlesByPage.get(page.id) ?? NONE;
    if (circles.length) groups.push({ page, circles });
  }

  // mouse and pencil only: a finger's pointerleave may never come
  const hover = (id: string | null) => (e: PointerEvent) => {
    if (e.pointerType !== "touch") onLit(id);
  };

  return (
    <div className="nl">
      <div className="nl-scope evtabs" role="group" aria-label="Show notes from">
        <button type="button" className="evtab" aria-pressed={scope === "page"} onClick={() => pick("page")}>
          This page
        </button>
        <button type="button" className="evtab" aria-pressed={scope === "all"} onClick={() => pick("all")}>
          All pages
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="nl-empty">
          <p className="nl-empty-h">{scope === "page" ? "No circles on this page yet" : "No circles yet"}</p>
          <p>
            Choose <strong>Circle</strong> at the top, then tap the blueprint where something matters. Its comments show up here.
          </p>
        </div>
      ) : (
        groups.map(({ page, circles }) => (
          <section key={page.id} className="nl-group" aria-label={page.label}>
            <h3 className="nl-group-h">
              <span className="nl-group-name">{page.label}</span>
              <span className="nl-group-count">{plural(circles.length, "circle")}</span>
            </h3>
            <ul className="nl-rows">
              {circles.map((c) => {
                const comments = commentsByCircle.get(c.id);
                const n = comments?.length ?? 0;
                const text = circleSummary(c, comments);
                const pal = CIRCLE_COLORS[c.color] ?? CIRCLE_COLORS[DEFAULT_CIRCLE_COLOR];
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`nl-row${c.id === selectedId ? " active" : ""}`}
                      onClick={() => onOpen(c)}
                      onPointerEnter={hover(c.id)}
                      onPointerLeave={hover(null)}
                      onFocus={() => onLit(c.id)}
                      onBlur={() => onLit(null)}
                    >
                      <span className="nl-dot" style={paperSwatch(pal)} aria-hidden="true" />
                      <span className="nl-num">{circleTag(c)}</span>
                      <span className={`nl-text${text ? "" : " none"}`}>{text || "No comments yet"}</span>
                      {n > 0 && (
                        <span className="nl-count" aria-label={plural(n, "comment")}>
                          <IconComment size={12} />
                          {n}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export default memo(NotesList);
