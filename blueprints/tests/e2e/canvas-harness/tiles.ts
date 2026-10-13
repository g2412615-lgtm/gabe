// Renders one PDF page exactly the way the server's render worker does
// (src/server/render/worker.ts, SPEC §5): 300 DPI capped at 8000 px on the
// long side, a 2048 px preview.webp and 512 px PNG deep-zoom tiles — so the
// canvas test looks at real tiles. Cached by fixture size + mtime.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as mupdf from "mupdf";
import sharp from "sharp";

export interface RenderedPage {
  dir: string;
  width: number;
  height: number;
  previewW: number;
  previewH: number;
  tileSize: number;
  minLevel: number;
  maxLevel: number;
}

export async function renderFixturePage(pdfFile: string, pageIndex = 0): Promise<RenderedPage> {
  const st = fs.statSync(pdfFile);
  const dir = path.join(os.tmpdir(), `bpn-canvas-e2e-${pageIndex}-${st.size}-${Math.round(st.mtimeMs)}`);
  const metaFile = path.join(dir, "meta.json");
  if (fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, "utf8")) as RenderedPage;

  const work = `${dir}.tmp-${process.pid}`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const doc = mupdf.Document.openDocument(fs.readFileSync(pdfFile), "application/pdf");
  const page = doc.loadPage(pageIndex);
  const [x0, y0, x1, y1] = page.getBounds();
  const scale = Math.min(300 / 72, 8000 / Math.max(1, x1 - x0, y1 - y0));
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const width = pix.getWidth();
  const height = pix.getHeight();
  const stride = pix.getStride();
  const pixels = pix.getPixels();
  const data = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) data.set(pixels.subarray(y * stride, y * stride + width * 3), y * width * 3);
  pix.destroy();
  page.destroy();
  doc.destroy();

  const raw = () => sharp(data, { raw: { width, height, channels: 3 } });
  const preview = await raw().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(work, "preview.webp"));
  await raw().png().tile({ size: 512, overlap: 0, layout: "dz", depth: "onetile" }).toFile(path.join(work, "tiles.dz"));
  const levels = fs
    .readdirSync(path.join(work, "tiles_files"))
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
  fs.renameSync(path.join(work, "tiles_files"), path.join(work, "tiles"));
  fs.rmSync(path.join(work, "tiles.dzi"), { force: true });

  const meta: RenderedPage = {
    dir,
    width,
    height,
    previewW: preview.width,
    previewH: preview.height,
    tileSize: 512,
    minLevel: Math.min(...levels),
    maxLevel: Math.max(...levels),
  };
  fs.writeFileSync(path.join(work, "meta.json"), JSON.stringify(meta));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(work, dir);
  return meta;
}
