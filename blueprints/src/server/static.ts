// Serves the built single-page app (dist/client). Hashed bundles under
// /assets/ never change, so browsers keep them for a year; index.html is
// revalidated every time so a deploy takes effect on the next load. Any
// other path that isn't a file gets index.html (the client router decides).

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

/** The file under `root` for a URL path, or null (no traversal, no dotfiles, must be a regular file). */
function resolveFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (!rel || rel.split("/").some((seg) => seg.startsWith(".") || seg === "")) return null;
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** A file as a web stream (the Node adapter pipes it out without buffering). */
export function fileStream(file: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
}

function sendFile(c: Context, file: string, headers: Record<string, string>): Response {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const h = new Headers({ "Content-Type": type, "Content-Length": String(stat.size), "X-Content-Type-Options": "nosniff", ...headers });
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: h });
  return new Response(fileStream(file), { status: 200, headers: h });
}

export function serveClient(clientDir: string) {
  const root = path.resolve(clientDir);
  const indexFile = path.join(root, "index.html");
  return (c: Context): Response => {
    const urlPath = new URL(c.req.url).pathname;
    const file = urlPath === "/" ? null : resolveFile(root, urlPath);
    if (file && file !== indexFile) {
      const immutable = urlPath.startsWith("/assets/");
      return sendFile(c, file, { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
    }
    // A missing hashed bundle must not come back as HTML (the browser would try to run it).
    if (urlPath.startsWith("/assets/")) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (!fs.existsSync(indexFile)) {
      return new Response("KWE Blueprints hasn't been built yet. Run npm run build.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return sendFile(c, indexFile, { "Cache-Control": "no-cache", ...HTML_SECURITY_HEADERS });
  };
}
