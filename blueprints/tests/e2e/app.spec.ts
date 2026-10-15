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
  const before = await ed.circles.count();
  const known = new Set(liveCircles(await getPlan(page, planId)).map((c) => c.id));
  await press(ed.circleMode, info);
  await expect(ed.circleMode).toHaveAttribute("aria-pressed", "true");
  await expect(ed.canvas).toHaveClass(/\bis-add\b/);
  await pressAt(page, at, info);
  // the panel opens on the new circle and the tool goes back to Move
  await expect(ed.panel).toBeVisible();
  await expect(ed.moveMode).toHaveAttribute("aria-pressed", "true");
  await expect(ed.circles).toHaveCount(before + 1);
  // numbered by the server on its first save
  await expect(ed.panelTitle).toHaveText(/^Circle #\d+$/);
  await expectSaved(page);
  const added = liveCircles(await getPlan(page, planId)).filter((c) => !known.has(c.id));
  expect(added).toHaveLength(1);
  return added[0];
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

  test("copy circles to other pages: all of a page's from its menu, one from its panel, ⌘C / ⌘V", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Copy circles");
    const ed = editor(page);
    const [p1, p2, p3, p4] = pages;
    const onPage = async (pageId: string) => liveCircles(await getPlan(page, planId)).filter((c) => c.pageId === pageId);

    // ── two circles on A-101, the first with a comment ──
    // (the panel's × closes it: adding a circle may pan the view, so no spot on the sheet is surely bare)
    const closePanel = ed.panel.getByRole("button", { name: "Close the panel" });
    const gate = await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    await writeComment(page, info, "Mag line at Gate B");
    await press(closePanel, info);
    await expect(ed.panel).toBeHidden();
    const tent = await addCircleAt(page, info, planId, await sheetPoint(page, 0.62, 0.5));
    await press(closePanel, info);
    await expect(ed.panel).toBeHidden();

    // ── the page's ⋯ menu: every circle on the page, to P-1 ──
    if (!isTouch(info)) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Copy circles to another page…" }), info);
    const dialog = page.getByRole("dialog", { name: "Copy circles" });
    await expect(dialog).toBeVisible();
    const circleBoxes = dialog.getByRole("group", { name: "Circles" }).getByRole("checkbox");
    await expect(circleBoxes).toHaveCount(2);
    for (const box of await circleBoxes.all()) await expect(box).toBeChecked();
    const targets = dialog.getByRole("group", { name: "Copy to" }).getByRole("checkbox");
    await expect(targets).toHaveCount(3);
    await expect(dialog.getByRole("button", { name: "Copy 2 circles" })).toBeDisabled(); // no page chosen yet
    await press(dialog.getByRole("checkbox", { name: /P-1/ }), info);
    await expect(dialog.getByRole("checkbox", { name: "Copy their 1 comment too" })).toBeChecked();
    await press(dialog.getByRole("button", { name: "Copy 2 circles" }), info);
    await expect(dialog).toBeHidden();
    const done = ed.toast("Copied 2 circles to “P-1”.");
    await expect(done).toBeVisible();
    await expectSaved(page);

    // same spots, size, comments; new numbers
    let copies = await onPage(p2.id);
    expect(copies).toHaveLength(2);
    const twinOf = (c: { x: number; y: number }) => copies.find((k) => Math.abs(k.x - c.x) < 1e-9 && Math.abs(k.y - c.y) < 1e-9);
    const gateCopy = twinOf(gate)!;
    expect(gateCopy).toBeTruthy();
    expect(gateCopy.r).toBeCloseTo(gate.r, 9);
    expect(gateCopy.num).toBeGreaterThan(tent.num);
    expect(twinOf(tent)).toBeTruthy();
    expect(liveComments(await getPlan(page, planId), gateCopy.id).map((c) => c.body)).toEqual(["Mag line at Gate B"]);
    expect(await onPage(p1.id)).toHaveLength(2); // the originals stay

    // "Show" opens P-1 with the copies on it
    await press(done.getByRole("button", { name: "Show" }), info);
    await expect(ed.pager).toContainText("Page 2 of 4");
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(2);

    // the whole copy is one undo step
    await press(ed.headerUndo, info);
    await expect(ed.circles).toHaveCount(0);
    await expectSaved(page);
    await expect.poll(async () => (await onPage(p2.id)).length).toBe(0);

    // ── a circle's panel: just that circle, to C-201 ──
    await press(ed.prevPage, info);
    await expect(ed.pager).toContainText("Page 1 of 4");
    await waitCanvas(page);
    await pressAt(page, await circleScreenPoint(page, gate), info);
    await expect(ed.panel).toBeVisible();
    await press(ed.panel.getByRole("button", { name: "Copy to another page" }), info);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /#\d+ Mag line at Gate B/ })).toBeChecked();
    await expect(dialog.getByRole("group", { name: "Circles" }).getByRole("checkbox", { checked: true })).toHaveCount(1);
    await press(dialog.getByRole("checkbox", { name: /C-201/ }), info);
    await press(dialog.getByRole("checkbox", { name: "Copy its 1 comment too" }), info); // the circle alone, this time
    await press(dialog.getByRole("button", { name: "Copy 1 circle" }), info);
    await expect(ed.toast("Copied 1 circle to “C-201”.")).toBeVisible();
    await expectSaved(page);
    copies = await onPage(p3.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ x: gate.x, y: gate.y, color: gate.color });
    expect(liveComments(await getPlan(page, planId), copies[0].id)).toHaveLength(0);

    if (isTouch(info)) return;

    // ── desktop: ⌘C on the selected circle, ⌘V on another page ──
    await expect(ed.panel).toBeVisible(); // Circle #… is still selected
    await page.keyboard.press("ControlOrMeta+C");
    await expect(ed.toast(/copied\. Open another page and press (⌘|Ctrl\+)V to paste it\./)).toBeVisible();
    await ed.pageButton("R-1").click();
    await expect(ed.pager).toContainText("Page 4 of 4");
    await waitCanvas(page);
    await page.keyboard.press("ControlOrMeta+V");
    await expect(ed.circles).toHaveCount(1);
    await expect(ed.panel).toBeVisible(); // the copy is selected, ready to move
    await expect(ed.commentBodies).toHaveText(["Mag line at Gate B"]);
    await expectSaved(page);
    copies = await onPage(p4.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ x: gate.x, y: gate.y });
    // pasted again on the same page: it steps aside instead of hiding under the first
    await page.keyboard.press("ControlOrMeta+V");
    await expect(ed.circles).toHaveCount(2);
    await expectSaved(page);
    copies = await onPage(p4.id);
    expect(copies).toHaveLength(2);
    expect(Math.max(...copies.map((c) => c.x))).toBeGreaterThan(gate.x);
  });

  test("Copy circles carries on when its page is deleted on another device; its Show toast goes with the editor", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Copy · page gone");
    const ed = editor(page);
    const [p1, p2, p3] = pages;
    const closePanel = ed.panel.getByRole("button", { name: "Close the panel" });

    // a circle on A-101 and one on C-201 (left open)
    await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    await press(closePanel, info);
    await press(ed.pageButton("C-201"), info);
    await expect(ed.pager).toContainText("Page 3 of 4");
    await waitCanvas(page);
    const other = await addCircleAt(page, info, planId, await sheetPoint(page, 0.5, 0.5));
    await press(closePanel, info);

    if (!isTouch(info)) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Copy circles to another page…" }), info);
    const dialog = page.getByRole("dialog", { name: "Copy circles" });
    const from = dialog.getByLabel("From");
    await expect(from).toHaveValue(p1.id);

    // the other device deletes A-101; this one hears of it when the tab comes back into view
    const row = (await getPlan(page, planId)).pages.find((p) => p.id === p1.id)!;
    const editable = { label: row.label, sortOrder: row.sortOrder, deletedAt: null };
    const res = await page.request.post(`/api/plans/${planId}/sync`, {
      data: { ops: [{ kind: "page", id: p1.id, base: editable, data: { ...editable, deletedAt: Date.now() } }] },
    });
    expect(res.ok()).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    // the dialog moves on to the page that has circles, and copies from there
    await expect(from).toHaveValue(p3.id);
    await expect(dialog.getByRole("group", { name: "Circles" }).getByRole("checkbox")).toHaveCount(1);
    await expect(dialog.getByRole("group", { name: "Copy to" }).getByRole("checkbox")).toHaveCount(2); // P-1, R-1
    await press(dialog.getByRole("checkbox", { name: /P-1/ }), info);
    await press(dialog.getByRole("button", { name: "Copy 1 circle" }), info);
    const done = ed.toast("Copied 1 circle to “P-1”.");
    await expect(done.getByRole("button", { name: "Show" })).toBeVisible();

    // leaving the editor takes the toast at once (its Show would have nowhere to go) —
    // well before its own 8 s are up
    await press(page.getByTitle("Back to event plans"), info);
    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(done).toHaveCount(0, { timeout: 1_500 });

    // and the copy is saved (leaving sends it)
    await expect
      .poll(async () => liveCircles(await getPlan(page, planId)).filter((c) => c.pageId === p2.id).map((c) => [c.x, c.y]))
      .toEqual([[other.x, other.y]]);
  });

  test("duplicate a page with its circles and comments, undo it, then duplicate just the page under a new name", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Duplicate page");
    const ed = editor(page);
    const [p1] = pages;
    const closePanel = ed.panel.getByRole("button", { name: "Close the panel" });

    const gate = await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    await writeComment(page, info, "Mag line at Gate B");
    await press(closePanel, info);
    await expectSaved(page);

    // ── with everything ──
    if (!isTouch(info)) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Duplicate page…" }), info);
    const dialog = page.getByRole("dialog", { name: "Duplicate page" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name of the copy")).toHaveValue("A-101 (copy)");
    await expect(dialog.getByRole("radio", { name: "The page, its 1 circle and their 1 comment" })).toBeChecked();
    await press(dialog.getByRole("button", { name: "Duplicate" }), info);
    await expect(dialog).toBeHidden();
    await expect(ed.toast("Duplicated “A-101” as “A-101 (copy)” with 1 circle.")).toBeVisible();

    // the copy opens, right after the original, with the circle and its comment
    await expect(ed.pager).toContainText("Page 2 of 5");
    await expect(ed.pager).toContainText("A-101 (copy)");
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(1);
    await expectSaved(page);
    let doc = await getPlan(page, planId);
    const dup = livePages(doc)[1];
    expect(dup.label).toBe("A-101 (copy)");
    expect(dup).toMatchObject({ status: "ready", width: p1.width, height: p1.height });
    const onDup = liveCircles(doc).filter((c) => c.pageId === dup.id);
    expect(onDup).toHaveLength(1);
    expect(onDup[0]).toMatchObject({ x: gate.x, y: gate.y, r: gate.r, color: gate.color });
    expect(onDup[0].num).not.toBe(gate.num);
    expect(liveComments(doc, onDup[0].id).map((c) => c.body)).toEqual(["Mag line at Gate B"]);

    // ── one undo takes the whole duplicate back ──
    await press(ed.headerUndo, info);
    await expect(ed.pageItems).toHaveCount(4);
    await expect(ed.pageMenu("A-101 (copy)")).toHaveCount(0);
    await expectSaved(page);
    await expect.poll(async () => livePages(await getPlan(page, planId)).map((p) => p.label)).toEqual(["A-101", "P-1", "C-201", "R-1"]);

    // ── just the page, under its own name ──
    if (!isTouch(info)) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Duplicate page…" }), info);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name of the copy").fill("A-101 Day 2");
    await press(dialog.getByRole("radio", { name: "Just the page" }), info);
    await press(dialog.getByRole("button", { name: "Duplicate" }), info);
    await expect(ed.toast("Duplicated “A-101” as “A-101 Day 2”.")).toBeVisible();
    await expect(ed.pager).toContainText("A-101 Day 2");
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(0);
    await expectSaved(page);

    await page.reload();
    await waitCanvas(page);
    await expect(ed.pageItems).toHaveCount(5);
    doc = await getPlan(page, planId);
    expect(livePages(doc).map((p) => p.label)).toEqual(["A-101", "A-101 Day 2", "P-1", "C-201", "R-1"]);
    expect(liveCircles(doc).filter((c) => c.pageId === livePages(doc)[1].id)).toHaveLength(0);
  });

  test("Duplicate page: a lost reply and a retry make one copy with its circles; the dialog goes when its page is deleted elsewhere", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Duplicate · lost reply");
    const ed = editor(page);
    const [p1, p2] = pages;
    await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    await press(ed.panel.getByRole("button", { name: "Close the panel" }), info);
    await expectSaved(page);

    const dialog = page.getByRole("dialog", { name: "Duplicate page" });
    const openDuplicate = async (label: string) => {
      if (!isTouch(info)) await ed.pageButton(label).hover();
      await press(ed.pageMenu(label), info);
      await press(page.getByRole("menuitem", { name: "Duplicate page…" }), info);
      await expect(dialog).toBeVisible();
    };

    // ── the first reply is lost: the server made the copy, this device never heard ──
    let lost = 0;
    await page.route("**/api/pages/*/duplicate", async (route) => {
      if (lost++ === 0) {
        await route.fetch(); // it reaches the server…
        await route.abort("connectionreset"); // …and the answer never comes back
      } else await route.continue();
    });
    await openDuplicate("A-101");
    const name = dialog.getByLabel("Name of the copy");
    if (isTouch(info)) {
      // the iPad keyboard's "done" key only puts the keyboard away
      await press(name, info);
      await name.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(name).not.toBeFocused();
    }
    await press(dialog.getByRole("button", { name: "Duplicate" }), info);
    await expect(dialog.getByRole("alert")).toContainText("The page wasn't duplicated.");
    // trying again finishes that same copy
    await press(dialog.getByRole("button", { name: "Duplicate" }), info);
    await expect(dialog).toBeHidden();
    await expect(ed.toast("Duplicated “A-101” as “A-101 (copy)” with 1 circle.")).toBeVisible();
    await expect(ed.pager).toContainText("Page 2 of 5");
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(1);
    await expectSaved(page);
    const doc = await getPlan(page, planId);
    expect(livePages(doc).map((p) => p.label)).toEqual(["A-101", "A-101 (copy)", "P-1", "C-201", "R-1"]);
    expect(liveCircles(doc).filter((c) => c.pageId === livePages(doc)[1].id)).toHaveLength(1);
    await page.unroute("**/api/pages/*/duplicate");

    // ── the page is deleted on another device while the dialog is open ──
    await openDuplicate("P-1");
    const row = (await getPlan(page, planId)).pages.find((p) => p.id === p2.id)!;
    const editable = { label: row.label, sortOrder: row.sortOrder, deletedAt: null };
    const res = await page.request.post(`/api/plans/${planId}/sync`, {
      data: { ops: [{ kind: "page", id: p2.id, base: editable, data: { ...editable, deletedAt: Date.now() } }] },
    });
    expect(res.ok()).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(dialog).toBeHidden();
    await expect(ed.toast("That page was deleted on another device, so it wasn't duplicated.")).toBeVisible();
    await expect(ed.pageMenu("P-1")).toHaveCount(0);
    expect(livePages(await getPlan(page, planId)).map((p) => p.label)).toEqual(["A-101", "A-101 (copy)", "C-201", "R-1"]);
    void p1;
  });

  test("Duplicate page: the original deleted elsewhere while the copy is being made — the copy still lands, no contradicting message", async ({ page }, info) => {
    const { planId, pages } = await freshPlan(page, info, "Duplicate · deleted meanwhile");
    const ed = editor(page);
    const [p1] = pages;
    await addCircleAt(page, info, planId, await sheetPoint(page, 0.3, 0.38));
    await press(ed.panel.getByRole("button", { name: "Close the panel" }), info);
    await expectSaved(page);

    // the server makes the copy, then A-101 is deleted on another device and this one hears of it — all before the reply arrives
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/pages/*/duplicate", async (route) => {
      const res = await route.fetch();
      await held;
      await route.fulfill({ response: res });
    });
    if (!isTouch(info)) await ed.pageButton("A-101").hover();
    await press(ed.pageMenu("A-101"), info);
    await press(page.getByRole("menuitem", { name: "Duplicate page…" }), info);
    const dialog = page.getByRole("dialog", { name: "Duplicate page" });
    await press(dialog.getByRole("button", { name: "Duplicate" }), info);
    await expect(dialog.getByRole("button", { name: "Duplicating…" })).toBeVisible();
    await expect.poll(async () => livePages(await getPlan(page, planId)).length).toBe(5); // made on the server

    const row = (await getPlan(page, planId)).pages.find((p) => p.id === p1.id)!;
    const editable = { label: row.label, sortOrder: row.sortOrder, deletedAt: null };
    expect(
      (await page.request.post(`/api/plans/${planId}/sync`, { data: { ops: [{ kind: "page", id: p1.id, base: editable, data: { ...editable, deletedAt: Date.now() } }] } })).ok(),
    ).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(ed.pageMenu("A-101")).toHaveCount(0); // this device knows A-101 is gone…
    await expect(dialog).toBeVisible(); // …and the dialog waits for its answer

    release();
    await expect(dialog).toBeHidden();
    await expect(ed.toast("Duplicated “A-101” as “A-101 (copy)” with 1 circle.")).toBeVisible();
    await expect(ed.toast(/wasn't duplicated/)).toHaveCount(0);
    await expect(ed.pager).toContainText("A-101 (copy)");
    await waitCanvas(page);
    await expect(ed.circles).toHaveCount(1);
    await expectSaved(page);
    await page.unroute("**/api/pages/*/duplicate");
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
