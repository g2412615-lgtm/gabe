// Duplicating a page: where the copy goes, its name, its own (hard-linked)
// images, a fresh render for a page that isn't ready, and the purge leaving
// the copy's images alone.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeNow } from "../../src/server/maintenance";
import { copyLabel } from "../../src/shared/labels";
import { comparePages } from "../../src/shared/order";
import type { DuplicatePageResponse, PageRow, PlanDoc } from "../../src/shared/types";
import { ensureFixtures, fixture, signedInClient, startTestServer, waitFor, type Client, type TestServer } from "./helpers";

let server: TestServer;
let c: Client;
let planId: string;
let original: PageRow[];

beforeAll(async () => {
  ensureFixtures();
  server = await startTestServer();
  c = await signedInClient(server);
  const r = await c.upload(fixture("event-plan.pdf"), { filename: "Millrace event plan.pdf" });
  expect(r.status).toBe(201);
  planId = r.json.plan.id;
  original = await waitFor(async () => {
    const pages = await pagesOf();
    return pages.every((p) => p.status === "ready") ? pages : null;
  });
});

afterAll(async () => {
  await server?.stop();
});

const pagesOf = async () => (await c.get<{ pages: PageRow[] }>(`/api/plans/${planId}/pages`)).json.pages;
const live = (pages: PageRow[]) => pages.filter((p) => p.deletedAt === null).sort(comparePages);
const duplicate = (pageId: string, body: object = {}) => c.post<DuplicatePageResponse>(`/api/pages/${pageId}/duplicate`, body);
const assetDir = (p: Pick<PageRow, "id" | "assetKey">) => path.join(server.dataDir, "assets", p.id, p.assetKey);
const fetchAsset = (url: string) => fetch(`${server.url}${url}`, { headers: { cookie: c.cookie } });

describe("duplicating a ready page", () => {
  let copy: PageRow;

  beforeAll(async () => {
    const r = await duplicate(original[0].id);
    expect(r.status).toBe(201);
    copy = r.json.page;
    expect(r.json.pages.map((p) => p.id)).toContain(copy.id);
  });

  it("goes right after the original, named as a copy, showing the same sheet at once", () => {
    const a = original[0];
    expect(copy.id).not.toBe(a.id);
    expect(copy.planId).toBe(planId);
    expect(copy.label).toBe("A-101 (copy)");
    expect(copy.sortOrder).toBe(1.5); // between A-101 (1) and P-1 (2)
    expect(copy).toMatchObject({
      status: "ready",
      error: null,
      sourceId: a.sourceId,
      sourceIndex: a.sourceIndex,
      width: a.width,
      height: a.height,
      previewW: a.previewW,
      previewH: a.previewH,
      tileSize: a.tileSize,
      maxLevel: a.maxLevel,
      minLevel: a.minLevel,
      tileFormat: a.tileFormat,
      deletedAt: null,
    });
  });

  it("serves its own preview, thumbnail and tiles — hard links to the original's files", async () => {
    for (const url of [
      `/api/pages/${copy.id}/${copy.assetKey}/preview.webp`,
      `/api/pages/${copy.id}/${copy.assetKey}/thumb.webp`,
      `/api/pages/${copy.id}/${copy.assetKey}/tiles/${copy.maxLevel}/0_0.png`,
    ]) {
      const res = await fetchAsset(url);
      expect(res.status, url).toBe(200);
    }
    const a = path.join(assetDir(original[0]), "preview.webp");
    const b = path.join(assetDir(copy), "preview.webp");
    expect(fs.statSync(b).ino).toBe(fs.statSync(a).ino);
    expect(fs.readdirSync(path.join(assetDir(copy), "tiles")).sort()).toEqual(fs.readdirSync(path.join(assetDir(original[0]), "tiles")).sort());
  });

  it("brings no circles or comments (the device copies those)", async () => {
    const doc = (await c.get<PlanDoc>(`/api/plans/${planId}`)).json;
    expect(doc.circles.filter((x) => x.pageId === copy.id)).toEqual([]);
  });

  it("names a second copy “(copy 2)”, and takes the name it's given", async () => {
    const again = await duplicate(original[0].id);
    expect(again.json.page.label).toBe("A-101 (copy 2)");
    const named = await duplicate(original[0].id, { label: "  A-101   Day 2 " });
    expect(named.json.page.label).toBe("A-101 Day 2");
    // each new copy goes straight after the original, before the earlier copies
    expect(live(await pagesOf()).map((p) => p.label)).toEqual(["A-101", "A-101 Day 2", "A-101 (copy 2)", "A-101 (copy)", "P-1", "C-201", "R-1"]);
  });

  it("a copy of the last page goes at the end", async () => {
    const last = live(await pagesOf()).at(-1)!;
    const r = await duplicate(last.id);
    expect(r.json.page.sortOrder).toBe(last.sortOrder + 1);
    expect(live(await pagesOf()).at(-1)!.id).toBe(r.json.page.id);
  });

  it("with no room between two pages, the pages are renumbered and returned — in the order the device shows them", async () => {
    // P-1 and C-201 came in the same upload (same createdAt): with equal orders, the file's order decides
    const [p, q] = [original[1], original[2]];
    server.db.prepare("UPDATE pages SET sort_order = ? WHERE id IN (?, ?)").run(7, p.id, q.id);
    const pages = live(await pagesOf());
    const before = pages.find((x) => x.id === q.id)!;
    const r = await duplicate(p.id);
    expect(r.status).toBe(201);
    const after = live(r.json.pages);
    const i = after.findIndex((x) => x.id === p.id);
    expect(after[i + 1].id).toBe(r.json.page.id);
    expect(after[i + 2].id).toBe(q.id);
    expect(after.map((x) => x.sortOrder)).toEqual(after.map((_, k) => k)); // 0, 1, 2…
    expect(r.json.pages.find((x) => x.id === q.id)!.rev).toBeGreaterThan(before.rev); // the device picks the new order up
  });

  it("the original's purge leaves the copy's images", async () => {
    const extra = (await duplicate(original[1].id)).json.page; // a copy of P-1
    const old = Date.now() - 40 * 86_400_000;
    server.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").run(old, original[1].id);
    purgeNow(server.db, server.dataDir);
    expect(fs.existsSync(path.join(server.dataDir, "assets", original[1].id))).toBe(false);
    const res = await fetchAsset(`/api/pages/${extra.id}/${extra.assetKey}/preview.webp`);
    expect(res.status).toBe(200);
  });
});

describe("duplicating a page that isn't ready", () => {
  it("queues the copy for its own render from the same file", async () => {
    const r = await c.upload(fixture("suite-level.pdf"), { planId, filename: "suite-level.pdf" });
    expect(r.status).toBe(201);
    const fresh: PageRow = r.json.pages[0];
    // straight away: the page is still queued or rendering
    const d = await duplicate(fresh.id);
    expect(d.status).toBe(201);
    const copy = d.json.page;
    if (copy.status !== "ready") {
      expect(copy.status).toBe("queued");
      expect(copy.width).toBe(0);
      expect(copy.assetKey).not.toBe(fresh.assetKey);
    }
    const done = await waitFor(async () => {
      const p = (await pagesOf()).find((x) => x.id === copy.id);
      return p && p.status === "ready" ? p : null;
    });
    expect(done.sourceId).toBe(fresh.sourceId);
    expect(done.width).toBeGreaterThan(0);
    expect((await fetchAsset(`/api/pages/${done.id}/${done.assetKey}/preview.webp`)).status).toBe(200);
  });
});

describe("a retry with the same id (the reply was lost)", () => {
  it("gets the copy the first try made — never a second one", async () => {
    const id = "copy-retry-0001";
    const first = await duplicate(original[0].id, { id, label: "Retry copy" });
    expect(first.status).toBe(201);
    expect(first.json.page.id).toBe(id);
    const count = live(await pagesOf()).length;
    const again = await duplicate(original[0].id, { id, label: "Retry copy" });
    expect(again.status).toBe(200);
    expect(again.json.page).toEqual(first.json.page);
    expect(live(await pagesOf())).toHaveLength(count);
    expect((await fetchAsset(`/api/pages/${id}/${first.json.page.assetKey}/preview.webp`)).status).toBe(200);
  });

  it("takes the name asked for now, and still answers once the original has been deleted", async () => {
    const id = "copy-retry-0004";
    const first = (await duplicate(original[0].id, { id, label: "Level 2 eats" })).json.page;
    const renamed = await duplicate(original[0].id, { id, label: "Level 2 east" });
    expect(renamed.status).toBe(200);
    expect(renamed.json.page.label).toBe("Level 2 east");
    expect(renamed.json.page.rev).toBeGreaterThan(first.rev); // the device adopts the new name
    // the original goes (on another device) before the next try
    server.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").run(Date.now(), original[0].id);
    try {
      const again = await duplicate(original[0].id, { id });
      expect(again.status).toBe(200);
      expect(again.json.page.id).toBe(id);
      // a new copy of the deleted page can't be made
      expect((await duplicate(original[0].id, { id: "copy-retry-0005" })).status).toBe(404);
    } finally {
      server.db.prepare("UPDATE pages SET deleted_at = NULL WHERE id = ?").run(original[0].id);
    }
  });

  it("refuses an id that belongs to another page (or to the original itself), and a copy deleted meanwhile", async () => {
    const taken = await duplicate(original[0].id, { id: original[0].id });
    expect(taken.status).toBe(409);
    expect((taken.json as unknown as { error: string }).error).toMatch(/can't be made with this id/);
    expect((await duplicate(original[0].id, { id: original[3].id })).status).toBe(409);
    const made = (await duplicate(original[0].id, { id: "copy-retry-0002" })).json.page;
    server.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").run(Date.now(), made.id);
    const r = await duplicate(original[0].id, { id: made.id });
    expect(r.status).toBe(409);
    expect((r.json as unknown as { error: string }).error).toMatch(/deleted in the meantime/);
    // nothing of the refused ids' pages was touched
    expect((await fetchAsset(`/api/pages/${original[0].id}/${original[0].assetKey}/preview.webp`)).status).toBe(200);
  });

  it("clears a folder left for the id by a try cut off by a crash", async () => {
    const id = "copy-retry-0003";
    const stale = path.join(server.dataDir, "assets", id, "old-key");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "junk.bin"), "x");
    const r = await duplicate(original[0].id, { id });
    expect(r.status).toBe(201);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readdirSync(path.join(server.dataDir, "assets", id))).toEqual([r.json.page.assetKey]);
  });
});

describe("refusing", () => {
  it("a page that doesn't exist, was deleted, or is in a deleted plan", async () => {
    expect((await duplicate("no-such-page")).status).toBe(404);
    const pages = live(await pagesOf());
    server.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").run(Date.now(), pages[2].id);
    expect((await duplicate(pages[2].id)).status).toBe(404);

    const other = await c.upload(fixture("suite-level.pdf"), { filename: "Other.pdf" });
    server.db.prepare("UPDATE plans SET deleted_at = ? WHERE id = ?").run(Date.now(), other.json.plan.id);
    expect((await duplicate(other.json.pages[0].id)).status).toBe(404);
  });

  it("leaves no stray image folders after a refusal", async () => {
    const dirs = fs.readdirSync(path.join(server.dataDir, "assets"));
    const ids = new Set((await c.get<PlanDoc>(`/api/plans/${planId}`)).json.pages.map((p) => p.id));
    const others = dirs.filter((d) => !ids.has(d));
    // only the deleted plan's page folder (it rendered before the plan was deleted) may be left
    expect(others.length).toBeLessThanOrEqual(1);
  });
});

describe("copyLabel", () => {
  it("adds (copy), then (copy 2), (copy 3)… and names a copy of a copy after the original", () => {
    expect(copyLabel("A-101", ["A-101"], 200)).toBe("A-101 (copy)");
    expect(copyLabel("A-101", ["A-101", "A-101 (copy)"], 200)).toBe("A-101 (copy 2)");
    expect(copyLabel("A-101 (copy)", ["A-101", "A-101 (copy)"], 200)).toBe("A-101 (copy 2)");
    expect(copyLabel("A-101 (copy 2)", ["A-101", "A-101 (copy)", "A-101 (copy 2)"], 200)).toBe("A-101 (copy 3)");
  });
  it("never cuts an emoji in half at the length limit", () => {
    const label = "x".repeat(192) + "🎪🎪🎪🎪"; // 200 units: the cut falls inside an emoji
    const name = copyLabel(label, [label], 200);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).toMatch(/^x{192}🎪* \(copy\)$/u);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(name)).toBe(false);
  });

  it("never cuts a flag or a joined emoji sequence in half either", () => {
    const flags = "x".repeat(191) + "🇫🇷🇫🇷";
    expect(copyLabel(flags, [flags], 200)).toBe("x".repeat(191) + " (copy)");
    const family = "x".repeat(190) + "👨‍👩‍👧👨‍👩‍👧";
    expect(copyLabel(family, [family], 200)).toBe("x".repeat(190) + " (copy)");
  });

  it("stays within the length limit", () => {
    const long = "x".repeat(200);
    const name = copyLabel(long, [long], 200);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith(" (copy)")).toBe(true);
  });
});
