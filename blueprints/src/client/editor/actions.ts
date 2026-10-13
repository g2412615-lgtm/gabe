// Editor actions shared by several controls (panel buttons, keyboard,
// sidebar menus). Destructive ones act at once and offer Undo in a toast —
// gentler on an iPad than an "Are you sure?" for every circle.

import { api, ApiError } from "../api";
import type { CircleRow, PageRow } from "../../shared/types";
import { notify } from "../ui/notify";
import type { PlanStore } from "../sync";
import { circleName } from "./format";

export function deleteCircleWithUndo(store: PlanStore, circle: CircleRow, onUndo?: () => void) {
  const name = circleName(circle);
  store.deleteCircle(circle.id);
  notify(`${name} deleted.`, "info", {
    action: {
      label: "Undo",
      run: () => {
        store.restoreCircle(circle.id);
        onUndo?.();
      },
    },
  });
}

export function deleteCommentWithUndo(store: PlanStore, commentId: string) {
  store.deleteComment(commentId);
  notify("Comment deleted.", "info", { action: { label: "Undo", run: () => store.restoreComment(commentId) } });
}

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
