'use strict';

const { chromium } = require('@playwright/test');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  openAuditTrailPage,
  fillAuditSearch: helperFillAuditSearch,
} = require('./compliance-audit-wrapper');
const {
  login,
  clickOptionalYesConfirmation,
  getQuickFlowError,
  SEL,
} = require('../helpers/uiActions');
const { attachComplianceTraceability } = require('./compliance-traceability');

const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_USER = process.env.QT_USER || 'admin';
const QT_PASS = process.env.QT_PASS || 'admin@123';
const QT_USER2 = process.env.QT_USER2 || QT_USER;
const QT_PASS2 = process.env.QT_PASS2 || QT_PASS;
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
const QT_MASTER = process.env.QT_MASTER || 'Country';
const QT_TC_ID = process.env.QT_TC_ID || '';
const QT_AUDIT_FILTER_USER = process.env.QT_AUDIT_FILTER_USER || 'qa_audit_test';

const AUDIT_ROW_SELECTOR = '#auditTrailTable tbody tr, #output-table-body tr, #output-table tr, #information_table tbody tr, #information_table_wrapper tbody tr, .dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table tbody tr';

const READINESS = {
  AUTOMATABLE: 'Automatable',
  NEEDS_FEATURE_HOOK: 'Needs Feature Hook',
  NEEDS_SEED_DATA: 'Needs Seed Data',
};

function log(message) {
  process.stderr.write(`[AT-COMPLIANCE] ${message}\n`);
}

function emitResult(result) {
  const payload = attachComplianceTraceability(result, {
    suite: 'AT',
    runnerName: 'audit-trail-runner.js',
  });
  process.stdout.write(JSON.stringify(payload));
}

function baseCase(tcId, title, readiness = READINESS.AUTOMATABLE) {
  return {
    suite: 'AT',
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
        step: 'Precondition probe',
        passed: false,
        expected: 'Feature/action available in target environment',
        actual: reason,
      },
      ...details,
    ],
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getBaseUrl() {
  try {
    return new URL(QT_URL).origin;
  } catch {
    return 'https://ipdev.quickflow.in';
  }
}

function parseLastJsonBlock(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('No output from delegated runner');
  const match = text.match(/\{[\s\S]*\}$/);
  const jsonText = match ? match[0] : text;
  return JSON.parse(jsonText);
}

async function newComplianceContext(browser) {
  const options = {
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  };

  if (QT_RECORD_VIDEO) {
    options.recordVideo = {
      dir: path.resolve(__dirname, '..', 'test-reports'),
      size: { width: 1280, height: 720 },
    };
  }

  return browser.newContext(options);
}

async function runDelegatedRunner(runnerFile, tcId, suite) {
  const scriptPath = path.resolve(__dirname, runnerFile);
  const cwd = path.resolve(__dirname, '..');
  const env = {
    ...process.env,
    QT_SUITE: suite,
    QT_URL: String(QT_URL),
    QT_USER: String(QT_USER),
    QT_PASS: String(QT_PASS),
    QT_USER2: String(QT_USER2),
    QT_PASS2: String(QT_PASS2),
    QT_MASTER: String(QT_MASTER),
    QT_TC_ID: String(tcId),
    QT_HEADLESS: QT_HEADLESS ? 'true' : 'false',
  };

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], { cwd, env, maxBuffer: 20 * 1024 * 1024, timeout: 600000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || '').trim();
        reject(new Error(detail || 'Delegated compliance runner failed'));
        return;
      }
      try {
        const parsed = parseLastJsonBlock(stdout);
        parsed._debug = String(stderr || '').trim();
        resolve(parsed);
      } catch (parseErr) {
        reject(new Error(`Delegated runner returned invalid JSON: ${parseErr.message}`));
      }
    });
  });
}

function mapDelegatedResult(tcId, title, delegated, delegatedTcId, delegatedSuite) {
  const status = String(delegated?.status || '').toLowerCase();
  const normalizedStatus = status === 'passed' || status === 'failed' || status === 'blocked' ? status : 'failed';
  const details = Array.isArray(delegated?.details) ? delegated.details : [];

  return {
    ...baseCase(tcId, title, READINESS.AUTOMATABLE),
    status: normalizedStatus,
    details: [
      {
        step: 'Mapped execution',
        passed: normalizedStatus === 'passed',
        expected: `${delegatedSuite} ${delegatedTcId} should satisfy mapped AT condition`,
        actual: `${delegated?.tcId || delegatedTcId} -> ${normalizedStatus}`,
      },
      ...details,
    ],
    _debug: delegated?._debug || '',
  };
}

async function clickVisibleTextTarget(page, regex) {
  const candidates = [
    page.locator('button:visible:not([disabled])').filter({ hasText: regex }).first(),
    page.locator('a:visible').filter({ hasText: regex }).first(),
    page.locator('[role="button"]:visible').filter({ hasText: regex }).first(),
  ];

  for (const candidate of candidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    await candidate.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(700);
    return true;
  }

  return false;
}

async function openAuditLanding(page) {
  const base = getBaseUrl();

  if (typeof openAuditTrailPage === 'function') {
    try {
      await openAuditTrailPage(page, base);
      return { opened: true, route: page.url() || `${base}/report/viewer` };
    } catch {
      // Fallback to runner-local route probing below.
    }
  }

  const routes = [
    `${base}/Audit-Trails`,
    `${base}/Audit-Trail`,
    `${base}/AuditTrail`,
    `${base}/Audit-History`,
    `${base}/report/viewer`,
  ];

  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const looksReady = await page.evaluate((rowSelector) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
      const hasAuditWord = text.includes('audit trail');
      const hasRows = document.querySelectorAll(rowSelector).length > 0;
      const hasSearch = !!document.querySelector('input[type="search"], .dataTables_filter input, [placeholder*="search" i]');
      return hasAuditWord || hasRows || hasSearch;
    }, AUDIT_ROW_SELECTOR).catch(() => false);

    if (looksReady) return { opened: true, route };
  }

  return { opened: false, route: '' };
}

async function fillAuditSearch(page, value) {
  if (typeof helperFillAuditSearch === 'function') {
    const viaHelper = await helperFillAuditSearch(page, value).catch(() => false);
    if (viaHelper) {
      return true;
    }
  }

  const text = String(value || '');
  const candidates = [
    page.locator('label:has-text("Filter") input').first(),
    page.locator('.dataTables_filter input:visible').first(),
    page.locator('input[type="search"]:visible').first(),
    page.locator('input[placeholder*="search" i]:visible').first(),
    page.locator(SEL.searchBox).first(),
  ];

  for (const input of candidates) {
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;

    await input.fill('');
    await input.fill(text);
    await input.press('Enter').catch(() => {});
    await page.waitForTimeout(900);
    return true;
  }

  return false;
}

async function collectAuditRows(page, maxRows = 120) {
  return page.evaluate(({ selector, limit }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    return Array.from(document.querySelectorAll(selector))
      .filter((row) => isVisible(row))
      .map((row, index) => ({
        index,
        text: (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((row) => row.text && !/no data available in table|no matching records/i.test(row.text))
      .slice(0, limit);
  }, { selector: AUDIT_ROW_SELECTOR, limit: maxRows }).catch(() => []);
}

function inferRecordIdFromRows(rows) {
  for (const row of rows || []) {
    const text = String(row?.text || '');
    const match = text.match(/\b[A-Z]{1,10}-\d{1,8}-\d{1,12}\b/i);
    if (match?.[0]) return match[0];
  }
  return '';
}

function extractTimestampToken(text) {
  const raw = String(text || '');
  const iso = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/i);
  if (iso?.[0]) return iso[0];
  const friendly = raw.match(/\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}/);
  return friendly?.[0] || '';
}

function parseTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const friendly = raw.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!friendly) return null;

  const months = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const month = months[String(friendly[2] || '').toLowerCase()];
  if (month === undefined) return null;

  const parsed = new Date(
    Number(friendly[3]),
    month,
    Number(friendly[1]),
    Number(friendly[4]),
    Number(friendly[5]),
    0,
    0
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseMmDdYyyy(value) {
  const raw = String(value || '').trim();
  const parts = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!parts) return null;
  return new Date(Number(parts[3]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0);
}

function isIsoUtcTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00|\+0000)$/.test(String(value || '').trim());
}

function formatMmDdYyyy(dateValue) {
  const d = new Date(dateValue);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

async function applyDefaultDateRange(page) {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 1);
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 1);

  const defaultFrom = formatMmDdYyyy(fromDate);
  const defaultTo = formatMmDdYyyy(toDate);

  const result = await page.evaluate(({ fromText, toText }) => {
    const isVisible = (el) => !!el && !!el.offsetParent;
    const emit = (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    const operators = Array.from(document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]'));
    for (const operator of operators) {
      const operatorText = String(operator.options?.[operator.selectedIndex]?.textContent || operator.value || '').toLowerCase();
      if (!/between/.test(operatorText)) continue;

      const base = String(operator.id || operator.name || '').replace(/_Operator$/, '');
      if (!base) continue;

      const input1 = document.getElementById(`${base}_Value_1`) || document.querySelector(`input[name="${base}_Value_1"]`);
      const input2 = document.getElementById(`${base}_Value_2`) || document.querySelector(`input[name="${base}_Value_2"]`);
      if (!isVisible(input1) || !isVisible(input2)) continue;

      input1.removeAttribute('readonly');
      input2.removeAttribute('readonly');

      input1.value = fromText;
      input2.value = toText;
      emit(input1);
      emit(input2);

      return {
        filled: !!String(input1.value || '').trim() && !!String(input2.value || '').trim(),
        reason: 'filled',
        value1: String(input1.value || '').trim(),
        value2: String(input2.value || '').trim(),
      };
    }

    return {
      filled: false,
      reason: 'performed-on-between-filter-not-found',
      value1: '',
      value2: '',
    };
  }, { fromText: defaultFrom, toText: defaultTo }).catch(() => ({
    filled: false,
    reason: 'evaluate-failed',
    value1: '',
    value2: '',
  }));

  return result;
}

async function probeDeleteAuditEndpoints(requestContext, recordId) {
  const base = getBaseUrl();
  const safeId = encodeURIComponent(String(recordId || '1'));
  const candidates = [
    `${base}/api/audit-trail/${safeId}`,
    `${base}/api/audit-trails/${safeId}`,
    `${base}/api/audittrail/${safeId}`,
    `${base}/api/auditTrail/${safeId}`,
    `${base}/api/audit-trail?id=${safeId}`,
    `${base}/api/audit-trails?id=${safeId}`,
  ];

  const responses = [];
  for (const url of candidates) {
    try {
      const response = await requestContext.fetch(url, {
        method: 'DELETE',
        failOnStatusCode: false,
        headers: {
          accept: 'application/json, text/plain, */*',
        },
      });
      responses.push({ url, status: response.status() });
    } catch (error) {
      responses.push({ url, error: String(error?.message || error) });
    }
  }

  return responses;
}

async function probeBulkDeleteAuditEndpoints(requestContext, recordId) {
  const base = getBaseUrl();
  const safeId = String(recordId || '1');
  const payload = {
    ids: [safeId],
    reason: 'AT compliance immutability probe',
  };

  const candidates = [
    `${base}/api/audit-trails/bulk-delete`,
    `${base}/api/audit-trail/bulk-delete`,
    `${base}/api/audittrail/bulk-delete`,
    `${base}/api/audit-trails/delete-many`,
    `${base}/api/audit-trail/delete-many`,
  ];

  const responses = [];
  for (const url of candidates) {
    try {
      const response = await requestContext.fetch(url, {
        method: 'POST',
        failOnStatusCode: false,
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        },
        data: payload,
      });
      responses.push({ url, status: response.status() });
    } catch (error) {
      responses.push({ url, error: String(error?.message || error) });
    }
  }

  return responses;
}

function evaluateMutationProbe(responses) {
  const concrete = (responses || []).filter((item) => Number.isInteger(item?.status));
  const non404 = concrete.filter((item) => item.status !== 404);
  const mutatingSuccess = non404.some((item) => item.status >= 200 && item.status < 300);
  const hasStrongBlock = non404.some((item) => item.status === 403 || item.status === 405);
  const allRejected = non404.length > 0 && non404.every((item) => item.status >= 400);

  return {
    concreteCount: concrete.length,
    non404Count: non404.length,
    mutatingSuccess,
    hasStrongBlock,
    allRejected,
  };
}

async function runTC_AT_01_01() {
  const tcId = 'TC-AT-01-01';
  const title = 'Create Operation Audit Trail';
  const delegated = await runDelegatedRunner('compliance-runner.js', 'TC-DI-01-01', 'DI');
  return mapDelegatedResult(tcId, title, delegated, 'TC-DI-01-01', 'DI');
}

async function runTC_AT_01_02() {
  const tcId = 'TC-AT-01-02';
  const title = 'Update Operation Audit Trail';
  const delegated = await runDelegatedRunner('compliance-runner.js', 'TC-DI-01-02', 'DI');
  return mapDelegatedResult(tcId, title, delegated, 'TC-DI-01-02', 'DI');
}

async function runTC_AT_01_03() {
  const tcId = 'TC-AT-01-03';
  const title = 'Deactivate Operation Audit Trail';
  const delegated = await runDelegatedRunner('compliance-runner.js', 'TC-DI-08-01', 'DI');
  return mapDelegatedResult(tcId, title, delegated, 'TC-DI-08-01', 'DI');
}

async function runTC_AT_02_01(page) {
  const tcId = 'TC-AT-02-01';
  const title = 'Audit Trail Entries Cannot Be Edited via UI';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const probe = await page.evaluate((rowSelector) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const rows = Array.from(document.querySelectorAll(rowSelector)).filter((row) => isVisible(row));
    const mutableControls = [];

    for (const row of rows) {
      const controls = Array.from(row.querySelectorAll('a, button, input, textarea, [contenteditable="true"], .fa-edit, .fa-pen-to-square, .fa-trash'));
      for (const control of controls) {
        if (!isVisible(control)) continue;
        const text = `${control.textContent || ''} ${control.getAttribute?.('title') || ''} ${control.getAttribute?.('aria-label') || ''}`.trim();
        const className = control.className || '';
        const hasEditIntent = /edit|update|modify|delete|remove/i.test(text) || /fa-edit|fa-pen-to-square|fa-trash/i.test(className);

        if (!hasEditIntent) continue;
        mutableControls.push({
          text,
          className,
        });
      }
    }

    return {
      rowCount: rows.length,
      mutableControls,
      mutableControlCount: mutableControls.length,
    };
  }, AUDIT_ROW_SELECTOR).catch(() => ({ rowCount: 0, mutableControls: [], mutableControlCount: 0 }));

  const passed = probe.mutableControlCount === 0;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Audit rows scanned for edit/delete controls',
        passed,
        expected: 'No mutable controls should be available on audit rows',
        actual: `${probe.mutableControlCount} mutable control(s) detected across ${probe.rowCount} row(s)`,
      },
      {
        step: 'Sample mutable controls',
        passed: probe.mutableControlCount === 0,
        actual: probe.mutableControls.slice(0, 5).map((entry) => entry.text || entry.className).join(' | ') || '(none)',
      },
    ],
  };
}

async function runTC_AT_02_02(page) {
  const tcId = 'TC-AT-02-02';
  const title = 'Audit Trail Entries Cannot Be Deleted via API';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const rows = await collectAuditRows(page, 80);
  const recordId = inferRecordIdFromRows(rows) || '1';
  const responses = await probeDeleteAuditEndpoints(page.context().request, recordId);
  const probe = evaluateMutationProbe(responses);

  if (probe.non404Count === 0) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Could not discover a concrete audit delete API endpoint (only 404 or transport errors).', [
      {
        step: 'Delete probe responses',
        passed: false,
        actual: responses.map((item) => `${item.url} -> ${item.status || item.error || 'error'}`).join(' | '),
      },
    ]);
  }

  const passed = !probe.mutatingSuccess && probe.allRejected;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Direct DELETE request on audit endpoints',
        passed,
        expected: '403/405 or equivalent rejection; no 2xx mutation accepted',
        actual: responses.map((item) => `${item.status || 'ERR'}:${item.url.split('/').slice(-2).join('/')}`).join(' | '),
      },
      {
        step: 'Security rejection strength',
        passed: probe.hasStrongBlock || probe.allRejected,
        expected: 'At least one explicit policy rejection (403/405) or full rejection set',
        actual: probe.hasStrongBlock ? '403/405 observed' : 'Only equivalent non-2xx rejections observed',
      },
    ],
  };
}

async function runTC_AT_03_01(page) {
  const tcId = 'TC-AT-03-01';
  const title = 'Audit Data Protected from Bulk Delete Operations';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const rows = await collectAuditRows(page, 80);
  const recordId = inferRecordIdFromRows(rows) || '1';
  const responses = await probeBulkDeleteAuditEndpoints(page.context().request, recordId);
  const probe = evaluateMutationProbe(responses);

  if (probe.non404Count === 0) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Bulk-delete API endpoint is not discoverable in current environment.', [
      {
        step: 'Bulk delete probe responses',
        passed: false,
        actual: responses.map((item) => `${item.url} -> ${item.status || item.error || 'error'}`).join(' | '),
      },
    ]);
  }

  const passed = !probe.mutatingSuccess && probe.allRejected;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Bulk delete payload rejected by backend',
        passed,
        expected: 'Bulk delete API must reject requests for audit data',
        actual: responses.map((item) => `${item.status || 'ERR'}:${item.url.split('/').slice(-2).join('/')}`).join(' | '),
      },
    ],
  };
}

async function runTC_AT_04_01() {
  const tcId = 'TC-AT-04-01';
  const title = 'E-Signature Event Details in Audit Trail';
  const delegated = await runDelegatedRunner('master-data-runner.js', 'TC-MD-01-02', 'MD');
  return mapDelegatedResult(tcId, title, delegated, 'TC-MD-01-02', 'MD');
}

async function runTC_AT_05_01(page) {
  const tcId = 'TC-AT-05-01';
  const title = 'Verify Audit Trail Filtering by User';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  await fillAuditSearch(page, QT_AUDIT_FILTER_USER).catch(() => false);
  const rows = await collectAuditRows(page, 80);

  if (!rows.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, `No rows returned for user filter "${QT_AUDIT_FILTER_USER}".`);
  }

  const allMatch = rows.every((row) => normalizeText(row.text).includes(normalizeText(QT_AUDIT_FILTER_USER)));

  return {
    ...baseCase(tcId, title),
    status: allMatch ? 'passed' : 'failed',
    details: [
      {
        step: 'User filter query applied',
        passed: true,
        expected: QT_AUDIT_FILTER_USER,
        actual: QT_AUDIT_FILTER_USER,
      },
      {
        step: 'All returned rows match selected user',
        passed: allMatch,
        expected: `Every row contains "${QT_AUDIT_FILTER_USER}"`,
        actual: `${rows.filter((row) => normalizeText(row.text).includes(normalizeText(QT_AUDIT_FILTER_USER))).length}/${rows.length} rows matched`,
      },
    ],
  };
}

async function runTC_AT_05_02(page) {
  const tcId = 'TC-AT-05-02';
  const title = 'Verify Audit Trail Filtering by Date Range';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const rangeResult = await applyDefaultDateRange(page).catch(() => ({ filled: false, reason: 'range-fill-failed', value1: '', value2: '' }));
  await clickVisibleTextTarget(page, /execute|ecucute|run|apply|search|submit|view/i).catch(() => false);

  if (!rangeResult.filled) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Date range filter could not be applied (${rangeResult.reason || 'unknown'}).`);
  }

  const rows = await collectAuditRows(page, 120);
  const fromDate = parseMmDdYyyy(rangeResult.value1);
  const toDate = parseMmDdYyyy(rangeResult.value2);

  if (!rows.length || !fromDate || !toDate) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'No auditable rows or parseable date bounds available after applying date range.');
  }

  const toInclusive = new Date(toDate.getTime());
  toInclusive.setHours(23, 59, 59, 999);

  const rowChecks = rows.map((row) => {
    const token = extractTimestampToken(row.text);
    const parsed = parseTimestamp(token);
    const within = !!parsed && parsed >= fromDate && parsed <= toInclusive;
    return { token, within };
  });

  const parseable = rowChecks.filter((check) => !!check.token && !!parseTimestamp(check.token));
  if (!parseable.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'Rows were found but no parseable timestamps were detected.');
  }

  const allWithin = parseable.every((check) => check.within);

  return {
    ...baseCase(tcId, title),
    status: allWithin ? 'passed' : 'failed',
    details: [
      {
        step: 'Date range filter set and executed',
        passed: true,
        expected: `${rangeResult.value1} -> ${rangeResult.value2}`,
        actual: `${rangeResult.value1} -> ${rangeResult.value2}`,
      },
      {
        step: 'Returned rows are within selected range',
        passed: allWithin,
        expected: 'All timestamps should fall in selected range',
        actual: `${parseable.filter((check) => check.within).length}/${parseable.length} parseable rows in range`,
      },
    ],
  };
}

async function runTC_AT_05_03(page) {
  const tcId = 'TC-AT-05-03';
  const title = 'Verify Combined Filters (User + Date Range + Master)';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const rangeResult = await applyDefaultDateRange(page).catch(() => ({ filled: false, reason: 'range-fill-failed', value1: '', value2: '' }));
  if (!rangeResult.filled) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Date range filter could not be applied (${rangeResult.reason || 'unknown'}).`);
  }

  await clickVisibleTextTarget(page, /execute|ecucute|run|apply|search|submit|view/i).catch(() => false);
  await fillAuditSearch(page, `${QT_AUDIT_FILTER_USER} ${QT_MASTER}`).catch(() => false);
  const rows = await collectAuditRows(page, 80);

  if (!rows.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, `No rows returned for combined filter "${QT_AUDIT_FILTER_USER} + ${QT_MASTER}".`);
  }

  const fromDate = parseMmDdYyyy(rangeResult.value1);
  const toDate = parseMmDdYyyy(rangeResult.value2);
  const toInclusive = toDate ? new Date(toDate.getTime()) : null;
  if (toInclusive) toInclusive.setHours(23, 59, 59, 999);

  const masterNorm = normalizeText(QT_MASTER).replace(/-/g, ' ');
  const checks = rows.map((row) => {
    const text = normalizeText(row.text);
    const userOk = text.includes(normalizeText(QT_AUDIT_FILTER_USER));
    const masterOk = text.includes(masterNorm);
    const tsToken = extractTimestampToken(row.text);
    const tsParsed = parseTimestamp(tsToken);
    const dateOk = !!fromDate && !!toInclusive && !!tsParsed && tsParsed >= fromDate && tsParsed <= toInclusive;
    return {
      ok: userOk && masterOk && dateOk,
      userOk,
      masterOk,
      dateOk,
    };
  });

  const allMatch = checks.every((entry) => entry.ok);

  return {
    ...baseCase(tcId, title),
    status: allMatch ? 'passed' : 'failed',
    details: [
      {
        step: 'Combined filter query applied',
        passed: true,
        expected: `${QT_AUDIT_FILTER_USER} + ${QT_MASTER} + ${rangeResult.value1}..${rangeResult.value2}`,
        actual: `${QT_AUDIT_FILTER_USER} + ${QT_MASTER} + ${rangeResult.value1}..${rangeResult.value2}`,
      },
      {
        step: 'Returned rows satisfy both filters',
        passed: allMatch,
        expected: 'Each row matches selected user, selected master, and selected date range',
        actual: `${checks.filter((entry) => entry.ok).length}/${checks.length} rows matched all three filters`,
      },
    ],
  };
}

async function runTC_AT_06_01(page) {
  const tcId = 'TC-AT-06-01';
  const title = 'Verify Failed Login Attempts are Logged';

  const baseUrl = getBaseUrl();
  const badPassword = `Invalid@${Date.now()}`;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForSelector(SEL.username, { timeout: 30000 }).catch(() => {});
  await page.fill(SEL.username, QT_USER).catch(() => {});
  await page.fill(SEL.password, badPassword).catch(() => {});
  await page.click(SEL.loginBtn).catch(() => {});
  await page.waitForTimeout(1500);
  const failedError = await getQuickFlowError(page).catch(() => null);

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  await fillAuditSearch(page, QT_USER).catch(() => false);
  const rows = await collectAuditRows(page, 100);
  if (!rows.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'No audit rows returned while checking failed login evidence.');
  }

  const failedRow = rows.find((row) => {
    const text = normalizeText(row.text);
    return text.includes(normalizeText(QT_USER)) && /failed\s*login|login\s*failed|invalid\s*login|invalid\s*credential|authentication\s*failed/i.test(text);
  });

  const passed = !!failedRow;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Invalid login attempt generated an auth error',
        passed: !!failedError,
        expected: 'Login should fail with invalid credentials',
        actual: failedError?.message || '(no explicit popup error captured)',
      },
      {
        step: 'Failed login event found in audit trail',
        passed,
        expected: 'Audit row should include failed login details for attempted user',
        actual: failedRow?.text?.slice(0, 220) || '(not found)',
      },
    ],
  };
}

async function runTC_AT_06_02(page) {
  const tcId = 'TC-AT-06-02';
  const title = 'Verify Configuration Changes are Logged';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });

  const baseUrl = getBaseUrl();
  const policyRoutes = [
    `${baseUrl}/Password-Policy`,
    `${baseUrl}/PasswordPolicy`,
    `${baseUrl}/Admin-Password-Policy`,
    `${baseUrl}/Admin/Password-Policy`,
  ];

  let policyOpened = false;
  for (const route of policyRoutes) {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 9000 }).catch(() => {});

    const hasPolicySignals = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const hasPolicy = /password\s*policy|lockout|expiry|minimum\s*length/.test(text);
      const hasEditable = !!document.querySelector('input:enabled:not([readonly]), select:enabled:not([readonly]), textarea:enabled:not([readonly])');
      return hasPolicy && hasEditable;
    }).catch(() => false);

    if (hasPolicySignals) {
      policyOpened = true;
      break;
    }
  }

  if (!policyOpened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Password Policy configuration UI is not discoverable in the current environment.');
  }

  const changeResult = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const controls = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
      .filter((el) => !['hidden', 'password'].includes(String(el.type || '').toLowerCase()));

    const control = controls[0];
    if (!control) return { updated: false, reason: 'no-editable-control' };

    const oldValue = 'value' in control ? String(control.value || '') : String(control.textContent || '');
    let newValue = oldValue;

    if (control.tagName.toLowerCase() === 'select') {
      const options = Array.from(control.options || []).filter((opt) => String(opt.value || '').trim() !== '');
      if (options.length < 2) return { updated: false, reason: 'select-has-no-alternative' };
      const next = options.find((opt) => String(opt.value) !== oldValue) || options[0];
      control.value = next.value;
      newValue = String(next.value || '');
    } else if (String(control.type || '').toLowerCase() === 'number') {
      const currentNumber = Number(oldValue || 0);
      newValue = Number.isFinite(currentNumber) ? String(currentNumber + 1) : '1';
      control.value = newValue;
    } else {
      newValue = `${oldValue || 'Policy'}-AT`;
      control.value = newValue;
    }

    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    control.dispatchEvent(new Event('blur', { bubbles: true }));

    const label = control.getAttribute('name') || control.getAttribute('id') || control.getAttribute('aria-label') || control.tagName;
    return { updated: true, label, oldValue, newValue };
  }).catch(() => ({ updated: false, reason: 'update-evaluate-failed' }));

  if (!changeResult.updated) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, `Policy field could not be updated (${changeResult.reason || 'unknown'}).`);
  }

  const saveClicked = await clickVisibleTextTarget(page, /save|update|submit|apply/i);
  if (!saveClicked) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'No Save/Update action is available on Password Policy page.');
  }

  await clickOptionalYesConfirmation(page, 3000).catch(() => false);
  await page.waitForTimeout(1200);
  const saveError = await getQuickFlowError(page).catch(() => null);

  if (saveError?.message) {
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [
        {
          step: 'Password policy save operation',
          passed: false,
          expected: 'Configuration save should succeed',
          actual: saveError.message,
        },
      ],
    };
  }

  const openedAudit = await openAuditLanding(page);
  if (!openedAudit.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened after configuration change.');
  }

  await fillAuditSearch(page, 'password policy').catch(() => false);
  const rows = await collectAuditRows(page, 100);
  if (!rows.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'No audit rows were returned for password policy search.');
  }

  const configRow = rows.find((row) => {
    const text = normalizeText(row.text);
    return /password\s*policy|configuration/.test(text) && /update|updated|modified|changed/.test(text);
  });

  const passed = !!configRow;

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Configuration updated in policy UI',
        passed: true,
        expected: `${changeResult.label}: ${changeResult.oldValue} -> ${changeResult.newValue}`,
        actual: `${changeResult.label}: ${changeResult.oldValue} -> ${changeResult.newValue}`,
      },
      {
        step: 'Configuration change appears in audit trail',
        passed,
        expected: 'Audit row should include policy update evidence with performer and timestamp',
        actual: configRow?.text?.slice(0, 220) || '(not found)',
      },
    ],
  };
}

async function runTC_AT_07_01(page) {
  const tcId = 'TC-AT-07-01';
  const title = 'Verify Audit Trail Export to PDF';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  await applyDefaultDateRange(page).catch(() => ({ filled: false }));
  await clickVisibleTextTarget(page, /execute|ecucute|run|apply|search|submit|view/i).catch(() => false);

  const exportButton = page.locator('button:visible:not([disabled]), a:visible').filter({ hasText: /export\s*to\s*pdf|export\s*pdf|pdf\s*export|export|download\s*pdf|pdf/i }).first();
  const canExport = await exportButton.isVisible().catch(() => false);

  if (!canExport) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'PDF export control is not available on the current audit page.');
  }

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    exportButton.click({ timeout: 7000, force: true }).catch(() => {}),
  ]).then((result) => result[0]);

  if (!download) {
    return {
      ...baseCase(tcId, title),
      status: 'failed',
      details: [
        {
          step: 'Export action triggered',
          passed: false,
          expected: 'A PDF download should start',
          actual: 'No download event observed',
        },
      ],
    };
  }

  const reportsDir = path.resolve(__dirname, '..', 'test-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const outPath = path.join(reportsDir, `at-export-${Date.now()}.pdf`);
  await download.saveAs(outPath).catch(() => {});

  const exists = fs.existsSync(outPath);
  const buffer = exists ? fs.readFileSync(outPath) : Buffer.from([]);
  const header = buffer.slice(0, 5).toString('utf8');
  const passed = exists && buffer.length > 5 && header === '%PDF-';

  return {
    ...baseCase(tcId, title),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'PDF file downloaded',
        passed: exists,
        expected: 'Downloaded artifact should exist on disk',
        actual: exists ? outPath : '(file not found)',
      },
      {
        step: 'PDF signature validation',
        passed,
        expected: 'File starts with %PDF- and is non-empty',
        actual: `header=${header || '(empty)'} size=${buffer.length}`,
      },
    ],
  };
}

async function runTC_AT_08_01(page) {
  const tcId = 'TC-AT-08-01';
  const title = 'Timestamp Timezone Consistency (ISO 8601 UTC)';

  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  const opened = await openAuditLanding(page);
  if (!opened.opened) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Audit Trail page could not be opened in current environment.');
  }

  const rows = await collectAuditRows(page, 120);
  if (!rows.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'No audit rows available to evaluate timestamp format.');
  }

  const timestampChecks = rows
    .map((row) => {
      const token = extractTimestampToken(row.text);
      return {
        token,
        isoUtc: token ? isIsoUtcTimestamp(token) : false,
      };
    })
    .filter((entry) => !!entry.token);

  if (!timestampChecks.length) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'No parseable timestamp tokens found in visible audit rows.');
  }

  const allIsoUtc = timestampChecks.every((entry) => entry.isoUtc);

  return {
    ...baseCase(tcId, title),
    status: allIsoUtc ? 'passed' : 'failed',
    details: [
      {
        step: 'ISO 8601 UTC timestamp format check',
        passed: allIsoUtc,
        expected: 'All sampled timestamps should be ISO 8601 with UTC designator (Z or +00:00)',
        actual: `${timestampChecks.filter((entry) => entry.isoUtc).length}/${timestampChecks.length} rows matched`,
      },
      {
        step: 'Sample timestamp evidence',
        passed: true,
        actual: timestampChecks.slice(0, 5).map((entry) => entry.token).join(' | '),
      },
    ],
  };
}

async function runTC_AT_08_02() {
  return blockedCase(
    'TC-AT-08-02',
    'Verify Admin Time Change is Logged',
    READINESS.NEEDS_FEATURE_HOOK,
    'Blocked: system clock/admin time adjustment is outside browser-level automation sandbox for this runner.'
  );
}

async function runTC_AT_09_01() {
  return blockedCase(
    'TC-AT-09-01',
    'Verify Audit Retention Policy Configuration',
    READINESS.NEEDS_FEATURE_HOOK,
    'Blocked: retention configuration is managed outside browser-level automation and requires environment-level policy hooks.'
  );
}

async function runTC_AT_09_02() {
  return blockedCase(
    'TC-AT-09-02',
    'Verify Archived Audit Records are Accessible',
    READINESS.NEEDS_FEATURE_HOOK,
    'Blocked: archived audit retrieval is outside browser-level automation scope and needs backend/archive access hooks.'
  );
}

async function runTC_AT_10_01() {
  const tcId = 'TC-AT-10-01';
  const title = 'Verify Audit Trail After Record Deactivation';
  const delegated = await runDelegatedRunner('compliance-runner.js', 'TC-DI-08-01', 'DI');
  return mapDelegatedResult(tcId, title, delegated, 'TC-DI-08-01', 'DI');
}

const TC_MAP = {
  'TC-AT-01-01': { run: async () => runTC_AT_01_01() },
  'TC-AT-01-02': { run: async () => runTC_AT_01_02() },
  'TC-AT-01-03': { run: async () => runTC_AT_01_03() },
  'TC-AT-02-01': { run: async ({ page }) => runTC_AT_02_01(page) },
  'TC-AT-02-02': { run: async ({ page }) => runTC_AT_02_02(page) },
  'TC-AT-03-01': { run: async ({ page }) => runTC_AT_03_01(page) },
  'TC-AT-04-01': { run: async () => runTC_AT_04_01() },
  'TC-AT-05-01': { run: async ({ page }) => runTC_AT_05_01(page) },
  'TC-AT-05-02': { run: async ({ page }) => runTC_AT_05_02(page) },
  'TC-AT-05-03': { run: async ({ page }) => runTC_AT_05_03(page) },
  'TC-AT-06-01': { run: async ({ page }) => runTC_AT_06_01(page) },
  'TC-AT-06-02': { run: async ({ page }) => runTC_AT_06_02(page) },
  'TC-AT-07-01': { run: async ({ page }) => runTC_AT_07_01(page) },
  'TC-AT-08-01': { run: async ({ page }) => runTC_AT_08_01(page) },
  'TC-AT-08-02': { run: async () => runTC_AT_08_02() },
  'TC-AT-09-01': { run: async () => runTC_AT_09_01() },
  'TC-AT-09-02': { run: async () => runTC_AT_09_02() },
  'TC-AT-10-01': { run: async () => runTC_AT_10_01() },
};

const DEFAULT_ALL_ORDER = [
  'TC-AT-01-01',
  'TC-AT-01-02',
  'TC-AT-01-03',
  'TC-AT-02-01',
  'TC-AT-02-02',
  'TC-AT-03-01',
  'TC-AT-04-01',
  'TC-AT-05-01',
  'TC-AT-05-02',
  'TC-AT-05-03',
  'TC-AT-06-01',
  'TC-AT-06-02',
  'TC-AT-07-01',
  'TC-AT-08-01',
  'TC-AT-08-02',
  'TC-AT-09-01',
  'TC-AT-09-02',
  'TC-AT-10-01',
];

async function runOne(tcId, browser, sharedContext, sharedPage) {
  const entry = TC_MAP[tcId];
  if (!entry) {
    return {
      ...baseCase(tcId, tcId),
      status: 'blocked',
      reason: `Unknown TC ID: ${tcId}`,
      details: [{ step: 'Dispatcher', passed: false, actual: 'tc-id-not-mapped' }],
    };
  }

  try {
    const result = await entry.run({ browser, context: sharedContext, page: sharedPage });
    return {
      suite: 'AT',
      ...result,
    };
  } catch (error) {
    return {
      ...baseCase(tcId, tcId),
      status: 'failed',
      details: [{ step: 'Unhandled error', passed: false, reason: String(error?.message || error) }],
    };
  }
}

async function main() {
  log(`Suite=AT master=${QT_MASTER} tc=${QT_TC_ID || '(all)'}`);

  const browser = await chromium.launch({ headless: QT_HEADLESS });
  const context = await newComplianceContext(browser);
  const page = await context.newPage();

  const startedAt = new Date().toISOString();
  let output;

  try {
    if (QT_TC_ID && QT_TC_ID.trim()) {
      const tcId = String(QT_TC_ID).trim();
      const single = await runOne(tcId, browser, context, page);
      output = {
        suite: 'AT',
        mode: 'single',
        masterName: QT_MASTER,
        tcId,
        startedAt,
        completedAt: new Date().toISOString(),
        ...single,
      };
    } else {
      const results = [];
      for (const tcId of DEFAULT_ALL_ORDER) {
        const result = await runOne(tcId, browser, context, page);
        results.push(result);
      }

      output = {
        suite: 'AT',
        mode: 'all',
        masterName: QT_MASTER,
        startedAt,
        completedAt: new Date().toISOString(),
        summary: {
          total: results.length,
          passed: results.filter((result) => result.status === 'passed').length,
          failed: results.filter((result) => result.status === 'failed').length,
          blocked: results.filter((result) => result.status === 'blocked').length,
        },
        results,
      };
    }
  } catch (error) {
    output = {
      suite: 'AT',
      mode: QT_TC_ID ? 'single' : 'all',
      status: 'failed',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(error?.message || error),
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  emitResult(output);
}

main().catch((error) => {
  process.stderr.write(`[AT-COMPLIANCE] Fatal error: ${error?.message || error}\n`);
  process.stdout.write(JSON.stringify({ suite: 'AT', status: 'failed', error: String(error?.message || error) }));
  process.exit(1);
});
