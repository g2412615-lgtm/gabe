// The render queue's safety rails: a page whose renderer keeps dying is
// given up on instead of crash-looping, renders run in their own process
// (killable, first in line for the OOM killer), deleted pages and plans are
// skipped and stop their render, scans get JPEG tiles, sheets are capped by
// area, and a full disk says so.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { isStorageFull } from "../../src/server/storage";
import type { PageRow } from "../../src/shared/types";
import { makePdf, signedInClient, startTestServer, waitFor, type Client, type TestServer } from "./helpers";

const linux = process.platform === "linux";
const ARCH_D: [number, number] = [2592, 1728]; // 36×24 in: ~40 MP, a second or two to render

const TOO_LARGE = "This page is too large or complex to prepare. Try exporting it as a smaller PDF.";
const STORAGE_RENDER = "The app's storage is full, so this page couldn't be prepared. Add more storage (the setup guide explains how), then press Retry.";

async function pagesOf(c: Client, planId: string): Promise<PageRow[]> {
  return (await c.get<{ pages: PageRow[] }>(`/api/plans/${planId}/pages`)).json.pages;
}

/** Live render worker processes whose task mentions `pageId` (Linux /proc). */
function renderWorkers(pageId: string): number[] {
  const pids: number[] = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmd.includes('"task":"render"') && cmd.includes(pageId)) pids.push(Number(name));
    } catch {
      /* gone meanwhile */
    }
  }
  return pids;
}

/** The OOM killer, played by the test: SIGKILL the page's render worker as soon as it exists. */
async function killWorker(pageId: string, skip: Set<number> = new Set()): Promise<number> {
  const pid = await waitFor(async () => renderWorkers(pageId).find((p) => !skip.has(p)), 20_000, 5);
  // the worker asked the kernel to pick it, not the server, when memory runs out
  expect(fs.readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim()).toBe("1000");
  process.kill(pid, "SIGKILL");
  skip.add(pid);
  return pid;
}

async function withServer<T>(overrides: Parameters<typeof startTestServer>[0], fn: (s: TestServer, c: Client) => Promise<T>): Promise<T> {
  const s = await startTestServer(overrides);
  try {
    return await fn(s, await signedInClient(s));
  } finally {
    await s.stop();
  }
}

describe("a page whose renderer keeps dying", () => {
  it.skipIf(!linux)("is retried once, then marked failed — the server stays up — and Retry starts afresh", () =>
    withServer({}, async (s, c) => {
      const up = await c.upload(await makePdf({ pages: 1, size: ARCH_D }), { filename: "heavy.pdf" });
      const pageId = up.json.pages[0].id;
      const killed = new Set<number>();

      await killWorker(pageId, killed); // attempt 1
      await killWorker(pageId, killed); // attempt 2 (it was queued again by itself)
      const [failed] = await waitFor(async () => {
        const ps = await pagesOf(c, up.json.plan.id);
        return ps[0].status === "failed" ? ps : null;
      });
      expect(failed.error).toBe(TOO_LARGE);
      await s.queue.whenIdle();
      expect(renderWorkers(pageId)).toEqual([]);
      expect((await c.get("/api/me")).status).toBe(200); // the server never went down
      expect(fs.existsSync(path.join(s.dataDir, "assets", pageId))).toBe(false); // nothing half-made left
      expect(fs.readdirSync(path.join(s.dataDir, "tmp"))).toEqual([]);

      // Retry gives it fresh attempts
      expect((await c.post(`/api/pages/${pageId}/retry`)).json.page.status).toBe("queued");
      await killWorker(pageId, killed);
      const [ready] = await waitFor(async () => {
        const ps = await pagesOf(c, up.json.plan.id);
        return ps[0].status === "ready" ? ps : null;
      });
      expect(ready.error).toBeNull();
      expect(ready.maxLevel).toBeGreaterThan(0);
    }),
  );

  it("is not retried at boot once it has been cut off twice (no crash loop)", async () => {
    const first = await startTestServer({ render: false });
    const c = await signedInClient(first);
    const up = await c.upload(await makePdf({ pages: 2 }), { filename: "boot.pdf" });
    const [killer, other] = up.json.pages;
    // as the database looks after the server was killed mid-render: the
    // first page twice already, the second once
    first.db.prepare("UPDATE pages SET status = 'rendering', render_attempts = 2 WHERE id = ?").run(killer.id);
    first.db.prepare("UPDATE pages SET status = 'rendering', render_attempts = 1 WHERE id = ?").run(other.id);
    await first.shutdown(1000);

    await withServer({ dataDir: first.dataDir }, async (s, c2) => {
      await s.queue.whenIdle();
      const [a, b] = await pagesOf(c2, up.json.plan.id);
      expect(a.status).toBe("failed");
      expect(a.error).toBe(TOO_LARGE);
      expect(b.status).toBe("ready"); // one more try was allowed
      expect(s.db.prepare("SELECT render_attempts AS n FROM pages WHERE id = ?").get(other.id)).toEqual({ n: 0 });

      // Retry resets the count and renders it
      await c2.post(`/api/pages/${killer.id}/retry`);
      await s.queue.whenIdle();
      expect((await pagesOf(c2, up.json.plan.id))[0].status).toBe("ready");
    });
  });

  it("stays viewable (preview only) when it was cut off twice after its preview was made", async () => {
    const first = await startTestServer({});
    const c = await signedInClient(first);
    const up = await c.upload(await makePdf({ pages: 1 }), { filename: "tiles.pdf" });
    await first.queue.whenIdle();
    const [done] = await pagesOf(c, up.json.plan.id);
    expect(done.status).toBe("ready");
    first.db.prepare("UPDATE pages SET status = 'preview', render_attempts = 2 WHERE id = ?").run(done.id);
    await first.shutdown(1000);

    await withServer({ dataDir: first.dataDir }, async (s, c2) => {
      await s.queue.whenIdle();
      const [page] = await pagesOf(c2, up.json.plan.id);
      expect(page).toMatchObject({ status: "ready", error: null, assetKey: done.assetKey, maxLevel: 0, minLevel: 0, tileSize: 0, tileFormat: "" });
      expect([page.width, page.previewW]).toEqual([done.width, done.previewW]);
      const preview = await fetch(`${s.url}/api/pages/${page.id}/${page.assetKey}/preview.webp`, { headers: { cookie: c2.cookie } });
      expect(preview.status).toBe(200);
      expect(fs.existsSync(path.join(s.dataDir, "assets", page.id, page.assetKey, "tiles"))).toBe(false);
    });
  });

  it.skipIf(!linux)("keeps the preview when the worker dies while making tiles", () =>
    withServer({}, async (s, c) => {
      const up = await c.upload(await makePdf({ pages: 1, size: ARCH_D }), { filename: "tiles-die.pdf" });
      const pageId = up.json.pages[0].id;
      await waitFor(async () => (await pagesOf(c, up.json.plan.id))[0].status === "preview", 20_000, 5);
      for (const pid of renderWorkers(pageId)) process.kill(pid, "SIGKILL");
      await s.queue.whenIdle();
      const [page] = await pagesOf(c, up.json.plan.id);
      expect(page).toMatchObject({ status: "ready", error: null, maxLevel: 0, tileFormat: "" });
      expect(page.previewW).toBe(2048);
      const thumb = await fetch(`${s.url}/api/pages/${page.id}/${page.assetKey}/thumb.webp`, { headers: { cookie: c.cookie } });
      expect(thumb.status).toBe(200); // made before the page was announced as viewable
    }),
  );
});

describe("timeouts", () => {
  it("kill the worker process and leave nothing behind", () =>
    withServer({ renderTimeoutMs: 400 }, async (s, c) => {
      const up = await c.upload(await makePdf({ pages: 1, size: ARCH_D }), { filename: "slow.pdf" });
      await s.queue.whenIdle();
      const [page] = await pagesOf(c, up.json.plan.id);
      expect(page.status).toBe("failed");
      expect(page.error).toBe("This page took too long to prepare.");
      if (linux) expect(renderWorkers(page.id)).toEqual([]); // really stopped, not still decoding in the background
      expect(fs.readdirSync(path.join(s.dataDir, "tmp"))).toEqual([]);
      expect(fs.existsSync(path.join(s.dataDir, "assets", page.id))).toBe(false);
    }),
  );
});

describe("deleted pages and plans", () => {
  it("a deleted plan's pages wait (its render in progress stops) and the next upload goes first; Undo brings them back", () =>
    withServer({}, async (s, c) => {
      const wrong = await c.upload(await makePdf({ pages: 3, size: ARCH_D }), { filename: "wrong set.pdf" });
      const wrongIds = wrong.json.pages.map((p) => p.id);
      if (linux) await waitFor(async () => renderWorkers(wrongIds[0]).length > 0, 20_000, 5);
      expect((await c.patch(`/api/plans/${wrong.json.plan.id}`, { deleted: true })).status).toBe(200);
      const right = await c.upload(await makePdf({ pages: 1 }), { filename: "right set.pdf" });
      await s.queue.whenIdle();

      expect((await pagesOf(c, right.json.plan.id))[0].status).toBe("ready");
      const stmt = s.db.prepare("SELECT status FROM pages WHERE id = ?");
      expect(wrongIds.map((id) => (stmt.get(id) as { status: string }).status)).toEqual(["queued", "queued", "queued"]);
      if (linux) expect(renderWorkers(wrongIds[0])).toEqual([]);
      for (const id of wrongIds) expect(fs.existsSync(path.join(s.dataDir, "assets", id))).toBe(false);
      // stopping it didn't count against the page
      expect(s.db.prepare("SELECT render_attempts AS n FROM pages WHERE id = ?").get(wrongIds[0])).toEqual({ n: 0 });

      // Undo: rendered after all
      await c.patch(`/api/plans/${wrong.json.plan.id}`, { deleted: false });
      await s.queue.whenIdle();
      expect((await pagesOf(c, wrong.json.plan.id)).map((p) => p.status)).toEqual(["ready", "ready", "ready"]);
    }),
  );

  it("a page deleted through autosave isn't rendered until it is restored", () =>
    withServer({ render: true }, async (s, c) => {
      const up = await c.upload(await makePdf({ pages: 2 }), { filename: "two.pdf" });
      const [, second] = up.json.pages;
      const del = await c.post(`/api/plans/${up.json.plan.id}/sync`, {
        ops: [{ kind: "page", id: second.id, base: { deletedAt: null }, data: { deletedAt: Date.now() } }],
      });
      expect(del.status).toBe(200);
      await s.queue.whenIdle();
      const after = await pagesOf(c, up.json.plan.id);
      expect(after.map((p) => p.status)).toEqual(["ready", "queued"]);

      await c.post(`/api/plans/${up.json.plan.id}/sync`, {
        ops: [{ kind: "page", id: second.id, base: { deletedAt: after[1].deletedAt }, data: { deletedAt: null } }],
      });
      await s.queue.whenIdle();
      expect((await pagesOf(c, up.json.plan.id)).map((p) => p.status)).toEqual(["ready", "ready"]);
    }),
  );
});

describe("tile format and size", () => {
  it("tiles a scanned page as JPEG, keeping line work as PNG", () =>
    withServer({}, async (s, c) => {
      // a 4 × 5⅓ in "scan": paper-grey noise, rendered at 300 DPI to 1200×1600
      const scan = await sharp({
        create: { width: 1200, height: 1600, channels: 3, background: "#e1e1e1", noise: { type: "gaussian", mean: 225, sigma: 8 } },
      })
        .jpeg({ quality: 90 })
        .toBuffer();
      const pdf = await PDFDocument.create();
      const img = await pdf.embedJpg(scan);
      pdf.addPage([288, 384]).drawImage(img, { x: 0, y: 0, width: 288, height: 384 });
      const lines = await makePdf({ pages: 1, size: [288, 384] });
      const a = await c.upload(Buffer.from(await pdf.save()), { filename: "scanned.pdf" });
      const b = await c.upload(lines, { filename: "drawn.pdf" });
      await s.queue.whenIdle();

      const [scanned] = await pagesOf(c, a.json.plan.id);
      expect(scanned.status).toBe("ready");
      expect([scanned.width, scanned.height]).toEqual([1200, 1600]);
      expect(scanned.tileFormat).toBe("jpeg");
      const base = `${s.url}/api/pages/${scanned.id}/${scanned.assetKey}/tiles/${scanned.maxLevel}`;
      const tile = await fetch(`${base}/0_0.jpeg`, { headers: { cookie: c.cookie } });
      expect(tile.status).toBe(200);
      expect(tile.headers.get("content-type")).toBe("image/jpeg");
      expect((await fetch(`${base}/0_0.png`, { headers: { cookie: c.cookie } })).status).toBe(404);

      expect((await pagesOf(c, b.json.plan.id))[0].tileFormat).toBe("png");
    }),
  );

  it("caps a huge square sheet at about 40 megapixels", () =>
    withServer({}, async (s, c) => {
      const up = await c.upload(await makePdf({ pages: 1, size: [7200, 7200] }), { filename: "100in square.pdf" }); // 100 × 100 in
      await s.queue.whenIdle();
      const [page] = await pagesOf(c, up.json.plan.id);
      expect(page.status).toBe("ready");
      expect(page.width).toBe(page.height);
      expect(page.width).toBeLessThan(8000);
      expect((page.width * page.height) / 1e6).toBeCloseTo(40, 0);
    }),
  );

  it("caps a large square image the same way", () =>
    withServer({}, async (s, c) => {
      const png = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: "#f4f4f4" } })
        .png()
        .toBuffer();
      const up = await c.upload(png, { filename: "square.png", type: "image/png" });
      await s.queue.whenIdle();
      const [page] = await pagesOf(c, up.json.plan.id);
      expect(page.status).toBe("ready");
      expect(page.width).toBe(page.height);
      expect((page.width * page.height) / 1e6).toBeCloseTo(40, 0);
    }),
  );
});

describe("a full disk", () => {
  const FULL = Number.MAX_SAFE_INTEGER; // "keep this much free": never satisfied

  it("refuses uploads with a plain message and shows in /api/health", () =>
    withServer({ minFreeBytes: FULL }, async (s, c) => {
      const r = await c.upload(await makePdf({ pages: 1 }), { filename: "one more.pdf" });
      expect(r.status).toBe(507);
      expect(r.json.error).toBe("The app's storage is full, so this file wasn't uploaded. Add more storage (the setup guide explains how), then try again.");
      expect(fs.readdirSync(path.join(s.dataDir, "tmp"))).toEqual([]);
      const h = await c.get("/api/health");
      expect(h.status).toBe(503);
      expect(h.json.checks.storage).toBe("full");
    }),
  );

  it("fails queued pages with a plain message instead of 'upload again'", async () => {
    const first = await startTestServer({ render: false });
    const c = await signedInClient(first);
    const up = await c.upload(await makePdf({ pages: 1 }), { filename: "queued.pdf" });
    await first.shutdown(1000);
    await withServer({ dataDir: first.dataDir, minFreeBytes: FULL }, async (s, c2) => {
      await s.queue.whenIdle();
      const [page] = await pagesOf(c2, up.json.plan.id);
      expect(page.status).toBe("failed");
      expect(page.error).toBe(STORAGE_RENDER);
    });
    void c;
  });

  it("recognises disk-full errors from the file system and SQLite", () => {
    expect(isStorageFull(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe(true);
    expect(isStorageFull(Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 }))).toBe(true);
    expect(isStorageFull(new Error("ENOENT: no such file"))).toBe(false);
    expect(isStorageFull(null)).toBe(false);
  });
});
