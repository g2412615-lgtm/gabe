// DeployMap's inline rename (.model-name-input): a borderless text field
// that shows its edges on hover and focus. It commits on blur and on Enter;
// Escape puts the old name back. onCommit only fires for a real change to a
// non-empty name (trimmed).
//
// Two ways to use it:
//   <InlineRename value={name} onCommit={rename} ariaLabel="Plan name" />
//     → always an input (the editor's plan name).
//   <InlineRename value={name} onCommit={rename} ariaLabel="Plan name"
//                 editing={editing} onEditingChange={setEditing} display={<Link…/>} />
//     → shows `display` until `editing` turns true (e.g. a "Rename" menu
//       item), then the input, focused with the text selected; finishing
//       (commit or Escape) calls onEditingChange(false).
//
// `commitWhileTyping` (off by default) also commits after each pause in the
// typing, for names that autosave like everything else in the editor: a
// closed tab or a discarded iPad tab doesn't lose a name half-typed. Escape
// (or leaving the field empty) then puts back — and commits — the name the
// field had when the owner started.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface InlineRenameProps {
  value: string;
  onCommit: (value: string) => void;
  /** Accessible name for the field, e.g. "Plan name". */
  ariaLabel: string;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Shown instead of the input while not editing (controlled mode). Default: the value as text. */
  display?: ReactNode;
  className?: string;
  title?: string;
  placeholder?: string;
  maxLength?: number;
  /** Select all text when the field takes focus (default: true in controlled mode). */
  selectOnFocus?: boolean;
  /** Also commit while typing, after a short pause (see the top of this file). Default false. */
  commitWhileTyping?: boolean;
}

/** Pause in the typing after which commitWhileTyping commits. */
export const TYPING_COMMIT_MS = 400;

/** The name as it would be committed: trimmed and capped ("" = not a name). */
export function cleanName(text: string, maxLength?: number): string {
  const t = text.trim();
  return maxLength ? t.slice(0, maxLength) : t;
}

/**
 * commitWhileTyping's timing: each change waits for a pause of `delay` ms,
 * then goes to `commit`; flush() sends a waiting change at once, cancel()
 * drops it.
 */
export function typingCommitter(commit: (text: string) => void, delay = TYPING_COMMIT_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  const run = () => {
    timer = null;
    const t = pending;
    pending = null;
    if (t !== null) commit(t);
  };
  return {
    change(text: string) {
      pending = text;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export default function InlineRename({
  value,
  onCommit,
  ariaLabel,
  editing,
  onEditingChange,
  display,
  className,
  title,
  placeholder,
  maxLength,
  selectOnFocus,
  commitWhileTyping = false,
}: InlineRenameProps) {
  const controlled = editing !== undefined;
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  // set by Escape (revert) or by a commit, so the blur that follows doesn't commit again
  const settled = useRef(false);
  // the name when this round of editing began: what Escape goes back to
  const original = useRef(value);

  // the latest props, for the typing timer (it fires after renders it didn't see)
  const latest = useRef({ value, onCommit, maxLength });
  latest.current = { value, onCommit, maxLength };
  const [typed] = useState(() =>
    typingCommitter((text) => {
      const l = latest.current;
      const next = cleanName(text, l.maxLength);
      if (next && next !== l.value) l.onCommit(next);
    }),
  );
  // Going away mid-pause (the editor closing, the page list changing): commit
  // what was typed. A layout cleanup, so it lands before the editor's store
  // is closed in its own (passive) cleanup.
  useLayoutEffect(() => () => typed.flush(), [typed]);

  // Follow outside changes (e.g. a rename synced from another device) unless
  // the owner is typing in the field right now.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  // Entering edit mode: focus and select the whole name.
  useLayoutEffect(() => {
    if (!controlled || !editing) return;
    settled.current = false;
    original.current = value;
    setDraft(value);
    const el = inputRef.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.select();
    }
    // Deliberately keyed on the edit switch only (not on `value`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, editing]);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    typed.cancel();
    const next = cleanName(draft, maxLength);
    if (commit && next) {
      if (next !== value) onCommit(next);
      setDraft(next);
    } else {
      // Escape, or nothing left of the name: back to what it was — which,
      // after commits made while typing, has to be committed again
      if (commitWhileTyping && original.current && original.current !== value) onCommit(original.current);
      setDraft(commitWhileTyping && original.current ? original.current : value);
    }
    if (controlled) onEditingChange?.(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
      if (!controlled) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      // consumed here: a dialog or the editor shouldn't also act on it
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      if (!controlled) e.currentTarget.blur();
    }
  };

  if (controlled && !editing) return <>{display ?? <span>{value}</span>}</>;

  return (
    <input
      ref={inputRef}
      type="text"
      className={`model-name-input${className ? ` ${className}` : ""}`}
      value={draft}
      aria-label={ariaLabel}
      title={title}
      placeholder={placeholder}
      maxLength={maxLength}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="done"
      onChange={(e) => {
        setDraft(e.target.value);
        if (commitWhileTyping) typed.change(e.target.value);
      }}
      onFocus={(e) => {
        focused.current = true;
        if (!controlled) {
          settled.current = false;
          original.current = value;
        }
        if (selectOnFocus ?? controlled) e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        finish(true);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
