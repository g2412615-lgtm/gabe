// config.js — user-editable constants. No build step: edit and re-upload.

// Paste the deployed Cloudflare Worker URL here (see worker/README section of
// the repo README). Leave '' to run in manual mode (no AI drafting).
// Example: 'https://froi-draft.your-account.workers.dev/draft'
export const DRAFT_ENDPOINT = '';

// Standing defaults — applied silently on every FROI (the wizard never asks),
// visible and editable on the review screen.
export const DEFAULTS = {
  'Company #': 'BEST',
  'Branch': 'Houston',
  'Job number where incident occured': '8822',
  'Text Field5': 'Shell Energy Stadium',
  'Text Field6': 'Houston, TX',
  'Nametitle of person completing FROI': 'Gabriel Exposito Schmitz', // exact spelling — a prior form was regenerated over this
  'Manager ID Number': '390424',
  'Phone Number_2': '(954) 805-3061',
  'Combo Box4': 'Good', // footwear condition default; overridable in the wizard
};

// Quick-pick location chips for the "Where" step. Edit freely.
export const LOCATION_PICKS = [
  'Bayou City Gate',
  'North Gate area',
  'East side gates',
  'North Lot',
  'Warehouse 1',
  'Warehouse 2',
  'Concourse',
  'Field level',
  'Suite level',
  'Parking lots',
  'Back of house',
  'Other',
];

// Report registry for the landing page. Adding a form = new forms/<id>/ folder
// (template.pdf, fieldmap.js, rulebook.js, wizard.js) + an entry here.
export const FORM_REGISTRY = [
  { id: 'froi', label: 'First Report of Injury', description: 'Employee injury or near miss (GardaWorld FROI)', active: true },
  { id: 'incident', label: 'Incident Report', description: 'Non-injury incident reporting', active: false },
  { id: 'caf', label: 'CAF', description: 'Corrective action form', active: false },
];

// Where the completed form must be sent (used in the copyable summary).
export const SUBMIT_EMAIL = 'safety.ss.us@garda.com';
export const SUBMIT_DEADLINE = 'within 24 hours of incident';
