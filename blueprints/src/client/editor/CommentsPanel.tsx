// The right-hand panel for one circle (DeployMap's side-panel look): its
// name, colour and size, its comments, and a composer that saves as you
// type. The editor mounts one per circle (key = circle id), so a draft can
// never land on a different circle than the one it was typed for.
//
// Everything autosaves through the store as the owner types — nothing is
// held only in component state, because on an iPad "blur" and "unmount"
// are not dependable moments to save (app switches, the page being killed).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CIRCLE_COLORS, CIRCLE_COLOR_ORDER, MAX_COMMENT_CHARS, MAX_TITLE_CHARS } from "../../shared/constants";
import type { CircleRow, CommentRow } from "../../shared/types";
import { IconTrash, IconX } from "../ui/icons";
import { useCoarsePointer } from "../ui/media";
import { usePlanState, type PlanStore } from "../sync";
import AutoTextarea from "./AutoTextarea";
import { deleteCircleWithUndo, deleteCommentWithUndo } from "./actions";
import { circleName, commentTime, isMac, radiusToSlider, SIZE_STEPS, sliderToRadius, wasEdited } from "./format";

const NO_COMMENTS: CommentRow[] = [];

export interface CommentsPanelProps {
  store: PlanStore;
  circle: CircleRow;
  /** The comment open in the inline editor (the editor owns it: Esc closes it). */
  editingId: string | null;
  onEditingChange(id: string | null): void;
  /** Close the panel (deselect). */
  onClose(): void;
  /** The composer holds text: the panel must not switch to a hovered circle. */
  onDraftingChange(drafting: boolean): void;
  /** Asked once on mount: should the composer take focus (a circle was just added with a mouse)? */
  takeComposerFocus(circleId: string): boolean;
  /** False while the whole editor is unmounting (the store is going away: no more edits). */
  editorAlive(): boolean;
}

function CommentsPanel({ store, circle, editingId, onEditingChange, onClose, onDraftingChange, takeComposerFocus, editorAlive }: CommentsPanelProps) {
  const comments = usePlanState(store, (s) => s.commentsByCircle.get(circle.id) ?? NO_COMMENTS);
  // the comment being written in the composer: it exists already, but shows in the list only once it's finished
  const [draftId, setDraftId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pal = CIRCLE_COLORS[circle.color];
  const shown = draftId ? comments.filter((c) => c.id !== draftId) : comments;

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  return (
    <div className="cp" style={{ ["--cp-stroke" as string]: pal.stroke }}>
      <div className="cp-head">
        <span className="cp-dot" style={{ background: pal.fill, borderColor: pal.stroke }} aria-hidden="true" />
        <h2 className="cp-name">{circleName(circle)}</h2>
        <button type="button" className="ghost icon-btn cp-close" onClick={onClose} aria-label="Close the panel" title="Close (Esc)">
          <IconX size={16} />
        </button>
      </div>

      <div className="cp-scroll" ref={listRef}>
        <TitleField store={store} circle={circle} />

        <div className="cp-look">
          <div className="cp-swatches" role="group" aria-label="Colour">
            {CIRCLE_COLOR_ORDER.map((c) => {
              const p = CIRCLE_COLORS[c];
              const on = circle.color === c;
              return (
                <button
                  key={c}
                  type="button"
                  className={`cp-swatch${on ? " on" : ""}`}
                  aria-pressed={on}
                  aria-label={p.label}
                  title={p.label}
                  onClick={() => store.updateCircle(circle.id, { color: c })}
                >
                  <span style={{ background: p.fill, borderColor: p.stroke }} />
                </button>
              );
            })}
          </div>
          <SizeSlider store={store} circle={circle} />
        </div>

        <section className="cp-comments" aria-label="Comments">
          <h3 className="cp-h">
            Comments {shown.length > 0 && <span className="count">{shown.length}</span>}
          </h3>
          {shown.length === 0 ? (
            <p className="cp-empty">No comments yet — add the first one below.</p>
          ) : (
            <ol className="cp-list">
              {shown.map((c) =>
                c.id === editingId ? (
                  <CommentEditor
                    key={c.id}
                    store={store}
                    comment={c}
                    onDone={() => onEditingChange(null)}
                    editorAlive={editorAlive}
                  />
                ) : (
                  <CommentItem key={c.id} store={store} comment={c} onEdit={() => onEditingChange(c.id)} />
                ),
              )}
            </ol>
          )}
        </section>
      </div>

      <Composer
        store={store}
        circleId={circle.id}
        draftId={draftId}
        setDraftId={setDraftId}
        onDraftingChange={onDraftingChange}
        takeFocus={takeComposerFocus}
        editorAlive={editorAlive}
        onFinished={scrollToEnd}
      />

      <div className="cp-foot">
        <button type="button" className="ghost danger small cp-delete" onClick={() => deleteCircleWithUndo(store, circle)}>
          <IconTrash size={14} /> Delete circle
        </button>
      </div>
    </div>
  );
}

export default memo(CommentsPanel);

// ── title ──────────────────────────────────────────────────────────────

/**
 * The circle's optional name, saved as it's typed (title edits merge into
 * one undo step). Enter finishes; Escape puts back what was there when the
 * field took focus.
 */
function TitleField({ store, circle }: { store: PlanStore; circle: CircleRow }) {
  const [draft, setDraft] = useState(circle.title);
  const focused = useRef(false);
  const original = useRef(circle.title);

  // follow changes from elsewhere (undo, the other device) unless typing here
  useEffect(() => {
    if (!focused.current) setDraft(circle.title);
  }, [circle.title]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      store.updateCircle(circle.id, { title: original.current });
      setDraft(original.current);
      e.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      className="cp-title"
      value={draft}
      placeholder="Name this spot (optional)"
      aria-label="Circle name"
      maxLength={MAX_TITLE_CHARS}
      autoComplete="off"
      enterKeyHint="done"
      onFocus={() => {
        focused.current = true;
        original.current = circle.title;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(store.getState().circleById.get(circle.id)?.title ?? draft);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        store.updateCircle(circle.id, { title: e.target.value });
      }}
      onKeyDown={onKeyDown}
    />
  );
}

// ── size ───────────────────────────────────────────────────────────────

/**
 * Log-scale radius slider. A drag is one gesture (live updates, one undo
 * step); each arrow-key press is its own step (input + change per press).
 */
function SizeSlider({ store, circle }: { store: PlanStore; circle: CircleRow }) {
  const ref = useRef<HTMLInputElement>(null);
  const active = useRef(false);

  const begin = useCallback(() => {
    if (active.current) return;
    active.current = true;
    store.beginGesture();
  }, [store]);
  const end = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    store.endGesture();
  }, [store]);

  // the native change event marks the end of a drag (React's onChange is "input")
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("change", end);
    return () => {
      el.removeEventListener("change", end);
      end();
    };
  }, [end]);

  return (
    <label className="cp-size">
      <span className="cp-size-lbl">Size</span>
      <input
        ref={ref}
        type="range"
        min={0}
        max={SIZE_STEPS}
        step={1}
        value={radiusToSlider(circle.r)}
        aria-label="Circle size"
        onPointerDown={begin}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => {
          begin();
          store.updateCircle(circle.id, { r: sliderToRadius(Number(e.target.value)) }, { live: true });
        }}
      />
    </label>
  );
}

// ── comments ───────────────────────────────────────────────────────────

const CommentItem = memo(function CommentItem({ store, comment, onEdit }: { store: PlanStore; comment: CommentRow; onEdit: () => void }) {
  const full = new Date(comment.createdAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return (
    <li className="cp-comment">
      <div className="cp-body">{comment.body}</div>
      <div className="cp-meta">
        <span title={full}>
          {commentTime(comment.createdAt)}
          {wasEdited(comment) && " · edited"}
        </span>
        <span className="cp-actions">
          <button type="button" className="cp-act" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="cp-act danger" onClick={() => deleteCommentWithUndo(store, comment.id)}>
            Delete
          </button>
        </span>
      </div>
    </li>
  );
});

/**
 * Inline editing of a comment: saved as it's typed. Done (or Esc, or
 * ⌘/Ctrl+Enter) closes it; a comment emptied out is deleted (with Undo).
 */
function CommentEditor({ store, comment, onDone, editorAlive }: { store: PlanStore; comment: CommentRow; onDone: () => void; editorAlive: () => boolean }) {
  const [text, setText] = useState(comment.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const finished = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: false });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  /** Tidy up what was typed: trim it, or delete the comment when nothing is left. */
  const settle = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    const t = textRef.current.trim();
    if (!t) deleteCommentWithUndo(store, comment.id);
    else if (t !== textRef.current) store.updateComment(comment.id, t);
  }, [store, comment.id]);

  // Closed some other way (another circle opened): settle it then — unless the editor itself is going away.
  useEffect(() => () => void (editorAlive() && settle()), [settle, editorAlive]);

  const done = () => {
    settle();
    onDone();
  };

  return (
    <li className="cp-comment editing">
      <AutoTextarea
        ref={ref}
        className="cp-edit"
        value={text}
        maxLength={MAX_COMMENT_CHARS}
        minRows={2}
        maxRows={12}
        aria-label="Edit comment"
        onChange={(e) => {
          setText(e.target.value);
          store.updateComment(comment.id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            e.stopPropagation();
            done();
          }
        }}
      />
      <div className="cp-edit-foot">
        <span className="cp-note">Saved as you type</span>
        <button type="button" className="small primary" onClick={done}>
          Done
        </button>
      </div>
    </li>
  );
}

// ── composer ───────────────────────────────────────────────────────────

/**
 * "Add a comment…": the first non-blank character creates the comment,
 * further typing updates it, erasing it all deletes it again. Add (or
 * ⌘/Ctrl+Enter) finishes it: the composer clears and the comment joins the
 * list. Leaving with text keeps the comment — it already exists.
 */
function Composer({
  store,
  circleId,
  draftId,
  setDraftId,
  onDraftingChange,
  takeFocus,
  editorAlive,
  onFinished,
}: {
  store: PlanStore;
  circleId: string;
  draftId: string | null;
  setDraftId: (id: string | null) => void;
  onDraftingChange: (drafting: boolean) => void;
  takeFocus: (circleId: string) => boolean;
  editorAlive: () => boolean;
  onFinished: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const coarse = useCoarsePointer();
  const isLive = useCallback((id: string) => store.getState().commentsByCircle.get(circleId)?.some((c) => c.id === id) ?? false, [store, circleId]);

  // the latest values, for the unmount cleanup (which must run on unmount only)
  const live = useRef({ text, draftId, isLive, editorAlive, onDraftingChange });
  live.current = { text, draftId, isLive, editorAlive, onDraftingChange };

  useEffect(() => {
    if (takeFocus(circleId)) ref.current?.focus({ preventScroll: true });
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving this circle with a draft: it's already saved; just tidy its ends.
  useEffect(
    () => () => {
      const l = live.current;
      const t = l.text.trim();
      if (l.draftId && l.editorAlive() && t && t !== l.text && l.isLive(l.draftId)) store.updateComment(l.draftId, t);
      l.onDraftingChange(false);
    },
    [store],
  );

  const onChange = (value: string) => {
    setText(value);
    const blank = value.trim() === "";
    const id = draftId && isLive(draftId) ? draftId : null; // an Undo may have taken the draft away
    if (id) {
      if (blank) {
        store.deleteComment(id);
        setDraftId(null);
      } else store.updateComment(id, value);
    } else if (!blank) setDraftId(store.addComment(circleId, value));
    else if (draftId) setDraftId(null);
    onDraftingChange(!blank);
  };

  const finish = () => {
    const t = text.trim();
    if (!t) return;
    if (draftId && isLive(draftId)) {
      if (t !== text) store.updateComment(draftId, t);
    } else store.addComment(circleId, t);
    setDraftId(null);
    setText("");
    onDraftingChange(false);
    onFinished();
    // With a keyboard, stay ready for the next one. On a touch screen let the
    // on-screen keyboard go (iPad Safari keeps focus in the field after a
    // button tap) so the comment just added is in view.
    if (coarse) ref.current?.blur();
    else ref.current?.focus({ preventScroll: true });
  };

  return (
    <div className="cp-composer">
      <AutoTextarea
        ref={ref}
        className="cp-input"
        value={text}
        placeholder="Add a comment…"
        aria-label="Add a comment"
        maxLength={MAX_COMMENT_CHARS}
        minRows={2}
        maxRows={8}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            finish();
          } else if (e.key === "Escape") {
            // the comment is already saved; just step out of the field
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      <div className="cp-composer-foot">
        <span className="cp-note">{text.trim() ? "Saved as you type" : coarse ? "" : <><kbd>{isMac() ? "⌘" : "Ctrl"}</kbd> <kbd>↵</kbd> to add</>}</span>
        {/* amber only once there's something to add (a disabled amber reads as muddy brown) */}
        <button type="button" className={text.trim() ? "small primary" : "small"} onClick={finish} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
