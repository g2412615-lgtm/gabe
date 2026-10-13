// The plan store + sync engine (SPEC §7.4).
//
//   const store = createPlanStore(planId);   // one per open plan
//   useEffect(() => { void store.load(); return () => store.dispose(); }, [store]);
//   const pages = usePlanState(store, (s) => s.pages);

export { createPlanStore } from "./store";
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
