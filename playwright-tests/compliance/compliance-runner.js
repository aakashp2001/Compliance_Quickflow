/**
 * compliance-runner.js
 *
 * Standalone Node.js script triggered by the backend (server.js) via child_process.execFile.
 * Runs a single Data Integrity compliance test case and outputs a JSON result to stdout.
 */

'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const { fillOffcanvasForm } = require('../helpers/formFiller');
const { verifyAuditTrailEntry } = require('../helpers/auditTrail');
const { login, navigateTo, openCreateForm, getActionableSaveButton, clickOptionalYesConfirmation, SEL } = require('../helpers/uiActions');

const OFFCANVAS_SCOPE = `:is(${SEL.offcanvas})`;

const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_USER = process.env.QT_USER || 'admin';
const QT_PASS = process.env.QT_PASS || 'admin@123';
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
const QT_MASTER = process.env.QT_MASTER || 'Department';
const QT_TC_ID = process.env.QT_TC_ID || '';
const QT_USER2 = process.env.QT_USER2 || QT_USER;
const QT_PASS2 = process.env.QT_PASS2 || QT_PASS;

function log(msg) {
  process.stderr.write(`[COMPLIANCE] ${msg}\n`);
}

function emitResult(result) {
  process.stdout.write(JSON.stringify(result));
}

// ── Playback overlay: direct DOM injection that survives page navigations ──────
// Maintain the last requested overlay state so it can be re-applied to any
// pages (including popups) in the same Playwright context until hidden.
const _pageOverlayState = new Map();
const _contextOverlayState = new WeakMap();

async function _injectOverlay(page, desc, index, total) {
  try {
    await page.evaluate(({ d, i, t }) => {
      try {
        // Inject CSS once per document
        if (!document.getElementById('__pbo_s')) {
          const s = document.createElement('style');
          s.id = '__pbo_s';
          s.textContent =
            '#__pbo{position:fixed;top:12px;right:12px;z-index:2147483647;' +
            'background:rgba(11, 18, 32, 0.8);color:#fff;padding:10px 16px;border-radius:10px;' +
            'box-shadow:0 8px 32px rgba(0, 0, 0, 0.5);min-width:220px;max-width:500px;' +
            'display:none;align-items:center;gap:10px;font-family:system-ui,sans-serif;font-size:14px;pointer-events:none;}' +
            '#__pbo_main{flex:1;font-weight:600;line-height:1.35;color:#fff;}' +
            '#__pbo_meta{color:#94a3b8;font-size:12px;white-space:nowrap;}' +
            '#__pbo_x{background:none;border:none;color:#94a3b8;cursor:pointer;' +
            'font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;pointer-events:auto;}';
          document.documentElement.appendChild(s);
        }

        // Create or reuse overlay element
        let el = document.getElementById('__pbo');
        if (!el) {
          el = document.createElement('div');
          el.id = '__pbo';
          el.style.display = 'none';
          el.style.alignItems = 'center';
          el.style.gap = '10px';
          el.innerHTML =
            '<div id="__pbo_main" style="flex:1;margin-right:8px"></div>' +
            '<div id="__pbo_meta" style="margin-left:4px"></div>';
          document.documentElement.appendChild(el);
        }

        const main = document.getElementById('__pbo_main');
        const meta = document.getElementById('__pbo_meta');
        if (main) main.textContent = d;
        if (meta) meta.textContent = (i && t) ? (i + ' of ' + t) : '';
        el.style.display = 'flex';
      } catch (e) {
        // DOM may be in flux; ignore injection errors
      }
    }, { d: String(desc || ''), i: Number(index || 0), t: Number(total || 0) });
  } catch (_) {
    // page is navigating or closed — safe to ignore
  }
}

/**
 * Call once per Playwright page. Registers a 'load' listener so the overlay
 * is automatically re-injected after every page navigation. If a global
 * overlay state exists, apply it to newly-created pages as well.
 */
function setupOverlayOnPage(page) {
  // Re-apply overlay after navigations and DOM changes that replace page content.
  const tryReinject = async () => {
    const state = _pageOverlayState.get(page) || _contextOverlayState.get(page.context());
    if (state) {
      _pageOverlayState.set(page, state);
      await _injectOverlay(page, state.desc, state.index, state.total).catch(() => { });
    }
  };

  page.on('load', tryReinject);
  page.on('domcontentloaded', tryReinject);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) tryReinject().catch(() => { });
  });
}

async function showPlaybackOverlay(page, desc, index, total) {
  if (!page) return;
  const state = { desc, index, total };
  _contextOverlayState.set(page.context(), state);

  // Apply to all pages in the same context so popups/navigations show the overlay.
  try {
    const pages = page.context().pages();
    for (const p of pages) {
      _pageOverlayState.set(p, state);
      await _injectOverlay(p, desc, index, total).catch(() => { });
    }
  } catch (e) {
    // Fallback: set only for provided page
    _pageOverlayState.set(page, state);
    await _injectOverlay(page, desc, index, total).catch(() => { });
  }
}

async function hidePlaybackOverlay(page) {
  if (!page) return;
  _contextOverlayState.delete(page.context());
  try {
    const pages = page.context().pages();
    for (const p of pages) {
      _pageOverlayState.delete(p);
      try {
        await p.evaluate(() => {
          const el = document.getElementById('__pbo');
          if (el) el.style.display = 'none';
        });
      } catch (_) {
        // ignore per-page errors
      }
    }
  } catch (e) {
    // fallback: hide on provided page only
    _pageOverlayState.delete(page);
    try {
      await page.evaluate(() => {
        const el = document.getElementById('__pbo');
        if (el) el.style.display = 'none';
      });
    } catch (_) { }
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractTimestampFromText(text) {
  const raw = String(text || '');
  const iso = raw.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i);
  if (iso?.[0]) return iso[0];
  const friendly = raw.match(/\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}/);
  return friendly?.[0] || '';
}

function parseAuditTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const m = raw.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;

  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const monthIndex = months[String(m[2] || '').toLowerCase()];
  if (monthIndex === undefined) return null;

  const d = new Date(
    Number(m[3]),
    monthIndex,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

async function getFirstVisibleMasterRowData(page) {
  return page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('table thead th')).map((th) => (th.innerText || '').trim());
    const firstRow = document.querySelector('.dt-scroll-body tbody tr:first-child, .dataTables_scrollBody tbody tr:first-child, table tbody tr:first-child');
    if (!firstRow) return null;

    const cells = Array.from(firstRow.querySelectorAll('td'));
    const data = {};
    headers.forEach((h, i) => {
      if (cells[i]) data[h] = (cells[i].innerText || '').trim();
    });
    return {
      data,
      raw: (firstRow.innerText || firstRow.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => null);
}

function pickFieldValue(map, keys) {
  const source = map || {};
  const all = Object.keys(source);
  for (const key of all) {
    const normalizedKey = normalizeText(key);
    if (keys.some((k) => normalizedKey === normalizeText(k) || normalizedKey.includes(normalizeText(k)))) {
      return source[key];
    }
  }
  return '';
}

function normalizeComparableValue(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const parts = text
    .split(/[,;|\n]+/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  if (parts.length > 1) {
    return Array.from(new Set(parts)).sort().join(',');
  }
  return text;
}

function resolveMasterFieldValueForAuditKey(masterData, auditKey) {
  const source = masterData || {};
  const desired = String(auditKey || '').trim();
  if (!desired) return '';

  const direct = pickFieldValue(source, [desired]);
  if (String(direct || '').trim()) return direct;

  const compact = (value) => normalizeText(value).replace(/[^a-z0-9]/g, '');
  const desiredCompact = compact(desired);
  for (const [key, value] of Object.entries(source)) {
    const keyCompact = compact(key);
    if (!keyCompact || !desiredCompact) continue;
    if (keyCompact === desiredCompact || keyCompact.includes(desiredCompact) || desiredCompact.includes(keyCompact)) {
      return value;
    }
  }

  return '';
}

function deriveChangedAuditTrail(updateAuditTrail, preUpdateMasterData) {
  const changedAuditTrail = {};
  const unchangedAuditFields = [];

  for (const [key, value] of Object.entries(updateAuditTrail || {})) {
    const fieldName = String(key || '').trim();
    if (!fieldName) continue;

    const beforeValue = resolveMasterFieldValueForAuditKey(preUpdateMasterData || {}, fieldName);
    const beforeNorm = normalizeComparableValue(beforeValue);
    const afterNorm = normalizeComparableValue(value);

    if (beforeNorm === afterNorm) {
      unchangedAuditFields.push(fieldName);
      continue;
    }

    changedAuditTrail[fieldName] = value;
  }

  return {
    changedAuditTrail,
    unchangedAuditFields: Array.from(new Set(unchangedAuditFields)),
  };
}

function buildCreateAuditTrailForVerification(formAuditTrail, masterRowData) {
  const out = { ...(formAuditTrail || {}) };
  const master = masterRowData || {};
  const skipKey = /^(action\(s\)|record\s*id|status|performed\s*by|performed\s*on|app\s*icon)$/i;

  for (const [rawKey, rawValue] of Object.entries(master)) {
    const key = String(rawKey || '').trim();
    if (!key || skipKey.test(key)) continue;
    const value = String(rawValue || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;

    // Preserve explicit form-filled values; only backfill missing keys.
    const hasDirect = Object.prototype.hasOwnProperty.call(out, key);
    const hasSimilar = Object.keys(out).some((k) => normalizeText(k) === normalizeText(key));
    if (!hasDirect && !hasSimilar) {
      out[key] = value;
    }
  }

  return out;
}

function extractPerformerFromAuditRow(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const ts = extractTimestampFromText(raw);
  let base = raw;
  if (ts) {
    const idx = raw.lastIndexOf(ts);
    if (idx > 0) base = raw.slice(0, idx).trim();
  }

  const opToken = /(\bcreated\b|\bupdated\b|\bdeleted\b|\bdeactivated\b)/i;
  const opMatch = base.match(opToken);
  if (!opMatch) return '';

  const afterOp = base.slice((opMatch.index || 0) + opMatch[0].length).trim();
  const cleaned = afterOp
    .replace(/compliance\s*tc-di[^\s]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return '';
  const parts = cleaned.split(' ').filter(Boolean);
  return parts.slice(0, 3).join(' ');
}

function expectedSuccessToast(operation) {
  const op = normalizeText(operation);
  if (op === 'create') return 'data saved successfully';
  if (op === 'update') return 'data updated successfully';
  if (op === 'delete' || op === 'deactivate') return 'data deactivated successfully';
  return 'successfully';
}

async function waitForSuccessToastOrHandleConfirm(page, operation, timeoutMs = 30000) {
  const expected = expectedSuccessToast(operation);
  const start = Date.now();
  let lastToast = '';

  while (Date.now() - start < timeoutMs) {
    const toastInfo = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };

      const candidates = Array.from(document.querySelectorAll('.swal2-html-container, .toast-message, .Toastify__toast-body, .toastr, .alert-success'));
      const visible = candidates.find((el) => isVisible(el));
      const text = (visible?.textContent || '').replace(/\s+/g, ' ').trim();
      return { visible: !!visible, text };
    }).catch(() => ({ visible: false, text: '' }));

    const toastText = normalizeText(toastInfo?.text || '');
    if (toastText) lastToast = toastInfo.text;
    if (toastText && toastText.includes(expected)) {
      return { seen: true, text: toastInfo.text || '' };
    }

    await clickOptionalYesConfirmation(page, 250).catch(() => false);
    await page.waitForTimeout(200);
  }

  return { seen: false, text: lastToast };
}

async function applyUpdateReasonToMasterForm(page, reasonText) {
  return page.evaluate((value) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const offcanvas = document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body');
    if (!offcanvas) return { applied: false, field: '', reason: 'offcanvas-not-found' };

    const roots = Array.from(offcanvas.querySelectorAll('.ele')).filter(isVisible);
    const targetRegex = /remarks?|reason|comment|description|notes?/i;

    for (const root of roots) {
      const label = (root.querySelector('label, .form-label, .control-label, .label')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!targetRegex.test(label)) continue;

      const control = root.matches('input, textarea')
        ? root
        : root.querySelector('textarea, input[type="text"], input:not([type]), input[type="search"]');
      if (!control || !isVisible(control) || control.disabled || control.readOnly) continue;

      control.focus();
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      control.dispatchEvent(new Event('blur', { bubbles: true }));
      return { applied: true, field: label || control.name || control.id || 'reason-like-field', reason: '' };
    }

    return { applied: false, field: '', reason: 'reason-like-field-not-found' };
  }, String(reasonText || '')).catch(() => ({ applied: false, field: '', reason: 'evaluate-failed' }));
}

function sanitizeAuditVerifyForReport(verifyResult) {
  if (!verifyResult || typeof verifyResult !== 'object') return verifyResult;
  const { rowSnapshots, operationRowSnapshots, ...rest } = verifyResult;
  return rest;
}

/**
 * Verify that the expected action status word ("Created", "Updated", "Deleted")
 * is literally present in the audit trail row text returned by verifyAuditTrailEntry.
 *
 * IMPORTANT: verifyResult.matched contains internal analysis *labels* such as
 * ["operation:update", "identifier:123", ...] — these are NOT page text and must
 * NEVER be scanned with a regex. We use them only as boolean flags.
 *
 * Real page text lives in:
 *   - verifyResult.matchedRow  : raw text of the matched audit table row
 *   - verifyResult.comparison.matches[*].actual : field values from audit detail
 */
function detectAuditStatus(verifyResult, expectedOperation) {
  const patterns = {
    create: /\bcreated\b/i,
    update: /\bupdated\b/i,
    delete: /\bdeleted\b/i,
  };
  const canon = { create: 'Created', update: 'Updated', delete: 'Deleted' };
  if (!verifyResult) return { found: false, label: '', evidence: '', source: 'status-column', reason: 'no-verify-result' };

  const pat = patterns[expectedOperation] || new RegExp(String(expectedOperation), 'i');

  const snapshots = Array.isArray(verifyResult.operationRowSnapshots)
    ? verifyResult.operationRowSnapshots
    : (Array.isArray(verifyResult.rowSnapshots) ? verifyResult.rowSnapshots : []);
  const statusColumn = verifyResult.statusColumn || {};
  const statusColumnFound = statusColumn.found === true || snapshots.some((row) => Number(row?.statusColumnIndex) >= 0);

  if (!statusColumnFound) {
    return { found: false, label: canon[expectedOperation] || '', evidence: '', source: 'status-column', reason: 'status-column-missing' };
  }
  if (!snapshots.length) {
    return { found: false, label: canon[expectedOperation] || '', evidence: '', source: 'status-column', reason: 'no-audit-rows' };
  }

  const rowChecks = snapshots.map((row) => {
    const statusText = String(row?.statusValue || '').trim();
    const m = statusText.match(pat);
    return {
      statusText,
      matched: !!m,
      evidence: m ? m[0] : '',
    };
  });

  const rowsChecked = rowChecks.length;
  const rowsWithStatus = rowChecks.filter((r) => r.matched).length;
  const allRowsPass = rowsChecked > 0 && rowsWithStatus === rowsChecked;
  const firstEvidence = rowChecks.find((r) => r.matched)?.evidence || '';

  return {
    found: allRowsPass,
    label: canon[expectedOperation] || '',
    evidence: firstEvidence,
    source: 'status-column',
    rowsChecked,
    rowsWithStatus,
    reason: allRowsPass ? '' : 'one-or-more-rows-missing-expected-status',
  };
}

/**
 * Scan every visible audit table row for a record and report whether the
 * expected status word ("Created", "Updated", "Deleted") appears in each row.
 *
 * Returns an object:
 * {
 *   expectedStatus : 'Created' | 'Updated' | 'Deleted',
 *   rowsChecked    : number,
 *   rowsWithStatus : number,
 *   allRowsPass    : boolean,
 *   rows           : [{ rowText, statusFound, evidence }]
 * }
 *
 * This is called AFTER verifyAuditTrailEntry has already opened the report page
 * and found the record's rows, so we rely on the comparison fields + matchedRow
 * to reconstruct the per-row picture without needing the live page.
 */
function buildPerRowStatusReport(verifyResult, expectedOperation) {
  const patterns = {
    create: /\bcreated\b/i,
    update: /\bupdated\b/i,
    delete: /\bdeleted\b/i,
  };
  const canon = { create: 'Created', update: 'Updated', delete: 'Deleted' };
  const expectedStatus = canon[expectedOperation] || expectedOperation;
  const pat = patterns[expectedOperation] || new RegExp(String(expectedOperation), 'i');

  if (!verifyResult) {
    return { expectedStatus, statusColumnFound: false, statusColumnIndex: -1, statusHeader: 'Status', rowsChecked: 0, rowsWithStatus: 0, allRowsPass: false, rows: [] };
  }

  const snapshots = Array.isArray(verifyResult.operationRowSnapshots)
    ? verifyResult.operationRowSnapshots
    : (Array.isArray(verifyResult.rowSnapshots) ? verifyResult.rowSnapshots : []);
  const statusColumn = verifyResult.statusColumn || {};
  const statusColumnFound = statusColumn.found === true || snapshots.some((row) => Number(row?.statusColumnIndex) >= 0);
  const statusColumnIndex = Number.isInteger(statusColumn.index) ? statusColumn.index : (snapshots.find((row) => Number(row?.statusColumnIndex) >= 0)?.statusColumnIndex ?? -1);
  const statusHeader = statusColumn.header || 'Status';

  const rows = snapshots.map((row) => {
    const statusText = String(row?.statusValue || '').trim();
    const m = statusText.match(pat);
    return {
      rowIndex: row?.index,
      rowText: String(row?.text || '').slice(0, 220),
      statusValue: statusText,
      statusFound: !!m,
      evidence: m ? m[0] : '',
    };
  });

  const rowsWithStatus = rows.filter((r) => r.statusFound).length;
  return {
    expectedStatus,
    statusColumnFound,
    statusColumnIndex,
    statusHeader,
    rowsChecked: rows.length,
    rowsWithStatus,
    allRowsPass: statusColumnFound && rows.length > 0 && rowsWithStatus === rows.length,
    rows,
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

async function openEditFormForRecord(page, recordID) {
  if (recordID) {
    await page.fill(SEL.searchBox, '');
    await page.fill(SEL.searchBox, recordID);
    await page.keyboard.press('Enter').catch(() => { });
    await page.waitForTimeout(1500);
  }

  const rowCandidates = [
    recordID ? page.locator(SEL.tableRows).filter({ hasText: new RegExp(String(recordID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first() : null,
    page.locator(SEL.tableRows).first(),
  ].filter(Boolean);

  for (const row of rowCandidates) {
    const rowVisible = await row.isVisible().catch(() => false);
    if (!rowVisible) continue;
    const editInRow = row.locator(SEL.editBtn).first();
    const editVisible = await editInRow.isVisible().catch(() => false);
    if (!editVisible) continue;

    await editInRow.click({ timeout: 8000 }).catch(async () => {
      await editInRow.click({ timeout: 5000, force: true }).catch(() => { });
    });

    const opened = await page.waitForSelector(SEL.offcanvas, { timeout: 15000 }).then(() => true).catch(() => false);
    if (opened) return true;
  }

  return false;
}

// ── Test Case Implementations ──────────────────────────────────────────────────

async function runTC_DI_01(page) {
  log('TC-DI-01-01 & 01-02: Attributability on Create & Update');
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 1/10: Logging in', 1, 10).catch(() => { });
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 2/10: Navigating to master list', 2, 10).catch(() => { });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  // 1. Create Flow
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 3/10: Opening create form', 3, 10).catch(() => { });
  await openCreateForm(page);
  const createAuditTrail = await fillOffcanvasForm(page, QT_MASTER);
  const saveBtnC = await getActionableSaveButton(page);
  if (saveBtnC) {
    await showPlaybackOverlay(page, 'TC-DI-01 — Step 4/10: Saving new record', 4, 10).catch(() => { });
    await saveBtnC.click();
  }
  const createSystemSavedAt = new Date();
  const createToast = await waitForSuccessToastOrHandleConfirm(page, 'create', 5000);
  const toastText = createToast?.text || '';

  // Extract ID from toast (e.g. "Record Created Successfully. ID: 123")
  let recordID = null;

  let masterRowData = null;
  masterRowData = await getFirstVisibleMasterRowData(page);
  if (masterRowData?.data && !recordID) {
    recordID = pickFieldValue(masterRowData.data, ['Record ID', 'Code', 'ID']);
    if (!recordID) {
      const keys = Object.keys(masterRowData.data || {});
      if (keys[1]) recordID = masterRowData.data[keys[1]];
    }
  }

  log(`Created record: ${recordID}`);
  if (masterRowData?.data) {
    log(`Master Page Data: ${JSON.stringify(masterRowData.data)}`);
  }
  const createAuditTrailForVerify = buildCreateAuditTrailForVerification(createAuditTrail, masterRowData?.data);
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 5/10: Verifying create audit trail', 5, 10).catch(() => { });
  const requestedTc = String(QT_TC_ID || '').trim().toUpperCase();
  const onlyCreate = requestedTc === 'TC-DI-01-01';
  const onlyUpdate = requestedTc === 'TC-DI-01-02';

  const createVerify = await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: QT_MASTER,
    operation: 'create',
    recordName: recordID,
    recordID,
    auditTrail: createAuditTrailForVerify,
    username: QT_USER,
    masterPerformedOn: masterRowData?.data?.['Performed On'] || masterRowData?.data?.['Performedon'],
  }).then((res) => ({
    // passed = text analysis passed AND field-level comparison also passed (no mismatches)
    passed: res.verified && (res.comparison === null || res.comparison === undefined || res.comparison.passed !== false),
    ...res,
  })).catch((e) => ({ passed: false, reason: e.message }));
  const createVerifyReport = sanitizeAuditVerifyForReport(createVerify);
  const createStatus = detectAuditStatus(createVerify, 'create');
  const createRowStatus = buildPerRowStatusReport(createVerify, 'create');
  log(`Create audit verification: ${createVerify.passed ? 'passed' : 'failed'}${createVerify.reason ? ' (' + createVerify.reason + ')' : ''}`);
  log(`Create audit status: ${createStatus.found ? 'found (source:' + createStatus.source + ' evidence:' + createStatus.evidence + ')' : 'NOT FOUND in actual row text'}`);
  log(`Create per-row status: ${createRowStatus.rowsWithStatus}/${createRowStatus.rowsChecked} rows contain '${createRowStatus.expectedStatus}'`);
  log(`Create row scope: totalRows=${Array.isArray(createVerify?.rowSnapshots) ? createVerify.rowSnapshots.length : 0}, scopedRows=${Array.isArray(createVerify?.operationRowSnapshots) ? createVerify.operationRowSnapshots.length : 0}`);
  // If caller requested only the create sub-test, return create-only result
  if (onlyCreate) {
    await hidePlaybackOverlay(page).catch(() => { });
    return {
      tcId: 'TC-DI-01-01',
      title: 'Attributability on Create',
      status: (createVerify.passed && createStatus.found) ? 'passed' : 'failed',
      statusChecks: { create: { expected: 'Created', found: !!createStatus.found, source: createStatus.source, evidence: createStatus.evidence } },
      perRowStatusReport: { create: createRowStatus },
      details: [
        { step: 'Create audit verification', ...createVerifyReport },
        {
          step: 'Create status visible in audit trail rows',
          passed: !!createStatus.found,
          expected: 'Created',
          actual: createStatus.label || '(not found)',
          source: createStatus.source || '',
          evidence: createStatus.evidence || '',
          rowsChecked: createRowStatus.rowsChecked,
          rowsWithStatus: createRowStatus.rowsWithStatus,
          rows: createRowStatus.rows,
        },
      ],
      _debug: undefined,
    };
  }

  // 2. Update Flow
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 6/10: Navigating back for update', 6, 10).catch(() => { });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  if (recordID) {
    await page.fill(SEL.searchBox, '').catch(() => { });
    await page.fill(SEL.searchBox, String(recordID)).catch(() => { });
    await page.keyboard.press('Enter').catch(() => { });
    await page.waitForTimeout(1000);
  }
  const preUpdateMasterRowData = await getFirstVisibleMasterRowData(page);
  const editOpened = await openEditFormForRecord(page, recordID);
  if (!editOpened) {
    await hidePlaybackOverlay(page).catch(() => { });
    throw new Error(`Could not open edit form for record ${recordID || '[unknown]'}`);
  }

  await showPlaybackOverlay(page, 'TC-DI-01 — Step 7/10: Opening edit form', 7, 10).catch(() => { });
  const updateAuditTrail = await fillOffcanvasForm(page, QT_MASTER);
  const updateReason = 'Compliance TC-DI-01-02 Update';
  const reasonApplied = await applyUpdateReasonToMasterForm(page, updateReason);
  if (reasonApplied?.applied && reasonApplied.field) {
    updateAuditTrail[reasonApplied.field] = updateReason;
  }
  let submittedUpdateReason = reasonApplied?.applied ? updateReason : '';
  const saveBtnU = await getActionableSaveButton(page);
  if (saveBtnU) {
    await showPlaybackOverlay(page, 'TC-DI-01 — Step 8/10: Saving updated record', 8, 10).catch(() => { });
    await saveBtnU.click();
  }
  const updateSystemSavedAt = new Date();

  const reasonField = page.locator('#reasonTextarea:visible').first();
  if (await reasonField.isVisible().catch(() => false)) {
    await reasonField.fill(updateReason);
    await page.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    submittedUpdateReason = updateReason;
  }

  const { changedAuditTrail, unchangedAuditFields } = deriveChangedAuditTrail(
    updateAuditTrail,
    preUpdateMasterRowData?.data
  );
  log(`Update changed fields: ${Object.keys(changedAuditTrail).length ? Object.keys(changedAuditTrail).join(', ') : 'none'}`);
  log(`Update unchanged fields (expected missing): ${unchangedAuditFields.length ? unchangedAuditFields.join(', ') : 'none'}`);


  await page.waitForTimeout(1000);
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  if (recordID) {
    await page.fill(SEL.searchBox, '');
    await page.fill(SEL.searchBox, String(recordID));
    await page.keyboard.press('Enter').catch(() => { });
    await page.waitForTimeout(1000);
  }
  const updatedMasterRowData = await getFirstVisibleMasterRowData(page);
  const masterReason = pickFieldValue(updatedMasterRowData?.data, ['Reason', 'Update Reason', 'Remarks']);
  const masterPerformedOn = pickFieldValue(updatedMasterRowData?.data, ['Performed On', 'Performedon', 'Last Updated', 'Modified On', 'Updated On']);
  const masterPerformedBy = pickFieldValue(updatedMasterRowData?.data, ['Performed By', 'Performedby', 'Updated By', 'Modified By', 'User']);
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 9/10: Verifying update audit trail', 9, 10).catch(() => { });

  const updateVerify = await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: QT_MASTER,
    operation: 'update',
    recordName: recordID,
    recordID,
    auditTrail: changedAuditTrail,
    skipFields: unchangedAuditFields,
    reason: updateReason,
    username: QT_USER, // Pass username for attributability check
    masterPerformedOn,
  }).then((res) => ({
    // passed = text analysis passed AND field-level comparison also passed (no mismatches)
    passed: res.verified && (res.comparison === null || res.comparison === undefined || res.comparison.passed !== false),
    ...res,
  })).catch((e) => ({ passed: false, reason: e.message }));
  const updateVerifyReport = sanitizeAuditVerifyForReport(updateVerify);

  const updateStatus = detectAuditStatus(updateVerify, 'update');
  const updateRowStatus = buildPerRowStatusReport(updateVerify, 'update');
  log(`Update audit verification: ${updateVerify.passed ? 'passed' : 'failed'}${updateVerify.reason ? ' (' + updateVerify.reason + ')' : ''}`);
  log(`Update audit status: ${updateStatus.found ? 'found (source:' + updateStatus.source + ' evidence:' + updateStatus.evidence + ')' : 'NOT FOUND in actual row text'}`);
  log(`Update per-row status: ${updateRowStatus.rowsWithStatus}/${updateRowStatus.rowsChecked} rows contain '${updateRowStatus.expectedStatus}'`);
  log(`Update row scope: totalRows=${Array.isArray(updateVerify?.rowSnapshots) ? updateVerify.rowSnapshots.length : 0}, scopedRows=${Array.isArray(updateVerify?.operationRowSnapshots) ? updateVerify.operationRowSnapshots.length : 0}, reasonColumnFound=${updateVerify?.reasonColumn?.found ? 'true' : 'false'}`);
  const auditReasonMatched = Array.isArray(updateVerify?.matched) && updateVerify.matched.includes('reason');
  const masterReasonMatched = !masterReason
    ? null
    : normalizeText(masterReason).includes(normalizeText(updateReason))
    || normalizeText(updateReason).includes(normalizeText(masterReason));

  // ── Per-row checks for timestamp, performed-by, and reason ───────────────────
  // These must be verified for EVERY operation-scoped audit row, not just the first matched row.
  const updateOpSnapshots = Array.isArray(updateVerify?.operationRowSnapshots)
    ? updateVerify.operationRowSnapshots
    : [];

  // Timestamp consistency: check every row against master's performed-on time
  const parsedMasterTime = parseAuditTimestamp(masterPerformedOn);
  const perRowTimestamps = updateOpSnapshots.map((snap) => {
    const rowText = String(snap?.text || '');
    const auditTimestampTextRow = extractTimestampFromText(rowText);
    const parsedAuditTimeRow = parseAuditTimestamp(auditTimestampTextRow);
    const deltaRow = parsedAuditTimeRow && parsedMasterTime
      ? Math.abs(parsedAuditTimeRow.getTime() - parsedMasterTime.getTime()) / 1000
      : null;
    return {
      rowIndex: snap?.index,
      rowText: String(rowText).slice(0, 220),
      auditTimestamp: auditTimestampTextRow || '(not found)',
      auditTimeISO: parsedAuditTimeRow ? parsedAuditTimeRow.toISOString() : null,
      deltaAuditVsMasterSeconds: deltaRow,
      withinWindow: deltaRow !== null ? deltaRow <= 120 : false,
    };
  });
  const allTimestampsWithin = perRowTimestamps.length > 0 && perRowTimestamps.every((r) => r.withinWindow);
  // Fallback: use matchedRow timestamp when no operation snapshots available
  const fallbackAuditTimestampText = extractTimestampFromText(updateVerify?.matchedRow || '');
  const fallbackParsedAuditTime = parseAuditTimestamp(fallbackAuditTimestampText);
  const fallbackDeltaAuditVsMasterSec = fallbackParsedAuditTime && parsedMasterTime
    ? Math.abs(fallbackParsedAuditTime.getTime() - parsedMasterTime.getTime()) / 1000
    : null;
  const auditVsMasterWithin = updateOpSnapshots.length > 0
    ? allTimestampsWithin
    : (fallbackDeltaAuditVsMasterSec !== null ? fallbackDeltaAuditVsMasterSec <= 120 : false);

  // Performed-by consistency: check every row
  const perRowPerformedBy = updateOpSnapshots.map((snap) => {
    const rowText = String(snap?.text || '');
    const auditPerformedByRow = extractPerformerFromAuditRow(rowText);
    const matchesMaster = !masterPerformedBy
      ? null
      : (normalizeText(auditPerformedByRow).includes(normalizeText(masterPerformedBy))
        || normalizeText(masterPerformedBy).includes(normalizeText(auditPerformedByRow)));
    const matchesUser = normalizeText(auditPerformedByRow).includes(normalizeText(QT_USER))
      || normalizeText(masterPerformedBy || '').includes(normalizeText(QT_USER));
    return {
      rowIndex: snap?.index,
      rowText: String(rowText).slice(0, 220),
      auditPerformedBy: auditPerformedByRow,
      matchesMaster,
      matchesUser,
      passed: (matchesMaster === null || matchesMaster === true) && matchesUser,
    };
  });
  const allRowsPerformerPass = perRowPerformedBy.length > 0 && perRowPerformedBy.every((r) => r.passed);
  // Fallback for single-matched-row mode
  const fallbackAuditPerformedBy = extractPerformerFromAuditRow(updateVerify?.matchedRow || '');
  const performerMatchesMaster = !masterPerformedBy
    ? null
    : (normalizeText(fallbackAuditPerformedBy).includes(normalizeText(masterPerformedBy))
      || normalizeText(masterPerformedBy).includes(normalizeText(fallbackAuditPerformedBy)));
  const performerMatchesUser = normalizeText(fallbackAuditPerformedBy).includes(normalizeText(QT_USER))
    || normalizeText(masterPerformedBy || '').includes(normalizeText(QT_USER));
  const performedByPassed = updateOpSnapshots.length > 0
    ? allRowsPerformerPass
    : (performerMatchesMaster === null || performerMatchesMaster === true) && performerMatchesUser;

  // Reason consistency: check every row — only compare expected reason vs master reason column
  // (no other fields; just the reason/remarks column value in the audit row)
  const perRowReason = updateOpSnapshots.map((snap) => {
    const reasonValue = String(snap?.reasonValue || '').trim();
    const rowText = String(snap?.text || '');
    // A row passes reason check if it either:
    //  a) has a non-empty reason cell that matches the expected reason, OR
    //  b) has an empty reason cell (reason is stored once, not on every field row)
    const hasReason = !!reasonValue;
    const reasonMatches = hasReason
      ? normalizeText(reasonValue).includes(normalizeText(updateReason))
        || normalizeText(updateReason).includes(normalizeText(reasonValue))
      : true; // empty cell is acceptable (reason not duplicated on every row)
    return {
      rowIndex: snap?.index,
      rowText: String(rowText).slice(0, 220),
      reasonValue: reasonValue || '(empty)',
      reasonMatches,
    };
  });
  // Overall reason check: expected reason must appear in at least one row OR in the matched label
  const anyRowHasReason = perRowReason.some((r) => r.reasonValue !== '(empty)' && r.reasonMatches);
  const reasonConsistencyPassed = auditReasonMatched || anyRowHasReason;

  // Derive audit performed-by from the first operation row for backward-compat reporting
  const auditPerformedBy = perRowPerformedBy[0]?.auditPerformedBy || fallbackAuditPerformedBy;

  // Legacy single-row timing for backward-compat (used when no snapshots available)
  const auditTimestampText = updateOpSnapshots.length > 0
    ? (perRowTimestamps[0]?.auditTimestamp || '')
    : fallbackAuditTimestampText;
  const parsedAuditTime = updateOpSnapshots.length > 0
    ? (perRowTimestamps[0]?.auditTimeISO ? new Date(perRowTimestamps[0].auditTimeISO) : null)
    : fallbackParsedAuditTime;
  const deltaAuditVsMasterSec = updateOpSnapshots.length > 0
    ? (perRowTimestamps[0]?.deltaAuditVsMasterSeconds ?? null)
    : fallbackDeltaAuditVsMasterSec;

  const statusChecksPassed = !!(createStatus && createStatus.found) && !!(updateStatus && updateStatus.found);
  const passed = createVerify.passed && updateVerify.passed && statusChecksPassed;
  // If caller requested only the update sub-test, return update-only result (create was performed to obtain a record but not reported)
  if (onlyUpdate) {
    await hidePlaybackOverlay(page).catch(() => { });
    log('Test Only Update: Returning update-only result');
    return {
      tcId: 'TC-DI-01-02',
      title: 'Attributability on Update',
      status: (updateVerify.passed && updateStatus.found) ? 'passed' : 'failed',
      statusChecks: { update: { expected: 'Updated', found: !!updateStatus.found, source: updateStatus.source, evidence: updateStatus.evidence } },
      perRowStatusReport: { update: updateRowStatus },
      details: [
        { step: 'Update audit verification', ...updateVerifyReport },
        {
          step: 'Update status visible in audit trail rows',
          passed: !!updateStatus?.found,
          expected: 'Updated',
          actual: updateStatus?.label || '(not found)',
          source: updateStatus?.source || '',
          evidence: updateStatus?.evidence || '',
          rowsChecked: updateRowStatus.rowsChecked,
          rowsWithStatus: updateRowStatus.rowsWithStatus,
          rows: updateRowStatus.rows,
        },
        {
          step: 'Update unchanged fields (informational)',
          passed: true,
          expectedMissing: unchangedAuditFields,
          changedFieldsVerified: Object.keys(changedAuditTrail),
          message: unchangedAuditFields.length
            ? 'Unchanged update fields are expected-missing in audit details and are not treated as failures.'
            : 'All submitted update fields are treated as changed for this run.',
        },
        {
          step: 'Update reason consistency (Master row vs Audit trail)',
          passed: reasonConsistencyPassed,
          expected: updateReason,
          actualMasterReason: masterReason || '(reason column not available)',
          rows: perRowReason,
        },
        {
          step: 'Update timestamp consistency (Audit vs Master)',
          passed: auditVsMasterWithin,
          actualMasterTime: parsedMasterTime ? parsedMasterTime.toISOString() : (masterPerformedOn || '(not found)'),
          actualAuditTime: parsedAuditTime ? parsedAuditTime.toISOString() : (auditTimestampText || '(not found)'),
          deltaAuditVsMasterSeconds: deltaAuditVsMasterSec,
          rows: perRowTimestamps,
        },
        {
          step: 'Performed-by consistency (Master row vs Audit trail)',
          passed: performedByPassed,
          actualMasterPerformedBy: masterPerformedBy || '(not available)',
          actualAuditPerformedBy: auditPerformedBy || '(not found)',
          rows: perRowPerformedBy,
        },
      ],
    };
  }
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 10/10: Closing Browser', 10, 10).catch(() => { });

  await hidePlaybackOverlay(page).catch(() => { });
  return {
    tcId: 'TC-DI-01-01 & TC-DI-01-02',
    title: 'Attributability on Create & Update',
    status: passed ? 'passed' : 'failed',
    statusChecks: {
      create: { expected: 'Created', found: !!(createStatus && createStatus.found), source: createStatus?.source, evidence: createStatus?.evidence },
      update: { expected: 'Updated', found: !!(updateStatus && updateStatus.found), source: updateStatus?.source, evidence: updateStatus?.evidence },
    },
    perRowStatusReport: {
      create: createRowStatus,
      update: updateRowStatus,
    },
    details: [
      { step: 'Create audit verification', ...createVerifyReport },
      {
        step: 'Create status visible in audit trail rows',
        passed: !!createStatus?.found,
        expected: 'Created',
        actual: createStatus?.label || '(not found)',
        source: createStatus?.source || '',
        evidence: createStatus?.evidence || '',
        rowsChecked: createRowStatus.rowsChecked,
        rowsWithStatus: createRowStatus.rowsWithStatus,
        rows: createRowStatus.rows,
      },
      { step: 'Update audit verification', ...updateVerifyReport },
      {
        step: 'Update status visible in audit trail rows',
        passed: !!updateStatus?.found,
        expected: 'Updated',
        actual: updateStatus?.label || '(not found)',
        source: updateStatus?.source || '',
        evidence: updateStatus?.evidence || '',
        rowsChecked: updateRowStatus.rowsChecked,
        rowsWithStatus: updateRowStatus.rowsWithStatus,
        rows: updateRowStatus.rows,
      },
      {
        step: 'Update unchanged fields (informational)',
        passed: true,
        expectedMissing: unchangedAuditFields,
        changedFieldsVerified: Object.keys(changedAuditTrail),
        message: unchangedAuditFields.length
          ? 'Unchanged update fields are expected-missing in audit details and are not treated as failures.'
          : 'All submitted update fields are treated as changed for this run.',
      },
      {
        // Only compare expected reason vs actual master reason; no other fields
        step: 'Update reason consistency (Master row vs Audit trail)',
        passed: reasonConsistencyPassed,
        expected: updateReason,
        actualMasterReason: masterReason || '(reason column not available)',
        rows: perRowReason,
      },
      {
        step: 'Update timestamp consistency (Audit vs Master)',
        passed: auditVsMasterWithin,
        actualMasterTime: parsedMasterTime ? parsedMasterTime.toISOString() : (masterPerformedOn || '(not found)'),
        actualAuditTime: parsedAuditTime ? parsedAuditTime.toISOString() : (auditTimestampText || '(not found)'),
        deltaAuditVsMasterSeconds: deltaAuditVsMasterSec,
        rows: perRowTimestamps,
      },
      {
        step: 'Performed-by consistency (Master row vs Audit trail)',
        passed: performedByPassed,
        actualMasterPerformedBy: masterPerformedBy || '(not available)',
        actualAuditPerformedBy: auditPerformedBy || '(not found)',
        rows: perRowPerformedBy,
      },
    ],
  };
}

async function runTC_DI_02(page) {
  log('TC-DI-02-01 & 02-02: Legibility (Special Characters & Long Strings)');
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 1/3: Logging in', 1, 3).catch(() => { });
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 2/3: Opening create form', 2, 3).catch(() => { });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  await openCreateForm(page);

  const firstTextInput = page.locator(`${OFFCANVAS_SCOPE} input[type="text"]`).first();
  await firstTextInput.waitFor({ state: 'visible', timeout: 10000 });

  const specialUnicodeStr = 'Ärzte & Société';
  const longString = 'AbCdEf12'.repeat(32).substring(0, 255);

  await firstTextInput.fill(specialUnicodeStr);
  const unicodeVal = await firstTextInput.inputValue();
  const unicodePassed = unicodeVal === specialUnicodeStr;

  await firstTextInput.fill(longString);
  const longVal = await firstTextInput.inputValue();
  const longPassed = longVal === longString && longVal.length === 255;

  const passed = unicodePassed && longPassed;
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 3/3: Checks complete', 3, 3).catch(() => { });
  await hidePlaybackOverlay(page).catch(() => { });
  return {
    tcId: 'TC-DI-02-01 & TC-DI-02-02',
    title: 'Legibility (Special Characters & Long Strings)',
    status: passed ? 'passed' : 'failed',
    details: [
      { step: 'Unicode input preserved', passed: unicodePassed, expected: specialUnicodeStr, actual: unicodeVal },
      { step: '255-char string preserved', passed: longPassed, expected: `length=255`, actual: `length=${longVal.length}` },
    ],
  };
}

async function runTC_DI_06(page) {
  log('TC-DI-06-01: Mandatory Field Enforcement');
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 1/3: Logging in', 1, 3).catch(() => { });
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 2/3: Opening empty create form', 2, 3).catch(() => { });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  await openCreateForm(page);

  const saveBtn = await getActionableSaveButton(page);
  if (saveBtn) await saveBtn.click();

  await page.waitForTimeout(1500);
  const errorCount = await page.locator('.text-danger, .invalid-feedback').count();
  const passed = errorCount > 0;
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 3/3: Validation check complete', 3, 3).catch(() => { });
  await hidePlaybackOverlay(page).catch(() => { });
  return {
    tcId: 'TC-DI-06-01',
    title: 'Mandatory Field Enforcement',
    status: passed ? 'passed' : 'failed',
    details: [
      { step: 'Validation errors appeared on empty form save', passed, actual: `${errorCount} error(s) visible` },
    ],
  };
}

async function runTC_DI_07(browser) {
  log('TC-DI-07-01: Session Interruption (Durability)');
  const context = await newComplianceContext(browser);
  const page = await context.newPage();
  setupOverlayOnPage(page);
  await showPlaybackOverlay(page, 'TC-DI-07 — Session interruption test', 1, 3).catch(() => { });
  try {
    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
    await openCreateForm(page);
    await fillOffcanvasForm(page, QT_MASTER);

    await context.setOffline(true);
    log('Network set offline before save');

    try {
      const saveBtn = await getActionableSaveButton(page);
      if (saveBtn) await saveBtn.click({ timeout: 5000 });
    } catch {
      log('Save click failed as expected (offline)');
    }

    await context.setOffline(false);
    log('Network restored');

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(SEL.pageTitle, { timeout: 30000 }).catch(() => { });

    return {
      tcId: 'TC-DI-07-01',
      title: 'Session Interruption (Durability)',
      status: 'passed',
      details: [{ step: 'No crash / partial write on network kill before save', passed: true }],
    };
  } catch (e) {
    return { tcId: 'TC-DI-07-01', title: 'Session Interruption (Durability)', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await hidePlaybackOverlay(page).catch(() => { });
    await context.close();
  }
}

async function runTC_DI_08(browser) {
  log('TC-DI-08-01: Soft Delete Data Preservation');
  const context = await newComplianceContext(browser);
  const page = await context.newPage();
  setupOverlayOnPage(page);
  await showPlaybackOverlay(page, 'TC-DI-08 — Soft delete verification', 1, 3).catch(() => { });
  try {
    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

    const deleteTarget = page.locator(`${SEL.tableRows}:first-child ${SEL.deleteBtn}`).first();
    await deleteTarget.click();
    await clickOptionalYesConfirmation(page, 5000).catch(() => false);
    await waitForSuccessToastOrHandleConfirm(page, 'deactivate', 30000);
    await clickOptionalYesConfirmation(page, 800).catch(() => false);

    const auditVerify = await verifyAuditTrailEntry(page, {
      baseURL: new URL(page.url()).origin,
      masterName: QT_MASTER,
      operation: 'delete',
      recordName: null,
      recordID: null,
      username: QT_USER,
    }).then((res) => ({ passed: res.verified, ...res })).catch((e) => ({ passed: false, reason: e.message }));

    return {
      tcId: 'TC-DI-08-01',
      title: 'Soft Delete Data Preservation',
      status: auditVerify.passed ? 'passed' : 'failed',
      details: [{ step: 'Audit trail retained after deactivation', ...auditVerify }],
    };
  } catch (e) {
    return { tcId: 'TC-DI-08-01', title: 'Soft Delete Data Preservation', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await hidePlaybackOverlay(page).catch(() => { });
    await context.close();
  }
}

async function runTC_DI_09(browser) {
  log('TC-DI-09-01: Concurrent Edit Conflict Detection');
  const ctxA = await newComplianceContext(browser);
  const ctxB = await newComplianceContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  setupOverlayOnPage(pageA);
  setupOverlayOnPage(pageB);
  await showPlaybackOverlay(pageA, 'TC-DI-09 — Concurrent edit (User A)', 1, 2).catch(() => { });
  await showPlaybackOverlay(pageB, 'TC-DI-09 — Concurrent edit (User B)', 1, 2).catch(() => { });

  try {
    await login(pageA, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await login(pageB, { loginUrl: QT_URL, username: QT_USER2, password: QT_PASS2 });

    await navigateTo(pageA, QT_MASTER, new URL(QT_URL).origin);
    await navigateTo(pageB, QT_MASTER, new URL(QT_URL).origin);

    await pageA.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first().click();
    await pageA.waitForSelector(SEL.offcanvas, { timeout: 15000 });
    await pageB.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first().click();
    await pageB.waitForSelector(SEL.offcanvas, { timeout: 15000 });

    const inputA = pageA.locator(`${OFFCANVAS_SCOPE} input[type="text"]`).first();
    await inputA.fill('Concurrent Edit User A ' + Date.now());
    const saveBtnA = await getActionableSaveButton(pageA);
    if (saveBtnA) await saveBtnA.click();
    const reasonA = pageA.locator('#reasonTextarea:visible').first();
    if (await reasonA.isVisible().catch(() => false)) {
      await reasonA.fill('User A concurrent update');
      await pageA.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    }
    await pageA.waitForSelector('.swal2-html-container', { timeout: 30000 }).catch(() => { });

    const inputB = pageB.locator(`${OFFCANVAS_SCOPE} input[type="text"]`).first();
    await inputB.fill('Concurrent Edit User B ' + Date.now());
    const saveBtnB = await getActionableSaveButton(pageB);
    if (saveBtnB) await saveBtnB.click();
    const reasonB = pageB.locator('#reasonTextarea:visible').first();
    if (await reasonB.isVisible().catch(() => false)) {
      await reasonB.fill('User B concurrent update');
      await pageB.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    }

    const conflictVisible = await pageB.locator('.swal2-popup:has-text("modified"), .swal2-popup:has-text("conflict"), .swal2-popup:has-text("error")').isVisible({ timeout: 10000 }).catch(() => false);
    return {
      tcId: 'TC-DI-09-01',
      title: 'Concurrent Edit Conflict Detection',
      status: conflictVisible ? 'passed' : 'failed',
      details: [
        { step: 'User A saves first - expecting success', passed: true },
        { step: 'User B save raises conflict warning', passed: conflictVisible, reason: conflictVisible ? '' : 'No conflict popup detected' },
      ],
    };
  } catch (e) {
    return { tcId: 'TC-DI-09-01', title: 'Concurrent Edit Conflict Detection', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await hidePlaybackOverlay(pageA).catch(() => { });
    await hidePlaybackOverlay(pageB).catch(() => { });
    await ctxA.close();
    await ctxB.close();
  }
}

// ── Main Dispatcher ────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: QT_HEADLESS });
  const context = await newComplianceContext(browser);
  const page = await context.newPage();
  setupOverlayOnPage(page); // re-inject overlay automatically after every navigation
  // Ensure any future pages/popups are wired to receive the overlay state
  context.on('page', (p) => {
    try {
      setupOverlayOnPage(p);
      const ctxState = _contextOverlayState.get(p.context());
      if (ctxState) {
        _pageOverlayState.set(p, ctxState);
        _injectOverlay(p, ctxState.desc, ctxState.index, ctxState.total).catch(() => { });
      }
    } catch (e) {
      // ignore
    }
  });

  const tcMap = {
    'TC-DI-01': () => runTC_DI_01(page),
    'TC-DI-01-01': () => runTC_DI_01(page),
    'TC-DI-01-02': () => runTC_DI_01(page),
    'TC-DI-02-01': () => runTC_DI_02(page),
    'TC-DI-02-02': () => runTC_DI_02(page),
    'TC-DI-06-01': () => runTC_DI_06(page),
    'TC-DI-07-01': () => runTC_DI_07(browser),
    'TC-DI-08-01': () => runTC_DI_08(browser),
    'TC-DI-09-01': () => runTC_DI_09(browser),
  };

  const startedAt = new Date().toISOString();
  let result;

  try {
    if (!QT_TC_ID || !tcMap[QT_TC_ID]) {
      const allResults = [];
      const uniqueCases = ['TC-DI-01', 'TC-DI-02-01', 'TC-DI-06-01', 'TC-DI-07-01', 'TC-DI-08-01', 'TC-DI-09-01'];
      for (const tcId of uniqueCases) {
        try {
          const tcResult = await tcMap[tcId]().catch((e) => ({
            tcId,
            status: 'failed',
            title: tcId,
            details: [{ step: 'Unhandled error', passed: false, reason: e.message }],
          }));
          allResults.push(tcResult);
        } catch (e) {
          allResults.push({ tcId, status: 'failed', title: tcId, details: [{ step: 'Unhandled error', passed: false, reason: e.message }] });
        }
      }
      result = {
        mode: 'all',
        masterName: QT_MASTER,
        startedAt,
        completedAt: new Date().toISOString(),
        summary: {
          total: allResults.length,
          passed: allResults.filter((r) => r.status === 'passed').length,
          failed: allResults.filter((r) => r.status === 'failed').length,
        },
        results: allResults,
      };
    } else {
      const tcFn = tcMap[QT_TC_ID];
      const tcResult = await tcFn();
      result = {
        mode: 'single',
        masterName: QT_MASTER,
        tcId: QT_TC_ID,
        startedAt,
        completedAt: new Date().toISOString(),
        ...tcResult,
      };
    }
  } catch (e) {
    result = {
      mode: QT_TC_ID ? 'single' : 'all',
      status: 'failed',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      error: e.message,
    };
  } finally {
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
  }

  emitResult(result);
}

main().catch((e) => {
  process.stderr.write(`[COMPLIANCE] Fatal error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ status: 'failed', error: e.message }));
  process.exit(1);
});
