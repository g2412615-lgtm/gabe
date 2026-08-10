// app.js — wizard engine, state, review screen, PDF generation.
// The engine is generic: everything form-specific (steps, field map, fill
// mapping, AI facts payload, narrative contract) is loaded dynamically from
// forms/<id>/wizard.js + forms/<id>/fieldmap.js based on the registry entry,
// so adding a form is a new folder + a registry entry — no engine changes.

import {
  DRAFT_ENDPOINT, DEFAULTS, FORM_REGISTRY, SUBMIT_EMAIL, SUBMIT_DEADLINE,
} from './config.js';

// ---------------------------------------------------------------------------
// Per-form module loading
// ---------------------------------------------------------------------------

const formCache = {};
let FORM = null; // the active form's merged module exports + metadata

async function loadForm(id) {
  if (!formCache[id]) {
    const [wizard, fieldmap] = await Promise.all([
      import(`./forms/${id}/wizard.js`),
      import(`./forms/${id}/fieldmap.js`),
    ]);
    const fieldIdx = {};
    for (const step of wizard.WIZARD_STEPS) {
      for (const f of allStepFields(step)) fieldIdx[f.id] = f;
    }
    formCache[id] = {
      id,
      ...wizard,
      ...fieldmap,
      fieldIdx,
      templateUrl: `forms/${id}/template.pdf`,
      draftKey: `${id}.draft.v1`,
    };
  }
  return formCache[id];
}

function allStepFields(step) {
  return [...(step.fields || []), ...(step.sections || []).flatMap((s) => s.fields)];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const emptyNarratives = () => ({
  location: '', incident: '', activity: '', injury: '', cause: '', detailed: '', specificInjury: '',
});

const store = {
  screen: 'landing', // landing | wizard | review | done
  formId: null,
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

// Answers that back a required confirmation: changing them un-confirms.
const CONFIRMATION_ANSWERS = { beyondFirstAid: 'firstAid', missedDays: 'missedDays' };

// Remembered open/closed state for <details> sections across re-renders.
const openSections = {};

const templateBytesCache = {};
let saveTimer = null;

// Draft-request ownership: a response may only touch state if no reset
// happened while it was in flight — otherwise a slow response could write the
// PREVIOUS report's narrative (another claimant's details) into a fresh one.
let draftEpoch = 0;
let draftController = null;

function cancelDraft() {
  draftEpoch++;
  if (draftController) {
    draftController.abort();
    draftController = null;
  }
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resetState(formId) {
  cancelDraft();
  store.formId = formId;
  store.step = 0;
  store.answers = {};
  store.narratives = emptyNarratives();
  store.defaults = { ...DEFAULTS };
  store.classification = '';
  store.incidentType = '';
  store.incidentTypeOther = '';
  store.confirmed = { classification: false, firstAid: false, missedDays: false };
  store.ai = { status: 'idle', data: null, error: null, key: '' };
  if (store.generated?.url) URL.revokeObjectURL(store.generated.url);
  store.generated = null;
  store.savedAt = null;
  for (const k of Object.keys(openSections)) delete openSections[k];
}

function saveDraft() {
  if (!FORM) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.savedAt = new Date().toISOString();
    const { formId, screen, step, answers, narratives, defaults, classification, incidentType, incidentTypeOther, confirmed, savedAt } = store;
    let saved = false;
    try {
      localStorage.setItem(FORM.draftKey, JSON.stringify({
        version: 1, formId, screen, step, answers, narratives, defaults, classification, incidentType, incidentTypeOther, confirmed, savedAt,
      }));
      saved = true;
    } catch { /* storage full or blocked — keep working in memory */ }
    const el = document.getElementById('save-indicator');
    if (el) {
      el.textContent = saved ? 'Draft saved' : 'NOT saved — storage unavailable';
      el.classList.toggle('save-failed', !saved);
    }
  }, 250);
}

function loadDraftFor(id) {
  try {
    const raw = localStorage.getItem(`${id}.draft.v1`);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.version === 1 ? d : null;
  } catch { return null; }
}

async function resumeForm(entry, draft) {
  try {
    FORM = await loadForm(entry.id);
  } catch (e) {
    window.alert(`Could not load the ${entry.label} form: ${e.message || e}`);
    return;
  }
  resetState(entry.id);
  store.step = Math.min(draft.step || 0, FORM.WIZARD_STEPS.length - 1);
  store.answers = draft.answers || {};
  store.narratives = { ...emptyNarratives(), ...(draft.narratives || {}) };
  store.defaults = { ...DEFAULTS, ...(draft.defaults || {}) };
  store.classification = draft.classification || '';
  store.incidentType = draft.incidentType || '';
  store.incidentTypeOther = draft.incidentTypeOther || '';
  store.confirmed = { classification: false, firstAid: false, missedDays: false, ...(draft.confirmed || {}) };
  store.savedAt = draft.savedAt || null;
  applyWizardDefaults();
  store.screen = draft.screen === 'review' ? 'review' : 'wizard';
  if (store.screen === 'review') maybeDraft();
  render();
}

async function startForm(entry) {
  const existing = loadDraftFor(entry.id);
  if (existing && !window.confirm('Start a new report? The saved draft on this device will be deleted.')) return;
  try {
    FORM = await loadForm(entry.id);
  } catch (e) {
    window.alert(`Could not load the ${entry.label} form: ${e.message || e}`);
    return;
  }
  resetState(entry.id);
  try { localStorage.removeItem(FORM.draftKey); } catch {}
  applyWizardDefaults();
  store.screen = 'wizard';
  render();
  saveDraft();
}

function clearDraft() {
  if (!window.confirm('Delete this draft from the device? Drafts contain personal information — clear them once the report is filed.')) return;
  if (FORM) { try { localStorage.removeItem(FORM.draftKey); } catch {} }
  resetState(null);
  FORM = null;
  store.screen = 'landing';
  render();
}

// Wizard-level defaults (dates default to today, branch questions default to
// No, footwear condition defaults to Good) — applied only when unanswered.
function applyWizardDefaults() {
  for (const step of FORM.WIZARD_STEPS) {
    for (const f of allStepFields(step)) {
      if (store.answers[f.id] !== undefined && store.answers[f.id] !== '') continue;
      if (f.defaultToday) store.answers[f.id] = todayISO();
      else if (f.default !== undefined) store.answers[f.id] = f.default;
    }
  }
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

// A <details> that remembers the USER's open/closed choice across re-renders.
// The initial programmatic `open` assignment queues a native toggle event too;
// tracking the expected state keeps that from being recorded as a user choice
// (which would pin a computed default forever).
function detailsSection(key, defaultOpen, attrs, ...children) {
  const open = key in openSections ? openSections[key] : defaultOpen;
  const el = h('details', { ...attrs, open }, ...children);
  let expected = open;
  el.addEventListener('toggle', () => {
    if (el.open === expected) return; // programmatic — not a user choice
    expected = el.open;
    openSections[key] = el.open;
  });
  return el;
}

// keepScroll: true for in-place answer updates so a tap doesn't yank the
// viewport back to the top of a long step; navigation renders scroll to top.
function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  const app = document.getElementById('app');
  app.replaceChildren(
    store.screen === 'landing' ? renderLanding()
      : store.screen === 'wizard' ? renderWizard()
        : store.screen === 'review' ? renderReview()
          : renderDone()
  );
  if (keepScroll) {
    window.scrollTo(0, y);
  } else {
    app.scrollTop = 0;
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function renderLanding() {
  const drafts = FORM_REGISTRY.filter((f) => f.active)
    .map((f) => ({ entry: f, draft: loadDraftFor(f.id) }))
    .filter((d) => d.draft);
  return h('div', { class: 'shell' },
    h('header', { class: 'hero' },
      h('div', { class: 'brand' }, 'BEST Crowd Management'),
      h('h1', {}, 'Report Builder'),
      h('p', { class: 'muted' }, 'Shell Energy Stadium · Houston'),
    ),
    h('main', { class: 'stack' },
      ...drafts.map(({ entry, draft }) => h('div', { class: 'card resume-card' },
        h('div', { class: 'card-title' }, `${entry.label} — draft in progress`),
        h('p', { class: 'muted' }, `Last saved ${new Date(draft.savedAt || Date.now()).toLocaleString()}`),
        h('button', { class: 'btn primary', onclick: () => resumeForm(entry, draft) }, 'Resume draft'),
        h('button', {
          class: 'btn ghost danger',
          onclick: async () => {
            if (!window.confirm('Delete this draft from the device? Drafts contain personal information.')) return;
            try { localStorage.removeItem(`${entry.id}.draft.v1`); } catch {}
            render();
          },
        }, 'Clear draft'),
      )),
      ...FORM_REGISTRY.map((f) => h('div', { class: `card form-card${f.active ? '' : ' inactive'}` },
        h('div', { class: 'card-title' }, f.label),
        h('p', { class: 'muted' }, f.description || ''),
        f.active
          ? h('button', { class: 'btn primary', onclick: () => startForm(f) },
            loadDraftFor(f.id) ? 'Start a new report' : (f.cta || `File: ${f.label}`))
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
  if (!field || !field.showIf) return true;
  const v = store.answers[field.showIf.field];
  if (field.showIf.in) return field.showIf.in.includes(v);
  if (field.showIf.includes) return Array.isArray(v) && v.includes(field.showIf.includes);
  return true;
}

// Whether an answer's question is currently asked at all (its wizard field is
// not hidden behind a showIf). Used to keep facts, summary, and blanks lists
// consistent with what the filer was actually asked.
function isAnswerVisible(id) {
  return isVisible(FORM.fieldIdx[id]);
}

function setAnswer(id, value, { rerender = false } = {}) {
  const changed = store.answers[id] !== value;
  store.answers[id] = value;
  // Changing an answer that backs a required confirmation un-confirms it.
  if (changed && CONFIRMATION_ANSWERS[id]) {
    store.confirmed[CONFIRMATION_ANSWERS[id]] = false;
  }
  saveDraft();
  if (rerender) render({ keepScroll: true });
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
  const step = FORM.WIZARD_STEPS[store.step];
  const total = FORM.WIZARD_STEPS.length;
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
      ...(step.sections || []).map((sec) => detailsSection(
        `wiz:${step.id}:${sec.label}`, !sec.collapsed || sectionFilled(sec), { class: 'section' },
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

function draftRequestKey() {
  return JSON.stringify({ facts: FORM.buildFacts(store.answers), notes: store.answers.notes || '' });
}

function enterReview() {
  store.screen = 'review';
  maybeDraft();
  render();
  saveDraft();
}

function maybeDraft() {
  if (!DRAFT_ENDPOINT) { store.ai.status = 'error'; store.ai.error = 'no-endpoint'; return; }
  const key = draftRequestKey();
  if (store.ai.status === 'done' && store.ai.key === key) return; // unchanged — keep draft
  if (store.ai.status === 'loading') return;
  callDraft(key);
}

async function callDraft(key, { overwrite = false } = {}) {
  const epoch = draftEpoch;
  store.ai = { status: 'loading', data: store.ai.data, error: null, key };
  render({ keepScroll: true });
  const controller = new AbortController();
  draftController = controller;
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
    if (epoch !== draftEpoch) return; // a reset happened mid-flight — this response belongs to a dead report
    for (const k of FORM.RESPONSE_KEYS) {
      if (!(k in data)) throw new Error(`draft response missing ${k}`);
    }
    // Fill empty narrative boxes; clobber existing text only on an explicit
    // re-draft (the filer confirmed the replacement first).
    for (const [localKey, respKey] of FORM.NARRATIVE_KEYS) {
      if (overwrite || !store.narratives[localKey]) store.narratives[localKey] = String(data[respKey] || '');
    }
    store.ai = { status: 'done', data, error: null, key };
    saveDraft();
  } catch (e) {
    if (epoch !== draftEpoch) return;
    // A confirmed replace-all keeps its intent across the failure so Retry
    // still delivers the replacement the filer already agreed to.
    store.ai = {
      status: 'error', data: store.ai.data,
      error: e.name === 'AbortError' ? 'timed out' : String(e.message || e),
      key: '', overwritePending: overwrite,
    };
  } finally {
    clearTimeout(timeout);
    if (draftController === controller) draftController = null;
    if (epoch === draftEpoch && store.screen === 'review') render({ keepScroll: true });
  }
}

function retryDraft() {
  callDraft(draftRequestKey(), { overwrite: store.ai.overwritePending === true });
}

function redraft() {
  if (store.ai.status === 'loading') return;
  const hasText = FORM.NARRATIVE_KEYS.some(([k]) => store.narratives[k]);
  if (hasText && !window.confirm('Re-run the AI draft? This replaces all seven narrative boxes with fresh drafts.')) return;
  // Existing text is kept until the new draft actually arrives — a failed
  // request must never destroy hand-written narrative.
  callDraft(draftRequestKey(), { overwrite: true });
}

// ---------------------------------------------------------------------------
// Review screen
// ---------------------------------------------------------------------------

function fmtValue(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return FORM.isoToMDY(v);
  if (/^\d{1,2}:\d{2}$/.test(String(v))) return FORM.to12Hour(v);
  return String(v);
}

function blanksList() {
  const a = store.answers;
  const out = [];
  for (const [id, label, onlyIf] of FORM.FOLLOW_UP_FIELDS) {
    if (onlyIf && !onlyIf(a)) continue;
    if (!isAnswerVisible(id)) continue;
    const v = a[id];
    const empty = Array.isArray(v) ? v.length === 0 : !v || !String(v).trim();
    if (empty) out.push(label);
  }
  if (typeof FORM.extraBlanks === 'function') out.push(...FORM.extraBlanks(store));
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
        onclick: () => { store.classification = v; store.confirmed.classification = true; saveDraft(); render({ keepScroll: true }); },
      }, label)),
    ),
    h('p', { class: 'field-help' }, 'Tap to confirm — even if it matches what you picked at the start.'),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'f_incidentType' }, 'Type of incident (page 3)'),
      suggestion && suggestion.suggested_incident_type && !store.incidentType && h('button', {
        type: 'button', class: 'btn ghost small',
        onclick: () => { store.incidentType = suggestion.suggested_incident_type; saveDraft(); render({ keepScroll: true }); },
      }, `Use AI suggestion: ${suggestion.suggested_incident_type}`),
      h('select', {
        id: 'f_incidentType',
        onchange: (e) => { store.incidentType = e.target.value; saveDraft(); render({ keepScroll: true }); },
      },
        h('option', { value: '' }, '— choose —'),
        ...FORM.OPTIONS['Type of Incident'].map((v) => h('option', { value: v, selected: store.incidentType === v }, v)),
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
      DRAFT_ENDPOINT && h('button', { class: 'btn ghost small', onclick: retryDraft }, 'Retry AI draft'),
    ),
    (manual || !loading) && a.notes && detailsSection('rev:rawnotes', manual, { class: 'section' },
      h('summary', {}, 'Your raw notes (reference)'),
      h('p', { class: 'raw-notes' }, a.notes),
    ),
    !loading && h('div', { class: 'stack' },
      ...FORM.NARRATIVE_KEYS.map(([localKey, , label, help]) => h('div', { class: 'field' },
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
    ...FORM.REVIEW_SECTIONS.map((sec) => {
      const rows = sec.items
        .filter(([id]) => isAnswerVisible(id))
        .map(([id, label]) => [label, a[id]])
        .filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== ''));
      return detailsSection(`rev:facts:${sec.label}`, false, { class: 'section' },
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
    detailsSection('rev:defaults', false, { class: 'section' },
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
    ? `Yes — ${a.missedDaysCount || '?'} day(s), return ${a.returnDate ? FORM.isoToMDY(a.returnDate) : 'TBD'}`
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
            onclick: () => { setAnswer('beyondFirstAid', v); store.confirmed.firstAid = true; saveDraft(); render({ keepScroll: true }); },
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
            onclick: () => { setAnswer('missedDays', v); store.confirmed.missedDays = true; saveDraft(); render({ keepScroll: true }); },
          }, v)),
        ),
        a.missedDays === 'Yes' && h('div', { class: 'inline-fields' },
          h('input', {
            type: 'text', inputmode: 'numeric', placeholder: 'How many days?', value: a.missedDaysCount || '',
            oninput: (e) => setAnswer('missedDaysCount', e.target.value),
            onchange: () => render({ keepScroll: true }), // refresh summary + blanks once typing settles
          }),
          h('input', {
            type: 'date', value: a.returnDate || '', 'aria-label': 'Return-to-work date',
            oninput: (e) => setAnswer('returnDate', e.target.value),
            onchange: () => render({ keepScroll: true }),
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

  // Generate needs all three confirmations AND live answers behind them —
  // un-confirming (or clearing an answer in the wizard) re-locks the button.
  const canGenerate = store.confirmed.classification && !!store.classification
    && store.confirmed.firstAid && !!a.beyondFirstAid
    && store.confirmed.missedDays && !!a.missedDays;

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
      h('button', { class: 'btn ghost', onclick: () => { store.screen = 'wizard'; store.step = FORM.WIZARD_STEPS.length - 1; render(); } }, 'Back'),
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
  if (templateBytesCache[FORM.id]) return templateBytesCache[FORM.id];
  const res = await fetch(FORM.templateUrl);
  if (!res.ok) throw new Error(`could not load template (${res.status})`);
  templateBytesCache[FORM.id] = await res.arrayBuffer();
  return templateBytesCache[FORM.id];
}

async function onGenerate() {
  if (!window.PDFLib) {
    window.alert('The PDF library failed to load (check the connection) — reload the page and try again.');
    return;
  }
  try {
    const templateBytes = await getTemplateBytes();
    const fill = FORM.buildFill(store);
    const bytes = await FORM.fillFroi(window.PDFLib, templateBytes, fill);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (store.generated?.url) URL.revokeObjectURL(store.generated.url);
    store.generated = { url: URL.createObjectURL(blob), filename: FORM.outputFilename(store.answers, todayISO()) };
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
  lines.push(`FROI — ${claimant} — ${FORM.isoToMDY(a.incidentDate) || 'date unknown'}`);
  lines.push('Entered:');
  for (const sec of FORM.REVIEW_SECTIONS) {
    const vals = sec.items
      .filter(([id]) => isAnswerVisible(id))
      .map(([id, label]) => [label, a[id]])
      .filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== ''))
      .map(([label, v]) => `${label}: ${fmtValue(v)}`);
    if (vals.length) lines.push(`- ${sec.label}: ${vals.join('; ')}`);
  }
  const blanks = blanksList();
  lines.push(`Left blank / need from you: ${blanks.length ? blanks.join('; ') : 'nothing'}`);
  const missed = a.missedDays === 'Yes'
    ? `missed days: Yes (${a.missedDaysCount || '?'} days, return ${a.returnDate ? FORM.isoToMDY(a.returnDate) : 'TBD'})`
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
