import type { CircleColor } from "./types";

/** What the app calls itself (tab titles, home-screen name). */
export const APP_NAME = "KWE Blueprints";
/** The company it belongs to, for the logo's alt text and the sign-in page. */
export const ORG_NAME = "Kilowatt Events";
/** The product name shown after the logo in the gold header band. */
export const PRODUCT_NAME = "Blueprints";

/** Upload limit per file. Plotted CAD sets can be large; the body is streamed to disk. */
export const MAX_UPLOAD_MB = 150;
export const MAX_PAGES_PER_FILE = 300;

/** Accepted upload types (the server checks the bytes, not the name). */
export const UPLOAD_ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

/** Tombstones (deleted plans/pages/circles/comments) are purged after this long. */
export const PURGE_AFTER_DAYS = 30;

/**
 * Circle colours: the Kilowatt Events palette — KW Gold, black, and the brand
 * kit's red (risk), blue (info) and green (ok). Circles are drawn on white
 * paper, so every stroke is dark enough to read on white: gold's stroke is
 * black (gold lines on white don't read), and gold shows as a highlighter
 * fill instead. Other fills are translucent so the blueprint stays readable
 * underneath.
 */
export const CIRCLE_COLORS: Record<CircleColor, { label: string; stroke: string; fill: string; glow: string }> = {
  gold: { label: "Gold", stroke: "#000000", fill: "rgba(254, 224, 0, 0.38)", glow: "rgba(254, 224, 0, 0.75)" },
  black: { label: "Black", stroke: "#000000", fill: "rgba(0, 0, 0, 0.08)", glow: "rgba(0, 0, 0, 0.35)" },
  red: { label: "Red", stroke: "#c21f1f", fill: "rgba(194, 31, 31, 0.12)", glow: "rgba(194, 31, 31, 0.45)" },
  blue: { label: "Blue", stroke: "#1f4e99", fill: "rgba(31, 78, 153, 0.12)", glow: "rgba(31, 78, 153, 0.45)" },
  green: { label: "Green", stroke: "#1f7a3a", fill: "rgba(31, 122, 58, 0.12)", glow: "rgba(31, 122, 58, 0.45)" },
};
export const CIRCLE_COLOR_ORDER: CircleColor[] = ["gold", "black", "red", "blue", "green"];
export const DEFAULT_CIRCLE_COLOR: CircleColor = "gold";

/**
 * Colour names from before the rebrand → today's. Stored circles were renamed
 * by schema migration 3 (src/server/db.ts); this keeps changes still carrying
 * an old name (a tab left open on the old app, a device's unsaved outbox)
 * saving as the colour that was meant. Never remove an entry.
 */
export const LEGACY_CIRCLE_COLORS: ReadonlyMap<string, CircleColor> = new Map<string, CircleColor>([
  ["amber", "gold"],
  ["purple", "black"],
]);

/** The circle colour `v` names — a legacy name counts as its new colour — or undefined when it names none. */
export function circleColorOf(v: unknown): CircleColor | undefined {
  if (typeof v !== "string") return undefined;
  if (Object.prototype.hasOwnProperty.call(CIRCLE_COLORS, v)) return v as CircleColor;
  return LEGACY_CIRCLE_COLORS.get(v);
}

/** Circle radius limits, as a fraction of the page's long side. */
export const MIN_CIRCLE_R = 0.0015;
export const MAX_CIRCLE_R = 0.5;
/** A tapped (not dragged) new circle is this many screen pixels across in radius. */
export const DEFAULT_CIRCLE_SCREEN_R = 36;

export const MAX_COMMENT_CHARS = 10_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_LABEL_CHARS = 200;
export const MAX_PLAN_NAME_CHARS = 200;
