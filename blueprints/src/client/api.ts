// Thin wrappers around the server API. Every call is same-origin JSON; errors
// carry the server's plain-language message (`{ error }`) so the UI can show
// it as-is. A 401 means the session ended: callers decide what to do (the
// editor keeps unsaved work on the device and offers to sign in again).

import type { DuplicatePageResponse, ExportPdfRequest, PageRow, PlanDoc, PlanRow, PlanSummary, SyncRequest, SyncResponse, UploadResponse } from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
  get signedOut() {
    return this.status === 401;
  }
  /** Worth retrying later (no connection, timeout, server busy or restarting). */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function request<T>(method: string, url: string, body?: unknown, opts: { timeoutMs?: number; keepalive?: boolean } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl.signal,
      keepalive: opts.keepalive,
    });
  } catch {
    throw new ApiError("No connection — your changes are kept on this device.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let msg = "";
  try {
    const j = await res.json();
    msg = typeof j?.error === "string" ? j.error : "";
  } catch {
    /* not JSON */
  }
  return new ApiError(msg || fallbackMessage(res.status), res.status);
}

/** What to say when the server's reply carries no `{ error }`. */
function fallbackMessage(status: number): string {
  return status === 401
    ? "You've been signed out — sign in again to keep working."
    : status === 413
      ? "That file is too large."
      : status >= 500
        ? "The server had a problem — try again in a moment."
        : "That didn't work.";
}

// ── auth ────────────────────────────────────────────────────────────────

export const api = {
  login: (password: string) => request<{ ok: true }>("POST", "/api/login", { password }),
  logout: () => request<{ ok: true }>("POST", "/api/logout", {}),
  me: () => request<{ ok: true }>("GET", "/api/me"),

  // ── plans ──────────────────────────────────────────────────────────────
  listPlans: () => request<{ plans: PlanSummary[] }>("GET", "/api/plans"),
  getPlan: (id: string) => request<PlanDoc>("GET", `/api/plans/${encodeURIComponent(id)}`),
  /** Rename, delete (deleted: true) or restore (deleted: false) a plan from the home page. */
  patchPlan: (id: string, patch: { name?: string; deleted?: boolean }) =>
    request<PlanRow>("PATCH", `/api/plans/${encodeURIComponent(id)}`, patch),
  /** Render status of every page in a plan (polled while pages are being prepared). */
  getPages: (planId: string) => request<{ pages: PageRow[] }>("GET", `/api/plans/${encodeURIComponent(planId)}/pages`),
  retryPage: (pageId: string) => request<{ page: PageRow }>("POST", `/api/pages/${encodeURIComponent(pageId)}/retry`, {}),
  duplicatePage: (pageId: string, body: { id?: string; label?: string }) =>
    request<DuplicatePageResponse>("POST", `/api/pages/${encodeURIComponent(pageId)}/duplicate`, body),
  sync: (planId: string, body: SyncRequest, opts: { keepalive?: boolean } = {}) =>
    request<SyncResponse>("POST", `/api/plans/${encodeURIComponent(planId)}/sync`, body, opts),
};

// ── uploads ─────────────────────────────────────────────────────────────

export interface UploadHandle {
  promise: Promise<UploadResponse>;
  abort: () => void;
}

/**
 * Upload one file with progress (fetch can't report upload progress, XHR can).
 * The body is the raw file; the server streams it to disk.
 *
 *   newPlan: { planName } → creates a plan from the file (POST /api/plans/upload)
 *   addTo:   { planId }   → appends the file's pages to an existing plan (POST /api/plans/:id/files)
 */
export function uploadFile(
  file: File,
  target: { planName: string } | { planId: string },
  onProgress?: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const q = new URLSearchParams({ filename: file.name || "blueprint" });
  let url: string;
  if ("planId" in target) url = `/api/plans/${encodeURIComponent(target.planId)}/files?${q}`;
  else {
    q.set("name", target.planName);
    url = `/api/plans/upload?${q}`;
  }
  const promise = new Promise<UploadResponse>((resolve, reject) => {
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(1, e.loaded / Math.max(1, e.total)));
    };
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && json) resolve(json as UploadResponse);
      else {
        const msg = (json as { error?: string } | null)?.error;
        reject(
          new ApiError(
            msg ||
              (xhr.status === 413
                ? "That file is too large."
                : xhr.status === 401
                  ? "You've been signed out — sign in again to keep working."
                  : "That upload didn't work — try again."),
            xhr.status,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new ApiError("The upload stopped — check the connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

// ── Download PDF ────────────────────────────────────────────────────────

export interface PdfDownload {
  /** The PDF, once it has all arrived. */
  promise: Promise<Blob>;
  abort: () => void;
}

/**
 * Ask the server for a PDF of an event plan's pages with their circles
 * (POST /api/plans/:id/export) and download it here, with progress (XHR:
 * a big plan on venue Wi-Fi takes a while). The server makes the whole PDF
 * before it answers: `onReady` says it has started to arrive.
 */
export function downloadPlanPdf(
  planId: string,
  body: ExportPdfRequest,
  on: { onReady?: () => void; onProgress?: (fraction: number) => void } = {},
): PdfDownload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Blob>((resolve, reject) => {
    xhr.open("POST", `/api/plans/${encodeURIComponent(planId)}/export`);
    xhr.responseType = "blob";
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "application/pdf, application/json");
    let ready = false;
    xhr.onprogress = (e) => {
      if (xhr.status !== 200) return;
      if (!ready) {
        ready = true;
        on.onReady?.();
      }
      if (e.lengthComputable) on.onProgress?.(Math.min(1, e.loaded / Math.max(1, e.total)));
    };
    xhr.onload = async () => {
      if (xhr.status === 200) return resolve(xhr.response as Blob);
      let msg = "";
      try {
        const j = JSON.parse(await (xhr.response as Blob).text());
        msg = typeof j?.error === "string" ? j.error : "";
      } catch {
        /* not JSON */
      }
      reject(new ApiError(msg || fallbackMessage(xhr.status), xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("The download stopped — check the connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Download cancelled.", 0));
    xhr.send(JSON.stringify(body));
  });
  return { promise, abort: () => xhr.abort() };
}

// ── asset URLs ──────────────────────────────────────────────────────────

type AssetPage = Pick<PageRow, "id" | "assetKey">;
export const assetUrl = {
  preview: (p: AssetPage) => `/api/pages/${p.id}/${p.assetKey}/preview.webp`,
  thumb: (p: AssetPage) => `/api/pages/${p.id}/${p.assetKey}/thumb.webp`,
  tile: (p: AssetPage & Pick<PageRow, "tileFormat">, level: number, col: number, row: number) =>
    `/api/pages/${p.id}/${p.assetKey}/tiles/${level}/${col}_${row}.${p.tileFormat === "jpeg" ? "jpeg" : "png"}`,
};

// ── ids ─────────────────────────────────────────────────────────────────

/** A random UUID. crypto.randomUUID needs a secure context (HTTPS or localhost), so fall back for LAN testing. */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
