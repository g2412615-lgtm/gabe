// The empty-state illustration: a square sheet with a hairline grid and
// circles marked on it — two ink rings, one "lit" ring filled with KW Gold
// and its comment marker. Flat, square, purely decorative.

export default function EmptyArt({ className }: { className?: string }) {
  return (
    <div className={`empty-art${className ? ` ${className}` : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
