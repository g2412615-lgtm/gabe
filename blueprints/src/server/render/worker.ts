// Render worker: one fresh worker thread per job, so mupdf's WebAssembly heap
// (which grows but never shrinks — an ARCH D sheet needs ~130 MB of pixels)
// is thrown away afterwards. mupdf calls are synchronous; running them here
// keeps the main thread free to answer autosaves while big sheets render.
//
// In development and tests this file runs as TypeScript through Node's type
// stripping (or tsx), in production as dist/server/render-worker.js. Keep it
// to erasable TypeScript, and import only packages and `import type`s.

import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import * as mupdf from "mupdf";
import sharp from "sharp";
import type { WorkerMessage, WorkerTask } from "./protocol";

/** DeployMap's proven numbers: 300 DPI, but never more than 8000 px on the long side. */
const PDF_DPI = 300;
const MAX_LONG_SIDE = 8000;
const PREVIEW_MAX = 2048;
const THUMB_MAX = 480;
const TILE_SIZE = 512;

// mupdf prints "repairing PDF" chatter for slightly broken files; real
// failures surface as exceptions, so the log lines are noise.
mupdf.setLog({ error: () => {}, warning: () => {} });

const post = (m: WorkerMessage) => parentPort?.postMessage(m);

interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

// ── inspect ──────────────────────────────────────────────────────────────

function inspect(task: Extract<WorkerTask, { task: "inspect" }>) {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(task.file), "application/pdf");
  } catch {
    post({ type: "error", code: "corrupt", message: "open failed" });
    return;
  }
  try {
    if (doc.needsPassword()) {
      post({ type: "inspected", pageCount: 0, needsPassword: true, labels: [] });
      return;
    }
    const pageCount = doc.countPages();
    if (pageCount > task.maxPages || pageCount < 1) {
      post({ type: "inspected", pageCount, needsPassword: false, labels: [] });
      return;
    }
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
    post({ type: "inspected", pageCount, needsPassword: false, labels });
  } catch (e) {
    post({ type: "error", code: "corrupt", message: String(e) });
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
      const scale = Math.min(PDF_DPI / 72, MAX_LONG_SIDE / Math.max(1, x1 - x0, y1 - y0));
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
  const { data, info } = await sharp(file)
    .rotate() // bake the EXIF orientation in: a phone photo stores its pixels sideways
    .flatten({ background: "#ffffff" })
    .resize({ width: MAX_LONG_SIDE, height: MAX_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .raw({ depth: "uchar" }) // 16-bit PNGs come out as 8-bit RGB like everything else
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`unexpected image channels: ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

const fromRaw = (r: Raster) => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } });

/** Write a file in the work folder, then move it into place in one rename (a half-written file is never served). */
async function writeInto(outDir: string, workDir: string, name: string, write: (tmp: string) => Promise<unknown>) {
  const tmp = path.join(workDir, name);
  await write(tmp);
  fs.renameSync(tmp, path.join(outDir, name));
}

async function render(task: Extract<WorkerTask, { task: "render" }>) {
  const { outDir, workDir } = task;
  // The final message goes out only after the work folder is cleaned up: the
  // main thread terminates this worker as soon as it arrives.
  let final: WorkerMessage;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const raster = task.kind === "pdf" ? rasterizePdf(task.file, task.pageIndex) : await rasterizeImage(task.file);

    // 1. preview — the page becomes viewable as soon as this exists
    let preview = { width: 0, height: 0 };
    await writeInto(outDir, workDir, "preview.webp", async (tmp) => {
      preview = await fromRaw(raster)
        .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(tmp);
    });
    post({ type: "preview", width: raster.width, height: raster.height, previewW: preview.width, previewH: preview.height });

    // 2. thumbnail for the home list and the page sidebar
    await writeInto(outDir, workDir, "thumb.webp", (tmp) =>
      fromRaw(raster).resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(tmp),
    );

    // 3. deep-zoom tiles: lossless PNG for PDFs (line work stays crisp), JPEG
    //    for photos and scans. sharp's tile() forwards only interlace,
    //    compression and filter to PNG tiles — a palette option would be
    //    silently ignored, and re-encoding every tile as palette PNG
    //    afterwards costs more than the whole render (measured: 2.4 → 1.2 MB
    //    but +9 s per ARCH D sheet), so tiles are plain RGB PNG at the
    //    default compression (the best speed/size point measured).
    const tileFormat = task.kind === "pdf" ? "png" : "jpeg";
    const encoder = fromRaw(raster);
    if (tileFormat === "png") encoder.png();
    else encoder.jpeg({ quality: 86 });
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

    final = { type: "done", tileSize: TILE_SIZE, maxLevel: Math.max(...levels), minLevel: Math.min(...levels), tileFormat };
  } catch (e) {
    final = { type: "error", code: "failed", message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  post(final);
}

const task = workerData as WorkerTask;
if (task.task === "inspect") inspect(task);
else await render(task);
