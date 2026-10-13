// Messages between the server and a render worker process (types only — the
// worker runs as plain .ts under Node's type stripping in development and
// tests, so it may import nothing local at runtime).

export type WorkerTask =
  /** Open an uploaded PDF: page count, password check, default page names. */
  | { task: "inspect"; file: string; maxPages: number }
  /** Render one page to preview.webp, thumb.webp and deep-zoom tiles under `outDir`. */
  | { task: "render"; file: string; kind: "pdf" | "image"; pageIndex: number; outDir: string; workDir: string };

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
  /** "nospace": a write failed because the disk is full. */
  | { type: "error"; code: "corrupt" | "failed" | "nospace"; message: string };

export type FinalMessage = Extract<WorkerMessage, { type: "inspected" | "done" | "error" }>;
