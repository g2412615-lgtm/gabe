// "Download PDF" (POST /api/plans/:id/export): the chosen pages of an event
// plan as one PDF, each page as it was uploaded with the circles drawn on it,
// and — when asked — a notes page after each page with circles: every
// circle's number, colour (and what the colour means in this plan), title
// and comments.
//
// This module decides what goes in (live pages in the app's order, live
// circles of the chosen colours, live comments that say something) and lays
// out the notes as HTML; the export worker (render/export-worker.ts) makes
// the PDF in a process of its own, as page renders are made. One export runs
// at a time: a big plan holds a few hundred MB while it's being put together.
//
// The server exports what it has: the device saves its pending changes
// first (DownloadPdfDialog), so the PDF matches what the owner sees.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CIRCLE_COLOR_ORDER, CIRCLE_COLORS } from "../shared/constants";
import { legendOf, pdfFileName } from "../shared/labels";
import { comparePages } from "../shared/order";
import type { CircleColor, CircleRow, CommentRow, PageRow, PlanRow } from "../shared/types";
import type { ServerConfig } from "./config";
import type { Db } from "./db";
import { HttpError, isId, isRecord, MSG } from "./http";
import type { ExportCircle, ExportJob, ExportSheet } from "./render/protocol";
import { runWorker, WorkerCrashError, WorkerTimeoutError } from "./render/run-worker";
import { circlesOfPlan, commentsOfPlan, getSource, pagesOfPlan } from "./repo";
import { freeBytes, isStorageFull } from "./storage";

export interface ExportOptions {
  pageIds: string[];
  /** Colours whose circles go in. */
  colors: ReadonlySet<CircleColor>;
  notes: boolean;
  /** An IANA time zone Intl knows (else UTC). */
  timeZone: string;
}

export const EXPORT_MSG = {
  noPages: "Choose at least one page to download.",
  pagesGone: "Those pages were deleted, so there's nothing to download.",
  tooBig: "That's too much for one PDF. Choose fewer pages and download them in parts.",
  busy: "Other PDFs are being made right now. Try again in a minute.",
  failed: "The PDF couldn't be made. Try again; if it keeps failing, choose fewer pages.",
  timeout: "The PDF took too long to make. Choose fewer pages and download them in parts.",
  storageFull: "The app's storage is too full to make this PDF. Add more storage (the setup guide explains how), then try again.",
} as const;

/** The uploaded originals one PDF may draw on, together (the worker needs a few times this in memory). */
export const MAX_EXPORT_SOURCE_BYTES = 400 * 1024 * 1024;
/** Exports waiting for the one being made; more are turned away. */
const MAX_WAITING = 3;

/** The request body, checked (400 for anything malformed). */
export function parseExportRequest(body: unknown): ExportOptions {
  if (!isRecord(body) || !Array.isArray(body.pageIds) || body.pageIds.length > 10_000 || !body.pageIds.every(isId)) throw new HttpError(400, MSG.badRequest);
  const pageIds = [...new Set(body.pageIds as string[])];
  if (pageIds.length === 0) throw new HttpError(400, EXPORT_MSG.noPages);
  let colors: ReadonlySet<CircleColor> = new Set(CIRCLE_COLOR_ORDER);
  if (body.colors !== undefined) {
    if (!Array.isArray(body.colors)) throw new HttpError(400, MSG.badRequest);
    colors = new Set(CIRCLE_COLOR_ORDER.filter((c) => (body.colors as unknown[]).includes(c)));
  }
  if (body.notes !== undefined && typeof body.notes !== "boolean") throw new HttpError(400, MSG.badRequest);
  return { pageIds, colors, notes: body.notes !== false, timeZone: knownTimeZone(body.timeZone) };
}

function knownTimeZone(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return v;
  } catch {
    return "UTC";
  }
}

// ── one at a time ────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING) throw new HttpError(429, EXPORT_MSG.busy);
  waiting++;
  const run = queue.then(
    () => {
      waiting--;
      return work();
    },
    () => {
      waiting--;
      return work();
    },
  );
  queue = run.catch(() => {});
  return run;
}

// ── what goes in ─────────────────────────────────────────────────────────

/** "#c21f1f" → [0.76, 0.12, 0.12] */
function hexRgb(hex: string): [number, number, number] {
  const v = /^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000";
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** "rgba(194, 31, 31, 0.12)" → colour and opacity */
function rgba(css: string): { rgb: [number, number, number]; alpha: number } {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(css);
  if (!m) return { rgb: [0, 0, 0], alpha: 0.1 };
  return { rgb: [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255], alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

function exportCircle(c: CircleRow): ExportCircle {
  const pal = CIRCLE_COLORS[c.color] ?? CIRCLE_COLORS.gold;
  const fill = rgba(pal.fill);
  return { x: c.x, y: c.y, r: c.r, num: c.num, stroke: hexRgb(pal.stroke), fill: fill.rgb, alpha: fill.alpha };
}

/** The colour's swatch in the notes: solid, as it reads on paper. */
const NOTE_SWATCH: Record<CircleColor, string> = { gold: "#fee000", black: "#000000", red: "#c21f1f", blue: "#1f4e99", green: "#1f7a3a" };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Comments edited more than a minute after they were written say so (as in the app). */
const wasEdited = (m: CommentRow) => m.updatedAt - m.createdAt > 60_000;

export interface NotesInput {
  plan: Pick<PlanRow, "name"> & Partial<PlanRow>;
  page: Pick<PageRow, "label">;
  /** The page's place in the plan (1-based) and the plan's page count. */
  position: number;
  pageCount: number;
  /** In number order. */
  circles: { circle: CircleRow; comments: CommentRow[] }[];
  timeZone: string;
}

/**
 * One page's notes, as HTML for mupdf's layout engine (which knows a subset
 * of CSS: no inline padding, borders on blocks and table cells only, no page
 * break rules — hence a table, one row per circle). The worker draws the
 * Kilowatt Events lockup in the top margin left free here.
 */
export function notesHtml({ plan, page, position, pageCount, circles, timeZone }: NotesInput): string {
  const when = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const zone = timeZone === "UTC" ? " UTC" : "";
  const nComments = circles.reduce((k, x) => k + x.comments.length, 0);
  const rows = circles
    .map(({ circle: c, comments }) => {
      const color = CIRCLE_COLORS[c.color] ? c.color : "gold";
      const meaning = legendOf(plan, color).trim();
      const head = `<p class="hd"><span style="background-color:${NOTE_SWATCH[color]}">&#160;&#160;&#160;&#160;</span>&#160; <b>${esc(CIRCLE_COLORS[color].label)}</b>${meaning ? ` · ${esc(meaning)}` : ""}</p>`;
      const title = c.title.trim() ? `<p class="title">${esc(c.title.trim())}</p>` : "";
      const list = comments.length
        ? comments
            .map((m) => `<p class="meta">${esc(when.format(m.createdAt))}${zone}${wasEdited(m) ? " · edited" : ""}</p><p class="body">${esc(m.body.trim())}</p>`)
            .join("")
        : `<p class="none">No comments</p>`;
      return `<tr><td class="n"><span class="badge">&#160;${c.num > 0 ? c.num : "•"}&#160;</span></td><td class="c">${head}${title}${list}</td></tr>`;
    })
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
@page { margin: 64pt 54pt 48pt 54pt; }
body { font-family: sans-serif; font-size: 10pt; color: #1a1a1a; }
.top { border-top: 2pt solid #000; padding-top: 7pt; margin: 0 0 8pt 0; }
h1 { font-size: 15pt; font-weight: bold; margin: 0; }
.sub { color: #555; margin: 3pt 0 0 0; }
table { border-collapse: collapse; width: 100%; }
td { vertical-align: top; border-top: 0.75pt solid #d9d9d9; padding: 7pt 0 7pt 0; }
td.n { width: 40pt; }
.badge { background-color: #000; color: #fee000; font-weight: bold; }
.hd { margin: 0; }
.title { font-weight: bold; margin: 3pt 0 0 0; }
.meta { color: #6b6b6b; font-size: 8.5pt; margin: 5pt 0 0 0; }
.body { white-space: pre-wrap; margin: 1pt 0 0 0; }
.none { color: #6b6b6b; font-style: italic; margin: 4pt 0 0 0; }
</style></head><body>
<div class="top"><h1>${esc(page.label)}</h1><p class="sub">${esc(plan.name)} · Notes for page ${position} of ${pageCount} · ${plural(circles.length, "circle")} · ${plural(nComments, "comment")}</p></div>
<table>${rows}</table>
</body></html>`;
}

// ── the export ───────────────────────────────────────────────────────────

export interface ExportResult {
  /** The PDF, in DATA_DIR/tmp: the caller sends it, then removes it. */
  file: string;
  bytes: number;
  pages: number;
  /** For Content-Disposition. */
  fileName: string;
}

export interface ExportDeps {
  db: Db;
  config: Pick<ServerConfig, "dataDir" | "clientDir" | "minFreeBytes" | "exportTimeoutMs">;
}

export function exportPlanPdf(deps: ExportDeps, plan: PlanRow, opts: ExportOptions): Promise<ExportResult> {
  // checked before waiting in line: a mistake is reported at once
  const job = buildJob(deps, plan, opts);
  return oneAtATime(() => run(deps, job.job, job.fileName));
}

function buildJob({ db, config }: ExportDeps, plan: PlanRow, opts: ExportOptions): { job: ExportJob; fileName: string } {
  const live = pagesOfPlan(db, plan.id)
    .filter((p) => p.deletedAt === null)
    .sort(comparePages);
  const wanted = new Set(opts.pageIds);
  const pages = live.filter((p) => wanted.has(p.id));
  if (pages.length === 0) throw new HttpError(409, EXPORT_MSG.pagesGone);
  const pageIds = new Set(pages.map((p) => p.id));

  const circles = circlesOfPlan(db, plan.id).filter((c) => c.deletedAt === null && pageIds.has(c.pageId) && opts.colors.has(c.color));
  const circleIds = new Set(circles.map((c) => c.id));
  const commentsBy = new Map<string, CommentRow[]>();
  for (const m of commentsOfPlan(db, plan.id)) {
    if (m.deletedAt !== null || !circleIds.has(m.circleId) || m.body.trim() === "") continue;
    const list = commentsBy.get(m.circleId);
    if (list) list.push(m);
    else commentsBy.set(m.circleId, [m]);
  }
  const circlesBy = new Map<string, CircleRow[]>();
  for (const c of circles.sort((a, b) => a.num - b.num || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const list = circlesBy.get(c.pageId);
    if (list) list.push(c);
    else circlesBy.set(c.pageId, [c]);
  }

  // the originals: how much there is to read decides whether it can be done
  const files = new Map<string, { file: string; kind: "pdf" | "image"; size: number }>();
  for (const p of pages) {
    if (files.has(p.sourceId)) continue;
    const source = getSource(db, p.sourceId);
    const file = path.join(config.dataDir, "uploads", `${p.sourceId}.${source?.ext ?? "pdf"}`);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* missing: a placeholder page says so */
    }
    files.set(p.sourceId, { file, kind: source?.kind === "image" ? "image" : "pdf", size });
  }
  const sourceBytes = [...files.values()].reduce((k, f) => k + f.size, 0);
  if (sourceBytes > MAX_EXPORT_SOURCE_BYTES) throw new HttpError(413, EXPORT_MSG.tooBig);
  // the PDF is about as big as the originals it draws on
  if (freeBytes(config.dataDir) < config.minFreeBytes + sourceBytes) throw new HttpError(507, EXPORT_MSG.storageFull);

  const sheets: ExportSheet[] = pages.map((p) => {
    const f = files.get(p.sourceId)!;
    const list = circlesBy.get(p.id) ?? [];
    const withNotes = opts.notes && list.length > 0;
    return {
      label: p.label,
      file: f.file,
      kind: f.kind,
      sourceId: p.sourceId,
      index: p.sourceIndex,
      circles: list.map(exportCircle),
      notesHtml: withNotes
        ? notesHtml({
            plan,
            page: p,
            position: live.indexOf(p) + 1,
            pageCount: live.length,
            circles: list.map((c) => ({ circle: c, comments: commentsBy.get(c.id) ?? [] })),
            timeZone: opts.timeZone,
          })
        : null,
      missingText: `“${p.label}” couldn't be read from the file it was uploaded in, so it isn't in this PDF.${withNotes ? " Its circles are listed on the next page." : ""}`,
    };
  });
  const logo = path.join(config.clientDir, "brand", "lockup-black.png");
  return {
    job: { title: plan.name, logoFile: fs.existsSync(logo) ? logo : null, sheets },
    fileName: pdfFileName(plan.name, pages.length === 1 ? pages[0].label : null),
  };
}

async function run({ config }: ExportDeps, job: ExportJob, fileName: string): Promise<ExportResult> {
  const tmp = path.join(config.dataDir, "tmp");
  const id = randomUUID();
  const jobFile = path.join(tmp, `export-${id}.json`);
  const outFile = path.join(tmp, `export-${id}.pdf`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(jobFile, JSON.stringify(job));
  } catch (e) {
    fs.rmSync(jobFile, { force: true });
    if (isStorageFull(e)) throw new HttpError(507, EXPORT_MSG.storageFull);
    throw e;
  }
  try {
    const m = await runWorker({ task: "export", jobFile, outFile }, { timeoutMs: config.exportTimeoutMs }).promise;
    if (m.type === "exported") return { file: outFile, bytes: m.bytes, pages: m.pages, fileName };
    fs.rmSync(outFile, { force: true });
    if (m.type === "error" && m.code === "nospace") throw new HttpError(507, EXPORT_MSG.storageFull);
    throw new ExportFailed(m.type === "error" ? m.message : `unexpected answer: ${m.type}`);
  } catch (e) {
    fs.rmSync(outFile, { force: true });
    if (e instanceof HttpError || e instanceof ExportFailed) throw e;
    if (e instanceof WorkerTimeoutError) throw new HttpError(500, EXPORT_MSG.timeout);
    // killed: almost always out of memory — too much at once
    if (e instanceof WorkerCrashError) throw new HttpError(500, EXPORT_MSG.tooBig);
    throw e;
  } finally {
    fs.rmSync(jobFile, { force: true });
  }
}

/** The worker couldn't make the PDF: logged by the route, the owner sees EXPORT_MSG.failed. */
export class ExportFailed extends Error {}
