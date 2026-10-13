// Uploads (byte sniffing, limits, labels), the render pipeline (queued →
// preview → ready with tiles), asset serving and page retry.

import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageRow, PlanSummary } from "../../src/shared/types";
import { ensureFixtures, fixture, makePdf, signedInClient, startTestServer, waitFor, type Client, type TestServer } from "./helpers";

let server: TestServer;
let c: Client;

beforeAll(async () => {
  ensureFixtures();
  server = await startTestServer();
  c = await signedInClient(server);
});

afterAll(async () => {
  await server?.stop();
});

const pagesOf = async (planId: string) => (await c.get<{ pages: PageRow[] }>(`/api/plans/${planId}/pages`)).json.pages;

async function waitUntilSettled(planId: string): Promise<PageRow[]> {
  return waitFor(async () => {
    const pages = await pagesOf(planId);
    return pages.every((p) => p.status === "ready" || p.status === "failed") ? pages : null;
  });
}

describe("uploading a multi-page PDF", () => {
  let planId: string;
  let pages: PageRow[];

  beforeAll(async () => {
    const r = await c.upload(fixture("event-plan.pdf"), { filename: "Millrace event plan.pdf" });
    expect(r.status).toBe(201);
    planId = r.json.plan.id;
    pages = r.json.pages;
  });

  it("creates the plan, the source and one queued page per sheet with the PDF's labels", async () => {
    const plan = (await c.get(`/api/plans/${planId}`)).json;
    expect(plan.plan.name).toBe("Millrace event plan");
    expect(pages.map((p) => p.label)).toEqual(["A-101", "P-1", "C-201", "R-1"]);
    expect(pages.map((p) => p.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(pages.map((p) => p.sourceIndex)).toEqual([0, 1, 2, 3]);
    for (const p of pages) {
      expect(p.status).toBe("queued");
      expect(p.assetKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(p.width).toBe(0);
    }
    const original = await fetch(`${server.url}/api/sources/${pages[0].sourceId}/original`, { headers: { cookie: c.cookie } });
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("application/pdf");
    expect(original.headers.get("content-disposition")).toBe(`attachment; filename="Millrace event plan.pdf"; filename*=UTF-8''Millrace%20event%20plan.pdf`);
    expect(Buffer.from(await original.arrayBuffer()).equals(fixture("event-plan.pdf"))).toBe(true);
  });

  it("renders every page to 'ready' with sizes and a tile pyramid", async () => {
    const t = Date.now();
    const done = await waitUntilSettled(planId);
    console.log(`event-plan.pdf: 4 pages ready in ${Date.now() - t} ms`);
    for (const p of done) {
      expect(p.status, p.label).toBe("ready");
      expect(p.error).toBeNull();
      expect(p.tileSize).toBe(512);
      expect(p.tileFormat).toBe("png");
      expect(p.maxLevel).toBeGreaterThan(p.minLevel);
      expect(Math.max(p.previewW, p.previewH)).toBe(2048);
    }
    const [arch, letter, tabloid, rotated] = done;
    expect([arch.width, arch.height]).toEqual([8000, 5334]); // ARCH D capped at 8000 px
    expect([letter.width, letter.height]).toEqual([2550, 3300]); // 300 DPI
    expect([tabloid.width, tabloid.height]).toEqual([5100, 3300]);
    expect([rotated.width, rotated.height]).toEqual([2550, 3300]); // /Rotate 90 applied
    expect(arch.minLevel).toBe(0);
    expect(arch.maxLevel).toBe(4); // 8000 → 4000 → 2000 → 1000 → 500 (one tile)
    // the assetKey changed when rendering started (a fresh key per attempt)
    expect(arch.assetKey).not.toBe(pages[0].assetKey);
    // no work folders left behind
    expect(fs.readdirSync(path.join(server.dataDir, "tmp")).filter((n) => n.startsWith("render-"))).toEqual([]);
    // the home list shows nothing pending any more
    const summary = (await c.get<{ plans: PlanSummary[] }>("/api/plans")).json.plans.find((p) => p.id === planId)!;
    expect(summary.pendingPages).toBe(0);
    expect(summary.firstPage).toMatchObject({ id: arch.id, assetKey: arch.assetKey, status: "ready" });
  });

  it("serves preview, thumbnail and tiles with immutable caching", async () => {
    const p = (await pagesOf(planId))[0];
    const base = `/api/pages/${p.id}/${p.assetKey}`;
    const preview = await fetch(`${server.url}${base}/preview.webp`, { headers: { cookie: c.cookie } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([p.previewW, p.previewH]);

    const thumb = await fetch(`${server.url}${base}/thumb.webp`, { headers: { cookie: c.cookie } });
    expect(thumb.status).toBe(200);
    const tm = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(Math.max(tm.width ?? 0, tm.height ?? 0)).toBe(480);

    // full-resolution level: 8000×5334 → 16×11 tiles; the last one is the 320×214 corner
    const corner = await fetch(`${server.url}${base}/tiles/${p.maxLevel}/15_10.png`, { headers: { cookie: c.cookie } });
    expect(corner.status).toBe(200);
    expect(corner.headers.get("content-type")).toBe("image/png");
    const cm = await sharp(Buffer.from(await corner.arrayBuffer())).metadata();
    expect([cm.width, cm.height]).toEqual([320, 214]);
    const one = await fetch(`${server.url}${base}/tiles/${p.minLevel}/0_0.png`, { headers: { cookie: c.cookie } });
    expect(one.status).toBe(200);
    const om = await sharp(Buffer.from(await one.arrayBuffer())).metadata();
    expect([om.width, om.height]).toEqual([500, 334]);
  });

  it("answers 404 for bad or missing asset paths", async () => {
    const p = (await pagesOf(planId))[0];
    const base = `/api/pages/${p.id}/${p.assetKey}`;
    const bad = [
      `${base}/tiles/${p.maxLevel}/16_0.png`, // past the edge
      `${base}/tiles/${p.maxLevel + 1}/0_0.png`, // no such level
      `${base}/tiles/${p.maxLevel}/0_0.jpeg`, // wrong format
      `${base}/tiles/x/0_0.png`,
      `${base}/tiles/1/0-0.png`,
      `${base}/tiles/1/..%2f..%2fpreview.webp`,
      `${base}/tiles/999/0_0.png`,
      `/api/pages/${p.id}/not-the-key/preview.webp`,
      `/api/pages/${p.id}/${"k".repeat(65)}/preview.webp`,
      `/api/pages/${p.id}/..%2f..%2f..%2fapp.db/preview.webp`,
      `/api/pages/${p.id}/${p.assetKey}/other.webp`,
      `/api/sources/no-such-source/original`,
    ];
    for (const u of bad) {
      const r = await c.get(u);
      expect(r.status, u).toBe(404);
      expect(r.headers.get("cache-control"), u).toBe("no-store");
    }
  });

  it("appends added files after the last page, numbering unlabelled sheets from the current count", async () => {
    const before = await pagesOf(planId);
    const r = await c.upload(await makePdf({ pages: 2 }), { planId, filename: "extra sheets.pdf" });
    expect(r.status).toBe(201);
    expect(r.json.plan.id).toBe(planId);
    expect(r.json.source.pageCount).toBe(2);
    expect(r.json.pages.map((p) => p.label)).toEqual(["Page 5", "Page 6"]);
    const maxBefore = Math.max(...before.map((p) => p.sortOrder));
    expect(r.json.pages.every((p) => p.sortOrder > maxBefore)).toBe(true);
    expect(r.json.pages[1].sortOrder).toBeGreaterThan(r.json.pages[0].sortOrder);
    const all = await pagesOf(planId);
    expect(all.slice(-2).map((p) => p.id)).toEqual(r.json.pages.map((p) => p.id));
  });

  it("uses bookmark titles when a PDF has no page labels", async () => {
    const pdf = await makePdf({ pages: 3, bookmarks: [{ title: "Ground  floor ", page: 0 }, { title: "Roof", page: 2 }] });
    const r = await c.upload(pdf, { filename: "tower.pdf", name: "  Tower \n  walk-through  " });
    expect(r.status).toBe(201);
    expect(r.json.plan.name).toBe("Tower walk-through");
    expect(r.json.pages.map((p) => p.label)).toEqual(["Ground floor", "Page 2", "Roof"]);
  });
});

describe("uploading images", () => {
  it("accepts a PNG as one page named after the file and tiles it as JPEG", async () => {
    const r = await c.upload(fixture("warehouse.png"), { filename: "Warehouse 2.png", type: "image/png", name: "Warehouse" });
    expect(r.status).toBe(201);
    expect(r.json.source.kind).toBe("image");
    expect(r.json.pages).toHaveLength(1);
    expect(r.json.pages[0].label).toBe("Warehouse 2");
    const [page] = await waitUntilSettled(r.json.plan.id);
    expect(page.status).toBe("ready");
    expect([page.width, page.height]).toEqual([1600, 1000]);
    expect(page.tileFormat).toBe("jpeg");
    const tile = await fetch(`${server.url}/api/pages/${page.id}/${page.assetKey}/tiles/${page.maxLevel}/0_0.jpeg`, { headers: { cookie: c.cookie } });
    expect(tile.status).toBe(200);
    expect(tile.headers.get("content-type")).toBe("image/jpeg");
  });

  it("bakes in EXIF orientation for a sideways JPEG (the bytes decide, not the declared type)", async () => {
    // 300×200 pixels stored sideways with orientation 6 → displays as 200×300
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ddeeff" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const r = await c.upload(jpeg, { filename: "photo.jpeg", type: "application/octet-stream" });
    expect(r.status).toBe(201);
    const [page] = await waitUntilSettled(r.json.plan.id);
    expect(page.status).toBe("ready");
    expect([page.width, page.height]).toEqual([200, 300]);
  });
});

describe("refusing bad uploads", () => {
  it("refuses a corrupt PDF", async () => {
    const before = (await c.get("/api/plans")).json.plans.length;
    const r = await c.upload(fixture("corrupt.pdf"), { filename: "corrupt.pdf" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("That PDF couldn't be read. Try exporting it again.");
    expect((await c.get("/api/plans")).json.plans.length).toBe(before); // no half-made plan
  });

  it("refuses a file that isn't a PDF, PNG or JPG whatever its name says", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`);
    const r = await c.upload(svg, { filename: "plan.png", type: "image/png" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("That file isn't a PDF, PNG or JPG.");
    const empty = await c.upload(new Uint8Array(0), { filename: "nothing.pdf" });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("That file is empty.");
  });

  it("refuses a broken image with PNG magic bytes", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    const r = await c.upload(fake, { filename: "broken.png", type: "image/png" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("That image couldn't be read. Try saving it again as a PNG or JPG.");
  });

  it("refuses a password-protected PDF", async () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.addObject({}), "0 0 m 10 10 l S"));
    const locked = doc.saveToBuffer("encrypt=aes-256,user-password=gate,owner-password=ops").asUint8Array();
    const r = await c.upload(locked, { filename: "locked.pdf" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("That PDF is password-protected. Save an unlocked copy and upload that.");
  });

  it("adding files to a plan that doesn't exist is a 404", async () => {
    const r = await c.upload(await makePdf({ pages: 1 }), { planId: "no-such-plan" });
    expect(r.status).toBe(404);
  });

  it("leaves no temp files behind", () => {
    expect(fs.readdirSync(path.join(server.dataDir, "tmp")).filter((n) => n.startsWith("upload-"))).toEqual([]);
  });
});

describe("limits", () => {
  let small: TestServer;
  let sc: Client;
  beforeAll(async () => {
    small = await startTestServer({ maxUploadBytes: 1024 * 1024, maxPagesPerFile: 3, render: false });
    sc = await signedInClient(small);
  });
  afterAll(async () => {
    await small?.stop();
  });

  it("refuses an oversize file from its Content-Length", async () => {
    const r = await sc.upload(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1100 * 1024, 32)]), { filename: "huge.pdf" });
    expect(r.status).toBe(413);
    expect(r.json.error).toBe("That file is over 1 MB. Export a smaller PDF or split the set.");
  });

  it("refuses an oversize file streamed without a Content-Length", async () => {
    const chunk = Buffer.alloc(128 * 1024, 65);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent >= 10) return ctrl.close();
        sent++;
        ctrl.enqueue(sent === 1 ? Buffer.concat([Buffer.from("%PDF-1.7\n"), chunk]) : chunk);
      },
    });
    const res = await fetch(`${small.url}/api/plans/upload?filename=stream.pdf`, {
      method: "POST",
      headers: { cookie: sc.cookie, "content-type": "application/pdf" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(fs.readdirSync(path.join(small.dataDir, "tmp"))).toEqual([]);
  });

  it("refuses a PDF with more pages than allowed", async () => {
    const r = await sc.upload(await makePdf({ pages: 4 }), { filename: "set.pdf" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("That PDF has 4 pages — the limit is 3 per file. Split the set and upload it in parts.");
  });
});

describe("retrying a failed page", () => {
  it("marks a page whose source vanished as failed, and retry renders it again", async () => {
    const s = await startTestServer({ render: false });
    try {
      const sc = await signedInClient(s);
      const up = await sc.upload(await makePdf({ pages: 1 }), { filename: "gate.pdf" });
      const page = up.json.pages[0];
      const file = path.join(s.dataDir, "uploads", `${up.json.source.id}.pdf`);
      const keep = fs.readFileSync(file);
      fs.rmSync(file);
      s.queue.kick();
      await s.queue.whenIdle();
      const failed = (await sc.get(`/api/plans/${up.json.plan.id}/pages`)).json.pages[0];
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("The original file for this page is missing. Upload it again.");

      fs.writeFileSync(file, keep);
      const retry = await sc.post(`/api/pages/${page.id}/retry`);
      expect(retry.status).toBe(200);
      expect(retry.json.page.status).toBe("queued");
      expect(retry.json.page.error).toBeNull();
      expect(retry.json.page.assetKey).not.toBe(failed.assetKey);
      s.queue.kick();
      await s.queue.whenIdle();
      const ready = (await sc.get(`/api/plans/${up.json.plan.id}/pages`)).json.pages[0];
      expect(ready.status).toBe("ready");
      // only the successful render's folder remains
      expect(fs.readdirSync(path.join(s.dataDir, "assets", page.id))).toEqual([ready.assetKey]);
      // retrying a page that isn't failed changes nothing
      const again = await sc.post(`/api/pages/${page.id}/retry`);
      expect(again.json.page).toEqual(ready);
      expect((await sc.post(`/api/pages/nope/retry`)).status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  it("fails a page that takes longer than the render timeout", async () => {
    const s = await startTestServer({ renderTimeoutMs: 1 });
    try {
      const sc = await signedInClient(s);
      const up = await sc.upload(await makePdf({ pages: 1 }), { filename: "slow.pdf" });
      await s.queue.whenIdle();
      const [page] = (await sc.get<{ pages: PageRow[] }>(`/api/plans/${up.json.plan.id}/pages`)).json.pages;
      expect(page.status).toBe("failed");
      expect(page.error).toBe("This page took too long to prepare.");
      expect(fs.readdirSync(path.join(s.dataDir, "tmp"))).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("re-queues pages cut off by a restart", async () => {
    const s = await startTestServer({ render: false });
    const dataDir = s.dataDir;
    const sc = await signedInClient(s);
    const up = await sc.upload(await makePdf({ pages: 1 }), { filename: "restart.pdf" });
    s.db.prepare("UPDATE pages SET status = 'rendering'").run();
    await s.shutdown(1000);
    const again = await startTestServer({ dataDir });
    try {
      const c2 = await signedInClient(again);
      const pages = await waitFor(async () => {
        const ps = (await c2.get<{ pages: PageRow[] }>(`/api/plans/${up.json.plan.id}/pages`)).json.pages;
        return ps[0].status === "ready" ? ps : null;
      });
      expect(pages[0].status).toBe("ready");
    } finally {
      await again.stop();
    }
  });
});
