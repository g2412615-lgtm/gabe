// Names the device and the server must agree on: the name a duplicated
// page gets unless the owner types another one (the dialog suggests it, the
// server falls back to it), and colour labels (cleaned the same way on both
// sides, so the server's echo never changes what's in the field).

import { DEFAULT_LEGEND, LEGEND_FIELD, MAX_LEGEND_CHARS } from "./constants";
import type { CircleColor, PlanRow } from "./types";

/** "A-101" → "A-101 (copy)", or "A-101 (copy 2)", … — the first that no page in `taken` has; never longer than `max`. */
export function copyLabel(label: string, taken: Iterable<string>, max: number): string {
  const used = new Set(taken);
  // a copy of a copy is named after the original: "A-101 (copy)" → "A-101 (copy 2)"
  const base = label.replace(/ \(copy(?: \d+)?\)$/, "") || label;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const name = `${cutAt(base, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`;
    if (!used.has(name) || n > 999) return name;
  }
}

/** At most `max` UTF-16 units of `s`, cut between whole characters (never half an emoji, a flag or a joined sequence). */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    let out = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) {
      if (out.length + segment.length > max) break;
      out += segment;
    }
    return out;
  }
  // no Segmenter: at least never leave half a surrogate pair
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * A colour label as stored: one line (tabs and line breaks become spaces,
 * other control characters go), at most MAX_LEGEND_CHARS. Not trimmed: it's
 * saved as it's typed, and trimming would eat the space before the next
 * word. "" is a valid label (not assigned). null for anything but a string.
 */
export function cleanLegend(v: unknown, max = MAX_LEGEND_CHARS): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const oneLine = v.replace(/[\t\r\n]+/g, " ").replace(/[\u0000-\u001F\u007F]/g, "");
  return cutAt(oneLine, max);
}

/**
 * The downloaded PDF's file name: the event plan's name, plus the page's when
 * it's just one page — "Millrace Spring Fest - A-101.pdf". Characters a file
 * name can't hold become "-"; never longer than 120 characters before ".pdf".
 */
export function pdfFileName(planName: string, pageLabel: string | null = null): string {
  // eslint-disable-next-line no-control-regex
  const clean = (v: string) => v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  const plan = clean(planName) || "Event plan";
  const page = pageLabel === null ? "" : clean(pageLabel);
  const base = cutAt(page ? `${plan} - ${page}` : plan, 120).replace(/^[.\s]+|[.\s]+$/g, "") || "Event plan";
  return `${base}.pdf`;
}

/** What `color` means in `plan` (its default when the plan doesn't say). */
export function legendOf(plan: Partial<PlanRow> | null | undefined, color: CircleColor): string {
  const v = plan?.[LEGEND_FIELD[color]];
  return typeof v === "string" ? v : DEFAULT_LEGEND[color];
}
