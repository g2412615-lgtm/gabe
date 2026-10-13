// The empty-state illustration: DeployMap's grid tile, with circles marked on
// it instead of dots — two grey rings, one lit amber ring and its comment
// marker. Purely decorative.

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
