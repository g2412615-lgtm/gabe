// The owner's core flows, end to end against the built server, on a desktop
// (mouse) and an iPad-sized touch screen (finger): see playwright.config.ts.
// Each test makes its own event plan, so they don't depend on each other.

import type { Page, TestInfo } from "@playwright/test";
import {
  centreOf,
  dragFromTo,
  editor,
  expect,
  expectSaved,
  getPlan,
  isTouch,
  liveCircles,
  liveComments,
  livePages,
  openEditor,
  press,
  pressAt,
  sheetPoint,
  signInByApi,
  test,
  uniqueName,
  uploadByApi,
  waitCanvas,
  waitPagesReady,
  appPassword,
  fixture,
  type Pt,
} from "./helpers";

/** The page labels inside tests/fixtures/out/event-plan.pdf (its /PageLabels). */
const LABELS = ["A-101", "P-1", "C-201", "R-1"];

/** The plan's row on the home page (its meta line counts pages, circles and comments). */
const planRow = (page: Page, planId: string) => page.locator(`[data-plan="${planId}"]`);

/** Upload event-plan.pdf through the API, wait until its pages are ready, open it. */
async function freshPlan(page: Page, info: TestInfo, what: string) {
  await signInByApi(page);
  const name = uniqueName(what, info);
  const planId = await uploadByApi(page, "event-plan.pdf", name);
  const pages = await waitPagesReady(page, planId);
  expect(pages).toHaveLength(4);
  await openEditor(page, planId);
  return { planId, name, pages };
}

/** Circle mode, then a click / tap on the sheet: returns the new circle (saved, numbered). */
async function addCircleAt(page: Page, info: TestInfo, planId: string, at: Pt) {
  const ed = editor(page);
  await press(ed.circleMode, info);
  await expect(ed.circleMode).toHaveAttribute("aria-pressed", "true");
  await expect(ed.canvas).toHaveClass(/\bis-add\b/);
  await pressAt(page, at, info);
  // the panel opens on the new circle and the tool goes back to Move
  await expect(ed.panel).toBeVisible();
  await expect(ed.moveMode).toHaveAttribute("aria-pressed", "true");
  await expect(ed.circles).toHaveCount(1);
  // numbered by the server on its first save
  await expect(ed.panelTitle).toHaveText(/^Circle #\d+$/);
  await expectSaved(page);
  const circles = liveCircles(await getPlan(page, planId));
  expect(circles).toHaveLength(1);
  return circles[0];
}

/** Type a comment in the composer and add it (⌘↵-free: the Add button, like the iPad). */
async function writeComment(page: Page, info: TestInfo, text: string) {
  const ed = editor(page);
  const before = await ed.comments.count();
  await press(ed.composer, info);
  await expect(ed.composer).toBeFocused();
  await page.keyboard.type(text);
  await press(ed.addComment, info);
  await expect(ed.comments).toHaveCount(before + 1);
  await expect(ed.commentBodies.last()).toHaveText(text);
  await expect(ed.composer).toHaveValue("");
}

/** Where a circle's centre is on screen right now. */
async function circleScreenPoint(page: Page, c: { x: number; y: number }) {
  return sheetPoint(page, c.x, c.y);
}

/** A spot on the sheet away from any circle (a deselecting click/tap lands here). */
const EMPTY_SPOT = { x: 0.06, y: 0.55 };

test.describe("signing in", () => {
  test("a wrong password is refused, the right one opens the event plans", async ({ page }, info) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login(\?|$)/);
    const password = page.getByLabel("Password", { exact: true });
    const signIn = page.getByRole("button", { name: "Sign in" });

    await password.fill("not-the-password");
    await press(signIn, info);
    await expect(page.getByRole("alert")).toHaveText("That password isn't right.");
    await expect(page).toHaveURL(/\/login/);

    await password.fill(appPassword());
    await press(signIn, info);
    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(page.getByRole("heading", { name: "Event plans", level: 1 })).toBeVisible();
  });
});

test.describe("the editor", () => {
  test("upload a PDF from home: the editor opens, the pages get ready, the sidebar lists every page", async ({ page }, info) => {
    await signInByApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Event plans", level: 1 })).toBeVisible();

    const name = uniqueName("Home upload", info);
    // (with no plans yet, the empty state has a second Upload button)
    await press(page.getByRole("button", { name: "Upload blueprint" }).first(), info);
    const dialog = page.getByRole("dialog", { name: "Upload a blueprint" });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles(fixture("event-plan.pdf"));
    await expect(dialog.getByLabel("Plan name")).toHaveValue(/event.plan/i); // prefilled from the file name
    await dialog.getByLabel("Plan name").fill(name);
    await press(dialog.getByRole("button", { name: "Upload", exact: true }), info);

    await expect(page).toHaveURL(/\/plans\/[\w-]+/, { timeout: 30_000 });
    const ed = editor(page);
    await expect(page.getByRole("textbox", { name: "Event plan name" })).toHaveValue(name);
    await expect(ed.pageItems).toHaveCount(4, { timeout: 30_000 });
    // every page finishes preparing (no "Preparing…" or "Sharpening…" left)
    await expect(ed.sidebar.getByText(/Preparing…|Sharpening…/)).toHaveCount(0, { timeout: 90_000 });
    await waitCanvas(page);
    await expect(ed.pager).toContainText("Page 1 of 4");
    for (const [i, label] of LABELS.entries()) {
      await expect(ed.pageMenu(label)).toBeAttached();
      await expect(ed.pageItems.nth(i)).toContainText(label);
    }
    await expect(ed.pager).toContainText(LABELS[0]);
  });

  test("switch pages from the sidebar and with next / previous", async ({ page }, info) => {
    const { pages } = await freshPlan(page, info, "Page switching");
    const ed = editor(page);
    const showing = async (i: number) => {
      await expect(ed.pager).toContainText(`Page ${i + 1} of 4`);
      await expect(ed.pager).toContainText(LABELS[i]);
      await expect(ed.pageButton(LABELS[i])).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveURL(new RegExp(`[?&]page=${pages[i].id}`));
      // the canvas really shows that page
      await expect(ed.preview).toHaveAttribute("src", new RegExp(`/api/pages/${pages[i].id}/`));
      await waitCanvas(page);
    };

    await showing(0);
    await expect(ed.prevPage).toBeDisabled();

    await press(ed.pageButton("C-201"), info);
    await showing(2);
    await press(ed.pageButton("P-1"), info);
    await showing(1);

    await press(ed.nextPage, info);
    await showing(2);
    await press(ed.nextPage, info);
    await showing(3);
    await expect(ed.nextPage).toBeDisabled();

    await press(ed.prevPage, info);
    await showing(2);
    await press(ed.prevPage, info);
    await press(ed.prevPage, info);
    await showing(0);
  });

  test("mark up a page: label, circle, size, two comments — all still there after a reload", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Mark-up");
    const ed = editor(page);
    const touch = isTouch(info);
    const p1 = pages[0];
    const longSide = Math.max(p1.width, p1.height);

    // ── label the page ──
    const newLabel = "A-101 Seating bowl";
    if (!touch) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Rename" }), info);
    const labelField = ed.sidebar.getByRole("textbox", { name: "Page name" });
    await expect(labelField).toBeFocused();
    await labelField.fill(newLabel);
    await labelField.press("Enter");
    await expect(ed.pageMenu(newLabel)).toBeAttached();
    await expect(ed.pager).toContainText(newLabel);
    await expectSaved(page);
    await expect.poll(async () => livePages(await getPlan(page, planId))[0].label).toBe(newLabel);

    // ── add a circle (Circle mode, then click / tap) ──
    const circle = await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    expect(circle.pageId).toBe(p1.id);
    expect(circle.x).toBeCloseTo(0.3, 1);
    expect(circle.y).toBeCloseTo(0.38, 1);
    await expect(ed.circles.first()).toHaveClass(/\bsel\b/);

    // ── resize it with the east handle ──
    const handle = page.locator(".bp-selection .bp-handle-e .bp-handle-dot");
    await expect(handle).toBeVisible();
    const from = await centreOf(handle);
    await dragFromTo(page, from, { x: from.x + 70, y: from.y }, info);
    await expectSaved(page);
    let grown = circle;
    await expect
      .poll(async () => {
        grown = liveCircles(await getPlan(page, planId))[0];
        return grown.r / circle.r;
      })
      .toBeGreaterThan(1.3);
    // the drag only resized: the centre stayed put
    expect(grown.x).toBeCloseTo(circle.x, 3);
    expect(grown.y).toBeCloseTo(circle.y, 3);

    // ── two comments through the composer ──
    const notes = ["Mag line at Gate B — 4 staff, one lead.", "Barricade check before doors."];
    for (const n of notes) await writeComment(page, info, n);
    await expectSaved(page);
    await expect
      .poll(async () => liveComments(await getPlan(page, planId), circle.id).map((c) => c.body))
      .toEqual(notes);

    // ── close the panel: a click / tap on bare paper ──
    await pressAt(page, await sheetPoint(page, EMPTY_SPOT.x, EMPTY_SPOT.y), info);
    await expect(ed.panel).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]circle=/);

    const centre = await circleScreenPoint(page, grown);
    if (!touch) {
      // ── desktop: hovering lights the circle and shows its comments; leaving puts the panel away ──
      await page.mouse.move(centre.x - 200, centre.y + 120); // somewhere else on the sheet first
      await expect(ed.circles.first()).not.toHaveClass(/\blit\b/);
      await page.mouse.move(centre.x, centre.y, { steps: 5 });
      await expect(ed.circles.first()).toHaveClass(/\blit\b/);
      await expect(ed.panel).toBeVisible();
      await expect(ed.panelTitle).toHaveText(`Circle #${grown.num}`);
      await expect(ed.commentBodies).toHaveText(notes);
      const away = await sheetPoint(page, EMPTY_SPOT.x, EMPTY_SPOT.y);
      await page.mouse.move(away.x, away.y, { steps: 5 });
      await expect(ed.panel).toBeHidden();
      await expect(ed.circles.first()).not.toHaveClass(/\blit\b/);
    } else {
      // ── iPad: a tap on the circle opens it with its comments; a tap on paper closes it ──
      await pressAt(page, centre, info);
      await expect(ed.panel).toBeVisible();
      await expect(ed.circles.first()).toHaveClass(/\blit\b/);
      await expect(ed.commentBodies).toHaveText(notes);
      await pressAt(page, await sheetPoint(page, EMPTY_SPOT.x, EMPTY_SPOT.y), info);
      await expect(ed.panel).toBeHidden();
    }

    // the circle as drawn (world px; same page, same fit → same number after the reload)
    const drawnR = Number(await ed.circles.first().locator(".bp-anno-body").getAttribute("r"));
    expect(drawnR).toBeCloseTo(grown.r * longSide, 0);

    // ── reload: label, circle, size and comments are all kept ──
    await expectSaved(page);
    await page.reload();
    await waitCanvas(page);
    await expect(ed.pager).toContainText("Page 1 of 4");
    await expect(ed.pager).toContainText(newLabel);
    await expect(ed.pageMenu(newLabel)).toBeAttached();
    await expect(ed.circles).toHaveCount(1);
    await expect.poll(async () => Number(await ed.circles.first().locator(".bp-anno-body").getAttribute("r"))).toBeCloseTo(drawnR, 1);
    await pressAt(page, await circleScreenPoint(page, grown), info);
    await expect(ed.panel).toBeVisible();
    await expect(ed.panelTitle).toHaveText(`Circle #${grown.num}`);
    await expect(ed.commentBodies).toHaveText(notes);
    const doc = await getPlan(page, planId);
    expect(liveCircles(doc)[0].r).toBeCloseTo(grown.r, 6);

    // ── home lists the plan with its counts ──
    await press(page.getByTitle("Back to event plans"), info);
    await expect(page).toHaveURL((u) => u.pathname === "/");
    const row = planRow(page, planId);
    await expect(row).toContainText("4 pages");
    await expect(row).toContainText("1 circle");
    await expect(row).toContainText("2 comments");
  });

  test("delete a circle, then Undo brings it back", async ({ page }, info) => {
    const { planId } = await freshPlan(page, info, "Delete + undo");
    const ed = editor(page);
    const circle = await addCircleAt(page, info, planId, await sheetPoint(page, 0.45, 0.4));
    await writeComment(page, info, "Keep this note");
    await expectSaved(page);

    await press(ed.deleteCircle, info);
    await expect(ed.circles).toHaveCount(0);
    await expect(ed.panel).toBeHidden();
    const toast = ed.toast(`Circle #${circle.num} deleted.`);
    await expect(toast).toBeVisible();
    await expectSaved(page);
    await expect.poll(async () => liveCircles(await getPlan(page, planId)).length).toBe(0);

    await press(toast.getByRole("button", { name: "Undo" }), info);
    await expect(ed.circles).toHaveCount(1);
    await expectSaved(page);
    await expect.poll(async () => liveCircles(await getPlan(page, planId)).map((c) => c.id)).toEqual([circle.id]);
    expect(liveComments(await getPlan(page, planId), circle.id).map((c) => c.body)).toEqual(["Keep this note"]);

    await page.reload();
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(1);
  });

  test("add pages from a second PDF, delete one page; home shows the counts", async ({ page }, info) => {
    const { planId } = await freshPlan(page, info, "Add + delete pages");
    const ed = editor(page);
    await expect(ed.pageItems).toHaveCount(4);

    // ── add pages: suite-level.pdf has one page ──
    await ed.addPagesInput.setInputFiles(fixture("suite-level.pdf"));
    await expect(ed.toast("Added 1 page from “suite-level.pdf”.")).toBeVisible({ timeout: 30_000 });
    await expect(ed.pageItems).toHaveCount(5);
    await expect(ed.pager).toContainText("Page 1 of 5");
    await waitPagesReady(page, planId);
    await expect(ed.sidebar.getByText(/Preparing…|Sharpening…/)).toHaveCount(0, { timeout: 30_000 });
    // the new page opens like any other
    await press(ed.pageItems.nth(4).getByRole("button").first(), info);
    await expect(ed.pager).toContainText("Page 5 of 5");
    await waitCanvas(page);

    // ── delete a page (after confirming) ──
    if (!isTouch(info)) await ed.pageButton("R-1").hover();
    await press(ed.pageMenu("R-1"), info);
    await press(page.getByRole("menuitem", { name: "Delete page…" }), info);
    const confirm = page.getByRole("dialog", { name: "Delete page “R-1”?" });
    await expect(confirm).toBeVisible();
    await press(confirm.getByRole("button", { name: "Delete page" }), info);
    await expect(confirm).toBeHidden();
    await expect(ed.pageItems).toHaveCount(4);
    await expect(ed.pageMenu("R-1")).toHaveCount(0);
    await expect(ed.pager).toContainText(/Page \d of 4/);
    await expectSaved(page);
    await expect.poll(async () => livePages(await getPlan(page, planId)).length).toBe(4);

    await page.reload();
    await waitCanvas(page);
    await expect(ed.pageItems).toHaveCount(4);
    await expect(ed.pageMenu("R-1")).toHaveCount(0);

    await page.goto("/");
    const row = planRow(page, planId);
    await expect(row).toContainText("4 pages");
    await expect(row).toContainText("0 circles");
    await expect(row).toContainText("0 comments");
  });

  test("offline: a comment written with no connection saves once it's back", async ({ page, context }, info) => {
    const { planId } = await freshPlan(page, info, "Offline");
    const ed = editor(page);
    const circle = await addCircleAt(page, info, planId, await sheetPoint(page, 0.6, 0.45));

    await context.setOffline(true);
    const note = "Written with no signal in the bowl";
    await writeComment(page, info, note);
    await expect(ed.saveStatus).toHaveAccessibleName(/^Offline — \d+ changes? kept on this device/, { timeout: 15_000 });
    // really not on the server yet (the API helper doesn't go through the browser's network)
    expect(liveComments(await getPlan(page, planId), circle.id)).toEqual([]);

    await context.setOffline(false);
    await expectSaved(page);
    await expect.poll(async () => liveComments(await getPlan(page, planId), circle.id).map((c) => c.body)).toEqual([note]);

    await pressAt(page, await sheetPoint(page, EMPTY_SPOT.x, EMPTY_SPOT.y), info);
    await expect(ed.panel).toBeHidden();
    await page.reload();
    await waitCanvas(page);
    await pressAt(page, await circleScreenPoint(page, circle), info);
    await expect(ed.panel).toBeVisible();
    await expect(ed.commentBodies).toHaveText([note]);
  });
});
