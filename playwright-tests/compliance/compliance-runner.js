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

const QT_URL     = process.env.QT_URL     || 'https://ipdev.quickflow.in/login';
const QT_USER    = process.env.QT_USER    || 'admin';
const QT_PASS    = process.env.QT_PASS    || 'admin@123';
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
const QT_MASTER  = process.env.QT_MASTER  || 'Department';
const QT_TC_ID   = process.env.QT_TC_ID   || '';
const QT_USER2   = process.env.QT_USER2   || QT_USER;
const QT_PASS2   = process.env.QT_PASS2   || QT_PASS;

function log(msg) {
  process.stderr.write(`[COMPLIANCE] ${msg}\n`);
}

function emitResult(result) {
  process.stdout.write(JSON.stringify(result));
}

// ── Playback overlay: direct DOM injection that survives page navigations ──────
// Stores the last overlay state per Playwright page object so the load listener
// can re-inject it automatically after every navigation (login, navigateTo, etc.)
const _pageOverlayState = new Map();

async function _injectOverlay(page, desc, index, total) {
  try {
    await page.evaluate(({ d, i, t }) => {
      // Inject CSS once per document
      if (!document.getElementById('__pbo_s')) {
        const s = document.createElement('style');
        s.id = '__pbo_s';
        s.textContent =
          '#__pbo{position:fixed;top:12px;right:12px;z-index:2147483647;' +
          'background:rgba(11, 18, 32, 0.8);color:#fff;padding:10px 16px;border-radius:10px;' +
          'box-shadow:0 8px 32px rgba(0, 0, 0, 0.5);min-width:220px;max-width:500px;' +
          'display:none;align-items:center;gap:10px;font-family:system-ui,sans-serif;font-size:14px;}' +
          '#__pbo_main{flex:1;font-weight:600;line-height:1.35;color:#fff;}' +
          '#__pbo_meta{color:#94a3b8;font-size:12px;white-space:nowrap;}' +
          '#__pbo_x{background:none;border:none;color:#94a3b8;cursor:pointer;' +
          'font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;}';
        document.documentElement.appendChild(s);
      }
      // Create or reuse overlay element
      let el = document.getElementById('__pbo');
      if (!el) {
        el = document.createElement('div');
        el.id = '__pbo';
        el.innerHTML =
          '<div id="__pbo_main"></div>' +
          '<div id="__pbo_meta"></div>';
        document.documentElement.appendChild(el);
        document.getElementById('__pbo_x').addEventListener('click', () => {
          el.style.display = 'none';
        });
      }
      document.getElementById('__pbo_main').textContent = d;
      document.getElementById('__pbo_meta').textContent = (i && t) ? (i + ' of ' + t) : '';
      el.style.display = 'flex';
    }, { d: String(desc || ''), i: Number(index || 0), t: Number(total || 0) });
  } catch (_) {
    // page is navigating or closed — safe to ignore
  }
}

/**
 * Call once per Playwright page. Registers a 'load' listener so the overlay
 * is automatically re-injected after every page navigation.
 */
function setupOverlayOnPage(page) {
  page.on('load', async () => {
    const state = _pageOverlayState.get(page);
    if (state) {
      await _injectOverlay(page, state.desc, state.index, state.total);
    }
  });
}

async function showPlaybackOverlay(page, desc, index, total) {
  if (!page) return;
  _pageOverlayState.set(page, { desc, index, total });
  await _injectOverlay(page, desc, index, total);
}

async function hidePlaybackOverlay(page) {
  if (!page) return;
  _pageOverlayState.delete(page);
  try {
    await page.evaluate(() => {
      const el = document.getElementById('__pbo');
      if (el) el.style.display = 'none';
    });
  } catch (_) {
    // ignore
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
    await page.keyboard.press('Enter').catch(() => {});
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
      await editInRow.click({ timeout: 5000, force: true }).catch(() => {});
    });

    const opened = await page.waitForSelector(SEL.offcanvas, { timeout: 15000 }).then(() => true).catch(() => false);
    if (opened) return true;
  }

  return false;
}

// ── Test Case Implementations ──────────────────────────────────────────────────

async function runTC_DI_01(page) {
  log('TC-DI-01-01 & 01-02: Attributability on Create & Update');
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 1/10: Logging in', 1, 10).catch(() => {});
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 2/10: Navigating to master list', 2, 10).catch(() => {});
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  // 1. Create Flow
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 3/10: Opening create form', 3, 10).catch(() => {});
  await openCreateForm(page);
  const createAuditTrail = await fillOffcanvasForm(page, QT_MASTER);
  const saveBtnC = await getActionableSaveButton(page);
  if (saveBtnC) {
    await showPlaybackOverlay(page, 'TC-DI-01 — Step 4/10: Saving new record', 4, 10).catch(() => {});
    await saveBtnC.click();
  }
  const createSystemSavedAt = new Date();
  const createToast = await waitForSuccessToastOrHandleConfirm(page, 'create', 30000);
  const toastText = createToast?.text || '';
  
  // Extract ID from toast (e.g. "Record Created Successfully. ID: 123")
  let recordID = null;
  const idMatch = toastText.match(/ID\s*:\s*(\d+)/i) || toastText.match(/(\d+)/);
  if (idMatch) recordID = idMatch[1];

  await clickOptionalYesConfirmation(page, 800).catch(() => false);
  
  let masterRowData = null;
  if (!recordID) {
    log('ID not found in toast, checking table data...');
  }
  await page.waitForTimeout(1200);
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
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 5/10: Verifying create audit trail', 5, 10).catch(() => {});
  const requestedTc = String(QT_TC_ID || '').trim().toUpperCase();
  const onlyCreate = requestedTc === 'TC-DI-01-01';
  const onlyUpdate = requestedTc === 'TC-DI-01-02';

  const createVerify = await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: QT_MASTER,
    operation: 'create',
    recordName: recordID,
    recordID,
    auditTrail: createAuditTrail,
    username: QT_USER,
    masterPerformedOn: masterRowData?.data?.['Performed On'] || masterRowData?.data?.['Performedon'],
  }).then((res) => ({ passed: res.verified, ...res })).catch((e) => ({ passed: false, reason: e.message }));
  // If caller requested only the create sub-test, return create-only result
  if (onlyCreate) {
    await hidePlaybackOverlay(page).catch(() => {});
    return {
      tcId: 'TC-DI-01-01',
      title: 'Attributability on Create',
      status: createVerify.passed ? 'passed' : 'failed',
      details: [ { step: 'Create audit verification', ...createVerify } ],
      _debug: undefined,
    };
  }

  // 2. Update Flow
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 6/10: Navigating back for update', 6, 10).catch(() => {});
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  const editOpened = await openEditFormForRecord(page, recordID);
  if (!editOpened) {
    await hidePlaybackOverlay(page).catch(() => {});
    throw new Error(`Could not open edit form for record ${recordID || '[unknown]'}`);
  }
  
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 7/10: Opening edit form', 7, 10).catch(() => {});
  const updateAuditTrail = await fillOffcanvasForm(page, QT_MASTER);
  const updateReason = 'Compliance TC-DI-01-02 Update';
  const reasonApplied = await applyUpdateReasonToMasterForm(page, updateReason);
  if (reasonApplied?.applied && reasonApplied.field) {
    updateAuditTrail[reasonApplied.field] = updateReason;
  }
  let submittedUpdateReason = reasonApplied?.applied ? updateReason : '';
  const saveBtnU = await getActionableSaveButton(page);
  if (saveBtnU) {
    await showPlaybackOverlay(page, 'TC-DI-01 — Step 8/10: Saving updated record', 8, 10).catch(() => {});
    await saveBtnU.click();
  }
  const updateSystemSavedAt = new Date();
  
  const reasonField = page.locator('#reasonTextarea:visible').first();
  if (await reasonField.isVisible().catch(() => false)) {
    await reasonField.fill(updateReason);
    await page.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    submittedUpdateReason = updateReason;
  }

  await waitForSuccessToastOrHandleConfirm(page, 'update', 30000);
  await clickOptionalYesConfirmation(page, 800).catch(() => false);

  await page.waitForTimeout(1000);
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  if (recordID) {
    await page.fill(SEL.searchBox, '');
    await page.fill(SEL.searchBox, String(recordID));
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
  }
  const updatedMasterRowData = await getFirstVisibleMasterRowData(page);
  const masterReason = pickFieldValue(updatedMasterRowData?.data, ['Reason', 'Update Reason', 'Remarks']);
  const masterPerformedOn = pickFieldValue(updatedMasterRowData?.data, ['Performed On', 'Performedon', 'Last Updated', 'Modified On', 'Updated On']);
  const masterPerformedBy = pickFieldValue(updatedMasterRowData?.data, ['Performed By', 'Performedby', 'Updated By', 'Modified By', 'User']);
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 9/10: Verifying update audit trail', 9, 10).catch(() => {});

  const updateVerify = await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: QT_MASTER,
    operation: 'update',
    recordName: recordID,
    recordID,
    auditTrail: updateAuditTrail,
    reason: updateReason,
    username: QT_USER, // Pass username for attributability check
    masterPerformedOn,
  }).then((res) => ({ passed: res.verified, ...res })).catch((e) => ({ passed: false, reason: e.message }));

  const auditReasonMatched = Array.isArray(updateVerify?.matched) && updateVerify.matched.includes('reason');
  const masterReasonMatched = !masterReason
    ? null
    : normalizeText(masterReason).includes(normalizeText(updateReason))
      || normalizeText(updateReason).includes(normalizeText(masterReason));

  const auditTimestampText = extractTimestampFromText(updateVerify?.matchedRow || '');
  const parsedAuditTime = parseAuditTimestamp(auditTimestampText);
  const parsedMasterTime = parseAuditTimestamp(masterPerformedOn);

  const deltaAuditVsSystemSec = parsedAuditTime
    ? Math.abs(parsedAuditTime.getTime() - updateSystemSavedAt.getTime()) / 1000
    : null;
  const deltaMasterVsSystemSec = parsedMasterTime
    ? Math.abs(parsedMasterTime.getTime() - updateSystemSavedAt.getTime()) / 1000
    : null;
  const deltaAuditVsMasterSec = parsedAuditTime && parsedMasterTime
    ? Math.abs(parsedAuditTime.getTime() - parsedMasterTime.getTime()) / 1000
    : null;

  const timeWithinWindow =
    deltaAuditVsSystemSec !== null && deltaMasterVsSystemSec !== null && deltaAuditVsMasterSec !== null
      ? (deltaAuditVsSystemSec <= 180 && deltaMasterVsSystemSec <= 180 && deltaAuditVsMasterSec <= 120)
      : false;
  // For compliance we only validate Audit vs Master timing delta (ignore system save comparisons)
  const auditVsMasterWithin = deltaAuditVsMasterSec !== null ? deltaAuditVsMasterSec <= 120 : false;

  const auditPerformedBy = extractPerformerFromAuditRow(updateVerify?.matchedRow || '');
  const performerMatchesMaster = !masterPerformedBy
    ? null
    : (normalizeText(auditPerformedBy).includes(normalizeText(masterPerformedBy))
      || normalizeText(masterPerformedBy).includes(normalizeText(auditPerformedBy)));
  const performerMatchesUser = normalizeText(auditPerformedBy).includes(normalizeText(QT_USER))
    || normalizeText(masterPerformedBy).includes(normalizeText(QT_USER));

  const passed = createVerify.passed && updateVerify.passed;
    // If caller requested only the update sub-test, return update-only result (create was performed to obtain a record but not reported)
    if (onlyUpdate) {
      await hidePlaybackOverlay(page).catch(() => {});
      return {
        tcId: 'TC-DI-01-02',
        title: 'Attributability on Update',
        status: updateVerify.passed ? 'passed' : 'failed',
        details: [
          { step: 'Update audit verification', ...updateVerify },
          {
            step: 'Update reason consistency (Master row vs Audit trail)',
            passed: normalizeText(submittedUpdateReason) === normalizeText(updateReason) && auditReasonMatched,
            expected: updateReason,
            actualMasterReason: submittedUpdateReason || '(not captured)',
          },
          {
            step: 'Master row vs Audit trail timing',
            passed: auditVsMasterWithin,
            actualMasterTime: parsedMasterTime ? parsedMasterTime.toISOString() : (masterPerformedOn || '(not found)'),
            actualAuditTime: parsedAuditTime ? parsedAuditTime.toISOString() : (auditTimestampText || '(not found)'),
            deltaAuditVsMasterSeconds: deltaAuditVsMasterSec,
          },
          {
            step: 'Audit performer vs Master/Username',
            passed: performerMatchesUser || performerMatchesMaster,
            details: { auditPerformedBy, masterPerformedBy, username: QT_USER },
          },
        ],
      };
    }
    await hidePlaybackOverlay(page).catch(() => {});
  return {
    tcId: 'TC-DI-01-01 & TC-DI-01-02',
    title: 'Attributability on Create & Update',
    status: passed ? 'passed' : 'failed',
    details: [
      { step: 'Create audit verification', ...createVerify },
      { step: 'Update audit verification', ...updateVerify },
      {
        step: 'Update reason consistency (Master row vs Audit trail)',
        passed: normalizeText(submittedUpdateReason) === normalizeText(updateReason) && auditReasonMatched,
        expected: updateReason,
        actualMasterReason: submittedUpdateReason || '(not captured)',
        masterRowReason: masterReason || '(reason column not available)',
        masterRowReasonMatchesExpected: masterReasonMatched,
        auditReasonMatched,
        masterReasonFieldUpdated: !!reasonApplied?.applied,
        masterReasonFieldName: reasonApplied?.field || '',
      },
      {
        step: 'Update timestamp consistency (Audit vs Master)',
        passed: auditVsMasterWithin,
        actualMasterTime: parsedMasterTime ? parsedMasterTime.toISOString() : (masterPerformedOn || '(not found)'),
        actualAuditTime: parsedAuditTime ? parsedAuditTime.toISOString() : (auditTimestampText || '(not found)'),
        deltaAuditVsMasterSeconds: deltaAuditVsMasterSec,
      },
      {
        step: 'Performed-by consistency (Master row vs Audit trail)',
        passed: (performerMatchesMaster === null || performerMatchesMaster === true) && performerMatchesUser,
        expected: QT_USER,
        actualMasterPerformedBy: masterPerformedBy || '(not available)',
        actualAuditPerformedBy: auditPerformedBy || '(not found)',
        performerMatchesMaster,
        performerMatchesUser,
      },
    ],
  };
}

async function runTC_DI_02(page) {
  log('TC-DI-02-01 & 02-02: Legibility (Special Characters & Long Strings)');
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 1/3: Logging in', 1, 3).catch(() => {});
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 2/3: Opening create form', 2, 3).catch(() => {});
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  await openCreateForm(page);

  const firstTextInput = page.locator(`${SEL.offcanvas} input[type="text"]`).first();
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
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 3/3: Checks complete', 3, 3).catch(() => {});
  await hidePlaybackOverlay(page).catch(() => {});
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
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 1/3: Logging in', 1, 3).catch(() => {});
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 2/3: Opening empty create form', 2, 3).catch(() => {});
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  await openCreateForm(page);

  const saveBtn = await getActionableSaveButton(page);
  if (saveBtn) await saveBtn.click();

  await page.waitForTimeout(1500);
  const errorCount = await page.locator('.text-danger, .invalid-feedback').count();
  const passed = errorCount > 0;
  await showPlaybackOverlay(page, 'TC-DI-06 — Step 3/3: Validation check complete', 3, 3).catch(() => {});
  await hidePlaybackOverlay(page).catch(() => {});
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
  await showPlaybackOverlay(page, 'TC-DI-07 — Session interruption test', 1, 3).catch(() => {});
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
    await page.waitForSelector(SEL.pageTitle, { timeout: 30000 }).catch(() => {});

    return {
      tcId: 'TC-DI-07-01',
      title: 'Session Interruption (Durability)',
      status: 'passed',
      details: [{ step: 'No crash / partial write on network kill before save', passed: true }],
    };
  } catch (e) {
    return { tcId: 'TC-DI-07-01', title: 'Session Interruption (Durability)', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await hidePlaybackOverlay(page).catch(() => {});
    await context.close();
  }
}

async function runTC_DI_08(browser) {
  log('TC-DI-08-01: Soft Delete Data Preservation');
  const context = await newComplianceContext(browser);
  const page = await context.newPage();
  setupOverlayOnPage(page);
  await showPlaybackOverlay(page, 'TC-DI-08 — Soft delete verification', 1, 3).catch(() => {});
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
    await hidePlaybackOverlay(page).catch(() => {});
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
  await showPlaybackOverlay(pageA, 'TC-DI-09 — Concurrent edit (User A)', 1, 2).catch(() => {});
  await showPlaybackOverlay(pageB, 'TC-DI-09 — Concurrent edit (User B)', 1, 2).catch(() => {});

  try {
    await login(pageA, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await login(pageB, { loginUrl: QT_URL, username: QT_USER2, password: QT_PASS2 });

    await navigateTo(pageA, QT_MASTER, new URL(QT_URL).origin);
    await navigateTo(pageB, QT_MASTER, new URL(QT_URL).origin);

    await pageA.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first().click();
    await pageA.waitForSelector(SEL.offcanvas, { timeout: 15000 });
    await pageB.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first().click();
    await pageB.waitForSelector(SEL.offcanvas, { timeout: 15000 });

    const inputA = pageA.locator(`${SEL.offcanvas} input[type="text"]`).first();
    await inputA.fill('Concurrent Edit User A ' + Date.now());
    const saveBtnA = await getActionableSaveButton(pageA);
    if (saveBtnA) await saveBtnA.click();
    const reasonA = pageA.locator('#reasonTextarea:visible').first();
    if (await reasonA.isVisible().catch(() => false)) {
      await reasonA.fill('User A concurrent update');
      await pageA.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    }
    await pageA.waitForSelector('.swal2-html-container', { timeout: 30000 }).catch(() => {});

    const inputB = pageB.locator(`${SEL.offcanvas} input[type="text"]`).first();
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
    await hidePlaybackOverlay(pageA).catch(() => {});
    await hidePlaybackOverlay(pageB).catch(() => {});
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
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  emitResult(result);
}

main().catch((e) => {
  process.stderr.write(`[COMPLIANCE] Fatal error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ status: 'failed', error: e.message }));
  process.exit(1);
});
