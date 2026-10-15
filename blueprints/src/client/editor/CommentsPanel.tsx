// The right-hand panel for one circle (laid out like DeployMap's side panel): its
// name, colour and size, its comments, and a composer that saves as you
// type. The editor mounts one per circle (key = circle id), so a draft can
// never land on a different circle than the one it was typed for.
//
// Everything autosaves through the store as the owner types — nothing is
// held only in component state, because on an iPad "blur" and "unmount"
// are not dependable moments to save (app switches, the page being killed).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CIRCLE_COLORS, CIRCLE_COLOR_ORDER, DEFAULT_CIRCLE_COLOR, MAX_COMMENT_CHARS, MAX_TITLE_CHARS } from "../../shared/constants";
import { legendOf } from "../../shared/labels";
import type { CircleColor, CircleRow, CommentRow } from "../../shared/types";
import { IconCopy, IconTrash, IconX } from "../ui/icons";
import { useCoarsePointer } from "../ui/media";
import { usePlanState, type PlanStore } from "../sync";
import AutoTextarea from "./AutoTextarea";
import { deleteCircleWithUndo, deleteCommentWithUndo } from "./actions";
import { draftIsLive, editComment, finishDraft, leaveDraft, settleCommentEdit, typeDraft } from "./commentDrafts";
import { circleName, commentTime, isMac, radiusToSlider, SIZE_STEPS, sliderToRadius, wasEdited } from "./format";
import { holdsTyping } from "./panelLogic";
import { paperSwatch } from "./swatch";

const NO_COMMENTS: CommentRow[] = [];

/** The panel's text fields that can hold it still while typing. */
export type TypingField = "title" | "composer";

export interface CommentsPanelProps {
  store: PlanStore;
  circle: CircleRow;
  /** The comment open in the inline editor (the editor owns it: Esc closes it). */
  editingId: string | null;
  onEditingChange(id: string | null): void;
  /** Close the panel (deselect). */
  onClose(): void;
  /**
   * A focused field holds typing (the circle's name, or the composer): the
   * panel must not switch to a hovered circle meanwhile. Each field reports
   * for itself, and false when it goes away.
   */
  onTypingChange(field: TypingField, typing: boolean): void;
  /** Asked once on mount: should the composer take focus (a circle was just added with a mouse)? */
  takeComposerFocus(circleId: string): boolean;
  /** False while the whole editor is unmounting (the store is going away: no more edits). */
  editorAlive(): boolean;
  /** Open the Copy circles dialog for this circle; absent when there's no other page to copy to. */
  onCopy?(circle: CircleRow): void;
  /** A colour was picked for the circle (the editor shows that colour again if this device hides it). */
  onColorPicked?(color: CircleColor): void;
}

function CommentsPanel({ store, circle, editingId, onEditingChange, onClose, onTypingChange, takeComposerFocus, editorAlive, onCopy, onColorPicked }: CommentsPanelProps) {
  const plan = usePlanState(store, (s) => s.plan);
  const meaning = legendOf(plan, circle.color).trim();
  const comments = usePlanState(store, (s) => s.commentsByCircle.get(circle.id) ?? NO_COMMENTS);
  // the comment being written in the composer: it exists already, but shows in the list only once it's finished
  const [draftId, setDraftId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pal = CIRCLE_COLORS[circle.color] ?? CIRCLE_COLORS[DEFAULT_CIRCLE_COLOR];
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
        <span className="cp-dot" style={paperSwatch(pal)} aria-hidden="true" />
        <h2 className="cp-name">{circleName(circle)}</h2>
        <button type="button" className="ghost icon-btn cp-close" onClick={onClose} aria-label="Close the panel" title="Close (Esc)">
          <IconX size={16} />
        </button>
      </div>

      <div className="cp-scroll" ref={listRef}>
        <TitleField store={store} circle={circle} onTypingChange={onTypingChange} />

        <div className="cp-look">
          <div className="cp-swatches" role="group" aria-label="Colour">
            {CIRCLE_COLOR_ORDER.map((c) => {
              const p = CIRCLE_COLORS[c];
              const on = circle.color === c;
              const legend = legendOf(plan, c).trim();
              const name = legend ? `${p.label}: ${legend}` : p.label;
              return (
                <button
                  key={c}
                  type="button"
                  className={`cp-swatch${on ? " on" : ""}`}
                  aria-pressed={on}
                  aria-label={name}
                  title={name}
                  // never part of a size drag that may still be open: its own step, saved now
                  onClick={() => {
                    store.updateCircle(circle.id, { color: c }, { live: false });
                    onColorPicked?.(c);
                  }}
                >
                  <span style={paperSwatch(p)} />
                </button>
              );
            })}
          </div>
          <SizeSlider store={store} circle={circle} />
        </div>
        {meaning && (
          <p className="cp-legend">
            <span className="cp-legend-color">{pal.label}</span> {meaning}
          </p>
        )}

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
        onTypingChange={onTypingChange}
        takeFocus={takeComposerFocus}
        editorAlive={editorAlive}
        onFinished={scrollToEnd}
      />

      <div className="cp-foot">
        {onCopy && (
          <button type="button" className="ghost small cp-copy" onClick={() => onCopy(circle)} title="Copy this circle onto another page">
            <IconCopy size={14} /> Copy to another page
          </button>
        )}
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
function TitleField({ store, circle, onTypingChange }: { store: PlanStore; circle: CircleRow; onTypingChange(field: TypingField, typing: boolean): void }) {
  const [draft, setDraft] = useState(circle.title);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const original = useRef(circle.title);

  // follow changes from elsewhere (undo, the other device) unless typing here
  useEffect(() => {
    if (!focusedRef.current) setDraft(circle.title);
  }, [circle.title]);

  // a name being typed holds the panel still; an empty, merely focused field doesn't
  const typing = holdsTyping(focused, draft);
  useEffect(() => onTypingChange("title", typing), [typing, onTypingChange]);
  useEffect(() => () => onTypingChange("title", false), [onTypingChange]);

  // { live: false }: a name is its own undo step, saved now — never folded into a size drag
  const save = (title: string) => store.updateCircle(circle.id, { title }, { live: false });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      save(original.current);
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
        focusedRef.current = true;
        setFocused(true);
        original.current = circle.title;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setFocused(false);
        setDraft(store.getState().circleById.get(circle.id)?.title ?? draft);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        save(e.target.value);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

// ── size ───────────────────────────────────────────────────────────────

/**
 * Log-scale radius slider. A drag is one gesture (live updates, one undo
 * step); each arrow-key press is its own step (input + change per press).
 *
 * The gesture opens on the first value change, not on pointerdown — a tap
 * that doesn't move the thumb fires no "change", and Safari doesn't focus
 * a range input, so nothing would close it. It closes on whichever comes
 * first: release (anywhere), cancel, lost capture, change, key up, blur,
 * unmount. While a gesture is open the store holds edits back from saving,
 * so one must never be left open.
 */
function SizeSlider({ store, circle }: { store: PlanStore; circle: CircleRow }) {
  const ref = useRef<HTMLInputElement>(null);
  const value = radiusToSlider(circle.r);
  const active = useRef(false);

  const end = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    store.endGesture();
  }, [store]);
  const begin = useCallback(() => {
    if (active.current) return;
    active.current = true;
    // the finger or mouse may come up off the slider: hear it wherever it does
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    store.beginGesture();
  }, [store, end]);

  // the native change event marks the end of a drag or a key press (React's onChange is "input")
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
        value={value}
        // how far the gold runs along the track (editor.css)
        style={{ ["--pct" as string]: `${(value / SIZE_STEPS) * 100}%` }}
        aria-label="Circle size"
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyUp={end}
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
 * ⌘/Ctrl+Enter) closes it; a comment emptied out is deleted (with Undo),
 * keeping the words it had before this edit for that Undo.
 */
function CommentEditor({ store, comment, onDone, editorAlive }: { store: PlanStore; comment: CommentRow; onDone: () => void; editorAlive: () => boolean }) {
  const [text, setText] = useState(comment.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const original = useRef(comment.body);
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
    settleCommentEdit(store, comment.id, original.current, textRef.current);
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
          editComment(store, comment.id, e.target.value);
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
        <span className="cp-note">{text.trim() ? "Saved as you type" : "Empty — closing this deletes the comment"}</span>
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
 * list. Leaving with text keeps the comment — it already exists. If the
 * draft goes away meanwhile (an Undo, the other device), the composer
 * starts over: it never shows text that isn't saved.
 */
function Composer({
  store,
  circleId,
  draftId,
  setDraftId,
  onTypingChange,
  takeFocus,
  editorAlive,
  onFinished,
}: {
  store: PlanStore;
  circleId: string;
  draftId: string | null;
  setDraftId: (id: string | null) => void;
  onTypingChange: (field: TypingField, typing: boolean) => void;
  takeFocus: (circleId: string) => boolean;
  editorAlive: () => boolean;
  onFinished: () => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const coarse = useCoarsePointer();

  // the latest values, for the unmount cleanup (which must run on unmount only)
  const live = useRef({ text, draftId, editorAlive });
  live.current = { text, draftId, editorAlive };

  useEffect(() => {
    if (takeFocus(circleId)) ref.current?.focus({ preventScroll: true });
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typing holds the panel still; the empty composer with focus (after an add) doesn't.
  const typing = holdsTyping(focused, text);
  useEffect(() => onTypingChange("composer", typing), [typing, onTypingChange]);

  // The draft went away under the composer (an Undo took it, or it was
  // deleted on the other device): start over — the text isn't saved any more.
  const draftLive = usePlanState(store, (s) => draftIsLive(s, circleId, draftId));
  useEffect(() => {
    if (!draftId || draftLive) return;
    setDraftId(null);
    setText("");
  }, [draftId, draftLive, setDraftId]);

  // Leaving this circle with a draft: it's already saved; just tidy its ends.
  useEffect(
    () => () => {
      const l = live.current;
      if (l.editorAlive()) leaveDraft(store, circleId, l.draftId, l.text);
      onTypingChange("composer", false);
    },
    [store, circleId, onTypingChange],
  );

  const onChange = (value: string) => {
    setText(value);
    setDraftId(typeDraft(store, circleId, draftId, value));
  };

  const finish = () => {
    if (!finishDraft(store, circleId, draftId, text)) return;
    setDraftId(null);
    setText("");
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
        {/* the primary (black, gold words) only once there's something to add */}
        <button type="button" className={text.trim() ? "small primary" : "small"} onClick={finish} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
