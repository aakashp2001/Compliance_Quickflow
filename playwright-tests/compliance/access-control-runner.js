'use strict';

const path = require('path');
const { chromium } = require('@playwright/test');
const { fillOffcanvasForm } = require('../helpers/formFiller');
const {
  openFirstReachableRoute,
  setPasswordPolicyMinimumRules,
  GivenUserLoggedIn,
  WhenProbeRouteAccess,
  WhenProbeApiRequest,
  openUserCreateForm,
  populateUserIdentityFields,
  setUserPasswordFields,
  submitCurrentForm,
  tableHasText,
  openUserRowForPasswordReset,
  ThenProbeShouldBeDenied,
  ThenApiShouldBeDenied,
} = require('./ac-bdd-steps');
const { attachComplianceTraceability } = require('./compliance-traceability');

const QT_TC_ID = process.env.QT_TC_ID || '';
const QT_MASTER = process.env.QT_MASTER || 'Country';
const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';

const ROLE_CREDS = {
  admin: {
    username: process.env.QT_AC_ADMIN_USER || process.env.QT_USER || 'admin',
    password: process.env.QT_AC_ADMIN_PASS || process.env.QT_PASS || 'admin@123',
  },
  viewer: {
    username: process.env.QT_AC_VIEWER_USER || process.env.QT_USER2 || process.env.QT_USER || 'admin',
    password: process.env.QT_AC_VIEWER_PASS || process.env.QT_PASS2 || process.env.QT_PASS || 'admin@123',
  },
  standard: {
    username: process.env.QT_AC_STANDARD_USER || process.env.QT_AC_VIEWER_USER || process.env.QT_USER2 || process.env.QT_USER || 'admin',
    password: process.env.QT_AC_STANDARD_PASS || process.env.QT_AC_VIEWER_PASS || process.env.QT_PASS2 || process.env.QT_PASS || 'admin@123',
  },
};

const READINESS = {
  AUTOMATABLE: 'Automatable',
  NEEDS_FEATURE_HOOK: 'Needs Feature Hook',
  NEEDS_EXTERNAL_DEPENDENCY: 'Needs External Dependency',
  NEEDS_SEED_DATA: 'Needs Seed Data',
  NEEDS_ENVIRONMENT: 'Needs Environment',
};

const AC_ADMIN_PROTECTED_PATHS = parseCsvEnv(
  process.env.QT_AC_ADMIN_PROTECTED_PATHS,
  ['/Country', '/Site', '/User', '/Role', '/System-Access-Control']
);
const AC_EDIT_PROTECTED_PATHS = parseCsvEnv(
  process.env.QT_AC_EDIT_PROTECTED_PATHS,
  ['/Create-Template', '/Master', '/Form-Issuance']
);
const AC_APPROVE_PROTECTED_PATHS = parseCsvEnv(
  process.env.QT_AC_APPROVE_PROTECTED_PATHS,
  ['/Reviewer-Dashboard', '/Master-Review']
);
const AC_MODULE_COUNTRY_PATH = String(process.env.QT_AC_COUNTRY_PATH || '/Country').trim();
const AC_MODULE_CREATE_APP_PATH = String(process.env.QT_AC_CREATE_APP_PATH || '/Create-Template').trim();
const AC_BUILDER_PATH = String(process.env.QT_AC_BUILDER_PATH || '/Create-Template').trim();
const AC_QA_URL = String(process.env.QT_AC_QA_URL || '').trim();
const AC_PROD_URL = String(process.env.QT_AC_PROD_URL || '').trim();
const AC_PASSWORD_POLICY_PATHS = parseCsvEnv(
  process.env.QT_AC_PASSWORD_POLICY_PATHS,
  ['/Password-Policy', '/PasswordPolicy', '/Admin-Password-Policy', '/Admin/Password-Policy']
);
const AC_USER_PATHS = parseCsvEnv(
  process.env.QT_AC_USER_PATHS,
  ['/User', '/Users', '/Admin/User']
);
const AC02_DEFAULT_ROLE = String(process.env.QT_AC02_ROLE || '').trim();
const AC02_DEFAULT_SITE = String(process.env.QT_AC02_SITE || '').trim();
const AC02_DEFAULT_DEPARTMENT = String(process.env.QT_AC02_DEPARTMENT || '').trim();
const AC02_VALID_PASSWORD = String(process.env.QT_AC02_VALID_PASSWORD || 'Qf@12345').trim();
const AC02_VALID_RESET_USER = String(process.env.QT_AC02_RESET_USER || 'qa_pp_valid').trim();

const AC_PROTECTED_API_ENDPOINTS = parseCsvEnv(
  process.env.QT_AC_PROTECTED_API_ENDPOINTS,
  ['/api/masters/Country/crud', '/api/template-workflow/last-run', '/api/compliance/runs']
);
const AC_GUESSED_API_ENDPOINTS = parseCsvEnv(
  process.env.QT_AC_GUESSED_API_ENDPOINTS,
  ['/api/users', '/api/templates', '/admin/config']
);

const TC_CATALOG = {
  'TC-MR-AC01': 'Create minimal Viewer role for AC01 setup',
  'TC-MU-AC01': 'Create test user and assign Viewer role',
  'TC-MSAC-AC01': 'Assign zero rights to Viewer role',
  'TC-AC-01': 'Viewer cannot access Admin endpoints directly',
  'TC-AC-02': 'Viewer cannot access Edit endpoints directly',
  'TC-AC-03': 'Viewer cannot access Approve endpoints directly',
  'TC-AC-MC-01': 'Viewer cannot access Country module directly',
  'TC-AC-MA-01': 'Viewer cannot access Create APP module directly',
  'TC-MPP-AC02': 'Configure minimum password policy prerequisites',
  'TC-AC02-01': 'Reject new user password below minimum length',
  'TC-AC02-02': 'Reject new user password without uppercase',
  'TC-AC02-03': 'Reject new user password without lowercase',
  'TC-AC02-04': 'Reject new user password without numeric digit',
  'TC-AC02-05': 'Reject new user password without special character',
  'TC-AC02-PR-01': 'Reject reset password below minimum length',
  'TC-AC02-PR-02': 'Reject reset password without uppercase',
  'TC-AC02-PR-03': 'Reject reset password without lowercase',
  'TC-AC02-PR-04': 'Reject reset password without numeric digit',
  'TC-AC02-PR-05': 'Reject reset password without special character',
  'TC-AC02-06': 'Accept compliant boundary password on user creation',
  'TC-MPP-AC03': 'Configure session inactivity timeout prerequisite',
  'TC-AC03-01': 'Auto logout after inactivity timeout',
  'TC-AC03-02': 'Reject action after expired session',
  'TC-AC03-03': 'Handle unsaved form data on session expiry',
  'TC-AC03-04': 'Allow re-authentication after timeout',
  'TC-AC03-05': 'Keep active session alive before timeout threshold',
  'TC-AC03-06': 'Enforce updated timeout value for new sessions',
  'TC-MPP-AC04': 'Configure MFA enforcement prerequisite',
  'TC-AC04-01': 'Block approval-role login without MFA completion',
  'TC-AC04-02': 'Block approval action without MFA completion',
  'TC-AC04-03': 'Allow login and approval after MFA success',
  'TC-AC04-GxP-01': 'Block GxP form approval without MFA',
  'TC-AC04-GxP-02': 'Block GxP master approval without MFA',
  'TC-AC04-04': 'Allow GxP approval only after MFA challenge',
  'TC-MPP-AC05': 'Configure account lockout threshold prerequisite',
  'TC-AC05-01': 'Lock account at failed login threshold',
  'TC-AC05-02': 'Keep locked account blocked with correct credentials',
  'TC-AC05-03': 'Log failed attempts in invalid login audit',
  'TC-AC05-04': 'Admin unlock restores user login access',
  'TC-AC05-PR-01': 'Block password reset on locked account',
  'TC-AC05-PR-02': 'Trigger lockout through eSign failures',
  'TC-AC05-05': 'Unlock then allow password reset and login',
  'TC-MR-AC06': 'Create role for AC06 audit setup',
  'TC-MU-AC06': 'Create user for AC06 audit setup',
  'TC-MSAC-AC06': 'Assign role rights via system access control',
  'TC-AC06-01': 'Audit role assignment event fields',
  'TC-AC06-02': 'Audit role revocation event fields',
  'TC-AC06-03': 'Audit permission change in access control',
  'TC-AC06-04': 'Validate role rename audit name propagation',
  'TC-AC06-05': 'Validate required audit fields completeness',
  'TC-AC08-01': 'Reject protected API call without token',
  'TC-AC08-02': 'Reject protected API call with expired token',
  'TC-AC08-03': 'Allow protected API call with valid token',
  'TC-AC08-04': 'Reject guessed or predictable API endpoints',
  'TC-MU-AC09': 'Create test user for deactivation scenarios',
  'TC-AC09-01': 'Deactivate user blocks immediate login',
  'TC-AC09-02': 'Preserve historical records after deactivation',
  'TC-AC09-03': 'Block deactivated user interactions via UI and API',
  'TC-AC09-04': 'Reactivate user restores access',
  'TC-AC09-05': 'Reject duplicate active username across sites',
  'TC-AC09-06': 'Allow username reuse only after deactivation',
  'TC-AC10-01': 'Block builder access for standard user roles',
  'TC-AC10-02': 'Allow builder access for authorized admins',
  'TC-AC10-03': 'Block builder access in QA environment',
  'TC-AC10-04': 'Block builder access in Production environment',
  'TC-VMS-AC10-01': 'Create initial template version in Dev',
  'TC-VMS-AC10-02': 'Promote Dev to QA and handle rejection',
  'TC-VMS-AC10-03': 'Create successor version after Dev failure',
  'TC-VMS-AC10-04': 'Promote successful Dev version to QA',
  'TC-VMS-AC10-05': 'Promote approved QA version to Production',
  'TC-VMS-AC10-06': 'Validate end-to-end Dev-QA-Prod lifecycle',
};

const DEFAULT_ALL_ORDER = [
  'TC-MR-AC01',
  'TC-MU-AC01',
  'TC-MSAC-AC01',
  'TC-AC-01',
  'TC-AC-02',
  'TC-AC-03',
  'TC-AC-MC-01',
  'TC-AC-MA-01',
  'TC-MPP-AC02',
  'TC-AC02-01',
  'TC-AC02-02',
  'TC-AC02-03',
  'TC-AC02-04',
  'TC-AC02-05',
  'TC-AC02-PR-01',
  'TC-AC02-PR-02',
  'TC-AC02-PR-03',
  'TC-AC02-PR-04',
  'TC-AC02-PR-05',
  'TC-AC02-06',
  'TC-MPP-AC03',
  'TC-AC03-01',
  'TC-AC03-02',
  'TC-AC03-03',
  'TC-AC03-04',
  'TC-AC03-05',
  'TC-AC03-06',
  'TC-MPP-AC04',
  'TC-AC04-01',
  'TC-AC04-02',
  'TC-AC04-03',
  'TC-AC04-GxP-01',
  'TC-AC04-GxP-02',
  'TC-AC04-04',
  'TC-MPP-AC05',
  'TC-AC05-01',
  'TC-AC05-02',
  'TC-AC05-03',
  'TC-AC05-04',
  'TC-AC05-PR-01',
  'TC-AC05-PR-02',
  'TC-AC05-05',
  'TC-MR-AC06',
  'TC-MU-AC06',
  'TC-MSAC-AC06',
  'TC-AC06-01',
  'TC-AC06-02',
  'TC-AC06-03',
  'TC-AC06-04',
  'TC-AC06-05',
  'TC-AC08-01',
  'TC-AC08-02',
  'TC-AC08-03',
  'TC-AC08-04',
  'TC-MU-AC09',
  'TC-AC09-01',
  'TC-AC09-02',
  'TC-AC09-03',
  'TC-AC09-04',
  'TC-AC09-05',
  'TC-AC09-06',
  'TC-AC10-01',
  'TC-AC10-02',
  'TC-AC10-03',
  'TC-AC10-04',
  'TC-VMS-AC10-01',
  'TC-VMS-AC10-02',
  'TC-VMS-AC10-03',
  'TC-VMS-AC10-04',
  'TC-VMS-AC10-05',
  'TC-VMS-AC10-06',
];

const IMPLEMENTED_TC_IDS = new Set([
  'TC-MPP-AC02',
  'TC-AC02-01',
  'TC-AC02-02',
  'TC-AC02-03',
  'TC-AC02-04',
  'TC-AC02-05',
  'TC-AC02-PR-01',
  'TC-AC02-PR-02',
  'TC-AC02-PR-03',
  'TC-AC02-PR-04',
  'TC-AC02-PR-05',
  'TC-AC02-06',
  'TC-AC-01',
  'TC-AC-02',
  'TC-AC-03',
  'TC-AC-MC-01',
  'TC-AC-MA-01',
  'TC-AC08-01',
  'TC-AC08-02',
  'TC-AC08-03',
  'TC-AC08-04',
  'TC-AC10-01',
  'TC-AC10-02',
  'TC-AC10-03',
  'TC-AC10-04',
]);

const AC02_CREATE_CASES = {
  'TC-AC02-01': {
    password: 'Ab1@xyz',
    expectedRegex: /at least\s*8|minimum\s*8|8\s*character/i,
  },
  'TC-AC02-02': {
    password: 'ab1@wxyz',
    expectedRegex: /uppercase|[A-Z]/i,
  },
  'TC-AC02-03': {
    password: 'AB1@WXYZ',
    expectedRegex: /lowercase|[a-z]/i,
  },
  'TC-AC02-04': {
    password: 'Ab@@Wxyz',
    expectedRegex: /numeric|digit|0-9|number/i,
  },
  'TC-AC02-05': {
    password: 'Ab1Xwxyz',
    expectedRegex: /special|character|symbol|@|#|\$|!/i,
  },
};

const AC02_RESET_CASES = {
  'TC-AC02-PR-01': {
    password: 'Ab1@xyz',
    expectedRegex: /at least\s*8|minimum\s*8|8\s*character/i,
  },
  'TC-AC02-PR-02': {
    password: 'ab1@wxyz',
    expectedRegex: /uppercase|[A-Z]/i,
  },
  'TC-AC02-PR-03': {
    password: 'AB1@WXYZ',
    expectedRegex: /lowercase|[a-z]/i,
  },
  'TC-AC02-PR-04': {
    password: 'Ab@@Wxyz',
    expectedRegex: /numeric|digit|0-9|number/i,
  },
  'TC-AC02-PR-05': {
    password: 'Ab1Xwxyz',
    expectedRegex: /special|character|symbol|@|#|\$|!/i,
  },
};

function parseCsvEnv(raw, fallback = []) {
  const fromEnv = String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return [...(Array.isArray(fallback) ? fallback : [])];
}

function emitResult(result) {
  const payload = attachComplianceTraceability(result, {
    suite: 'AC',
    runnerName: 'access-control-runner.js',
  });
  process.stdout.write(JSON.stringify(payload));
}

function log(message) {
  process.stderr.write(`[AC-COMPLIANCE] ${String(message || '')}\n`);
}

function baseCase(tcId, title, readiness = READINESS.AUTOMATABLE) {
  return {
    suite: 'AC',
    tcId,
    title,
    readiness,
    status: 'failed',
    details: [],
  };
}

function blockedCase(tcId, title, readiness, reason, details = []) {
  return {
    ...baseCase(tcId, title, readiness),
    status: 'blocked',
    reason,
    details: [
      detail('Readiness check', false, {
        expected: 'Required setup, hooks, and selectors available',
        actual: reason,
      }),
      ...details,
    ],
  };
}

function detail(step, passed, extra = {}) {
  return { step, passed: !!passed, ...extra };
}

function isConfiguredValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/<[^>]+>/.test(text)) return false;
  if (/^(changeme|replace_me|your_.+|example)$/i.test(text)) return false;
  return true;
}

function isValidAbsoluteUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getReadinessForTc(tcId) {
  const id = String(tcId || '').toUpperCase();
  if (id.startsWith('TC-AC04') || id === 'TC-MPP-AC04') return READINESS.NEEDS_EXTERNAL_DEPENDENCY;
  if (id.startsWith('TC-VMS-AC10')) return READINESS.NEEDS_ENVIRONMENT;
  if (id.startsWith('TC-AC03') || id === 'TC-MPP-AC03') return READINESS.NEEDS_FEATURE_HOOK;
  if (id.startsWith('TC-AC05') || id === 'TC-MPP-AC05') return READINESS.NEEDS_FEATURE_HOOK;
  if (id.startsWith('TC-AC06') || id.startsWith('TC-MR-AC06') || id.startsWith('TC-MU-AC06') || id.startsWith('TC-MSAC-AC06')) return READINESS.NEEDS_FEATURE_HOOK;
  if (id.startsWith('TC-AC09') || id.startsWith('TC-MU-AC09')) return READINESS.NEEDS_SEED_DATA;
  if (id.startsWith('TC-AC02') || id === 'TC-MPP-AC02') return READINESS.NEEDS_FEATURE_HOOK;
  if (id.startsWith('TC-MR-AC01') || id.startsWith('TC-MU-AC01') || id.startsWith('TC-MSAC-AC01')) return READINESS.NEEDS_SEED_DATA;
  return READINESS.AUTOMATABLE;
}

function getUnimplementedReason(tcId) {
  const id = String(tcId || '').toUpperCase();
  if (id.startsWith('TC-AC04') || id === 'TC-MPP-AC04') {
    return 'MFA challenge automation needs OTP/provider integration hooks (QT_AC_MFA_*).';
  }
  if (id.startsWith('TC-VMS-AC10')) {
    return 'Dev-QA-Prod promotion hooks and deterministic VMS assertions are not configured in this environment.';
  }
  if (id.startsWith('TC-AC03') || id === 'TC-MPP-AC03') {
    return 'Session timeout fast-forward and post-expiry assertions need deterministic server-side timeout hooks.';
  }
  if (id.startsWith('TC-AC05') || id === 'TC-MPP-AC05') {
    return 'Lockout and eSign threshold automation requires dedicated account fixtures and stable selectors.';
  }
  if (id.startsWith('TC-AC06') || id.startsWith('TC-MR-AC06') || id.startsWith('TC-MU-AC06') || id.startsWith('TC-MSAC-AC06')) {
    return 'Audit field assertions for role assignment/revocation need environment-specific audit table selectors and seed data.';
  }
  if (id.startsWith('TC-AC09') || id.startsWith('TC-MU-AC09')) {
    return 'User deactivation/reactivation and username reuse require isolated multi-site fixture setup.';
  }
  if (id.startsWith('TC-AC02') || id === 'TC-MPP-AC02') {
    return 'Password policy setup and inline validation checks need stable policy/user form locators in target environment.';
  }
  if (id.startsWith('TC-MR-AC01') || id.startsWith('TC-MU-AC01') || id.startsWith('TC-MSAC-AC01')) {
    return 'RBAC setup workflow requires deterministic role/user provisioning helpers before assertion execution.';
  }
  return 'Scenario scaffolded but implementation is pending the next automation phase.';
}

function validateCoreConfig() {
  if (!isConfiguredValue(QT_URL)) return 'QT_URL is not configured.';
  if (!isValidAbsoluteUrl(QT_URL)) return `QT_URL is invalid: ${QT_URL}`;
  return '';
}

function requireCreds(roleKey) {
  const role = ROLE_CREDS[roleKey] || {};
  if (!isConfiguredValue(role.username)) return `${roleKey} username is not configured`;
  if (!isConfiguredValue(role.password)) return `${roleKey} password is not configured`;
  return '';
}

function buildAc02UserSeed(tcId, fixedUsername = '') {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const slug = String(tcId || 'ac02').replace(/[^A-Za-z0-9]+/g, '').toLowerCase().slice(-12) || 'ac02';
  const username = String(fixedUsername || `qa_${slug}_${stamp.slice(-6)}`).slice(0, 28);
  return {
    username,
    email: `${username}@webosphere.com`,
    firstName: 'QA',
    lastName: `AC02${stamp.slice(-4)}`,
    employeeCode: `EMP${stamp.slice(-6)}`,
    roleName: AC02_DEFAULT_ROLE,
    siteName: AC02_DEFAULT_SITE,
    department: AC02_DEFAULT_DEPARTMENT,
  };
}

function isErrorLikeMessage(text) {
  return /error|failed|invalid|not allowed|rejected|must|required|unable/i.test(String(text || ''));
}

function mergeMessages(messages = []) {
  return String((Array.isArray(messages) ? messages : []).join(' | ') || '').trim();
}

function matchesExpectedMessage(messages, expectedRegex) {
  const merged = mergeMessages(messages);
  if (!merged) return false;
  return expectedRegex.test(merged);
}

async function ensureAc02PasswordPolicyConfigured(page) {
  const opened = await openFirstReachableRoute(page, {
    loginUrl: QT_URL,
    routePaths: AC_PASSWORD_POLICY_PATHS,
    probeRegex: 'password\\s*policy|minimum|uppercase|lowercase|numeric|special|lockout|expiry',
    requireEditable: true,
  });

  if (!opened.opened) {
    return {
      ok: false,
      blocked: true,
      reason: 'Password Policy page is not reachable or has no editable controls.',
      updates: [],
      submit: null,
    };
  }

  const updates = await setPasswordPolicyMinimumRules(page);
  const updatedCount = updates.filter((item) => item.updated).length;
  if (updatedCount < 3) {
    return {
      ok: false,
      blocked: true,
      reason: 'Could not map enough password policy controls for minimum AC02 policy setup.',
      updates,
      submit: null,
    };
  }

  const submit = await submitCurrentForm(page);
  if (!submit.clicked) {
    return {
      ok: false,
      blocked: true,
      reason: 'Save/Update action not available on Password Policy page.',
      updates,
      submit,
    };
  }

  const blockingErrors = (submit.messages || []).filter((message) => isErrorLikeMessage(message));
  const ok = submit.success.matched || blockingErrors.length === 0;
  return {
    ok,
    blocked: false,
    reason: ok ? '' : `Password policy update appears to have failed: ${blockingErrors[0] || 'unknown error'}`,
    updates,
    submit,
  };
}

async function runAc02PolicySetupCase(page) {
  const tcId = 'TC-MPP-AC02';
  const title = TC_CATALOG[tcId];

  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);
  }

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const policy = await ensureAc02PasswordPolicyConfigured(page);
  if (policy.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, policy.reason);
  }

  const updatedCount = policy.updates.filter((item) => item.updated).length;
  const passed = policy.ok && updatedCount >= 3;
  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      detail('Password policy controls are discovered and updated', updatedCount >= 3, {
        expected: 'At least minimum length + complexity controls updated',
        actual: `${updatedCount}/5 controls updated`,
      }),
      detail('Password policy save action succeeds', policy.ok, {
        expected: 'Save should complete without blocking errors',
        actual: policy.reason || mergeMessages(policy.submit?.messages || []) || '(no message)',
      }),
    ],
  };
}

async function openAndPopulateUserCreateForm(page, tcId, password, fixedUsername = '') {
  const userForm = await openUserCreateForm(page, {
    loginUrl: QT_URL,
    userRoutes: AC_USER_PATHS,
  });
  if (!userForm.ok) {
    return {
      ok: false,
      blocked: true,
      reason: userForm.reason,
      userSeed: null,
      submit: null,
      messages: [],
      tableCheck: { found: false, rowText: '' },
      identityApplied: [],
      passwordApplied: { filled: false, count: 0 },
    };
  }

  await fillOffcanvasForm(page, 'User').catch(() => ({}));

  const userSeed = buildAc02UserSeed(tcId, fixedUsername);
  const identityApplied = await populateUserIdentityFields(page, userSeed);
  const passwordApplied = await setUserPasswordFields(page, {
    password,
    confirmPassword: password,
  });

  if (!passwordApplied.filled) {
    return {
      ok: false,
      blocked: true,
      reason: 'Password inputs are not discoverable on User create form.',
      userSeed,
      submit: null,
      messages: [],
      tableCheck: { found: false, rowText: '' },
      identityApplied,
      passwordApplied,
    };
  }

  const submit = await submitCurrentForm(page);
  const messages = Array.isArray(submit.messages) ? submit.messages : [];
  const tableCheck = await tableHasText(page, userSeed.username);

  return {
    ok: true,
    blocked: false,
    reason: '',
    userSeed,
    submit,
    messages,
    tableCheck,
    identityApplied,
    passwordApplied,
  };
}

async function runAc02CreateNegativeCase(page, tcId) {
  const title = TC_CATALOG[tcId];
  const caseDef = AC02_CREATE_CASES[tcId];
  if (!caseDef) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `No AC02 create-case definition found for ${tcId}`);
  }

  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);
  }

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const policy = await ensureAc02PasswordPolicyConfigured(page);
  if (policy.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, policy.reason, [
      detail('Password policy route probing', false, {
        actual: policy.reason,
      }),
    ]);
  }
  if (!policy.ok) {
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [
        detail('Password policy setup before create attempt', false, {
          expected: 'Policy should save with minimum AC02 constraints',
          actual: policy.reason || 'Policy save returned error',
        }),
      ],
    };
  }

  const create = await openAndPopulateUserCreateForm(page, tcId, caseDef.password);
  if (create.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, create.reason);
  }

  const rejected = !create.submit.success.matched;
  const ruleMessageMatched = matchesExpectedMessage(create.messages, caseDef.expectedRegex);
  const userPersisted = create.tableCheck.found;
  const hasValidationFeedback = create.messages.length > 0;
  const passed = rejected && !userPersisted && (ruleMessageMatched || hasValidationFeedback);

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      detail('Create attempt rejected for invalid password', rejected, {
        expected: 'User create should be blocked',
        actual: create.submit.success.matched ? 'Success signal observed' : 'No success signal observed',
      }),
      detail('Validation feedback is visible for password rule', hasValidationFeedback, {
        expected: 'Inline/toast validation message should appear',
        actual: mergeMessages(create.messages) || '(no message)',
      }),
      detail('Password validation message matches expected rule', ruleMessageMatched || hasValidationFeedback, {
        expected: String(caseDef.expectedRegex),
        actual: mergeMessages(create.messages) || '(no message)',
      }),
      detail('Invalid password user is not persisted in listing', !userPersisted, {
        expected: create.userSeed.username,
        actual: userPersisted ? create.tableCheck.rowText : '(not found)',
      }),
    ],
  };
}

async function runAc02CreatePositiveCase(page) {
  const tcId = 'TC-AC02-06';
  const title = TC_CATALOG[tcId];
  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);
  }

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const policy = await ensureAc02PasswordPolicyConfigured(page);
  if (policy.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, policy.reason);
  }
  if (!policy.ok) {
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [
        detail('Password policy setup before positive create', false, {
          expected: 'Policy should save with minimum AC02 constraints',
          actual: policy.reason || 'Policy save returned error',
        }),
      ],
    };
  }

  const create = await openAndPopulateUserCreateForm(page, tcId, AC02_VALID_PASSWORD, AC02_VALID_RESET_USER);
  if (create.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, create.reason);
  }

  const errorMessages = create.messages.filter((msg) => isErrorLikeMessage(msg));
  const userPersisted = create.tableCheck.found;
  const passed = userPersisted && errorMessages.length === 0;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      detail('Compliant password create attempt succeeds', create.submit.success.matched || userPersisted, {
        expected: 'Create success signal should be visible',
        actual: create.submit.success.text || mergeMessages(create.messages) || '(no message)',
      }),
      detail('Created user appears in user listing', userPersisted, {
        expected: create.userSeed.username,
        actual: userPersisted ? create.tableCheck.rowText : '(not found)',
      }),
      detail('No blocking validation error is shown', errorMessages.length === 0, {
        actual: errorMessages.join(' | ') || '(none)',
      }),
    ],
  };
}

async function ensureAc02BaselineUser(page, username) {
  const listed = await tableHasText(page, username);
  if (listed.found) {
    return { ok: true, created: false, rowText: listed.rowText, reason: '' };
  }

  const create = await openAndPopulateUserCreateForm(page, 'TC-AC02-06', AC02_VALID_PASSWORD, username);
  if (create.blocked) {
    return { ok: false, created: false, rowText: '', reason: create.reason };
  }
  if (create.tableCheck.found) {
    return { ok: true, created: true, rowText: create.tableCheck.rowText, reason: '' };
  }
  return {
    ok: false,
    created: false,
    rowText: '',
    reason: `Unable to create baseline AC02 reset user ${username}`,
  };
}

async function runAc02ResetNegativeCase(page, tcId) {
  const title = TC_CATALOG[tcId];
  const caseDef = AC02_RESET_CASES[tcId];
  if (!caseDef) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `No AC02 reset-case definition found for ${tcId}`);
  }

  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);
  }

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const policy = await ensureAc02PasswordPolicyConfigured(page);
  if (policy.blocked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, policy.reason);
  }
  if (!policy.ok) {
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [
        detail('Password policy setup before reset attempt', false, {
          expected: 'Policy should save with minimum AC02 constraints',
          actual: policy.reason || 'Policy save returned error',
        }),
      ],
    };
  }

  const userRoute = await openFirstReachableRoute(page, {
    loginUrl: QT_URL,
    routePaths: AC_USER_PATHS,
    probeRegex: 'user|role|email|department|location',
    requireEditable: false,
  });
  if (!userRoute.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'User listing page is not reachable for reset flow.');
  }

  const baseline = await ensureAc02BaselineUser(page, AC02_VALID_RESET_USER);
  if (!baseline.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, baseline.reason);
  }

  const rowOpen = await openUserRowForPasswordReset(page, AC02_VALID_RESET_USER);
  if (!rowOpen.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, rowOpen.reason || 'Reset flow UI is not discoverable.');
  }

  const passwordFill = await setUserPasswordFields(page, {
    password: caseDef.password,
    confirmPassword: caseDef.password,
  });
  if (!passwordFill.filled) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Password fields are not discoverable in reset/edit form.');
  }

  const submit = await submitCurrentForm(page);
  if (!submit.clicked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Reset submit action is not discoverable.');
  }

  const messages = Array.isArray(submit.messages) ? submit.messages : [];
  const rejected = !submit.success.matched;
  const messageMatched = matchesExpectedMessage(messages, caseDef.expectedRegex);
  const hasValidation = messages.length > 0;
  const passed = rejected && (messageMatched || hasValidation);

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      detail('Reset password attempt rejected for invalid password', rejected, {
        expected: 'Reset should be blocked by password policy',
        actual: submit.success.matched ? 'Success signal observed' : 'No success signal observed',
      }),
      detail('Validation feedback is visible for reset rule violation', hasValidation, {
        actual: mergeMessages(messages) || '(no message)',
      }),
      detail('Reset validation message matches expected rule', messageMatched || hasValidation, {
        expected: String(caseDef.expectedRegex),
        actual: mergeMessages(messages) || '(no message)',
      }),
      detail('Reset action used expected UI path', true, {
        actual: `action=${rowOpen.action || 'unknown'}, baselineCreated=${baseline.created}`,
      }),
    ],
  };
}

async function newComplianceContext(browser) {
  const options = {
    viewport: { width: 1366, height: 900 },
  };
  if (QT_RECORD_VIDEO) {
    options.recordVideo = {
      dir: path.resolve(__dirname, '..', 'test-reports'),
      size: { width: 1280, height: 720 },
    };
  }
  return browser.newContext(options);
}

async function runRouteDenialCase(page, { tcId, title, roleKey, routePaths }) {
  const preflight = validateCoreConfig() || requireCreds(roleKey);
  if (preflight) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);
  }
  if (!Array.isArray(routePaths) || !routePaths.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'No route paths configured for denial probe.');
  }

  const role = ROLE_CREDS[roleKey];
  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: role.username,
    password: role.password,
  });

  const probes = [];
  for (const routePath of routePaths) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await WhenProbeRouteAccess(page, { loginUrl: QT_URL, routePath });
    probes.push(probe);
  }

  const deniedResults = probes.map((probe) => ({ probe, verdict: ThenProbeShouldBeDenied(probe) }));
  const details = deniedResults.map(({ probe, verdict }) => detail(
    `Direct route denial: ${probe.route}`,
    verdict.passed,
    {
      expected: 'HTTP 401/403 or unauthorized UI state',
      actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
      reason: verdict.reason || '',
    }
  ));

  const passed = details.every((item) => item.passed);
  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details,
  };
}

async function runApiNoTokenCase(browser) {
  const tcId = 'TC-AC08-01';
  const title = TC_CATALOG[tcId];
  const coreIssue = validateCoreConfig();
  if (coreIssue) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${coreIssue}`);

  const context = await newComplianceContext(browser);
  try {
    const probes = [];
    for (const endpoint of AC_PROTECTED_API_ENDPOINTS) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await WhenProbeApiRequest(context.request, {
        loginUrl: QT_URL,
        endpoint,
        method: 'GET',
      });
      probes.push(probe);
    }

    const details = probes.map((probe) => {
      const verdict = ThenApiShouldBeDenied(probe);
      return detail(`API without token denied: ${probe.endpoint}`, verdict.passed, {
        expected: 'HTTP 401/403',
        actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
        reason: verdict.reason || '',
      });
    });

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runApiExpiredTokenCase(browser) {
  const tcId = 'TC-AC08-02';
  const title = TC_CATALOG[tcId];
  const coreIssue = validateCoreConfig();
  if (coreIssue) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${coreIssue}`);

  const context = await newComplianceContext(browser);
  try {
    const probes = [];
    for (const endpoint of AC_PROTECTED_API_ENDPOINTS) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await WhenProbeApiRequest(context.request, {
        loginUrl: QT_URL,
        endpoint,
        method: 'GET',
        headers: {
          Authorization: 'Bearer expired-or-invalid-token-for-ac08',
        },
      });
      probes.push(probe);
    }

    const details = probes.map((probe) => {
      const verdict = ThenApiShouldBeDenied(probe);
      return detail(`API with expired token denied: ${probe.endpoint}`, verdict.passed, {
        expected: 'HTTP 401/403',
        actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
        reason: verdict.reason || '',
      });
    });

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runApiValidTokenCase(page) {
  const tcId = 'TC-AC08-03';
  const title = TC_CATALOG[tcId];
  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const probes = [];
  for (const endpoint of AC_PROTECTED_API_ENDPOINTS) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await WhenProbeApiRequest(page.context().request, {
      loginUrl: QT_URL,
      endpoint,
      method: 'GET',
    });
    probes.push(probe);
  }

  const details = probes.map((probe) => {
    const isSuccess = probe.status >= 200 && probe.status < 300;
    return detail(`API with valid session succeeds: ${probe.endpoint}`, isSuccess, {
      expected: 'HTTP 2xx',
      actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
      reason: isSuccess ? '' : 'Protected endpoint did not return success for authenticated session.',
    });
  });

  const passed = details.every((item) => item.passed);
  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details,
  };
}

async function runApiGuessabilityCase(browser) {
  const tcId = 'TC-AC08-04';
  const title = TC_CATALOG[tcId];
  const coreIssue = validateCoreConfig();
  if (coreIssue) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${coreIssue}`);

  const context = await newComplianceContext(browser);
  try {
    const probes = [];
    for (const endpoint of AC_GUESSED_API_ENDPOINTS) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await WhenProbeApiRequest(context.request, {
        loginUrl: QT_URL,
        endpoint,
        method: 'GET',
      });
      probes.push(probe);
    }

    const details = probes.map((probe) => {
      const okStatus = probe.status === 401 || probe.status === 403 || probe.status === 404;
      return detail(`Guessed endpoint is denied or absent: ${probe.endpoint}`, okStatus, {
        expected: 'HTTP 401/403/404',
        actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
        reason: okStatus ? '' : 'Guessed endpoint returned an unexpected status.',
      });
    });

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runBuilderDeniedForStandardCase(page) {
  const tcId = 'TC-AC10-01';
  const title = TC_CATALOG[tcId];
  const preflight = validateCoreConfig() || requireCreds('standard');
  if (preflight) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.standard.username,
    password: ROLE_CREDS.standard.password,
  });

  const probe = await WhenProbeRouteAccess(page, {
    loginUrl: QT_URL,
    routePath: AC_BUILDER_PATH,
  });

  const verdict = ThenProbeShouldBeDenied(probe);
  return {
    ...baseCase(tcId, title),
    status: verdict.passed ? 'passed' : 'failed',
    details: [
      detail('Builder route denied for standard user', verdict.passed, {
        expected: 'HTTP 401/403 or explicit access denied message',
        actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
        reason: verdict.reason || '',
      }),
    ],
  };
}

async function runBuilderAllowedForAdminCase(page) {
  const tcId = 'TC-AC10-02';
  const title = TC_CATALOG[tcId];
  const preflight = validateCoreConfig() || requireCreds('admin');
  if (preflight) return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Preflight failed: ${preflight}`);

  await GivenUserLoggedIn(page, {
    loginUrl: QT_URL,
    username: ROLE_CREDS.admin.username,
    password: ROLE_CREDS.admin.password,
  });

  const probe = await WhenProbeRouteAccess(page, {
    loginUrl: QT_URL,
    routePath: AC_BUILDER_PATH,
  });

  const unauthorized = probe.unauthorizedByStatus || probe.unauthorizedByUi;
  const builderSignal = /template|design|builder|canvas|drag|workflow/i.test(String(probe.bodySnippet || ''));
  const passed = !unauthorized && (probe.status === 200 || builderSignal);

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      detail('Builder route accessible to admin', passed, {
        expected: 'HTTP 200 and builder UI signal',
        actual: `status=${probe.status}, unauthorizedUi=${probe.unauthorizedByUi}, snippet=${probe.bodySnippet || '(empty)'}`,
        reason: passed ? '' : 'Builder route was denied or no builder UI signal was detected.',
      }),
    ],
  };
}

async function runBuilderEnvironmentRestrictionCase(browser, tcId, envUrl, envLabel) {
  const title = TC_CATALOG[tcId];
  const baseIssue = !isConfiguredValue(envUrl)
    ? `${envLabel} URL is not configured (set ${envLabel === 'QA' ? 'QT_AC_QA_URL' : 'QT_AC_PROD_URL'})`
    : (!isValidAbsoluteUrl(envUrl) ? `${envLabel} URL is invalid: ${envUrl}` : '');
  const preflight = baseIssue || requireCreds('admin');
  if (preflight) return blockedCase(tcId, title, READINESS.NEEDS_ENVIRONMENT, `Preflight failed: ${preflight}`);

  const context = await newComplianceContext(browser);
  const page = await context.newPage();

  try {
    await GivenUserLoggedIn(page, {
      loginUrl: envUrl,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });

    const probe = await WhenProbeRouteAccess(page, {
      loginUrl: envUrl,
      routePath: AC_BUILDER_PATH,
    });

    const denied = probe.status === 401 || probe.status === 403 || probe.status === 404 || probe.unauthorizedByUi;
    return {
      ...baseCase(tcId, title, READINESS.AUTOMATABLE),
      status: denied ? 'passed' : 'failed',
      details: [
        detail(`Builder restricted in ${envLabel}`, denied, {
          expected: 'HTTP 401/403/404 or explicit environment restriction',
          actual: `status=${probe.status}, body=${probe.bodySnippet || '(empty)'}`,
          reason: denied ? '' : `Builder appears accessible in ${envLabel}.`,
        }),
      ],
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runImplementedCase(tcId, browser, page) {
  if (tcId === 'TC-MPP-AC02') return runAc02PolicySetupCase(page);
  if (tcId === 'TC-AC02-01') return runAc02CreateNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-02') return runAc02CreateNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-03') return runAc02CreateNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-04') return runAc02CreateNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-05') return runAc02CreateNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-06') return runAc02CreatePositiveCase(page);
  if (tcId === 'TC-AC02-PR-01') return runAc02ResetNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-PR-02') return runAc02ResetNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-PR-03') return runAc02ResetNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-PR-04') return runAc02ResetNegativeCase(page, tcId);
  if (tcId === 'TC-AC02-PR-05') return runAc02ResetNegativeCase(page, tcId);

  if (tcId === 'TC-AC-01') {
    return runRouteDenialCase(page, {
      tcId,
      title: TC_CATALOG[tcId],
      roleKey: 'viewer',
      routePaths: AC_ADMIN_PROTECTED_PATHS,
    });
  }
  if (tcId === 'TC-AC-02') {
    return runRouteDenialCase(page, {
      tcId,
      title: TC_CATALOG[tcId],
      roleKey: 'viewer',
      routePaths: AC_EDIT_PROTECTED_PATHS,
    });
  }
  if (tcId === 'TC-AC-03') {
    return runRouteDenialCase(page, {
      tcId,
      title: TC_CATALOG[tcId],
      roleKey: 'viewer',
      routePaths: AC_APPROVE_PROTECTED_PATHS,
    });
  }
  if (tcId === 'TC-AC-MC-01') {
    return runRouteDenialCase(page, {
      tcId,
      title: TC_CATALOG[tcId],
      roleKey: 'viewer',
      routePaths: [AC_MODULE_COUNTRY_PATH],
    });
  }
  if (tcId === 'TC-AC-MA-01') {
    return runRouteDenialCase(page, {
      tcId,
      title: TC_CATALOG[tcId],
      roleKey: 'viewer',
      routePaths: [AC_MODULE_CREATE_APP_PATH],
    });
  }
  if (tcId === 'TC-AC08-01') return runApiNoTokenCase(browser);
  if (tcId === 'TC-AC08-02') return runApiExpiredTokenCase(browser);
  if (tcId === 'TC-AC08-03') return runApiValidTokenCase(page);
  if (tcId === 'TC-AC08-04') return runApiGuessabilityCase(browser);
  if (tcId === 'TC-AC10-01') return runBuilderDeniedForStandardCase(page);
  if (tcId === 'TC-AC10-02') return runBuilderAllowedForAdminCase(page);
  if (tcId === 'TC-AC10-03') return runBuilderEnvironmentRestrictionCase(browser, tcId, AC_QA_URL, 'QA');
  if (tcId === 'TC-AC10-04') return runBuilderEnvironmentRestrictionCase(browser, tcId, AC_PROD_URL, 'Production');
  return null;
}

async function runOne(tcId) {
  const id = String(tcId || '').trim().toUpperCase();
  const title = TC_CATALOG[id];
  if (!title) {
    return blockedCase(id || 'UNKNOWN-TC', id || 'Unknown AC TC', READINESS.NEEDS_FEATURE_HOOK, `Unknown AC test case ID: ${id || '(empty)'}`);
  }

  if (!IMPLEMENTED_TC_IDS.has(id)) {
    return blockedCase(id, title, getReadinessForTc(id), getUnimplementedReason(id), [
      detail('Scenario catalog mapping', true, {
        actual: `${id} is registered in Access Control catalog`,
      }),
      detail('Implementation status', false, {
        actual: 'Scenario is scaffolded and returns explicit blocked readiness until feature hooks are finalized.',
      }),
    ]);
  }

  const browser = await chromium.launch({ headless: QT_HEADLESS });
  const context = await newComplianceContext(browser);
  const page = await context.newPage();

  try {
    const implemented = await runImplementedCase(id, browser, page);
    if (implemented) return implemented;

    return blockedCase(id, title, READINESS.NEEDS_FEATURE_HOOK, `No implementation mapped for ${id}`);
  } catch (error) {
    return {
      ...baseCase(id, title, getReadinessForTc(id)),
      status: 'failed',
      details: [
        detail('Unhandled error', false, {
          reason: String(error?.message || error),
        }),
      ],
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const startedAt = new Date().toISOString();

  try {
    if (QT_TC_ID && QT_TC_ID.trim()) {
      const tcId = String(QT_TC_ID).trim();
      log(`Running single AC test case: ${tcId}`);
      const single = await runOne(tcId);
      emitResult({
        suite: 'AC',
        mode: 'single',
        masterName: QT_MASTER,
        tcId,
        startedAt,
        completedAt: new Date().toISOString(),
        ...single,
      });
      return;
    }

    const results = [];
    for (const tcId of DEFAULT_ALL_ORDER) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runOne(tcId);
      results.push(result);
    }

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
    };

    emitResult({
      suite: 'AC',
      mode: 'all',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      summary,
      results,
    });
  } catch (error) {
    emitResult({
      suite: 'AC',
      mode: QT_TC_ID ? 'single' : 'all',
      status: 'failed',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(error?.message || error),
    });
  }
}

main().catch((error) => {
  process.stderr.write(`[AC-COMPLIANCE] Fatal error: ${String(error?.message || error)}\n`);
  process.stdout.write(JSON.stringify({ suite: 'AC', status: 'failed', error: String(error?.message || error) }));
  process.exit(1);
});
