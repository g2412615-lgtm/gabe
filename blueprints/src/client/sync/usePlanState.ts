// React binding for the plan store: subscribe to a slice of the state.
//
//   const pages  = usePlanState(store, (s) => s.pages);
//   const save   = usePlanState(store, (s) => s.save);
//   const circle = usePlanState(store, (s) => (selectedId ? s.circleById.get(selectedId) ?? null : null));
//
// The component re-renders only when the selected value changes (Object.is,
// or the optional `isEqual`). The result is cached per (state, selector), so
// a selector that builds a new object is recomputed only when the store's
// state or the selector itself changes — and when the new result is equal to
// the previous one, the previous one is returned (stable identity).

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { PlanState, PlanStore } from "./types";

export function usePlanState<T>(store: PlanStore, select: (s: PlanState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ state: PlanState; select: (s: PlanState) => T; value: T } | null>(null);
  // the latest selector/equality, read at call time: an inline arrow doesn't resubscribe
  const selectRef = useRef(select);
  const equalRef = useRef(isEqual);
  selectRef.current = select;
  equalRef.current = isEqual;

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    const sel = selectRef.current;
    const c = cache.current;
    if (c && c.state === s && c.select === sel) return c.value;
    const value = sel(s);
    if (c && equalRef.current(c.value, value)) {
      c.state = s;
      c.select = sel;
      return c.value;
    }
    cache.current = { state: s, select: sel, value };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
