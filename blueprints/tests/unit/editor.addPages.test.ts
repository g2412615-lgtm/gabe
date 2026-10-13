// "Add pages" (useAddPages.ts): the upload queue lives outside the editor,
// so files still waiting when the owner leaves the plan are uploaded anyway,
// one after another, and each one's outcome is told in a toast.

import { describe, expect, it } from "vitest";
import { ApiError, type UploadHandle } from "../../src/client/api";
import type { PageRow, UploadResponse } from "../../src/shared/types";
import type { PlanStore } from "../../src/client/sync";
import { createUploadQueues } from "../../src/client/editor/useAddPages";

const PLAN = "plan-1";

/** A fake upload the test answers by hand. */
interface Pending {
  file: File;
  progress: (f: number) => void;
  resolve: (pages: Partial<PageRow>[]) => Promise<void>;
  reject: (err: unknown) => Promise<void>;
  aborted: boolean;
}

function setup(opts: { editorOpen?: boolean } = {}) {
  const uploads: Pending[] = [];
  const toasts: { message: string; kind: string }[] = [];
  const merged: PageRow[][] = [];
  const editorStore = { mergePages: (pages: PageRow[]) => merged.push(pages) } as unknown as PlanStore;
  let editorOpen = opts.editorOpen ?? false;
  const queues = createUploadQueues({
    upload(file, _planId, onProgress): UploadHandle {
      let res!: (r: UploadResponse) => void;
      let rej!: (e: unknown) => void;
      const promise = new Promise<UploadResponse>((a, b) => {
        res = a;
        rej = b;
      });
      const p: Pending = {
        file,
        progress: onProgress,
        aborted: false,
        resolve: async (pages) => {
          res({ pages: pages as PageRow[] } as UploadResponse);
          await flush();
        },
        reject: async (err) => {
          rej(err);
          await flush();
        },
      };
      uploads.push(p);
      return {
        promise,
        abort: () => {
          p.aborted = true;
          rej(new ApiError("Upload cancelled.", 0));
        },
      };
    },
    storeFor: () => (editorOpen ? editorStore : null),
    notify: (message, kind) => void toasts.push({ message, kind }),
  });
  return {
    queues,
    uploads,
    toasts,
    merged,
    setEditorOpen(v: boolean) {
      editorOpen = v;
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45])], name, { type: "application/pdf" });
const page = (id: string): Partial<PageRow> => ({ id, planId: PLAN, label: id, status: "queued" });

describe("Add pages", () => {
  it("keeps uploading the waiting files after the owner leaves the plan, and names the plan in the toasts", async () => {
    const t = setup({ editorOpen: true });
    const stop = t.queues.subscribe(PLAN, () => {});
    t.queues.add(PLAN, [pdf("event-plan.pdf"), pdf("warehouse.pdf"), pdf("suite-level.pdf")], "Spring concert");
    expect(t.uploads.map((u) => u.file.name)).toEqual(["event-plan.pdf"]); // one at a time
    expect(t.queues.items(PLAN).map((i) => i.phase)).toEqual(["sending", "waiting", "waiting"]);

    // "← Plans" while the first is sending
    stop();
    t.setEditorOpen(false);

    await t.uploads[0].resolve([page("p1"), page("p2")]);
    expect(t.uploads.map((u) => u.file.name)).toEqual(["event-plan.pdf", "warehouse.pdf"]);
    await t.uploads[1].reject(new ApiError("That file isn't a PDF, PNG or JPG.", 400));
    expect(t.uploads.map((u) => u.file.name)).toEqual(["event-plan.pdf", "warehouse.pdf", "suite-level.pdf"]);
    await t.uploads[2].resolve([page("p3")]);

    expect(t.toasts).toEqual([
      { message: "Added 2 pages from “event-plan.pdf” to “Spring concert”.", kind: "ok" },
      { message: "“warehouse.pdf” wasn't added to “Spring concert”. That file isn't a PDF, PNG or JPG.", kind: "error" },
      { message: "Added 1 page from “suite-level.pdf” to “Spring concert”.", kind: "ok" },
    ]);
    expect(t.queues.items(PLAN)).toEqual([]);
    expect(t.merged).toEqual([]); // no editor to hand them to: the plan loads them next time
  });

  it("hands each file's pages to the open editor, which hears about them, and shows progress rows", async () => {
    const t = setup({ editorOpen: true });
    const added: string[][] = [];
    let renders = 0;
    t.queues.subscribe(PLAN, () => renders++);
    t.queues.onAdded(PLAN, (pages) => added.push(pages.map((p) => p.id)));
    t.queues.add(PLAN, [pdf("a.pdf")], "Spring concert");
    t.uploads[0].progress(0.5);
    expect(t.queues.items(PLAN)[0]).toMatchObject({ name: "a.pdf", phase: "sending", progress: 0.5 });
    t.uploads[0].progress(1);
    expect(t.queues.items(PLAN)[0]).toMatchObject({ phase: "checking", progress: null });
    await t.uploads[0].resolve([page("p1")]);

    expect(t.merged.map((m) => m.map((p) => p.id))).toEqual([["p1"]]);
    expect(added).toEqual([["p1"]]);
    expect(t.toasts).toEqual([{ message: "Added 1 page from “a.pdf”.", kind: "ok" }]);
    expect(renders).toBeGreaterThan(0);
  });

  it("coming back to the plan shows the rows still going; cancel drops a waiting file, or aborts the one sending", async () => {
    const t = setup();
    t.queues.add(PLAN, [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], "Spring concert");
    const [a, b, c] = t.queues.items(PLAN);
    expect(t.queues.items(PLAN)).toHaveLength(3); // a remounted sidebar reads these

    t.queues.cancel(PLAN, b.id);
    t.queues.cancel(PLAN, a.id);
    await flush();
    expect(t.uploads[0].aborted).toBe(true);
    expect(t.uploads.map((u) => u.file.name)).toEqual(["a.pdf", "c.pdf"]);
    expect(t.queues.items(PLAN).map((i) => i.id)).toEqual([c.id]);
    expect(t.toasts).toEqual([]); // a cancel isn't news
  });

  it("refuses files that can't be blueprints before queueing them", () => {
    const t = setup();
    t.queues.add(PLAN, [new File(["x"], "notes.txt", { type: "text/plain" })], "Spring concert");
    expect(t.uploads).toEqual([]);
    expect(t.toasts).toEqual([{ message: "“notes.txt” isn't a PDF, PNG or JPG.", kind: "error" }]);
  });
});
