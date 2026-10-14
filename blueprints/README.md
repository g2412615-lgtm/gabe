# KWE Blueprints

Mark up event blueprints on a computer or an iPad. Upload a blueprint PDF.
Each page becomes a sheet you can flip to and label. Drop circles on the
spots that matter, size them, and keep comments on each one. A circle lights
up when you point at it, and its comments open in the sidebar on the right.
Every change saves by itself, even on patchy stadium Wi‑Fi.

It's a Kilowatt Events tool and uses the Kilowatt Events brand: gold header
band, black and white, square corners, Montserrat headlines (see
[docs/BRAND.md](docs/BRAND.md)). The layout and interactions started from
DeployMap's. It runs at **https://blueprints.gabeweb.com**; see
[DEPLOY.md](DEPLOY.md) to put it online or update it.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173 — password "dev"
```

`npm run dev` starts the API server on :8787 and Vite on :5173. The data
lives in `./data` (gitignored).

## Checks

```bash
npm run typecheck
npm run fixtures   # sample blueprints (fictional "Millrace Stadium") for the tests
npm test           # unit + server tests (vitest)
npm run build
npm run test:e2e   # browser tests on desktop and iPad-sized screens (Playwright)
```

GitHub runs all of these on every change to this folder
(`.github/workflows/blueprints-ci.yml`).

## How it's built

- `src/server/`: the Node server.
  - Hono with SQLite (`node:sqlite`).
  - Sign-in, streamed uploads, and a render queue. Each PDF page is turned into a preview and deep-zoom tiles with mupdf and sharp, in its own process.
  - The `/sync` endpoint that autosave talks to.
  - Daily database snapshots, and a purge of anything deleted more than 30 days ago.
- `src/client/sync/`: the autosave engine.
  - Every change is kept on the device first, then saved in the background.
  - It retries, works offline, survives sign-out, and keeps edits made from another device.
  - It also handles undo and redo.
- `src/client/editor/canvas/`: the blueprint view.
  - Pan, pinch, wheel and trackpad zoom, and deep-zoom tiles.
  - Circles, plus the gestures to add, resize and move them.
- `src/client/editor/`: the editor screen.
  - Page sidebar, notes list, and the comments panel.
  - Keyboard shortcuts.
- `src/client/home/`, `src/client/auth/`, `src/client/ui/`, `src/client/styles/`: the event plans list, sign-in, and the UI kit (structure ported from DeployMap, styled with the Kilowatt Events tokens in `styles/tokens.css`).
- `public/brand/`: the official Kilowatt Events logo files, used as supplied (`ui/Logo.tsx`).
- `docs/SPEC.md` has the full specification: data model, API, sync rules, and how each screen should behave. `docs/BRAND.md` has the brand rules.
