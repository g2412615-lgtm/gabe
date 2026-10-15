# KWE Blueprints — product and build specification

A private web app for one owner (a stadium/event security operations lead,
not a developer) to mark up event blueprints: upload blueprint PDFs, flip
between their pages, drop resizable circles on spots, and keep comments on
each circle. Used on a desktop computer **and an iPad** (touch first-class).
Every change autosaves continuously. It wears the Kilowatt Events brand
(KWE Ops Board kit — see `docs/BRAND.md`); its layout and interactions follow
the owner's existing "dot map" app, DeployMap.

This file is the contract between the parts of the codebase. Read it fully
before writing code. When this spec and your instincts disagree, follow the
spec; when the spec is silent, follow `docs/BRAND.md` for the look and
DeployMap's conventions for behaviour (reference reports below), and write
the simplest robust thing.

## 0. Reference material

The look is the Kilowatt Events brand: `docs/BRAND.md` (rules and logo
use) and `src/client/styles/tokens.css` (the brand's values under the app's
token names) are the visual source of truth. The official logo files are in
`public/brand/` and are shown through `src/client/ui/Logo.tsx`, unaltered.

The layout and interaction reference is DeployMap, the owner's dot map app
(private repository `g2412615-lgtm/deploymap`, read-only from here); its
primitives were ported into `src/client/ui/` and `src/client/styles/` and
then restyled to the brand. DeployMap's `components/editor/Canvas.tsx` and
RUNBOOK.md are the places to look when a new screen needs an interaction
pattern this app doesn't have yet.

## 1. Stack and layout

- Node 22 (`node:sqlite` built in — no native DB driver), TypeScript, ESM.
- Server: Hono (`hono`, `@hono/node-server`), SQLite via `node:sqlite` `DatabaseSync`, `mupdf` (WASM) + `sharp` for rendering in a separate child process per page.
- Client: React 19 SPA built by Vite 7. No UI framework, no CSS framework, no state library. Plain CSS files using the Kilowatt Events tokens (`tokens.css`).
- Tests: Vitest (server + unit), Playwright (end-to-end, later).

```
blueprints/
  index.html  vite.config.ts  tsconfig.json  package.json      (foundation — done)
  public/                       icons + manifest                (foundation — done)
  scripts/                      dev.mjs, build-server.mjs, hash-password.mjs, make-icons.mjs (done)
  src/shared/                   types.ts constants.ts merge.ts geometry.ts (done — import, don't change without need)
  src/client/api.ts             API client + upload with progress + asset URLs + newId (done)
  src/client/router.tsx         tiny router: useRoute, navigate, Link, goToLogin, addLeaveGuard, replaceQuery (done)
  src/client/main.tsx, App.tsx  entry + routes (done)
  src/server/**                 SERVER agent
  src/client/styles/tokens.css, base.css, components.css     UI agent
  src/client/ui/**              UI agent (primitives)
  src/client/home/**            UI agent (home page)
  src/client/auth/**            UI agent (login page)
  src/client/sync/**            SYNC agent (store + sync engine)
  src/client/editor/canvas/**   CANVAS agent
  src/client/styles/canvas.css  CANVAS agent
  src/client/editor/*.tsx|ts    EDITOR agent (editor shell, sidebars, comments panel)
  src/client/styles/editor.css  EDITOR agent
  tests/server/**               SERVER agent
  tests/unit/**                 SYNC agent (and anyone with pure logic)
  tests/fixtures/make-fixtures.mjs  sample PDFs (done; `npm run fixtures` → tests/fixtures/out/)
```

Only create/modify files you own. If you need something from another part,
code against the interface in this spec. If an interface is truly missing,
add the smallest thing to your own files and mention it in your final report.

Imports: relative paths (`../../shared/types`). No path aliases.

## 2. Data model

See `src/shared/types.ts` (authoritative). Summary:

- **Plan** (an "event plan"): `name`. Home page lists plans.
- **Source**: an uploaded file (PDF or PNG/JPEG), kept verbatim on disk.
- **Page**: one page of a source, in a plan. Owner-editable `label` and `sortOrder`. Server-owned render fields (`status`, sizes, tiles, `assetKey`).
- **Circle**: on a page. `x`,`y` = centre as fractions of page width/height; `r` = radius as a fraction of the page's **long side**; `color` (a `CIRCLE_COLORS` key: `gold` (default), `black`, `red`, `blue`, `green`); optional `title`; server-assigned per-plan `num` (1, 2, 3… never reused; 0 until first save).
- **Comment**: on a circle. `body` text.

All rows: `createdAt`, `updatedAt`, `deletedAt` (soft delete / tombstone), `rev`.
Visibility cascades without touching children: a circle is hidden if it or its
page is deleted; a comment is hidden if it, its circle or the circle's page is
deleted. Undoing a page delete brings its circles back.

IDs: client-generated UUIDs for circles and comments (`newId()` in api.ts);
server-generated UUIDs for plans, sources, pages.

## 3. HTTP API (server)

All JSON. Errors: `{ "error": "<plain sentence for the owner>" }` with a fitting
status. Every `/api/*` route except `/api/login`, `/api/health` requires the
session cookie (401 otherwise). Every non-GET request must be same-origin:
reject (403) if `Sec-Fetch-Site` is present and not `same-origin`/`none`, or if
`Origin` is present and its host differs from the request `Host`. Responses
from `/api/*` (except assets) send `Cache-Control: no-store`.

| Method & path | Body / query | Reply |
|---|---|---|
| `POST /api/login` | `{ password }` | `{ ok: true }` + `Set-Cookie`. 401 `"That password isn't right."`. Per-IP throttle: 10 failures / 15 min → 429 `"Too many tries — wait 15 minutes and try again."`. 400 ms delay on failure. |
| `POST /api/logout` | `{}` | `{ ok: true }`, clears cookie |
| `GET /api/me` | | `{ ok: true }` (401 if not signed in) |
| `GET /api/health` | | `{ ok, checks: { database, storage }, time }` — 200/503, public |
| `GET /api/plans` | | `{ plans: PlanSummary[] }` — non-deleted, newest `updatedAt` first |
| `POST /api/plans/upload?name=&filename=` | raw file body | `UploadResponse` — creates plan + source + queued pages in one go |
| `GET /api/plans/:id` | | `PlanDoc` (plan + all pages/circles/comments **including tombstones**) — 404 if the plan doesn't exist or is deleted |
| `PATCH /api/plans/:id` | `{ name?, deleted?: boolean }` | `PlanRow` (works on deleted plans so Undo can restore) |
| `GET /api/plans/:id/pages` | | `{ pages: PageRow[] }` (incl. tombstones) — polled during rendering |
| `POST /api/plans/:id/files?filename=` | raw file body | `UploadResponse` — appends pages after the current last page |
| `POST /api/plans/:id/sync` | `SyncRequest` | `SyncResponse` (see §4) |
| `POST /api/pages/:id/retry` | `{}` | `{ page }` — re-queues a failed page (new assetKey) |
| `POST /api/pages/:id/duplicate` | `{ id?, label? }` | 201 `{ page, pages }` — a copy of a live page right after it (between it and the next live page in `comparePages` order; the live pages are renumbered 0, 1, 2… when there's no room). Named `label` (cleaned), else "A-101 (copy)", "(copy 2)"… (`shared/labels.ts`). A `ready` page's assets are hard-linked into the copy's own folder (instant, no extra space; each page still owns its folder); any other page is queued for a fresh render from the same source. No circles: the device copies those (`store.addDuplicatedPage`). `id` (optional, chosen by the device once per dialog) makes it safe to retry after a lost reply: when a page with that id is already this page's live copy, it's returned with 200 and nothing is made; an id of any other page, or of that copy deleted meanwhile, → 409. 404 for a missing/deleted page or plan |
| `GET /api/pages/:id/:assetKey/preview.webp` | | preview image (long side ≤ 2048) |
| `GET /api/pages/:id/:assetKey/thumb.webp` | | thumbnail (long side ≤ 480) |
| `GET /api/pages/:id/:assetKey/tiles/:level/:col_:row.(png|jpeg)` | | one deep-zoom tile |
| `GET /api/sources/:id/original` | | the uploaded file as-is (`Content-Disposition: attachment`) |

Assets: `Cache-Control: private, max-age=31536000, immutable` (the assetKey in
the path changes on every re-render), `X-Content-Type-Options: nosniff`,
correct `Content-Type`. 404 when missing. Validate every path segment
(ids/assetKey: `[A-Za-z0-9_-]{1,64}`, level/col/row: small non-negative ints).

Uploads: raw body (not multipart), `Content-Type` is the file's type; the
server streams the body to a temp file, enforcing `MAX_UPLOAD_MB` (413
`"That file is over 150 MB. Export a smaller PDF or split the set."`), then
sniffs the bytes (`%PDF-`, PNG, JPEG magic — never trust name or type; 400
`"That file isn't a PDF, PNG or JPG."`). A PDF is opened with mupdf **inside a
worker** (never on the main thread) to count pages, read page labels and
outline titles, and check `needsPassword()` (400 `"That PDF is password-protected. Save an unlocked copy and upload that."`);
corrupt → 400 `"That PDF couldn't be read. Try exporting it again."`. More than
`MAX_PAGES_PER_FILE` pages → 400. Then the file moves to `uploads/`, and the
source + one queued page per PDF page are inserted in one transaction. The
reply comes back right away; rendering continues in the background.

Default page labels: the PDF page label if it isn't purely numeric, else the
outline (bookmark) title pointing at that page, else `Page N` where N counts
from the plan's existing page count + 1. Images: the file name without its
extension. New plan name (`name` query) defaults to the file name without
extension; trim, collapse whitespace, cap at `MAX_PLAN_NAME_CHARS`.

## 4. Sync semantics (server side and client side)

`POST /api/plans/:id/sync` with `{ ops: SyncOp[] }` (≤ 2000 ops, ≤ 2 MB).
One SQLite transaction for the whole batch. Process plan ops, then pages,
then circles, then comments (so a comment can follow its new circle in the
same batch). For each op:

1. Validate kind/id. The row (if it exists) must belong to plan `:id`; else reject `"not in this plan"`.
2. **Row missing:**
   - `circle`: needs `data.pageId` naming a page of this plan (deleted is OK), numbers finite; insert with `num = max(num in plan) + 1`, `createdAt = data.createdAt` if it's within the last 30 days and not more than a day in the future, else now.
   - `comment`: needs `data.circleId` naming a circle of this plan; insert.
   - `plan`/`page`: reject `"unknown"` (those are created by uploads only).
3. **Row exists:** for each editable field `f` (types.ts `EDITABLE`) present in `data`: apply it when `base` is null or `data[f] !== base[f]`. Never touch non-editable fields (pageId, circleId, num…). If anything changed: `rev += 1`, `updatedAt = now`.
4. **Clean, don't reject** values: clamp `x`,`y` to [0,1], `r` to [MIN_CIRCLE_R, MAX_CIRCLE_R]; unknown `color` → keep the current (or default), and read the pre-rebrand names `amber`/`purple` as `gold`/`black` (migration 3 renamed the stored rows); trim/cap strings (`MAX_*_CHARS`); `deletedAt` must be null or a number (use the server's now for any non-null value); `sortOrder` finite.
5. If any op in the batch changed something, set the plan's `updatedAt = now` (the home list sorts by it).

Reply: `rows` = the current server copy of every row any op referenced
(accepted, cleaned or rejected-but-existing), `rejected`, `serverTime`.
Ops are idempotent: replaying a batch changes nothing the second time.

Client-side merge rule (implemented in `src/shared/merge.ts`): editable fields
the client changed since `base` keep local values; everything else takes the
server's.

## 5. Rendering pipeline (server)

A persistent queue in the database: pages with `status = 'queued'`
(and `'rendering'`/`'preview'` found at boot → back to `'queued'`), skipping
pages whose page or plan is deleted. Concurrency 1. Each render (and each
upload inspection) runs in its own **child process** (`child_process.fork` of
`src/server/render/worker.ts`, bundled as `dist/server/render-worker.js`) whose
`oom_score_adj` is 1000, so if a page needs more memory than the machine has,
the kernel kills the renderer, never the server. A watchdog in the child exits
it if the server dies. Every attempt is counted (`render_attempts`): a page
whose render was killed or timed out twice is marked failed ("This page is too
large or complex to prepare. Try exporting it as a smaller PDF.") and is never
auto-retried at boot; Retry resets the count, and a graceful shutdown hands the
attempt back. A timeout (default 180 s) SIGKILLs the child and removes its
partial output. If the preview was already made, the page ends `ready` with no
tiles (`maxLevel 0`) — viewable, just without deep zoom — instead of failing.
Worker steps:

1. Open the source. PDF: `mupdf.Document.openDocument(bytes, "application/pdf")`, `loadPage(i)`, bounds = `page.getBounds()` (CropBox, rotation applied). Image: `sharp(file).rotate()` (bake EXIF orientation) → raw RGB.
2. Scale = `Math.min(300 / 72, 8000 / longSide)` for PDFs (DeployMap's proven numbers), further reduced so the page is at most ~40 MP; images: same caps (downscale only).
3. `page.toPixmap(Matrix.scale(s, s), ColorSpace.DeviceRGB, false, true)` → copy pixels out (`Buffer.from(pix.getPixels())`, check stride) → `destroy()` pixmap/page/doc.
4. Write, under `DATA_DIR/assets/<pageId>/<assetKey>/` (write to a temp dir, then rename into place):
   - `preview.webp` — fit inside 2048×2048, quality 82. **Post a message right after this** so the main thread sets `status = 'preview'` with `width`, `height`, `previewW`, `previewH` (the page is viewable now).
   - `thumb.webp` — fit inside 480×480, quality 78.
   - Tiles: PNG for line art, JPEG q85 for scans/photos (PDF pages are sampled: JPEG when PNG would cost > 0.4 bytes/pixel and > 2× the JPEG size; image uploads are always JPEG) `.tile({ size: 512, overlap: 0, layout: "dz", depth: "onetile" }).toFile(<dir>/tiles.dz)`. Then move `tiles_files/<level>/` folders to `<dir>/tiles/<level>/` (served as `tiles/<level>/<col>_<row>.<ext>`), delete the `.dzi` and `vips-properties.xml`. Record `tileSize = 512`, `maxLevel` (the highest numbered folder; full resolution), `minLevel` (the lowest), `tileFormat`.
5. Main thread sets `status = 'ready'` and the tile fields. On any error: `status = 'failed'`, `error` = a plain sentence, and log the technical error.

Measured locally: an ARCH D (36×24 in) page renders in ~0.8 s and tiles in
~1.4 s (PNG palette) on 4 cores; expect several times slower on a 1-CPU host.

`assetKey`: a fresh random id per render attempt (so URLs never collide with
a stale cache). Delete the previous assetKey folder after a successful
re-render.

## 6. Server details

- Config (env): `PORT` (8080), `DATA_DIR` (`./data`), `APP_PASSWORD` or `APP_PASSWORD_HASH` (scrypt format `scrypt:<salt b64url>:<hash b64url>` from `scripts/hash-password.mjs`), `SESSION_SECRET` (optional: if missing, generate 48 random bytes once and keep them in `DATA_DIR/.session-secret`, mode 600), `NODE_ENV`. In production with no password configured, every API answers 503 `"The app isn't set up yet: no password is configured."` (fail closed). `MAX_UPLOAD_MB` from constants.
- Session cookie `bpn_session` = `v2.<issuedMs>.<expiresMs>.<hmacSHA256hex>`, HttpOnly, SameSite=Lax, Path=/, Secure when the request is HTTPS (check `x-forwarded-proto` too). Renewed about weekly while in use, never past one year from the original sign-in. The signing key mixes SESSION_SECRET with a fingerprint of the password config, so **changing the password signs every device out** (the way to cut off a lost iPad).
- Free-space guard: uploads are refused (507, plain message) when they'd leave less than 256 MB free; renders fail with a storage message; `/api/health` reports `storage: "full"` with a 503.
- Data layout: `DATA_DIR/app.db` (WAL mode, `foreign_keys = ON`, `busy_timeout`), `DATA_DIR/uploads/<sourceId>.<pdf|png|jpg>`, `DATA_DIR/assets/<pageId>/<assetKey>/…`, `DATA_DIR/tmp/`, `DATA_DIR/backups/`.
- Migrations: `PRAGMA user_version`; an ordered array of SQL strings applied in a transaction at boot.
- Indexes: pages(plan_id, sort_order), circles(plan_id), circles(page_id), comments(plan_id), comments(circle_id).
- Backups: once a day (wall-clock stamp file `DATA_DIR/.last-backup`, checked at boot and every 10 min), `VACUUM INTO DATA_DIR/backups/app-<UTC stamp>.db`; keep the newest 14. (Off-site copies to Cloudflare R2 are handled by `boot.sh` with rclone, outside the app.)
- Purge: daily (stamp file), hard-delete tombstoned comments/circles/pages/plans whose `deletedAt` is older than `PURGE_AFTER_DAYS`, with their children and files (assets folder, and the source file once no page references it).
- Static: serve `dist/client` (built SPA). Hashed files under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`. Any non-`/api` GET that isn't a file → `index.html` (SPA routes). Security headers on HTML: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, a CSP allowing self only (`default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`).
- Logging: one line per request (method, path, status, ms) except asset hits; errors with stack.
- Graceful shutdown on SIGTERM: stop accepting, let the queue's current worker finish or terminate after 10 s, close the DB.
- Entry `src/server/index.ts`; worker `src/server/render/worker.ts`. In development the server runs under `tsx` (the worker file is `.ts`); in production both are bundled to `dist/server/index.js` and `dist/server/render-worker.js` (see `scripts/build-server.mjs`) — resolve the worker path accordingly (e.g. `new URL(import.meta.url.endsWith(".ts") ? "./render/worker.ts" : "./render-worker.js", import.meta.url)`).
- `package.json` `start` runs `node --disable-warning=ExperimentalWarning dist/server/index.js`.
- Export a `createApp(config)` (returns the Hono app + a `close()`), so tests can start the server on a temp DATA_DIR with a random port.

## 7. Client architecture

### 7.1 UI kit (`src/client/ui/`, UI agent)

DeployMap's primitives (report-design.md §3, §9) as React components and CSS, styled to the Kilowatt Events brand:

- `icons.tsx` — DeployMap's Feather-style `Icon` + all icons the app needs: `IconChevron`, `IconChevronLeft`, `IconPlus`, `IconMinus`, `IconUpload`, `IconX`, `IconCheck`, `IconMore`, `IconTrash`, `IconComment`, `IconSidebar`, `IconCircle`, `IconFit`, `IconEdit`, `IconSearch`, `IconArrowLeft`, `IconUndo`, `IconRedo`, `IconHand` (move/pan), `IconLayers` (pages), `IconList` (notes), `IconAlert`, `IconDownload`, `IconLogout`, `IconRefresh`. Same signature: `(p: { size?: number; className?: string }) => JSX`.
- `Logo.tsx` — the Kilowatt Events lockup or bulb from `public/brand/`, at the file's own proportions (never below 75 px wide for the lockup), black or white to suit what it sits on (`tone`: `on-gold`, `on-light`, `on-dark`, or `page` to follow the theme).
- `Toaster.tsx` + `notify.ts` — `notify(message, kind?: "info"|"ok"|"error", opts?: { action?: { label: string; run: () => void }; duration?: number })`. Up to 4 toasts, dedupe by message, ok/info 4 s, error 7 s, action toasts 8 s. `role="status" aria-live="polite"`. Toasts can carry an **Undo** action button.
- `Dialog.tsx` — accessible modal (`.drawer-overlay` > `.drawer.es-dialog`): `role="dialog" aria-modal aria-labelledby`, Escape closes, click outside closes, focus first field / primary button, returns focus. Plus `confirmDialog({ title, body, confirmLabel, danger? }): Promise<boolean>` mounted via a portal host (no native `confirm()`).
- `Menu.tsx` — DeployMap's HeaderMenu (`.hmenu`, `.hmenu-pop`) with Escape, outside `pointerdown`, `aria-haspopup`/`aria-expanded`, `role="menu"`/`menuitem`, arrow-key navigation, items `{ label, icon?, danger?, disabled?, onSelect }` plus separators. Pop-up flips/aligns to stay on screen (prop `align: "left" | "right"`).
- `InlineRename.tsx` — DeployMap's `.model-name-input` pattern: borderless input, commits on blur and Enter, Escape reverts, `onCommit(value)` only when changed and non-empty. Also controllable `editing` mode for "Rename" menu items.
- `Dropzone.tsx` — DeployMap's `.dropzone` label with hidden `<input type="file">` (accept `UPLOAD_ACCEPT`, `multiple` prop), drag-over state, keyboard accessible.
- `Progress.tsx` — thin progress bar (KW Gold fill on a hairline track) with label.
- `Spinner.tsx`, `SaveStatus.tsx` (the `.save-status` tag — states in §7.4), `EmptyArt.tsx` (`.empty-art`: a sheet with ink rings and one gold-filled circle).
- `AppHeader.tsx` — the sticky gold header band (72 px, 64 px on phones; gold with black content in both themes): `lockup-black.png` at 34 px tall, a 2 px black divider and the product name "Blueprints" in Montserrat 900; right side: a `Menu` with "Sign out" (POST /api/logout then navigate to /login).

### 7.2 Styles (UI agent: tokens.css, base.css, components.css)

- `tokens.css`: the app's token names (`--bg`, `--surface*`, `--border*`, `--text*`, `--accent*`, …) mapped to the Kilowatt Events values, light by default and dark via `prefers-color-scheme` / `<html data-theme>`; radii 0; shadows only for floating UI; plus `--canvas-paper: #ffffff` and `--hit: 44px`. Fonts: `--font-head` is Montserrat (600/800/900, self-hosted through `@fontsource/montserrat`, imported in `main.tsx`); `--font` is `"Aptos", "Segoe UI", -apple-system, …, sans-serif` (Aptos isn't hosted). Do not add external font requests: the CSP forbids them.
- `base.css`: base elements (h1–h3 in Montserrat 900, gold focus ring and selection, gold link underline), `html, body { height: 100%; overscroll-behavior: none }`, `body { background: var(--bg) }`, `#root { min-height: 100% }`, focus ring, selection, reduced-motion rule, `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation` on interactive elements.
- `components.css`: buttons (all variants), inputs/select/textarea, `.field`, `.card*`, `.event-list`/`.event-row`, `.pill`/`.chip`, `.banner*`, `.empty*`, `.skeleton`, `.spinner`, `.toaster`/`.toast*`, `.hmenu*`, `.drawer*`/`.es-dialog*`, `.app-header*`, `.brand*`, `.page*`, `.eyebrow`, `.subtitle`, `.dropzone`, `.upload-line`, `.model-name-input`, `.save-status`, `.hdr-group`, `.evtabs`, `.caps`, `.muted`, `kbd`, `.login-card`.
- **Touch sizing** (DeployMap has none — required here): `@media (pointer: coarse) { … }` gives buttons, menu items, list rows and form controls a ≥ 44px hit size (min-height or padding), and inputs/textareas `font-size: 16px` (stops iOS focus-zoom). Hover styles that would stick after a tap are wrapped in `@media (hover: hover)`.
- Use `100dvh` (with a `100vh` fallback) for full-height layouts; respect `env(safe-area-inset-*)` in fixed bars.

### 7.3 Screens owned by the UI agent

**Login (`src/client/auth/LoginPage.tsx`)** — a plain page with a thin gold bar on top and a centred `.login-card`: the lockup (black or white by theme), a 2 px rule, h1 "Blueprints" (Montserrat 900, uppercase), a one-line lead, one password field (`autocomplete="current-password"`, plus a hidden `username` input with value `owner` so password managers behave), primary "Sign in" (black with gold text; spinner + "Signing in…"), `.error-text` with the server's message. On success navigate to `next`.

**Home (`src/client/home/HomePage.tsx`)** — "Event plans":
- `AppHeader`, then the screen's one black strip (`.strip.home-strip`): h1 "Event plans" in Montserrat 900, subtitle "Upload a blueprint, circle the spots that matter, and keep your notes right on them.", and the gold accent button `IconUpload` "Upload blueprint". Then `.page.wide.home-body` with the rest.
- A `.home-bar`: search input (filters by name, with `IconSearch`), sort select (Recently edited / Name / Newest).
- A ruled list (2 px strong top rule, 1 px hairlines between rows) of `.event-row`: thumbnail (first page `thumb.webp`, ~88×62 on white, `object-fit: contain`, placeholder when not rendered), name (a `Link` to `/plans/:id`), meta line `N pages · N circles · N comments · edited <relative time>` (`.dot-sep` items), a `.pill.warn` "Preparing N pages…" while `pendingPages > 0`; row actions: "Open" button + `Menu` (⋯) with Rename (switches the name to `InlineRename`), Delete… (danger). Whole row is easy to tap on iPad (the name link covers the row's text area; buttons stay separate).
- Delete: `confirmDialog` ("Delete “<name>”?", "Its pages, circles and comments go with it. You can undo this right after.", danger "Delete plan") → `api.patchPlan(id, { deleted: true })` → remove from the list → toast "Deleted “<name>”." with **Undo** (`patchPlan(id, { deleted: false })` and reload).
- Upload: the button opens a `Dialog` "Upload a blueprint" with a `Dropzone` ("Drop a blueprint here" / "or tap to choose a file · PDF, PNG or JPG up to 150 MB"), a "Plan name" field prefilled from the file name, and "Upload" (primary). While uploading: `Progress` with "Uploading… 42%", cancel button (aborts). On success navigate to `/plans/<id>`. Dropping a file anywhere on the home page opens the same dialog with the file chosen.
- Empty state (`.empty` + rings `EmptyArt`): "No event plans yet" / "Upload a blueprint PDF to start. Each page becomes a sheet you can mark up with circles and comments." + Upload button.
- Loading: 3 `.skeleton` rows. Error: banner with Retry. 401 → `goToLogin()`.
- Poll `listPlans` every 4 s while any plan has `pendingPages > 0`; refresh on `visibilitychange` → visible.

### 7.4 Plan store + sync engine (`src/client/sync/`, SYNC agent)

`createPlanStore(planId: string): PlanStore` — one per open plan. Framework-free
core plus a React hook. Required API (the editor codes against exactly this):

```ts
type SaveState = "saved" | "pending" | "saving" | "offline" | "error" | "signedOut";

interface PlanState {
  loaded: boolean;
  loadError: string | null;          // plain sentence; set when the first load fails (and nothing is cached)
  notFound: boolean;                  // plan deleted or never existed
  plan: PlanRow | null;
  pages: PageRow[];                   // live (not deleted) pages, sorted by sortOrder
  circlesByPage: Map<string, CircleRow[]>;   // live circles per live page, sorted by num then createdAt
  commentsByCircle: Map<string, CommentRow[]>; // live comments per live circle, oldest first
  circleById: Map<string, CircleRow>; // live circles
  save: { state: SaveState; pending: number; message: string | null }; // pending = rows not yet confirmed
  canUndo: boolean; canRedo: boolean;
  rev: number;                        // bumps on every local change (handy for effects)
}

interface PlanStore {
  getState(): PlanState;
  subscribe(fn: () => void): () => void;
  load(): Promise<void>;              // GET plan, restore the device outbox, rebase, start syncing
  dispose(): void;                    // flush with keepalive, remove listeners/timers

  // circles
  addCircle(input: { pageId: string; x: number; y: number; r: number; color?: CircleColor }): string; // returns new id; one undo step
  pasteCircles(items: (CircleCopy & { pageId: string })[]): string[]; // copies of circles + their comments' text, each on its live page; ONE undo step; new ids in order
  addDuplicatedPage(pages: PageRow[], pageId: string, circles: CircleCopy[]): string[]; // a page the server just duplicated + copies of circles on it; ONE undo step (undo deletes the page)
  updateCircle(id: string, patch: Partial<Pick<CircleRow, "x" | "y" | "r" | "color" | "title">>, opts?: { live?: boolean }): void;
  beginGesture(): void;               // start of a drag/resize: following live updates make ONE undo step
  endGesture(): void;                 // commit the gesture as one undo step and schedule a save
  cancelGesture(): void;              // restore the pre-gesture state (e.g. a second finger landed)
  deleteCircle(id: string): void;     // soft delete; one undo step
  restoreCircle(id: string): void;

  // comments
  addComment(circleId: string, body: string): string;     // returns new id
  updateComment(id: string, body: string): void;          // typing: consecutive edits to the same comment coalesce into one undo step
  deleteComment(id: string): void;
  restoreComment(id: string): void;

  // pages & plan
  renamePage(id: string, label: string): void;
  movePage(id: string, toIndex: number): void;            // index among live pages; sets sortOrder between neighbours
  deletePage(id: string): void;
  restorePage(id: string): void;
  renamePlan(name: string): void;
  mergePages(pages: PageRow[]): void;                     // server page rows from uploads/polling (server-owned fields always win; new pages appear)
  refreshPages(): Promise<void>;                          // GET /pages and merge (used while rendering)

  undo(): void; redo(): void;
  flushNow(): Promise<void>;          // save immediately (Cmd/Ctrl+S, tapping the save pill, before leaving)
  hasUnsaved(): boolean;
}

function usePlanState<T>(store: PlanStore, select: (s: PlanState) => T): T; // useSyncExternalStore-based; select must be cheap
```

Engine rules (see report-state.md §9 — follow it, with these decisions):

- State: `doc` (the client's rows by kind+id, tombstones included) and `synced` (last known server copy per row). Pending = rows whose editable fields differ from `synced` (or with no `synced` entry). Ops are built by diffing; this naturally coalesces rapid edits.
- Every local change: update `doc`, persist the **outbox** to localStorage synchronously (key `bpn-outbox:<planId>`, `{ v: 2, name, entries: { "<kind>:<id>": { local, base, sent? } } }` — `sent` holds the fields of a request that went out without a confirmed reply; only pending rows; read-modify-write so two stores never erase each other's entries; replies trim confirmed entries even after dispose; wrapped in try/catch), bump `rev`, schedule a flush: 500 ms debounce, 2.5 s max wait.
- Flush: one request at a time (`api.sync`), ≤ 500 ops and ≤ 1.5 MB of JSON per request (loop for more; the server refuses bodies over 2 MB with 413), 15 s timeout (api.ts does it). On success, for each returned row R and what was sent S: `doc = merge3(kind, S, docCurrent, R)`, `synced = R` (so edits made while the request was out survive, and server-assigned `num` etc. arrive). Rejected ops: drop the local pending change for that row (adopt the server row if returned, else remove a never-created row) and set `save.message`. Network/5xx/timeout → state `offline`, retry with backoff 1, 2, 4, 8, 15, 30 s; `online` event retries immediately. 401 → `signedOut` (keep everything; retry after `api.me()` succeeds — poll every 10 s while signedOut). Other 4xx → `error` with the message (keep the outbox; tapping the pill retries).
- `visibilitychange` → hidden and `pagehide`: flush with `keepalive: true` (request body < 60 KB; otherwise normal). → visible and `pageshow` with `persisted`: pull (GET plan) and rebase. Also pull every 30 s while the tab is visible and nothing is pending/in flight (picks up edits from the other device).
- Rebase after a pull: for every server row R: if the client has no pending change for it → adopt R into `doc` and `synced`; else `doc = merge3(kind, synced_old, doc, R)`, `synced = R`. Rows only in `doc` (created offline) stay.
- Load: GET plan; read the outbox; restore each entry with `restoreRow` (outbox.ts): a field that never left the device wins; a field that went out without a reply comes back only if the server still holds its base value; a create that reached the server takes the server row as-is (so a circle deleted on the other device stays deleted); a create that never reached the server is kept; then flush. The home page also saves every stored outbox in the background (`startBackgroundSave`, 3 s after it opens, on `online` and on return to the app), skipping plans open in this tab. If the GET fails because of the network and an outbox exists, show `loadError` ("You're offline — this plan will open when the connection is back.") and retry every 5 s. If restored entries exist, `notify("<n> changes made on this device hadn't reached the server — saving them now.")` (defer with setTimeout 0).
- Undo/redo: snapshot stacks of `doc` (max 100), cleared of nothing on save (saves don't affect undo). `undo` restores the previous snapshot's editable fields **for rows that changed** (keep server-owned fields current). Comment typing coalesces per comment id (a new undo step starts when a different comment/action happens or after 3 s idle). Live gesture updates (`opts.live` or between begin/endGesture) don't create steps; `endGesture` creates one step if anything changed (DeployMap's dragBase pattern, including keeping the base if a commit lands mid-gesture).
- Derived state is recomputed only when `doc` changes (memoize; plans can have hundreds of circles).
- `movePage`: sortOrder = midpoint of neighbours (first: first − 1; last: last + 1).
- New circles: `num: 0`, `title: ""`, `color` default `DEFAULT_CIRCLE_COLOR`, `createdAt: Date.now()`. Show provisional numbers in the UI as "•" until the server assigns (the editor handles display).
- Unit tests in `tests/unit/` for: merge3 cases, diffing/coalescing, flush success adopting num, edits during an in-flight request survive, offline → retry → saved, 401 → signedOut → resumes, outbox restore on load (including a create that never reached the server), undo/redo of add/move/delete, comment typing coalescing, rebase on pull. Mock `api` (inject a transport into `createPlanStore` for tests: `createPlanStore(planId, { transport?, storage?, now? })`).

Save tag labels (DeployMap tone): saved → "Saved"; pending/saving → "Saving…";
offline → "Offline — N changes kept on this device" (gold `dirty` style,
nothing is lost); error → "Not saved — tap to retry" (red); signedOut →
"Signed out" (red) plus the editor banner.

### 7.5 Canvas (`src/client/editor/canvas/`, CANVAS agent)

Component `BlueprintCanvas` (default export of `src/client/editor/canvas/BlueprintCanvas.tsx`):

```ts
export type CanvasMode = "move" | "add";
export interface CanvasHandle {
  zoomIn(): void; zoomOut(): void; fit(): void;
  focusCircle(id: string): void;               // pan/zoom so the circle is centred and comfortably sized
  revealCircle(id: string): void;              // minimal animated pan so the circle (+ handles, badge, 24 px) is outside the insets; no zoom unless it can't fit
  getView(): View;
}
export interface BlueprintCanvasProps {
  page: PageRow;                       // status is "preview" or "ready" (the editor shows placeholders otherwise)
  circles: CircleRow[];                // live circles on this page
  selectedId: string | null;
  litId: string | null;                // circle the editor wants lit (e.g. hovered in the notes list)
  mode: CanvasMode;
  initialView?: View | null;           // restore the last view of this page (else fit)
  onViewChange?(v: View): void;        // throttled (≤ 4/s) and on gesture end
  onHover(id: string | null, pointerType: "mouse" | "pen"): void;   // circle under a hovering mouse/pencil (not touch)
  onSelect(id: string | null, how: "tap" | "click"): void;          // tap/click on a circle (id) or empty paper (null)
  onAdd(c: { x: number; y: number; r: number }): void;             // normalized; the editor creates it
  onGesture(e: { phase: "start" | "update" | "end" | "cancel"; id: string; kind: "move" | "resize"; x?: number; y?: number; r?: number }): void;
  topInset?: number; rightInset?: number; bottomInset?: number; // px covered by floating UI (the right panel / phone sheet) — focus/reveal keep content clear of it; inset changes never move the view by themselves
}
```

Rendering:
- A `.bp-canvas` div (fills its parent, `touch-action: none`, `overscroll-behavior: none`, no text selection, `-webkit-touch-callout: none`) on the plain canvas background (`--canvas-bg`).
- Raster layer: a div with `transform: translate(tx,ty) scale(scale)`, `transform-origin: 0 0`, containing: a white paper rect (`page.width × page.height`, flat, with a 1 px `--border` edge), the preview `<img>` stretched to page size (always present), and, when `pickLevel()` returns a level, the visible tiles of that level as absolutely positioned `<img>`s in world coordinates (each tile box enlarged by 1/scale world px right/bottom to hide seams; fade in on load; `draggable=false`, `decoding="async"`). Only tiles intersecting the viewport (+1 tile margin) are mounted. Keep the previous level's loaded tiles visible until the new level's tiles in view have loaded (no flash to blurry). Don't set a permanent `will-change: transform`.
- Annotation layer: an `<svg>` the size of the viewport with a `<g transform="translate scale">`: each circle as `<g class="anno …">` with a glow ring (wide translucent stroke), body circle (`fill` = palette fill, `stroke` = palette stroke, `vector-effect: non-scaling-stroke`, 2px), and a number badge (a small black square with gold figures at the circle's top, constant screen size, showing `num` or "•"). Lit state (hovered, selected, or `litId`): stroke 3px, glow visible (opacity transition 120 ms), fill a bit stronger, and a gentle pulse of the glow (disabled under reduced motion). A circle smaller than 10 screen px is drawn at 10 px (and hit-tested at ≥ 22 px on touch, ≥ 12 px with a mouse).
- Selected circle: the lit look + a dashed outer ring + **four resize handles** (N, E, S, W) drawn in screen space: 12 px white squares with a black border, each with an invisible 44 px hit target.
- Zoom controls (bottom-right, floating square panel with a soft shadow): − , percentage (fit = 100%), +, Fit (`IconFit`). 44 px targets on coarse pointers.
- Add mode: cursor crosshair; a floating hint at the top (a black bar with white text and a gold Cancel link): "Tap the blueprint to add a circle — drag to size it" + Cancel (calls `onAdd`? no: the editor owns the mode; render the hint with a Cancel button that calls a prop `onCancelAdd?()` — add this optional prop).

Gestures (implement the multi-pointer state machine from report-canvas.md §7.2–7.4; pointer events + pointer capture; always match `pointerId`; handle `pointercancel`/`lostpointercapture`):
- Wheel / trackpad: zoom around the cursor like DeployMap (`exp(-delta * speed)`, ctrlKey pinch faster), native listener `{ passive: false }`. Safari `gesturestart/change/end` for Mac trackpad pinch (ignored while touch pointers are down).
- One finger / left mouse drag on paper or on an **unselected** circle: pan. Slop 10 px touch, 4 px mouse/pen.
- A selected circle shows a **move grip** (✥ chip, constant size, 44 px touch target) at its centre: dragging it moves the circle. Dragging the selected circle's **body** moves it only while it's drawn at radius ≤ 90 px; a bigger circle's body pans like paper, so panning is never impossible. On small circles the resize handles sit outside the rim (≥ 46 px from the centre on touch). Handle/grip padding never steals a tap meant for another circle drawn there.
- Drag a handle: resize (r = distance from centre to the pointer, clamped to MIN/MAX_CIRCLE_R).
- Two fingers anywhere: pinch-zoom + pan together (anchor to the starting midpoint and starting view — no drift). A second finger cancels any single-finger move/resize in progress (`onGesture` cancel → the editor restores) and suppresses the pending tap. Lifting one finger hands over to a pan without a jump.
- Tap (press + release within the slop, < 600 ms, single pointer): on a circle → `onSelect(id)`; on paper → `onSelect(null)`. Hit-test by math (world distance), smallest containing circle wins; handles of the selected circle first.
- **Add mode**: press on the paper (even inside an existing circle) → release within slop → `onAdd({ x, y, r })` with `r` = `DEFAULT_CIRCLE_SCREEN_R` screen px converted to the normalized radius; press and drag → live preview circle centred at the press point with radius = drag distance; release → `onAdd` with that radius (if it's under 6 screen px, use the default). Pinch still zooms in add mode.
- **Long press** (touch or pen, 500 ms, no movement beyond slop, move mode, on paper or an unselected circle): `onAdd` at that point with the default radius (a quick haptic-like feedback: a ring expanding animation). Mouse: no long press.
- Double-tap / double-click on paper: zoom in ×2 around that point (animate 180 ms). Do NOT delay single taps waiting for a second tap (select/deselect fires on the first tap).
- Hover (mouse/pen only, no button pressed): hit-test on move and after every view change at the last pointer position; call `onHover` only when the result changes; `onHover(null)` on pointer leave.
- Keyboard is handled by the editor (it calls the handle methods).
- View: `{ scale, tx, ty }` in a ref (source of truth), rendered via one `requestAnimationFrame` per frame. Min scale = fit × 0.5, max scale = max(fit × 12, 3). On container resize keep the content centre stable (shift by half the size change). Initial view = `initialView` (if it still fits sensibly) else fit.
- `focusCircle(id)`: animate (≤ 250 ms ease) to centre the circle in the area not covered by `rightInset`, scale so the circle's diameter is ~35 % of the shorter viewport side (but never zoom out from the current scale by more than 2×, never beyond max).
- Performance: memoized circle components; tile list recomputed per frame is fine (math only); avoid React state updates per pointermove except the rAF view commit.

`canvas.css` holds every `.bp-*` style the canvas uses (including the zoom controls and the add-mode hint), using the design tokens.

### 7.6 Editor shell (`src/client/editor/`, EDITOR agent)

`EditorPage({ planId, initialPageId, initialCircleId })` (default export of `src/client/editor/EditorPage.tsx`):

Layout (full-height `100dvh`, no page scroll):

```
header.ed-header   [← Plans] [plan name: InlineRename] | [sidebar toggle] [‹ Page 2 of 6 ›  "A-101 Seating bowl"]  … spacer …
                   [hdr-group: Move | Circle]  [Undo][Redo]  [SaveStatus]  [? help menu]
div.ed-body
  aside.ed-left  (collapsible)   tabs: Pages | Notes
  main.ed-stage  BlueprintCanvas (or a placeholder for pages not ready) + floating right panel
    aside.ed-right (CommentsPanel, floats over the stage's right edge — never resizes the canvas)
```

- **Header**: back link `IconArrowLeft` "Plans" (flushes first). Plan name inline-renamable (`store.renamePlan`). Page switcher: prev/next icon buttons + "Page 2 of 6" + the page label (click opens the left sidebar on Pages). Mode group (`.hdr-group`, segmented): "Move" (`IconHand`) and "Circle" (`IconCircle`; the active mode is black with gold text) — keyboard `V`/`C`. Undo/Redo icon buttons (disabled states). `SaveStatus` tag (tap = `flushNow()`). Help `Menu` (`?`) listing shortcuts with `<kbd>` and gestures for iPad. Below 1100 px labels collapse to icons (with `aria-label`/`title`); below 820 px the header wraps to two rows (DeployMap's narrow header rule).
- **Left sidebar** (`PageSidebar.tsx`): width 280 px; collapsible to a 56 px rail (page number buttons 1…N with the active one marked, plus an expand button). Collapse state persists in localStorage (`bpn-left-collapsed`). Below 900 px wide it's an overlay drawer (with a scrim) that closes after choosing a page. Tabs at the top (`.evtabs`, the open one with a 4 px gold underline): **Pages** and **Notes** (with counts).
  - Pages tab: rows with thumbnail (white, contain, ~96×68), label (two lines max), "N circles" meta, active row = soft gold fill (`--accent-soft`) + 6 px gold left bar; status: spinner + "Preparing…" (queued/rendering), "Sharpening…" small note while `preview`, failed → red "Couldn't prepare this page" + Retry (`api.retryPage` then `store.refreshPages()`). Row `Menu` (⋯, always visible on touch): Rename (inline), Move up, Move down, Duplicate page… (disabled for a failed page), Copy circles to another page… (with 2+ pages; disabled while the page has no circles), Delete page….
  - Duplicate page (`DuplicatePageDialog.tsx`): "Name of the copy" (prefilled "A-101 (copy)"; focused with a mouse, not on touch screens) and "What comes along": Just the page / The page and its N circles / The page, its N circles and their M comments (only the choices that differ; everything by default). Duplicate → `store.flushNow()`, `api.duplicatePage` (with the copy's id, picked when the dialog opens, so a retry after a lost reply finishes the same copy), then `store.addDuplicatedPage(res.pages, res.page.id, copies)` — copies of the page's live circles as this device shows them; ONE undo step (undo deletes the copy) — opens the copy and toasts "Duplicated “A-101” as “A-101 (copy)” with 2 circles.". Errors stay in the dialog ("The page wasn't duplicated. …", then a pull so the page list catches up; focus back on the name with a mouse); it can't be dismissed while the request is out, and nothing is made once the editor has closed. On a touch screen the keyboard's "done" key only closes the keyboard. If the page is deleted on the other device while the dialog is open, the dialog closes with "That page was deleted on another device, so it wasn't duplicated." Double-click a label to rename on desktop. Footer: "Add pages" button (`IconUpload`) → file picker (multiple, `UPLOAD_ACCEPT`) → sequential uploads via `uploadFile(file, { planId })` with a `Progress` row per file; each success → `store.mergePages(res.pages)`; errors → toast.
  - Delete page: `confirmDialog` ("Delete page “A-101”?", "Its N circles and N comments go with it. You can undo this right after.") → `store.deletePage` → toast with Undo (`store.restorePage`). If it was the open page, open the nearest remaining page.
  - Notes tab (`NotesList.tsx`): every circle in the plan grouped by page (page order), each row: colour dot, `#num`, title (or the first comment's first line, or "No comments yet" muted), comment count; a filter toggle "This page / All pages"; hovering a row lights that circle (`litId`); clicking a row opens its page, selects the circle and calls `canvas.focusCircle`.
- **Stage**: if the current page is `queued`/`rendering` → centred placeholder card ("Preparing page… This takes a few seconds for big sheets." with spinner); `failed` → message + Retry; no pages → empty state with "Add pages" (Dropzone). Otherwise `BlueprintCanvas`. Remember each page's last view in memory (Map pageId → View) and pass it as `initialView`; give the canvas `key={page.id}`. Poll `store.refreshPages()` every 1.5 s while any page is queued/rendering/preview.
- **Selection & hover → right panel** (`CommentsPanel.tsx`):
  - `selectedId` (pinned) and `hoverId` (from canvas `onHover`, mouse/pen only).
  - Panel shows `hoverId` when it's set and the panel isn't "busy" (the pointer is over the panel, an inline comment edit is open, or the title/composer field has focus AND holds text — an empty focused composer doesn't count); otherwise `selectedId`. While the panel shows, the canvas gets `rightInset` (or `bottomInset` for the phone sheet) and `revealCircle` slides a selected/added circle — or a hovered one under the panel — into view. When the hover ends, keep showing the hovered circle for 700 ms (so the pointer can travel into the panel); entering the panel cancels that and **pins** the hovered circle (becomes `selectedId`). Leaving the panel without interacting lets it fall back/close.
  - Touch: tap a circle → select (panel opens); tap paper → deselect (panel closes); tap another circle → switch.
  - Panel contents (laid out like DeployMap's side panel, width 340 px, floats at the right of the stage with `--shadow-3`, full stage height, slides in 160 ms; on narrow screens (< 700 px) it's a bottom sheet at 60 % height):
    - Header: colour dot, "Circle #12" (or "New circle" while `num` is 0), close button (deselect).
    - Title field (`InlineRename`-like, placeholder "Name this spot (optional)").
    - Colour swatches (5 palette colours, 32 px, 44 px hit on touch) and a "Size" slider (log scale between MIN and MAX_CIRCLE_R, live updates via begin/updateCircle(live)/endGesture).
    - Comments list (oldest first): body (pre-wrap), meta "Oct 13, 2:41 PM" (+ " · edited" when updatedAt − createdAt > 60 s), actions Edit / Delete (visible on hover, always on touch). Edit = inline auto-growing textarea that autosaves (`store.updateComment` on input) — "Done" closes it; empty after edit → delete it. Delete → `store.deleteComment` + toast with Undo.
    - Composer at the bottom: auto-growing textarea "Add a comment…" — **autosaves as you type**: the first non-blank character creates the comment (`store.addComment`), further typing updates it (`store.updateComment`). "Add" button (primary) / ⌘↵ / Ctrl↵ finishes it: the composer clears and the comment shows in the list. Switching circles or blurring with text keeps the comment (it already exists). If the text is erased back to blank, delete that draft comment.
    - Footer: "Copy to another page" (`IconCopy`, with 2+ pages) → the Copy circles dialog for this circle; "Delete circle" (`button.ghost.danger`, `IconTrash`) → `store.deleteCircle` + toast "Circle #12 deleted." with Undo.
  - After adding a circle (canvas `onAdd`): create it (`store.addCircle` on the current page), select it, switch the mode back to Move, and — **with a mouse only** — focus the composer.
- **Copy circles** (`CopyCirclesDialog.tsx`, `copyCircles.ts`): copy some or all of one page's circles onto one or more other pages of the same plan.
  - Dialog "Copy circles": **From** (a select of the pages with circles), **Circles** (a checkbox per circle — dot, `#num`, title or first comment, comment count — with Select all / Clear), **Copy to** (a checkbox per other page with its thumbnail, label and circle count; pre-ticked when there's only one other page), "Copy their N comments too" (on by default; shown when the chosen circles have comments). Foot note "Copies land in the same spot on each page."; primary "Copy N circles" (disabled until a circle and a page are chosen).
  - Opened from a page's ⋯ menu (every circle on that page ticked) or a circle's panel (just that circle).
  - A copy keeps x/y (shares of the page's width/height), r (share of the long side), colour, title and its non-blank comments' text; the server gives it a new number. If a copy would sit exactly on a circle already there (pasted twice, or onto its own page), the whole group steps aside by 2 % of the long side until it's clear: per axis toward the side with more room (down/right, or up/left near those edges), then the other way once that room is used up, never further than the page has room for, so the group keeps its layout (with no clear spot left, it goes where it covers the fewest circles).
  - All the copies, on every page, are one `store.pasteCircles` call: one undo step, one save. Toast "Copied 3 circles to “P-1”." with "Show" (opens that page; not when it's the open page — and the toast is dismissed when the editor closes, since Show would have nowhere to go), or "Copied 3 circles to 2 pages.".
  - If the From page is deleted (on the other device) while the dialog is open, it carries on from the first page that has circles (closes when no page is left).
  - ⌘C / Ctrl+C with a circle selected (and no text selected on the page) copies it with its comments to an in-memory clipboard for this plan (toast "Circle #4 copied. Open another page and press ⌘V to paste it."); ⌘V / Ctrl+V pastes onto the open page (if it's showing; a page still being prepared says "paste once it shows", a failed one "press Try again, then paste"), selects the copy and reveals it.
- **Gestures from the canvas**: `onGesture` start → `store.beginGesture()`; update → `store.updateCircle(id, {x,y}|{r}, { live: true })`; end → `store.endGesture()`; cancel → `store.cancelGesture()`.
- **Keyboard** (ignored while typing in inputs/textareas/contenteditable, except ⌘S): `V` move, `C` circle mode, `Esc` cascade (cancel add mode → close the comment editor → deselect → close the left drawer), `Delete`/`Backspace` delete the selected circle (toast with Undo), `⌘Z`/`Ctrl+Z` undo, `⌘⇧Z`/`Ctrl+Y` redo, `⌘S`/`Ctrl+S` flush (preventDefault), `+`/`=` zoom in, `-` zoom out, `0` fit, `[`/`PageUp` previous page, `]`/`PageDown` next page, `F` focus the selected circle, `⌘C`/`Ctrl+C` copy the selected circle, `⌘V`/`Ctrl+V` paste copied circles onto the open page.
- **URL**: keep `?page=<id>` (and `&circle=<id>` when one is selected) in sync with `replaceQuery`; honour `initialPageId`/`initialCircleId` on load (focus that circle).
- **Leaving**: `addLeaveGuard` flushes (fire-and-forget) — never block navigation; the outbox keeps anything unsent. `store.dispose()` on unmount.
- **Banners**: `signedOut` → `.editor-banner` "Signed out — your changes are kept on this device. Sign in to finish saving." + "Sign in" button (`goToLogin()`); `notFound` → full-page message with a link home; `loadError` → full-page message with retry spinner.
- Document title: `<plan name> · KWE Blueprints`.

`editor.css` holds all `.ed-*` styles.

## 8. Copy and tone

Sentence case; `…` for in-progress and for actions that open a further
step; ` — ` joins clauses; ` · ` separates meta items. Plain, practical,
second person, contractions. Errors say what didn't happen ("That change
wasn't saved."). Terms: **event plan**, **blueprint**, **page**, **circle**,
**comment**. Never mention real client or venue names anywhere (fixtures use
the fictional "Millrace Stadium").

## 9. Quality bar

- TypeScript strict, `npm run typecheck` clean, no `any` leaks across module boundaries.
- No console errors in normal use. No external network requests (fonts, CDNs).
- Every interactive element is a real `<button>`/`<a>`/`<input>` with an accessible name; visible focus rings.
- iPad: everything reachable by touch with ≥ 44 px targets; no hover-only affordances; no page zoom/bounce; pinch/pan never fight the browser.
- Robustness over cleverness: when unsure, choose the behaviour that can't lose the owner's work.
