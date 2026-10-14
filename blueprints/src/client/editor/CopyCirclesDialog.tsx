// The Copy circles dialog: copy some or all of one page's circles, with
// their comments if wanted, onto one or more other pages of the same event
// plan. One copy is one undo step, however many circles and pages.
//
// Opened from a page's ⋯ menu (every circle on that page ticked) or from a
// circle's panel (just that circle). Copies land in the same spot on each
// page they go to (copyCircles.ts).

import { useId, useRef, useState } from "react";
import { CIRCLE_COLORS, DEFAULT_CIRCLE_COLOR } from "../../shared/constants";
import type { CircleRow, CommentRow } from "../../shared/types";
import Dialog from "../ui/Dialog";
import { IconComment, IconCopy } from "../ui/icons";
import { notify } from "../ui/notify";
import { usePlanState, type PastedCircle, type PlanStore } from "../sync";
import { copyOf, placeCopies } from "./copyCircles";
import { circleSummary, circleTag, plural } from "./format";
import { PageThumb } from "./PageSidebar";
import { paperSwatch } from "./swatch";

export interface CopyRequest {
  fromPageId: string;
  /** The circles ticked to start with; null: every circle on the page. */
  circleIds: string[] | null;
}

export interface CopyCirclesDialogProps {
  store: PlanStore;
  request: CopyRequest;
  onClose(): void;
  /** The page open in the editor: a copy onto it needs no "Show" on the toast. */
  currentPageId: string | null;
  /** The toast's "Show": open that page. */
  onShowPage(pageId: string): void;
}

const NONE: CircleRow[] = [];

const commentCount = (comments: readonly CommentRow[] | undefined) => (comments ?? []).filter((c) => c.body.trim() !== "").length;

/** Mount one per opening (a new key each time): it starts from the request. */
export default function CopyCirclesDialog({ store, request, onClose, currentPageId, onShowPage }: CopyCirclesDialogProps) {
  const pages = usePlanState(store, (s) => s.pages);
  const circlesByPage = usePlanState(store, (s) => s.circlesByPage);
  const commentsByCircle = usePlanState(store, (s) => s.commentsByCircle);

  const [from, setFrom] = useState(request.fromPageId);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(request.circleIds ?? (circlesByPage.get(request.fromPageId) ?? NONE).map((c) => c.id)));
  // with one other page there's nothing to choose
  const [targets, setTargets] = useState<ReadonlySet<string>>(() => {
    const others = pages.filter((p) => p.id !== request.fromPageId);
    return new Set(others.length === 1 ? [others[0].id] : []);
  });
  const [withComments, setWithComments] = useState(true);

  const fromId = useId();
  const circlesId = useId();
  const toId = useId();
  // ready to go (a page to copy to is already ticked): focus Copy, so Enter copies. Else the
  // dialog's body: no field lit up as if it were chosen (a ringed, unticked box reads as ticked on an iPad).
  const focusRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startOnCopy = useRef(targets.size > 0 && picked.size > 0).current;

  const fromPage = pages.find((p) => p.id === from) ?? null;
  const circles = (fromPage && circlesByPage.get(fromPage.id)) || NONE;
  const chosen = circles.filter((c) => picked.has(c.id));
  const others = pages.filter((p) => p.id !== from);
  const toPages = others.filter((p) => targets.has(p.id));
  const nComments = chosen.reduce((n, c) => n + commentCount(commentsByCircle.get(c.id)), 0);
  // pages with circles to copy (and the one picked, even if its circles have all gone)
  const sources = pages.filter((p) => p.id === from || (circlesByPage.get(p.id)?.length ?? 0) > 0);
  const allPicked = circles.length > 0 && chosen.length === circles.length;
  const ready = chosen.length > 0 && toPages.length > 0;

  const changeFrom = (id: string) => {
    setFrom(id);
    setPicked(new Set((circlesByPage.get(id) ?? NONE).map((c) => c.id)));
    const rest = pages.filter((p) => p.id !== id);
    setTargets((t) => {
      if (rest.length === 1) return new Set([rest[0].id]); // the only other page
      if (!t.has(id)) return t;
      const next = new Set(t);
      next.delete(id);
      return next;
    });
  };

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const copy = () => {
    if (!ready) return;
    const items = chosen.map((c) => copyOf(c, commentsByCircle.get(c.id), withComments));
    const placed: PastedCircle[] = [];
    for (const p of toPages) placed.push(...placeCopies(items, p, circlesByPage.get(p.id) ?? NONE));
    const made = store.pasteCircles(placed);
    onClose();
    if (!made.length) {
      notify("Nothing was copied — that page isn't there any more.", "error");
      return;
    }
    const what = plural(chosen.length, "circle");
    if (toPages.length > 1) {
      notify(`Copied ${what} to ${toPages.length} pages.`, "ok");
      return;
    }
    const to = toPages[0];
    notify(`Copied ${what} to “${to.label}”.`, "ok", to.id === currentPageId ? {} : { action: { label: "Show", run: () => onShowPage(to.id) } });
  };

  return (
    <Dialog
      open
      title="Copy circles"
      onClose={onClose}
      onSubmit={copy}
      initialFocus={startOnCopy ? focusRef : bodyRef}
      className="cc-dialog"
      footer={
        <>
          <span className="foot-note">Copies land in the same spot on each page.</span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!ready}
            ref={(el) => {
              if (startOnCopy) focusRef.current = el;
            }}
          >
            <IconCopy size={14} /> {chosen.length > 0 ? `Copy ${plural(chosen.length, "circle")}` : "Copy"}
          </button>
        </>
      }
    >
      <div className="cc" ref={bodyRef} tabIndex={-1}>
        <div className="field">
          <label htmlFor={fromId}>From</label>
          <select id={fromId} value={from} onChange={(e) => changeFrom(e.target.value)}>
            {sources.map((p) => (
              <option key={p.id} value={p.id}>
                {`${pages.indexOf(p) + 1} · ${p.label} (${plural(circlesByPage.get(p.id)?.length ?? 0, "circle")})`}
              </option>
            ))}
          </select>
        </div>

        <section className="cc-sec" role="group" aria-labelledby={circlesId}>
          <div className="cc-sec-h">
            <h4 id={circlesId}>Circles</h4>
            {circles.length > 1 && (
              <button type="button" className="ghost small" onClick={() => setPicked(allPicked ? new Set() : new Set(circles.map((c) => c.id)))}>
                {allPicked ? "Clear" : "Select all"}
              </button>
            )}
          </div>
          {circles.length === 0 ? (
            <p className="cc-none">There are no circles on this page.</p>
          ) : (
            <ul className="cc-list">
              {circles.map((c) => {
                const comments = commentsByCircle.get(c.id);
                const n = commentCount(comments);
                const text = circleSummary(c, comments);
                const pal = CIRCLE_COLORS[c.color] ?? CIRCLE_COLORS[DEFAULT_CIRCLE_COLOR];
                return (
                  <li key={c.id}>
                    <label className="cc-row">
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => setPicked((s) => toggle(s, c.id))} />
                      <span className="nl-dot" style={paperSwatch(pal)} aria-hidden="true" />
                      <span className="nl-num">{circleTag(c)}</span>
                      <span className={`nl-text${text ? "" : " none"}`}>{text || "No comments yet"}</span>
                      {n > 0 && (
                        <span className="nl-count" aria-label={plural(n, "comment")}>
                          <IconComment size={12} />
                          {n}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="cc-sec" role="group" aria-labelledby={toId}>
          <div className="cc-sec-h">
            <h4 id={toId}>Copy to</h4>
          </div>
          {others.length === 0 ? (
            <p className="cc-none">This plan has only one page. Add pages to copy circles onto them.</p>
          ) : (
            <ul className="cc-list cc-pages">
              {others.map((p) => (
                <li key={p.id}>
                  <label className="cc-row cc-page">
                    <input
                      type="checkbox"
                      checked={targets.has(p.id)}
                      onChange={() => setTargets((s) => toggle(s, p.id))}
                    />
                    <PageThumb page={p} />
                    <span className="cc-page-text">
                      <span className="cc-page-label">
                        <span className="ps-index">{pages.indexOf(p) + 1}</span>
                        {p.label}
                      </span>
                      <span className="ps-meta">{plural(circlesByPage.get(p.id)?.length ?? 0, "circle")}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {nComments > 0 && (
          <label className="cc-check">
            <input type="checkbox" checked={withComments} onChange={(e) => setWithComments(e.target.checked)} />
            {chosen.length === 1 ? `Copy its ${plural(nComments, "comment")} too` : `Copy their ${plural(nComments, "comment")} too`}
          </label>
        )}
      </div>
    </Dialog>
  );
}
