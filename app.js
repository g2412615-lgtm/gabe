// app.js — wizard engine, state, review screen, PDF generation.
// The engine is generic: steps/fields/conditions come from forms/<id>/wizard.js
// data; everything form-specific lives in the per-form config modules.

import {
  DRAFT_ENDPOINT, DEFAULTS, FORM_REGISTRY, SUBMIT_EMAIL, SUBMIT_DEADLINE,
} from './config.js';
import {
  WIZARD_STEPS, REVIEW_SECTIONS, FOLLOW_UP_FIELDS,
} from './forms/froi/wizard.js';
import {
  OPTIONS, buildFill, fillFroi, isoToMDY, to12Hour,
} from './forms/froi/fieldmap.js';

const DRAFT_KEY = 'froi.draft.v1';
const TEMPLATE_URL = 'forms/froi/template.pdf';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const emptyNarratives = () => ({
  location: '', incident: '', activity: '', injury: '', cause: '', detailed: '', specificInjury: '',
});

const store = {
  screen: 'landing', // landing | wizard | review | done
  step: 0,
  answers: {},
  narratives: emptyNarratives(),
  defaults: { ...DEFAULTS },
  classification: '',      // 'Near Miss' | 'Workers Comp' (confirmed value)
  incidentType: '',        // exact Type of Incident option string
  incidentTypeOther: '',
  confirmed: { classification: false, firstAid: false, missedDays: false },
  ai: { status: 'idle', data: null, error: null, key: '' }, // idle|loading|done|error
  generated: null,         // { url, filename }
  savedAt: null,
};

let templateBytesCache = null;
let saveTimer = null;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.savedAt = new Date().toISOString();
    const { screen, step, answers, narratives, defaults, classification, incidentType, incidentTypeOther, confirmed, savedAt } = store;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        version: 1, screen, step, answers, narratives, defaults, classification, incidentType, incidentTypeOther, confirmed, savedAt,
      }));
    } catch { /* storage full/blocked — keep working in memory */ }
    const el = document.getElementById('save-indicator');
    if (el) el.textContent = 'Draft saved';
  }, 250);
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.version === 1 ? d : null;
  } catch { return null; }
}

function resumeDraft(d) {
  store.step = Math.min(d.step || 0, WIZARD_STEPS.length - 1);
  store.answers = d.answers || {};
  store.narratives = { ...emptyNarratives(), ...(d.narratives || {}) };
  store.defaults = { ...DEFAULTS, ...(d.defaults || {}) };
  store.classification = d.classification || '';
  store.incidentType = d.incidentType || '';
  store.incidentTypeOther = d.incidentTypeOther || '';
  store.confirmed = { classification: false, firstAid: false, missedDays: false, ...(d.confirmed || {}) };
  store.savedAt = d.savedAt || null;
  applyWizardDefaults();
  store.screen = d.screen === 'review' ? 'review' : 'wizard';
  if (store.screen === 'review') maybeDraft();
  render();
}

function clearDraft() {
  if (!window.confirm('Delete this draft from the device? Drafts contain personal information — clear them once the report is filed.')) return;
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  store.screen = 'landing';
  store.step = 0;
  store.answers = {};
  store.narratives = emptyNarratives();
  store.defaults = { ...DEFAULTS };
  store.classification = '';
  store.incidentType = '';
  store.incidentTypeOther = '';
  store.confirmed = { classification: false, firstAid: false, missedDays: false };
  store.ai = { status: 'idle', data: null, error: null, key: '' };
  store.generated = null;
  store.savedAt = null;
  render();
}

function startFroi() {
  applyWizardDefaults();
  store.screen = 'wizard';
  render();
  saveDraft();
}

// Wizard-level defaults (dates default to today, branch questions default to
// No, footwear condition defaults to Good) — applied only when unanswered.
function applyWizardDefaults() {
  for (const step of WIZARD_STEPS) {
    for (const f of allStepFields(step)) {
      if (store.answers[f.id] !== undefined && store.answers[f.id] !== '') continue;
      if (f.defaultToday) store.answers[f.id] = todayISO();
      else if (f.default !== undefined) store.answers[f.id] = f.default;
    }
  }
}

function allStepFields(step) {
  return [...(step.fields || []), ...(step.sections || []).flatMap((s) => s.fields)];
}

// ---------------------------------------------------------------------------
// DOM helpers (no innerHTML for user data)
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else if (k === 'open') el.open = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function render() {
  const app = document.getElementById('app');
  app.replaceChildren(
    store.screen === 'landing' ? renderLanding()
      : store.screen === 'wizard' ? renderWizard()
        : store.screen === 'review' ? renderReview()
          : renderDone()
  );
  app.scrollTop = 0;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function renderLanding() {
  const draft = loadDraft();
  return h('div', { class: 'shell' },
    h('header', { class: 'hero' },
      h('div', { class: 'brand' }, 'BEST Crowd Management'),
      h('h1', {}, 'Report Builder'),
      h('p', { class: 'muted' }, 'Shell Energy Stadium · Houston'),
    ),
    h('main', { class: 'stack' },
      draft && h('div', { class: 'card resume-card' },
        h('div', { class: 'card-title' }, 'Draft in progress'),
        h('p', { class: 'muted' }, `Last saved ${new Date(draft.savedAt || Date.now()).toLocaleString()}`),
        h('button', { class: 'btn primary', onclick: () => resumeDraft(draft) }, 'Resume draft'),
        h('button', { class: 'btn ghost danger', onclick: clearDraft }, 'Clear draft'),
      ),
      ...FORM_REGISTRY.map((f) => h('div', { class: `card form-card${f.active ? '' : ' inactive'}` },
        h('div', { class: 'card-title' }, f.label),
        h('p', { class: 'muted' }, f.description || ''),
        f.active
          ? h('button', { class: 'btn primary', onclick: startFroi }, draft ? 'Start a new FROI' : 'File a FROI')
          : h('span', { class: 'badge' }, 'Coming soon'),
      )),
    ),
    h('footer', { class: 'page-foot muted' }, 'Drafts autosave to this device only.'),
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

function isVisible(field) {
  if (!field.showIf) return true;
  const v = store.answers[field.showIf.field];
  if (field.showIf.in) return field.showIf.in.includes(v);
  if (field.showIf.includes) return Array.isArray(v) && v.includes(field.showIf.includes);
  return true;
}

function setAnswer(id, value, { rerender = false } = {}) {
  store.answers[id] = value;
  saveDraft();
  if (rerender) render();
}

function renderField(f) {
  if (!isVisible(f)) return null;
  const val = store.answers[f.id];
  const fid = `f_${f.id}`;
  const kids = [];
  if (f.label) kids.push(h('label', { class: 'field-label', for: fid }, f.label, f.required && h('span', { class: 'req' }, ' *')));
  if (f.help) kids.push(h('p', { class: 'field-help' }, f.help));

  switch (f.type) {
    case 'text': case 'tel': {
      kids.push(h('input', {
        id: fid, type: f.type === 'tel' ? 'tel' : 'text', value: val || '',
        placeholder: f.placeholder || '', inputmode: f.inputmode || null,
        autocomplete: f.autocomplete || null, enterkeyhint: 'next',
        oninput: (e) => setAnswer(f.id, e.target.value),
      }));
      break;
    }
    case 'date': case 'time': {
      kids.push(h('input', {
        id: fid, type: f.type, value: val || '',
        oninput: (e) => setAnswer(f.id, e.target.value),
      }));
      break;
    }
    case 'textarea': {
      kids.push(h('textarea', {
        id: fid, rows: f.rows || 4, placeholder: f.placeholder || '',
        oninput: (e) => setAnswer(f.id, e.target.value),
      }, val || ''));
      break;
    }
    case 'select': {
      kids.push(h('select', {
        id: fid,
        onchange: (e) => setAnswer(f.id, e.target.value, { rerender: true }),
      },
        h('option', { value: '' }, '— skip for now —'),
        ...f.options.map((o) => h('option', { value: o.value, selected: val === o.value }, o.label)),
      ));
      break;
    }
    case 'choice': {
      kids.push(h('div', { class: `choice-row${f.wrap ? ' wrap' : ''}` },
        ...f.options.map((o) => h('button', {
          type: 'button',
          class: `choice${val === o.value ? ' selected' : ''}`,
          onclick: () => setAnswer(f.id, val === o.value ? '' : o.value, { rerender: true }),
        }, o.label)),
      ));
      break;
    }
    case 'yesno': {
      kids.push(h('div', { class: 'choice-row' },
        ...['Yes', 'No'].map((o) => h('button', {
          type: 'button',
          class: `choice${val === o ? ' selected' : ''}`,
          onclick: () => setAnswer(f.id, val === o ? '' : o, { rerender: true }),
        }, o)),
      ));
      break;
    }
    case 'chips': {
      const arr = Array.isArray(val) ? val : [];
      kids.push(h('div', { class: 'choice-row wrap' },
        ...f.options.map((o) => h('button', {
          type: 'button',
          class: `chip${arr.includes(o.value) ? ' selected' : ''}`,
          onclick: () => {
            const next = arr.includes(o.value) ? arr.filter((x) => x !== o.value) : [...arr, o.value];
            setAnswer(f.id, next, { rerender: true });
          },
        }, o.label)),
      ));
      if (f.freeText) {
        const otherId = `${f.id}Other`;
        kids.push(h('input', {
          type: 'text', value: store.answers[otherId] || '',
          placeholder: f.freeTextLabel || 'Other',
          'aria-label': f.freeTextLabel || 'Other',
          oninput: (e) => setAnswer(otherId, e.target.value),
        }));
      }
      break;
    }
    default:
      kids.push(h('p', { class: 'muted' }, `Unknown field type: ${f.type}`));
  }
  kids.push(h('p', { class: 'field-error', id: `err_${f.id}`, hidden: true }, 'This one is required — it pins down where it happened.'));
  return h('div', { class: 'field', 'data-field': f.id }, ...kids);
}

function sectionFilled(sec) {
  return sec.fields.some((f) => {
    const v = store.answers[f.id];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '';
  });
}

function renderWizard() {
  const step = WIZARD_STEPS[store.step];
  const total = WIZARD_STEPS.length;
  return h('div', { class: 'shell' },
    h('header', { class: 'wiz-head' },
      h('div', { class: 'wiz-meta' },
        h('span', {}, `Step ${store.step + 1} of ${total}`),
        h('span', { id: 'save-indicator', class: 'muted' }, ''),
      ),
      h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: `width:${((store.step + 1) / total) * 100}%` })),
      h('h1', {}, step.title),
      step.intro && h('p', { class: 'muted' }, step.intro),
    ),
    h('main', { class: 'stack' },
      ...(step.fields || []).map(renderField),
      ...(step.sections || []).map((sec) => h('details', { class: 'section', open: !sec.collapsed || sectionFilled(sec) },
        h('summary', {}, sec.label),
        sec.help && h('p', { class: 'field-help' }, sec.help),
        ...sec.fields.map(renderField),
      )),
    ),
    h('footer', { class: 'wiz-foot' },
      h('button', {
        class: 'btn ghost',
        onclick: () => {
          if (store.step === 0) { store.screen = 'landing'; render(); }
          else { store.step--; render(); saveDraft(); }
        },
      }, store.step === 0 ? 'Home' : 'Back'),
      h('button', {
        class: 'btn primary grow',
        onclick: () => {
          if (!validateStep(step)) return;
          if (store.step < total - 1) { store.step++; render(); saveDraft(); }
          else enterReview();
        },
      }, store.step < total - 1 ? 'Next' : 'Review & draft'),
    ),
  );
}

function validateStep(step) {
  let firstBad = null;
  for (const f of allStepFields(step)) {
    if (!f.required || !isVisible(f)) continue;
    const v = store.answers[f.id];
    const bad = Array.isArray(v) ? v.length === 0 : !v || !String(v).trim();
    const err = document.getElementById(`err_${f.id}`);
    if (err) err.hidden = !bad;
    if (bad && !firstBad) firstBad = f.id;
  }
  if (firstBad) {
    const el = document.querySelector(`[data-field="${firstBad}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// AI drafting
// ---------------------------------------------------------------------------

const NARRATIVE_KEYS = [
  ['location', 'location_description', 'Location of incident', 'Environment where it happened — goes in Section 3.'],
  ['incident', 'incident_description', 'Description of incident', 'What happened, step by step.'],
  ['activity', 'activity_description', 'What the employee was doing', 'Their task/rotation when it happened.'],
  ['injury', 'injury_description', 'Injury / illness description', 'Symptoms and complaints as reported — no diagnoses.'],
  ['cause', 'direct_cause', 'Direct cause', 'The machine, tool, object, substance, etc.'],
  ['detailed', 'detailed_narrative', 'Detailed narrative (page 3 + comments)', 'The comprehensive chronological account.'],
  ['specificInjury', 'specific_injury', 'Specific injury (short)', 'Short phrase, e.g. MINOR WRIST PAIN. Printed uppercase.'],
];

const RESPONSE_KEYS = [
  'location_description', 'incident_description', 'activity_description',
  'injury_description', 'direct_cause', 'detailed_narrative', 'specific_injury',
  'suggested_incident_type', 'suggested_classification', 'classification_rationale', 'flags',
];

function prune(obj) {
  if (Array.isArray(obj)) {
    const a = obj.map(prune).filter((v) => v !== undefined);
    return a.length ? a : undefined;
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (obj === '' || obj == null) return undefined;
  return obj;
}

// PII discipline: only narrative-relevant facts. SSN, DOB, home address, pay
// data, phone numbers and employee # are NEVER sent — they map straight from
// the wizard to PDF fields.
function buildFacts() {
  const a = store.answers;
  return prune({
    claimant_name: [a.firstName, a.lastName].map((s) => (s || '').trim()).filter(Boolean).join(' '),
    job_title: a.jobTitle,
    incident_date: isoToMDY(a.incidentDate),
    incident_time: to12Hour(a.incidentTime),
    date_reported: isoToMDY(a.dateReported),
    initial_classification: a.classification,
    location: { area: a.locationPick, exact_spot: a.exactSpot, indoor_outdoor: a.indoorOutdoor },
    surface_type: a.surfaceType,
    surface_condition: a.surfaceCondition,
    weather: a.weather,
    body_parts: [...(Array.isArray(a.bodyParts) ? a.bodyParts : []), a.bodyPartsOther].filter(Boolean).join(', '),
    direct_cause_object: a.causeObject,
    could_have_taken_alternate_path: a.altPath,
    was_carrying_anything: a.carrying,
    distracted_or_in_a_hurry: a.distracted,
    performing_normal_job_functions: a.normalDuties,
    questionable_case: a.questionableCase,
    treatment_beyond_first_aid: a.beyondFirstAid,
    hospital: a.hospitalName,
    physician: a.physicianName,
    lost_consciousness: a.lostConsciousness,
    ambulance_called: a.ambulanceCalled,
    ambulance_transport: a.transport,
    fatality: a.fatality,
    missed_days: a.missedDays,
    missed_days_count: a.missedDaysCount,
    return_to_work_date: isoToMDY(a.returnDate),
    footwear: { description: a.footwearDesc, condition: a.footwearCondition },
    ppe: a.ppe,
    chair_involved: a.chairInvolved, chair_type: a.chairType, chair_condition: a.chairCondition,
    stairs_involved: a.stairsInvolved, handrail: a.handrail, stair_condition: a.stairCondition,
    fall_from_elevation: a.elevationFall,
    ladder_involved: a.ladderInvolved, ladder_condition: a.ladderCondition,
    hours_on_duty_prior: a.hoursOnDuty,
    hours_prior_7_days: a.hoursPrior7,
    witnesses: [
      { name: a.w1_name, type: [...(Array.isArray(a.w1_type) ? a.w1_type : []), a.w1_typeOther].filter(Boolean).join('/') },
      { name: a.w2_name, type: [...(Array.isArray(a.w2_type) ? a.w2_type : []), a.w2_typeOther].filter(Boolean).join('/') },
    ].filter((w) => w.name),
    supporting_documentation: [...(Array.isArray(a.docs) ? a.docs : []), a.docsOther].filter(Boolean).join(', '),
    direct_supervisor: a.supervisor,
    additional_comments: a.extraComments,
  }) || {};
}

function enterReview() {
  store.screen = 'review';
  maybeDraft();
  render();
  saveDraft();
}

function maybeDraft() {
  if (!DRAFT_ENDPOINT) { store.ai.status = 'error'; store.ai.error = 'no-endpoint'; return; }
  const key = JSON.stringify({ facts: buildFacts(), notes: store.answers.notes || '' });
  if (store.ai.status === 'done' && store.ai.key === key) return; // unchanged — keep draft
  if (store.ai.status === 'loading') return;
  callDraft(key);
}

async function callDraft(key) {
  store.ai = { status: 'loading', data: store.ai.data, error: null, key };
  render();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(DRAFT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: key,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`draft endpoint returned ${res.status}`);
    const data = await res.json();
    for (const k of RESPONSE_KEYS) {
      if (!(k in data)) throw new Error(`draft response missing ${k}`);
    }
    // Fill only empty narrative boxes — never clobber the filer's edits.
    for (const [localKey, respKey] of NARRATIVE_KEYS) {
      if (!store.narratives[localKey]) store.narratives[localKey] = String(data[respKey] || '');
    }
    store.ai = { status: 'done', data, error: null, key };
    saveDraft();
  } catch (e) {
    store.ai = { status: 'error', data: store.ai.data, error: e.name === 'AbortError' ? 'timed out' : String(e.message || e), key: '' };
  } finally {
    clearTimeout(timeout);
    if (store.screen === 'review') render();
  }
}

function redraft() {
  if (store.ai.status === 'loading') return;
  const hasText = NARRATIVE_KEYS.some(([k]) => store.narratives[k]);
  if (hasText && !window.confirm('Re-run the AI draft? This replaces all seven narrative boxes with fresh drafts.')) return;
  store.narratives = emptyNarratives();
  callDraft(JSON.stringify({ facts: buildFacts(), notes: store.answers.notes || '' }));
}

// ---------------------------------------------------------------------------
// Review screen
// ---------------------------------------------------------------------------

function fmtValue(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return isoToMDY(v);
  if (/^\d{1,2}:\d{2}$/.test(String(v))) return to12Hour(v);
  return String(v);
}

function blanksList() {
  const a = store.answers;
  const out = [];
  for (const [id, label, onlyIf] of FOLLOW_UP_FIELDS) {
    if (onlyIf && !onlyIf(a)) continue;
    const v = a[id];
    const empty = Array.isArray(v) ? v.length === 0 : !v || !String(v).trim();
    if (empty) out.push(label);
  }
  if (!a.w1_name && !a.w2_name) out.push('Witness names/contact (confirm there were none)');
  if (!store.incidentType) out.push('Type of incident (page 3)');
  return out;
}

function confirmChip(done) {
  return h('span', { class: `confirm-chip${done ? ' done' : ''}` }, done ? '✓ Confirmed' : 'Needs confirmation');
}

function renderReview() {
  const a = store.answers;
  const ai = store.ai;
  const manual = ai.status === 'error';
  const loading = ai.status === 'loading';
  const suggestion = ai.data || null;

  const classificationCard = h('div', { class: 'card' },
    h('div', { class: 'card-title-row' }, h('div', { class: 'card-title' }, '1 · Classification & incident type'), confirmChip(store.confirmed.classification)),
    suggestion && suggestion.suggested_classification && h('div', { class: 'ai-note' },
      h('strong', {}, `AI suggests: ${suggestion.suggested_classification}`),
      suggestion.classification_rationale && h('p', {}, suggestion.classification_rationale),
    ),
    manual && h('p', { class: 'field-help' }, 'Pick one — near miss means nobody was actually injured.'),
    h('div', { class: 'choice-row' },
      ...[['Near Miss', 'Near miss — no injury'], ['Workers Comp', "Workers' Comp claim — injury"]].map(([v, label]) => h('button', {
        type: 'button',
        class: `choice${store.classification === v ? ' selected' : ''}`,
        onclick: () => { store.classification = v; store.confirmed.classification = true; saveDraft(); render(); },
      }, label)),
    ),
    h('p', { class: 'field-help' }, 'Tap to confirm — even if it matches what you picked at the start.'),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'f_incidentType' }, 'Type of incident (page 3)'),
      suggestion && suggestion.suggested_incident_type && !store.incidentType && h('button', {
        type: 'button', class: 'btn ghost small',
        onclick: () => { store.incidentType = suggestion.suggested_incident_type; saveDraft(); render(); },
      }, `Use AI suggestion: ${suggestion.suggested_incident_type}`),
      h('select', {
        id: 'f_incidentType',
        onchange: (e) => { store.incidentType = e.target.value; saveDraft(); render(); },
      },
        h('option', { value: '' }, '— choose —'),
        ...OPTIONS['Type of Incident'].map((v) => h('option', { value: v, selected: store.incidentType === v }, v)),
      ),
      store.incidentType === 'Other' && h('input', {
        type: 'text', placeholder: 'Other — describe the incident type', value: store.incidentTypeOther,
        oninput: (e) => { store.incidentTypeOther = e.target.value; saveDraft(); },
      }),
    ),
    suggestion && Array.isArray(suggestion.flags) && suggestion.flags.length > 0 && h('div', { class: 'flags' },
      h('strong', {}, 'AI flagged:'),
      h('ul', {}, ...suggestion.flags.map((f) => h('li', {}, String(f)))),
    ),
  );

  const narrativesCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '2 · Narrative — review every word'),
    loading && h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Drafting formal narrative from your notes…'),
      ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' })),
    ),
    manual && h('div', { class: 'banner warn' },
      ai.error === 'no-endpoint'
        ? 'AI drafting is not configured — write the narrative by hand below. Your raw notes are underneath for reference.'
        : `AI drafting is unavailable (${ai.error}) — write the narrative by hand below, or retry.`,
      DRAFT_ENDPOINT && h('button', { class: 'btn ghost small', onclick: () => callDraft(JSON.stringify({ facts: buildFacts(), notes: a.notes || '' })) }, 'Retry AI draft'),
    ),
    (manual || !loading) && a.notes && h('details', { class: 'section', open: manual },
      h('summary', {}, 'Your raw notes (reference)'),
      h('p', { class: 'raw-notes' }, a.notes),
    ),
    !loading && h('div', { class: 'stack' },
      ...NARRATIVE_KEYS.map(([localKey, , label, help]) => h('div', { class: 'field' },
        h('label', { class: 'field-label', for: `n_${localKey}` }, label),
        help && h('p', { class: 'field-help' }, help),
        h('textarea', {
          id: `n_${localKey}`, rows: localKey === 'detailed' ? 8 : localKey === 'specificInjury' ? 1 : 4,
          oninput: (e) => { store.narratives[localKey] = e.target.value; saveDraft(); },
        }, store.narratives[localKey] || ''),
      )),
      ai.status === 'done' && h('button', { class: 'btn ghost small', onclick: redraft }, 'Re-run AI draft'),
    ),
  );

  const factsCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '3 · Facts on the form'),
    ...REVIEW_SECTIONS.map((sec) => {
      const rows = sec.items
        .map(([id, label]) => [label, a[id]])
        .filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== ''));
      return h('details', { class: 'section', open: false },
        h('summary', {}, sec.label,
          h('button', {
            type: 'button', class: 'edit-link',
            onclick: (e) => { e.preventDefault(); store.screen = 'wizard'; store.step = sec.step; render(); },
          }, 'Edit'),
        ),
        rows.length
          ? h('dl', { class: 'facts' }, ...rows.flatMap(([label, v]) => [h('dt', {}, label), h('dd', {}, fmtValue(v))]))
          : h('p', { class: 'muted' }, 'Nothing entered.'),
      );
    }),
  );

  const defaultsCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '4 · Standing defaults'),
    h('p', { class: 'field-help' }, 'Applied to every FROI automatically. Edit only if this report is different.'),
    h('details', { class: 'section' },
      h('summary', {}, 'View / edit defaults'),
      ...Object.keys(DEFAULTS).map((name) => h('div', { class: 'field' },
        h('label', { class: 'field-label', for: `d_${name}` }, defaultLabel(name)),
        h('input', {
          id: `d_${name}`, type: 'text', value: store.defaults[name] ?? '',
          oninput: (e) => { store.defaults[name] = e.target.value; saveDraft(); },
        }),
      )),
    ),
  );

  const missedSummary = a.missedDays === 'Yes'
    ? `Yes — ${a.missedDaysCount || '?'} day(s), return ${a.returnDate ? isoToMDY(a.returnDate) : 'TBD'}`
    : a.missedDays === 'No' ? 'No missed days' : 'Not answered yet';

  const confirmationsCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '5 · Confirm the judgment calls'),
    h('p', { class: 'field-help' }, 'These three are decided by you, never by the AI.'),
    h('div', { class: 'confirm-row' },
      h('div', {},
        h('strong', {}, 'Near Miss vs. Workers’ Comp'),
        h('p', { class: 'muted' }, store.classification || 'Not chosen yet — use the buttons in card 1.'),
      ),
      confirmChip(store.confirmed.classification),
    ),
    h('div', { class: 'confirm-row' },
      h('div', {},
        h('strong', {}, 'Treatment beyond first aid?'),
        h('div', { class: 'choice-row' },
          ...['Yes', 'No'].map((v) => h('button', {
            type: 'button', class: `choice small${a.beyondFirstAid === v ? ' selected' : ''}`,
            onclick: () => { setAnswer('beyondFirstAid', v); store.confirmed.firstAid = true; saveDraft(); render(); },
          }, v)),
        ),
      ),
      confirmChip(store.confirmed.firstAid),
    ),
    h('div', { class: 'confirm-row' },
      h('div', {},
        h('strong', {}, 'Missed days of work?'),
        h('p', { class: 'muted' }, missedSummary),
        h('div', { class: 'choice-row' },
          ...['Yes', 'No'].map((v) => h('button', {
            type: 'button', class: `choice small${a.missedDays === v ? ' selected' : ''}`,
            onclick: () => { setAnswer('missedDays', v); store.confirmed.missedDays = true; saveDraft(); render(); },
          }, v)),
        ),
        a.missedDays === 'Yes' && h('div', { class: 'inline-fields' },
          h('input', {
            type: 'text', inputmode: 'numeric', placeholder: 'How many days?', value: a.missedDaysCount || '',
            oninput: (e) => setAnswer('missedDaysCount', e.target.value),
          }),
          h('input', {
            type: 'date', value: a.returnDate || '', 'aria-label': 'Return-to-work date',
            oninput: (e) => setAnswer('returnDate', e.target.value),
          }),
        ),
      ),
      confirmChip(store.confirmed.missedDays),
    ),
  );

  const blanks = blanksList();
  const blanksCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '6 · Left blank — need from you'),
    blanks.length
      ? h('ul', { class: 'blank-list' }, ...blanks.map((b) => h('li', {}, b)))
      : h('p', { class: 'muted' }, 'Nothing — every follow-up field is filled.'),
    h('p', { class: 'field-help' }, 'Blanks stay blank on the PDF — nothing is ever invented. Chase these down and pencil them in later; the PDF stays editable.'),
  );

  const canGenerate = store.confirmed.classification && store.confirmed.firstAid && store.confirmed.missedDays && !!store.classification;

  return h('div', { class: 'shell' },
    h('header', { class: 'wiz-head' },
      h('div', { class: 'wiz-meta' }, h('span', {}, 'Review & generate'), h('span', { id: 'save-indicator', class: 'muted' }, '')),
      h('h1', {}, 'Check everything, then generate'),
    ),
    h('main', { class: 'stack' },
      classificationCard, narrativesCard, factsCard, defaultsCard, confirmationsCard, blanksCard,
      !canGenerate && h('p', { class: 'muted center' }, 'Generate unlocks once all three judgment calls are confirmed.'),
    ),
    h('footer', { class: 'wiz-foot' },
      h('button', { class: 'btn ghost', onclick: () => { store.screen = 'wizard'; store.step = WIZARD_STEPS.length - 1; render(); } }, 'Back'),
      h('button', { class: 'btn primary grow', disabled: !canGenerate, onclick: onGenerate }, 'Generate FROI PDF'),
    ),
  );
}

function defaultLabel(name) {
  const labels = {
    'Company #': 'Company #',
    'Branch': 'Branch',
    'Job number where incident occured': 'Job number',
    'Text Field5': 'Location line 2',
    'Text Field6': 'Location line 3',
    'Nametitle of person completing FROI': 'Completed by (name/title)',
    'Manager ID Number': 'Manager ID number',
    'Phone Number_2': 'Reporting manager phone',
    'Combo Box4': 'Footwear condition default',
  };
  return labels[name] || name;
}

// ---------------------------------------------------------------------------
// PDF generation & download
// ---------------------------------------------------------------------------

async function getTemplateBytes() {
  if (templateBytesCache) return templateBytesCache;
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error(`could not load template (${res.status})`);
  templateBytesCache = await res.arrayBuffer();
  return templateBytesCache;
}

function outputFilename() {
  const last = (store.answers.lastName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9-]+/g, '') || 'UNKNOWN';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(store.answers.incidentDate || '') ? store.answers.incidentDate : todayISO();
  return `FROI_${last}_${date}.pdf`;
}

async function onGenerate() {
  if (!window.PDFLib) {
    window.alert('The PDF library failed to load (check the connection) — reload the page and try again.');
    return;
  }
  try {
    const templateBytes = await getTemplateBytes();
    const fill = buildFill(store);
    const bytes = await fillFroi(window.PDFLib, templateBytes, fill);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (store.generated?.url) URL.revokeObjectURL(store.generated.url);
    store.generated = { url: URL.createObjectURL(blob), filename: outputFilename() };
    store.screen = 'done';
    render();
    triggerDownload();
  } catch (e) {
    window.alert(`PDF generation failed: ${e.message || e}`);
  }
}

function triggerDownload() {
  if (!store.generated) return;
  const aEl = document.createElement('a');
  aEl.href = store.generated.url;
  aEl.download = store.generated.filename;
  document.body.appendChild(aEl);
  aEl.click();
  aEl.remove();
}

// ---------------------------------------------------------------------------
// Done screen & copyable summary
// ---------------------------------------------------------------------------

function summaryText() {
  const a = store.answers;
  const claimant = [a.lastName, a.firstName].map((s) => (s || '').trim().toUpperCase()).filter(Boolean).join(', ') || 'UNKNOWN';
  const lines = [];
  lines.push(`FROI — ${claimant} — ${isoToMDY(a.incidentDate) || 'date unknown'}`);
  lines.push('Entered:');
  for (const sec of REVIEW_SECTIONS) {
    const vals = sec.items
      .map(([id, label]) => [label, a[id]])
      .filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== ''))
      .map(([label, v]) => `${label}: ${fmtValue(v)}`);
    if (vals.length) lines.push(`- ${sec.label}: ${vals.join('; ')}`);
  }
  const blanks = blanksList();
  lines.push(`Left blank / need from you: ${blanks.length ? blanks.join('; ') : 'nothing'}`);
  const missed = a.missedDays === 'Yes'
    ? `missed days: Yes (${a.missedDaysCount || '?'} days, return ${a.returnDate ? isoToMDY(a.returnDate) : 'TBD'})`
    : `missed days: ${a.missedDays || 'unconfirmed'}`;
  lines.push(`Confirmed: ${store.classification === 'Near Miss' ? 'Near Miss (no injury)' : "Workers' Comp claim"}; treatment beyond first aid: ${a.beyondFirstAid || 'unconfirmed'}; ${missed}`);
  lines.push(`Reminder: send completed form + supporting docs to ${SUBMIT_EMAIL} ${SUBMIT_DEADLINE}.`);
  return lines.join('\n');
}

async function copySummary(btn) {
  const text = summaryText();
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    btn.textContent = 'Copied ✓';
  }
  setTimeout(() => { btn.textContent = 'Copy summary'; }, 1600);
}

function renderDone() {
  const blanks = blanksList();
  return h('div', { class: 'shell' },
    h('header', { class: 'wiz-head' }, h('h1', {}, 'FROI generated')),
    h('main', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'card-title' }, store.generated?.filename || 'FROI.pdf'),
        h('p', { class: 'muted' }, 'The PDF keeps its live form fields — anyone can still edit it in Acrobat or a browser.'),
        h('button', { class: 'btn primary', onclick: triggerDownload }, 'Download again'),
        h('button', { class: 'btn ghost', onclick: (e) => copySummary(e.target) }, 'Copy summary'),
      ),
      blanks.length > 0 && h('div', { class: 'card' },
        h('div', { class: 'card-title' }, 'Still blank — chase these down'),
        h('ul', { class: 'blank-list' }, ...blanks.map((b) => h('li', {}, b))),
      ),
      h('div', { class: 'banner' },
        `Send the completed form + supporting docs to ${SUBMIT_EMAIL} ${SUBMIT_DEADLINE}.`,
      ),
    ),
    h('footer', { class: 'wiz-foot' },
      h('button', { class: 'btn ghost', onclick: () => { store.screen = 'review'; render(); } }, 'Back to review'),
      h('button', { class: 'btn ghost danger grow', onclick: clearDraft }, 'Done — clear draft'),
    ),
  );
}

// ---------------------------------------------------------------------------

render();
