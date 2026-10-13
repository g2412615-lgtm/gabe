// Editor actions shared by several controls (panel buttons, keyboard,
// sidebar menus). Destructive ones act at once and offer Undo in a toast —
// gentler on an iPad than an "Are you sure?" for every circle.
//
// Those toasts stay up for a few seconds whatever screen opens next, so an
// Undo can come after the owner has left the editor. A closed editor's
// store has stopped saving, so Undo goes through the store that has the plan
// open now — or, when none has, wakes the closed one just long enough to
// put the row back and save it (see undoDelete).

import { api, ApiError } from "../api";
import type { CircleRow, PageRow } from "../../shared/types";
import { notify } from "../ui/notify";
import type { PlanStore } from "../sync";
import { circleName } from "./format";

// ── which store has a plan open ────────────────────────────────────────

/** The store of each plan open in an editor right now (one editor at a time per plan in this tab). */
const editorStores = new Map<string, PlanStore>();
/** Which plan each editor store was for (kept after it closes, for its toasts). */
const planOfStore = new WeakMap<PlanStore, string>();

/**
 * EditorPage: `store` edits `planId` until the returned function is called
 * (call it before disposing the store).
 */
export function registerEditorStore(planId: string, store: PlanStore): () => void {
  planOfStore.set(store, planId);
  editorStores.set(planId, store);
  return () => {
    if (editorStores.get(planId) === store) editorStores.delete(planId);
  };
}

/** The loaded store of the editor that has this plan open, if any. */
export function openEditorStore(planId: string): PlanStore | null {
  const s = editorStores.get(planId);
  return s && s.getState().loaded ? s : null;
}

// ── delete with Undo ───────────────────────────────────────────────────

export function deleteCircleWithUndo(store: PlanStore, circle: CircleRow, onUndo?: () => void) {
  const name = circleName(circle);
  store.deleteCircle(circle.id);
  notify(`${name} deleted.`, "info", {
    action: { label: "Undo", run: () => undoDelete(store, name, (s) => s.restoreCircle(circle.id), onUndo) },
  });
}

export function deleteCommentWithUndo(store: PlanStore, commentId: string) {
  store.deleteComment(commentId);
  notify("Comment deleted.", "info", {
    action: { label: "Undo", run: () => undoDelete(store, "The comment", (s) => s.restoreComment(commentId)) },
  });
}

/** `onUndo` runs only while the same editor is still open (e.g. to show the page again). */
export function deletePageWithUndo(store: PlanStore, page: Pick<PageRow, "id" | "label">, onUndo?: () => void) {
  store.deletePage(page.id);
  notify(`Deleted page “${page.label}”.`, "info", {
    action: { label: "Undo", run: () => undoDelete(store, `Page “${page.label}”`, (s) => s.restorePage(page.id), onUndo) },
  });
}

/**
 * Run a delete toast's Undo: in the editor that has the plan open now (the
 * one the delete was made in, or the plan opened again since); with none,
 * through the closed editor's store, woken for the purpose.
 */
function undoDelete(store: PlanStore, what: string, restore: (s: PlanStore) => void, here?: () => void) {
  const planId = planOfStore.get(store);
  // a store no editor ever registered: it's its own (tests, other callers)
  const open = planId === undefined ? store : openEditorStore(planId);
  if (open) {
    restore(open);
    if (open === store) here?.();
    return;
  }
  void restoreAfterLeaving(store, what, restore);
}

/** Closed editor stores woken for an Undo, and how many Undos are using each right now. */
const woken = new Map<PlanStore, number>();

/**
 * The editor is closed: revive its store (load() brings a disposed store
 * back with everything it had), make the change, save, and close it again.
 * The change goes through the device outbox like any edit, so offline or
 * signed out it's kept on this device and sent later (the home page sends
 * leftover outboxes); the toast says which happened.
 */
async function restoreAfterLeaving(store: PlanStore, what: string, restore: (s: PlanStore) => void) {
  woken.set(store, (woken.get(store) ?? 0) + 1);
  try {
    await store.load();
    if (!store.getState().loaded) {
      notify(`${what} wasn't brought back — the plan couldn't be opened. Check the connection and try again.`, "error");
      return;
    }
    restore(store);
    await store.flushNow();
    const save = store.getState().save;
    if (!store.hasUnsaved()) notify(`${what} is back.`, "ok");
    else if (save.state === "error") notify(`${what} wasn't brought back. ${save.message ?? "The server didn't take the change."}`, "error");
    else if (save.state === "signedOut") notify(`${what} is back on this device — it'll be saved once you sign in again.`, "info");
    else notify(`${what} is back on this device — it'll be saved when the connection is back.`, "info");
  } catch (err) {
    console.error(err);
    notify(`${what} wasn't brought back. Open the plan and try again.`, "error");
  } finally {
    // close it again once no other Undo is using it — unless an editor has picked this very store back up
    const n = (woken.get(store) ?? 1) - 1;
    if (n > 0) woken.set(store, n);
    else {
      woken.delete(store);
      const planId = planOfStore.get(store);
      if (planId === undefined || editorStores.get(planId) !== store) store.dispose();
    }
  }
}

// ── pages ──────────────────────────────────────────────────────────────

/** Prepare a failed page again (a fresh render), then pick up its new status. */
export async function retryPage(store: PlanStore, page: Pick<PageRow, "id" | "label">) {
  try {
    const res = await api.retryPage(page.id);
    if (res?.page) store.mergePages([res.page]);
  } catch (err) {
    // the API's no-connection sentence talks about kept changes, which isn't the point here
    const why = err instanceof ApiError && err.status !== 0 && err.message ? ` ${err.message}` : " Check the connection and try again.";
    notify(`“${page.label}” wasn't sent to be prepared again.${why}`, "error");
    return;
  }
  void store.refreshPages();
}
