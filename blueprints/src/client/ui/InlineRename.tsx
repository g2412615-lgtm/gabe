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
}: InlineRenameProps) {
  const controlled = editing !== undefined;
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  // set by Escape (revert) or by a commit, so the blur that follows doesn't commit again
  const settled = useRef(false);

  // Follow outside changes (e.g. a rename synced from another device) unless
  // the owner is typing in the field right now.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  // Entering edit mode: focus and select the whole name.
  useLayoutEffect(() => {
    if (!controlled || !editing) return;
    settled.current = false;
    setDraft(value);
    const el = inputRef.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.select();
    }
    // Deliberately keyed on the edit switch only (not on `value`).
  }, [controlled, editing]);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (commit && next && next !== value) {
      const clean = maxLength ? next.slice(0, maxLength) : next;
      setDraft(clean);
      onCommit(clean);
    } else setDraft(value);
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
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        focused.current = true;
        if (!controlled) settled.current = false;
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
