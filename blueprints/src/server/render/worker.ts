// Render worker: one fresh Node process per job (see run-worker.ts), so
// mupdf's WebAssembly heap (which grows but never shrinks — an ARCH D sheet
// needs ~130 MB of pixels) is thrown away afterwards, and a page that needs
// more memory than the machine has takes down only this process, never the
// server. mupdf calls are synchronous; running them here keeps the server
// free to answer autosaves while big sheets render.
//
// The task arrives as JSON in argv[2]; messages go back over the IPC
// channel (process.send). In development and tests this file runs as
// TypeScript through Node's type stripping, in production as
// dist/server/render-worker.js. Keep it to erasable TypeScript, and import
// only packages and `import type`s.

import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import sharp from "sharp";
import type { WorkerMessage, WorkerTask } from "./protocol";

/** DeployMap's proven numbers: 300 DPI, but never more than 8000 px on the long side… */
const PDF_DPI = 300;
const MAX_LONG_SIDE = 8000;
/**
 * …and never more than ~40 megapixels in all: memory follows the area, so a
 * huge square sheet (8000 × 8000 = 64 MP) would need half as much again as
 * an ARCH D one. Every buffer of the render (and each transparency group
 * mupdf composites) is a multiple of this.
 */
const MAX_PIXELS = 40_000_000;
const PREVIEW_MAX = 2048;
const THUMB_MAX = 480;
const TILE_SIZE = 512;
const JPEG_QUALITY = 85;

/**
 * Tile format for a PDF page: PNG unless a sample shows that lossless tiles
 * would cost more than this many bytes per pixel AND be over twice the
 * JPEG size. Measured: line work 0.01–0.05 B/px (PNG often smaller than
 * JPEG), a noisy 300 dpi scan 1.06 B/px (9.6× its JPEG).
 */
const PNG_BYTES_PER_PIXEL_LIMIT = 0.4;
const PNG_OVER_JPEG_LIMIT = 2;

// mupdf prints "repairing PDF" chatter for slightly broken files; real
// failures surface as exceptions, so the log lines are noise.
mupdf.setLog({ error: () => {}, warning: () => {} });

// If memory runs out, the kernel should kill this process rather than the
// server. The server sets this as it starts the worker; this is the fallback
// (Linux; raising one's own score needs no privileges).
try {
  fs.writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  /* not Linux */
}
// The server went away (crashed or was stopped): stop rendering for nobody.
process.on("disconnect", () => process.exit(1));

/** Send a message; resolves once it has been handed to the server. */
const post = (m: WorkerMessage) =>
  new Promise<void>((resolve) => {
    if (!process.send || !process.connected) return resolve();
    process.send(m, undefined, {}, () => resolve());
  });

interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

/** Downscale factor (≤ `max`) that keeps a w×h image inside both the long-side and the area limits. */
function fitScale(w: number, h: number, max: number): number {
  return Math.min(max, MAX_LONG_SIDE / Math.max(1, w, h), Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
}

// ── inspect ──────────────────────────────────────────────────────────────

function inspect(task: Extract<WorkerTask, { task: "inspect" }>): WorkerMessage {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(task.file), "application/pdf");
  } catch {
    return { type: "error", code: "corrupt", message: "open failed" };
  }
  try {
    if (doc.needsPassword()) return { type: "inspected", pageCount: 0, needsPassword: true, labels: [] };
    const pageCount = doc.countPages();
    if (pageCount > task.maxPages || pageCount < 1) return { type: "inspected", pageCount, needsPassword: false, labels: [] };
    // Bookmarks: plotted CAD sets often carry one per sheet ("A-101 Seating bowl").
    const bookmarks = new Map<number, string>();
    const walk = (items: ReturnType<mupdf.Document["loadOutline"]>) => {
      for (const it of items ?? []) {
        const title = it.title?.replace(/\s+/g, " ").trim();
        if (typeof it.page === "number" && it.page >= 0 && title && !bookmarks.has(it.page)) bookmarks.set(it.page, title);
        if (it.down) walk(it.down);
      }
    };
    try {
      walk(doc.loadOutline());
    } catch {
      /* a broken outline just means no bookmark names */
    }
    const labels: (string | null)[] = [];
    for (let i = 0; i < pageCount; i++) {
      let label: string | null = null;
      try {
        const page = doc.loadPage(i);
        // getLabel() returns "1", "2"… when the PDF defines no labels: only real names count
        const l = page.getLabel()?.replace(/\s+/g, " ").trim();
        if (l && !/^\d+$/.test(l)) label = l;
        page.destroy();
      } catch {
        /* unreadable page: it will fail to render and say so */
      }
      labels.push(label ?? bookmarks.get(i) ?? null);
    }
    return { type: "inspected", pageCount, needsPassword: false, labels };
  } catch (e) {
    return { type: "error", code: "corrupt", message: String(e) };
  } finally {
    doc.destroy();
  }
}

// ── render ───────────────────────────────────────────────────────────────

function rasterizePdf(file: string, pageIndex: number): Raster {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), "application/pdf");
  try {
    const page = doc.loadPage(pageIndex);
    try {
      // getBounds(): the CropBox with /Rotate applied, origin at 0,0
      const [x0, y0, x1, y1] = page.getBounds();
      const scale = fitScale(x1 - x0, y1 - y0, PDF_DPI / 72);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        const width = pix.getWidth();
        const height = pix.getHeight();
        const n = pix.getNumberOfComponents();
        const stride = pix.getStride();
        if (n !== 3) throw new Error(`unexpected pixmap components: ${n}`);
        const pixels = pix.getPixels();
        let data: Buffer;
        if (stride === width * 3) {
          data = Buffer.from(pixels); // copy out of the wasm heap before it is freed
        } else {
          data = Buffer.allocUnsafe(width * height * 3);
          for (let y = 0; y < height; y++) data.set(pixels.subarray(y * stride, y * stride + width * 3), y * width * 3);
        }
        return { data, width, height };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

async function rasterizeImage(file: string): Promise<Raster> {
  // The EXIF rotation below may swap width and height; the scale doesn't care.
  const meta = await sharp(file).metadata();
  const s = fitScale(meta.width ?? 1, meta.height ?? 1, 1);
  const box = Math.max(1, Math.floor(Math.max(meta.width ?? 1, meta.height ?? 1) * s));
  const { data, info } = await sharp(file)
    .rotate() // bake the EXIF orientation in: a phone photo stores its pixels sideways
    .flatten({ background: "#ffffff" })
    .resize({ width: box, height: box, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .raw({ depth: "uchar" }) // 16-bit PNGs come out as 8-bit RGB like everything else
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`unexpected image channels: ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

const fromRaw = (r: Raster) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } });

/**
 * Lossless PNG keeps line work crisp, and line work is cheap that way
 * (mostly flat paper). A scanned or photographic page is not: as PNG it
 * comes to 1–2 bytes per pixel, ~16× the upload, and a few dozen such
 * sheets would fill the volume. Decide by encoding a sample — 16 strips
 * across the page at full resolution, ~5% of it — both ways.
 */
async function chooseTileFormat(r: Raster): Promise<"png" | "jpeg"> {
  const rows = Math.min(16, r.height);
  const strips = Math.max(1, Math.min(16, Math.floor(r.height / rows)));
  const rowBytes = r.width * 3;
  const sample = Buffer.allocUnsafe(strips * rows * rowBytes);
  for (let i = 0; i < strips; i++) {
    const y = Math.min(r.height - rows, Math.max(0, Math.round(((i + 0.5) * r.height) / strips - rows / 2)));
    r.data.copy(sample, i * rows * rowBytes, y * rowBytes, (y + rows) * rowBytes);
  }
  const img = sharp(sample, { raw: { width: r.width, height: strips * rows, channels: 3 } });
  const [png, jpeg] = await Promise.all([img.clone().png().toBuffer(), img.clone().jpeg({ quality: JPEG_QUALITY }).toBuffer()]);
  const pngPerPixel = png.length / (r.width * strips * rows);
  return pngPerPixel > PNG_BYTES_PER_PIXEL_LIMIT && png.length > PNG_OVER_JPEG_LIMIT * jpeg.length ? "jpeg" : "png";
}

/** Write a file in the work folder, then move it into place in one rename (a half-written file is never served). */
async function writeInto(outDir: string, workDir: string, name: string, write: (tmp: string) => Promise<unknown>) {
  const tmp = path.join(workDir, name);
  await write(tmp);
  fs.renameSync(tmp, path.join(outDir, name));
}

/** A failed write because the disk is full (libvips only says "write failed"). */
function isNoSpace(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  return /ENOSPC|no space left|disk quota|write failed/i.test(e instanceof Error ? e.message : String(e));
}

async function render(task: Extract<WorkerTask, { task: "render" }>): Promise<WorkerMessage> {
  const { outDir, workDir } = task;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const raster = task.kind === "pdf" ? rasterizePdf(task.file, task.pageIndex) : await rasterizeImage(task.file);

    // 1. preview and thumbnail — the page becomes viewable (in the editor
    //    and the page list) as soon as both exist
    let preview = { width: 0, height: 0 };
    await writeInto(outDir, workDir, "preview.webp", async (tmp) => {
      preview = await fromRaw(raster)
        .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(tmp);
    });
    await writeInto(outDir, workDir, "thumb.webp", (tmp) =>
      fromRaw(raster).resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(tmp),
    );
    await post({ type: "preview", width: raster.width, height: raster.height, previewW: preview.width, previewH: preview.height });

    // 2. deep-zoom tiles: lossless PNG for line work, JPEG for scans and
    //    photos (every uploaded image, and PDF pages that sample as such).
    //    sharp's tile() forwards only interlace, compression and filter to
    //    PNG tiles — a palette option would be silently ignored, and
    //    re-encoding every tile as palette PNG afterwards costs more than the
    //    whole render (measured: 2.4 → 1.2 MB but +9 s per ARCH D sheet), so
    //    tiles are plain RGB PNG at the default compression.
    const tileFormat = task.kind === "pdf" ? await chooseTileFormat(raster) : "jpeg";
    const encoder = fromRaw(raster);
    if (tileFormat === "png") encoder.png();
    else encoder.jpeg({ quality: JPEG_QUALITY });
    await encoder.tile({ size: TILE_SIZE, overlap: 0, layout: "dz", depth: "onetile" }).toFile(path.join(workDir, "tiles.dz"));

    // dzsave writes tiles.dzi + tiles_files/<level>/<col>_<row>.<ext> (+ vips-properties.xml)
    const filesDir = path.join(workDir, "tiles_files");
    fs.rmSync(path.join(filesDir, "vips-properties.xml"), { force: true });
    fs.rmSync(path.join(workDir, "tiles.dzi"), { force: true });
    const levels = fs
      .readdirSync(filesDir)
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
    if (!levels.length) throw new Error("no tile levels were written");
    fs.rmSync(path.join(outDir, "tiles"), { recursive: true, force: true });
    fs.renameSync(filesDir, path.join(outDir, "tiles"));

    return { type: "done", tileSize: TILE_SIZE, maxLevel: Math.max(...levels), minLevel: Math.min(...levels), tileFormat };
  } catch (e) {
    return { type: "error", code: isNoSpace(e) ? "nospace" : "failed", message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const task = JSON.parse(process.argv[2] ?? "null") as WorkerTask;
// The answer goes out only after the work folder is cleaned up; then the
// process ends (the server would kill it soon after anyway).
await post(task.task === "inspect" ? inspect(task) : await render(task));
process.exit(0);
