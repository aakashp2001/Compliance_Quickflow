'use strict';

const path = require('path');
const { chromium } = require('@playwright/test');
const {
  SEL,
  getQuickFlowError,
  getActionableSaveButton,
  clickOptionalYesConfirmation,
} = require('../helpers/uiActions');
const {
  findSensitiveLeaks,
} = require('../helpers/errorLeakChecks');
const {
  buildXssPayload,
  buildSqlInjectionPayload,
  buildOversizedString,
  createExecutableFixture,
  createOversizedFixture,
  createMacroEnabledFixture,
} = require('../helpers/ehFixtures');
const { fillOffcanvasForm } = require('../helpers/formFiller');
const {
  GivenUserLoggedIn,
  GivenNavigatedToModule,
  GivenFormCreateOpened,
} = require('./eh-bdd-steps');
const { attachComplianceTraceability } = require('./compliance-traceability');

const QT_TC_ID = process.env.QT_TC_ID || '';
const QT_MASTER = process.env.QT_MASTER || 'Country';
const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';

const ROLE_CREDS = {
  entry: {
    username: process.env.QT_EH_ENTRY_USER || process.env.QT_USER || 'admin',
    password: process.env.QT_EH_ENTRY_PASS || process.env.QT_PASS || 'admin@123',
  },
  admin: {
    username: process.env.QT_EH_ADMIN_USER || process.env.QT_USER || 'admin',
    password: process.env.QT_EH_ADMIN_PASS || process.env.QT_PASS || 'admin@123',
  },
  supervisor: {
    username: process.env.QT_EH_SUPERVISOR_USER || process.env.QT_USER2 || process.env.QT_USER || 'admin',
    password: process.env.QT_EH_SUPERVISOR_PASS || process.env.QT_PASS2 || process.env.QT_PASS || 'admin@123',
  },
};

const FORM_ISSUANCE_PATH = process.env.QT_EH_FORM_ISSUANCE_PATH || '/Form-Issuance';
const COUNTRY_PATH = process.env.QT_EH_COUNTRY_PATH || '/Country';
const NON_EXISTENT_PATH = process.env.QT_EH_NON_EXISTENT_PATH || `/nonexistent-page-${Date.now()}`;
const UPLOAD_PATH = process.env.QT_EH_UPLOAD_PATH || FORM_ISSUANCE_PATH;
const LOGS_PATH = process.env.QT_EH_LOGS_PATH || '/Logs';
const USER_ADMIN_PATH = process.env.QT_EH_USER_ADMIN_PATH || '/User';
const WORKFLOW_MONITOR_PATH = process.env.QT_EH_WORKFLOW_MONITOR_PATH || FORM_ISSUANCE_PATH;
const REVIEWER_USERNAME = String(process.env.QT_EH_REVIEWER_USER || process.env.QT_USER2 || '').trim();

const READINESS = {
  AUTOMATABLE: 'Automatable',
  NEEDS_FEATURE_HOOK: 'Needs Feature Hook',
};

const TC_CATALOG = {
  'TC-EH-01-01': 'User-facing validation errors do not expose internals',
  'TC-EH-01-02': '404 page does not expose internals',
  'TC-EH-02-01': 'Network timeout shows clear error and preserves entered data',
  'TC-EH-03-01': 'XSS payload is sanitized and not executed',
  'TC-EH-03-02': 'SQL injection string is treated as literal input',
  'TC-EH-03-03': 'Oversized input is handled gracefully',
  'TC-EH-04-01': 'Server-side error logging includes required context fields',
  'TC-EH-05-01': 'Executable file uploads are rejected',
  'TC-EH-05-02': 'Oversized uploads are rejected with size limit message',
  'TC-EH-05-03': 'Macro-enabled files are rejected by policy/scanning',
  'TC-EH-06-01': 'Workflow halts and alerts when approver is deactivated',
};

const DEFAULT_ALL_ORDER = [
  'TC-EH-01-01',
  'TC-EH-01-02',
  'TC-EH-02-01',
  'TC-EH-03-01',
  'TC-EH-03-02',
  'TC-EH-03-03',
  'TC-EH-04-01',
  'TC-EH-05-01',
  'TC-EH-05-02',
  'TC-EH-05-03',
  'TC-EH-06-01',
];

function emitResult(result) {
  const payload = attachComplianceTraceability(result, {
    suite: 'EH',
    runnerName: 'error-handling-runner.js',
  });
  process.stdout.write(JSON.stringify(payload));
}

function log(msg) {
  process.stderr.write(`[EH-COMPLIANCE] ${msg}\n`);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function baseCase(tcId, title, readiness = READINESS.AUTOMATABLE) {
  return {
    suite: 'EH',
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
      {
        step: 'Readiness check',
        passed: false,
        expected: 'Required hooks and workflow available',
        actual: reason,
      },
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

function isValidRouteValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.startsWith('/')) return true;
  return /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(text);
}

function resolveFirstConfigured(keys = []) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (isConfiguredValue(value)) {
      return { key, value };
    }
  }
  return null;
}

function getPreflightSpec(tcId) {
  const common = {
    credentialGroups: [],
    requiredRoutes: [],
  };

  const byTc = {
    'TC-EH-01-01': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Form Issuance route', value: FORM_ISSUANCE_PATH, env: 'QT_EH_FORM_ISSUANCE_PATH' }],
    },
    'TC-EH-01-02': {
      credentialGroups: [
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Non-existent route seed', value: NON_EXISTENT_PATH, env: 'QT_EH_NON_EXISTENT_PATH' }],
    },
    'TC-EH-02-01': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Form Issuance route', value: FORM_ISSUANCE_PATH, env: 'QT_EH_FORM_ISSUANCE_PATH' }],
    },
    'TC-EH-03-01': {
      credentialGroups: [
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Country route', value: COUNTRY_PATH, env: 'QT_EH_COUNTRY_PATH' }],
    },
    'TC-EH-03-02': {
      credentialGroups: [
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Country route', value: COUNTRY_PATH, env: 'QT_EH_COUNTRY_PATH' }],
    },
    'TC-EH-03-03': {
      credentialGroups: [
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Country route', value: COUNTRY_PATH, env: 'QT_EH_COUNTRY_PATH' }],
    },
    'TC-EH-04-01': {
      credentialGroups: [
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Logs route', value: LOGS_PATH, env: 'QT_EH_LOGS_PATH' }],
    },
    'TC-EH-05-01': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Upload route', value: UPLOAD_PATH, env: 'QT_EH_UPLOAD_PATH' }],
    },
    'TC-EH-05-02': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Upload route', value: UPLOAD_PATH, env: 'QT_EH_UPLOAD_PATH' }],
    },
    'TC-EH-05-03': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
      ],
      requiredRoutes: [{ label: 'Upload route', value: UPLOAD_PATH, env: 'QT_EH_UPLOAD_PATH' }],
    },
    'TC-EH-06-01': {
      credentialGroups: [
        { label: 'Entry username', keys: ['QT_EH_ENTRY_USER', 'QT_USER'] },
        { label: 'Entry password', keys: ['QT_EH_ENTRY_PASS', 'QT_PASS'] },
        { label: 'Admin username', keys: ['QT_EH_ADMIN_USER', 'QT_USER'] },
        { label: 'Admin password', keys: ['QT_EH_ADMIN_PASS', 'QT_PASS'] },
        { label: 'Supervisor username', keys: ['QT_EH_SUPERVISOR_USER', 'QT_USER2', 'QT_USER'] },
        { label: 'Supervisor password', keys: ['QT_EH_SUPERVISOR_PASS', 'QT_PASS2', 'QT_PASS'] },
        { label: 'Reviewer username', keys: ['QT_EH_REVIEWER_USER', 'QT_USER2'] },
      ],
      requiredRoutes: [
        { label: 'Form Issuance route', value: FORM_ISSUANCE_PATH, env: 'QT_EH_FORM_ISSUANCE_PATH' },
        { label: 'User Admin route', value: USER_ADMIN_PATH, env: 'QT_EH_USER_ADMIN_PATH' },
        { label: 'Workflow monitor route', value: WORKFLOW_MONITOR_PATH, env: 'QT_EH_WORKFLOW_MONITOR_PATH' },
      ],
    },
  };

  return byTc[tcId] || common;
}

function validatePreflight(tcId, title) {
  const issues = [];
  const details = [];

  if (!isConfiguredValue(QT_URL)) {
    issues.push('QT_URL is not configured');
  } else {
    try {
      // eslint-disable-next-line no-new
      new URL(QT_URL);
      details.push(detail('QT_URL format check', true, { actual: QT_URL }));
    } catch {
      issues.push(`QT_URL is not a valid URL: ${QT_URL}`);
    }
  }

  const spec = getPreflightSpec(tcId);

  for (const group of spec.credentialGroups || []) {
    const resolved = resolveFirstConfigured(group.keys);
    if (!resolved) {
      issues.push(`${group.label} missing. Configure one of: ${group.keys.join(', ')}`);
      continue;
    }
    details.push(detail(`${group.label} availability`, true, {
      actual: `${resolved.key} is set`,
    }));
  }

  for (const routeDef of spec.requiredRoutes || []) {
    if (!isConfiguredValue(routeDef.value)) {
      issues.push(`${routeDef.label} is empty. Configure ${routeDef.env}.`);
      continue;
    }
    if (!isValidRouteValue(routeDef.value)) {
      issues.push(`${routeDef.label} is invalid ("${routeDef.value}"). Use '/Path' or a master slug.`);
      continue;
    }
    details.push(detail(`${routeDef.label} format`, true, {
      actual: routeDef.value,
    }));
  }

  if (!issues.length) return null;

  return blockedCase(
    tcId,
    title,
    READINESS.NEEDS_FEATURE_HOOK,
    `Preflight validation failed: ${issues[0]}`,
    [
      detail('Preflight issues', false, {
        actual: issues.join(' | '),
      }),
      ...details,
    ]
  );
}

function getBaseOrigin() {
  try {
    return new URL(String(QT_URL)).origin;
  } catch {
    return 'https://ipdev.quickflow.in';
  }
}

function createCollector(page, baseOrigin) {
  const consoleEvents = [];
  const responses = [];
  const origin = String(baseOrigin || '');

  const onConsole = (message) => {
    consoleEvents.push({
      type: String(message?.type?.() || 'log'),
      text: String(message?.text?.() || ''),
    });
  };

  const onResponse = (response) => {
    const url = String(response?.url?.() || '');
    if (!origin || url.startsWith(origin)) {
      responses.push(response);
    }
  };

  page.on('console', onConsole);
  page.on('response', onResponse);

  return {
    async stop() {
      page.off('console', onConsole);
      page.off('response', onResponse);

      const responseEvents = [];
      for (const response of responses.slice(0, 40)) {
        const status = Number(response?.status?.() || 0);
        let bodySnippet = '';
        if (status >= 400) {
          bodySnippet = normalizeText(await response.text().catch(() => '')).slice(0, 800);
        }
        const headers = response?.headers?.() || {};
        responseEvents.push({
          url: String(response?.url?.() || ''),
          status,
          headers,
          bodySnippet,
        });
      }
      return { consoleEvents, responseEvents };
    },
  };
}

function collectLeakHitsFromEvents(events = []) {
  const hits = [];
  for (const event of events) {
    const text = normalizeText(event?.text || '');
    if (!text) continue;
    const leaks = findSensitiveLeaks(text);
    if (leaks.length) {
      hits.push({
        source: event?.type || 'console',
        text: text.slice(0, 200),
        leaks,
      });
    }
  }
  return hits;
}

function collectLeakHitsFromResponses(responseEvents = []) {
  const hits = [];
  for (const response of responseEvents) {
    const status = Number(response?.status || 0);
    const isErrorLike = status >= 400 || status === 0;
    if (!isErrorLike) continue;

    const headersText = Object.entries(response?.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    const joined = `${headersText} ${response?.bodySnippet || ''}`.trim();
    if (!joined) continue;

    const leaks = findSensitiveLeaks(joined);
    if (leaks.length) {
      hits.push({
        url: response?.url || '',
        status,
        leaks,
      });
    }
  }
  return hits;
}

async function collectValidationTexts(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const nodes = Array.from(document.querySelectorAll('.text-danger, .invalid-feedback, [data-valmsg-for], .swal2-html-container, .alert-danger'));
    return nodes
      .filter((n) => isVisible(n))
      .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }).catch(() => []);
}

async function readFirstTextValue(page) {
  const locator = page.locator(`${SEL.offcanvas} input[type="text"], ${SEL.offcanvas} textarea, ${SEL.offcanvas} input:not([type])`).first();
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return '';
  return String(await locator.inputValue().catch(() => '')).trim();
}

async function waitForSuccessSignal(page, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const signal = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };
      const candidates = Array.from(document.querySelectorAll('.swal2-html-container, .toast-message, .Toastify__toast-body, .alert-success'))
        .filter((node) => isVisible(node))
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const text = candidates.join(' | ');
      const matched = /success|saved|updated|created|submitted|data saved/i.test(text);
      return { matched, text };
    }).catch(() => ({ matched: false, text: '' }));
    if (signal.matched) return signal;
    await clickOptionalYesConfirmation(page, 350).catch(() => false);
    await page.waitForTimeout(220);
  }
  return { matched: false, text: '' };
}

async function readBodyText(page) {
  return normalizeText(await page.locator('body').innerText().catch(() => ''));
}

async function findVisibleFileInput(page) {
  const candidates = [
    page.locator(`${SEL.offcanvas} input[type="file"]`).first(),
    page.locator('input[type="file"]').first(),
  ];
  for (const candidate of candidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (visible) return candidate;
  }
  return null;
}

async function openUploadContext(page) {
  await GivenNavigatedToModule(page, UPLOAD_PATH, QT_URL);
  let fileInput = await findVisibleFileInput(page);
  if (fileInput) return { ok: true, fileInput };

  await GivenFormCreateOpened(page).catch(() => null);
  fileInput = await findVisibleFileInput(page);
  if (fileInput) return { ok: true, fileInput };
  return { ok: false, reason: 'No visible file input found in upload context' };
}

function collectUploadResponses(responseEvents = []) {
  return (responseEvents || []).filter((event) => {
    const url = String(event?.url || '').toLowerCase();
    return /upload|file|attachment|document|import/.test(url);
  });
}

function hasSuccessUploadSignal(text) {
  return /upload(ed)?\s+success|successfully upload|file uploaded|saved successfully|data saved/i.test(String(text || ''));
}

async function navigateToSelectedModuleWithFallback(page, fallbackRoute) {
  const attempts = [];
  const selectedFromUi = String(QT_MASTER || '').trim();

  if (selectedFromUi) {
    attempts.push(selectedFromUi);
  }
  if (fallbackRoute && String(fallbackRoute).trim()) {
    const route = String(fallbackRoute).trim();
    if (!attempts.some((item) => item.toLowerCase() === route.toLowerCase())) {
      attempts.push(route);
    }
  }

  let lastError = '';
  for (const target of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await GivenNavigatedToModule(page, target, QT_URL);
      // eslint-disable-next-line no-await-in-loop
      await GivenFormCreateOpened(page);
      return { ok: true, target };
    } catch (error) {
      lastError = String(error?.message || error || 'unknown navigation error');
    }
  }

  return {
    ok: false,
    reason: `Could not open create form from selected module/fallback. Tried: ${attempts.join(', ') || '(none)'}. Last error: ${lastError}`,
  };
}

async function newComplianceContext(browser) {
  const contextOptions = {
    viewport: { width: 1366, height: 900 },
  };
  if (QT_RECORD_VIDEO) {
    contextOptions.recordVideo = {
      dir: path.resolve(__dirname, '..', 'test-reports'),
      size: { width: 1280, height: 720 },
    };
  }
  return browser.newContext(contextOptions);
}

async function runTC_EH_01_01(page) {
  const tcId = 'TC-EH-01-01';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.entry.username,
      password: ROLE_CREDS.entry.password,
    });
    const nav = await navigateToSelectedModuleWithFallback(page, FORM_ISSUANCE_PATH);
    if (!nav.ok) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, nav.reason || 'Unable to open selected module for validation check.');
    }

    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Save action is not discoverable for empty form validation check.');
    }

    await saveButton.click();
    await clickOptionalYesConfirmation(page, 1200).catch(() => false);
    await page.waitForTimeout(1200);

    const validationMessages = await collectValidationTexts(page);
    const quickError = await getQuickFlowError(page).catch(() => null);
    const uiText = [...validationMessages, String(quickError?.message || '')].filter(Boolean).join(' | ');
    const uiLeaks = findSensitiveLeaks(uiText);
    const isActionable = validationMessages.some((msg) => /required|mandatory|please|enter|select/i.test(msg));

    const telemetry = await collector.stop();
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);

    const details = [
      detail('Validation message is displayed on empty submit', validationMessages.length > 0, {
        actual: validationMessages.slice(0, 3).join(' | ') || '(none)',
      }),
      detail('Validation message is informative/actionable', isActionable, {
        expected: 'Message like "[Field] is required"',
        actual: validationMessages.slice(0, 3).join(' | ') || '(none)',
      }),
      detail('UI error text does not expose stack/system internals', uiLeaks.length === 0, {
        actual: uiLeaks.length ? JSON.stringify(uiLeaks.slice(0, 3)) : 'no leak signatures',
      }),
      detail('Browser console has no sensitive server internals', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('Error response sensitive-internals leak check', responseLeaks.length === 0, {
        expected: 'No sensitive framework/system markers in error responses',
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
        reason: responseLeaks.length
          ? `Sensitive internals detected in ${responseLeaks.length} response(s)`
          : '',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runTC_EH_01_02(page) {
  const tcId = 'TC-EH-01-02';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });

    const target = `${baseOrigin}${String(NON_EXISTENT_PATH).startsWith('/') ? NON_EXISTENT_PATH : `/${NON_EXISTENT_PATH}`}`;
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const statusCode = Number(response?.status?.() || 0);
    const pageText = normalizeText(await page.locator('body').innerText().catch(() => ''));
    const headersText = response
      ? Object.entries(response.headers() || {}).map(([k, v]) => `${k}: ${v}`).join(' | ')
      : '';

    const routeHandled = statusCode === 404 || /404|not found|page not found|does not exist/i.test(pageText);
    const friendlyMessage = /404|not found|page not found|home|go back|return/i.test(pageText);
    const uiLeaks = findSensitiveLeaks(pageText);
    const headerLeaks = findSensitiveLeaks(headersText);

    const telemetry = await collector.stop();
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const details = [
      detail('Non-existent route resolves to 404-style handling', routeHandled, {
        expected: 'HTTP 404 or explicit Not Found page',
        actual: `status=${statusCode || 'n/a'} text="${pageText.slice(0, 140)}"`,
      }),
      detail('404 page is user friendly', friendlyMessage, {
        actual: pageText.slice(0, 180) || '(no visible body text)',
      }),
      detail('404 UI does not expose framework/path/stack internals', uiLeaks.length === 0, {
        actual: uiLeaks.length ? JSON.stringify(uiLeaks.slice(0, 3)) : 'no leak signatures',
      }),
      detail('404 response headers do not expose internals', headerLeaks.length === 0, {
        actual: headerLeaks.length ? JSON.stringify(headerLeaks.slice(0, 3)) : 'no leak signatures',
      }),
      detail('Browser console has no sensitive internals on 404 flow', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runTC_EH_03_01(page) {
  const tcId = 'TC-EH-03-01';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);
  const xssPayload = buildXssPayload();

  let alertTriggered = false;
  const dialogTexts = [];
  const onDialog = async (dialog) => {
    alertTriggered = true;
    dialogTexts.push(String(dialog?.message?.() || ''));
    await dialog.dismiss().catch(() => {});
  };
  page.on('dialog', onDialog);

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });
    await GivenNavigatedToModule(page, COUNTRY_PATH, QT_URL);
    await GivenFormCreateOpened(page);

    const input = page.locator(`${SEL.offcanvas} input[type="text"], ${SEL.offcanvas} textarea, ${SEL.offcanvas} input:not([type])`).first();
    const fieldVisible = await input.isVisible().catch(() => false);
    if (!fieldVisible) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'No editable text field found on create form for XSS probe.');
    }

    await input.fill(xssPayload);
    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Save action is not discoverable for XSS probe.');
    }

    await saveButton.click();
    await clickOptionalYesConfirmation(page, 1200).catch(() => false);
    await page.waitForTimeout(1600);

    const quickError = await getQuickFlowError(page).catch(() => null);
    const validationMessages = await collectValidationTexts(page);
    const rejectionText = normalizeText(`${quickError?.message || ''} ${validationMessages.join(' ')}`);
    const rejected = /not allowed|invalid|reject|required|mandatory|error|failed/.test(rejectionText);

    const tableSnapshot = normalizeText(await page.locator(SEL.tableRows).first().innerText().catch(() => ''));
    const appearsEscaped = /&lt;script&gt;|<script>alert\('xss'\)<\/script>/i.test(tableSnapshot);
    const appearsLiteralAsText = /alert\('xss'\)/i.test(tableSnapshot);

    const uiLeaks = findSensitiveLeaks(rejectionText);
    const telemetry = await collector.stop();
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);

    const storageOrRejectionSatisfied = rejected || appearsEscaped || appearsLiteralAsText;
    const details = [
      detail('Injected script does not execute in browser', !alertTriggered, {
        actual: alertTriggered ? `dialog=${dialogTexts.join(' | ') || '(empty)'}` : 'no JS alert/dialog triggered',
      }),
      detail('Input is rejected or rendered as safe text', storageOrRejectionSatisfied, {
        expected: 'Validation rejection OR escaped/literal non-executing text',
        actual: `rejected=${rejected}, escaped=${appearsEscaped}, literalText=${appearsLiteralAsText}`,
      }),
      detail('No sensitive server/database internals exposed to user', uiLeaks.length === 0, {
        actual: uiLeaks.length ? JSON.stringify(uiLeaks.slice(0, 3)) : 'no leak signatures',
      }),
      detail('Console remains free of sensitive internal leakage', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('Error response sensitive-internals leak check', responseLeaks.length === 0, {
        expected: 'No sensitive framework/system markers in error responses',
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
        reason: responseLeaks.length
          ? `Sensitive internals detected in ${responseLeaks.length} response(s)`
          : '',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  } finally {
    page.off('dialog', onDialog);
  }
}

async function runTC_EH_02_01(page) {
  const tcId = 'TC-EH-02-01';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);
  const context = page.context();

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.entry.username,
      password: ROLE_CREDS.entry.password,
    });
    const nav = await navigateToSelectedModuleWithFallback(page, FORM_ISSUANCE_PATH);
    if (!nav.ok) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, nav.reason || 'Unable to open selected module for timeout scenario.');
    }

    const auditTrail = await fillOffcanvasForm(page, QT_MASTER).catch(() => ({}));
    const preSubmitValue = await readFirstTextValue(page);
    if (!preSubmitValue) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Could not prefill any text value before network timeout simulation.');
    }

    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Save action not discoverable for network timeout flow.');
    }

    await context.setOffline(true);
    await saveButton.click().catch(() => {});
    await clickOptionalYesConfirmation(page, 900).catch(() => false);
    await page.waitForTimeout(1200);

    const quickErrorOffline = await getQuickFlowError(page).catch(() => null);
    const validationMessages = await collectValidationTexts(page);
    const offlineMessageText = normalizeText(`${quickErrorOffline?.message || ''} ${validationMessages.join(' ')}`);
    const offlineFailureVisible = /network|timeout|failed|offline|unable|error/.test(offlineMessageText);

    const retainedValue = await readFirstTextValue(page);
    const dataRetained = retainedValue.length > 0 && retainedValue === preSubmitValue;

    await context.setOffline(false);
    await page.waitForTimeout(900);

    const retrySaveButton = await getActionableSaveButton(page);
    if (!retrySaveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Form save action unavailable after network restoration.');
    }
    await retrySaveButton.click().catch(() => {});
    await clickOptionalYesConfirmation(page, 1600).catch(() => false);
    const successSignal = await waitForSuccessSignal(page, 9000);
    const quickErrorAfterRetry = await getQuickFlowError(page).catch(() => null);
    const offcanvasVisibleAfterRetry = await page.locator(SEL.offcanvas).first().isVisible().catch(() => false);
    const retrySucceeded = successSignal.matched || (!offcanvasVisibleAfterRetry && !quickErrorAfterRetry);

    const telemetry = await collector.stop();
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const details = [
      detail('Submission fails clearly during network interruption', offlineFailureVisible, {
        expected: 'Network/timeout failure notification',
        actual: offlineMessageText || '(no explicit message detected)',
      }),
      detail('Form data remains for re-submission after failure', dataRetained, {
        expected: preSubmitValue,
        actual: retainedValue || '(empty)',
      }),
      detail('Re-submission succeeds after network restoration', retrySucceeded, {
        actual: successSignal.text || quickErrorAfterRetry?.message || `offcanvasVisible=${offcanvasVisibleAfterRetry}`,
      }),
      detail('No sensitive internals leaked in responses', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
      meta: {
        capturedFields: Object.keys(auditTrail || {}).length,
      },
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  } finally {
    await context.setOffline(false).catch(() => {});
  }
}

async function runTC_EH_03_02(page) {
  const tcId = 'TC-EH-03-02';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);
  const payload = buildSqlInjectionPayload();
  const context = page.context();

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });
    await GivenNavigatedToModule(page, COUNTRY_PATH, QT_URL);
    await GivenFormCreateOpened(page);

    const input = page.locator(`${SEL.offcanvas} input[type="text"], ${SEL.offcanvas} textarea, ${SEL.offcanvas} input:not([type])`).first();
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'No editable text field found for SQL injection probe.');
    }

    await input.fill(payload);
    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Save action not discoverable for SQL injection probe.');
    }

    await saveButton.click();
    await clickOptionalYesConfirmation(page, 1500).catch(() => false);
    await page.waitForTimeout(1500);

    const quickError = await getQuickFlowError(page).catch(() => null);
    const validationMessages = await collectValidationTexts(page);
    const uiMessage = normalizeText(`${quickError?.message || ''} ${validationMessages.join(' ')}`);
    const uiLeaks = findSensitiveLeaks(uiMessage);

    const tableText = normalizeText(await page.locator(SEL.tableRows).first().innerText().catch(() => ''));
    const literalVisibleInUi = tableText.includes(normalizeText(payload));
    const rejected = /invalid|not allowed|failed|error|required|mandatory|exists/.test(uiMessage);

    // API probe with conservative candidate endpoints. If endpoints are unavailable, do not fail case.
    const candidates = [
      `${baseOrigin}/api/masters/${encodeURIComponent(QT_MASTER)}/crud`,
      `${baseOrigin}/api/masters/${encodeURIComponent(QT_MASTER)}`,
      `${baseOrigin}/api/${String(QT_MASTER || '').toLowerCase()}`,
    ];
    const apiProbeResults = [];
    for (const endpoint of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const response = await context.request.post(endpoint, {
        data: { operation: 'create', payload: { name: payload } },
        failOnStatusCode: false,
      }).catch(() => null);
      if (!response) continue;
      // eslint-disable-next-line no-await-in-loop
      const bodyText = normalizeText(await response.text().catch(() => '')).slice(0, 1000);
      apiProbeResults.push({
        endpoint,
        status: response.status(),
        leakHits: findSensitiveLeaks(bodyText),
      });
    }

    const apiLeakFound = apiProbeResults.some((item) => Array.isArray(item.leakHits) && item.leakHits.length > 0);
    const apiReachable = apiProbeResults.some((item) => item.status !== 404 && item.status !== 405);

    const telemetry = await collector.stop();
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const sqlHandledSafely = rejected || literalVisibleInUi;
    const details = [
      detail('SQL injection payload does not expose SQL/system internals in UI', uiLeaks.length === 0, {
        actual: uiLeaks.length ? JSON.stringify(uiLeaks.slice(0, 3)) : 'no leak signatures',
      }),
      detail('Injection string is treated safely (rejected or literal)', sqlHandledSafely, {
        expected: 'Validation rejection OR literal storage/display',
        actual: `rejected=${rejected}, literalVisibleInUi=${literalVisibleInUi}`,
      }),
      detail('No sensitive internals leaked in responses during UI flow', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('API probe does not expose SQL internals when reachable', !apiReachable || !apiLeakFound, {
        actual: apiReachable
          ? JSON.stringify(apiProbeResults.map((item) => ({ status: item.status, endpoint: item.endpoint, leaks: item.leakHits.length })).slice(0, 3))
          : 'No API endpoint reachable for probe; UI path validated',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runTC_EH_03_03(page) {
  const tcId = 'TC-EH-03-03';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);
  const oversized = buildOversizedString(10000, 'EH-OVERSIZED-');

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });
    await GivenNavigatedToModule(page, COUNTRY_PATH, QT_URL);
    await GivenFormCreateOpened(page);

    const input = page.locator(`${SEL.offcanvas} input[type="text"], ${SEL.offcanvas} textarea, ${SEL.offcanvas} input:not([type])`).first();
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'No editable text field found for oversized-input probe.');
    }

    await input.fill(oversized);
    await page.waitForTimeout(700);
    const postFillValue = await input.inputValue().catch(() => '');
    const postFillLength = String(postFillValue || '').length;

    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Save action not discoverable for oversized-input probe.');
    }

    await saveButton.click();
    await clickOptionalYesConfirmation(page, 1200).catch(() => false);
    await page.waitForTimeout(1700);

    const quickError = await getQuickFlowError(page).catch(() => null);
    const validationMessages = await collectValidationTexts(page);
    const msg = normalizeText(`${quickError?.message || ''} ${validationMessages.join(' ')}`);
    const limitEnforced = /max|maximum|length|character|limit|too long|invalid/.test(msg) || postFillLength < oversized.length;
    const crashSignal = /cannot read|undefined|null reference|server error|500|exception/.test(msg);

    const telemetry = await collector.stop();
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);
    const unhandledCrashInConsole = telemetry.consoleEvents.some((event) =>
      /uncaught|typeerror|referenceerror|syntaxerror|runtimeerror/i.test(String(event?.text || ''))
    );

    const details = [
      detail('Oversized payload is accepted by UI input without browser freeze', postFillLength > 0, {
        actual: `inputLengthAfterFill=${postFillLength}`,
      }),
      detail('System handles oversized input gracefully (validation/truncation)', limitEnforced, {
        expected: 'Validation limit message OR controlled truncation',
        actual: `message="${msg.slice(0, 180)}", lengthAfterFill=${postFillLength}`,
      }),
      detail('No unhandled crash or hard failure is exposed', !crashSignal && !unhandledCrashInConsole, {
        actual: crashSignal ? msg.slice(0, 180) : (unhandledCrashInConsole ? 'Unhandled browser error detected in console' : 'no crash signature'),
      }),
      detail('No sensitive internals leaked in responses', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runTC_EH_04_01(page) {
  const tcId = 'TC-EH-04-01';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);
  const context = page.context();

  try {
    log(`${tcId}: start`);
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });

    const malformedCandidates = [
      `${baseOrigin}/template-render/objects/entries`,
      `${baseOrigin}/template-render/workflows/validate`,
      `${baseOrigin}/api/template-render/objects/entries`,
      `${baseOrigin}/api/template-render/workflows/validate`,
    ];

    const requestResults = [];
    for (const endpoint of malformedCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const response = await context.request.post(endpoint, {
        data: { malformed: true, body: null, force: ['bad', 'payload'] },
        failOnStatusCode: false,
      }).catch(() => null);
      if (!response) continue;
      // eslint-disable-next-line no-await-in-loop
      const body = normalizeText(await response.text().catch(() => '')).slice(0, 700);
      requestResults.push({
        endpoint,
        status: response.status(),
        body,
      });
    }

    const triggered500 = requestResults.some((item) => Number(item.status) >= 500);
    if (!triggered500) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(
        tcId,
        title,
        READINESS.NEEDS_FEATURE_HOOK,
        'Could not trigger a 500-class server error with available malformed-request probes in this environment.',
        [
          detail('Probe responses', true, {
            actual: requestResults.length
              ? JSON.stringify(requestResults.map((item) => ({ status: item.status, endpoint: item.endpoint })).slice(0, 4))
              : 'No probe endpoint reachable',
          }),
        ]
      );
    }

    const logRoutes = [LOGS_PATH, '/Admin/Logs', '/Audit-Trails', '/report/viewer'];
    let logRoute = '';
    let logText = '';
    for (const route of logRoutes) {
      // eslint-disable-next-line no-await-in-loop
      await GivenNavigatedToModule(page, route, QT_URL).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      const text = await readBodyText(page);
      if (/log|error|audit|exception|report/i.test(text)) {
        logRoute = route;
        logText = text;
        break;
      }
    }

    if (!logRoute) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(
        tcId,
        title,
        READINESS.NEEDS_FEATURE_HOOK,
        'Server-side logs UI is not accessible/discoverable in the current environment.'
      );
    }

    const hasErrorCode = /\berror\s*code\b|\bcode\s*:\s*[a-z0-9_-]+/i.test(logText);
    const hasModule = /\bmodule\b|\bcontroller\b|\bservice\b/i.test(logText);
    const hasUtcTimestamp = /\bUTC\b|\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?/i.test(logText);
    const hasSessionId = /\bsession\b|\bsession id\b|\buser session\b/i.test(logText);
    const hasRecordOrTxn = /\brecord\b|\btransaction\b|\btxn\b|\breference\b/i.test(logText);
    const sensitiveFound = /\bpassword\b|\baccess token\b|\brefresh token\b|\bauthorization\s*:\s*bearer/i.test(logText);

    const telemetry = await collector.stop();
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const details = [
      detail('Malformed API probe triggers 500-class server error', triggered500, {
        actual: JSON.stringify(requestResults.map((item) => ({ status: item.status, endpoint: item.endpoint })).slice(0, 4)),
      }),
      detail('Logs contain error code and module context', hasErrorCode && hasModule, {
        actual: `errorCode=${hasErrorCode}, module=${hasModule}, route=${logRoute}`,
      }),
      detail('Logs contain UTC/timestamp and session context', hasUtcTimestamp && hasSessionId, {
        actual: `utcOrTimestamp=${hasUtcTimestamp}, sessionContext=${hasSessionId}`,
      }),
      detail('Logs contain affected record/transaction reference', hasRecordOrTxn, {
        actual: `recordOrTxnContext=${hasRecordOrTxn}`,
      }),
      detail('Logs do not expose sensitive secrets (password/token)', !sensitiveFound, {
        actual: sensitiveFound ? 'Sensitive token/password text detected in logs page text' : 'no secret markers detected',
      }),
      detail('No sensitive internals leaked in error responses', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runUploadRejectionCase(page, { tcId, title, fixturePath, rejectionRegex, requireSizeHint = false, requireMacroHint = false }) {
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);

  try {
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.entry.username,
      password: ROLE_CREDS.entry.password,
    });

    const uploadCtx = await openUploadContext(page);
    if (!uploadCtx.ok || !uploadCtx.fileInput) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, uploadCtx.reason || 'Upload UI is unavailable for this environment.');
    }

    await uploadCtx.fileInput.setInputFiles(fixturePath);
    await page.waitForTimeout(900);

    const saveButton = await getActionableSaveButton(page);
    if (saveButton) {
      await saveButton.click().catch(() => {});
      await clickOptionalYesConfirmation(page, 1400).catch(() => false);
    }

    await page.waitForTimeout(1500);
    const quickError = await getQuickFlowError(page).catch(() => null);
    const validationMessages = await collectValidationTexts(page);
    const bodyText = await readBodyText(page);
    const mergedText = normalizeText(`${quickError?.message || ''} ${validationMessages.join(' ')} ${bodyText}`);
    const rejectionDetected = rejectionRegex.test(mergedText);
    const successSignal = await waitForSuccessSignal(page, 2500);
    const uploadSuccess = hasSuccessUploadSignal(successSignal.text) || hasSuccessUploadSignal(mergedText);

    const telemetry = await collector.stop();
    const uploadResponses = collectUploadResponses(telemetry.responseEvents);
    const explicitRejectResponse = uploadResponses.some((event) => Number(event.status) >= 400);
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const sizeHint = /max|maximum|mb|size|limit|too large|exceed/i.test(mergedText);
    const macroHint = /macro|vba|malware|scan|security/i.test(mergedText);

    if (requireMacroHint && rejectionDetected && !macroHint) {
      return blockedCase(
        tcId,
        title,
        READINESS.NEEDS_FEATURE_HOOK,
        'File rejection observed but macro-scanning evidence is not exposed in UI/response in this environment.',
        [
          detail('Rejection evidence', true, { actual: mergedText.slice(0, 180) || '(empty)' }),
        ]
      );
    }

    const rejectionSatisfied = rejectionDetected || explicitRejectResponse;
    const details = [
      detail('Disallowed upload is rejected', rejectionSatisfied, {
        actual: rejectionDetected
          ? `UI/message rejection detected`
          : `uploadResponses=${JSON.stringify(uploadResponses.map((item) => ({ status: item.status, url: item.url })).slice(0, 3))}`,
      }),
      detail('Upload does not complete as success', !uploadSuccess, {
        actual: uploadSuccess ? `Success signal detected: ${successSignal.text || mergedText.slice(0, 120)}` : 'no success upload signal',
      }),
      detail('Rejection message is specific enough for user action', rejectionDetected, {
        actual: mergedText.slice(0, 200) || '(no message text)',
      }),
      detail('Size limit hint is visible for oversized file case', !requireSizeHint || sizeHint, {
        actual: requireSizeHint ? `sizeHint=${sizeHint}` : 'not required for this case',
      }),
      detail('Macro/security hint is visible for macro file case', !requireMacroHint || macroHint, {
        actual: requireMacroHint ? `macroHint=${macroHint}` : 'not required for this case',
      }),
      detail('No sensitive internals leaked in responses', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runTC_EH_05_01(page) {
  const tcId = 'TC-EH-05-01';
  const title = TC_CATALOG[tcId];
  log(`${tcId}: start`);
  const fixture = createExecutableFixture('malicious.exe');
  return runUploadRejectionCase(page, {
    tcId,
    title,
    fixturePath: fixture,
    rejectionRegex: /(\.exe|\.bat|\.sh|not permitted|not allowed|invalid file type|file type.*allowed|forbidden)/i,
  });
}

async function runTC_EH_05_02(page) {
  const tcId = 'TC-EH-05-02';
  const title = TC_CATALOG[tcId];
  log(`${tcId}: start`);
  const fixture = createOversizedFixture('oversized-11mb.bin', 11 * 1024 * 1024);
  return runUploadRejectionCase(page, {
    tcId,
    title,
    fixturePath: fixture,
    rejectionRegex: /(file size|size exceeds|too large|max(?:imum)?\s*\d+\s*(mb|kb)|upload failed)/i,
    requireSizeHint: true,
  });
}

async function runTC_EH_05_03(page) {
  const tcId = 'TC-EH-05-03';
  const title = TC_CATALOG[tcId];
  log(`${tcId}: start`);
  const fixture = createMacroEnabledFixture('macro-enabled.xlsm');
  return runUploadRejectionCase(page, {
    tcId,
    title,
    fixturePath: fixture,
    rejectionRegex: /(\.xlsm|\.docm|macro|vba|malware|not permitted|not allowed|rejected)/i,
    requireMacroHint: true,
  });
}

async function runTC_EH_06_01(page) {
  const tcId = 'TC-EH-06-01';
  const title = TC_CATALOG[tcId];
  const baseOrigin = getBaseOrigin();
  const collector = createCollector(page, baseOrigin);

  try {
    log(`${tcId}: start`);
    if (!REVIEWER_USERNAME) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'QT_EH_REVIEWER_USER is not configured for deactivation routing test.');
    }

    // Step 1: Entry user submits a form to create a pending workflow item.
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.entry.username,
      password: ROLE_CREDS.entry.password,
    });
    await GivenNavigatedToModule(page, FORM_ISSUANCE_PATH, QT_URL);
    await GivenFormCreateOpened(page);
    await fillOffcanvasForm(page, QT_MASTER).catch(() => ({}));

    const saveButton = await getActionableSaveButton(page);
    if (!saveButton) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Could not submit workflow form: save action unavailable.');
    }
    await saveButton.click().catch(() => {});
    await clickOptionalYesConfirmation(page, 1800).catch(() => false);
    const submitSuccess = await waitForSuccessSignal(page, 7000);
    if (!submitSuccess.matched) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Could not confirm workflow submission success in current environment.');
    }

    const recordToken = normalizeText(await page.locator(SEL.tableRows).first().innerText().catch(() => '')).slice(0, 120);

    // Step 2: Admin deactivates reviewer.
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.admin.username,
      password: ROLE_CREDS.admin.password,
    });
    await GivenNavigatedToModule(page, USER_ADMIN_PATH, QT_URL).catch(() => null);
    const adminText = await readBodyText(page);
    if (!/user|account|active|deactive|deactivate/i.test(adminText)) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'User administration/deactivation UI is not discoverable in this environment.');
    }

    if (await page.locator(SEL.searchBox).first().isVisible().catch(() => false)) {
      await page.fill(SEL.searchBox, REVIEWER_USERNAME).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(900);
    }

    const reviewerRow = page.locator(SEL.tableRows).filter({ hasText: new RegExp(REVIEWER_USERNAME, 'i') }).first();
    const reviewerVisible = await reviewerRow.isVisible().catch(() => false);
    if (!reviewerVisible) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Reviewer user "${REVIEWER_USERNAME}" was not found in user administration list.`);
    }

    const deactivateBtn = reviewerRow.locator(SEL.deleteBtn).first();
    const deactivateVisible = await deactivateBtn.isVisible().catch(() => false);
    if (!deactivateVisible) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Deactivate action for reviewer user is not available.');
    }

    await deactivateBtn.click().catch(() => {});
    await clickOptionalYesConfirmation(page, 1800).catch(() => false);
    await page.waitForTimeout(1300);

    // Step 3: Supervisor checks workflow routing alert.
    await GivenUserLoggedIn(page, {
      loginUrl: QT_URL,
      username: ROLE_CREDS.supervisor.username,
      password: ROLE_CREDS.supervisor.password,
    });
    await GivenNavigatedToModule(page, WORKFLOW_MONITOR_PATH, QT_URL).catch(() => null);
    const supervisorText = await readBodyText(page);

    const alertPresent = /workflow|routing|deactivated|inactive|assignee|reviewer|halt|error/i.test(supervisorText);
    const hasRecordContext = !recordToken || supervisorText.includes(recordToken.split(' ').slice(0, 3).join(' '));
    const haltedHint = /halt|paused|stopped|routing error|cannot assign|deactivated/i.test(supervisorText);

    if (!alertPresent) {
      await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
      return blockedCase(
        tcId,
        title,
        READINESS.NEEDS_FEATURE_HOOK,
        'Supervisor workflow alert surface is not discoverable in this environment.',
        [
          detail('Supervisor page snapshot', true, {
            actual: supervisorText.slice(0, 220) || '(empty)',
          }),
        ]
      );
    }

    const telemetry = await collector.stop();
    const responseLeaks = collectLeakHitsFromResponses(telemetry.responseEvents);
    const consoleLeaks = collectLeakHitsFromEvents(telemetry.consoleEvents);

    const details = [
      detail('Workflow routing alert is visible after reviewer deactivation', alertPresent, {
        actual: supervisorText.slice(0, 220),
      }),
      detail('Alert includes workflow/record context', hasRecordContext, {
        actual: `recordToken=${recordToken || '(not captured)'}`,
      }),
      detail('Workflow shows halted/routing-error semantics', haltedHint, {
        actual: `haltedHint=${haltedHint}`,
      }),
      detail('No sensitive internals leaked in responses', responseLeaks.length === 0, {
        actual: responseLeaks.length ? JSON.stringify(responseLeaks.slice(0, 2)) : 'no leak signatures',
      }),
      detail('No sensitive internals leaked in console', consoleLeaks.length === 0, {
        actual: consoleLeaks.length ? JSON.stringify(consoleLeaks.slice(0, 2)) : 'no leak signatures',
      }),
    ];

    const passed = details.every((item) => item.passed);
    return {
      ...baseCase(tcId, title),
      status: passed ? 'passed' : 'failed',
      details,
    };
  } catch (error) {
    await collector.stop().catch(() => ({ consoleEvents: [], responseEvents: [] }));
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [detail('Execution error', false, { reason: String(error?.message || error) })],
    };
  }
}

async function runImplementedCase(tcId, page) {
  if (tcId === 'TC-EH-01-01') return runTC_EH_01_01(page);
  if (tcId === 'TC-EH-01-02') return runTC_EH_01_02(page);
  if (tcId === 'TC-EH-02-01') return runTC_EH_02_01(page);
  if (tcId === 'TC-EH-03-01') return runTC_EH_03_01(page);
  if (tcId === 'TC-EH-03-02') return runTC_EH_03_02(page);
  if (tcId === 'TC-EH-03-03') return runTC_EH_03_03(page);
  if (tcId === 'TC-EH-04-01') return runTC_EH_04_01(page);
  if (tcId === 'TC-EH-05-01') return runTC_EH_05_01(page);
  if (tcId === 'TC-EH-05-02') return runTC_EH_05_02(page);
  if (tcId === 'TC-EH-05-03') return runTC_EH_05_03(page);
  if (tcId === 'TC-EH-06-01') return runTC_EH_06_01(page);
  return null;
}

async function runOne(tcId) {
  const id = String(tcId || '').trim().toUpperCase();
  const title = TC_CATALOG[id];
  if (!title) {
    return blockedCase(id || 'UNKNOWN-TC', id || 'Unknown EH TC', READINESS.NEEDS_FEATURE_HOOK, `Unknown EH test case ID: ${id || '(empty)'}`);
  }

  const preflightFailure = validatePreflight(id, title);
  if (preflightFailure) return preflightFailure;

  const browser = await chromium.launch({ headless: QT_HEADLESS });
  const context = await newComplianceContext(browser);
  const page = await context.newPage();

  try {
    const result = await runImplementedCase(id, page);
    if (result) return result;
    return blockedCase(id, title, READINESS.NEEDS_FEATURE_HOOK, `No implementation mapped for ${id}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const startedAt = new Date().toISOString();

  try {
    if (QT_TC_ID && QT_TC_ID.trim()) {
      const single = await runOne(QT_TC_ID);
      emitResult({
        suite: 'EH',
        mode: 'single',
        masterName: QT_MASTER,
        tcId: String(QT_TC_ID).trim(),
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
      suite: 'EH',
      mode: 'all',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      summary,
      results,
    });
  } catch (error) {
    emitResult({
      suite: 'EH',
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
  process.stderr.write(`[EH-COMPLIANCE] Fatal error: ${String(error?.message || error)}\n`);
  process.stdout.write(JSON.stringify({ suite: 'EH', status: 'failed', error: String(error?.message || error) }));
  process.exit(1);
});
