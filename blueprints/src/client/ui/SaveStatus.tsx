// The editor's save pill (DeployMap's .save-status), extended with the
// states an always-autosaving, sometimes-offline app needs. It's a button:
// tapping it saves right away (or retries after an error).
//
// Below 1100px wide the long labels swap for short ones (CSS); the full
// sentence stays in the tooltip and the accessible name.

/** Same values as the sync engine's SaveState (src/client/sync). */
export type SaveStatusState = "saved" | "pending" | "saving" | "offline" | "error" | "signedOut";

export interface SaveStatusProps {
  state: SaveStatusState;
  /** Changes not yet confirmed by the server (shown when offline). */
  pending?: number;
  /** The engine's last problem, in plain words (shown as the tooltip). */
  message?: string | null;
  onClick?: () => void;
  className?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function saveStatusLabel(state: SaveStatusState, pending = 0): { long: string; short: string; cls: string } {
  switch (state) {
    case "saved":
      return { long: "Saved", short: "Saved", cls: "saved" };
    case "pending":
    case "saving":
      return { long: "Saving…", short: "Saving…", cls: "saving" };
    case "offline":
      // amber, not red: nothing is lost, it's kept on the device
      return {
        long: pending > 0 ? `Offline — ${plural(pending, "change", "changes")} kept on this device` : "Offline — changes are kept on this device",
        short: pending > 0 ? `Offline · ${pending}` : "Offline",
        cls: "dirty",
      };
    case "error":
      return { long: "Not saved — tap to retry", short: "Not saved", cls: "error" };
    case "signedOut":
      return { long: "Signed out", short: "Signed out", cls: "error" };
  }
}

function tooltip(state: SaveStatusState, long: string, message?: string | null): string {
  const extra = message ? ` ${message}` : "";
  switch (state) {
    case "saved":
      return `All changes are saved.${extra}`;
    case "pending":
    case "saving":
      return `Saving your changes — tap to save right away.${extra}`;
    case "offline":
      return `${long}. They'll save when the connection is back — tap to try now.${extra}`;
    case "error":
      return `Not saved.${extra} Tap to retry.`;
    case "signedOut":
      return `Signed out — sign in to finish saving.${extra}`;
  }
}

export default function SaveStatus({ state, pending = 0, message, onClick, className }: SaveStatusProps) {
  const { long, short, cls } = saveStatusLabel(state, pending);
  return (
    <button
      type="button"
      className={`save-status ${cls}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      title={tooltip(state, long, message)}
      aria-label={message ? `${long}. ${message}` : long}
    >
      <span className="ss-long">{long}</span>
      <span className="ss-short" aria-hidden="true">
        {short}
      </span>
    </button>
  );
}
