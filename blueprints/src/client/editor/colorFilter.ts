// Which circle colours are hidden on this device, per event plan. Hiding is
// a way of looking (like zoom), not an edit: it changes nothing in the plan,
// isn't saved to the server and doesn't reach the other device. It's kept in
// localStorage so it's still set after a reload.

import { CIRCLE_COLOR_ORDER } from "../../shared/constants";
import type { CircleColor, CircleRow } from "../../shared/types";
import { readPref, writePref } from "./prefs";

export const hiddenColorsKey = (planId: string) => `bpn-hidden-colors:${planId}`;

export function readHiddenColors(planId: string): ReadonlySet<CircleColor> {
  const raw = readPref(hiddenColorsKey(planId));
  if (!raw) return new Set();
  try {
    const list: unknown = JSON.parse(raw);
    return new Set(Array.isArray(list) ? CIRCLE_COLOR_ORDER.filter((c) => list.includes(c)) : []);
  } catch {
    return new Set();
  }
}

export function writeHiddenColors(planId: string, hidden: ReadonlySet<CircleColor>) {
  writePref(hiddenColorsKey(planId), hidden.size ? JSON.stringify(CIRCLE_COLOR_ORDER.filter((c) => hidden.has(c))) : null);
}

/** The circles to draw: all but the hidden colours — the selected one always (it's being worked on). */
export function visibleCircles(circles: CircleRow[], hidden: ReadonlySet<CircleColor>, selectedId: string | null): CircleRow[] {
  if (hidden.size === 0) return circles;
  return circles.filter((c) => !hidden.has(c.color) || c.id === selectedId);
}
