// Small HTTP helpers shared by the routes: plain-language errors, bounded
// JSON bodies, id validation and text cleaning.

import type { Context } from "hono";

/** An error the owner can read. Thrown anywhere in a handler; app.onError turns it into `{ error }`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503 | 507,
    message: string,
  ) {
    super(message);
  }
}

export const MSG = {
  badRequest: "That request wasn't understood.",
  notFound: "That doesn't exist.",
  planNotFound: "That event plan doesn't exist or was deleted.",
  pageNotFound: "That page doesn't exist.",
  signIn: "Sign in to continue.",
  crossSite: "That request came from another site, so it was refused.",
  notConfigured: "The app isn't set up yet: no password is configured.",
  serverError: "Something went wrong on the server — try again in a moment.",
} as const;

/** Ids in paths and sync ops: UUIDs (server or client made) and asset keys. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/** A path parameter that must be an id; anything else is simply "not found". */
export function idParam(c: Context, name: string, notFound: string = MSG.notFound): string {
  const v = c.req.param(name);
  if (!isId(v)) throw new HttpError(404, notFound);
  return v;
}

/**
 * Read a JSON body without trusting Content-Length: the stream is cut off
 * as soon as it passes `maxBytes`.
 */
export async function readJson(c: Context, maxBytes: number): Promise<unknown> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "That request is too large.");
  const body = c.req.raw.body;
  if (!body) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "That request is too large.");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, MSG.badRequest);
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Remove NUL and other C0 control characters except tab/newline/CR (SQLite and browsers handle them badly). */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * A one-line name (plan name, page label): trimmed, inner whitespace
 * collapsed, capped. Names are committed on blur/Enter, so trimming never
 * fights the owner's typing.
 */
export function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return cap(stripControls(v).replace(/\s+/g, " ").trim(), max).trim();
}

/**
 * Free text the owner types with live autosave (comment bodies, circle
 * titles): capped but NOT trimmed — the server echoes values back, so
 * trimming would eat the space the owner just typed before the next word.
 */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return cap(stripControls(v), max);
}

/** The file name the browser sent, without any folder part. */
export function cleanFileName(v: string | undefined | null): string {
  const base = (v ?? "").split(/[\\/]/).pop() ?? "";
  return cap(stripControls(base).trim(), 255) || "blueprint";
}

/** "A-101 Seating bowl.pdf" → "A-101 Seating bowl". */
export function withoutExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
