// Browser tests (Playwright), on a desktop-sized screen and an iPad-sized
// touch screen.
//
//   npm run build            # the tests drive the BUILT app (dist/)
//   npx playwright test      # or: npm run test:e2e
//   npx playwright test --project=ipad tests/e2e/app.spec.ts
//
// tests/e2e/app.spec.ts drives the real app: the global setup (in
// tests/e2e/helpers.ts) makes the sample PDFs if they're missing, starts
// `node dist/server/index.js` on a free port with an empty temporary data
// folder and its own password, and stops it (and deletes the folder) at the
// end. Point the suite at a server that's already running instead with
// E2E_BASE_URL (+ E2E_PASSWORD).
//
// tests/e2e/canvas.spec.ts is self-contained (it serves its own canvas
// harness with Vite) and sets its own desktop and iPad screens, so it runs
// once, under the desktop project.
//
// Browser binary: PW_CHROMIUM_PATH when set; else the sandbox's Chromium
// when present; else Playwright's own (`npx playwright install chromium`).

import fs from "node:fs";
import { defineConfig } from "@playwright/test";

const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = process.env.PW_CHROMIUM_PATH || (fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/helpers.ts",
  // One shared server whose render queue does one page at a time: run the
  // tests one after another (each test still makes its own event plan).
  workers: 1,
  fullyParallel: false,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
  use: {
    browserName: "chromium",
    // a UTF-8 locale: without one Chromium names any download with a non-ASCII name "download"
    launchOptions: { ...(executablePath ? { executablePath } : {}), env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" } },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
    },
    {
      name: "ipad",
      // iPad Air / Pro 11" in landscape: a touch screen at 2x. isMobile stays
      // off — iPadOS Safari asks for desktop pages and ignores the viewport meta.
      use: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: false },
      // the canvas spec brings its own iPad describes (and runs under desktop)
      testIgnore: /canvas\.spec\.ts$/,
    },
  ],
});
