// Wording helpers for the editor: circle names, comment times, counts.

import { MAX_CIRCLE_R, MAX_UPLOAD_MB, MIN_CIRCLE_R } from "../../shared/constants";
import type { CircleRow, CommentRow } from "../../shared/types";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Circle #12", or "New circle" until the server has numbered it. */
export const circleName = (c: Pick<CircleRow, "num">) => (c.num > 0 ? `Circle #${c.num}` : "New circle");

/** "#12", or "•" until the server has numbered it (the canvas badge shows the same). */
export const circleTag = (c: Pick<CircleRow, "num">) => (c.num > 0 ? `#${c.num}` : "•");

/** "Oct 13, 2:41 PM" (the year too when it isn't this year). */
export function commentTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A comment counts as edited once it changed more than a minute after it was written. */
export const wasEdited = (c: Pick<CommentRow, "createdAt" | "updatedAt">) => c.updatedAt - c.createdAt > 60_000;

/** The first non-blank line of a text, for one-line previews. */
export function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** What a circle is called in lists: its title, else its first comment's first line. */
export function circleSummary(c: CircleRow, comments: readonly CommentRow[] | undefined): string {
  const t = c.title.trim();
  if (t) return t;
  for (const cm of comments ?? []) {
    const l = firstLine(cm.body);
    if (l) return l;
  }
  return "";
}

// The size slider runs on a log scale: small circles need fine control,
// big ones don't. Slider units 0…SIZE_STEPS.
export const SIZE_STEPS = 1000;
const LOG_SPAN = Math.log(MAX_CIRCLE_R / MIN_CIRCLE_R);
export const radiusToSlider = (r: number) =>
  Math.round((Math.log(Math.min(MAX_CIRCLE_R, Math.max(MIN_CIRCLE_R, r)) / MIN_CIRCLE_R) / LOG_SPAN) * SIZE_STEPS);
export const sliderToRadius = (v: number) => MIN_CIRCLE_R * Math.exp((Math.min(SIZE_STEPS, Math.max(0, v)) / SIZE_STEPS) * LOG_SPAN);

const OK_EXT = /\.(pdf|png|jpe?g)$/i;
const OK_TYPE = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** A plain sentence if the file can't be added, else null. The server checks the bytes again. */
export function checkUploadFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `“${file.name}” is over ${MAX_UPLOAD_MB} MB. Export a smaller PDF or split the set.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (!OK_EXT.test(file.name) && !OK_TYPE.has(file.type)) return `“${file.name}” isn't a PDF, PNG or JPG.`;
  return null;
}

/** Mac and iPad keyboards say ⌘; others say Ctrl. */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
