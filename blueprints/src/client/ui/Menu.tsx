// DeployMap's HeaderMenu (a small trigger button + a .hmenu-pop list), with
// what it lacked: Escape, ARIA (menu button pattern), arrow-key navigation,
// and a pop-up that stays on screen. The pop-up is portalled to <body> with
// position: fixed, so a scrolling sidebar or a transformed panel never clips
// it. It closes on any pointerdown outside (works for touch too), on
// Escape, on Tab, and after an item is chosen.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { focusableIn, useLayer } from "./layers";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
export type MenuSeparator = "separator";
export interface MenuHeading {
  heading: ReactNode;
  sub?: ReactNode;
}
/** Falsy entries are skipped, so items can be conditional: `canX && { … }`. */
export type MenuEntry = MenuItem | MenuSeparator | MenuHeading | null | false | undefined;

export interface MenuProps {
  /** The trigger's content (text, an icon, or both). */
  label: ReactNode;
  /** Accessible name for the trigger — required when `label` is only an icon. */
  ariaLabel?: string;
  title?: string;
  items?: MenuEntry[];
  /** Free-form content shown above the items (e.g. a list of shortcuts). A function gets `close`. */
  children?: ReactNode | ((close: () => void) => ReactNode);
  /** Line the pop-up up with the trigger's left (default) or right edge; it shifts/flips to stay on screen. */
  align?: "left" | "right";
  /** Extra classes on the .hmenu wrapper. */
  className?: string;
  /** Trigger classes (default "small"); "toggled" is added while open. */
  buttonClassName?: string;
  popClassName?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const EDGE = 8; // keep this far from the window edges
const GAP = 6; // between trigger and pop-up

export default function Menu({
  label,
  ariaLabel,
  title,
  items = [],
  children,
  align = "left",
  className,
  buttonClassName = "small",
  popClassName,
  disabled,
  onOpenChange,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const popId = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const entries = items.filter((e): e is MenuItem | MenuSeparator | MenuHeading => !!e);
  const hasPanel = children != null;
  const menuOnly = !hasPanel;

  const reported = useRef(false);
  useEffect(() => {
    if (!reported.current && !open) return; // nothing to report before the first opening
    reported.current = true;
    onOpenChangeRef.current?.(open);
  }, [open]);

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [],
  );

  useLayer(open, () => close(true));

  // Close on a press anywhere else (capture: runs even if the target stops propagation).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (wrapRef.current?.contains(t) || popRef.current?.contains(t))) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // Place the pop-up next to the trigger, inside the window: below (or above
  // when there's no room below), aligned left or right, shifted to fit.
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = align === "right" ? r.right - pw : r.left;
    left = Math.max(EDGE, Math.min(left, vw - EDGE - pw));
    let top = r.bottom + GAP;
    if (top + ph > vh - EDGE) {
      const above = r.top - GAP - ph;
      top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - ph);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
  }, [open, place]);

  const itemEls = () => Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);

  // Opened from the keyboard: focus the first (or last) item, per the ARIA
  // menu-button pattern. Opened by pointer: focus the pop-up itself, so the
  // arrow keys still work without showing a focus ring on an item.
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    if (!pop) return;
    const which = focusOnOpen.current;
    focusOnOpen.current = null;
    const targets = menuOnly ? itemEls() : focusableIn(pop);
    const target = which === "first" ? targets[0] : which === "last" ? targets[targets.length - 1] : undefined;
    (target ?? pop).focus({ preventScroll: true });
  }, [open, menuOnly]);

  const onTriggerClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (open) {
      close(false);
      return;
    }
    // detail 0 = the click came from Enter/Space, not a pointer
    if (e.detail === 0) focusOnOpen.current = "first";
    setOpen(true);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    focusOnOpen.current = e.key === "ArrowDown" ? "first" : "last";
    if (!open) setOpen(true);
    else {
      const els = itemEls();
      (e.key === "ArrowDown" ? els[0] : els[els.length - 1])?.focus();
    }
  };

  const onPopKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        if (els.length) go(i < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        if (els.length) go(i < 0 ? els.length - 1 : i - 1);
        break;
      case "Home":
        if (els.length) go(0);
        break;
      case "End":
        if (els.length) go(els.length - 1);
        break;
      case "Tab": {
        // Tab moves through a panel's own links/buttons; leaving them closes the menu.
        const stops = focusableIn(e.currentTarget);
        const at = stops.indexOf(document.activeElement as HTMLElement);
        const leaving = stops.length === 0 || at < 0 || (e.shiftKey ? at === 0 : at === stops.length - 1);
        if (leaving) {
          e.preventDefault();
          close(true);
        }
        break;
      }
    }
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    // Focus goes back to the trigger first, so an action that moves focus
    // (e.g. Rename opening an input) keeps it.
    close(true);
    item.onSelect();
  };

  const itemButtons = entries.map((en, i) => {
    if (en === "separator") return <div key={`sep${i}`} className="hmenu-sep" role="separator" />;
    if ("heading" in en)
      return (
        <div key={`head${i}`} className="hmenu-head" role="presentation">
          {en.heading}
          {en.sub && <small>{en.sub}</small>}
        </div>
      );
    return (
      <button
        key={`item${i}`}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={`hmenu-item${en.danger ? " menu-danger" : ""}`}
        disabled={en.disabled}
        onClick={() => choose(en)}
      >
        {en.icon}
        <span className="hmenu-label">{en.label}</span>
        {en.hint && <span className="hmenu-hint">{en.hint}</span>}
      </button>
    );
  });

  const popName = ariaLabel ?? (typeof label === "string" ? label : undefined);

  return (
    <div className={`hmenu${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${buttonClassName}${open ? " toggled" : ""}`}
        aria-haspopup={menuOnly ? "menu" : "dialog"}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            className={`hmenu-pop${popClassName ? ` ${popClassName}` : ""}`}
            role={menuOnly ? "menu" : "dialog"}
            aria-label={popName}
            tabIndex={-1}
            onKeyDown={onPopKey}
          >
            {hasPanel && <div className="hmenu-panel">{typeof children === "function" ? children(() => close(true)) : children}</div>}
            {entries.length > 0 &&
              (menuOnly ? (
                itemButtons
              ) : (
                <div role="menu" className="hmenu-items">
                  {itemButtons}
                </div>
              ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
