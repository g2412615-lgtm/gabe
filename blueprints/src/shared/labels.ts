// The name a duplicated page gets unless the owner types another one
// (shared: the dialog suggests it, the server falls back to it).

/** "A-101" → "A-101 (copy)", or "A-101 (copy 2)", … — the first that no page in `taken` has; never longer than `max`. */
export function copyLabel(label: string, taken: Iterable<string>, max: number): string {
  const used = new Set(taken);
  // a copy of a copy is named after the original: "A-101 (copy)" → "A-101 (copy 2)"
  const base = label.replace(/ \(copy(?: \d+)?\)$/, "") || label;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const name = `${base.slice(0, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`;
    if (!used.has(name) || n > 999) return name;
  }
}
