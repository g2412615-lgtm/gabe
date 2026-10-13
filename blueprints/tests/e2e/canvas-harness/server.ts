// A Vite dev server for the canvas harness page, serving a real rendered
// fixture page under the app's asset URL shape (/api/pages/:id/:key/…).
// Tests can slow down tile responses and see which tiles were requested.

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { renderFixturePage, type RenderedPage } from "./tiles";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

export interface Harness {
  /** The harness page; add a query string for options (status=preview, inset=340, select=c1, mode=add, view={…}, empty=1). */
  url: string;
  meta: RenderedPage;
  /** Tile requests seen so far ("level/col_row"). */
  tileRequests: string[];
  /** Delay tile responses of one level (or all levels when `level` is omitted). 0 = off. */
  setTileDelay(ms: number, level?: number): void;
  close(): Promise<void>;
}

async function ensureFixture(): Promise<string> {
  const pdf = path.join(root, "tests/fixtures/out/event-plan.pdf");
  if (!fs.existsSync(pdf)) await import(path.join(root, "tests/fixtures/make-fixtures.mjs"));
  return pdf;
}

/** A free TCP port (Vite reads port 0 as "use the default 5173", which the dev server may hold). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function startHarness(): Promise<Harness> {
  const meta = await renderFixturePage(await ensureFixture(), 0);
  const tileRequests: string[] = [];
  let delay = { ms: 0, level: -1 };

  const send = (res: ServerResponse, file: string, type: string) => {
    fs.readFile(file, (err, body) => {
      if (err) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.end(body);
    });
  };

  const assets = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/__canvas/page.json") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(meta));
      return;
    }
    let m = /^\/api\/pages\/[\w-]+\/[\w-]+\/preview\.webp$/.exec(url);
    if (m) return send(res, path.join(meta.dir, "preview.webp"), "image/webp");
    m = /^\/api\/pages\/[\w-]+\/[\w-]+\/tiles\/(\d+)\/(\d+)_(\d+)\.png$/.exec(url);
    if (m) {
      const [, level, col, row] = m;
      tileRequests.push(`${level}/${col}_${row}`);
      const wait = delay.ms > 0 && (delay.level < 0 || delay.level === Number(level)) ? delay.ms : 0;
      setTimeout(() => send(res, path.join(meta.dir, "tiles", level, `${col}_${row}.png`), "image/png"), wait);
      return;
    }
    next();
  };

  const server: ViteDevServer = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    cacheDir: path.join(os.tmpdir(), "bpn-canvas-harness-vite"),
    plugins: [react(), { name: "canvas-harness-assets", configureServer: (s) => void s.middlewares.use(assets) }],
    server: { host: "127.0.0.1", port: await freePort(), strictPort: false, hmr: false, watch: null },
    // Pre-bundle up front: a mid-test "new dependency found, reloading" would break a test.
    optimizeDeps: {
      entries: ["tests/e2e/canvas-harness/main.tsx"],
      include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime"],
    },
  });
  await server.listen();
  const { port } = server.httpServer!.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/tests/e2e/canvas-harness/index.html`,
    meta,
    tileRequests,
    setTileDelay: (ms, level) => {
      delay = { ms, level: level ?? -1 };
    },
    close: () => server.close(),
  };
}
