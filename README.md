# FROI Report Builder — BEST / Shell Energy Stadium

A phone-first web app that lets stadium supervisors file a First Report of
Injury (FROI) in minutes. A plain-language wizard collects the facts, an AI
drafting step turns raw notes into compliant formal narrative, a human reviews
and approves every word, and the app fills the official GardaWorld FROI PDF in
its **native form fields** — the output stays fully editable in Acrobat or any
PDF viewer.

Static site, no framework, no build step, plus one Cloudflare Worker that
proxies AI drafting calls so the Anthropic API key never touches the client.

## Layout

```
index.html            landing: pick a report (FROI active; others coming soon)
app.js                wizard engine, state, review screen, PDF generation
styles.css            mobile-first styles
config.js             DRAFT_ENDPOINT, DEFAULTS, LOCATION_PICKS (user-editable)
forms/froi/
  template.pdf        blank FROI template (pre-processed; never ship an unblanked copy)
  fieldmap.js         exact AcroForm field names/types + fill recipe
  rulebook.js         the AI drafting system prompt
  wizard.js           wizard step definitions (pure data)
worker/
  worker.js           Cloudflare Worker: POST /draft proxy
  wrangler.toml
tests/
  fill_test.mjs       acceptance tests
```

## Deploy the site (Cloudflare Pages)

Upload the repo folder (everything except `worker/`, `tests/`, `node_modules/`)
to Cloudflare Pages — no build step. The site works immediately in **manual
mode** (no AI drafting) until the Worker is deployed.

## Deploy the Worker (AI drafting)

```sh
cd worker
npx wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic API key
npx wrangler deploy
```

Then:

1. Paste the deployed Worker URL + `/draft` into `DRAFT_ENDPOINT` in `config.js`
   (e.g. `https://froi-draft.<account>.workers.dev/draft`).
2. Add the production site origin to `PROD_ORIGINS` in `worker/worker.js` and
   redeploy — CORS allows only the production origin and localhost.
3. Re-upload `config.js` to Pages.

If the Worker is unreachable or errors, the app falls back to manual mode: the
narrative boxes open empty with the filer's raw notes beside them. It never
dead-ends on an API failure.

## Run the acceptance tests

```sh
npm install
npm test          # node tests/fill_test.mjs
```

The tests verify the template census (98 fields, exact names/types), template
purity (no leftover values or prior-claimant PII), a full fill round trip
(values read back after reload; the output accepts further edits — i.e. it was
never flattened), and — when poppler is installed — rasterized renders of the
historically blank-rendering choice fields.

## Local development

Serve over HTTP (ES modules don't load from `file://`):

```sh
npm run serve     # http://localhost:8788
```

## House rules baked into the app

- **Never invent data** — anything the filer didn't provide stays blank on the
  PDF, and every blank is surfaced in a "Left blank — need from you" list.
- **Three judgment calls are confirmed by a human, never decided silently:**
  Near Miss vs. Workers' Comp, treatment beyond first aid, and missed-days
  status. The AI may suggest; the filer taps to confirm before Generate unlocks.
- **The output PDF stays editable** — native AcroForm fill, never flattened.
- **PII discipline** — SSN, DOB, home address and pay data are never sent to
  the drafting endpoint; they map straight from the wizard to PDF fields.
- Drafts autosave to the device (`localStorage`) and contain PII — use the
  visible **Clear draft** action once a report is filed.

## Adding future forms

`index.html` renders the registry in `config.js` (`FORM_REGISTRY`). Adding a
form = a new `forms/<id>/` folder + a registry entry — no engine changes. The
engine dynamically imports `forms/<id>/wizard.js` and `forms/<id>/fieldmap.js`
and fetches `forms/<id>/template.pdf`. A form folder must export:

- `wizard.js` — `WIZARD_STEPS`, `REVIEW_SECTIONS`, `FOLLOW_UP_FIELDS`,
  `extraBlanks(state)`
- `fieldmap.js` — `OPTIONS`, `buildFill(state)`, `fillFroi(pdfLib, bytes, fill)`,
  `buildFacts(answers)`, `NARRATIVE_KEYS`, `RESPONSE_KEYS`,
  `outputFilename(answers, todayIso)`, `isoToMDY`, `to12Hour`
- `rulebook.js` — `RULEBOOK` (imported by the Worker)
