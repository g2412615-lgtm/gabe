// DeployMap's 13px ring spinner; it takes the text colour (currentColor).

export default function Spinner({ size, className, label }: { size?: number; className?: string; label?: string }) {
  const style = size ? { width: size, height: size, borderWidth: size >= 20 ? 2.5 : size <= 10 ? 1.5 : 2 } : undefined;
  return (
    <span
      className={`spinner${className ? ` ${className}` : ""}`}
      style={style}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
