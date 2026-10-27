// Messages between the server and a render worker process (types only — the
// worker runs as plain .ts under Node's type stripping in development and
// tests, so it may import nothing local at runtime).

export type WorkerTask =
  /** Open an uploaded PDF: page count, password check, default page names. */
  | { task: "inspect"; file: string; maxPages: number }
  /** Render one page to preview.webp, thumb.webp and deep-zoom tiles under `outDir`. */
  | { task: "render"; file: string; kind: "pdf" | "image"; pageIndex: number; outDir: string; workDir: string }
  /** Make a "Download PDF" file: the job (an ExportJob, as JSON — too big for a command line) is in `jobFile`; the PDF goes to `outFile`. */
  | { task: "export"; jobFile: string; outFile: string };

export type WorkerMessage =
  | {
      type: "inspected";
      pageCount: number;
      needsPassword: boolean;
      /** Per page: the PDF's page label (when not just a number) or its bookmark title, else null. Empty when pageCount > maxPages. */
      labels: (string | null)[];
    }
  /** preview.webp and thumb.webp are on disk: the page can be shown now. */
  | { type: "preview"; width: number; height: number; previewW: number; previewH: number }
  | { type: "done"; tileSize: number; maxLevel: number; minLevel: number; tileFormat: "png" | "jpeg" }
  /** The PDF is in outFile. */
  | { type: "exported"; pages: number; bytes: number }
  /** "nospace": a write failed because the disk is full. */
  | { type: "error"; code: "corrupt" | "failed" | "nospace"; message: string };

export type FinalMessage = Extract<WorkerMessage, { type: "inspected" | "done" | "exported" | "error" }>;

/**
 * Everything the export worker needs, worked out by the server (src/server/export.ts):
 * the worker reads no database and imports nothing local, so colours, sizes
 * and the notes pages' HTML all arrive ready-made.
 */
export interface ExportJob {
  /** The PDF's title (the event plan's name). */
  title: string;
  /** The Kilowatt Events lockup (PNG) drawn at the top of every notes page; null: none. */
  logoFile: string | null;
  /** In order. */
  sheets: ExportSheet[];
}

export interface ExportSheet {
  /** The page's name: its bookmark and page label in the PDF. */
  label: string;
  /** The uploaded original. */
  file: string;
  kind: "pdf" | "image";
  /** Pages from the same file are copied from one opening of it. */
  sourceId: string;
  /** 0-based page of `file`. */
  index: number;
  circles: ExportCircle[];
  /** The notes pages that follow this sheet (an HTML document laid out by mupdf); null: none. */
  notesHtml: string | null;
  /** Shown on a placeholder page if the original can't be read. */
  missingText: string;
}

/** A circle as the app stores it (fractions of the page as shown), with its colour resolved. */
export interface ExportCircle {
  x: number;
  y: number;
  /** Fraction of the page's long side. */
  r: number;
  num: number;
  /** Outline, 0–1 RGB. */
  stroke: [number, number, number];
  /** Fill, 0–1 RGB, laid over the paper at `alpha`. */
  fill: [number, number, number];
  alpha: number;
}
