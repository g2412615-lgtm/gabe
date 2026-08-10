// forms/froi/wizard.js — FROI wizard step definitions (pure data; the engine in
// app.js renders these). Plain language throughout — the filer never needs to
// know form vocabulary. Answer values that map to PDF choice fields use the
// form's EXACT option strings (including its misspellings); labels are friendly.

import { LOCATION_PICKS } from '../../config.js';
import { OPTIONS } from './fieldmap.js';

const opt = (value, label) => ({ value, label: label || value });
const yesNo = (id, label, help, extra) => ({ id, type: 'yesno', label, help, ...extra });

// Friendly labels over the form's exact (sometimes misspelled) option strings.
const SURFACE_CONDITION_LABELS = { 'Debris/Obsticle': 'Debris / obstacle', 'Icey': 'Icy', 'Oiley': 'Oily' };

export const WIZARD_STEPS = [
  {
    id: 'basics',
    title: 'Basics',
    intro: 'A few quick facts to get started.',
    fields: [
      {
        id: 'classification', type: 'choice', label: 'What kind of report is this?',
        options: [
          opt('Near Miss', 'Near miss — nobody was injured'),
          opt('Workers Comp', 'Injury — someone got hurt'),
          opt('Not sure yet', "Not sure yet — I'll decide at review"),
        ],
        help: 'You will confirm this at the end — the AI can suggest one based on what happened.',
      },
      { id: 'incidentDate', type: 'date', label: 'Date of incident', defaultToday: true },
      { id: 'incidentTime', type: 'time', label: 'Time of incident' },
      { id: 'dateReported', type: 'date', label: 'Date it was reported to you', defaultToday: true },
    ],
  },
  {
    id: 'who',
    title: 'Who got hurt',
    fields: [
      { id: 'lastName', type: 'text', label: 'Last name', autocomplete: 'off' },
      { id: 'firstName', type: 'text', label: 'First name', autocomplete: 'off' },
      { id: 'employeeNumber', type: 'text', label: 'Employee #', inputmode: 'numeric' },
      { id: 'jobTitle', type: 'text', label: 'Job title', placeholder: 'e.g., Event Security Officer' },
      { id: 'claimantPhone', type: 'tel', label: 'Their phone number' },
    ],
    sections: [
      {
        label: 'More claimant details (optional)', collapsed: true,
        help: "Skip anything you don't have — it'll be flagged for follow-up.",
        fields: [
          { id: 'dob', type: 'date', label: 'Date of birth' },
          { id: 'ssn', type: 'text', label: 'Social Security Number', inputmode: 'numeric', autocomplete: 'off' },
          { id: 'hireDate', type: 'date', label: 'Hire date' },
          { id: 'sex', type: 'choice', label: 'Sex', options: OPTIONS['Sex'].map((v) => opt(v)) },
          { id: 'address', type: 'text', label: 'Home address', autocomplete: 'off' },
          { id: 'cityST', type: 'text', label: 'City, State', placeholder: 'e.g., Houston, TX' },
          { id: 'zip', type: 'text', label: 'ZIP', inputmode: 'numeric' },
          { id: 'payType', type: 'choice', label: 'Pay type', options: OPTIONS['Pay Type'].map((v) => opt(v)) },
          { id: 'payRate', type: 'text', label: 'Pay rate', inputmode: 'decimal', placeholder: 'e.g., 17.50' },
          { id: 'avgHours', type: 'text', label: 'Average hours/week worked', inputmode: 'numeric' },
        ],
      },
    ],
  },
  {
    id: 'where',
    title: 'Where',
    fields: [
      { id: 'locationPick', type: 'choice', label: 'Where did it happen?', options: LOCATION_PICKS.map((v) => opt(v)), wrap: true },
      {
        id: 'exactSpot', type: 'text', label: 'Exact spot', required: true,
        placeholder: 'e.g., just inside Bayou City Gate, next to the ticket scanners',
      },
      { id: 'indoorOutdoor', type: 'choice', label: 'Indoor or outdoor?', options: [opt('Indoor'), opt('Outdoor')] },
      {
        id: 'surfaceType', type: 'select', label: 'What kind of ground / floor?',
        options: OPTIONS['Combo Box2'].map((v) => opt(v)),
      },
      {
        id: 'surfaceCondition', type: 'select', label: 'Condition of the ground / floor',
        options: OPTIONS['Combo Box3'].map((v) => opt(v, SURFACE_CONDITION_LABELS[v])),
      },
      { id: 'weather', type: 'select', label: 'Weather at the time', options: OPTIONS['Combo Box1'].map((v) => opt(v)) },
    ],
  },
  {
    id: 'what',
    title: 'What happened',
    fields: [
      {
        id: 'notes', type: 'textarea', rows: 9, label: 'Tell the story',
        placeholder: "Tell it like you'd tell a coworker: what were they doing, what happened, what got hurt, what caused it. Times help.",
        help: 'Talk-to-text works great here. The AI turns this into the formal wording — you review every word before anything is filed.',
      },
      {
        id: 'bodyParts', type: 'chips', label: 'What got hurt? (tap all that apply)', freeText: true,
        options: ['Head', 'Neck', 'Shoulder', 'Arm', 'Elbow', 'Wrist', 'Hand', 'Finger', 'Back', 'Hip', 'Leg', 'Knee', 'Ankle', 'Foot'].map((v) => opt(v)),
        freeTextLabel: 'Other / details',
      },
      { id: 'causeObject', type: 'text', label: 'What object, substance, or thing caused it?', placeholder: 'e.g., base of a PMD, wet concrete, forklift' },
      yesNo('altPath', 'Could they have gone a different way?'),
      yesNo('carrying', 'Were they carrying anything?'),
      yesNo('distracted', 'Were they distracted or in a hurry?'),
      yesNo('normalDuties', 'Were they doing their normal job duties?'),
    ],
  },
  {
    id: 'medical',
    title: 'Medical & outcome',
    fields: [
      yesNo('questionableCase', 'Is anything about this case questionable?', 'Answer Yes if any part of the story doesn’t add up.'),
      yesNo('beyondFirstAid', 'Did they get medical treatment beyond first aid?', 'First aid = bandage, ice pack, cleaning a scrape. Beyond = stitches, X-rays, prescriptions, a hospital or clinic evaluation.'),
      { id: 'hospitalName', type: 'text', label: 'Hospital / medical center name', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      { id: 'physicianName', type: 'text', label: 'Physician name', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      { id: 'medAddress', type: 'text', label: 'Facility address', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      { id: 'medCityST', type: 'text', label: 'Facility city, state', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      { id: 'medZip', type: 'text', label: 'Facility ZIP', inputmode: 'numeric', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      { id: 'medPhone', type: 'tel', label: 'Facility phone', showIf: { field: 'beyondFirstAid', in: ['Yes'] } },
      yesNo('lostConsciousness', 'Did they black out or lose consciousness?'),
      yesNo('ambulanceCalled', 'Was an ambulance called to the scene?'),
      {
        id: 'transport', type: 'choice', label: 'Did they take the ambulance ride?',
        options: [opt('Accepted', 'Accepted transport'), opt('Refused', 'Refused transport')],
        showIf: { field: 'ambulanceCalled', in: ['Yes'] },
        help: 'This goes into the narrative, not a checkbox.',
      },
      yesNo('fatality', 'Did the incident result in a death?'),
      yesNo('missedDays', 'Will they miss any days of work (or already have)?'),
      { id: 'missedDaysCount', type: 'text', label: 'How many days?', inputmode: 'numeric', showIf: { field: 'missedDays', in: ['Yes'] } },
      { id: 'returnDate', type: 'date', label: 'Return-to-work date (actual or expected)', showIf: { field: 'missedDays', in: ['Yes'] } },
      { id: 'footwearDesc', type: 'text', label: 'What shoes were they wearing?', placeholder: 'e.g., Black sneakers' },
      {
        id: 'footwearCondition', type: 'choice', label: 'Condition of the shoes', default: 'Good',
        options: ['New', 'Good', 'Fair', 'Poor'].map((v) => opt(v)),
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Conditions & hours',
    intro: 'Quick safety-review questions. Leave the defaults unless something applies.',
    fields: [
      {
        id: 'ppe', type: 'select', label: 'Was protective equipment (PPE) involved?',
        options: OPTIONS['Combo Box11'].map((v) => opt(v)),
      },
      yesNo('chairInvolved', 'Was a chair or stool involved?', null, { default: 'No' }),
      { id: 'chairType', type: 'select', label: 'What kind of chair?', options: OPTIONS['Combo Box6'].map((v) => opt(v)), showIf: { field: 'chairInvolved', in: ['Yes'] } },
      { id: 'chairCondition', type: 'select', label: 'Chair condition', options: OPTIONS['Combo Box7'].map((v) => opt(v)), showIf: { field: 'chairInvolved', in: ['Yes'] } },
      yesNo('stairsInvolved', 'Were stairs involved?', null, { default: 'No' }),
      { id: 'handrail', type: 'choice', label: 'Was a handrail available and used?', options: OPTIONS['Combo Box9'].map((v) => opt(v)), showIf: { field: 'stairsInvolved', in: ['Yes'] } },
      { id: 'stairCondition', type: 'select', label: 'Condition of the stairs', options: OPTIONS['Combo Box10'].map((v) => opt(v)), showIf: { field: 'stairsInvolved', in: ['Yes'] } },
      yesNo('elevationFall', 'Did they fall from a height / elevation?', null, { default: 'No' }),
      yesNo('ladderInvolved', 'Was a ladder involved?', null, { default: 'No' }),
      { id: 'ladderCondition', type: 'select', label: 'Ladder condition', options: OPTIONS['Combo Box14'].map((v) => opt(v)), showIf: { field: 'ladderInvolved', in: ['Yes'] } },
      { id: 'hoursOnDuty', type: 'text', label: 'Hours on duty before the incident', inputmode: 'decimal' },
      { id: 'hoursPrior7', type: 'text', label: 'Hours worked in the prior 7 days', inputmode: 'decimal' },
    ],
  },
  {
    id: 'witnesses',
    title: 'Witnesses & docs',
    fields: [],
    sections: [
      {
        label: 'Witness 1 (tap to add)', collapsed: true,
        fields: [
          {
            id: 'w1_type', type: 'chips', label: 'Who are they?',
            options: [opt('Company', 'BEST employee'), opt('Client', 'Client employee'), opt('Other', 'Other')],
          },
          { id: 'w1_typeOther', type: 'text', label: 'Other — who?', showIf: { field: 'w1_type', includes: 'Other' } },
          { id: 'w1_name', type: 'text', label: 'Name' },
          { id: 'w1_phone', type: 'tel', label: 'Phone' },
          { id: 'w1_address', type: 'text', label: 'Address' },
          { id: 'w1_cityST', type: 'text', label: 'City, State' },
          { id: 'w1_zip', type: 'text', label: 'ZIP', inputmode: 'numeric' },
        ],
      },
      {
        label: 'Witness 2 (tap to add)', collapsed: true,
        fields: [
          {
            id: 'w2_type', type: 'chips', label: 'Who are they?',
            options: [opt('Company', 'BEST employee'), opt('Client', 'Client employee'), opt('Other', 'Other')],
          },
          { id: 'w2_typeOther', type: 'text', label: 'Other — who?', showIf: { field: 'w2_type', includes: 'Other' } },
          { id: 'w2_name', type: 'text', label: 'Name' },
          { id: 'w2_phone', type: 'tel', label: 'Phone' },
          { id: 'w2_address', type: 'text', label: 'Address' },
          { id: 'w2_cityST', type: 'text', label: 'City, State' },
          { id: 'w2_zip', type: 'text', label: 'ZIP', inputmode: 'numeric' },
        ],
      },
      {
        label: 'Supporting documentation & sign-off', collapsed: false,
        fields: [
          {
            id: 'docs', type: 'chips', label: 'What documentation do you have? (tap all that apply)',
            options: ['Photos', 'Video', 'Witness Statements', 'Incident Reports', 'Medical Documentation', 'Other'].map((v) => opt(v)),
          },
          { id: 'docsOther', type: 'text', label: 'Other documentation — what?', showIf: { field: 'docs', includes: 'Other' } },
          { id: 'supervisor', type: 'text', label: "Direct supervisor's name", help: 'Added to the comments section, per the form’s instructions.' },
          { id: 'extraComments', type: 'textarea', rows: 3, label: 'Anything else to add?' },
        ],
      },
    ],
  },
];

// Friendly labels used by the review screen's facts summary and blanks list.
export const REVIEW_SECTIONS = [
  {
    label: 'Section 1 — Claimant', step: 1,
    items: [
      ['lastName', 'Last name'], ['firstName', 'First name'], ['employeeNumber', 'Employee #'],
      ['jobTitle', 'Job title'], ['claimantPhone', 'Phone'], ['dob', 'Date of birth'], ['ssn', 'SSN'],
      ['hireDate', 'Hire date'], ['sex', 'Sex'], ['address', 'Home address'], ['cityST', 'City, State'],
      ['zip', 'ZIP'], ['payType', 'Pay type'], ['payRate', 'Pay rate'], ['avgHours', 'Avg hours/week'],
    ],
  },
  {
    label: 'Section 2 — Incident', step: 0,
    items: [
      ['incidentDate', 'Date of incident'], ['incidentTime', 'Time of incident'], ['dateReported', 'Date reported'],
    ],
  },
  {
    label: 'Where & what happened', step: 2,
    items: [
      ['locationPick', 'Area'], ['exactSpot', 'Exact spot'], ['indoorOutdoor', 'Indoor/outdoor'],
      ['surfaceType', 'Surface'], ['surfaceCondition', 'Surface condition'], ['weather', 'Weather'],
      ['bodyParts', 'Body part(s)'], ['causeObject', 'Caused by'],
      ['altPath', 'Alternate path available'], ['carrying', 'Carrying anything'],
      ['distracted', 'Distracted / hurried'], ['normalDuties', 'Normal job duties'],
    ],
  },
  {
    label: 'Sections 3–4 — Medical & outcome', step: 4,
    items: [
      ['questionableCase', 'Questionable case'], ['beyondFirstAid', 'Treatment beyond first aid'],
      ['hospitalName', 'Hospital / medical center'], ['physicianName', 'Physician'],
      ['medAddress', 'Facility address'], ['medCityST', 'Facility city/state'], ['medZip', 'Facility ZIP'], ['medPhone', 'Facility phone'],
      ['lostConsciousness', 'Lost consciousness'], ['ambulanceCalled', 'Ambulance called'], ['transport', 'Transport'],
      ['fatality', 'Fatality'], ['missedDays', 'Missed days'], ['missedDaysCount', 'How many days'], ['returnDate', 'Return-to-work date'],
      ['footwearDesc', 'Footwear'], ['footwearCondition', 'Footwear condition'],
    ],
  },
  {
    label: 'Conditions & hours', step: 5,
    items: [
      ['ppe', 'PPE'], ['chairInvolved', 'Chair involved'], ['chairType', 'Chair type'], ['chairCondition', 'Chair condition'],
      ['stairsInvolved', 'Stairs involved'], ['handrail', 'Handrail'], ['stairCondition', 'Stair condition'],
      ['elevationFall', 'Fall from elevation'], ['ladderInvolved', 'Ladder involved'], ['ladderCondition', 'Ladder condition'],
      ['hoursOnDuty', 'Hours on duty prior'], ['hoursPrior7', 'Hours in prior 7 days'],
    ],
  },
  {
    label: 'Sections 5–6 — Witnesses & documentation', step: 6,
    items: [
      ['w1_name', 'Witness 1'], ['w2_name', 'Witness 2'], ['docs', 'Documentation'],
      ['supervisor', 'Direct supervisor'], ['extraComments', 'Additional comments'],
    ],
  },
];

// Fields surfaced in the "Left blank — need from you" list when empty
// (product rule 2: surface EVERY blank that maps to a PDF field).
// [answerId, label, onlyIf?] — onlyIf gates conditionals; the engine also
// skips entries whose wizard field is hidden by showIf.
export const FOLLOW_UP_FIELDS = [
  ['lastName', "Claimant's last name"],
  ['firstName', "Claimant's first name"],
  ['employeeNumber', 'Employee #'],
  ['jobTitle', 'Job title'],
  ['claimantPhone', "Claimant's phone number"],
  ['dob', 'Date of birth'],
  ['ssn', 'SSN'],
  ['hireDate', 'Hire date'],
  ['sex', 'Sex'],
  ['address', 'Home address'],
  ['cityST', 'Home city/state'],
  ['zip', 'Home ZIP'],
  ['payType', 'Pay type'],
  ['payRate', 'Pay rate'],
  ['avgHours', 'Average hours/week'],
  ['incidentDate', 'Date of incident'],
  ['incidentTime', 'Time of incident'],
  ['dateReported', 'Date reported'],
  ['questionableCase', 'Questionable case (Yes/No)'],
  ['beyondFirstAid', 'Treatment beyond first aid (Yes/No)'],
  ['hospitalName', 'Hospital / medical center name', (a) => a.beyondFirstAid === 'Yes'],
  ['physicianName', 'Physician name', (a) => a.beyondFirstAid === 'Yes'],
  ['medAddress', 'Medical facility address', (a) => a.beyondFirstAid === 'Yes'],
  ['medCityST', 'Medical facility city/state', (a) => a.beyondFirstAid === 'Yes'],
  ['medZip', 'Medical facility ZIP', (a) => a.beyondFirstAid === 'Yes'],
  ['medPhone', 'Medical facility phone', (a) => a.beyondFirstAid === 'Yes'],
  ['lostConsciousness', 'Lost consciousness (Yes/No)'],
  ['ambulanceCalled', 'Ambulance called (Yes/No)'],
  ['fatality', 'Fatality (Yes/No)'],
  ['missedDays', 'Missed days (Yes/No)'],
  ['missedDaysCount', 'Number of missed days', (a) => a.missedDays === 'Yes'],
  ['returnDate', 'Return-to-work date', (a) => a.missedDays === 'Yes'],
  ['weather', 'Weather'],
  ['surfaceType', 'Ground/floor type'],
  ['surfaceCondition', 'Ground/floor condition'],
  ['altPath', 'Alternate path available (page 3, Yes/No)'],
  ['carrying', 'Carrying anything (page 3, Yes/No)'],
  ['distracted', 'Distracted or hurried (page 3, Yes/No)'],
  ['normalDuties', 'Normal job duties (page 3, Yes/No)'],
  ['footwearDesc', 'Footwear description'],
  ['footwearCondition', 'Footwear condition'],
  ['ppe', 'PPE involvement'],
  ['chairInvolved', 'Chair involved (Yes/No)'],
  ['chairType', 'Chair type', (a) => a.chairInvolved === 'Yes'],
  ['chairCondition', 'Chair condition', (a) => a.chairInvolved === 'Yes'],
  ['stairsInvolved', 'Stairs involved (Yes/No)'],
  ['handrail', 'Handrail available/used', (a) => a.stairsInvolved === 'Yes'],
  ['stairCondition', 'Stair condition', (a) => a.stairsInvolved === 'Yes'],
  ['elevationFall', 'Fall from elevation (Yes/No)'],
  ['ladderInvolved', 'Ladder involved (Yes/No)'],
  ['ladderCondition', 'Ladder condition', (a) => a.ladderInvolved === 'Yes' || a.ladderInvolved === 'Other'],
  ['hoursOnDuty', 'Hours on duty prior to incident'],
  ['hoursPrior7', 'Hours worked in prior 7 days'],
  ['supervisor', "Direct supervisor's name"],
];

// Blanks that aren't simple per-answer checks. Returns extra labels for the
// "Left blank — need from you" list.
export function extraBlanks(state) {
  const a = state.answers || {};
  const out = [];
  if (!a.w1_name && !a.w2_name) out.push('Witness names/contact (confirm there were none)');
  for (const n of [1, 2]) {
    if (!a[`w${n}_name`]) continue;
    const missing = ['phone', 'address', 'cityST', 'zip'].filter((f) => !String(a[`w${n}_${f}`] || '').trim());
    if (missing.length) out.push(`Witness ${n} contact details (${missing.length === 4 ? 'all' : missing.join('/')})`);
    const types = Array.isArray(a[`w${n}_type`]) ? a[`w${n}_type`] : [];
    if (types.includes('Other') && !String(a[`w${n}_typeOther`] || '').trim()) out.push(`Witness ${n} "Other" description`);
  }
  if (!state.incidentType) out.push('Type of incident (page 3)');
  else if (state.incidentType === 'Other' && !String(state.incidentTypeOther || '').trim()) {
    out.push('Incident type "Other" description (page 3)');
  }
  if (Array.isArray(a.docs) && a.docs.includes('Other') && !String(a.docsOther || '').trim()) {
    out.push('Documentation "Other" description');
  }
  return out;
}
