// The plan store + sync engine (SPEC §7.4).
//
//   const store = createPlanStore(planId);   // one per open plan
//   useEffect(() => { void store.load(); return () => store.dispose(); }, [store]);
//   const pages = usePlanState(store, (s) => s.pages);
//
// The home page calls startBackgroundSave() so changes an editor left on
// this device (closed while offline) are sent without reopening that plan.

export { createPlanStore, isPlanOpen } from "./store";
export { flushStoredOutboxes, startBackgroundSave, type LeftoverResult } from "./background";
export { usePlanState } from "./usePlanState";
export type {
  CirclePatch,
  Notifier,
  PlanState,
  PlanStore,
  PlanStoreOptions,
  SaveInfo,
  SaveState,
  StorageLike,
  SyncEnv,
  SyncEnvHandlers,
  SyncTransport,
  Timers,
} from "./types";
