// Floating controls over the canvas: the zoom panel (bottom-right) and the
// add-mode hint (top-centre). Both stay clear of the editor's floating right
// panel via `rightInset`. The three glyphs are drawn here (Feather paths, the
// same style as ui/icons.tsx) so the canvas has no dependency on the icon set.

import type { ReactNode } from "react";
import { useMediaQuery } from "../../ui/media";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const GlyphMinus = () => (
  <Glyph>
    <line x1="5" y1="12" x2="19" y2="12" />
  </Glyph>
);
const GlyphPlus = () => (
  <Glyph>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Glyph>
);
const GlyphFit = () => (
  <Glyph>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
  </Glyph>
);

export function ZoomControls(props: {
  pct: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  rightInset: number;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}) {
  return (
    <div className="bp-zoom" role="group" aria-label="Zoom" style={props.rightInset ? { right: 14 + props.rightInset } : undefined}>
      <button type="button" className="bp-zoom-btn" onClick={props.onZoomOut} disabled={!props.canZoomOut} aria-label="Zoom out" title="Zoom out (−)">
        <GlyphMinus />
      </button>
      <span className="bp-zoom-pct" title="Zoom (100% = whole page)">
        {props.pct}%
      </span>
      <button type="button" className="bp-zoom-btn" onClick={props.onZoomIn} disabled={!props.canZoomIn} aria-label="Zoom in" title="Zoom in (+)">
        <GlyphPlus />
      </button>
      <button type="button" className="bp-zoom-btn" onClick={props.onFit} aria-label="Fit the page to the screen" title="Fit the page to the screen (0)">
        <GlyphFit />
      </button>
    </div>
  );
}

export function AddHint({ topInset, rightInset, onCancel }: { topInset: number; rightInset: number; onCancel?: () => void }) {
  // Word it for the hand that's holding the device.
  const coarse = useMediaQuery("(pointer: coarse)");
  return (
    <div className="bp-hint" role="status" style={{ top: 12 + topInset, left: `calc((100% - ${rightInset}px) / 2)` }}>
      <span className="bp-hint-ring" aria-hidden="true" />
      <span className="bp-hint-text">{coarse ? "Tap" : "Click"} the blueprint to add a circle — drag to size it</span>
      {onCancel && (
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
