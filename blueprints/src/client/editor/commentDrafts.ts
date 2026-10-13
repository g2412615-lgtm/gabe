// How the comments panel writes comments, kept free of React so it can be
// tested against a real store. Everything goes to the store as it's typed
// (on an iPad, blur and unmount are not dependable moments to save):
//
//  - the composer's draft is a real comment from its first character;
//  - the inline editor saves an existing comment as it's edited, and
//    deleting a comment by emptying it keeps its words for the Undo.

import type { PlanState, PlanStore } from "../sync";
import { deleteCommentWithUndo } from "./actions";

/** Is the composer's draft still a live comment on its circle? An Undo, or the other device, can take it away. */
export function draftIsLive(s: PlanState, circleId: string, draftId: string | null): boolean {
  return !!draftId && (s.commentsByCircle.get(circleId)?.some((c) => c.id === draftId) ?? false);
}

/**
 * The composer's text changed: the first non-blank character creates the
 * comment, further typing updates it, erasing it all deletes it again.
 * Returns the draft's id afterwards (null: there's none).
 */
export function typeDraft(store: PlanStore, circleId: string, draftId: string | null, text: string): string | null {
  const blank = text.trim() === "";
  if (draftId && draftIsLive(store.getState(), circleId, draftId)) {
    if (blank) {
      store.deleteComment(draftId);
      return null;
    }
    store.updateComment(draftId, text);
    return draftId;
  }
  return blank ? null : store.addComment(circleId, text);
}

/**
 * Add (or ⌘/Ctrl+Enter): the draft becomes a finished comment, its ends
 * trimmed — created now if it isn't live. False when there's nothing to add.
 */
export function finishDraft(store: PlanStore, circleId: string, draftId: string | null, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (draftId && draftIsLive(store.getState(), circleId, draftId)) {
    if (t !== text) store.updateComment(draftId, t);
  } else store.addComment(circleId, t);
  return true;
}

/** Leaving the circle with a draft: it's saved already; just tidy its ends. */
export function leaveDraft(store: PlanStore, circleId: string, draftId: string | null, text: string) {
  const t = text.trim();
  if (draftId && t && t !== text && draftIsLive(store.getState(), circleId, draftId)) store.updateComment(draftId, t);
}

/**
 * The inline editor's text changed: save it — except an emptied field. An
 * empty comment is deleted when the editor closes, and until then the store
 * keeps the last words (closing the tab mid-way loses nothing).
 */
export function editComment(store: PlanStore, commentId: string, text: string) {
  if (text.trim()) store.updateComment(commentId, text);
}

/**
 * The inline editor closes: trim what was typed, or — nothing left — delete
 * the comment with the text it had before this edit, so the toast's Undo
 * brings those words back rather than a blank comment.
 */
export function settleCommentEdit(store: PlanStore, commentId: string, original: string, text: string) {
  const t = text.trim();
  if (!t) {
    store.updateComment(commentId, original);
    deleteCommentWithUndo(store, commentId);
  } else if (t !== text) store.updateComment(commentId, t);
}
