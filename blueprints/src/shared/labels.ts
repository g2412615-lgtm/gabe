// The name a duplicated page gets unless the owner types another one
// (shared: the dialog suggests it, the server falls back to it).

/** "A-101" → "A-101 (copy)", or "A-101 (copy 2)", … — the first that no page in `taken` has; never longer than `max`. */
export function copyLabel(label: string, taken: Iterable<string>, max: number): string {
  const used = new Set(taken);
  // a copy of a copy is named after the original: "A-101 (copy)" → "A-101 (copy 2)"
  const base = label.replace(/ \(copy(?: \d+)?\)$/, "") || label;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const name = `${cutAt(base, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`;
    if (!used.has(name) || n > 999) return name;
  }
}

/** At most `max` UTF-16 units of `s`, cut between whole characters (never half an emoji, a flag or a joined sequence). */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    let out = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) {
      if (out.length + segment.length > max) break;
      out += segment;
    }
    return out;
  }
  // no Segmenter: at least never leave half a surrogate pair
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}
