// Undo/redo history. Each step records, per row it touched, the editable
// fields' values before and after — not a snapshot of the whole document.
// Undoing a step therefore puts back only what the owner changed in that
// step: an edit that arrived from the other device in the meantime (a
// recolour on the iPad while the desktop undoes a move) is left alone, and
// server-owned fields (num, render status, rev) are never touched.
//
// Creating a row is recorded as `deletedAt: <time> → null`, so undoing an add
// soft-deletes it and redo brings it back under the same id.

import type { EntityKind, ID } from "../../shared/types";

export const MAX_HISTORY = 100;
/** Typing pauses longer than this start a new undo step. */
export const COALESCE_IDLE_MS = 3000;

export interface RowChange {
  kind: EntityKind;
  id: ID;
  /** Field values before the step (only the fields the step changed). */
  before: Record<string, unknown>;
  /** Field values after the step. */
  after: Record<string, unknown>;
}

export interface Step {
  changes: RowChange[];
}

export class History {
  private past: Step[] = [];
  private future: Step[] = [];
  /** The step typing may still merge into: same tag, still on top, not idle too long. */
  private open: { tag: string; step: Step; at: number } | null = null;

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  /**
   * Record a step. With a `tag` (e.g. "comment:<id>"), consecutive pushes with
   * the same tag less than COALESCE_IDLE_MS apart merge into one step.
   */
  push(changes: RowChange[], now: number, tag: string | null = null) {
    if (!changes.length) return;
    const open = this.open;
    if (tag && open && open.tag === tag && now - open.at < COALESCE_IDLE_MS && this.past[this.past.length - 1] === open.step) {
      for (const c of changes) mergeChange(open.step, c);
      open.at = now;
      this.future = [];
      return;
    }
    const step: Step = { changes: changes.map((c) => ({ ...c, before: { ...c.before }, after: { ...c.after } })) };
    this.past.push(step);
    if (this.past.length > MAX_HISTORY) this.past.splice(0, this.past.length - MAX_HISTORY);
    this.future = [];
    this.open = tag ? { tag, step, at: now } : null;
  }

  /** End any typing run (another kind of action happened). */
  seal() {
    this.open = null;
  }

  /** Take the step to undo (moving it to the redo stack). */
  takeUndo(): Step | null {
    this.open = null;
    const step = this.past.pop();
    if (!step) return null;
    this.future.push(step);
    if (this.future.length > MAX_HISTORY) this.future.splice(0, this.future.length - MAX_HISTORY);
    return step;
  }

  /** Take the step to redo (moving it back to the undo stack). */
  takeRedo(): Step | null {
    this.open = null;
    const step = this.future.pop();
    if (!step) return null;
    this.past.push(step);
    if (this.past.length > MAX_HISTORY) this.past.splice(0, this.past.length - MAX_HISTORY);
    return step;
  }
}

function mergeChange(step: Step, c: RowChange) {
  const existing = step.changes.find((x) => x.kind === c.kind && x.id === c.id);
  if (!existing) {
    step.changes.push({ ...c, before: { ...c.before }, after: { ...c.after } });
    return;
  }
  // the earliest "before" wins; the latest "after" wins
  for (const [f, v] of Object.entries(c.before)) if (!(f in existing.before)) existing.before[f] = v;
  Object.assign(existing.after, c.after);
}
