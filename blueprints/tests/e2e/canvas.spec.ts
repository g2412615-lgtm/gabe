// The blueprint canvas, driven for real: a desktop mouse, and an iPad-sized
// touch screen through CDP touch events (one-finger pan, pinch, tap, long
// press, handle drags). Self-contained: it renders a fixture page into deep-
// zoom tiles exactly like the server does and serves the harness page
// (tests/e2e/canvas-harness) from its own Vite server.
//
//   npx playwright test tests/e2e/canvas.spec.ts
//   CANVAS_SHOTS_DIR=/some/dir  → also writes the screenshots there
//   CANVAS_CHROMIUM=/path/chrome → browser binary (default: the sandbox's)

import fs from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";
import { DEFAULT_CIRCLE_SCREEN_R, MAX_CIRCLE_R } from "../../src/shared/constants";
import { fitView, type View } from "../../src/shared/geometry";
import type { CircleRow } from "../../src/shared/types";
import type { HarnessEvent } from "./canvas-harness/main";
import { startHarness, type Harness } from "./canvas-harness/server";

const CHROMIUM = process.env.CANVAS_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (fs.existsSync(CHROMIUM)) test.use({ launchOptions: { executablePath: CHROMIUM } });

let h: Harness;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

// ── helpers ─────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function boot(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(h.url + query);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".bp-preview");
    return !!window.__bp?.canvas?.() && !!img && img.complete && img.naturalWidth > 0;
  });
  return errors;
}

const getView = (page: Page) => page.evaluate(() => window.__bp.canvas()!.getView());
const getEvents = (page: Page) => page.evaluate(() => window.__bp.events) as Promise<HarnessEvent[]>;
const getCircles = (page: Page) => page.evaluate(() => window.__bp.circles) as Promise<CircleRow[]>;
const clearEvents = (page: Page) => page.evaluate(() => void (window.__bp.events.length = 0));
const ofType = <T extends HarnessEvent["t"]>(ev: HarnessEvent[], t: T) => ev.filter((e): e is Extract<HarnessEvent, { t: T }> => e.t === t);

async function canvasBox(page: Page): Promise<Box> {
  const b = (await page.locator(".bp-canvas").boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** World px → client (page) px, rounded: input events may carry whole pixels only. */
const toClient = (box: Box, v: View, wx: number, wy: number): Pt => ({
  x: Math.round(box.x + wx * v.scale + v.tx),
  y: Math.round(box.y + wy * v.scale + v.ty),
});
/** Client px → world px. */
const toWorld = (box: Box, v: View, p: Pt): Pt => ({ x: (p.x - box.x - v.tx) / v.scale, y: (p.y - box.y - v.ty) / v.scale });

async function circleClient(page: Page, id: string) {
  const [box, v, circles] = await Promise.all([canvasBox(page), getView(page), getCircles(page)]);
  const c = circles.find((x) => x.id === id)!;
  const { width: W, height: H } = h.meta;
  const centre = toClient(box, v, c.x * W, c.y * H);
  const R = Math.max(c.r * Math.max(W, H) * v.scale, 10);
  return { centre, R, c, v, box };
}

/** Wait until no animation is running (the view holds still for a few frames). */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = "";
        let still = 0;
        const tick = () => {
          const v = JSON.stringify(window.__bp.canvas()!.getView());
          still = v === last ? still + 1 : 0;
          last = v;
          if (still >= 4) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** Every mounted tile has loaded and only one level is mounted (none at all when the preview is sharp enough). */
async function tilesSettled(page: Page, timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll<HTMLImageElement>(".bp-tile")];
      const levels = new Set(tiles.map((t) => /\/tiles\/(\d+)\//.exec(t.src)?.[1]));
      return levels.size <= 1 && tiles.every((t) => t.classList.contains("on") && t.complete);
    },
    null,
    { timeout },
  );
  await page.waitForTimeout(250); // let the 160 ms fade finish
}

const tileLevels = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, { on: number; off: number }> = {};
    for (const t of document.querySelectorAll<HTMLImageElement>(".bp-tile")) {
      const l = /\/tiles\/(\d+)\//.exec(t.src)![1];
      out[l] ??= { on: 0, off: 0 };
      out[l][t.classList.contains("on") ? "on" : "off"]++;
    }
    return out;
  });

async function shot(page: Page, info: TestInfo, name: string, clip?: Box) {
  const file = process.env.CANVAS_SHOTS_DIR ? path.join(process.env.CANVAS_SHOTS_DIR, name) : info.outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, clip: clip ? { x: clip.x, y: clip.y, width: clip.w, height: clip.h } : undefined });
  return file;
}

/**
 * Mean absolute Laplacian of a screenshot shrunk by `shrink` (to one pixel
 * per raster pixel, where the full-resolution tiles are crisp and an
 * upscaled preview is not): a simple "how sharp is this" number.
 */
async function sharpness(png: Buffer, shrink: number) {
  const meta = await sharp(png).metadata();
  const { data, info } = await sharp(png)
    .resize({ width: Math.round(meta.width! / shrink) })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: hh } = info;
  let sum = 0;
  for (let y = 1; y < hh - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      sum += Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]);
    }
  return sum / ((w - 2) * (hh - 2));
}

async function mouseDrag(page: Page, from: Pt, to: Pt, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/**
 * CDP touch. touchStart/touchMove list every finger that's down (only the
 * changed ones produce events); touchEnd lists the fingers being lifted.
 */
class Touch {
  private down = new Map<number, Pt>();
  private constructor(private cdp: CDPSession) {}
  static async open(page: Page) {
    return new Touch(await page.context().newCDPSession(page));
  }
  private send(type: "touchStart" | "touchMove" | "touchEnd", points = [...this.down]) {
    const touchPoints = points.map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 6, radiusY: 6, force: 1 }));
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  }
  async start(id: number, p: Pt) {
    this.down.set(id, p);
    await this.send("touchStart");
  }
  async move(moves: Record<number, Pt>) {
    for (const [id, p] of Object.entries(moves)) this.down.set(Number(id), p);
    await this.send("touchMove");
  }
  async end(id: number) {
    const p = this.down.get(id)!;
    this.down.delete(id);
    await this.send("touchEnd", [[id, p]]);
  }
  async tap(p: Pt) {
    await this.start(1, p);
    await this.end(1);
  }
  async drag(from: Pt, to: Pt, steps = 10, id = 1) {
    await this.start(id, from);
    for (let i = 1; i <= steps; i++) await this.move({ [id]: { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps } });
    await this.end(id);
  }
}

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b), `${a} ≈ ${b} (±${tol})`).toBeLessThanOrEqual(tol);

// A spot of plain paper (inside the sheet, away from the circles).
const PAPER = { x: 0.42, y: 0.12 };

// ═══ desktop: mouse and trackpad ════════════════════════════════════════

test.describe("desktop mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

  test("opens fitted, draws every circle, no console errors", async ({ page }, info) => {
    const errors = await boot(page);
    const box = await canvasBox(page);
    const v = await getView(page);
    const fit = fitView(h.meta, box.w, box.h);
    near(v.scale, fit.scale, 1e-9);
    near(v.tx, fit.tx, 0.01);
    near(v.ty, fit.ty, 0.01);
    await expect(page.locator(".bp-anno")).toHaveCount(6);
    await expect(page.locator(".bp-zoom-pct")).toHaveText("100%");
    await expect(page.locator(".bp-badge text").filter({ hasText: "•" })).toHaveCount(1); // unsaved circle
    await tilesSettled(page);
    await shot(page, info, "canvas-fit-desktop.png");
    expect(errors).toEqual([]);
  });

  test("hover lights the circle under the mouse and reports it", async ({ page }, info) => {
    await boot(page);
    await page.evaluate(() => window.__bp.canvas()!.focusCircle("c2"));
    await settle(page);
    await tilesSettled(page);
    await clearEvents(page);
    const { centre, R } = await circleClient(page, "c2");
    await page.mouse.move(centre.x - R * 3, centre.y);
    await page.mouse.move(centre.x - R * 0.3, centre.y, { steps: 6 });
    let hovers = ofType(await getEvents(page), "hover");
    expect(hovers).toEqual([{ t: "hover", id: "c2", pointerType: "mouse" }]);
    await expect(page.locator(".bp-anno.lit")).toHaveCount(1);
    await expect(page.locator(".bp-surface")).toHaveAttribute("data-cursor", "pointer");
    await page.waitForTimeout(400);
    await shot(page, info, "canvas-lit-desktop.png");

    // the view changing under a still cursor re-tests hover: after Fit, the
    // field circle (c1, centred) is what's under the cursor
    await page.evaluate(() => window.__bp.canvas()!.fit());
    await settle(page);
    expect(ofType(await getEvents(page), "hover").at(-1)).toEqual({ t: "hover", id: "c1", pointerType: "mouse" });
    // leaving the canvas clears it
    await page.mouse.move(5, 5);
    hovers = ofType(await getEvents(page), "hover");
    expect(hovers.at(-1)).toEqual({ t: "hover", id: null, pointerType: "mouse" });
    await expect(page.locator(".bp-anno.lit")).toHaveCount(0);
  });

  test("click selects (handles appear), click on paper deselects", async ({ page }, info) => {
    await boot(page);
    const { centre } = await circleClient(page, "c1");
    await page.mouse.click(centre.x + 5, centre.y - 5);
    await expect(page.locator(".bp-handle-dot")).toHaveCount(4);
    await expect(page.locator(".bp-sel-ring")).toHaveCount(1);
    expect(ofType(await getEvents(page), "select")).toEqual([{ t: "select", id: "c1", how: "click" }]);
    await page.mouse.move(centre.x, centre.y);
    await expect(page.locator(".bp-surface")).toHaveAttribute("data-cursor", "move");
    await page.evaluate(() => window.__bp.canvas()!.focusCircle("c1"));
    await settle(page);
    await tilesSettled(page);
    await shot(page, info, "canvas-selected-desktop.png");

    // the small circle inside the big one wins
    await page.evaluate(() => window.__bp.canvas()!.fit());
    await settle(page);
    const small = await circleClient(page, "c5");
    await page.mouse.click(small.centre.x, small.centre.y);
    expect(ofType(await getEvents(page), "select").at(-1)).toEqual({ t: "select", id: "c5", how: "click" });

    const box = await canvasBox(page);
    const v = await getView(page);
    const paper = toClient(box, v, PAPER.x * h.meta.width, PAPER.y * h.meta.height);
    await page.mouse.click(paper.x, paper.y);
    expect(ofType(await getEvents(page), "select").at(-1)).toEqual({ t: "select", id: null, how: "click" });
    await expect(page.locator(".bp-handle-dot")).toHaveCount(0);
  });

  test("dragging paper or an unselected circle pans exactly with the pointer", async ({ page }) => {
    await boot(page);
    const box = await canvasBox(page);
    const v0 = await getView(page);
    const from = toClient(box, v0, PAPER.x * h.meta.width, PAPER.y * h.meta.height);
    await mouseDrag(page, from, { x: from.x + 150, y: from.y - 80 });
    const v1 = await getView(page);
    near(v1.tx - v0.tx, 150, 0.01);
    near(v1.ty - v0.ty, -80, 0.01);
    expect(v1.scale).toBe(v0.scale);

    const { centre } = await circleClient(page, "c2"); // not selected → pans
    await mouseDrag(page, centre, { x: centre.x - 60, y: centre.y + 40 });
    const v2 = await getView(page);
    near(v2.tx - v1.tx, -60, 0.01);
    near(v2.ty - v1.ty, 40, 0.01);
    const ev = await getEvents(page);
    expect(ofType(ev, "select")).toEqual([]);
    expect(ofType(ev, "gesture")).toEqual([]);
    // onViewChange arrived with the final view
    await expect.poll(async () => ofType(await getEvents(page), "view").at(-1)?.v).toEqual(v2);
  });

  test("wheel zooms around the cursor; double-click zooms ×2 there", async ({ page }) => {
    await boot(page);
    const box = await canvasBox(page);
    const at = { x: Math.round(box.x + box.w * 0.3), y: Math.round(box.y + box.h * 0.6) };
    const v0 = await getView(page);
    const w0 = toWorld(box, v0, at);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -240);
    await settle(page);
    const v1 = await getView(page);
    expect(v1.scale).toBeGreaterThan(v0.scale * 1.3);
    const w1 = toWorld(box, v1, at);
    near(w1.x, w0.x, 0.01);
    near(w1.y, w0.y, 0.01);

    await page.mouse.dblclick(at.x, at.y);
    await settle(page);
    const v2 = await getView(page);
    near(v2.scale / v1.scale, 2, 1e-6);
    const w2 = toWorld(box, v2, at);
    near(w2.x, w0.x, 0.01);
    near(w2.y, w0.y, 0.01);
  });

  test("zoom buttons and Fit", async ({ page }) => {
    await boot(page);
    const v0 = await getView(page);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await settle(page);
    near((await getView(page)).scale / v0.scale, 1.3, 1e-6);
    await expect(page.locator(".bp-zoom-pct")).toHaveText("130%");
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await settle(page);
    near((await getView(page)).scale / v0.scale, 1 / 1.3, 1e-6);
    // can't zoom out past half of fit
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom out" }).click({ force: true });
    await settle(page);
    near((await getView(page)).scale, v0.scale * 0.5, 1e-9);
    await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    await page.getByRole("button", { name: "Fit the page to the screen" }).click();
    await settle(page);
    expect(await getView(page)).toEqual(v0);
    await expect(page.locator(".bp-zoom-pct")).toHaveText("100%");
  });

  test("add mode: click adds a default-size circle, drag sizes it", async ({ page }, info) => {
    await boot(page);
    await page.evaluate(() => window.__bp.setMode("add"));
    await expect(page.locator(".bp-hint")).toContainText("Click the blueprint to add a circle — drag to size it");
    await expect(page.locator(".bp-surface")).toHaveAttribute("data-cursor", "crosshair");
    // a click here adds rather than selects, so hovering a circle doesn't light it
    const c1 = await circleClient(page, "c1");
    await page.mouse.move(c1.centre.x, c1.centre.y);
    await expect(page.locator(".bp-anno.lit")).toHaveCount(0);
    expect(ofType(await getEvents(page), "hover")).toEqual([]);
    const box = await canvasBox(page);
    const v = await getView(page);
    const L = Math.max(h.meta.width, h.meta.height);

    // a click inside an existing circle still adds (add mode never selects)
    const { centre } = await circleClient(page, "c4");
    await page.mouse.click(centre.x, centre.y);
    let add = ofType(await getEvents(page), "add").at(-1)!;
    const wc = toWorld(box, v, centre);
    near(add.x, wc.x / h.meta.width, 1e-9);
    near(add.y, wc.y / h.meta.height, 1e-9);
    near(add.x, 0.27, 0.001);
    near(add.r, DEFAULT_CIRCLE_SCREEN_R / v.scale / L, 1e-9);
    expect(ofType(await getEvents(page), "select")).toEqual([]);
    expect(await page.evaluate(() => window.__bp.mode)).toBe("move"); // the harness switches back, like the editor

    // drag to size: the preview follows, release adds
    await page.evaluate(() => window.__bp.setMode("add"));
    const from = toClient(box, v, 0.62 * h.meta.width, 0.3 * h.meta.height);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 45, { steps: 8 }); // 75 px
    await expect(page.locator(".bp-add-preview")).toHaveCount(1);
    await page.waitForTimeout(100);
    await shot(page, info, "canvas-add-desktop.png");
    await page.mouse.up();
    add = ofType(await getEvents(page), "add").at(-1)!;
    near(add.r, 75 / v.scale / L, 1e-6);
    const wf = toWorld(box, v, from);
    near(add.x, wf.x / h.meta.width, 1e-9);
    near(add.y, wf.y / h.meta.height, 1e-9);
    await expect(page.locator(".bp-add-preview")).toHaveCount(0);

    // a drag under 6 px (but past the 4 px slop) gets the default size
    await page.evaluate(() => window.__bp.setMode("add"));
    await mouseDrag(page, from, { x: from.x + 5, y: from.y }, 3);
    near(ofType(await getEvents(page), "add").at(-1)!.r, DEFAULT_CIRCLE_SCREEN_R / v.scale / L, 1e-9);

    // the hint's Cancel goes through the editor
    await page.evaluate(() => window.__bp.setMode("add"));
    await page.locator(".bp-hint").getByRole("button", { name: "Cancel" }).click();
    expect(ofType(await getEvents(page), "cancelAdd")).toHaveLength(1);
    await expect(page.locator(".bp-hint")).toHaveCount(0);
  });

  test("drag the selected circle to move it, a handle to resize it", async ({ page }) => {
    await boot(page, "?select=c1");
    await page.evaluate(() => window.__bp.canvas()!.focusCircle("c1"));
    await settle(page);
    const L = Math.max(h.meta.width, h.meta.height);
    let { centre, R, v } = await circleClient(page, "c1");

    await mouseDrag(page, { x: centre.x - 10, y: centre.y + 10 }, { x: centre.x + 90, y: centre.y + 50 });
    let g = ofType(await getEvents(page), "gesture").map((e) => e.e);
    expect(g[0]).toEqual({ phase: "start", id: "c1", kind: "move", x: 0.5, y: 0.5 });
    expect(g.at(-1)!.phase).toBe("end");
    expect(g.filter((e) => e.phase === "update").length).toBeGreaterThan(0);
    const moved = (await getCircles(page)).find((c) => c.id === "c1")!;
    near(moved.x, 0.5 + 100 / v.scale / h.meta.width, 1e-6);
    near(moved.y, 0.5 + 40 / v.scale / h.meta.height, 1e-6);
    expect(g.at(-1)).toEqual({ phase: "end", id: "c1", kind: "move", x: moved.x, y: moved.y });
    expect((await getView(page)).tx).toBe(v.tx); // moving a circle doesn't pan

    // east handle outward by 50 px
    await clearEvents(page);
    ({ centre, R, v } = await circleClient(page, "c1"));
    const handle = { x: Math.round(centre.x + R), y: centre.y };
    await mouseDrag(page, handle, { x: handle.x + 50, y: centre.y + 3 });
    g = ofType(await getEvents(page), "gesture").map((e) => e.e);
    expect(g[0]).toMatchObject({ phase: "start", kind: "resize", id: "c1" });
    const resized = (await getCircles(page)).find((c) => c.id === "c1")!;
    near(resized.r * L * v.scale, R + 50, 0.2);
    expect(resized.x).toBe(moved.x);

    // dragging past the limit clamps (zoomed right out, so the limit is on screen)
    await page.evaluate(() => window.__bp.canvas()!.fit());
    for (let i = 0; i < 4; i++) await page.evaluate(() => window.__bp.canvas()!.zoomOut());
    await settle(page);
    let box: Box;
    ({ centre, R, v, box } = await circleClient(page, "c1"));
    const edge = box.x + box.w - 5;
    expect(edge - centre.x).toBeGreaterThan(MAX_CIRCLE_R * L * v.scale);
    await mouseDrag(page, { x: centre.x + R, y: centre.y }, { x: edge, y: centre.y }, 6);
    expect((await getCircles(page)).find((c) => c.id === "c1")!.r).toBe(MAX_CIRCLE_R);
  });

  test("deep zoom shows the full-resolution tiles: 4.5 pt print is crisp", async ({ page }, info) => {
    await boot(page);
    // the tiny circle sits on the small print in the corner; zoom to the max there
    await page.evaluate(() => window.__bp.canvas()!.focusCircle("c3"));
    await settle(page);
    const v = await getView(page);
    near(v.scale, 3, 1e-9); // max zoom: 3 screen px per raster px
    await tilesSettled(page);
    const levels = await tileLevels(page);
    expect(Object.keys(levels)).toEqual([String(h.meta.maxLevel)]);
    const box = await canvasBox(page);
    const file = await shot(page, info, "canvas-deep-desktop.png");
    // sharper than the stretched preview alone, by a lot
    const clip = { x: box.x + 40, y: box.y + 40, width: box.w - 80, height: box.h - 120 };
    const shrink = v.scale * 2; // device px per raster px (deviceScaleFactor 2)
    const withTiles = await sharpness(await page.screenshot({ clip }), shrink);
    await page.addStyleTag({ content: ".bp-tile { visibility: hidden !important; }" });
    const previewOnly = await sharpness(await page.screenshot({ clip }), shrink);
    expect(withTiles).toBeGreaterThan(previewOnly * 2.5);
    expect(fs.existsSync(file)).toBe(true);
  });

  test("changing level keeps the old tiles up until the new ones arrive", async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page);
    await tilesSettled(page);
    const before = await tileLevels(page);
    const [startLevel] = Object.keys(before).map(Number);
    // (the browser fetches 6 at a time, so ~80 tiles × 600 ms ≈ 8 s to finish)
    h.setTileDelay(600, startLevel + 1);
    try {
      // watch every frame: something sharp must always cover the middle of the screen
      await page.evaluate(() => {
        const w = window as unknown as { __bare: number; __frames: number; __stop: boolean };
        w.__bare = 0;
        w.__frames = 0;
        w.__stop = false;
        const c = document.querySelector(".bp-canvas")!.getBoundingClientRect();
        const pt = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
        const tick = () => {
          const covered = [...document.querySelectorAll(".bp-tile.on")].some((t) => {
            const r = t.getBoundingClientRect();
            return r.left <= pt.x && r.right >= pt.x && r.top <= pt.y && r.bottom >= pt.y;
          });
          w.__frames++;
          if (!covered) w.__bare++;
          if (!w.__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in" }).click();
      await settle(page);
      const during = await tileLevels(page);
      expect(during[String(startLevel)]?.on).toBeGreaterThan(0); // fallback still up
      expect(during[String(startLevel + 1)]?.on ?? 0).toBe(0); // new level still loading
      await tilesSettled(page, 40_000);
      const after = await tileLevels(page);
      expect(Object.keys(after)).toEqual([String(startLevel + 1)]);
      const watch = await page.evaluate(() => {
        const w = window as unknown as { __bare: number; __frames: number; __stop: boolean };
        w.__stop = true;
        return { bare: w.__bare, frames: w.__frames };
      });
      expect(watch.frames).toBeGreaterThan(20);
      expect(watch.bare).toBe(0);
    } finally {
      h.setTileDelay(0);
    }
  });

  test("a page still sharpening shows its preview, and fit keeps clear of the right panel", async ({ page }) => {
    await boot(page, "?status=preview&inset=340");
    await page.waitForTimeout(300);
    await expect(page.locator(".bp-tile")).toHaveCount(0);
    const box = await canvasBox(page);
    const v = await getView(page);
    // the page sits in the uncovered part
    expect(v.tx + h.meta.width * v.scale).toBeLessThanOrEqual(box.w - 340 + 0.5);
    const zoom = (await page.locator(".bp-zoom").boundingBox())!;
    expect(zoom.x + zoom.width).toBeLessThanOrEqual(box.x + box.w - 340);
  });
});

// ═══ iPad: touch ════════════════════════════════════════════════════════

test.describe("iPad touch (landscape)", () => {
  test.use({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("fits, coarse-pointer controls, screenshot", async ({ page }, info) => {
    const errors = await boot(page);
    await tilesSettled(page);
    const btn = (await page.getByRole("button", { name: "Zoom in" }).boundingBox())!;
    expect(btn.height).toBeGreaterThanOrEqual(44);
    expect(btn.width).toBeGreaterThanOrEqual(44);
    await shot(page, info, "canvas-ipad-landscape.png");
    expect(errors).toEqual([]);
  });

  test("one finger pans exactly; onViewChange is throttled", async ({ page }) => {
    await boot(page);
    const t = await Touch.open(page);
    const box = await canvasBox(page);
    const v0 = await getView(page);
    const from = toClient(box, v0, PAPER.x * h.meta.width, PAPER.y * h.meta.height);
    await clearEvents(page);
    const t0 = Date.now();
    await t.start(1, from);
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      await t.move({ 1: { x: from.x - 4 * i, y: from.y + 3 * i } });
      await page.waitForTimeout(30);
    }
    const mid = await getView(page);
    near(mid.tx - v0.tx, -120, 0.01);
    near(mid.ty - v0.ty, 90, 0.01);
    await t.end(1);
    const ev = await getEvents(page);
    expect(ofType(ev, "select")).toEqual([]);
    const views = ofType(ev, "view");
    expect(views.length).toBeGreaterThan(0);
    expect(views.length).toBeLessThanOrEqual(Math.ceil((Date.now() - t0) / 250) + 2);
    await expect.poll(async () => ofType(await getEvents(page), "view").at(-1)?.v).toEqual(mid);
    await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  });

  test("tap selects a circle, tap on paper deselects", async ({ page }, info) => {
    await boot(page);
    const t = await Touch.open(page);
    const { centre } = await circleClient(page, "c2");
    await t.tap({ x: centre.x + 3, y: centre.y + 2 });
    expect(ofType(await getEvents(page), "select")).toEqual([{ t: "select", id: "c2", how: "tap" }]);
    await expect(page.locator(".bp-handle-dot")).toHaveCount(4);
    expect(ofType(await getEvents(page), "hover")).toEqual([]); // touch never hovers
    // a tiny circle is easy to hit with a finger (22 px target)
    const tiny = await circleClient(page, "c3");
    await t.tap({ x: tiny.centre.x + 17, y: tiny.centre.y - 10 });
    expect(ofType(await getEvents(page), "select").at(-1)).toEqual({ t: "select", id: "c3", how: "tap" });
    const box = await canvasBox(page);
    const v = await getView(page);
    await t.tap(toClient(box, v, PAPER.x * h.meta.width, PAPER.y * h.meta.height));
    expect(ofType(await getEvents(page), "select").at(-1)).toEqual({ t: "select", id: null, how: "tap" });

    await page.evaluate(() => window.__bp.setSelected("c1"));
    await page.evaluate(() => window.__bp.canvas()!.focusCircle("c1"));
    await settle(page);
    await tilesSettled(page);
    await shot(page, info, "canvas-ipad-selected.png");
  });

  test("pinch zooms and pans with no drift; lifting a finger doesn't jump", async ({ page }) => {
    await boot(page);
    const t = await Touch.open(page);
    const box = await canvasBox(page);
    const v0 = await getView(page);
    const m0 = { x: Math.round(box.x + box.w * 0.45), y: Math.round(box.y + box.h * 0.55) };
    const anchor = toWorld(box, v0, m0); // world point under the starting midpoint
    await clearEvents(page);

    await t.start(1, { x: m0.x - 80, y: m0.y });
    await t.start(2, { x: m0.x + 80, y: m0.y });
    // spread to 2.5× while drifting the pair: zoom and pan together
    const steps = 16;
    let mid = m0;
    let last1 = m0;
    for (let i = 1; i <= steps; i++) {
      const half = 80 + 8 * i;
      mid = { x: m0.x + 3 * i, y: m0.y - 2 * i };
      last1 = { x: mid.x - half, y: mid.y + i };
      await t.move({ 1: last1, 2: { x: mid.x + half, y: mid.y - i } });
      const v = await getView(page);
      const a = toClient(box, v, anchor.x, anchor.y);
      near(a.x, mid.x, 0.01); // the anchor stays under the fingers' midpoint, every step
      near(a.y, mid.y, 0.01);
    }
    const v1 = await getView(page);
    const spread = Math.hypot(2 * (80 + 8 * steps), 2 * steps);
    near(v1.scale / v0.scale, spread / 160, 1e-6);

    // lift one finger: nothing moves; the other keeps panning 1:1
    await t.end(2);
    expect(await getView(page)).toEqual(v1);
    for (let i = 1; i <= 5; i++) await t.move({ 1: { x: last1.x + 5 * i, y: last1.y + 3 * i } });
    const v2 = await getView(page);
    near(v2.tx - v1.tx, 25, 0.01);
    near(v2.ty - v1.ty, 15, 0.01);
    expect(v2.scale).toBe(v1.scale);
    await t.end(1);
    const ev = await getEvents(page);
    expect(ofType(ev, "select")).toEqual([]); // a pinch is never a tap
    expect(ofType(ev, "add")).toEqual([]);
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1); // the page itself never zoomed
  });

  test("long press on paper adds a circle there", async ({ page }, info) => {
    await boot(page);
    const t = await Touch.open(page);
    const box = await canvasBox(page);
    const v = await getView(page);
    const p = toClient(box, v, 0.6 * h.meta.width, 0.4 * h.meta.height);
    await t.start(1, p);
    await expect(page.locator(".bp-hold")).toHaveCount(1, { timeout: 1000 }); // fires at 500 ms
    // freeze the ring 200 ms into its animation for the record
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        if ((a as CSSAnimation).animationName === "bp-hold-ring") {
          a.pause();
          a.currentTime = 200;
        }
      }
    });
    await shot(page, info, "canvas-ipad-longpress.png");
    await t.end(1);
    const ev = await getEvents(page);
    const adds = ofType(ev, "add");
    expect(adds).toHaveLength(1);
    const w = toWorld(box, v, p);
    near(adds[0].x, w.x / h.meta.width, 1e-9);
    near(adds[0].y, w.y / h.meta.height, 1e-9);
    near(adds[0].r, DEFAULT_CIRCLE_SCREEN_R / v.scale / Math.max(h.meta.width, h.meta.height), 1e-9);
    expect(ofType(ev, "select")).toEqual([]);

    // a press that moves is a pan, not a long press
    await clearEvents(page);
    await t.start(1, p);
    await t.move({ 1: { x: p.x + 30, y: p.y } });
    await page.waitForTimeout(650);
    await t.end(1);
    expect(ofType(await getEvents(page), "add")).toEqual([]);
  });

  test("drag a handle to resize, the circle to move; a second finger cancels", async ({ page }) => {
    await boot(page, "?select=c1");
    const t = await Touch.open(page);
    const L = Math.max(h.meta.width, h.meta.height);
    let { centre, R, v } = await circleClient(page, "c1");

    // handle: the finger lands 8 px off the dot — the rim stays under the finger, no jump
    const grab = { x: Math.round(centre.x + R + 8), y: centre.y - 4 };
    await t.drag(grab, { x: grab.x + 40, y: grab.y });
    const resized = (await getCircles(page)).find((c) => c.id === "c1")!;
    near(resized.r * L * v.scale, R + 40, 0.5);

    ({ centre, R, v } = await circleClient(page, "c1"));
    await t.drag(centre, { x: centre.x - 70, y: centre.y + 35 });
    const moved = (await getCircles(page)).find((c) => c.id === "c1")!;
    near(moved.x, 0.5 - 70 / v.scale / h.meta.width, 1e-6);
    near(moved.y, 0.5 + 35 / v.scale / h.meta.height, 1e-6);

    // move again, then a second finger lands: cancelled and restored, pinch takes over
    await clearEvents(page);
    ({ centre } = await circleClient(page, "c1"));
    await t.start(1, centre);
    for (let i = 1; i <= 5; i++) await t.move({ 1: { x: centre.x + 10 * i, y: centre.y } });
    await t.start(2, { x: centre.x + 200, y: centre.y + 100 });
    const g = ofType(await getEvents(page), "gesture").map((e) => e.e);
    expect(g[0].phase).toBe("start");
    expect(g.at(-1)).toEqual({ phase: "cancel", id: "c1", kind: "move" });
    const restored = (await getCircles(page)).find((c) => c.id === "c1")!;
    expect(restored.x).toBe(moved.x);
    await t.move({ 1: { x: centre.x + 30, y: centre.y }, 2: { x: centre.x + 300, y: centre.y + 150 } });
    expect((await getView(page)).scale).toBeGreaterThan(v.scale); // pinching now
    await t.end(2);
    await t.end(1);
    expect((await getCircles(page)).find((c) => c.id === "c1")!.x).toBe(restored.x); // nothing else moved it
  });

  test("double-tap zooms ×2 around the finger; add mode tap and drag", async ({ page }) => {
    await boot(page);
    const t = await Touch.open(page);
    const box = await canvasBox(page);
    const v0 = await getView(page);
    const p = toClient(box, v0, PAPER.x * h.meta.width, 0.2 * h.meta.height);
    const p2 = { x: p.x + 6, y: p.y - 4 };
    const w0 = toWorld(box, v0, p2);
    await t.tap(p);
    await page.waitForTimeout(80);
    await t.tap(p2);
    await settle(page);
    const v1 = await getView(page);
    near(v1.scale / v0.scale, 2, 1e-6);
    const w1 = toWorld(box, v1, p2); // zoomed around the second tap
    near(w1.x, w0.x, 0.01);
    near(w1.y, w0.y, 0.01);
    expect(ofType(await getEvents(page), "select")).toEqual([{ t: "select", id: null, how: "tap" }]); // only the first tap

    await page.evaluate(() => window.__bp.setMode("add"));
    await expect(page.locator(".bp-hint")).toContainText("Tap the blueprint to add a circle — drag to size it");
    const L = Math.max(h.meta.width, h.meta.height);
    const q = { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
    await t.tap(q);
    near(ofType(await getEvents(page), "add").at(-1)!.r, DEFAULT_CIRCLE_SCREEN_R / v1.scale / L, 1e-9);
    await page.evaluate(() => window.__bp.setMode("add"));
    await t.drag(q, { x: q.x + 80, y: q.y + 60 });
    const add = ofType(await getEvents(page), "add").at(-1)!;
    near(add.r, 100 / v1.scale / L, 1e-6);
    const w = toWorld(box, v1, q);
    near(add.x, w.x / h.meta.width, 1e-6);
    near(add.y, w.y / h.meta.height, 1e-6);
  });
});

test.describe("iPad touch (portrait)", () => {
  test.use({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("fits the width and pinches", async ({ page }, info) => {
    await boot(page);
    const box = await canvasBox(page);
    const v0 = await getView(page);
    near(v0.scale, fitView(h.meta, box.w, box.h).scale, 1e-9);
    await tilesSettled(page);
    await shot(page, info, "canvas-ipad-portrait.png");
    const t = await Touch.open(page);
    const m = { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
    await t.start(1, { x: m.x, y: m.y - 50 });
    await t.start(2, { x: m.x, y: m.y + 50 });
    for (let i = 1; i <= 8; i++) await t.move({ 1: { x: m.x, y: m.y - 50 - 5 * i }, 2: { x: m.x, y: m.y + 50 + 5 * i } });
    await t.end(1);
    await t.end(2);
    near((await getView(page)).scale / v0.scale, 1.8, 1e-6);
  });
});
