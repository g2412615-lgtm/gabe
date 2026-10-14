// A thin progress bar: a KW Gold fill on a hairline track, with a label
// above ("Uploading…" and, optionally, the percentage on the right).

import type { ReactNode } from "react";

export interface ProgressProps {
  /** 0..1, or null for "working, amount unknown" (a sliding fill). */
  value: number | null;
  label?: ReactNode;
  /** Show "42%" at the right of the label. */
  showPercent?: boolean;
  className?: string;
}

export default function Progress({ value, label, showPercent = false, className }: ProgressProps) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={`progress${pct == null ? " indeterminate" : ""}${className ? ` ${className}` : ""}`}>
      {(label != null || (showPercent && pct != null)) && (
        <div className="progress-label">
          <span>{label}</span>
          {showPercent && pct != null && <span className="progress-pct">{pct}%</span>}
        </div>
      )}
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-label={typeof label === "string" ? label : "Progress"}
      >
        <div className="progress-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}
