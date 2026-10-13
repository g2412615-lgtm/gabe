// Builds the sample blueprints the tests (and a local demo) use. Every name in
// here is fictional. Run: npm run fixtures  → writes into tests/fixtures/out/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb, degrees } from "pdf-lib";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });

const ink = rgb(0.12, 0.16, 0.22);
const faint = rgb(0.72, 0.76, 0.82);

// A stadium bowl drawn as vector line work, like a CAD plot: concentric
// ellipses, numbered sections, gates, a grid and small print.
function drawStadium(page, font, title) {
  const { width: W, height: H } = page.getSize();
  const cx = W / 2, cy = H / 2;
  for (let x = 36; x < W; x += 72) page.drawLine({ start: { x, y: 24 }, end: { x, y: H - 24 }, thickness: 0.3, color: faint });
  for (let y = 36; y < H; y += 72) page.drawLine({ start: { x: 24, y }, end: { x: W - 24, y }, thickness: 0.3, color: faint });
  for (const [rx, ry, t] of [[W * 0.42, H * 0.4, 2.2], [W * 0.36, H * 0.33, 1.2], [W * 0.27, H * 0.24, 1.2], [W * 0.18, H * 0.15, 2]]) {
    page.drawEllipse({ x: cx, y: cy, xScale: rx, yScale: ry, borderColor: ink, borderWidth: t });
  }
  page.drawRectangle({ x: cx - W * 0.14, y: cy - H * 0.1, width: W * 0.28, height: H * 0.2, borderColor: rgb(0.1, 0.5, 0.2), borderWidth: 2 });
  const sections = 48;
  for (let i = 0; i < sections; i++) {
    const a = (i / sections) * Math.PI * 2;
    const x1 = cx + Math.cos(a) * W * 0.27, y1 = cy + Math.sin(a) * H * 0.24;
    const x2 = cx + Math.cos(a) * W * 0.36, y2 = cy + Math.sin(a) * H * 0.33;
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.8, color: ink });
    const lx = cx + Math.cos(a + Math.PI / sections) * W * 0.315, ly = cy + Math.sin(a + Math.PI / sections) * H * 0.285;
    page.drawText(String(101 + i), { x: lx - 6, y: ly - 3, size: 7, font, color: ink });
  }
  const gates = ["Gate A", "Gate B", "Gate C", "Gate D"];
  gates.forEach((g, i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = cx + Math.cos(a) * W * 0.44, y = cy + Math.sin(a) * H * 0.43;
    page.drawRectangle({ x: x - 30, y: y - 10, width: 60, height: 20, color: rgb(1, 0.97, 0.88), borderColor: ink, borderWidth: 1 });
    page.drawText(g, { x: x - 18, y: y - 4, size: 9, font, color: ink });
  });
  // tiny print that only reads when zoomed in
  for (let i = 0; i < 12; i++) page.drawText(`Note ${i + 1}: magnetometer lane ${i + 1}, 3 ft spacing, stanchions per detail 4/A-501`, { x: 48, y: 48 + i * 7, size: 4.5, font, color: ink });
  page.drawText(title, { x: W - 360, y: 48, size: 18, font, color: ink });
  page.drawText("Millrace Stadium · Sample event plan · Not for construction", { x: W - 360, y: 30, size: 8, font, color: ink });
}

function setPageLabels(pdf, labels) {
  // /PageLabels number tree with one /P (prefix) entry per page, e.g. "A-101"
  const nums = [];
  labels.forEach((l, i) => {
    nums.push(PDFNumber.of(i));
    nums.push(pdf.context.obj({ P: PDFString.of(l) }));
  });
  pdf.catalog.set(PDFName.of("PageLabels"), pdf.context.obj({ Nums: nums }));
}

async function eventPlan() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Millrace Stadium sample event plan");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  drawStadium(pdf.addPage([2592, 1728]), font, "A-101 Seating bowl"); // ARCH D landscape
  const p2 = pdf.addPage([612, 792]); // Letter portrait: parking
  for (let r = 0; r < 14; r++) for (let c = 0; c < 6; c++) p2.drawRectangle({ x: 60 + c * 85, y: 80 + r * 46, width: 70, height: 36, borderColor: ink, borderWidth: 0.8 });
  p2.drawText("P-1 North lot", { x: 60, y: 740, size: 16, font, color: ink });
  const p3 = pdf.addPage([1224, 792]); // Tabloid landscape: concourse
  drawStadium(p3, font, "C-201 Concourse");
  const p4 = pdf.addPage([792, 612]); // rotated sheet
  p4.setRotation(degrees(90));
  p4.drawText("R-1 Rotated sheet (reads upright after /Rotate 90)", { x: 60, y: 300, size: 14, font, color: ink });
  p4.drawRectangle({ x: 40, y: 40, width: 712, height: 532, borderColor: ink, borderWidth: 2 });
  setPageLabels(pdf, ["A-101", "P-1", "C-201", "R-1"]);
  fs.writeFileSync(path.join(out, "event-plan.pdf"), await pdf.save());
}

async function onePage() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  drawStadium(pdf.addPage([1728, 1152]), font, "S-1 Suite level");
  fs.writeFileSync(path.join(out, "suite-level.pdf"), await pdf.save());
}

async function image() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#fff"/>
    <g fill="none" stroke="#1f2937" stroke-width="3"><rect x="80" y="80" width="1440" height="840"/><rect x="300" y="250" width="1000" height="500"/></g>
    <text x="100" y="60" font-family="sans-serif" font-size="36" fill="#1f2937">Warehouse 2 (photo of a printed plan)</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(out, "warehouse.png"));
}

fs.writeFileSync(path.join(out, "corrupt.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4000, 0x41)]));
await eventPlan();
await onePage();
await image();
console.log("fixtures written to", out);
