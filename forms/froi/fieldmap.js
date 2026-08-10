// forms/froi/fieldmap.js
// Exact AcroForm field names/types for the GardaWorld/BEST FROI template.
// Empirically verified against forms/froi/template.pdf with pdf-lib 1.17.1.
// Names are copied verbatim from the form — including the form's own typos
// (`Ciity ST`, `occured`) — never retype them from memory.

export const FIELD_COUNT = 98;

// ---- Shared multi-widget fields (set once, render on multiple pages) ----
export const SHARED = {
  claimantName: 'Name of claimant Last First',
  employeeNumber: 'Employee Number',
  jobNumber: 'Job number where incident occured',
  dateOfIncident: 'Date of incident',
  completedBy: 'Nametitle of person completing FROI',
};

// ---- Page 1 AI-written narrative boxes ----
export const P1_NARRATIVE = {
  location: 'Location of incident Describe environment where incident occurred Ex inside indoor main stairwell at XYZ building',
  incident: 'Description of incident Use full detail Ex Employee stepped on pant leg and tripped going up stairwell Employee fell forward and used both hands to catch himself',
  activity: 'Description of what employee was doing when incident occurred Use full detail Ex Employee was on his second rotation of the day He was walking to check if the doors were locked on the third floor',
  injury: 'Describe injuryillness Use full detail Ex Employee fell on both hands and right knee Both wrists on employee are sore and hurt to apply pressure Right knee has a visible bruise the size of a quarter',
  cause: 'Describe what was the direct cause of injury machine tool object substance etc',
};

// ---- Page 1 classification checkboxes (check exactly one) ----
export const CLASSIFICATION_BOXES = {
  'Near Miss': 'Near MissIncident Only No Injury',
  'Workers Comp': 'Workers Compensation Claim Injury',
};

// ---- Option strings (exact, including the form's misspellings) ----
export const OPTIONS = {
  'Sex': ['Female', 'Male'],
  'Pay Type': ['Hourly', 'Salary'],
  'Is this a questionable case': ['Yes', 'No'],
  'Did employee receive medical treatment beyond first aid?': ['Yes', 'No'],
  'Did employee lose consciousness?': ['Yes', 'No'],
  'Was an ambulance called to scene?': ['Yes', 'No'],
  'Did incident result in a fatality (death)?': ['Yes', 'No'],
  'Did employee miss any days of work, or anticipate missing any days?': ['Yes', 'No'],
  'Type of Incident': ['Altercation', 'Fall From Height', 'Hit By Vehicle', 'Other', 'Slip & Fall', 'Slip & No Fall', 'Trip & Fall', 'Trip & No Fall', 'Vehicle Accident'],
  'Combo Box1': ['Clear', 'Hail', 'Ice', 'Rain', 'Sleet', 'Snow', 'Windy'],
  'Combo Box2': ['Carpet', 'Concrete', 'Dirt', 'Grass', 'Gravel/Stone', 'Hardwood', 'Laminate', 'Other', 'Tile', 'Turf'],
  'Combo Box3': ['Debris/Obsticle', 'Dry', 'Icey', 'Oiley', 'Other', 'Snow', 'Wet'],
  'Combo Box4': [' ', 'Fair', 'New', 'Poor', 'Good'],
  'Combo Box5': ['No', 'Yes'],
  'Combo Box6': ['Desk', 'Office', 'Other', 'Portable', 'Stool'],
  'Combo Box7': ['N/A', 'New', 'Poor', 'Solid'],
  'Combo Box8': ['No', 'Yes'],
  'Combo Box9': ['N/A', 'No', 'Yes'],
  'Combo Box10': ['Broken', 'Good', 'Moderate', 'N/A', 'New', 'Painted', 'Poor', 'Smooth'],
  'Combo Box11': ['N/A', 'Not Required', 'Yes & Not Utilized', 'Yes & Utilized'],
  'Combo Box12': ['No', 'Yes'],
  'Combo Box13': ['No', 'Other', 'Yes'],
  'Combo Box14': ['Fair', 'Good', 'New', 'Poor'],
};

// ---- Full census: every one of the 98 fields with its pdf-lib type ----
export const FIELD_TYPES = {
  // Page 1
  'Near MissIncident Only No Injury': 'PDFCheckBox',
  'Workers Compensation Claim Injury': 'PDFCheckBox',
  'Company #': 'PDFTextField',
  'Branch': 'PDFTextField',
  'Date employee reported incident/injury': 'PDFTextField',
  'Name of claimant Last First': 'PDFTextField',
  'Employee Number': 'PDFTextField',
  'Job number where incident occured': 'PDFTextField',
  'Date of incident': 'PDFTextField',
  'Hire Date': 'PDFTextField',
  'Date of Birth': 'PDFTextField',
  'SSN': 'PDFTextField',
  'Address': 'PDFTextField',
  'Ciity ST': 'PDFTextField',
  'Zip': 'PDFTextField',
  'Pay Rate': 'PDFTextField',
  'Ave. Hours/Week Worked': 'PDFTextField',
  'Phone Number': 'PDFTextField',
  'Job Title': 'PDFTextField',
  'Time of Incident AMPM': 'PDFTextField',
  'If yes how many days': 'PDFTextField',
  'Date/Anticipated return to work date:': 'PDFTextField',
  'Sex': 'PDFDropdown',
  'Pay Type': 'PDFDropdown',
  'Is this a questionable case': 'PDFDropdown',
  'Did employee receive medical treatment beyond first aid?': 'PDFDropdown',
  'Did employee lose consciousness?': 'PDFDropdown',
  'Was an ambulance called to scene?': 'PDFDropdown',
  'Did incident result in a fatality (death)?': 'PDFDropdown',
  'Did employee miss any days of work, or anticipate missing any days?': 'PDFDropdown',
  [P1_NARRATIVE.location]: 'PDFTextField',
  [P1_NARRATIVE.incident]: 'PDFTextField',
  [P1_NARRATIVE.activity]: 'PDFTextField',
  [P1_NARRATIVE.injury]: 'PDFTextField',
  [P1_NARRATIVE.cause]: 'PDFTextField',
  // Page 2 — Section 4 (medical)
  'Name of hospital or medical center where employee was evaluated': 'PDFTextField',
  'Physician Name': 'PDFTextField',
  'Address_2': 'PDFTextField',
  'City ST': 'PDFTextField',
  'Zip_2': 'PDFTextField',
  'Phone': 'PDFTextField',
  // Page 2 — Witness 1
  'Company Employee manager coworker etc': 'PDFCheckBox',
  'Client Employee': 'PDFCheckBox',
  'Other': 'PDFCheckBox',
  'Other1': 'PDFTextField',
  'Name': 'PDFTextField',
  'Phone_2': 'PDFTextField',
  'Address_3': 'PDFTextField',
  'City ST_2': 'PDFTextField',
  'Zip_3': 'PDFTextField',
  // Page 2 — Witness 2
  'Company Employee manager coworker etc_2': 'PDFCheckBox',
  'Client Employee_2': 'PDFCheckBox',
  'Other3': 'PDFCheckBox',
  'Other4': 'PDFTextField',
  'Name_2': 'PDFTextField',
  'Phone_3': 'PDFTextField',
  'Address_4': 'PDFTextField',
  'City ST_3': 'PDFTextField',
  'Zip_4': 'PDFTextField',
  // Page 2 — Section 6
  'Photos': 'PDFCheckBox',
  'Video': 'PDFCheckBox',
  'Witness Statements': 'PDFCheckBox',
  'Incident Reports': 'PDFCheckBox',
  'Medical Documentation': 'PDFCheckBox',
  'Other5': 'PDFCheckBox',
  'Other6': 'PDFTextField',
  'Nametitle of person completing FROI': 'PDFTextField',
  'Phone Number_2': 'PDFTextField',
  'CommentsAdditional InformationRow1': 'PDFTextField',
  // Page 3
  'Type of Incident': 'PDFOptionList',
  'Combo Box0': 'PDFDropdown',
  'Text Field1': 'PDFTextField',
  'Manager ID Number': 'PDFTextField',
  'Text Field5': 'PDFTextField',
  'Text Field6': 'PDFTextField',
  'Text Field7': 'PDFTextField',
  'Text Field8': 'PDFTextField',
  'Text Field9': 'PDFTextField',
  'Text Field10': 'PDFTextField',
  'Text Field11': 'PDFTextField',
  'Text Field12': 'PDFTextField',
  'Text Field13': 'PDFTextField',
  'Combo Box1': 'PDFDropdown',
  'Combo Box2': 'PDFDropdown',
  'Combo Box3': 'PDFDropdown',
  'Combo Box4': 'PDFDropdown',
  'Combo Box5': 'PDFDropdown',
  'Combo Box6': 'PDFDropdown',
  'Combo Box7': 'PDFDropdown',
  'Combo Box8': 'PDFDropdown',
  'Combo Box9': 'PDFDropdown',
  'Combo Box10': 'PDFDropdown',
  'Combo Box11': 'PDFDropdown',
  'Combo Box12': 'PDFDropdown',
  'Combo Box13': 'PDFDropdown',
  'Combo Box14': 'PDFDropdown',
  'Text Field14': 'PDFTextField',
  'Text Field15': 'PDFTextField',
};

// Witness field name groups, wizard slot -> form names
export const WITNESS_FIELDS = [
  {
    company: 'Company Employee manager coworker etc',
    client: 'Client Employee',
    other: 'Other',
    otherText: 'Other1',
    name: 'Name',
    phone: 'Phone_2',
    address: 'Address_3',
    cityST: 'City ST_2',
    zip: 'Zip_3',
  },
  {
    company: 'Company Employee manager coworker etc_2',
    client: 'Client Employee_2',
    other: 'Other3',
    otherText: 'Other4',
    name: 'Name_2',
    phone: 'Phone_3',
    address: 'Address_4',
    cityST: 'City ST_3',
    zip: 'Zip_4',
  },
];

export const DOC_CHECKBOXES = {
  'Photos': 'Photos',
  'Video': 'Video',
  'Witness Statements': 'Witness Statements',
  'Incident Reports': 'Incident Reports',
  'Medical Documentation': 'Medical Documentation',
  'Other': 'Other5',
};
export const DOC_OTHER_TEXT = 'Other6';

// The two large boxes that render at 9pt; the p1 narrative boxes match by prefix.
export const BIG_FIELDS = new Set(['Text Field7', 'CommentsAdditional InformationRow1']);
export const BIG_FIELD_RE = /^(Location of incident|Description of|Describe )/;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function isoToMDY(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return String(iso);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export function to12Hour(hhmm) {
  if (!hhmm) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return String(hhmm);
  let h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

const clean = (v) => (v == null ? '' : String(v).trim());

// ---------------------------------------------------------------------------
// AI drafting contract (§7): review-screen narrative boxes <-> response keys.
// [localKey, responseKey, label, helper]
// ---------------------------------------------------------------------------

export const NARRATIVE_KEYS = [
  ['location', 'location_description', 'Location of incident', 'Environment where it happened — goes in Section 3.'],
  ['incident', 'incident_description', 'Description of incident', 'What happened, step by step.'],
  ['activity', 'activity_description', 'What the employee was doing', 'Their task/rotation when it happened.'],
  ['injury', 'injury_description', 'Injury / illness description', 'Symptoms and complaints as reported — no diagnoses.'],
  ['cause', 'direct_cause', 'Direct cause', 'The machine, tool, object, substance, etc.'],
  ['detailed', 'detailed_narrative', 'Detailed narrative (page 3 + comments)', 'The comprehensive chronological account.'],
  ['specificInjury', 'specific_injury', 'Specific injury (short)', 'Short phrase, e.g. MINOR WRIST PAIN. Printed uppercase.'],
];

export const RESPONSE_KEYS = [
  'location_description', 'incident_description', 'activity_description',
  'injury_description', 'direct_cause', 'detailed_narrative', 'specific_injury',
  'suggested_incident_type', 'suggested_classification', 'classification_rationale', 'flags',
];

// PII discipline (§3.6): only narrative-relevant facts go to the drafting
// endpoint. SSN, DOB, home address, pay data, phone numbers and employee #
// are NEVER included — they map straight from the wizard to PDF fields.
// Conditional sub-answers are included only while their controlling toggle
// still says Yes, so a corrected answer can't leak a stale fact into the
// narrative.
export function buildFacts(a) {
  const prune = (obj) => {
    if (Array.isArray(obj)) {
      const arr = obj.map(prune).filter((v) => v !== undefined);
      return arr.length ? arr : undefined;
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
  };
  const beyondFA = a.beyondFirstAid === 'Yes';
  const ems = a.ambulanceCalled === 'Yes';
  const missed = a.missedDays === 'Yes';
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
    hospital: beyondFA ? a.hospitalName : undefined,
    physician: beyondFA ? a.physicianName : undefined,
    lost_consciousness: a.lostConsciousness,
    ambulance_called: a.ambulanceCalled,
    ambulance_transport: ems ? a.transport : undefined,
    fatality: a.fatality,
    missed_days: a.missedDays,
    missed_days_count: missed ? a.missedDaysCount : undefined,
    return_to_work_date: missed ? isoToMDY(a.returnDate) : undefined,
    footwear: { description: a.footwearDesc, condition: a.footwearCondition },
    ppe: a.ppe,
    chair_involved: a.chairInvolved,
    chair_type: a.chairInvolved === 'Yes' ? a.chairType : undefined,
    chair_condition: a.chairInvolved === 'Yes' ? a.chairCondition : undefined,
    stairs_involved: a.stairsInvolved,
    handrail: a.stairsInvolved === 'Yes' ? a.handrail : undefined,
    stair_condition: a.stairsInvolved === 'Yes' ? a.stairCondition : undefined,
    fall_from_elevation: a.elevationFall,
    ladder_involved: a.ladderInvolved,
    ladder_condition: (a.ladderInvolved === 'Yes' || a.ladderInvolved === 'Other') ? a.ladderCondition : undefined,
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

// Download name: FROI_<LASTNAME>_<YYYY-MM-DD>.pdf
export function outputFilename(a, todayIso) {
  const last = (a.lastName || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9-]+/g, '') || 'UNKNOWN';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.incidentDate || '') ? a.incidentDate : todayIso;
  return `FROI_${last}_${date}.pdf`;
}

// ---------------------------------------------------------------------------
// Wizard state -> fill instructions
// Returns { text: {name: value}, checks: [names], picks: {name: value} }.
// Empty answers are omitted entirely — nothing is invented (product rule 1).
// ---------------------------------------------------------------------------

export function buildFill(state) {
  const a = state.answers || {};
  const n = state.narratives || {};
  const defaults = state.defaults || {};
  const text = {};
  const checks = [];
  const picks = {};

  const setText = (name, value) => { const v = clean(value); if (v) text[name] = v; };
  const setPick = (name, value) => { const v = clean(value); if (v) picks[name] = v; };

  // Standing defaults first (silently applied; review screen lets the filer edit
  // them via state.defaults). Wizard answers below overwrite on collision.
  for (const [name, value] of Object.entries(defaults)) {
    if (FIELD_TYPES[name] === 'PDFDropdown' || FIELD_TYPES[name] === 'PDFOptionList') setPick(name, value);
    else setText(name, value);
  }

  // Classification — check exactly one box.
  if (CLASSIFICATION_BOXES[state.classification]) checks.push(CLASSIFICATION_BOXES[state.classification]);

  // Basics
  setText(SHARED.dateOfIncident, isoToMDY(a.incidentDate));
  setText('Time of Incident AMPM', to12Hour(a.incidentTime));
  setText('Date employee reported incident/injury', isoToMDY(a.dateReported));

  // Claimant
  const last = clean(a.lastName); const first = clean(a.firstName);
  if (last || first) {
    setText(SHARED.claimantName, [last.toUpperCase(), first.toUpperCase()].filter(Boolean).join(', '));
  }
  setText(SHARED.employeeNumber, a.employeeNumber);
  setText('Job Title', a.jobTitle);
  setText('Phone Number', a.claimantPhone);
  setText('Date of Birth', isoToMDY(a.dob));
  setText('SSN', a.ssn);
  setText('Hire Date', isoToMDY(a.hireDate));
  setPick('Sex', a.sex);
  setText('Address', a.address);
  setText('Ciity ST', a.cityST);
  setText('Zip', a.zip);
  setPick('Pay Type', a.payType);
  setText('Pay Rate', a.payRate);
  setText('Ave. Hours/Week Worked', a.avgHours);

  // P1 medical / outcome questions
  setPick('Is this a questionable case', a.questionableCase);
  setPick('Did employee receive medical treatment beyond first aid?', a.beyondFirstAid);
  setPick('Did employee lose consciousness?', a.lostConsciousness);
  setPick('Was an ambulance called to scene?', a.ambulanceCalled);
  setPick('Did incident result in a fatality (death)?', a.fatality);
  setPick('Did employee miss any days of work, or anticipate missing any days?', a.missedDays);
  if (a.missedDays === 'Yes') {
    setText('If yes how many days', a.missedDaysCount);
    setText('Date/Anticipated return to work date:', isoToMDY(a.returnDate));
  }

  // Section 4 — only when treatment went beyond first aid
  if (a.beyondFirstAid === 'Yes') {
    setText('Name of hospital or medical center where employee was evaluated', a.hospitalName);
    setText('Physician Name', a.physicianName);
    setText('Address_2', a.medAddress);
    setText('City ST', a.medCityST);
    setText('Zip_2', a.medZip);
    setText('Phone', a.medPhone);
  }

  // Witnesses
  const witnesses = [
    { types: a.w1_type, otherText: a.w1_typeOther, name: a.w1_name, phone: a.w1_phone, address: a.w1_address, cityST: a.w1_cityST, zip: a.w1_zip },
    { types: a.w2_type, otherText: a.w2_typeOther, name: a.w2_name, phone: a.w2_phone, address: a.w2_address, cityST: a.w2_cityST, zip: a.w2_zip },
  ];
  witnesses.forEach((w, i) => {
    const f = WITNESS_FIELDS[i];
    const types = Array.isArray(w.types) ? w.types : [];
    if (types.includes('Company')) checks.push(f.company);
    if (types.includes('Client')) checks.push(f.client);
    if (types.includes('Other')) { checks.push(f.other); setText(f.otherText, w.otherText); }
    setText(f.name, w.name);
    setText(f.phone, w.phone);
    setText(f.address, w.address);
    setText(f.cityST, w.cityST);
    setText(f.zip, w.zip);
  });

  // Section 6 — supporting documentation
  const docs = Array.isArray(a.docs) ? a.docs : [];
  for (const d of docs) {
    if (DOC_CHECKBOXES[d]) checks.push(DOC_CHECKBOXES[d]);
  }
  if (docs.includes('Other')) setText(DOC_OTHER_TEXT, a.docsOther);

  // Narratives (AI-drafted, human-approved — or hand-written in manual mode)
  setText(P1_NARRATIVE.location, n.location);
  setText(P1_NARRATIVE.incident, n.incident);
  setText(P1_NARRATIVE.activity, n.activity);
  setText(P1_NARRATIVE.injury, n.injury);
  setText(P1_NARRATIVE.cause, n.cause);
  setText('Text Field7', n.detailed);
  const commentParts = [];
  if (clean(n.detailed)) commentParts.push(clean(n.detailed));
  if (clean(a.extraComments)) commentParts.push(clean(a.extraComments));
  if (clean(a.supervisor)) commentParts.push(`Direct supervisor: ${clean(a.supervisor)}`);
  if (commentParts.length) text['CommentsAdditional InformationRow1'] = commentParts.join('\n');
  if (clean(n.specificInjury)) setText('Text Field12', clean(n.specificInjury).toUpperCase());

  // Page 3 — incident type: two physically overlapping widgets, always set BOTH.
  if (clean(state.incidentType)) {
    setPick('Type of Incident', state.incidentType);
    setPick('Combo Box0', state.incidentType);
    if (state.incidentType === 'Other') setText('Text Field1', state.incidentTypeOther);
  }

  // Page 3 — preliminary questions, uppercase YES/NO text
  const yn = (v) => (v === 'Yes' ? 'YES' : v === 'No' ? 'NO' : '');
  setText('Text Field8', yn(a.altPath));
  setText('Text Field9', yn(a.carrying));
  setText('Text Field10', yn(a.distracted));
  setText('Text Field11', yn(a.normalDuties));

  // Page 3 — environment & conditions
  setPick('Combo Box1', a.weather);
  setPick('Combo Box2', a.surfaceType);
  setPick('Combo Box3', a.surfaceCondition);
  setText('Text Field13', a.footwearDesc);
  setPick('Combo Box4', a.footwearCondition); // overrides the standing default when answered
  setPick('Combo Box11', a.ppe);
  setPick('Combo Box5', a.chairInvolved);
  if (a.chairInvolved === 'Yes') {
    setPick('Combo Box6', a.chairType);
    setPick('Combo Box7', a.chairCondition);
  }
  setPick('Combo Box8', a.stairsInvolved);
  if (a.stairsInvolved === 'Yes') {
    setPick('Combo Box9', a.handrail);
    setPick('Combo Box10', a.stairCondition);
  }
  setPick('Combo Box12', a.elevationFall);
  setPick('Combo Box13', a.ladderInvolved);
  if (a.ladderInvolved === 'Yes' || a.ladderInvolved === 'Other') {
    setPick('Combo Box14', a.ladderCondition);
  }
  setText('Text Field14', a.hoursOnDuty);
  setText('Text Field15', a.hoursPrior7);

  return { text, checks, picks };
}

// ---------------------------------------------------------------------------
// The verified §9 fill recipe. `pdfLib` is the pdf-lib namespace (window.PDFLib
// in the browser, require('pdf-lib') in node) so app and tests share one path.
// Returns the saved bytes. NEVER flattens — the output must remain editable.
// ---------------------------------------------------------------------------

export async function fillFroi(pdfLib, templateBytes, fill) {
  const { PDFDocument, StandardFonts, PDFName } = pdfLib;
  const doc = await PDFDocument.load(templateBytes);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  // Choice fields: sync BOTH /V and /I — verified requirement for this form.
  // pdf-lib's select() sets /V but strips /I; several viewers render this
  // form's combos from /I, so selections silently vanish without the sync.
  const pick = (name, value) => {
    let f;
    try { f = form.getDropdown(name); } catch { f = form.getOptionList(name); }
    f.select(value);
    const idx = f.getOptions().indexOf(value);
    if (idx >= 0) f.acroField.dict.set(PDFName.of('I'), doc.context.obj([idx]));
  };

  for (const [name, value] of Object.entries(fill.text || {})) {
    if (value == null || value === '') continue; // skip — never write '' or 'N/A'
    form.getTextField(name).setText(String(value));
  }
  for (const name of fill.checks || []) form.getCheckBox(name).check();
  for (const [name, value] of Object.entries(fill.picks || {})) {
    if (value == null || value === '') continue;
    pick(name, value);
  }

  form.getFields().forEach((f) => {
    if (f.constructor.name === 'PDFTextField') {
      const big = BIG_FIELDS.has(f.getName()) || BIG_FIELD_RE.test(f.getName());
      try { f.setFontSize(big ? 9 : 10); } catch {}
    }
  });
  form.updateFieldAppearances(helv); // pass the font explicitly — required
  return doc.save(); // NEVER form.flatten()
}
