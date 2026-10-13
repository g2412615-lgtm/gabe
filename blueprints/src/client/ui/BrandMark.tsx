// The Blueprint Notes mark: DeployMap's graphite tile, re-glyphed from four
// posts to circles marked on a sheet — two grey rings and one lit amber ring
// (the same drawing as public/icon-*.png, see scripts/make-icons.mjs).
// Strokes are a little heavier than the app icon's so they stay crisp at 26px.

export default function BrandMark({ size = 26 }: { size?: number }) {
  const style = size === 26 ? undefined : { width: size, height: size, borderRadius: Math.round(size * 0.3) };
  return (
    <span className="brand-mark" style={style} aria-hidden="true">
      <svg viewBox="0 0 100 100" focusable="false">
        <circle cx="31" cy="32" r="12" fill="none" stroke="#b3bac6" strokeWidth="7.5" />
        <circle cx="31" cy="70" r="7" fill="none" stroke="#858d9b" strokeWidth="6.5" />
        <circle className="bm-lit" cx="64" cy="58" r="19" fill="rgba(247,168,27,0.2)" stroke="#f7a81b" strokeWidth="8.5" />
      </svg>
    </span>
  );
}
