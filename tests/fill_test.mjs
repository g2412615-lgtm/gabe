// tests/fill_test.mjs — acceptance tests for the FROI template + fill recipe.
// Run from the repo root:  npm install && node tests/fill_test.mjs
//
// 1. Template census: exactly 98 fields; every mapped name resolves with the
//    stated type (incl. `Ave. Hours/Week Worked`, `Type of Incident` option list).
// 2. Template purity: no /V or /I anywhere in the field tree; no prior
//    claimant's PII in the extracted text.
// 3. Round trip: fill a sample, save, reload — every value reads back and a
//    further edit succeeds (proves the output is not flattened).
// 4. If poppler is available: rasterize p1/p3 and confirm non-blank renders of
//    Sex, Combo Box2/3/4, and Type of Incident (historical blank-render bugs).

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { FIELD_COUNT, FIELD_TYPES, P1_NARRATIVE, buildFill, fillFroi } from '../forms/froi/fieldmap.js';
import { DEFAULTS } from '../config.js';

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-lib');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = pdfLib;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'forms', 'froi', 'template.pdf');

let failures = 0;
let checks = 0;
const ok = (cond, label) => {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  ✗ FAIL: ${label}`);
};
const eq = (actual, expected, label) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
const section = (t) => console.log(`\n== ${t}`);

const templateBytes = readFileSync(TEMPLATE_PATH);

// ---------------------------------------------------------------------------
section('Test 1 — template census');
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const fields = form.getFields();
  eq(fields.length, FIELD_COUNT, 'pdf-lib field count');
  eq(Object.keys(FIELD_TYPES).length, FIELD_COUNT, 'fieldmap census size');

  const actual = new Map(fields.map((f) => [f.getName(), f.constructor.name]));
  for (const [name, type] of Object.entries(FIELD_TYPES)) {
    ok(actual.has(name), `field exists: ${JSON.stringify(name)}`);
    eq(actual.get(name), type, `type of ${JSON.stringify(name)}`);
  }
  for (const name of actual.keys()) {
    ok(name in FIELD_TYPES, `unmapped field in template: ${JSON.stringify(name)}`);
  }
  // The two historically tricky resolutions, asserted explicitly:
  ok(!!form.getTextField('Ave. Hours/Week Worked'), '`Ave. Hours/Week Worked` resolves as text field');
  ok(!!form.getOptionList('Type of Incident'), '`Type of Incident` resolves as PDFOptionList');
}

// ---------------------------------------------------------------------------
section('Test 2 — template purity');
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.load(templateBytes);
  // Walk the raw AcroForm field tree (parents included — pdf-lib's getFields()
  // only returns terminal fields) checking for leftover /V or /I.
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const walk = (ref, pathLabel) => {
    const dict = doc.context.lookup(ref, PDFDict);
    const name = dict.get(PDFName.of('T'));
    const label = `${pathLabel}/${name ? name.decodeText?.() ?? String(name) : '(anon)'}`;
    ok(!dict.has(PDFName.of('V')), `no /V on ${label}`);
    ok(!dict.has(PDFName.of('I')), `no /I on ${label}`);
    const kids = dict.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.get(i);
        if (kid instanceof PDFRef) {
          const kd = doc.context.lookup(kid, PDFDict);
          // Recurse only into field nodes (widgets without /T are pure annots).
          if (kd.has(PDFName.of('T')) || kd.has(PDFName.of('Kids'))) walk(kid, label);
        }
      }
    }
  };
  const rootFields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  for (let i = 0; i < rootFields.size(); i++) walk(rootFields.get(i), '');

  const FORBIDDEN = ['ROSE', 'ELLIS', 'MIAMI', 'DIXIE', 'DANIA', '8460', '000339176', 'TODD', 'MACIEKOWICH'];
  const pdftotext = spawnSync('pdftotext', ['-layout', TEMPLATE_PATH, '-'], { encoding: 'utf8' });
  if (pdftotext.error) {
    console.log('  (pdftotext unavailable — falling back to raw byte scan)');
    const raw = templateBytes.toString('latin1').toUpperCase();
    for (const w of FORBIDDEN) ok(!raw.includes(w), `raw bytes free of ${w}`);
  } else {
    const text = pdftotext.stdout.toUpperCase();
    for (const w of FORBIDDEN) ok(!text.includes(w), `extracted text free of ${w}`);
  }
}

// ---------------------------------------------------------------------------
section('Test 3 — round trip (fill, reload, edit again)');
// ---------------------------------------------------------------------------

// Sample exercised through the real wizard-state mapping (buildFill), covering
// the historical traps: both incident-type widgets, Combo Box4, and choices
// that render blank when /I is missing.
const sampleState = {
  classification: 'Workers Comp',
  incidentType: 'Trip & No Fall',
  incidentTypeOther: '',
  defaults: { ...DEFAULTS },
  answers: {
    incidentDate: '2026-08-09', incidentTime: '23:30', dateReported: '2026-08-10',
    lastName: 'Sample', firstName: 'Casey', employeeNumber: '12345',
    jobTitle: 'Event Security Officer', claimantPhone: '(713) 555-0100',
    sex: 'Female', payType: 'Hourly',
    locationPick: 'Bayou City Gate', exactSpot: 'inside Bayou City Gate near the ticket scanners', indoorOutdoor: 'Outdoor',
    surfaceType: 'Concrete', surfaceCondition: 'Dry', weather: 'Clear',
    notes: 'raw shift notes', bodyParts: ['Wrist'], causeObject: 'base of a PMD',
    altPath: 'Yes', carrying: 'No', distracted: 'No', normalDuties: 'Yes',
    questionableCase: 'No', beyondFirstAid: 'No', lostConsciousness: 'No',
    ambulanceCalled: 'Yes', transport: 'Refused', fatality: 'No', missedDays: 'No',
    footwearDesc: 'Black sneakers', footwearCondition: 'Good',
    ppe: 'N/A', chairInvolved: 'No', stairsInvolved: 'No', elevationFall: 'No', ladderInvolved: 'No',
    hoursOnDuty: '6', hoursPrior7: '32',
    w1_type: ['Company'], w1_name: 'Jordan Witness', w1_phone: '(713) 555-0101',
    docs: ['Photos', 'Other'], docsOther: 'CCTV export',
    supervisor: 'Alex Supervisor', extraComments: 'Area was cordoned off after the incident.',
  },
  narratives: {
    location: 'Outdoor concourse just inside Bayou City Gate at Shell Energy Stadium.',
    incident: 'Employee tripped on the base of a PMD and fell forward, catching herself with both hands.',
    activity: 'Employee was directing guests during egress.',
    injury: 'Employee reported soreness in both wrists.',
    cause: 'Base of a PMD.',
    detailed: 'Casey Sample at around 11:30 PM was directing guests during egress when she tripped on the base of a PMD.',
    specificInjury: 'Minor wrist pain',
  },
};

let filledBytes;
{
  const fill = buildFill(sampleState);
  filledBytes = await fillFroi(pdfLib, templateBytes, fill);

  const doc2 = await PDFDocument.load(filledBytes);
  const form2 = doc2.getForm();
  const t = (n) => form2.getTextField(n).getText();

  // Shared + p1 text
  eq(t('Name of claimant Last First'), 'SAMPLE, CASEY', 'claimant LAST, FIRST');
  eq(t('Employee Number'), '12345', 'employee number');
  eq(t('Date of incident'), '08/09/2026', 'date of incident MM/DD/YYYY');
  eq(t('Time of Incident AMPM'), '11:30 PM', 'time formatted with AM/PM');
  eq(t('Date employee reported incident/injury'), '08/10/2026', 'date reported');
  eq(t('Job Title'), 'Event Security Officer', 'job title');
  eq(t('Phone Number'), '(713) 555-0100', 'claimant phone');
  // Standing defaults
  eq(t('Company #'), 'BEST', 'Company # default');
  eq(t('Branch'), 'Houston', 'Branch default');
  eq(t('Job number where incident occured'), '8822', 'job number default');
  eq(t('Text Field5'), 'Shell Energy Stadium', 'location line 2 default');
  eq(t('Text Field6'), 'Houston, TX', 'location line 3 default');
  eq(t('Nametitle of person completing FROI'), 'Gabriel Exposito Schmitz', 'completed-by default');
  eq(t('Manager ID Number'), '390424', 'manager ID default');
  eq(t('Phone Number_2'), '(954) 805-3061', 'reporting manager phone default');
  // Narratives
  eq(t(P1_NARRATIVE.incident), sampleState.narratives.incident, 'p1 incident narrative');
  eq(t('Text Field7'), sampleState.narratives.detailed, 'p3 detailed narrative');
  ok(t('CommentsAdditional InformationRow1').includes(sampleState.narratives.detailed), 'comments include detailed narrative');
  ok(t('CommentsAdditional InformationRow1').includes('Direct supervisor: Alex Supervisor'), 'comments include supervisor line');
  eq(t('Text Field12'), 'MINOR WRIST PAIN', 'specific injury uppercased');
  // Preliminary questions as uppercase YES/NO
  eq(t('Text Field8'), 'YES', 'alt path YES');
  eq(t('Text Field9'), 'NO', 'carrying NO');
  eq(t('Text Field10'), 'NO', 'distracted NO');
  eq(t('Text Field11'), 'YES', 'normal duties YES');
  eq(t('Text Field13'), 'Black sneakers', 'footwear description');
  eq(t('Text Field14'), '6', 'hours on duty');
  eq(t('Text Field15'), '32', 'hours prior 7 days');
  // Witness + docs
  eq(t('Name'), 'Jordan Witness', 'witness 1 name');
  ok(form2.getCheckBox('Company Employee manager coworker etc').isChecked(), 'witness 1 company box');
  ok(form2.getCheckBox('Photos').isChecked(), 'Photos box');
  ok(form2.getCheckBox('Other5').isChecked(), 'docs Other box');
  eq(t('Other6'), 'CCTV export', 'docs Other text');
  // Classification: exactly one box
  ok(form2.getCheckBox('Workers Compensation Claim Injury').isChecked(), 'WC box checked');
  ok(!form2.getCheckBox('Near MissIncident Only No Injury').isChecked(), 'near-miss box unchecked');
  // The trap dropdowns — both incident-type widgets set to the same value
  eq(form2.getOptionList('Type of Incident').getSelected(), ['Trip & No Fall'], 'Type of Incident option list');
  eq(form2.getDropdown('Combo Box0').getSelected(), ['Trip & No Fall'], 'Combo Box0 mirror');
  eq(form2.getDropdown('Combo Box4').getSelected(), ['Good'], 'footwear condition Good');
  eq(form2.getDropdown('Sex').getSelected(), ['Female'], 'Sex');
  eq(form2.getDropdown('Combo Box2').getSelected(), ['Concrete'], 'flooring type');
  eq(form2.getDropdown('Combo Box3').getSelected(), ['Dry'], 'flooring condition');
  eq(form2.getDropdown('Was an ambulance called to scene?').getSelected(), ['Yes'], 'ambulance Yes');
  eq(form2.getDropdown('Did employee miss any days of work, or anticipate missing any days?').getSelected(), ['No'], 'missed days No');
  // /V + /I sync (the verified fill recipe requirement)
  for (const name of ['Combo Box0', 'Combo Box4', 'Sex']) {
    const f = form2.getDropdown(name);
    ok(f.acroField.dict.has(PDFName.of('I')), `/I present on ${name}`);
  }
  ok(form2.getOptionList('Type of Incident').acroField.dict.has(PDFName.of('I')), '/I present on Type of Incident');
  // Conditionals stayed blank (never invent data)
  eq(t('If yes how many days') ?? '', '', 'missed-days count blank when No');
  eq(t('Physician Name') ?? '', '', 'physician blank when first-aid only');
  ok(form2.getDropdown('Combo Box6').getSelected().length === 0, 'chair type unselected when chair not involved');
  // NeedAppearances must survive (keeps Acrobat re-rendering the fields)
  const acro = doc2.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  eq(String(acro.get(PDFName.of('NeedAppearances'))), 'true', 'NeedAppearances still true');

  // Further edit proves the output is not flattened.
  form2.getTextField('Physician Name').setText('EDIT AFTER RELOAD OK');
  const bytes3 = await doc2.save();
  const doc3 = await PDFDocument.load(bytes3);
  eq(doc3.getForm().getTextField('Physician Name').getText(), 'EDIT AFTER RELOAD OK', 'post-reload edit round-trips');
}

// ---------------------------------------------------------------------------
section('Test 4 — rasterized visual check (requires poppler)');
// ---------------------------------------------------------------------------
{
  const probe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (probe.error) {
    console.log('  SKIP: pdftoppm not available');
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), 'froi-test-'));
    const blankPath = path.join(dir, 'blank.pdf');
    const filledPath = path.join(dir, 'filled.pdf');
    writeFileSync(blankPath, templateBytes);
    writeFileSync(filledPath, Buffer.from(filledBytes));

    const DPI = 150;
    const SCALE = DPI / 72;
    const raster = (pdfPath, page, prefix) => {
      const r = spawnSync('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(DPI), pdfPath, path.join(dir, prefix)]);
      if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr}`);
      const file = readdirSync(dir).find((f) => f.startsWith(prefix + '-') && f.endsWith('.ppm'));
      return parsePPM(readFileSync(path.join(dir, file)));
    };
    // Minimal P6 parser (pdftoppm default output).
    function parsePPM(buf) {
      let pos = 0;
      const token = () => {
        while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
        if (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; return token(); } // # comment
        let start = pos;
        while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
        return buf.toString('ascii', start, pos);
      };
      const magic = token();
      if (magic !== 'P6') throw new Error(`unexpected PPM magic ${magic}`);
      const w = Number(token()); const h = Number(token()); Number(token());
      pos++; // single whitespace after maxval
      return { w, h, data: buf.subarray(pos) };
    }
    const darkPixels = (img, rect) => {
      const inset = 2;
      const x0 = Math.max(0, Math.round(rect.x * SCALE) + inset);
      const y0 = Math.max(0, Math.round((792 - (rect.y + rect.height)) * SCALE) + inset);
      const x1 = Math.min(img.w, Math.round((rect.x + rect.width) * SCALE) - inset);
      const y1 = Math.min(img.h, Math.round((792 - rect.y) * SCALE) - inset);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.w + x) * 3;
          if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 400) count++;
        }
      }
      return count;
    };

    const doc = await PDFDocument.load(filledBytes);
    const form = doc.getForm();
    const targets = [
      ['Sex', 1],
      ['Type of Incident', 3],
      ['Combo Box2', 3],
      ['Combo Box3', 3],
      ['Combo Box4', 3],
    ];
    const pages = {};
    for (const page of [1, 3]) {
      pages[page] = {
        blank: raster(blankPath, page, `b${page}`),
        filled: raster(filledPath, page, `f${page}`),
      };
    }
    for (const [name, page] of targets) {
      let f;
      try { f = form.getDropdown(name); } catch { f = form.getOptionList(name); }
      const rect = f.acroField.getWidgets()[0].getRectangle();
      const blankInk = darkPixels(pages[page].blank, rect);
      const filledInk = darkPixels(pages[page].filled, rect);
      ok(filledInk > blankInk + 10, `${name} renders non-blank on p${page} (blank=${blankInk}, filled=${filledInk})`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exitCode = 1;
else console.log('ALL ACCEPTANCE TESTS PASSED');
