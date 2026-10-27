// "Download PDF" worker: one fresh Node process per export (see
// run-worker.ts), like the render worker, so mupdf's WebAssembly heap is
// thrown away afterwards and a plan too big for the machine's memory takes
// down only this process, never the server.
//
// The PDF it makes (src/server/export.ts says what goes in it):
//  - each chosen page as it was uploaded: the original PDF page copied as it
//    is (its vectors and text stay sharp and searchable), or a PNG/JPG upload
//    as a page of its own;
//  - the circles drawn on top of it as plain PDF drawing — the same colours,
//    and the number badges the map shows — so they print and look the same
//    in every PDF viewer;
//  - after each page, its notes pages (laid out from HTML by mupdf, with
//    fonts of our own for what its built-in ones lack: ./fonts);
//  - a bookmark and a page label per page; layers the original hides stay
//    hidden.
//
// The task arrives as JSON in argv[2], the job itself in a file (it can be
// bigger than a command line may be); the answer goes back over the IPC
// channel. Like worker.ts this runs as TypeScript through Node's type
// stripping in development and tests: keep it to erasable TypeScript, and
// import only packages and `import type`s.

import fs from "node:fs";
import { Worker } from "node:worker_threads";
import * as mupdf from "mupdf";
import sharp from "sharp";
import type { ExportCircle, ExportJob, ExportSheet, WorkerMessage, WorkerTask } from "./protocol";

type Rgb = [number, number, number];

// ── how the marks look ───────────────────────────────────────────────────
// The map draws a 2 px outline and an 18 px badge whatever the zoom; a PDF
// viewer zooms everything, so here they're a share of the page's long side
// (about what the map shows with the whole page in view), within limits that
// keep them readable on a letter sheet and not clumsy on an ARCH E one.
// Sizes are in PDF points (1/72 in).

/** Outline width. */
const STROKE = { share: 0.0018, min: 1, max: 4.5 };
/** Number badge height (a black chip with gold figures, on the circle's top edge). */
const BADGE = { share: 0.014, min: 9, max: 36 };
/** A circle is drawn at least this big (share of the long side), as the map never draws one smaller than 10 px. */
const MIN_RADIUS_SHARE = 0.006;
const KW_GOLD: Rgb = [254 / 255, 224 / 255, 0];

/** An uploaded PNG/JPG becomes a page at this resolution… */
const IMAGE_DPI = 150;
/** …but never bigger than an ARCH D sheet (36 × 24 in)… */
const IMAGE_MAX_SIDE = 36 * 72;
/** …so it never needs more pixels than this on its long side (a bigger upload is scaled down first: mupdf would hold all of it). */
const IMAGE_MAX_PX = Math.round((IMAGE_MAX_SIDE * IMAGE_DPI) / 72);

/** Notes pages: US letter. The HTML (export.ts) leaves the top 64 pt for the logo. */
const NOTES_W = 612;
const NOTES_H = 792;
const NOTES_EM = 10;
/** The Kilowatt Events lockup at the top left of every notes page: height and position (from the top left) in points. */
const LOGO = { h: 18, left: 54, top: 28 };

// mupdf prints "repairing PDF" chatter for slightly broken files; real
// failures surface as exceptions.
mupdf.setLog({ error: () => {}, warning: () => {} });

// The notes' HTML asks for these by name (export.ts richText) where mupdf's
// built-in fonts have nothing: emoji, symbols and some alphabets.
const FONT_DIR = new URL("./fonts/", import.meta.url);
const FONT_FILES: Record<string, string> = {
  "KWE Emoji": "NotoEmoji.ttf",
  "KWE Symbols": "NotoSansSymbols2-Regular.ttf",
  "KWE Hebrew": "NotoSansHebrew-Regular.ttf",
  "KWE Arabic": "NotoSansArabic-Regular.ttf",
  "KWE Devanagari": "NotoSansDevanagari-Regular.ttf",
  "KWE Thai": "NotoSansThai-Regular.ttf",
};
const fonts = new Map<string, mupdf.Font | null>();
/** Kept for good: mupdf takes over (and later drops) the reference it's handed, so each hand-over is a reference of its own. */
const handedOver: mupdf.Font[] = [];
mupdf.installLoadFontFunction((name: string) => {
  const file = FONT_FILES[name];
  if (!file) return null;
  if (!fonts.has(name)) {
    try {
      fonts.set(name, new mupdf.Font(name, fs.readFileSync(new URL(file, FONT_DIR))));
    } catch {
      fonts.set(name, null); // missing: those characters go undrawn, as before
    }
  }
  const font = fonts.get(name);
  if (!font) return null;
  const ref = new mupdf.Font(font.pointer);
  handedOver.push(ref);
  return ref;
});

// Out of memory: the kernel should kill this process, not the server (the
// server sets this as it starts the worker; this is the fallback).
try {
  fs.writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  /* not Linux */
}
// The server went away: stop (see worker.ts — mupdf blocks for seconds, so a
// watchdog thread notices the new parent and ends the process).
process.on("disconnect", () => process.exit(1));
new Worker(
  `const ppid = ${process.ppid};
   setInterval(() => { if (process.ppid !== ppid) process.kill(${process.pid}, "SIGKILL"); }, 500);`,
  { eval: true },
).unref();

const post = (m: WorkerMessage) =>
  new Promise<void>((resolve) => {
    if (!process.send || !process.connected) return resolve();
    process.send(m, undefined, {}, () => resolve());
  });

// ── content stream helpers ───────────────────────────────────────────────

/** A number for a content stream: at most 3 decimals, never exponent notation. */
function n(v: number): string {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
const rgb = (c: Rgb, op: "rg" | "RG") => `${n(c[0])} ${n(c[1])} ${n(c[2])} ${op}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const KAPPA = 0.5522847498307936;
/** A full circle as four Béziers. */
function circlePath(cx: number, cy: number, r: number): string {
  const k = r * KAPPA;
  return (
    `${n(cx + r)} ${n(cy)} m ` +
    `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ` +
    `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ` +
    `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ` +
    `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`
  );
}

/** ASCII digits (all a badge holds) as a PDF hex string. */
const asciiHex = (s: string) => `<${[...s].map((ch) => (ch.charCodeAt(0) & 0x7f).toString(16).padStart(2, "0")).join("")}>`;

interface Shared {
  /** Helvetica-Bold, not embedded: every PDF viewer has it. */
  font: mupdf.PDFObject;
  /** Forms made by joining a page's content streams, so the same sheet twice shares one. */
  joined: Map<string, mupdf.PDFObject>;
  /** Its metrics (mupdf's built-in Nimbus Sans Bold has the same widths), to centre the figures. */
  metrics: mupdf.Font;
  /** One ExtGState per fill opacity, by name. */
  states: Map<string, mupdf.PDFObject>;
  q: mupdf.PDFObject;
}

const stateName = (alpha: number) => `KWEa${Math.round(alpha * 1000)}`;

function makeShared(out: mupdf.PDFDocument, sheets: ExportSheet[]): Shared {
  const states = new Map<string, mupdf.PDFObject>();
  for (const s of sheets)
    for (const c of s.circles) {
      const name = stateName(c.alpha);
      if (!states.has(name)) states.set(name, out.addObject({ Type: "ExtGState", ca: Math.round(c.alpha * 1000) / 1000, CA: 1 }));
    }
  return {
    font: out.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold", Encoding: "WinAnsiEncoding" }),
    joined: new Map(),
    metrics: new mupdf.Font("Helvetica-Bold"),
    states,
    q: out.addStream("q\n", {}),
  };
}

function textWidth(metrics: mupdf.Font, s: string): number {
  let w = 0;
  for (const ch of s) w += metrics.advanceGlyph(metrics.encodeCharacter(ch.codePointAt(0) ?? 0x3f));
  return w;
}

/**
 * The circles and their badges, drawn in "page as shown" space — the space
 * the app's fractions refer to: page.getBounds() (the crop box, with the
 * page's rotation applied), y down, origin top left. The caller puts the
 * matrix from that space to the PDF's own in front.
 */
function overlay(circles: ExportCircle[], bounds: mupdf.Rect, shared: Shared): string {
  const [x0, y0, x1, y1] = bounds;
  const W = x1 - x0;
  const H = y1 - y0;
  const L = Math.max(W, H);
  const strokeW = clamp(L * STROKE.share, STROKE.min, STROKE.max);
  const badgeH = clamp(L * BADGE.share, BADGE.min, BADGE.max);
  const ops: string[] = [];
  const placed = circles.map((c) => ({ c, cx: x0 + c.x * W, cy: y0 + c.y * H, r: Math.max(c.r, MIN_RADIUS_SHARE) * L }));
  // bigger circles first, so a small one inside a big one shows (as on the map)
  placed.sort((a, b) => b.r - a.r);
  for (const { c, cx, cy, r } of placed) {
    // one path, filled at the colour's opacity (the ExtGState) and outlined solid
    ops.push("q", `/${stateName(c.alpha)} gs`, rgb(c.fill, "rg"), rgb(c.stroke, "RG"), `${n(strokeW)} w`, `${circlePath(cx, cy, r)} B`, "Q");
  }
  // the badges last: no circle ever covers a number
  const size = badgeH * (10.5 / 18);
  for (const { c, cx, cy, r } of placed) {
    if (!(c.num > 0)) continue;
    const label = String(Math.trunc(c.num));
    const tw = textWidth(shared.metrics, label) * size;
    const bw = Math.max(badgeH, tw + badgeH * 0.5);
    // centred on the circle's top edge, as on the map — but kept on the sheet
    const bx = clamp(cx, x0 + bw / 2, x1 - bw / 2);
    const by = clamp(cy - r, y0 + badgeH / 2, y1 - badgeH / 2);
    ops.push(
      "q",
      "0 0 0 rg 1 1 1 RG",
      `${n(badgeH / 18)} w`,
      `${n(bx - bw / 2)} ${n(by - badgeH / 2)} ${n(bw)} ${n(badgeH)} re B`,
      rgb(KW_GOLD, "rg"),
      // y points down here: the text matrix flips it back so the figures read upright
      `BT /KWEHB ${n(size)} Tf 1 0 0 -1 ${n(bx - tw / 2)} ${n(by + size * 0.35)} Tm ${asciiHex(label)} Tj ET`,
      "Q",
    );
  }
  return ops.join("\n");
}

/** A shallow copy of a dictionary (the values stay shared, so nothing they point at is copied). */
function copyDict(out: mupdf.PDFDocument, d: mupdf.PDFObject | null): mupdf.PDFObject {
  const c = out.newDictionary();
  if (d && d.isDictionary()) d.forEach((v, k) => c.put(k, v));
  return c;
}

/**
 * Puts the circles on page `index` of `out`. The page's own drawing becomes
 * a form (an XObject) drawn first, so nothing left over in it (an unclosed
 * transformation, say — common in real-world files) can move the circles;
 * the circles follow, through the matrix from "page as shown" to PDF space.
 * Done for every copied page, circles or not, so that a content stream two
 * copied pages share (the same sheet twice) is only ever used as a form.
 */
function drawCircles(out: mupdf.PDFDocument, index: number, circles: ExportCircle[], shared: Shared) {
  const page = out.loadPage(index);
  const bounds = page.getBounds();
  const toPdf = mupdf.Matrix.invert(page.getTransform());
  page.destroy();
  const pageObj = out.findPage(index);

  // resources: a fresh dictionary (a copied page's may be shared with another page), plus ours
  const oldRes = pageObj.getInheritable("Resources");
  const res = copyDict(out, oldRes);
  const fonts = copyDict(out, res.get("Font"));
  fonts.put("KWEHB", shared.font);
  res.put("Font", fonts);
  const states = copyDict(out, res.get("ExtGState"));
  for (const [name, obj] of shared.states) states.put(name, obj);
  res.put("ExtGState", states);

  const old = pageObj.get("Contents");
  const parts = old.isArray() ? Array.from({ length: old.length }, (_, i) => old.get(i)) : old.isNull() ? [] : [old];
  const bbox = pageObj.getInheritable("MediaBox");
  const formDict = { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: oldRes.isNull() ? out.newDictionary() : oldRes };
  const same = (a: mupdf.PDFObject, b: mupdf.PDFObject) => (a.isIndirect() && b.isIndirect() ? a.asIndirect() === b.asIndirect() : a.toString() === b.toString());
  const single = parts.length === 1 && parts[0].isStream() && parts[0].isIndirect() ? parts[0] : null;
  let form: mupdf.PDFObject;
  if (single && single.get("Subtype").isNull()) {
    // the page's one content stream becomes the form in place: nothing copied, nothing left behind
    for (const [k, v] of Object.entries(formDict)) single.put(k, v);
    form = single;
  } else if (single && single.get("Subtype").toString() === "/Form" && same(single.get("Resources"), formDict.Resources) && same(single.get("BBox"), bbox)) {
    form = single; // the same sheet copied twice: they share its form
  } else if (single) {
    // a stream shared by pages that differ: a copy of its still-compressed bytes
    const filter = single.get("Filter");
    const parms = single.get("DecodeParms");
    const dict: Record<string, unknown> = { ...formDict };
    if (!filter.isNull()) dict.Filter = filter;
    if (!parms.isNull()) dict.DecodeParms = parms;
    form = out.addRawStream(single.readRawStream(), dict);
  } else {
    // several streams (always so once a page's markups are merged in): joined
    // — one may end mid-token, hence the line breaks — once per sheet
    const key = parts.every((p) => p.isIndirect())
      ? `${parts.map((p) => p.asIndirect()).join(",")}|${formDict.Resources.isIndirect() ? formDict.Resources.asIndirect() : formDict.Resources.toString()}|${bbox.toString()}`
      : null;
    const known = key === null ? undefined : shared.joined.get(key);
    if (known) form = known;
    else {
      const buf = new mupdf.Buffer();
      for (const p of parts)
        if (p.isStream()) {
          buf.writeBuffer(p.readStream());
          buf.write("\n");
        }
      form = out.addStream(buf, formDict);
      if (key !== null) shared.joined.set(key, form);
    }
  }
  const xobjects = copyDict(out, res.get("XObject"));
  xobjects.put("KWEPage", form);
  res.put("XObject", xobjects);
  const m = toPdf.map(n).join(" ");
  pageObj.put("Contents", out.addStream(`q /KWEPage Do Q\nq\n${m} cm\n${overlay(circles, bounds, shared)}\nQ\n`, {}));
  pageObj.put("Resources", res);
}

/** The lockup at the top left of a notes page (made by htmlToPdf: our own, tidy drawing). */
function drawLogo(out: mupdf.PDFDocument, index: number, logo: { ref: mupdf.PDFObject; w: number; h: number }, shared: Shared) {
  const pageObj = out.findPage(index);
  const res = copyDict(out, pageObj.getInheritable("Resources"));
  const xobjects = copyDict(out, res.get("XObject"));
  xobjects.put("KWELogo", logo.ref);
  res.put("XObject", xobjects);
  pageObj.put("Resources", res);
  const old = pageObj.get("Contents");
  const contents = out.newArray();
  contents.push(shared.q);
  if (old.isArray()) for (let i = 0; i < old.length; i++) contents.push(old.get(i));
  else if (!old.isNull()) contents.push(old);
  const y = NOTES_H - LOGO.top - logo.h;
  contents.push(out.addStream(`\nQ\nq ${n(logo.w)} 0 0 ${n(logo.h)} ${n(LOGO.left)} ${n(y)} cm /KWELogo Do Q\n`, {}));
  pageObj.put("Contents", contents);
}

// ── sources ──────────────────────────────────────────────────────────────

/** A PDF read from disk as needed (never held whole in memory). */
function openPdfFile(file: string): { doc: mupdf.PDFDocument; close(): void } {
  const fd = fs.openSync(file, "r");
  let stm: mupdf.Stream | null = null;
  try {
    const size = fs.fstatSync(fd).size;
    stm = new mupdf.Stream({
      fileSize: () => size,
      read: (memory: Uint8Array, offset: number, length: number, position: number) => fs.readSync(fd, memory, offset, length, position),
      close: () => fs.closeSync(fd),
    });
    const doc = mupdf.Document.openDocument(stm, "application/pdf").asPDF();
    if (!doc) throw new Error("not a PDF");
    const s = stm;
    return {
      doc,
      close: () => {
        doc.destroy();
        s.destroy();
      },
    };
  } catch (e) {
    if (stm) stm.destroy();
    else fs.closeSync(fd);
    throw e;
  }
}

/**
 * A PNG/JPG upload as a page, upright as the app shows it (EXIF rotation
 * applied, as the renderer does), and no bigger than the page needs: an
 * image that's already both goes in as it is.
 */
async function addImagePage(out: mupdf.PDFDocument, file: string) {
  const meta = await sharp(file).metadata();
  let bytes: Buffer = fs.readFileSync(file);
  const turned = (meta.orientation ?? 1) > 1;
  if (turned || Math.max(meta.width ?? 0, meta.height ?? 0) > IMAGE_MAX_PX)
    bytes = await sharp(file)
      .rotate()
      .resize({ width: IMAGE_MAX_PX, height: IMAGE_MAX_PX, fit: "inside", withoutEnlargement: true })
      .toFormat(meta.format === "png" ? "png" : "jpeg", { quality: 92 })
      .toBuffer();
  const img = new mupdf.Image(bytes);
  let w = (img.getWidth() * 72) / IMAGE_DPI;
  let h = (img.getHeight() * 72) / IMAGE_DPI;
  const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
  w *= k;
  h *= k;
  const ref = out.addImage(img);
  img.destroy();
  out.insertPage(-1, out.addPage([0, 0, w, h], 0, { XObject: { KWEImg: ref } }, `q ${n(w)} 0 0 ${n(h)} 0 0 cm /KWEImg Do Q`));
}

/** HTML laid out on letter pages, as a PDF of its own (fonts cut down to the characters used). */
function htmlToPdf(html: string): mupdf.PDFDocument {
  const src = mupdf.Document.openDocument(new TextEncoder().encode(html), "text/html");
  const buf = new mupdf.Buffer();
  try {
    src.layout(NOTES_W, NOTES_H, NOTES_EM);
    const writer = new mupdf.DocumentWriter(buf, "pdf", "compress");
    for (let i = 0, count = src.countPages(); i < count; i++) {
      const page = src.loadPage(i);
      const dev = writer.beginPage(page.getBounds());
      page.run(dev, mupdf.Matrix.identity);
      writer.endPage();
      page.destroy();
    }
    writer.close();
  } finally {
    src.destroy();
  }
  const pdf = new mupdf.PDFDocument(buf);
  buf.destroy();
  pdf.subsetFonts();
  return pdf;
}

/** Appends every page of `doc`; returns their indexes in `out`. */
function appendAll(out: mupdf.PDFDocument, doc: mupdf.PDFDocument): number[] {
  const map = out.newGraftMap();
  const at: number[] = [];
  for (let i = 0, count = doc.countPages(); i < count; i++) {
    map.graftPage(-1, doc, i);
    at.push(out.countPages() - 1);
  }
  map.destroy();
  return at;
}

/**
 * Layers (optional content) the source hides stay hidden: a copied page keeps
 * its marks but not the file's list of layers, and without that list every
 * viewer shows every layer. Its layers join the export's list, those that
 * are off by default still off.
 */
function keepLayers(out: mupdf.PDFDocument, src: mupdf.PDFDocument, map: mupdf.PDFGraftMap) {
  // (get() on a missing entry's null object throws: everything is checked first)
  const props = src.getTrailer().get("Root").get("OCProperties");
  if (!props.isDictionary()) return;
  const groups = props.get("OCGs");
  if (!groups.isArray()) return;
  const config = props.get("D");
  const refs = (key: string) => {
    const set = new Set<number>();
    const list = config.isDictionary() ? config.get(key) : null;
    if (list?.isArray()) for (let i = 0; i < list.length; i++) if (list.get(i).isIndirect()) set.add(list.get(i).asIndirect());
    return set;
  };
  const on = refs("ON");
  const off = refs("OFF");
  const allOff = config.isDictionary() && config.get("BaseState").toString() === "/OFF";

  const root = out.getTrailer().get("Root");
  let mine = root.get("OCProperties");
  if (!mine.isDictionary()) {
    mine = out.newDictionary();
    mine.put("OCGs", out.newArray());
    const d = out.newDictionary();
    d.put("OFF", out.newArray());
    mine.put("D", d);
    root.put("OCProperties", mine);
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups.get(i);
    if (!g.isIndirect()) continue;
    const copy = map.graftObject(g);
    mine.get("OCGs").push(copy);
    if (allOff ? !on.has(g.asIndirect()) : off.has(g.asIndirect())) mine.get("D").get("OFF").push(copy);
  }
}

// ── the export ───────────────────────────────────────────────────────────

async function exportPdf(task: Extract<WorkerTask, { task: "export" }>): Promise<WorkerMessage> {
  const out = new mupdf.PDFDocument();
  try {
    const job = JSON.parse(fs.readFileSync(task.jobFile, "utf8")) as ExportJob;
    const sheets = job.sheets;
    const shared = makeShared(out, sheets);
    /** Where each sheet's page is in `out` (before reordering); -1: not copied (yet). */
    const sheetAt = sheets.map(() => -1);
    /** Sheets shown as a "couldn't be read" page: no circles on those. */
    const placeholder = sheets.map(() => false);

    // PDF pages, each file opened once. The original's own markups (stamps,
    // comments — the app's page images show them) don't come with a copied
    // page, so they're merged into its drawing first, in this copy of the
    // file that is never saved.
    const bySource = new Map<string, number[]>();
    sheets.forEach((s, i) => {
      if (s.kind !== "pdf") return;
      const list = bySource.get(s.sourceId);
      if (list) list.push(i);
      else bySource.set(s.sourceId, [i]);
    });
    for (const list of bySource.values()) {
      let src: { doc: mupdf.PDFDocument; close(): void } | null = null;
      try {
        src = openPdfFile(sheets[list[0]].file);
        src.doc.bake(true, true);
      } catch {
        src?.close();
        continue; // unreadable: those pages get a placeholder
      }
      // Some files point at objects they don't have (a quirk of some
      // producers; viewers shrug it off, copying a page can't): those pages
      // are copied from a tidied copy of the file instead.
      let tidied: mupdf.PDFDocument | null = null;
      let tidiedMap: mupdf.PDFGraftMap | null = null;
      try {
        const map = out.newGraftMap();
        const copyPage = (doc: mupdf.PDFDocument, m: mupdf.PDFGraftMap, i: number) => {
          // one copy per wanted page, so the same sheet wanted twice gets two pages (sharing their contents)
          m.graftPage(-1, doc, sheets[i].index);
          const at = out.countPages() - 1;
          // a page's transparency group doesn't come with a copied page either
          const group = doc.findPage(sheets[i].index).get("Group");
          if (!group.isNull()) out.findPage(at).put("Group", m.graftObject(group));
          sheetAt[i] = at;
        };
        for (const i of list) {
          try {
            copyPage(src.doc, map, i);
          } catch {
            try {
              tidied ??= new mupdf.PDFDocument(src.doc.saveToBuffer("garbage"));
              tidiedMap ??= out.newGraftMap();
              copyPage(tidied, tidiedMap, i);
            } catch {
              /* a broken page: a placeholder */
            }
          }
        }
        keepLayers(out, src.doc, map);
        map.destroy();
        if (tidied && tidiedMap) {
          keepLayers(out, tidied, tidiedMap);
          tidiedMap.destroy();
        }
      } finally {
        tidied?.destroy();
        src.close();
      }
    }
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].kind !== "image") continue;
      try {
        await addImagePage(out, sheets[i].file);
        sheetAt[i] = out.countPages() - 1;
      } catch {
        /* a placeholder */
      }
    }
    for (let i = 0; i < sheets.length; i++) {
      if (sheetAt[i] >= 0) continue;
      const doc = htmlToPdf(sheets[i].placeholderHtml);
      sheetAt[i] = appendAll(out, doc)[0];
      doc.destroy();
      placeholder[i] = true;
    }

    // notes, after their page
    const notesAt = sheets.map((s) => {
      if (!s.notesHtml) return [];
      const doc = htmlToPdf(s.notesHtml);
      const at = appendAll(out, doc);
      doc.destroy();
      return at;
    });

    const order: number[] = [];
    sheets.forEach((_, i) => order.push(sheetAt[i], ...notesAt[i]));
    out.rearrangePages(order);

    let logo: { ref: mupdf.PDFObject; w: number; h: number } | null = null;
    if (job.logoFile && notesAt.some((a) => a.length > 0)) {
      try {
        const img = new mupdf.Image(fs.readFileSync(job.logoFile));
        logo = { ref: out.addImage(img), w: (LOGO.h * img.getWidth()) / img.getHeight(), h: LOGO.h };
        img.destroy();
      } catch {
        logo = null; // the notes go without it
      }
    }

    const outline = out.outlineIterator();
    const linkTo = (page: number) => out.formatLinkURI({ type: "Fit", chapter: 0, page, x: 0, y: 0, width: 0, height: 0, zoom: 0 });
    let at = 0;
    sheets.forEach((s, i) => {
      if (!placeholder[i]) drawCircles(out, at, s.circles, shared);
      out.setPageLabels(at, mupdf.PDFDocument.PAGE_LABEL_NONE, s.label, 1);
      outline.insert({ title: s.label, uri: linkTo(at), open: false });
      at++;
      if (notesAt[i].length > 0) {
        out.setPageLabels(at, mupdf.PDFDocument.PAGE_LABEL_DECIMAL, `${s.label} notes `, 1);
        for (let k = 0; k < notesAt[i].length; k++, at++) if (logo) drawLogo(out, at, logo, shared);
      }
    });
    outline.destroy();
    out.setMetaData("info:Title", job.title);
    out.setMetaData("info:Creator", "KWE Blueprints");

    const pages = out.countPages();
    // "garbage": leaves out what the export no longer uses (a page's content streams once joined into one form)
    const buf = out.saveToBuffer("garbage,compress");
    try {
      const data = buf.asUint8Array(); // a view of mupdf's memory: written without a copy
      const fd = fs.openSync(task.outFile, "w");
      try {
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
      return { type: "exported", pages, bytes: data.length };
    } finally {
      buf.destroy();
    }
  } catch (e) {
    fs.rmSync(task.outFile, { force: true });
    return { type: "error", code: isNoSpace(e) ? "nospace" : "failed", message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  } finally {
    out.destroy();
  }
}

function isNoSpace(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  return /ENOSPC|no space left|disk quota|write failed/i.test(e instanceof Error ? e.message : String(e));
}

const task = JSON.parse(process.argv[2] ?? "null") as WorkerTask;
await post(task.task === "export" ? await exportPdf(task) : { type: "error", code: "failed", message: `not an export task: ${task.task}` });
process.exit(0);
