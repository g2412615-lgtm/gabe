// "Download PDF": the chosen pages as they were uploaded (vectors, text, page
// size and rotation kept), circles drawn exactly where the app shows them,
// notes pages after the pages with circles, colour and notes options, and
// the refusals.

import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { notesHtml, richText } from "../../src/server/export";
import { pdfFileName } from "../../src/shared/labels";
import { comparePages } from "../../src/shared/order";
import type { CircleRow, PageRow, PlanDoc, SyncOp, SyncResponse } from "../../src/shared/types";
import { ensureFixtures, fixture, signedInClient, startTestServer, waitFor, type Client, type TestServer } from "./helpers";

mupdf.setLog({ error: () => {}, warning: () => {} });

let server: TestServer;
let c: Client;
let planId: string;
let planName: string;
/** A-101, P-1, C-201, R-1 (turned by /Rotate 90), then the warehouse photo. */
let pages: PageRow[];
const ids: Record<string, string> = {};

const RED = [194, 31, 31];
const BLUE = [31, 78, 153];
const GREEN = [31, 122, 58];

let seq = 0;
const newId = (what: string) => `${what}-${Date.now().toString(36)}-${++seq}`;

function circle(pageId: string, over: Partial<CircleRow> & { key: string }): SyncOp {
  const id = newId("circle");
  ids[over.key] = id;
  const { key: _key, ...rest } = over;
  return { kind: "circle", id, base: null, data: { pageId, x: 0.5, y: 0.5, r: 0.03, color: "gold", title: "", createdAt: Date.now(), deletedAt: null, ...rest } };
}
function comment(circleKey: string, body: string, over: { key?: string; createdAt?: number } = {}): SyncOp {
  const id = newId("comment");
  if (over.key) ids[over.key] = id;
  return { kind: "comment", id, base: null, data: { circleId: ids[circleKey], body, createdAt: over.createdAt ?? Date.now(), deletedAt: null } };
}
const sync = async (ops: SyncOp[], plan = planId) => {
  const r = await c.post<SyncResponse>(`/api/plans/${plan}/sync`, { ops });
  expect(r.status).toBe(200);
  expect(r.json.rejected).toEqual([]);
  return r.json;
};

beforeAll(async () => {
  ensureFixtures();
  // the brand files the notes pages use (the built app has them under dist/client)
  server = await startTestServer({ clientDir: path.resolve("public") });
  c = await signedInClient(server);
  const up = await c.upload(fixture("event-plan.pdf"), { filename: "Millrace event plan.pdf" });
  expect(up.status).toBe(201);
  planId = up.json.plan.id;
  planName = up.json.plan.name;
  const photo = await c.upload(fixture("warehouse.png"), { filename: "warehouse.png", type: "image/png", planId });
  expect(photo.status).toBe(201);
  pages = await waitFor(async () => {
    const all = (await c.get<{ pages: PageRow[] }>(`/api/plans/${planId}/pages`)).json.pages;
    return all.length === 5 && all.every((p) => p.status === "ready") ? all.filter((p) => p.deletedAt === null).sort(comparePages) : null;
  });
  expect(pages.map((p) => p.label).slice(0, 4)).toEqual(["A-101", "P-1", "C-201", "R-1"]);

  const [a101, , c201, r1, photoPage] = pages;
  await sync([
    { kind: "plan", id: planId, base: { legendRed: "" }, data: { legendRed: "Security" } } as SyncOp,
    circle(a101.id, { key: "red", x: 0.3, y: 0.4, r: 0.05, color: "red", title: "Gate A scanners" }),
    circle(a101.id, { key: "gold", x: 0.7, y: 0.6, r: 0.04, color: "gold" }),
    circle(c201.id, { key: "gone", x: 0.5, y: 0.5, r: 0.05, color: "red" }),
    circle(r1.id, { key: "blue", x: 0.25, y: 0.25, r: 0.06, color: "blue" }),
    circle(photoPage.id, { key: "green", x: 0.5, y: 0.5, r: 0.08, color: "green" }),
  ]);
  const t = Date.UTC(2026, 9, 13, 19, 41);
  await sync([
    comment("red", "Two scanners at doors open.\nThird one from 6 PM.", { createdAt: t }),
    comment("red", "Deleted comment text", { key: "deletedComment", createdAt: t + 1000 }),
    comment("red", "   ", { createdAt: t + 2000 }),
  ]);
  const doc = (await c.get<PlanDoc>(`/api/plans/${planId}`)).json;
  const gone = doc.circles.find((x) => x.id === ids.gone)!;
  const dc = doc.comments.find((x) => x.id === ids.deletedComment)!;
  await sync([
    { kind: "circle", id: gone.id, base: { x: gone.x, y: gone.y, r: gone.r, color: gone.color, title: gone.title, deletedAt: null }, data: { x: gone.x, y: gone.y, r: gone.r, color: gone.color, title: gone.title, deletedAt: 1 } },
    { kind: "comment", id: dc.id, base: { body: dc.body, deletedAt: null }, data: { body: dc.body, deletedAt: 1 } },
  ]);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

async function exportPdf(body: unknown, headers: Record<string, string> = {}, plan = planId) {
  const res = await fetch(`${server.url}/api/plans/${plan}/export`, {
    method: "POST",
    headers: { cookie: c.cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}
const allPages = () => pages.map((p) => p.id);
const open = (bytes: Uint8Array) => new mupdf.PDFDocument(bytes);
const textOf = (doc: mupdf.PDFDocument, i: number) => {
  const p = doc.loadPage(i);
  const t = p.toStructuredText("preserve-whitespace").asText();
  p.destroy();
  return t;
};

/** Renders page i and returns the box around pixels close to `rgb`, as fractions of the page. */
function findColour(doc: mupdf.PDFDocument, i: number, rgb: number[], tol = 40) {
  const page = doc.loadPage(i);
  const [x0, y0, x1, y1] = page.getBounds();
  const s = 1200 / Math.max(x1 - x0, y1 - y0);
  const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const stride = pix.getStride();
  const px = pix.getPixels();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * n;
      if (Math.abs(px[o] - rgb[0]) < tol && Math.abs(px[o + 1] - rgb[1]) < tol && Math.abs(px[o + 2] - rgb[2]) < tol) {
        count++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  pix.destroy();
  page.destroy();
  if (count === 0) return null;
  return { cx: (minX + maxX + 1) / 2 / w, cy: (minY + maxY + 1) / 2 / h, rw: (maxX - minX + 1) / 2 / Math.max(w, h), count };
}

describe("downloading the whole plan", () => {
  let doc: mupdf.PDFDocument;
  let res: Response;

  beforeAll(async () => {
    const r = await exportPdf({ pageIds: allPages(), notes: true, timeZone: "America/Chicago" });
    res = r.res;
    expect(res.status).toBe(200);
    doc = open(r.bytes);
  });

  it("is a PDF download named after the plan", () => {
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(pdfFileName(planName))}`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("has every page in the plan's order, each followed by its notes when it has circles", () => {
    const labels = Array.from({ length: doc.countPages() }, (_, i) => {
      const p = doc.loadPage(i);
      const l = p.getLabel();
      p.destroy();
      return l;
    });
    expect(labels).toEqual(["A-101", "A-101 notes 1", "P-1", "C-201", "R-1", "R-1 notes 1", pages[4].label, `${pages[4].label} notes 1`]);
    expect((doc.loadOutline() ?? []).map((o) => o.title)).toEqual(pages.map((p) => p.label));
    expect(doc.getMetaData("info:Title")).toBe(planName);
  });

  it("keeps each sheet as uploaded: same size and turn, its text still text", () => {
    const original = open(fixture("event-plan.pdf"));
    for (const [out, src] of [
      [0, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ]) {
      const a = doc.loadPage(out);
      const b = original.loadPage(src);
      expect(a.getBounds()).toEqual(b.getBounds());
      a.destroy();
      b.destroy();
    }
    expect(textOf(doc, 0)).toContain("Gate A");
    expect(textOf(doc, 0)).toContain("magnetometer lane");
  });

  it("draws each circle where the app shows it — the turned sheet and the photo included", () => {
    const red = findColour(doc, 0, RED)!;
    expect(red.cx).toBeCloseTo(0.3, 2);
    expect(red.cy).toBeCloseTo(0.4, 2);
    expect(red.rw).toBeCloseTo(0.05, 2);
    const blue = findColour(doc, 4, BLUE)!;
    expect(blue.cx).toBeCloseTo(0.25, 2);
    expect(blue.cy).toBeCloseTo(0.25, 2);
    const green = findColour(doc, 6, GREEN)!;
    expect(green.cx).toBeCloseTo(0.5, 2);
    expect(green.cy).toBeCloseTo(0.5, 2);
    // no circle on P-1, and the deleted one on C-201 isn't drawn
    expect(findColour(doc, 2, RED)).toBeNull();
    expect(findColour(doc, 3, RED)).toBeNull();
  });

  it("numbers each circle on the sheet", () => {
    const text = textOf(doc, 0);
    const doc2 = (n: number) => new RegExp(`(^|\\s)${n}(\\s|$)`);
    // the badges are real text: 1 (red) and 2 (gold); the deleted circle's 3 is on no sheet
    expect(text).toMatch(doc2(1));
    expect(text).toMatch(doc2(2));
  });

  it("lists the circles in the notes: number, colour and what it means, title, comments with their dates", () => {
    const notes = textOf(doc, 1);
    expect(notes).toContain("A-101");
    expect(notes).toContain(`${planName} · Notes for page 1 of 5 · 2 circles · 1 comment`);
    expect(notes).toContain("Red · Security");
    expect(notes).toContain("Gate A scanners");
    expect(notes).toContain("Two scanners at doors open.");
    expect(notes).toContain("Third one from 6 PM.");
    expect(notes).toContain("Oct 13, 2026, 2:41 PM"); // 19:41 UTC in Chicago
    expect(notes).toContain("Gold");
    expect(notes).toContain("No comments");
    expect(notes).not.toContain("Deleted comment text");
  });

  it("puts the Kilowatt Events lockup at the top of each notes page", () => {
    const page = doc.loadPage(1);
    const s = 2;
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
    const stride = pix.getStride();
    const px = pix.getPixels();
    let dark = 0;
    // the logo's place: 54 pt from the left, 28–46 pt from the top
    for (let y = 28 * s; y < 46 * s; y++) for (let x = 54 * s; x < 120 * s; x++) if (px[y * stride + x * 3] < 100) dark++;
    pix.destroy();
    page.destroy();
    expect(dark).toBeGreaterThan(100);
  });

  it("leaves nothing behind in the server's temporary folder", async () => {
    await waitFor(async () => (fs.readdirSync(path.join(server.dataDir, "tmp")).some((f) => f.startsWith("export-")) ? null : true), 5_000);
  });
});

describe("options", () => {
  it("only the chosen colours: other circles are neither drawn nor listed", async () => {
    const { res, bytes } = await exportPdf({ pageIds: allPages(), colors: ["red"], notes: true });
    expect(res.status).toBe(200);
    const doc = open(bytes);
    expect(doc.countPages()).toBe(6); // 5 sheets + A-101's notes
    expect(findColour(doc, 0, RED)).not.toBeNull();
    expect(findColour(doc, 4, BLUE)).toBeNull();
    const notes = textOf(doc, 1);
    expect(notes).toContain("1 circle");
    expect(notes).not.toContain("Gold");
  });

  it("without notes: just the sheets", async () => {
    const { bytes } = await exportPdf({ pageIds: allPages(), notes: false });
    expect(open(bytes).countPages()).toBe(5);
  });

  it("one page: named after it too; comment dates in UTC when the device's time zone is unknown", async () => {
    const { res, bytes } = await exportPdf({ pageIds: [pages[0].id], notes: true, timeZone: "Mars/Olympus" });
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent(pdfFileName(planName, "A-101")));
    const doc = open(bytes);
    expect(doc.countPages()).toBe(2);
    expect(textOf(doc, 1)).toContain("Oct 13, 2026, 7:41 PM UTC");
  });

  it("pages come out in the plan's order, whatever order they're asked in", async () => {
    const { bytes } = await exportPdf({ pageIds: [pages[3].id, pages[1].id], notes: false });
    const doc = open(bytes);
    expect((doc.loadOutline() ?? []).map((o) => o.title)).toEqual(["P-1", "R-1"]);
  });
});

/** A plan of its own from `bytes`; its pages once they're listed. */
async function planFrom(bytes: Uint8Array, filename: string, type = "application/pdf") {
  const up = await c.upload(bytes, { filename, type });
  expect(up.status, up.json?.error).toBe(201);
  return { id: up.json.plan.id as string, pages: up.json.pages as PageRow[] };
}
const tmpExports = () => fs.readdirSync(path.join(server.dataDir, "tmp")).filter((f) => f.startsWith("export-"));

describe("awkward files", () => {
  it("layers the original hides stay hidden", async () => {
    const src = new mupdf.PDFDocument();
    const hidden = src.addObject({ Type: "OCG", Name: "Hidden layer" });
    const shown = src.addObject({ Type: "OCG", Name: "Shown layer" });
    const content = "/OC /H BDC 0.76 0.12 0.12 rg 100 400 150 150 re f EMC\n/OC /S BDC 0.12 0.48 0.23 rg 350 400 150 150 re f EMC\n";
    src.insertPage(-1, src.addPage([0, 0, 612, 792], 0, { Properties: { H: hidden, S: shown } }, content));
    const props = src.newDictionary();
    const groups = src.newArray();
    groups.push(hidden);
    groups.push(shown);
    props.put("OCGs", groups);
    const d = src.newDictionary();
    const off = src.newArray();
    off.push(hidden);
    d.put("OFF", off);
    props.put("D", d);
    src.getTrailer().get("Root").put("OCProperties", props);
    const plan = await planFrom(src.saveToBuffer("").asUint8Array().slice(), "layers.pdf");
    const { res, bytes } = await exportPdf({ pageIds: [plan.pages[0].id], notes: false }, {}, plan.id);
    expect(res.status).toBe(200);
    const doc = open(bytes);
    expect(findColour(doc, 0, RED, 20)).toBeNull();
    expect(findColour(doc, 0, GREEN, 20)).not.toBeNull();
  });

  it("a file that points at objects it doesn't have still comes out as its page, circles on", async () => {
    // a font whose descriptor is missing (object 99 of a 6-object file): viewers shrug, copying a page can't
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FontDescriptor 99 0 R >>",
    ];
    const text = "BT /F1 36 Tf 72 600 Td (Dangling sheet) Tj ET";
    objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
    let pdf = "%PDF-1.7\n";
    const at: number[] = [];
    objs.forEach((o, i) => {
      at.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const plan = await planFrom(new TextEncoder().encode(pdf), "dangling.pdf");
    await sync([circle(plan.pages[0].id, { key: "dangling", x: 0.5, y: 0.3, r: 0.05, color: "red" })], plan.id);
    const { res, bytes } = await exportPdf({ pageIds: [plan.pages[0].id], notes: false }, {}, plan.id);
    expect(res.status).toBe(200);
    const doc = open(bytes);
    expect(textOf(doc, 0)).toContain("Dangling sheet");
    expect(findColour(doc, 0, RED)).not.toBeNull();
  });

  it("a huge photo is scaled to the page's needs (36 in at 150 dpi) instead of held whole", async () => {
    const png = await sharp({ create: { width: 7000, height: 3500, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const plan = await planFrom(png, "huge.png", "image/png");
    const { res, bytes } = await exportPdf({ pageIds: [plan.pages[0].id], notes: false }, {}, plan.id);
    expect(res.status).toBe(200);
    const doc = open(bytes);
    const page = doc.loadPage(0);
    expect(page.getBounds()).toEqual([0, 0, 2592, 1296]);
    page.destroy();
    const img = doc.findPage(0).get("Resources").get("XObject").get("KWEPage").get("Resources").get("XObject").get("KWEImg");
    expect(img.get("Width").asNumber()).toBe(5400);
  });

  it("emoji, symbols and other alphabets in the notes get fonts that can draw them", async () => {
    await sync([comment("red", "👍 ✅ done ★ → עברית العربية हिन्दी ไทย", { createdAt: Date.UTC(2026, 9, 14) })]);
    try {
      const { bytes } = await exportPdf({ pageIds: [pages[0].id], notes: true });
      const doc = open(bytes);
      const fonts: string[] = [];
      const res = doc.findPage(1).get("Resources").get("Font");
      res.forEach((f) => fonts.push(f.get("BaseFont").toString()));
      // embedded under the names the notes ask for (subset: "/ABCDEF+KWE#20Emoji")
      for (const name of ["Emoji", "Symbols", "Hebrew", "Arabic", "Devanagari", "Thai"]) expect(fonts.join(" ")).toContain(`KWE#20${name}`);
      if (process.env.EXPORT_DUMP) fs.writeFileSync(process.env.EXPORT_DUMP, bytes);
    } finally {
      const doc = (await c.get<PlanDoc>(`/api/plans/${planId}`)).json;
      const m = doc.comments.find((x) => x.body.startsWith("👍"))!;
      await sync([{ kind: "comment", id: m.id, base: { body: m.body, deletedAt: null }, data: { body: m.body, deletedAt: 1 } }]);
    }
  });

  it("a long comment thread starts on the first notes page (one row per comment)", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `Line ${i + 1} of a long note about the loading dock and the stage door.`).join("\n");
    const plan = await planFrom(await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).png().toBuffer(), "thread.png", "image/png");
    await sync([circle(plan.pages[0].id, { key: "thread", color: "blue" })], plan.id);
    await sync(Array.from({ length: 15 }, (_, i) => comment("thread", `Comment ${i + 1}\n${lines}`, { createdAt: Date.UTC(2026, 9, 1, 12, i) })), plan.id);
    const { bytes } = await exportPdf({ pageIds: [plan.pages[0].id], notes: true }, {}, plan.id);
    const doc = open(bytes);
    expect(doc.countPages()).toBeGreaterThan(2);
    expect(textOf(doc, 1)).toContain("Comment 1\n");
  });

  it("an export the device gives up on stops, and leaves nothing behind", async () => {
    const ctrl = new AbortController();
    const going = fetch(`${server.url}/api/plans/${planId}/export`, {
      method: "POST",
      headers: { cookie: c.cookie, "content-type": "application/json" },
      body: JSON.stringify({ pageIds: allPages(), notes: true }),
      signal: ctrl.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await going;
    await waitFor(async () => (tmpExports().length === 0 ? true : null), 10_000);
    const started = Date.now();
    const { res } = await exportPdf({ pageIds: [pages[1].id], notes: false });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitFor(async () => (tmpExports().length === 0 ? true : null), 5_000);
  });
});

describe("richText", () => {
  it("puts emoji, symbols and other alphabets in their fonts, and escapes the rest", () => {
    expect(richText("Gate <A> 👍🏽 ok")).toBe('Gate &lt;A&gt; <span class="f-emo">👍🏽</span> ok');
    expect(richText("★ → x")).toBe('<span class="f-sym">★</span> <span class="f-sym">→</span> x');
    expect(richText("כניסה ראשית: A")).toBe('<span class="f-he">כניסה ראשית</span>: A');
    expect(richText("👨‍👩‍👧 🇺🇸")).toBe('<span class="f-emo">👨‍👩‍👧</span> <span class="f-emo">🇺🇸</span>');
  });
});

describe("refusals", () => {
  it("needs a signed-in, same-site request", async () => {
    const anon = await fetch(`${server.url}/api/plans/${planId}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anon.status).toBe(401);
    const { res } = await exportPdf({ pageIds: allPages() }, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("explains a bad request, an unknown plan and pages that are gone", async () => {
    expect((await exportPdf({ pageIds: [] })).res.status).toBe(400);
    expect((await exportPdf({ pageIds: "all" })).res.status).toBe(400);
    expect((await exportPdf({ pageIds: allPages(), notes: "yes" })).res.status).toBe(400);
    const gone = await exportPdf({ pageIds: ["no-such-page"] });
    expect(gone.res.status).toBe(409);
    expect(JSON.parse(new TextDecoder().decode(gone.bytes)).error).toMatch(/deleted/);
    const unknown = await fetch(`${server.url}/api/plans/nope/export`, { method: "POST", headers: { cookie: c.cookie, "content-type": "application/json" }, body: JSON.stringify({ pageIds: allPages() }) });
    expect(unknown.status).toBe(404);
  });

  it("a page whose original file is missing comes out as a page that says so", async () => {
    const src = path.join(server.dataDir, "uploads", `${pages[4].sourceId}.png`);
    const kept = `${src}.kept`;
    fs.renameSync(src, kept);
    try {
      const { res, bytes } = await exportPdf({ pageIds: [pages[4].id], notes: true });
      expect(res.status).toBe(200);
      const doc = open(bytes);
      expect(doc.countPages()).toBe(2);
      expect(textOf(doc, 0)).toContain("couldn't be read from the file it was uploaded in");
      expect(textOf(doc, 1)).toContain("Green");
    } finally {
      fs.renameSync(kept, src);
    }
  });
});

describe("notesHtml", () => {
  const base = { id: "c", planId: "p", pageId: "g", x: 0.5, y: 0.5, r: 0.1, num: 7, createdAt: 0, updatedAt: 0, deletedAt: null, rev: 1 };
  it("escapes what the owner typed and keeps line breaks", () => {
    const html = notesHtml({
      plan: { name: "Spring <Fest> & co", legendBlue: "Medical \"tent\"" },
      page: { label: "A-1 <b>" },
      position: 1,
      pageCount: 1,
      circles: [{ circle: { ...base, color: "blue", title: "<script>" }, comments: [{ id: "m", planId: "p", circleId: "c", body: "a\nb <i>", createdAt: 0, updatedAt: 120_000, deletedAt: null, rev: 1 }] }],
      timeZone: "UTC",
    });
    expect(html).toContain("Spring &lt;Fest&gt; &amp; co");
    expect(html).toContain("A-1 &lt;b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Medical &quot;tent&quot;");
    expect(html).toContain("a\nb &lt;i&gt;");
    expect(html).toContain(" · edited");
    expect(html).not.toContain("<script>");
  });
});
