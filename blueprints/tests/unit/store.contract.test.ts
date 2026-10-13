// Contract test: the plan store against the real server (src/server, on a
// temp DATA_DIR) over HTTP — the engine's assumptions about /sync (numbers,
// server-side deletedAt, cleaning, idempotent replays, field-level merges)
// checked end to end. The fake-server tests cover timing and failure paths.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../src/client/api";
import { createPlanStore } from "../../src/client/sync/store";
import type { PlanStore, StorageLike, SyncTransport } from "../../src/client/sync/types";
import type { PageRow, PlanDoc, UploadResponse } from "../../src/shared/types";
import { makePdf, signedInClient, startTestServer, type Client, type TestServer } from "../server/helpers";
import { FakeEnv, MemoryStorage } from "./fakes";

let server: TestServer;
let client: Client;

beforeAll(async () => {
  server = await startTestServer({ render: false }); // pages stay queued; circles don't care
  client = await signedInClient(server);
});
afterAll(async () => {
  await server?.stop();
});

interface Link {
  transport: SyncTransport;
  offline: boolean;
  /** The next sync reaches the server but its reply is lost. */
  loseNextReply: boolean;
}

function link(c: Client): Link {
  const l: Link = { offline: false, loseNextReply: false, transport: null as unknown as SyncTransport };
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (l.offline) throw new ApiError("No connection — your changes are kept on this device.", 0);
    const r = method === "GET" ? await c.get<T>(path) : await c.post<T>(path, body);
    if (r.status >= 400) throw new ApiError((r.json as { error?: string } | null)?.error ?? "That didn't work.", r.status);
    return r.json;
  }
  l.transport = {
    getPlan: (id) => call<PlanDoc>("GET", `/api/plans/${id}`),
    getPages: (id) => call<{ pages: PageRow[] }>("GET", `/api/plans/${id}/pages`),
    me: () => call("GET", "/api/me"),
    sync: async (id, body) => {
      const res = await call<never>("POST", `/api/plans/${id}/sync`, body);
      if (l.loseNextReply) {
        l.loseNextReply = false;
        throw new ApiError("No connection — your changes are kept on this device.", 0);
      }
      return res;
    },
  };
  return l;
}

async function newPlan(pages = 2): Promise<{ planId: string; pages: PageRow[] }> {
  const r = await client.upload(await makePdf({ pages }), { filename: "event.pdf", name: "Contract test plan" });
  expect(r.status).toBe(201);
  const json = r.json as UploadResponse;
  return { planId: json.plan.id, pages: json.pages };
}

async function openStore(planId: string, opts: { storage?: StorageLike; l?: Link } = {}) {
  const l = opts.l ?? link(client);
  const store = createPlanStore(planId, { transport: l.transport, storage: opts.storage ?? new MemoryStorage(), env: new FakeEnv(), notify: () => {} });
  await store.load();
  return { store, l };
}

const serverDoc = async (planId: string) => (await client.get<PlanDoc>(`/api/plans/${planId}`)).json;

async function closeAll(...stores: PlanStore[]) {
  for (const s of stores) s.dispose();
  await new Promise((r) => setTimeout(r, 50)); // let dispose's keepalive finish before the server stops
}

describe("plan store ⇄ real server", () => {
  it("creates circles and comments; the server's numbers come back; nothing is left pending", async () => {
    const { planId, pages } = await newPlan();
    const { store } = await openStore(planId);
    const c1 = store.addCircle({ pageId: pages[0].id, x: 0.25, y: 0.5, r: 0.03 });
    const c2 = store.addCircle({ pageId: pages[1].id, x: 0.75, y: 0.5, r: 0.03, color: "blue" });
    const m = store.addComment(c1, "Two stewards at the tunnel ");
    store.updateCircle(c2, { title: "Gate B\u0007 queue" }); // a control character the server would strip
    await store.flushNow();
    const s = store.getState();
    expect(s.circleById.get(c1)!.num).toBe(1);
    expect(s.circleById.get(c2)).toMatchObject({ num: 2, title: "Gate B queue", color: "blue" });
    expect(s.commentsByCircle.get(c1)![0].body).toBe("Two stewards at the tunnel "); // not trimmed
    expect(store.hasUnsaved()).toBe(false);
    expect(s.save.state).toBe("saved");

    const doc = await serverDoc(planId);
    expect(doc.circles.map((c) => [c.id, c.num]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      [c1, 1],
      [c2, 2],
    ]);
    expect(doc.comments.find((x) => x.id === m)!.circleId).toBe(c1);
    await closeAll(store);
  });

  it("delete, undo and redo round-trip the server's deletedAt without anything left pending", async () => {
    const { planId, pages } = await newPlan(1);
    const { store } = await openStore(planId);
    const c = store.addCircle({ pageId: pages[0].id, x: 0.5, y: 0.5, r: 0.05 });
    await store.flushNow();
    store.deleteCircle(c);
    await store.flushNow();
    expect(store.hasUnsaved()).toBe(false);
    expect((await serverDoc(planId)).circles[0].deletedAt).not.toBeNull();
    store.undo();
    await store.flushNow();
    expect((await serverDoc(planId)).circles[0].deletedAt).toBeNull();
    store.redo();
    await store.flushNow();
    expect(store.hasUnsaved()).toBe(false);
    expect((await serverDoc(planId)).circles[0].deletedAt).not.toBeNull();
    await closeAll(store);
  });

  it("two devices: a move and a recolour of one circle both win; both converge after a pull", async () => {
    const { planId, pages } = await newPlan(1);
    const a = await openStore(planId);
    const c = a.store.addCircle({ pageId: pages[0].id, x: 0.2, y: 0.2, r: 0.05 });
    await a.store.flushNow();
    const b = await openStore(planId);
    a.store.updateCircle(c, { x: 0.6, y: 0.7 });
    b.store.updateCircle(c, { color: "purple" });
    await a.store.flushNow();
    await b.store.flushNow();
    await a.store.pull();
    await b.store.pull();
    for (const d of [a, b]) {
      expect(d.store.getState().circleById.get(c)).toMatchObject({ x: 0.6, y: 0.7, color: "purple", num: 1 });
      expect(d.store.hasUnsaved()).toBe(false);
    }
    await closeAll(a.store, b.store);
  });

  it("a lost reply: the replayed create is idempotent (same number, no duplicate)", async () => {
    const { planId, pages } = await newPlan(1);
    const { store, l } = await openStore(planId);
    l.loseNextReply = true;
    const c = store.addCircle({ pageId: pages[0].id, x: 0.4, y: 0.4, r: 0.05 });
    await store.flushNow();
    expect(store.getState().save.state).toBe("offline");
    await store.flushNow();
    expect(store.getState().circleById.get(c)!.num).toBe(1);
    const next = store.addCircle({ pageId: pages[0].id, x: 0.6, y: 0.4, r: 0.05 });
    await store.flushNow();
    expect(store.getState().circleById.get(next)!.num).toBe(2);
    expect((await serverDoc(planId)).circles).toHaveLength(2);
    await closeAll(store);
  });

  it("offline edits survive a killed tab and are saved by the next visit", async () => {
    const { planId, pages } = await newPlan(2);
    const storage = new MemoryStorage();
    const first = await openStore(planId, { storage });
    first.l.offline = true;
    const c = first.store.addCircle({ pageId: pages[1].id, x: 0.3, y: 0.3, r: 0.05 });
    first.store.addComment(c, "Radio check every hour");
    first.store.renamePage(pages[0].id, "Field level");
    first.store.movePage(pages[1].id, 0);
    first.store.renamePlan("Contract test plan — final");
    await first.store.flushNow();
    expect(first.store.getState().save).toMatchObject({ state: "offline", pending: 5 });
    // the tab dies (no dispose)

    const second = await openStore(planId, { storage });
    await second.store.flushNow();
    expect(second.store.hasUnsaved()).toBe(false);
    const doc = await serverDoc(planId);
    expect(doc.plan.name).toBe("Contract test plan — final");
    expect(doc.pages.map((p) => p.id)).toEqual([pages[1].id, pages[0].id]);
    expect(doc.pages.find((p) => p.id === pages[0].id)!.label).toBe("Field level");
    expect(doc.circles[0]).toMatchObject({ id: c, num: 1, pageId: pages[1].id });
    expect(doc.comments[0].body).toBe("Radio check every hour");
    first.store.dispose();
    await closeAll(second.store);
  });

  it("leaving the editor right after an edit never undoes the other device's later edit (finding #0)", async () => {
    const { planId, pages } = await newPlan(1);
    const ipadStorage = new MemoryStorage();
    const ipad = await openStore(planId, { storage: ipadStorage });
    const c = ipad.store.addCircle({ pageId: pages[0].id, x: 0.2, y: 0.2, r: 0.05 });
    await ipad.store.flushNow();
    ipad.store.updateCircle(c, { x: 0.6 }); // move it…
    void ipad.store.flushNow(); // …and tap back to the plan list (leave guard, then unmount)
    await closeAll(ipad.store);
    expect((await serverDoc(planId)).circles[0].x).toBe(0.6);
    expect(ipadStorage.data.size).toBe(0); // the late reply still cleared the device outbox

    const desk = await openStore(planId);
    desk.store.updateCircle(c, { x: 0.9, title: "Gate A" });
    await desk.store.flushNow();
    await closeAll(desk.store);

    const again = await openStore(planId, { storage: ipadStorage });
    await again.store.flushNow();
    expect((await serverDoc(planId)).circles[0]).toMatchObject({ x: 0.9, title: "Gate A" });
    expect(again.store.getState().circleById.get(c)).toMatchObject({ x: 0.9, title: "Gate A" });
    await closeAll(again.store);
  });

  it("a circle added right before leaving and deleted on the other device stays deleted (finding #0)", async () => {
    const { planId, pages } = await newPlan(1);
    const ipadStorage = new MemoryStorage();
    const ipad = await openStore(planId, { storage: ipadStorage });
    const c = ipad.store.addCircle({ pageId: pages[0].id, x: 0.3, y: 0.3, r: 0.05 });
    ipad.store.addComment(c, "Temporary barrier");
    await closeAll(ipad.store); // dispose's keepalive creates both

    const desk = await openStore(planId);
    desk.store.deleteCircle(c);
    await desk.store.flushNow();
    await closeAll(desk.store);

    const again = await openStore(planId, { storage: ipadStorage });
    await again.store.flushNow();
    const doc = await serverDoc(planId);
    expect(doc.circles[0].deletedAt).not.toBeNull();
    expect(doc.circles).toHaveLength(1);
    expect(again.store.getState().circleById.has(c)).toBe(false);
    await closeAll(again.store);
  });

  it("refreshPages merges render status from GET /pages", async () => {
    const { planId, pages } = await newPlan(1);
    const { store } = await openStore(planId);
    await store.refreshPages();
    expect(store.getState().pageById.get(pages[0].id)!.status).toBe("queued");
    await closeAll(store);
  });
});
