// How a circle colour is shown outside the canvas (the notes list, the
// comments panel): a round swatch, its translucent fill laid over white
// paper with the colour's line around it — the circle as it's drawn on the
// blueprint, so it reads the same on the dark theme as on the light one.

import type { CSSProperties } from "react";

export function paperSwatch(p: { fill: string; stroke: string }): CSSProperties {
  return { background: `linear-gradient(${p.fill}, ${p.fill}), #fff`, borderColor: p.stroke };
}
