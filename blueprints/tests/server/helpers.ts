// Shared helpers for the server tests: sample files, a real server on a
// random port with its own temp DATA_DIR, and a small HTTP client that keeps
// the session cookie.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from "pdf-lib";
import { startServer, type RunningServer } from "../../src/server/app";
import type { ServerConfig } from "../../src/server/config";
import { silentLogger } from "../../src/server/log";
import type { UploadResponse } from "../../src/shared/types";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../fixtures/out");
const FIXTURE_FILES = ["event-plan.pdf", "suite-level.pdf", "warehouse.png", "corrupt.pdf"];

export const PASSWORD = "correct horse battery";

/**
 * Make sure tests/fixtures/out exists (npm run fixtures). Test files run in
 * parallel, so generation is guarded by a lock directory (mkdir is atomic).
 */
export function ensureFixtures() {
  const ready = () => FIXTURE_FILES.every((f) => fs.existsSync(path.join(FIXTURES, f)));
  if (ready()) return;
  const lock = path.join(os.tmpdir(), "bpn-fixtures.lock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      if (ready()) return;
      if (Date.now() > deadline) throw new Error("timed out waiting for the fixtures lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    if (!ready()) execFileSync(process.execPath, [path.resolve(here, "../fixtures/make-fixtures.mjs")], { stdio: "inherit" });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

export function tempDir(prefix = "bpn-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestServer extends RunningServer {
  dataDir: string;
  stop(): Promise<void>;
}

export async function startTestServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dataDir = overrides.dataDir ?? tempDir();
  const running = await startServer({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    clientDir: path.join(dataDir, "no-client"),
    password: PASSWORD,
    sessionSecret: "test-secret-test-secret-test-secret-0000",
    env: "test",
    maintenance: false,
    log: silentLogger,
    ...overrides,
  });
  return {
    ...running,
    url: `http://127.0.0.1:${running.port}`,
    dataDir,
    async stop() {
      await running.shutdown(2_000);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  json: T;
  text: string;
}

/** A tiny client: remembers the session cookie and parses JSON replies. */
export class Client {
  cookie = "";
  constructor(readonly base: string) {}

  async req<T = any>(method: string, p: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(this.base + p, { method, headers, body, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = /bpn_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `bpn_session=${m[1]}` : "";
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  get = <T = any>(p: string, headers?: Record<string, string>) => this.req<T>("GET", p, { headers });
  post = <T = any>(p: string, json: unknown = {}, headers?: Record<string, string>) => this.req<T>("POST", p, { json, headers });
  patch = <T = any>(p: string, json: unknown, headers?: Record<string, string>) => this.req<T>("PATCH", p, { json, headers });

  async login(password = PASSWORD) {
    return this.post("/api/login", { password });
  }

  upload(bytes: Uint8Array, opts: { filename?: string; name?: string; type?: string; planId?: string } = {}) {
    const q = new URLSearchParams({ filename: opts.filename ?? "blueprint.pdf" });
    if (opts.name !== undefined) q.set("name", opts.name);
    const p = opts.planId ? `/api/plans/${opts.planId}/files?${q}` : `/api/plans/upload?${q}`;
    // error replies carry `{ error }` instead
    return this.req<UploadResponse & { error?: string }>("POST", p, {
      body: bytes as unknown as BodyInit,
      headers: { "content-type": opts.type ?? "application/pdf" },
    });
  }
}

export async function signedInClient(server: TestServer): Promise<Client> {
  const c = new Client(server.url);
  const r = await c.login();
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return c;
}

/** Poll until `fn` returns a truthy value. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000, everyMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * A small PDF made on the fly: `pages` sheets of `size` points, optional page
 * labels (/PageLabels) and bookmarks (/Outlines: { title, page }).
 */
export async function makePdf(opts: { pages?: number; size?: [number, number]; labels?: string[]; bookmarks?: { title: string; page: number }[] } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const n = opts.pages ?? 2;
  const pages = Array.from({ length: n }, (_, i) => {
    const page = pdf.addPage(opts.size ?? [360, 240]);
    page.drawRectangle({ x: 10, y: 10, width: page.getWidth() - 20, height: page.getHeight() - 20, borderColor: rgb(0.1, 0.1, 0.2), borderWidth: 1 });
    page.drawText(`Test sheet ${i + 1}`, { x: 24, y: 24, size: 12, font });
    return page;
  });
  if (opts.labels) {
    const nums: unknown[] = [];
    opts.labels.forEach((l, i) => nums.push(PDFNumber.of(i), pdf.context.obj({ P: PDFString.of(l) })));
    pdf.catalog.set(PDFName.of("PageLabels"), pdf.context.obj({ Nums: nums as never }));
  }
  if (opts.bookmarks?.length) {
    const root = pdf.context.nextRef();
    const refs = opts.bookmarks.map(() => pdf.context.nextRef());
    opts.bookmarks.forEach((b, i) => {
      const dict: Record<string, unknown> = {
        Title: PDFString.of(b.title),
        Parent: root,
        Dest: pdf.context.obj([pages[b.page].ref, PDFName.of("Fit")]),
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < refs.length - 1) dict.Next = refs[i + 1];
      pdf.context.assign(refs[i], pdf.context.obj(dict as never));
    });
    pdf.context.assign(root, pdf.context.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(refs.length) }));
    pdf.catalog.set(PDFName.of("Outlines"), root);
  }
  return Buffer.from(await pdf.save());
}
