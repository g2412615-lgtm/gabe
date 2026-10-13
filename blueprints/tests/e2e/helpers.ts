// Shared pieces of the browser tests for the real app (tests/e2e/app.spec.ts):
//
//  - the global setup (this module's default export, named in
//    playwright.config.ts): sample PDFs, then the BUILT server on a free port
//    with an empty temporary data folder; it's stopped and the folder
//    deleted when the run ends;
//  - `test`: Playwright's test with baseURL pointed at that server;
//  - helpers to sign in, upload, read a plan back from the API, find things
//    on screen, and press / tap / drag the way the project's device does
//    (mouse on "desktop", finger on "ipad").

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { CircleRow, CommentRow, PageRow, PlanDoc, PlanSummary } from "../../src/shared/types";

export { expect };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = path.join(ROOT, "tests/fixtures/out");
export const fixture = (name: string) => path.join(FIXTURES, name);

const ENV_URL = "BPN_E2E_BASE_URL";
const ENV_PASSWORD = "BPN_E2E_PASSWORD";
const ENV_SETUP_ERROR = "BPN_E2E_SETUP_ERROR";

// ── global setup ─────────────────────────────────────────────────────────

function ensureFixtures() {
  const needed = ["event-plan.pdf", "suite-level.pdf"];
  if (needed.every((f) => fs.existsSync(fixture(f)))) return;
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "fixtures"], { cwd: ROOT, stdio: "inherit" });
  for (const f of needed) if (!fs.existsSync(fixture(f))) throw new Error(`npm run fixtures didn't make tests/fixtures/out/${f}`);
}

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

async function waitForHealth(url: string, child: ChildProcess, log: () => string, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The server exited (${child.exitCode ?? child.signalCode}) before it was up:\n${log()}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`The server didn't answer /api/health within ${timeoutMs} ms:\n${log()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = setTimeout(() => child.kill("SIGKILL"), 12_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts `node dist/server/index.js` for the run and returns the teardown.
 * With E2E_BASE_URL set, uses that server instead (E2E_PASSWORD, default
 * "test") and starts nothing.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  ensureFixtures();

  if (process.env.E2E_BASE_URL) {
    process.env[ENV_URL] = process.env.E2E_BASE_URL.replace(/\/+$/, "");
    process.env[ENV_PASSWORD] = process.env.E2E_PASSWORD || "test";
    return async () => {};
  }

  const entry = path.join(ROOT, "dist/server/index.js");
  const clientIndex = path.join(ROOT, "dist/client/index.html");
  if (!fs.existsSync(entry) || !fs.existsSync(clientIndex)) {
    // Don't stop the whole run: canvas.spec.ts needs no server. The app tests fail with this.
    process.env[ENV_SETUP_ERROR] = "The app tests drive the built app: run `npm run build` first (dist/ is missing).";
    console.warn(`[e2e] ${process.env[ENV_SETUP_ERROR]}`);
    return async () => {};
  }
  const builtAt = Math.min(fs.statSync(entry).mtimeMs, fs.statSync(clientIndex).mtimeMs);
  if (newestMtime(path.join(ROOT, "src")) > builtAt) console.warn("[e2e] src/ changed since the last `npm run build` — these tests run the built app in dist/.");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bpn-e2e-"));
  const port = await freePort();
  const password = `e2e-${crypto.randomBytes(6).toString("hex")}`;
  const url = `http://127.0.0.1:${port}`;

  let output = "";
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_PASSWORD: password,
      APP_PASSWORD_HASH: "",
      SESSION_SECRET: "",
      FLY_APP_NAME: "",
      TRUST_PROXY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (b: Buffer) => {
    output += b.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);

  try {
    await waitForHealth(url, child, () => output);
  } catch (e) {
    await stop(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }

  // Workers start after this and inherit these.
  process.env[ENV_URL] = url;
  process.env[ENV_PASSWORD] = password;

  return async () => {
    await stop(child);
    // the server's own log, for looking into a failure
    fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "test-results/e2e-server.log"), output);
    if (process.env.E2E_KEEP_DATA) console.log(`[e2e] server data kept in ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  };
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

// ── the test object ──────────────────────────────────────────────────────

export function appBaseURL(): string {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(process.env[ENV_SETUP_ERROR] ?? "No test server: run the browser tests with `npx playwright test` (its global setup starts one).");
  return url;
}
export const appPassword = () => process.env[ENV_PASSWORD] ?? "test";

export const test = base.extend<{ failOnPageErrors: void }>({
  baseURL: async ({}, use) => {
    await use(appBaseURL());
  },
  // An uncaught exception in the page fails the test, even when the screen looked right.
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
      await use();
      expect(errors, "uncaught errors in the page").toEqual([]);
    },
    { auto: true },
  ],
});

/** The project emulates a touch screen (the "ipad" project). */
export const isTouch = (info: TestInfo) => !!info.project.use.hasTouch;

/** A plan name no other test (or project, or retry) uses. */
export const uniqueName = (what: string, info: TestInfo) => `${what} · ${info.project.name} · ${Date.now().toString(36)}${info.retry ? ` r${info.retry}` : ""}`;

// ── API (shares the page's cookies) ──────────────────────────────────────

export async function signInByApi(page: Page) {
  const res = await page.request.post("/api/login", { data: { password: appPassword() } });
  expect(res.ok(), `sign in: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Uploads a fixture as a new plan and returns its id. */
export async function uploadByApi(page: Page, file: string, name: string): Promise<string> {
  const res = await page.request.post(`/api/plans/upload?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file)}`, {
    data: fs.readFileSync(fixture(file)),
    headers: { "Content-Type": "application/pdf" },
  });
  expect(res.ok(), `upload ${file}: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { plan: { id: string } }).plan.id;
}

export async function getPlan(page: Page, planId: string): Promise<PlanDoc> {
  const res = await page.request.get(`/api/plans/${planId}`);
  expect(res.ok(), `GET plan: ${res.status()}`).toBe(true);
  return (await res.json()) as PlanDoc;
}

export async function getPlanSummary(page: Page, planId: string): Promise<PlanSummary | undefined> {
  const res = await page.request.get("/api/plans");
  return ((await res.json()) as { plans: PlanSummary[] }).plans.find((p) => p.id === planId);
}

export const livePages = (doc: PlanDoc): PageRow[] => doc.pages.filter((p) => p.deletedAt === null).sort((a, b) => a.sortOrder - b.sortOrder);
export const liveCircles = (doc: PlanDoc): CircleRow[] => doc.circles.filter((c) => c.deletedAt === null);
export const liveComments = (doc: PlanDoc, circleId?: string): CommentRow[] =>
  doc.comments.filter((c) => c.deletedAt === null && (!circleId || c.circleId === circleId)).sort((a, b) => a.createdAt - b.createdAt);

/** Every page of the plan has been prepared (fully: tiles too). */
export async function waitPagesReady(page: Page, planId: string, timeout = 90_000): Promise<PageRow[]> {
  let pages: PageRow[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/plans/${planId}/pages`);
        pages = ((await res.json()) as { pages: PageRow[] }).pages;
        return pages.map((p) => p.status).join(",");
      },
      { timeout, intervals: [250, 500, 1000] },
    )
    .toMatch(/^(ready)(,ready)*$/);
  return pages.filter((p) => p.deletedAt === null).sort((a, b) => a.sortOrder - b.sortOrder);
}

// ── the editor on screen ─────────────────────────────────────────────────

export function editor(page: Page) {
  const sidebar = page.getByRole("complementary", { name: "Pages and notes" });
  const panel = page.getByRole("complementary", { name: "Circle comments" });
  return {
    header: page.getByRole("banner"),
    /** The page switcher: "‹ Page 2 of 4 · P-1 ›". */
    pager: page.getByRole("group", { name: "Page", exact: true }),
    nextPage: page.getByRole("button", { name: "Next page" }),
    prevPage: page.getByRole("button", { name: "Previous page" }),
    moveMode: page.getByRole("group", { name: "What a tap on the blueprint does" }).getByRole("button", { name: "Move" }),
    circleMode: page.getByRole("group", { name: "What a tap on the blueprint does" }).getByRole("button", { name: "Circle" }),
    headerUndo: page.getByRole("group", { name: "Undo and redo" }).getByRole("button", { name: "Undo" }),
    saveStatus: page.locator(".ed-header .save-status"),
    sidebar,
    /** One <li> per page in the Pages tab. */
    pageItems: sidebar.getByRole("list").first().getByRole("listitem"),
    /** The ⋯ menu of the page labelled `label` (its accessible name carries the exact label). */
    pageMenu: (label: string) => sidebar.getByRole("button", { name: `More for “${label}”`, exact: true }),
    /** The button that opens the page labelled `label`. */
    pageButton: (label: string) =>
      sidebar
        .getByRole("listitem")
        .filter({ has: page.getByRole("button", { name: `More for “${label}”`, exact: true }) })
        .getByRole("button")
        .first(),
    addPagesInput: sidebar.locator('input[type="file"]'),
    canvas: page.locator(".bp-canvas"),
    preview: page.locator(".bp-canvas img.bp-preview"),
    sheet: page.locator(".bp-canvas .bp-sheet"),
    circles: page.locator(".bp-canvas .bp-anno"),
    panel,
    panelTitle: panel.getByRole("heading", { level: 2 }),
    comments: panel.getByRole("region", { name: "Comments" }).getByRole("listitem"),
    /** Just the text of each comment (no time or Edit/Delete). */
    commentBodies: panel.getByRole("region", { name: "Comments" }).getByRole("listitem").locator(".cp-body"),
    composer: panel.getByRole("textbox", { name: "Add a comment" }),
    addComment: panel.getByRole("button", { name: "Add", exact: true }),
    deleteCircle: panel.getByRole("button", { name: "Delete circle" }),
    toast: (text: string | RegExp) => page.getByRole("status").locator(".toast").filter({ hasText: text }),
  };
}
export type Editor = ReturnType<typeof editor>;

export async function openEditor(page: Page, planId: string) {
  await page.goto(`/plans/${planId}`);
  await waitCanvas(page);
}

/** The blueprint is drawn: its preview image has loaded and the sheet holds still. */
export async function waitCanvas(page: Page) {
  const ed = editor(page);
  await expect(ed.preview).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => ed.preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
  await stableBox(ed.sheet);
}

/** The pill says "Saved" (every change reached the server). */
export async function expectSaved(page: Page, timeout = 20_000) {
  await expect(editor(page).saveStatus).toHaveAccessibleName(/^Saved\b/, { timeout });
}

/** A locator's box once it stops moving (an animation or a layout shift has settled). */
export async function stableBox(loc: Locator, timeout = 10_000) {
  let last = "";
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(
      async () => {
        box = await loc.boundingBox();
        const key = JSON.stringify(box);
        const same = !!box && key === last;
        last = key;
        return same;
      },
      { timeout, intervals: [50, 100, 100, 150] },
    )
    .toBe(true);
  return box!;
}

export type Pt = { x: number; y: number };

/** A point on the blueprint sheet, as fractions of its width and height → page px. */
export async function sheetPoint(page: Page, fx: number, fy: number): Promise<Pt> {
  const b = await stableBox(editor(page).sheet);
  return { x: Math.round(b.x + fx * b.width), y: Math.round(b.y + fy * b.height) };
}

/** Centre of an element on screen. */
export async function centreOf(loc: Locator): Promise<Pt> {
  const b = await stableBox(loc);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

// ── input: mouse on desktop, a finger on the iPad ────────────────────────

/** Click (mouse) or tap (touch) a control. */
export async function press(loc: Locator, info: TestInfo) {
  if (isTouch(info)) await loc.tap();
  else await loc.click();
}

/** Click or tap a point (e.g. on the blueprint). */
export async function pressAt(page: Page, p: Pt, info: TestInfo) {
  if (isTouch(info)) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/** Drag from one point to another with the mouse, or with one finger (CDP touch events). */
export async function dragFromTo(page: Page, from: Pt, to: Pt, info: TestInfo, steps = 10) {
  const at = (i: number) => ({ x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps) });
  if (!isTouch(info)) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(at(i).x, at(i).y);
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const point = (p: Pt) => [{ id: 1, x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1 }];
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(at(i)) });
      // one move per frame, like a finger
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}
