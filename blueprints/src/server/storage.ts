// Free space on the data volume. When it runs low, uploads and renders stop
// with a plain "storage is full" message instead of failing halfway with a
// misleading one ("try uploading again" only makes it worse), and the
// database keeps the room it needs for autosaves.

import fs from "node:fs";

export const STORAGE_FULL = {
  upload: "The app's storage is full, so this file wasn't uploaded. Add more storage (the setup guide explains how), then try again.",
  render: "The app's storage is full, so this page couldn't be prepared. Add more storage (the setup guide explains how), then press Retry.",
  other: "The app's storage is full, so this couldn't be saved on the server. Add more storage (the setup guide explains how).",
} as const;

/** Bytes this process may still write on the volume holding `dir` (Infinity when the system can't say). */
export function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

/** A write that failed because the disk (or the database file) is full. */
export function isStorageFull(e: unknown): boolean {
  const err = e as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (err.code === "ENOSPC" || err.code === "EDQUOT") return true;
  if (err.errcode === 13) return true; // SQLITE_FULL from node:sqlite
  return typeof err.message === "string" && /database or disk is full|ENOSPC|no space left/i.test(err.message);
}
