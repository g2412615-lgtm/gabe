// The editor's keyboard shortcuts (SPEC §7.6), one window listener for the
// editor's lifetime; it reads the latest handlers through a ref.
//
// Keys are ignored while the owner is typing in a field (except ⌘/Ctrl+S,
// which saves from anywhere), while a dialog or menu is open, and when
// someone else already handled the key (preventDefault, e.g. Escape closing
// a menu). A focused slider keeps only the keys it moves with; buttons and
// checkboxes keep none. Plain-letter shortcuts never fire with ⌘/Ctrl/Alt
// held, so ⌘C still copies.

import { useEffect, useRef } from "react";
import { isOverlayOpen } from "../ui/layers";

export interface EditorKeyHandlers {
  moveMode(): void;
  addMode(): void;
  /** The Esc cascade: stop adding → close the comment editor → deselect → close the drawer. */
  escape(): void;
  /** Delete the selected circle; false when nothing is selected. */
  deleteSelected(): boolean;
  undo(): void;
  redo(): void;
  save(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  prevPage(): void;
  nextPage(): void;
  focusSelected(): void;
}

/** Inputs nobody types in: the editor's shortcuts work while one has focus. */
const NOT_TEXT = new Set(["button", "checkbox", "radio", "submit", "reset", "color", "file", "image", "range"]);
/** The keys a focused slider moves with (the size slider keeps focus after a mouse drag). */
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * Does this key belong to the focused element rather than to the editor?
 * Everything typed into a text field, a select or contenteditable does; a
 * slider keeps only its own keys, so ⌘Z, Esc and the letter shortcuts still
 * work right after resizing a circle with it.
 */
export function keyBelongsToField(t: EventTarget | { tagName?: string; type?: string; isContentEditable?: boolean } | null, key: string): boolean {
  // duck-typed (no instanceof): also works on elements of another frame, and in tests
  const el = t as { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = typeof el.type === "string" && el.type ? el.type.toLowerCase() : "text";
  if (type === "range") return SLIDER_KEYS.has(key);
  return !NOT_TEXT.has(type);
}

export function useEditorKeys(handlers: EditorKeyHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const h = ref.current;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      if (mod && !e.altKey && k === "s") {
        e.preventDefault(); // never the browser's "Save page as…"
        h.save();
        return;
      }
      if (e.defaultPrevented || isOverlayOpen() || keyBelongsToField(e.target, e.key)) return;

      if (mod) {
        if (e.altKey) return;
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) h.redo();
          else h.undo();
        } else if (k === "y") {
          e.preventDefault();
          h.redo();
        }
        return;
      }
      if (e.altKey) return;

      const done = () => e.preventDefault();
      switch (k) {
        case "v":
          done();
          h.moveMode();
          break;
        case "c":
          done();
          h.addMode();
          break;
        case "Escape":
          h.escape();
          break;
        case "Delete":
        case "Backspace":
          if (h.deleteSelected()) done();
          break;
        case "+":
        case "=":
          done();
          h.zoomIn();
          break;
        case "-":
        case "_":
          done();
          h.zoomOut();
          break;
        case "0":
          done();
          h.fit();
          break;
        case "[":
        case "PageUp":
          done();
          h.prevPage();
          break;
        case "]":
        case "PageDown":
          done();
          h.nextPage();
          break;
        case "f":
          done();
          h.focusSelected();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
