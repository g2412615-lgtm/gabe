// The "Colors" button in the editor's top bar: the plan's colour key.
//
//  - Each colour's label ("what this colour means": Green is "General notes"
//    to start with, the others are the owner's to assign). Labels belong to
//    the event plan: they're saved like any edit and every device sees them.
//  - Show or hide each colour's circles on the blueprint (and in the Notes
//    list), or show only one. That's this device's view only; nothing in the
//    plan changes. The button says how many colours are hidden.

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CIRCLE_COLOR_ORDER, CIRCLE_COLORS, MAX_LEGEND_CHARS } from "../../shared/constants";
import { legendOf } from "../../shared/labels";
import type { CircleColor, CircleRow } from "../../shared/types";
import Menu from "../ui/Menu";
import { usePlanState, type PlanStore } from "../sync";
import { plural } from "./format";
import { paperSwatch } from "./swatch";

export interface ColorsMenuProps {
  store: PlanStore;
  /** The open page: the counts are for it. */
  pageId: string | null;
  hidden: ReadonlySet<CircleColor>;
  onHiddenChange(next: ReadonlySet<CircleColor>): void;
}

const NONE: CircleRow[] = [];

function ColorsMenu({ store, pageId, hidden, onHiddenChange }: ColorsMenuProps) {
  const plan = usePlanState(store, (s) => s.plan);
  const circles = usePlanState(store, (s) => (pageId && s.circlesByPage.get(pageId)) || NONE);
  const counts = useMemo(() => {
    const n = new Map<CircleColor, number>();
    for (const c of circles) n.set(c.color, (n.get(c.color) ?? 0) + 1);
    return n;
  }, [circles]);

  const toggle = (c: CircleColor) => {
    const next = new Set(hidden);
    if (!next.delete(c)) next.add(c);
    onHiddenChange(next);
  };
  const only = (c: CircleColor) => onHiddenChange(new Set(CIRCLE_COLOR_ORDER.filter((x) => x !== c)));

  const label = (
    <>
      <span className="cm-dots" aria-hidden="true">
        {CIRCLE_COLOR_ORDER.map((c) => (
          <span key={c} className={`cm-dot${hidden.has(c) ? " off" : ""}`} style={paperSwatch(CIRCLE_COLORS[c])} />
        ))}
      </span>
      <span className="lbl">Colors</span>
      {hidden.size > 0 && <span className="cm-badge">{hidden.size} hidden</span>}
    </>
  );

  return (
    <Menu
      label={label}
      ariaLabel={hidden.size ? `Colors: ${hidden.size} hidden` : "Colors"}
      title="Show, hide and label the circle colors"
      buttonClassName={`ed-colors-btn${hidden.size ? " filtering" : ""}`}
      align="right"
      popClassName="cm-pop"
    >
      <div className="cm">
        <div className="cm-head">
          <h3 className="cm-title">Circle colors</h3>
          <button type="button" className="ghost small" disabled={hidden.size === 0} onClick={() => onHiddenChange(new Set())}>
            Show all
          </button>
        </div>
        <ul className="cm-list">
          {CIRCLE_COLOR_ORDER.map((c) => {
            const pal = CIRCLE_COLORS[c];
            const off = hidden.has(c);
            const n = counts.get(c) ?? 0;
            const name = pal.label.toLowerCase();
            return (
              <li key={c} className={`cm-row${off ? " off" : ""}`}>
                <input type="checkbox" className="cm-show" checked={!off} onChange={() => toggle(c)} aria-label={`Show ${name} circles`} />
                <span className="nl-dot" style={paperSwatch(pal)} aria-hidden="true" />
                <span className="cm-name">{pal.label}</span>
                <LegendField store={store} color={c} value={legendOf(plan, c)} />
                <span className="cm-count" title={`${plural(n, "circle")} on this page`} aria-label={`${plural(n, "circle")} on this page`}>
                  {n}
                </span>
                <button type="button" className="ghost small cm-only" onClick={() => only(c)} aria-label={`Show only ${name} circles`} title={`Show only ${name} circles`}>
                  Only
                </button>
              </li>
            );
          })}
        </ul>
        <p className="cm-note">Labels are saved with this event plan. Showing and hiding only changes what this device shows.</p>
      </div>
    </Menu>
  );
}

export default memo(ColorsMenu);

/**
 * One colour's label, saved as it's typed (one undo step per label). Enter
 * finishes; Escape puts back what was there when the field took focus.
 */
function LegendField({ store, color, value }: { store: PlanStore; color: CircleColor; value: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const original = useRef(value);
  // follow changes from elsewhere (undo, the other device) unless typing here
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape" && draft !== original.current) {
      // undo the typing first; a second Escape closes the panel
      e.preventDefault();
      e.stopPropagation();
      store.setColorLabel(color, original.current);
      setDraft(original.current);
    }
  };

  return (
    <input
      type="text"
      className="cm-label"
      value={draft}
      maxLength={MAX_LEGEND_CHARS}
      placeholder="Add a label"
      aria-label={`${CIRCLE_COLORS[color].label} label`}
      autoComplete="off"
      enterKeyHint="done"
      onFocus={() => {
        focused.current = true;
        original.current = value;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(legendOf(store.getState().plan, color));
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        store.setColorLabel(color, e.target.value);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
