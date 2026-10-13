// The editor's delete-with-Undo toasts (actions.ts) and its comment-writing
// rules (commentDrafts.ts), run against a real plan store and the fake
// server. The toasts are the real ones (ui/notify keeps them in a module).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPlanOpen } from "../../src/client/sync/store";
import { DEBOUNCE_MS } from "../../src/client/sync/store";
import { outboxKey } from "../../src/client/sync/outbox";
import { dismissToast, getToasts, runToastAction } from "../../src/client/ui/notify";
import { deleteCircleWithUndo, deleteCommentWithUndo, deletePageWithUndo, registerEditorStore } from "../../src/client/editor/actions";
import { draftIsLive, editComment, finishDraft, settleCommentEdit, typeDraft } from "../../src/client/editor/commentDrafts";
import { device, FakeServer, settle, type Device } from "./fakes";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const t of getToasts()) dismissToast(t.id);
  vi.useRealTimers();
});

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

type Editor = Device & { server: FakeServer; pageId: string; close(): void };

/** An editor open on the plan: a loaded store, registered like EditorPage does. */
async function openEditor(server = new FakeServer(), opts: Parameters<typeof device>[1] = {}): Promise<Editor> {
  const d = device(server, opts);
  const unregister = registerEditorStore(server.planId, d.store);
  await d.store.load();
  await settle();
  return {
    ...d,
    server,
    pageId: d.store.getState().pages[0].id,
    // EditorPage's unmount
    close() {
      unregister();
      d.store.dispose();
    },
  };
}

async function savedCircle(e: Editor) {
  const id = e.store.addCircle({ pageId: e.pageId, x: 0.2, y: 0.3, r: 0.05 });
  await e.store.flushNow();
  await settle();
  return e.store.getState().circleById.get(id)!;
}

async function savedComment(e: Editor, circleId: string, body: string) {
  const id = e.store.addComment(circleId, body);
  await e.store.flushNow();
  await settle();
  return id;
}

const toast = (message: string) => getToasts().find((t) => t.message === message);

/** Press the toast's Undo and let the save run. */
async function pressUndo(message: string) {
  const t = toast(message);
  expect(t, `toast "${message}"`).toBeTruthy();
  runToastAction(t!.id);
  await tick(DEBOUNCE_MS);
}

describe("Undo on a delete toast", () => {
  it("still restores a circle after the owner has left the editor", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    deleteCircleWithUndo(e.store, circle);
    await tick(DEBOUNCE_MS);
    expect(e.server.circles.get(circle.id)!.deletedAt).not.toBeNull();

    e.close(); // "← Plans" within the toast's 8 s
    await pressUndo("Circle #1 deleted.");

    expect(e.server.circles.get(circle.id)!.deletedAt).toBeNull();
    expect(toast("Circle #1 is back.")).toBeTruthy();
    // the closed store was woken only for this and is closed again
    expect(isPlanOpen(e.server.planId)).toBe(false);
    expect(e.storage.data.has(outboxKey(e.server.planId))).toBe(false);
  });

  it("restores a page and a comment after leaving, too", async () => {
    const e = await openEditor(new FakeServer({ pages: 2 }));
    const circle = await savedCircle(e);
    const commentId = await savedComment(e, circle.id, "Gate staff on channel 4");
    const page2 = e.store.getState().pages[1];

    deleteCommentWithUndo(e.store, commentId);
    deletePageWithUndo(e.store, page2);
    await tick(DEBOUNCE_MS);
    expect(e.server.comments.get(commentId)!.deletedAt).not.toBeNull();
    expect(e.server.pages.get(page2.id)!.deletedAt).not.toBeNull();

    e.close();
    await pressUndo(`Deleted page “${page2.label}”.`);
    await pressUndo("Comment deleted.");

    expect(e.server.pages.get(page2.id)!.deletedAt).toBeNull();
    expect(e.server.comments.get(commentId)!.deletedAt).toBeNull();
    expect(e.server.comments.get(commentId)!.body).toBe("Gate staff on channel 4");
    expect(toast(`Page “${page2.label}” is back.`)).toBeTruthy();
    expect(toast("The comment is back.")).toBeTruthy();
  });

  it("offline after leaving: the restore is kept in the device outbox and saved by the next visit", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    deleteCircleWithUndo(e.store, circle);
    await tick(DEBOUNCE_MS);
    e.close();

    e.net.failWith = 0;
    await pressUndo("Circle #1 deleted.");
    expect(toast("Circle #1 is back on this device — it'll be saved when the connection is back.")).toBeTruthy();
    expect(e.server.circles.get(circle.id)!.deletedAt).not.toBeNull();
    const entry = e.storage.json(outboxKey(e.server.planId)).entries[`circle:${circle.id}`];
    expect(entry.local.deletedAt).toBeNull();
    expect(isPlanOpen(e.server.planId)).toBe(false);

    // back online, the plan opened again on this device
    e.net.failWith = null;
    const again = await openEditor(e.server, { storage: e.storage, net: e.net });
    await tick(DEBOUNCE_MS);
    expect(e.server.circles.get(circle.id)!.deletedAt).toBeNull();
    expect(again.store.getState().circleById.has(circle.id)).toBe(true);
    again.close();
  });

  it("goes through the editor that has the plan open again", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    deleteCircleWithUndo(e.store, circle);
    await tick(DEBOUNCE_MS);
    e.close();

    const again = await openEditor(e.server, { storage: e.storage, net: e.net });
    expect(again.store.getState().circleById.has(circle.id)).toBe(false);
    await pressUndo("Circle #1 deleted.");

    // shown at once in the open editor (and undoable there), then saved by it
    expect(again.store.getState().circleById.has(circle.id)).toBe(true);
    expect(again.store.getState().canUndo).toBe(true);
    expect(e.server.circles.get(circle.id)!.deletedAt).toBeNull();
    expect(toast("Circle #1 is back.")).toBeUndefined(); // seen in the editor itself
    again.close();
  });

  it("in the same editor: restores right there and runs its follow-up", async () => {
    const e = await openEditor(new FakeServer({ pages: 2 }));
    const page2 = e.store.getState().pages[1];
    const reopened: string[] = [];
    deletePageWithUndo(e.store, page2, () => reopened.push(page2.id));
    expect(e.store.getState().pageById.has(page2.id)).toBe(false);

    await pressUndo(`Deleted page “${page2.label}”.`);
    expect(e.store.getState().pageById.has(page2.id)).toBe(true);
    expect(reopened).toEqual([page2.id]);
    expect(e.server.pages.get(page2.id)!.deletedAt).toBeNull();
    e.close();
  });
});

describe("editing a comment until it's empty", () => {
  it("deletes it, and the toast's Undo brings back the words it had", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    const original = "Radio channel 4 for gate staff, bring spare batteries";
    const id = await savedComment(e, circle.id, original);

    // Edit, select all, Backspace: the emptied field isn't saved…
    editComment(e.store, id, "");
    await tick(DEBOUNCE_MS);
    expect(e.server.comments.get(id)!.body).toBe(original);

    // …and Done deletes the comment
    settleCommentEdit(e.store, id, original, "");
    await tick(DEBOUNCE_MS);
    expect(e.server.comments.get(id)!.deletedAt).not.toBeNull();

    await pressUndo("Comment deleted.");
    const back = e.store.getState().commentsByCircle.get(circle.id)!.find((c) => c.id === id);
    expect(back?.body).toBe(original);
    expect(e.server.comments.get(id)).toMatchObject({ body: original, deletedAt: null });
    e.close();
  });

  it("emptied after typing something else: Undo still brings back the text from before the edit", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    const id = await savedComment(e, circle.id, "North gate");
    for (const t of ["S", "So", "Sou", "So", "S", ""]) editComment(e.store, id, t);
    settleCommentEdit(e.store, id, "North gate", "");
    await tick(DEBOUNCE_MS);
    await pressUndo("Comment deleted.");
    expect(e.server.comments.get(id)).toMatchObject({ body: "North gate", deletedAt: null });
    e.close();
  });

  it("a comment edited to new words is trimmed and kept", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    const id = await savedComment(e, circle.id, "North gate");
    editComment(e.store, id, "South gate  ");
    settleCommentEdit(e.store, id, "North gate", "South gate  ");
    await tick(DEBOUNCE_MS);
    expect(e.server.comments.get(id)).toMatchObject({ body: "South gate", deletedAt: null });
    expect(toast("Comment deleted.")).toBeUndefined();
    e.close();
  });
});

describe("the composer's draft", () => {
  it("is a comment from the first character; an Undo takes it away and the composer can tell", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    let draft = typeDraft(e.store, circle.id, null, "d");
    draft = typeDraft(e.store, circle.id, draft, "draft two");
    expect(draft).not.toBeNull();
    expect(draftIsLive(e.store.getState(), circle.id, draft)).toBe(true);

    e.store.undo(); // the header's Undo: the whole draft goes
    expect(draftIsLive(e.store.getState(), circle.id, draft)).toBe(false);
    expect(e.store.getState().commentsByCircle.get(circle.id)).toEqual([]);

    // typing again makes a new one rather than writing to the undone comment
    const next = typeDraft(e.store, circle.id, draft, "draft three");
    expect(next).not.toBe(draft);
    expect(e.store.getState().commentsByCircle.get(circle.id)!.map((c) => c.body)).toEqual(["draft three"]);
    e.close();
  });

  it("erasing it all deletes it; Add trims it", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    let draft = typeDraft(e.store, circle.id, null, "x");
    draft = typeDraft(e.store, circle.id, draft, "");
    expect(draft).toBeNull();
    expect(e.store.getState().commentsByCircle.get(circle.id)).toEqual([]);

    draft = typeDraft(e.store, circle.id, null, "  Ramp closed ");
    expect(finishDraft(e.store, circle.id, draft, "  Ramp closed ")).toBe(true);
    expect(finishDraft(e.store, circle.id, null, "   ")).toBe(false);
    await tick(DEBOUNCE_MS);
    expect([...e.server.comments.values()].filter((c) => c.deletedAt === null).map((c) => c.body)).toEqual(["Ramp closed"]);
    e.close();
  });
});

describe("edits while a size drag is open", () => {
  it("a name or colour sent with { live: false } is saved at once, not held back with the drag", async () => {
    const e = await openEditor();
    const circle = await savedCircle(e);
    e.store.beginGesture(); // e.g. a slider gesture that's still open
    e.store.updateCircle(circle.id, { title: "Gate A" }, { live: false });
    e.store.updateCircle(circle.id, { color: "red" }, { live: false });
    expect(e.storage.json(outboxKey(e.server.planId)).entries[`circle:${circle.id}`].local).toMatchObject({ title: "Gate A", color: "red" });
    await tick(DEBOUNCE_MS);
    expect(e.server.circles.get(circle.id)).toMatchObject({ title: "Gate A", color: "red" });
    e.store.endGesture();
    e.close();
  });
});

describe("two Undos pressed after leaving", () => {
  it("both go through, and the woken store is closed once both are done", async () => {
    const e = await openEditor();
    const a = await savedCircle(e);
    const b = await savedCircle(e);
    deleteCircleWithUndo(e.store, a);
    deleteCircleWithUndo(e.store, b);
    await tick(DEBOUNCE_MS);
    e.close();

    runToastAction(toast("Circle #1 deleted.")!.id);
    runToastAction(toast("Circle #2 deleted.")!.id);
    await tick(DEBOUNCE_MS);
    expect(e.server.circles.get(a.id)!.deletedAt).toBeNull();
    expect(e.server.circles.get(b.id)!.deletedAt).toBeNull();
    expect(toast("Circle #1 is back.")).toBeTruthy();
    expect(toast("Circle #2 is back.")).toBeTruthy();
    expect(isPlanOpen(e.server.planId)).toBe(false);
  });
});
