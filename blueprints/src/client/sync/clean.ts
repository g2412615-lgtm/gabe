// Client-side cleaning of editable values, mirroring the server's rules
// (src/server/sync.ts cleanField). Cleaning locally means the value on screen
// is already the value the server will store, so a save's echo never makes
// the text jump or a circle hop.

import { CIRCLE_COLORS, circleColorOf, MAX_CIRCLE_R, MAX_COMMENT_CHARS, MAX_LABEL_CHARS, MAX_PLAN_NAME_CHARS, MAX_TITLE_CHARS, MIN_CIRCLE_R } from "../../shared/constants";
import { cleanLegend } from "../../shared/labels";
import { EDITABLE, type CircleColor, type EntityKind } from "../../shared/types";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A current colour key (the UI looks palettes up by it). Old names are not: see toColor. */
export const isColor = (v: unknown): v is CircleColor => typeof v === "string" && Object.prototype.hasOwnProperty.call(CIRCLE_COLORS, v);
/**
 * The colour a value means, as the server reads it: a current key, or a
 * pre-rebrand name ("amber" → "gold", "purple" → "black") from a change
 * made before the update; undefined for anything else.
 */
export const toColor = (v: unknown): CircleColor | undefined => circleColorOf(v);

/** Remove NUL and other C0 control characters except tab/newline/CR (as the server does). */
export function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
export function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Free text typed with live autosave (titles, comments): capped, never trimmed (trimming would eat the space before the next word). */
export const cleanText = (s: string, max: number) => cap(stripControls(s), max);

/** One-line names (plan name, page label): trimmed, inner whitespace collapsed, capped. */
export const cleanName = (s: string, max: number) => cap(stripControls(s).replace(/\s+/g, " ").trim(), max).trim();

/**
 * Keep only the editable fields of `patch` that are valid for `kind`,
 * cleaned. Invalid values are dropped (the field keeps its current value),
 * the same way the server cleans instead of rejecting.
 */
export function cleanPatch(kind: EntityKind, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of EDITABLE[kind] as readonly string[]) {
    if (!(f in patch)) continue;
    const v = patch[f];
    switch (f) {
      case "x":
      case "y":
        if (isFiniteNumber(v)) out[f] = clamp(v, 0, 1);
        break;
      case "r":
        if (isFiniteNumber(v)) out[f] = clamp(v, MIN_CIRCLE_R, MAX_CIRCLE_R);
        break;
      case "color": {
        const c = toColor(v);
        if (c) out[f] = c;
        break;
      }
      case "title":
        if (typeof v === "string") out[f] = cleanText(v, MAX_TITLE_CHARS);
        break;
      case "body":
        if (typeof v === "string") out[f] = cleanText(v, MAX_COMMENT_CHARS);
        break;
      case "label": {
        // an empty label keeps the old one (the server does the same)
        const s = typeof v === "string" ? cleanName(v, MAX_LABEL_CHARS) : "";
        if (s) out[f] = s;
        break;
      }
      case "name": {
        const s = typeof v === "string" ? cleanName(v, MAX_PLAN_NAME_CHARS) : "";
        if (s) out[f] = s;
        break;
      }
      case "sortOrder":
        if (isFiniteNumber(v)) out[f] = v;
        break;
      case "legendGold":
      case "legendBlack":
      case "legendRed":
      case "legendBlue":
      case "legendGreen": {
        const s = cleanLegend(v); // "" is a label too: not assigned
        if (s !== null) out[f] = s;
        break;
      }
      case "deletedAt":
        if (v === null || isFiniteNumber(v)) out[f] = v;
        break;
    }
  }
  return out;
}

/** Bytes of a string as UTF-8 (keepalive bodies are capped near 64 KB). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a surrogate pair is one 4-byte character
      i++;
    } else n += 3;
  }
  return n;
}
