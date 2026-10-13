import type { CircleColor } from "./types";

export const APP_NAME = "Blueprint Notes";

/** Upload limit per file. Plotted CAD sets can be large; the body is streamed to disk. */
export const MAX_UPLOAD_MB = 150;
export const MAX_PAGES_PER_FILE = 300;

/** Accepted upload types (the server checks the bytes, not the name). */
export const UPLOAD_ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

/** Tombstones (deleted plans/pages/circles/comments) are purged after this long. */
export const PURGE_AFTER_DAYS = 30;

/**
 * Circle colours. Strokes are deep enough to read on white paper (the brand
 * amber #f7a81b alone is too light on white); fills are translucent so the
 * blueprint stays readable underneath.
 */
export const CIRCLE_COLORS: Record<CircleColor, { label: string; stroke: string; fill: string; glow: string }> = {
  amber: { label: "Amber", stroke: "#e8900c", fill: "rgba(247, 168, 27, 0.16)", glow: "rgba(247, 168, 27, 0.55)" },
  red: { label: "Red", stroke: "#e5484d", fill: "rgba(229, 72, 77, 0.14)", glow: "rgba(229, 72, 77, 0.5)" },
  blue: { label: "Blue", stroke: "#2f7fe6", fill: "rgba(47, 127, 230, 0.14)", glow: "rgba(47, 127, 230, 0.5)" },
  green: { label: "Green", stroke: "#1f9d55", fill: "rgba(31, 157, 85, 0.14)", glow: "rgba(31, 157, 85, 0.5)" },
  purple: { label: "Purple", stroke: "#8b5cf6", fill: "rgba(139, 92, 246, 0.14)", glow: "rgba(139, 92, 246, 0.5)" },
};
export const CIRCLE_COLOR_ORDER: CircleColor[] = ["amber", "red", "blue", "green", "purple"];
export const DEFAULT_CIRCLE_COLOR: CircleColor = "amber";

/** Circle radius limits, as a fraction of the page's long side. */
export const MIN_CIRCLE_R = 0.0015;
export const MAX_CIRCLE_R = 0.5;
/** A tapped (not dragged) new circle is this many screen pixels across in radius. */
export const DEFAULT_CIRCLE_SCREEN_R = 36;

export const MAX_COMMENT_CHARS = 10_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_LABEL_CHARS = 200;
export const MAX_PLAN_NAME_CHARS = 200;
