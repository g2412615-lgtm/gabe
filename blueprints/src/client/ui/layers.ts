// A stack of open overlays (dialogs, menus) so Escape closes only the top
// one, and so screens with their own keyboard shortcuts can stand aside
// while an overlay is open.
//
// Convention: whoever consumes an Escape key press calls preventDefault()
// on it. Overlay handlers skip events that are already defaultPrevented, and
// a screen-level shortcut handler should skip them too (and check
// isOverlayOpen() — its window listener may run before the overlay's).

import { useEffect, useRef } from "react";

const stack: number[] = [];
let seq = 0;

/** True while any Dialog, confirmDialog or Menu is open. */
export function isOverlayOpen(): boolean {
  return stack.length > 0;
}

/**
 * Registers an overlay while `active`, and calls `onEscape` when Escape is
 * pressed and this overlay is the topmost one. Returns `isTop()`.
 */
export function useLayer(active: boolean, onEscape: () => void): () => boolean {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const idRef = useRef(0);
  const isTopRef = useRef(() => idRef.current !== 0 && stack[stack.length - 1] === idRef.current);

  useEffect(() => {
    if (!active) return;
    const id = ++seq;
    idRef.current = id;
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (stack[stack.length - 1] !== id) return;
      e.preventDefault();
      onEscapeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (idRef.current === id) idRef.current = 0;
    };
  }, [active]);

  return isTopRef.current;
}

// ── page scroll lock (modal dialogs) ────────────────────────────────────

let locks = 0;
let savedOverflow = "";

/** Stops the page behind a modal from scrolling; nested locks are counted. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (locks++ === 0) {
      savedOverflow = root.style.overflow;
      root.style.overflow = "hidden";
    }
    return () => {
      if (--locks === 0) root.style.overflow = savedOverflow;
    };
  }, [active]);
}

// ── focus helpers ───────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Focusable elements inside `root`, in DOM order, skipping ones that aren't
 * rendered (display: none). A Dropzone's 1px file input still counts: it's
 * a real tab stop.
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}
