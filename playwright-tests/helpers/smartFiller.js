'use strict';

/**
 * helpers/smartFiller.js
 *
 * Metadata-first form filler for CRUD create/update flows.
 */

const fs = require('fs');
const path = require('path');

// Unique stamp per script run — appended to text/name/code values to prevent duplicates.
let RUN_STAMP = Date.now().toString(36).toUpperCase().slice(-5);
/** Call this to generate a new unique stamp (e.g. after a duplicate-record rejection). */
function refreshStamp() {
  RUN_STAMP = Date.now().toString(36).toUpperCase().slice(-5);
  return RUN_STAMP;
}
const { collectStableFormFields } = require('./formDiscovery');
const { fillField, readFieldValue, waitForDependentFieldsToPopulate } = require('./formFiller');

const DEPENDENCY_CONFIG_PATH = path.resolve(__dirname, 'dependent-dropdowns.json');
let dependencyConfigCache = null;

const POOL = {
  country: [
    'India', 'Australia', 'Australia', 'Canada', 'Australia',
    'Germany', 'France', 'Japan', 'Singapore', 'UAE', 'Switzerland', 'Ireland',
  ],
  state: [
    'Gujarat', 'Maharashtra', 'Karnataka', 'Rajasthan', 'Tamil Nadu',
    'Delhi', 'Uttar Pradesh', 'West Bengal', 'Kerala', 'Telangana', 'Haryana',
  ],
  city: [
    'Ahmedabad', 'Mumbai', 'Bangalore', 'Pune', 'Chennai',
    'Delhi', 'Hyderabad', 'Surat', 'Vadodara', 'Jaipur', 'Indore', 'Goa',
  ],
  department: [
    'Research & Development', 'Manufacturing', 'Quality Assurance', 'Regulatory Affairs',
    'Clinical Research', 'Pharmacovigilance', 'Medical Affairs', 'Supply Chain',
    'Quality Control', 'Operations', 'Human Resources', 'Compliance', 
    'Procurement', 'Analytics', 'IT Infrastructure',
  ],
  designation: [
    'Pharmacist', 'Lab Technician', 'QA Officer', 'Regulatory Specialist',
    'Clinical Research Coordinator', 'Senior Scientist', 'Production Manager',
    'Quality Auditor', 'Medical Representative', 'Data Analyst', 'Project Lead',
    'Department Head', 'Trainee Pharmacist', 'Associate', 'Manager - QA', 'Manager',
    'Senior Manager', 'Executive', 'Analyst', 'Scientist', 'Technician', 'Supervisor',
    'Team Lead', 'Assistant Manager', 'Coordinator', 'Officer', 'Specialist', 'Consultant',
    'Inspector', 'Operator', 'Administrator', 'Architect', 'Developer', 'Tester',
  ],
  employeeType: ['Permanent', 'Contractual', 'Temporary', 'Consultant', 'Trainee'],
  gender: ['Male', 'Female'],
  location: [
    'Main Manufacturing Plant', 'QC Laboratory', 'R&D Center', 'Formulation Block',
    'Quality Assurance Lab', 'API Production', 'Packaging Unit', 'Warehouse', 
    'Head Office', 'Regional Office',
  ],
  site: ['Plant A', 'Plant B', 'Lab Main', 'Lab Analytical', 'Lab Microbiology', 'R&D Block'],
  app: ['ERP Module', 'Quality Management', 'Compliance Portal', 'Lab LIMS', 'Document Management'],
  category: ['Tablet', 'Capsule', 'Injectable', 'Liquid', 'Cream', 'Ointment', 'Powder', 'Suspension'],
  type: ['Prescription', 'Over-The-Counter', 'Diagnostic', 'Research Grade', 'Reference Standard'],
  grade: ['USP', 'BP', 'IP', 'EP', 'JP', 'ChP', 'Grade A', 'Grade B'],
  priority: ['High', 'Medium', 'Low', 'Critical', 'Routine'],
  status: ['Active', 'Inactive', 'Pending Approval', 'Approved', 'Discontinued', 'On Hold'],
  bank: ['HDFC Bank', 'ICICI Bank', 'Axis Bank', 'State Bank of India', 'Kotak Mahindra Bank'],
  currency: ['INR', 'USD', 'EUR', 'GBP', 'AED'],
  timeZone: ['India ( +05:30 )', 'UTC ( +00:00 )', 'Dubai ( +04:00 )', 'Singapore ( +08:00 )'],
  pharmaProduct: [
    'Paracetamol 500mg', 'Amoxicillin 250mg', 'Ibuprofen 400mg', 'Lisinopril 10mg',
    'Omeprazole 20mg', 'Levothyroxine 25mcg', 'Atorvastatin 10mg', 'Aspirin 75mg',
    'Metformin 500mg', 'Vitamin D3 1000IU', 'Cetirizine 10mg', 'Ciprofloxacin 500mg',
  ],
  reagent: [
    'Acetonitrile', 'Methanol', 'Ethanol', 'Water for Injection', 'Sodium Chloride',
    'Hydrochloric Acid', 'Sodium Hydroxide', 'Phosphate Buffer', 'Glucose Solution',
  ],
  equipment: [
    'HPLC System', 'UV Spectrophotometer', 'Gas Chromatograph', 'Mass Spectrometer',
    'Tablet Press', 'Capsule Filling Machine', 'Blister Packing Machine', 'Autoclave',
    'Laminar Flow Hood', 'Dissolution Apparatus', 'Disintegration Tester',
  ],
  shortName: () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const base = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * 26)]).join('');
    return `${base}${RUN_STAMP}`;
  },
  name: () => {
    const firstNames = ['Arjun', 'Priya', 'Rahul', 'Neha', 'Suresh', 'Pooja', 'Amit', 'Deepa', 'Rajesh', 'Meera', 'Vikram', 'Anjali'];
    const lastNames = ['Sharma', 'Patel', 'Shah', 'Kumar', 'Singh', 'Mehta', 'Joshi', 'Verma', 'Nair', 'Gupta', 'Desai', 'Bhat'];
    const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
    const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
    return `${fn} ${ln} ${RUN_STAMP}`;
  },
  email: () => {
    const users = ['qa', 'test', 'validation', 'audit', 'analyst'];
    const domains = ['pharmatest.in', 'qualitycheck.com', 'pharmaqa.org'];
    const user = users[Math.floor(Math.random() * users.length)];
    const domain = domains[Math.floor(Math.random() * domains.length)];
    return `${user}${RUN_STAMP.toLowerCase()}@${domain}`;
  },
  phone: () => String(Math.floor(7000000000 + Math.random() * 2999999999)),
  pincode: () => String(Math.floor(100000 + Math.random() * 899999)),
  address: () => {
    const streets = ['Industrial Estate', 'Pharma Park', 'Science Park Road', 'Lab Street', 'Research Avenue'];
    const areas = ['Ahmedabad', 'Pune', 'Bangalore', 'Hyderabad', 'Goa', 'Indore'];
    return `${Math.floor(Math.random() * 999) + 1}, ${streets[Math.floor(Math.random() * streets.length)]}, ${areas[Math.floor(Math.random() * areas.length)]}`;
  },
  description: () => {
    const descs = [
      'Pharmaceutical product - Quality tested batch',
      'Standard pharmaceutical grade material',
      'Batch created for regulatory compliance testing',
      'QA verified sample for quality assurance',
      'Reference standard for analytical testing',
      'Manufacturing batch documentation',
      'Clinical trial related batch record',
    ];
    return descs[Math.floor(Math.random() * descs.length)];
  },
};

function loadDependencyConfig() {
  if (dependencyConfigCache) return dependencyConfigCache;
  try {
    const raw = fs.readFileSync(DEPENDENCY_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    dependencyConfigCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    dependencyConfigCache = {};
  }
  return dependencyConfigCache;
}

function getMasterDependencyConfig(masterName) {
  const all = loadDependencyConfig();
  const target = String(masterName || '').trim().toLowerCase();
  if (!target) return { parentDropdowns: [], dependentDropdowns: [] };

  const key = Object.keys(all).find((candidate) => String(candidate).trim().toLowerCase() === target);
  const found = key ? all[key] : null;
  if (!found || typeof found !== 'object') {
    return { parentDropdowns: [], dependentDropdowns: [] };
  }

  return {
    parentDropdowns: Array.isArray(found.parentDropdowns) ? found.parentDropdowns : [],
    dependentDropdowns: Array.isArray(found.dependentDropdowns) ? found.dependentDropdowns : [],
  };
}

function pick(source) {
  if (typeof source === 'function') return source();
  return source[Math.floor(Math.random() * source.length)];
}

function uniquePick(source, existingValues, blocklist = new Set()) {
  const values = source.filter((value) => !existingValues.includes(value) && !blocklist.has(value));
  return pick(values.length ? values : source);
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === '' || String(value).trim() === 'null';
}

function isSelectLike(field) {
  return ['select', 'multiselect', 'customselect'].includes(field.elementType);
}

function normalizeLabel(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeUsername() {
  const base = ['qa', 'user', 'admin', 'test'][Math.floor(Math.random() * 4)];
  return `${base}${RUN_STAMP}`;
}

function makePassword() {
  const upper = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const lower = String.fromCharCode(97 + Math.floor(Math.random() * 26));
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `Qa${upper}${lower}${digits}`;
}

function matchesConfiguredField(field, configuredName) {
  const probe = normalizeLabel(configuredName);
  if (!probe) return false;

  const candidates = [field.id, field.displayName, field.columnToShow]
    .map((item) => normalizeLabel(item))
    .filter(Boolean);

  return candidates.includes(probe);
}

function isConfiguredDependencyParent(masterName, field) {
  if (!isSelectLike(field)) return false;
  const cfg = getMasterDependencyConfig(masterName);
  return cfg.parentDropdowns.some((item) => matchesConfiguredField(field, item));
}

function isConfiguredDependentDropdown(masterName, field) {
  if (!isSelectLike(field)) return false;
  const cfg = getMasterDependencyConfig(masterName);
  return cfg.dependentDropdowns.some((item) => matchesConfiguredField(field, item));
}

function fieldKey(field) {
  return field.columnToShow || field.displayName || field.id;
}

function getPrefilledValue(field, prefilledValues) {
  if (!prefilledValues || typeof prefilledValues !== 'object') return null;

  const directKeys = [
    fieldKey(field),
    field.displayName,
    field.columnToShow,
    field.id,
  ].filter(Boolean);

  for (const key of directKeys) {
    const value = prefilledValues[key];
    if (!isEmptyValue(value)) return value;
  }

  const normalizedLookups = directKeys.map((key) => normalizeLabel(key)).filter(Boolean);
  if (!normalizedLookups.length) return null;

  for (const [key, value] of Object.entries(prefilledValues)) {
    const normalizedKey = normalizeLabel(key);
    if (normalizedLookups.includes(normalizedKey) && !isEmptyValue(value)) {
      return value;
    }
  }

  return null;
}

function shouldUpdateExistingField(field, currentValue) {
  if (isEmptyValue(currentValue)) return true;
  if (field.disabled) return false;
  if (isSelectLike(field)) return false;

  const lower = normalizeLabel(field.displayName);
  if (/record id|recordid|username|login name|password|confirm password|first name|last name|employee code/.test(lower)) return false;

  return /remark|note|comment|description|summary|email|phone|mobile|contact/.test(lower);
}

async function isFormOffcanvasOpen(page) {
  return page
    .locator('#masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body, .offcanvas.show .offcanvas-body')
    .first()
    .isVisible()
    .catch(() => false);
}

function getCandidateValuesForField(field) {
  const lower = String(field.displayName || '').toLowerCase();
  if (/country/.test(lower)) return POOL.country;
  if (/time\s*zone|timezone|\btz\b/.test(lower)) return POOL.timeZone;
  if (/state|province/.test(lower)) return POOL.state;
  if (/\bcity\b/.test(lower)) return POOL.city;
  if (/department|dept/.test(lower)) return POOL.department;
  if (/designation|position|title|role/.test(lower)) return POOL.designation;
  if (/employee.*type|emp.*type/.test(lower)) return POOL.employeeType;
  if (/gender|sex/.test(lower)) return POOL.gender;
  if (/location/.test(lower)) return POOL.location;
  if (/\bsite\b/.test(lower)) return POOL.site;
  if (/\bapp\b|application/.test(lower)) return POOL.app;
  if (/category/.test(lower)) return POOL.category;
  if (/\btype\b/.test(lower)) return POOL.type;
  if (/grade/.test(lower)) return POOL.grade;
  if (/priority/.test(lower)) return POOL.priority;
  if (/status/.test(lower)) return POOL.status;
  if (/bank/.test(lower)) return POOL.bank;
  if (/currency/.test(lower)) return POOL.currency;
  return [];
}

function resolveSmartValue(displayName, elementType, existingValues = [], context = {}) {
  const lower = normalizeLabel(displayName);
  const masterLower = normalizeLabel(context.masterName || '');
  const invalidRoles = context.invalidRoles || new Set();
  const isSelectLikeType = ['select', 'multiselect', 'customselect'].includes(elementType);

  if (['date', 'time', 'dateandtime', 'radio', 'checkbox', 'file'].includes(elementType)) {
    return null;
  }

  if (elementType === 'number' || elementType === 'decimal') {
    if (/pin|zip|postal/.test(lower)) return pick(POOL.pincode);
    if (/phone|mobile|contact|fax/.test(lower)) return String(Math.floor(7000000000 + Math.random() * 2999999999));
    if (/batch|lot/.test(lower)) return String(Math.floor(Math.random() * 999000) + 1000).padStart(6, '0');
    if (/amount|price|cost|salary|budget|revenue/.test(lower)) return String(Math.floor(Math.random() * 500000) + 1000);
    if (/age|weight|height|dose|dosage/.test(lower)) return String(Math.floor(Math.random() * 100) + 10);
    if (/quantity|qty|count|strength|potency/.test(lower)) return String(Math.floor(Math.random() * 1000) + 100);
    if (/percentage|percent|purity|assay|yield|recovery/.test(lower)) return String(Math.floor(Math.random() * 10) + 90);
    if (/year/.test(lower)) return String(new Date().getFullYear());
    if (/seq|sequence|serial|sr\.?\s*no|order.*no|priority.*no/.test(lower)) return String(Math.floor(Math.random() * 99) + 1);
    return String(Math.floor(Math.random() * 999) + 1);
  }

  if (/country/.test(lower)) return uniquePick(POOL.country, existingValues);
  if (/time\s*zone|timezone|\btz\b/.test(lower)) return uniquePick(POOL.timeZone, existingValues);
  if (/state|province/.test(lower)) return uniquePick(POOL.state, existingValues);
  if (/\bcity\b/.test(lower)) return uniquePick(POOL.city, existingValues);
  if (/department|dept/.test(lower)) return uniquePick(POOL.department, existingValues);
  if (/designation|position|title|role/.test(lower)) return uniquePick(POOL.designation, existingValues, context.invalidRoles || new Set());
  if (/employee.*type|emp.*type/.test(lower)) return uniquePick(POOL.employeeType, existingValues);
  if (/gender|sex/.test(lower)) return uniquePick(POOL.gender, existingValues);
  if (/location/.test(lower) && !isSelectLikeType) return `QA Location ${RUN_STAMP}`;
  if (/\bsite\b/.test(lower) && !isSelectLikeType) return `QA Site ${RUN_STAMP}`;
  if (/\bsite\b/.test(lower)) return uniquePick(POOL.site, existingValues);
  if (/\bapp\b|application/.test(lower)) return uniquePick(POOL.app, existingValues);
  if (/category/.test(lower)) return uniquePick(POOL.category, existingValues);
  if (/\btype\b/.test(lower)) return uniquePick(POOL.type, existingValues);
  if (/grade|standard|specification/.test(lower)) return uniquePick(POOL.grade, existingValues);
  if (/priority/.test(lower)) return uniquePick(POOL.priority, existingValues);
  if (/status/.test(lower)) return uniquePick(POOL.status, existingValues);
  if (/bank/.test(lower)) return uniquePick(POOL.bank, existingValues);
  if (/currency/.test(lower)) return uniquePick(POOL.currency, existingValues);
  if (/product.*name|medicine|drug|pharmaceutical/.test(lower)) return uniquePick(POOL.pharmaProduct, existingValues);
  if (/reagent|chemical|solvent|buffer|solution/.test(lower)) return uniquePick(POOL.reagent, existingValues);
  if (/equipment|instrument|apparatus|machine/.test(lower)) return uniquePick(POOL.equipment, existingValues);
  if (/\bname\b/.test(lower) && /equipment|instrument|apparatus|machine/.test(masterLower)) {
    return uniquePick(POOL.equipment, existingValues);
  }
  if (/user ?name|login id|user id/.test(lower)) return makeUsername();
  if (/confirm password/.test(lower)) return null;
  if (/password|passcode/.test(lower) || elementType === 'password') return makePassword();
  if (/first name/.test(lower)) return pick(['Arjun', 'Priya', 'Rahul', 'Neha', 'Suresh', 'Pooja', 'Amit', 'Deepa']);
  if (/last name|surname/.test(lower)) return pick(['Sharma', 'Patel', 'Shah', 'Kumar', 'Singh', 'Mehta', 'Joshi', 'Verma', 'Nair', 'Gupta']);
  if (/email/.test(lower) || elementType === 'email') return pick(POOL.email);
  if (/phone|mobile|contact|fax/.test(lower) || elementType === 'tel') return pick(POOL.phone);
  if (/pin|zip|postal/.test(lower)) return pick(POOL.pincode);
  if (/address/.test(lower)) return pick(POOL.address);
  if (/location\s*name|plant\s*name/.test(lower)) return `QA Location ${RUN_STAMP}`;
  if (/site\s*name/.test(lower)) return `Ahmedabad QA Site ${RUN_STAMP}`;
  if (/app\s*name|application\s*name/.test(lower)) return `Quality Management App ${RUN_STAMP}`;
  if (/sub\s*template\s*name/.test(lower)) return `QC Sub Template ${RUN_STAMP}`;
  if (/template\s*name/.test(lower)) return `QC Template ${RUN_STAMP}`;
  if (/workflow\s*name/.test(lower)) return `Template Workflow ${RUN_STAMP}`;
  if (/location\s*code|plant\s*code|location\s*id|plant\s*id/.test(lower)) return `LC${RUN_STAMP}`;
  if (/site\s*code/.test(lower)) return `ST${RUN_STAMP}`;
  if (/app\s*code|application\s*code/.test(lower)) return `AP${RUN_STAMP}`;
  if (/template\s*code/.test(lower)) return `TP${RUN_STAMP}`;
  if (/workflow\s*code/.test(lower)) return `WF${RUN_STAMP}`;
  if (/\bname\b/.test(lower)) return pick(POOL.name);
  if (/code|short/.test(lower)) return pick(POOL.shortName);
  if (/remark|note|comment|description|detail|summary|instruction/.test(lower)) return pick(POOL.description);

  if (['text', 'textarea', 'encryptedtext', 'password'].includes(elementType)) {
    const compact = displayName
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
    return `${compact} ${RUN_STAMP}`;
  }

  return null;
}

async function rotateParentSelections(page, masterName, fields, currentIndex, auditTrail, context = {}) {
  const parents = fields
    .slice(0, currentIndex)
    .filter((field) => !field.disabled && isConfiguredDependencyParent(masterName, field))
    .reverse();

  for (const parent of parents) {
    const parentPrefilled = getPrefilledValue(parent, context.prefilledValues);
    if (!isEmptyValue(parentPrefilled)) {
      // Keep explicitly prefilled parent values stable (e.g. Country) during dependency recovery.
      process.stderr.write(`[SMART_FILL] Keeping parent "${parent.displayName}" fixed to prefilled value during recovery\n`);
      continue;
    }

    const parentAuditKey = fieldKey(parent);
    const attemptedParentValues = [auditTrail[parentAuditKey]].filter(Boolean).map(String);
    const candidates = getCandidateValuesForField(parent)
      .filter((value) => !attemptedParentValues.includes(String(value)))
      .slice(0, 2);

    for (const candidate of candidates) {
      const nextParent = await fillField(page, parent.idx, parent, attemptedParentValues, candidate);
      if (isEmptyValue(nextParent)) continue;

      auditTrail[parentAuditKey] = nextParent;
      process.stderr.write(`[SMART_FILL] Retried parent "${parent.displayName}" -> "${nextParent}"\n`);
      await waitForDependentFieldsToPopulate(page, parent.idx, fields, 2000);
      return true;
    }

    const nextParent = await fillField(page, parent.idx, parent, attemptedParentValues);
    if (isEmptyValue(nextParent)) continue;

    auditTrail[parentAuditKey] = nextParent;
    process.stderr.write(`[SMART_FILL] Retried parent "${parent.displayName}" -> "${nextParent}"\n`);
    await waitForDependentFieldsToPopulate(page, parent.idx, fields, 2000);
    return true;
  }

  return false;
}

async function fillDiscoveredField(page, masterName, field, auditTrail, context = {}) {
  const usedValues = Object.values(auditTrail).map(String);
  const normalizedName = normalizeLabel(field.displayName);
  const prefilled = getPrefilledValue(field, context.prefilledValues);
  let smartValue = !isEmptyValue(prefilled)
    ? prefilled
    : resolveSmartValue(field.displayName, field.elementType, usedValues, { masterName, invalidRoles: context.invalidRoles || new Set() });

  if (/confirm password/.test(normalizedName)) {
    const passwordKey = Object.keys(auditTrail).find((key) => {
      const normalizedKey = normalizeLabel(key);
      return /password/.test(normalizedKey) && !/confirm/.test(normalizedKey);
    });
    if (passwordKey && !isEmptyValue(auditTrail[passwordKey])) {
      smartValue = String(auditTrail[passwordKey]);
    }
  }

  if (field.maxLength && smartValue && String(smartValue).length > field.maxLength) {
    smartValue = String(smartValue).slice(0, field.maxLength);
  }

  return fillField(page, field.idx, field, usedValues, smartValue);
}

async function resolveBlockedField(page, masterName, fields, currentIndex, field, auditTrail, context = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const changedParent = await rotateParentSelections(page, masterName, fields, currentIndex, auditTrail, context);
    if (!changedParent) break;

    const retried = await fillDiscoveredField(page, masterName, field, auditTrail, context);
    if (!isEmptyValue(retried)) {
      return retried;
    }
  }

  return null;
}

async function refillRequiredFields(page, masterName, auditTrail, maxRounds = 2, context = {}) {
  for (let round = 0; round < maxRounds; round++) {
    const open = await isFormOffcanvasOpen(page);
    if (!open) {
      throw new Error(`Form offcanvas closed unexpectedly while repairing required fields for ${masterName}`);
    }

    const latestFields = await collectStableFormFields(page);
    let roundChanges = 0;

    for (let index = 0; index < latestFields.length; index++) {
      const field = latestFields[index];
      const key = fieldKey(field);
      if (!field.required) continue;
      if (field.id.includes('RecordID') || field.id.includes('RecordId')) continue;
      if (field.disabled && !isSelectLike(field)) continue;

      // For select-like fields, verify actual current DOM value even if auditTrail says filled.
      // React re-renders can clear customselect/select values after we set them.
      let alreadyFilled = !isEmptyValue(auditTrail[key]);
      if (alreadyFilled && isSelectLike(field)) {
        // HARD-SKIP: Country and Time Zone were explicitly prefilled — never re-open those
        // dropdowns in the repair pass regardless of what the DOM currently shows.
        // react-select v5 emotion class names cause false-empty reads for these fields.
        const lower = normalizeLabel(field.displayName);
        const isCountryOrTZ = /country|time\s*zone|timezone|\btz\b/.test(lower);
        const explicitPrefill = getPrefilledValue(field, context.prefilledValues);
        if (!isEmptyValue(explicitPrefill) || isCountryOrTZ) {
          process.stderr.write(`[SMART_FILL] Skipping DOM re-check for prefilled/protected select "${field.displayName}" — trusting audit trail\n`);
          // alreadyFilled stays true → continue below
        } else {
          const actualDomValue = await readFieldValue(page, field.idx, field).catch(() => null);
          if (isEmptyValue(actualDomValue)) {
            process.stderr.write(`[SMART_FILL] Select "${field.displayName}" was cleared after fill (re-render); repairing.\n`);
            auditTrail[key] = null;
            alreadyFilled = false;
          }
        }
      }
      if (alreadyFilled) continue;

      let value = await fillDiscoveredField(page, masterName, field, auditTrail, context);
      if (isEmptyValue(value) && isConfiguredDependentDropdown(masterName, field)) {
        value = await resolveBlockedField(page, masterName, latestFields, index, field, auditTrail, context);
      }

      if (!isEmptyValue(value)) {
        auditTrail[key] = value;
        roundChanges++;
        process.stderr.write(`[SMART_FILL] Repair "${field.displayName}" (${field.elementType}) -> "${value}"\n`);
      }
    }

    if (roundChanges === 0) break;
    process.stderr.write(`[SMART_FILL] Repair round ${round + 1} complete for ${masterName} (${roundChanges} updates)\n`);
  }
}

async function smartFillOffcanvasForm(page, masterName, providedFields = null, options = {}) {
  const mode = options.mode || 'create';
  const invalidRoles = options.invalidRoles || new Set();
  const prefilledValues = options.prefilledValues && typeof options.prefilledValues === 'object'
    ? options.prefilledValues
    : null;
  const fillContext = {
    invalidRoles,
    prefilledValues,
  };
  const fields = providedFields || await collectStableFormFields(page);
  process.stderr.write(`[SMART_FILL] Discovered ${fields.length} fields for ${masterName}\n`);

  const cfg = getMasterDependencyConfig(masterName);
  process.stderr.write(`[SMART_FILL] Dependency config for ${masterName}: parents=${cfg.parentDropdowns.length}, dependents=${cfg.dependentDropdowns.length}\n`);

  const auditTrail = {};

  for (let index = 0; index < fields.length; index++) {
    const open = await isFormOffcanvasOpen(page);
    if (!open) {
      throw new Error(`Form offcanvas closed unexpectedly while filling ${masterName} (field index ${index})`);
    }

    const field = fields[index];
    const key = fieldKey(field);
    const currentValue = await readFieldValue(page, field.idx, field).catch(() => null);

    if (field.id.includes('RecordID') || field.id.includes('RecordId')) {
      process.stderr.write(`[SMART_FILL] Skipping #${field.id} (disabled/RecordID)\n`);
      continue;
    }

    if (field.disabled) {
      if (!isEmptyValue(currentValue)) {
        auditTrail[key] = currentValue;
        process.stderr.write(`[SMART_FILL] Preserving disabled field "${field.displayName}" (${field.elementType}) -> "${currentValue}"\n`);
      } else {
        process.stderr.write(`[SMART_FILL] Skipping #${field.id} (disabled field)\n`);
      }
      continue;
    }

    if (mode === 'update' && !shouldUpdateExistingField(field, currentValue)) {
      if (!isEmptyValue(currentValue)) {
        auditTrail[key] = currentValue;
        process.stderr.write(`[SMART_FILL] Preserving existing field "${field.displayName}" (${field.elementType}) -> "${currentValue}"\n`);
      } else {
        process.stderr.write(`[SMART_FILL] Existing field "${field.displayName}" is empty and will be filled\n`);
      }
      if (!isEmptyValue(currentValue)) {
        continue;
      }
    }

    if (mode === 'update' && isSelectLike(field) && !isEmptyValue(currentValue)) {
      auditTrail[key] = currentValue;
      process.stderr.write(`[SMART_FILL] Keeping existing select "${field.displayName}" -> "${currentValue}"\n`);
      continue;
    }

    let value;
    try {
      value = await fillDiscoveredField(page, masterName, field, auditTrail, fillContext);
      await waitForDependentFieldsToPopulate(page, index, fields, 3000);
      const updatedFields = await collectStableFormFields(page);
      if (updatedFields.length === fields.length) {
        for (let j = index + 1; j < fields.length; j++) {
          fields[j] = updatedFields[j];
        }
      }

      if (isEmptyValue(value) && isConfiguredDependentDropdown(masterName, field)) {
        process.stderr.write(`[SMART_FILL] "${field.displayName}" is empty after first pass; checking configured dependencies...\n`);
        value = await resolveBlockedField(page, masterName, fields, index, field, auditTrail, fillContext);
      }
    } catch (error) {
      throw new Error(`Failed filling field "${field.displayName}" on ${masterName}: ${error?.message || error}`);
    }

    if (field.required && isEmptyValue(value)) {
      if (isSelectLike(field)) {
        process.stderr.write(`[SMART_FILL] Required select "${field.displayName}" has no options - skipping\n`);
      } else {
        const dependencyText = field.dependencyKeys?.length
          ? ` Metadata hints: ${field.dependencyKeys.map((item) => `${item.key}=${item.value}`).join(', ')}`
          : '';
        throw new Error(`Required field could not be resolved on ${masterName}: ${field.displayName}.${dependencyText}`);
      }
    }

    if (!isEmptyValue(value)) {
      auditTrail[key] = value;
      process.stderr.write(`[SMART_FILL] "${field.displayName}" (${field.elementType}) -> "${value}"\n`);
    } else {
      process.stderr.write(`[SMART_FILL] "${field.displayName}" (${field.elementType}) left empty\n`);
    }

    await page.waitForTimeout(150);
  }

  if (mode !== 'update') {
    // Wait for any async re-renders (e.g., dependent dropdown reloads triggered by text field blur)
    // before running the repair pass that checks actual DOM values.
    await page.waitForTimeout(600);
    await refillRequiredFields(page, masterName, auditTrail, 3, fillContext);
  }
  return auditTrail;
}

module.exports = { smartFillOffcanvasForm, resolveSmartValue, refreshStamp };
