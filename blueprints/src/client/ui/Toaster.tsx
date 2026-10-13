// Shows the toasts notify.ts keeps: newest at the bottom, bottom-right of
// the window. Mounted once in App. The live region is always present so
// screen readers announce each new message.

import { useSyncExternalStore, type PointerEvent } from "react";
import { dismissToast, getToasts, pauseToast, resumeToast, runToastAction, subscribeToasts } from "./notify";

export default function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

  // Mouse only: on a touch screen "pointerleave" may never come, which
  // would hold a toast open forever.
  const hover = (id: number, on: boolean) => (e: PointerEvent) => {
    if (e.pointerType === "mouse") (on ? pauseToast : resumeToast)(id);
  };

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}${t.action ? " has-action" : ""}`}
          onPointerEnter={hover(t.id, true)}
          onPointerLeave={hover(t.id, false)}
          onFocus={() => pauseToast(t.id)}
          onBlur={() => resumeToast(t.id)}
        >
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={() => runToastAction(t.id)}>
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
