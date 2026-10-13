// Small wording helpers for the home page.

import { ApiError } from "../api";
import { MAX_PLAN_NAME_CHARS, MAX_UPLOAD_MB } from "../../shared/constants";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", "Oct 3", "Oct 3, 2025". */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
  if (d < DAY) return plural(Math.round(d / HOUR), "hour") + " ago";
  const then = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday - DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.ceil((startOfToday - ms) / DAY)} days ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "Oct 13, 2026, 2:41 PM" — for tooltips. */
export function fullDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "12.4 MB", "830 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The default plan name for an uploaded file: its name without the extension, tidied (as the server does). */
export function planNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ");
  return base.replace(/\s+/g, " ").trim().slice(0, MAX_PLAN_NAME_CHARS);
}

const OK_EXT = /\.(pdf|png|jpe?g)$/i;
const OK_TYPE = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** A plain sentence if the file can't be uploaded, else null. The server checks the bytes again. */
export function checkUploadFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `That file is over ${MAX_UPLOAD_MB} MB. Export a smaller PDF or split the set.`;
  if (file.size === 0) return "That file is empty.";
  if (!OK_EXT.test(file.name) && !OK_TYPE.has(file.type)) return "That file isn't a PDF, PNG or JPG.";
  return null;
}

/** "PDF", "PNG", "JPG" (for the chosen-file line). */
export function fileKind(file: File): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(file.name);
  const ext = (m?.[1] ?? file.type.split("/")[1] ?? "").toUpperCase();
  return ext === "JPEG" ? "JPG" : ext || "File";
}

/**
 * What to tell the owner when a home-page action fails: what didn't happen,
 * and why in plain words. The API's no-connection message talks about
 * changes being kept on the device, which isn't true here, so it's reworded.
 */
export function actionError(err: unknown, whatDidntHappen: string): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return `${whatDidntHappen} — check the connection and try again.`;
    if (err.status >= 500) return `${whatDidntHappen} — the server had a problem. Try again in a moment.`;
    return err.message || `${whatDidntHappen}.`;
  }
  return `${whatDidntHappen}.`;
}
