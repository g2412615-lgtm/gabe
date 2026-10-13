// The editor's keyboard shortcuts (SPEC §7.6), one window listener for the
// editor's lifetime; it reads the latest handlers through a ref.
//
// Keys are ignored while the owner is typing in a field (except ⌘/Ctrl+S,
// which saves from anywhere), while a dialog or menu is open, and when
// someone else already handled the key (preventDefault, e.g. Escape closing
// a menu). Plain-letter shortcuts never fire with ⌘/Ctrl/Alt held, so ⌘C
// still copies.

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

const NOT_TEXT = new Set(["button", "checkbox", "radio", "submit", "reset", "color", "file", "image"]);

/** Is the key going into something the owner types in? */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  // a focused range slider counts too: its arrow keys and Delete belong to it
  return t instanceof HTMLInputElement && !NOT_TEXT.has(t.type);
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
      if (e.defaultPrevented || isOverlayOpen() || isTyping(e.target)) return;

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
