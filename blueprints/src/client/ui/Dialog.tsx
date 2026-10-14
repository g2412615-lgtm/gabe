// Accessible modal dialog on DeployMap's markup (.drawer-overlay > .drawer.es-dialog),
// with the behaviour of its newer ImpactDialog plus what that lacked:
// role="dialog" + aria-modal + aria-labelledby, Escape and a click outside
// close it, focus goes to the first field (or the primary button) and comes
// back to where it was when the dialog closes, Tab stays inside.
//
// confirmDialog() is the promise-returning "Are you sure?" built on it —
// never the browser's confirm(), which is jarring on an iPad.

import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { IconX } from "./icons";
import { focusableIn, useLayer, useScrollLock } from "./layers";

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  /** Called for Escape, a click outside, the × button — only while `dismissible`. */
  onClose: () => void;
  /** The body (inside .es-dialog-body). */
  children?: ReactNode;
  /** Buttons for the footer bar (.es-dialog-foot), right-aligned. */
  footer?: ReactNode;
  /** false while something must finish (e.g. an upload): Escape, outside clicks and × do nothing. Default true. */
  dismissible?: boolean;
  /** Show the × in the header (default true). */
  showClose?: boolean;
  /** Element to focus on open; default: the first field, else the primary button, else the dialog. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Extra classes on the box (.drawer.es-dialog), e.g. "narrow". */
  className?: string;
  overlayClassName?: string;
  /** When given, body + footer are wrapped in a <form> (Enter submits). */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  describedBy?: string;
}

export default function Dialog(props: DialogProps) {
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<DialogBox {...props} />, document.body);
}

function DialogBox({
  title,
  onClose,
  children,
  footer,
  dismissible = true,
  showClose = true,
  initialFocus,
  className,
  overlayClassName,
  onSubmit,
  describedBy,
}: DialogProps) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const pressStartedOnOverlay = useRef(false);
  const dismiss = useRef(() => {});
  dismiss.current = () => {
    if (dismissible) onClose();
  };

  const isTop = useLayer(true, () => dismiss.current());
  useScrollLock(true);

  // Focus in on open; back to whatever had it on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = boxRef.current;
    if (box) (initialFocus?.current ?? pickInitialFocus(box) ?? box).focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // Runs once per opening (the box mounts on open); initialFocus is read then.
  }, []);

  // Keep Tab inside the dialog while it's the top overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || !isTop()) return;
      const box = boxRef.current;
      if (!box) return;
      const els = focusableIn(box);
      if (els.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!box.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isTop]);

  // Close on a click outside the box — only when the press also started
  // outside (dragging a text selection out of a field must not close it).
  const onOverlayDown = (e: PointerEvent<HTMLDivElement>) => {
    pressStartedOnOverlay.current = e.target === e.currentTarget;
  };
  const onOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && pressStartedOnOverlay.current) dismiss.current();
    pressStartedOnOverlay.current = false;
  };

  const inner = (
    <>
      <div className="drawer-head">
        <h3 id={titleId}>{title}</h3>
        {showClose && dismissible && (
          <button type="button" className="ghost small icon-btn dialog-x" aria-label="Close" onClick={onClose}>
            <IconX size={16} />
          </button>
        )}
      </div>
      <div className="es-dialog-body">{children}</div>
      {footer && <div className="es-dialog-foot">{footer}</div>}
    </>
  );

  return (
    <div className={`drawer-overlay${overlayClassName ? ` ${overlayClassName}` : ""}`} onPointerDown={onOverlayDown} onClick={onOverlayClick}>
      <div
        ref={boxRef}
        className={`drawer es-dialog${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {onSubmit ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {inner}
          </form>
        ) : (
          inner
        )}
      </div>
    </div>
  );
}

function pickInitialFocus(box: HTMLElement): HTMLElement | null {
  const field = box.querySelector<HTMLElement>(
    '.es-dialog-body :is(input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), select, textarea):not([disabled])',
  );
  if (field) return field;
  const primary = box.querySelector<HTMLElement>("button.primary:not([disabled]), button.danger.solid:not([disabled])");
  if (primary) return primary;
  return focusableIn(box).find((el) => !el.classList.contains("dialog-x")) ?? null;
}

// ── confirmDialog ───────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  /** A sentence (shown as a paragraph) or any content. */
  body?: ReactNode;
  /** The confirming button's label, e.g. "Delete plan". Default "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive action: the confirm button is solid red. */
  danger?: boolean;
}

type PendingConfirm = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

let confirmQueue: readonly PendingConfirm[] = [];
const confirmListeners = new Set<() => void>();
let confirmSeq = 0;
let confirmRoot: Root | null = null;

/**
 * Ask the owner to confirm something. Resolves true for the confirm button,
 * false for Cancel / Escape / a click outside. Several calls queue up.
 * Rendered in its own small React root, so it works from anywhere.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmQueue = [...confirmQueue, { ...options, id: ++confirmSeq, resolve }];
    mountConfirmHost();
    confirmListeners.forEach((l) => l());
  });
}

function settleConfirm(id: number, ok: boolean) {
  const item = confirmQueue.find((c) => c.id === id);
  if (!item) return;
  confirmQueue = confirmQueue.filter((c) => c.id !== id);
  confirmListeners.forEach((l) => l());
  item.resolve(ok);
}

function mountConfirmHost() {
  if (confirmRoot || typeof document === "undefined") return;
  const el = document.createElement("div");
  el.id = "confirm-host";
  document.body.appendChild(el);
  confirmRoot = createRoot(el);
  confirmRoot.render(<ConfirmHost />);
}

const subscribeConfirms = (fn: () => void) => {
  confirmListeners.add(fn);
  return () => confirmListeners.delete(fn);
};
const getConfirms = () => confirmQueue;

function ConfirmHost() {
  const queue = useSyncExternalStore(subscribeConfirms, getConfirms, getConfirms);
  const current = queue[0];
  return current ? <ConfirmBox key={current.id} c={current} /> : null;
}

function ConfirmBox({ c }: { c: PendingConfirm }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const done = (ok: boolean) => settleConfirm(c.id, ok);
  return (
    <Dialog
      open
      title={c.title}
      onClose={() => done(false)}
      initialFocus={confirmRef}
      className="narrow confirm-dialog"
      overlayClassName="confirm-overlay"
      showClose={false}
      footer={
        <>
          <button type="button" onClick={() => done(false)}>
            {c.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" ref={confirmRef} className={c.danger ? "danger solid" : "primary"} onClick={() => done(true)}>
            {c.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      {c.body != null && (typeof c.body === "string" ? <p>{c.body}</p> : c.body)}
    </Dialog>
  );
}
