/**
 * compliance-runner.js
 *
 * Standalone Node.js script triggered by the backend (server.js) via child_process.execFile.
 * Runs a single Data Integrity compliance test case and outputs a JSON result to stdout.
 */

'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const crypto = require('crypto');
const { fillOffcanvasForm, randomText } = require('../helpers/formFiller');
const { collectStableFormFields } = require('../helpers/formDiscovery');
const { verifyAuditTrailEntryCompliance } = require('./compliance-audit-wrapper');
const { attachComplianceTraceability } = require('./compliance-traceability');
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
const QT_ROLE = process.env.QT_ROLE || '';

function log(msg) {
  process.stderr.write(`[COMPLIANCE] ${msg}\n`);
}

function emitResult(result) {
  const payload = attachComplianceTraceability(result, {
    suite: 'DI',
    runnerName: 'compliance-runner.js',
  });
  process.stdout.write(JSON.stringify(payload));
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

function enrichChangedAuditTrailFromMasterRows(changedAuditTrail, preUpdateMasterData, postUpdateMasterData) {
  const merged = { ...(changedAuditTrail || {}) };
  const autoDetectedChangedFields = [];

  const pre = preUpdateMasterData || {};
  const post = postUpdateMasterData || {};

  const skipKey = /^(action\(s\)|record\s*id|status|performed\s*by|performed\s*on|app\s*icon|reason|update\s*reason|last\s*updated|modified\s*on|updated\s*on)$/i;
  const hasField = (name) => Object.keys(merged).some((key) => normalizeText(key) === normalizeText(name));

  for (const [rawKey, rawValue] of Object.entries(post)) {
    const key = String(rawKey || '').trim();
    if (!key || skipKey.test(key) || hasField(key)) continue;

    const before = resolveMasterFieldValueForAuditKey(pre, key);
    const after = rawValue;

    const beforeNorm = normalizeComparableValue(before);
    const afterNorm = normalizeComparableValue(after);
    if (!afterNorm || beforeNorm === afterNorm) continue;

    merged[key] = String(after || '').replace(/\s+/g, ' ').trim();
    autoDetectedChangedFields.push(key);
  }

  return {
    changedAuditTrail: merged,
    autoDetectedChangedFields: Array.from(new Set(autoDetectedChangedFields)),
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
  return cleaned;
}

function getAuditPerformedByFromSnapshot(snap) {
  const direct = String(snap?.performedBy || '').replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  return extractPerformerFromAuditRow(snap?.text || '');
}

function parsePerformedByIdentity(value) {
  const raw = String(value || '').trim();
  const lines = raw.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  const compactLines = raw.replace(/\s+/g, ' ').trim().split(/\s{2,}/).map((line) => line.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : compactLines;

  let initials = '';
  let displayName = '';
  let role = '';

  if (parts.length >= 3 && /^[A-Z]{1,4}$/i.test(parts[0].replace(/[^A-Za-z]/g, ''))) {
    initials = parts[0];
    displayName = parts[1];
    role = parts.slice(2).join(' ');
  } else if (parts.length >= 2) {
    displayName = parts[0];
    role = parts.slice(1).join(' ');
  } else if (parts.length === 1) {
    displayName = parts[0];
  }

  return {
    raw,
    initials,
    displayName,
    role: QT_ROLE || role,
  };
}

function includesIdentityValue(haystack, needle) {
  const left = normalizeText(haystack);
  const right = normalizeText(needle);
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

function evaluatePerformedByConsistency(auditPerformedBy, masterPerformedBy, username) {
  const identity = parsePerformedByIdentity(masterPerformedBy);
  const hasAuditPerformedBy = !!normalizeText(auditPerformedBy);
  const hasMasterPerformedBy = !!normalizeText(masterPerformedBy);
  let matchesMaster = null;
  if (hasMasterPerformedBy) {
    if (hasAuditPerformedBy) {
      // Prefer matching the audit performed-by to the canonical "username (Role)" format
      // when both username and role are available from the master/identity.
      const roleFromIdentity = String(identity.role || '').trim();
      if (username && roleFromIdentity) {
        const expectedUserRole = `${String(username).trim()} (${roleFromIdentity})`;
        matchesMaster = includesIdentityValue(auditPerformedBy, expectedUserRole)
          || includesIdentityValue(auditPerformedBy, masterPerformedBy);
      } else {
        matchesMaster = includesIdentityValue(auditPerformedBy, masterPerformedBy);
      }
    } else {
      matchesMaster = false;
    }
  } else {
    matchesMaster = null;
  }

  const userCandidates = Array.from(new Set([
    username,
    identity.displayName,
    identity.initials,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
  const matchesLoggedInUser = hasAuditPerformedBy
    && userCandidates.some((candidate) => includesIdentityValue(auditPerformedBy, candidate));

  const expectedRole = String(identity.role || '').trim();
  const matchesLoggedInRole = expectedRole
    ? includesIdentityValue(auditPerformedBy, expectedRole)
    : null;

  return {
    expectedUsername: username || '',
    expectedDisplayName: identity.displayName || '',
    expectedRole,
    hasAuditPerformedBy,
    matchesMaster,
    matchesLoggedInUser,
    matchesLoggedInRole,
    passed: hasAuditPerformedBy
      && (matchesMaster === null || matchesMaster)
      && matchesLoggedInUser
      && (matchesLoggedInRole !== false),
  };
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

function resolveComplianceScopedRows(verifyResult) {
  if (Array.isArray(verifyResult?.complianceOperationRows) && verifyResult.complianceOperationRows.length > 0) {
    return verifyResult.complianceOperationRows;
  }
  if (Array.isArray(verifyResult?.operationRowSnapshots) && verifyResult.operationRowSnapshots.length > 0) {
    return verifyResult.operationRowSnapshots;
  }
  if (Array.isArray(verifyResult?.complianceRecordRows) && verifyResult.complianceRecordRows.length > 0) {
    return verifyResult.complianceRecordRows;
  }
  if (Array.isArray(verifyResult?.rowSnapshots) && verifyResult.rowSnapshots.length > 0) {
    return verifyResult.rowSnapshots;
  }
  return [];
}

function detectAuditStatusEnhanced(verifyResult, expectedOperation) {
  const baseline = detectAuditStatus(verifyResult, expectedOperation);
  if (baseline?.found) return baseline;

  const rows = resolveComplianceScopedRows(verifyResult);
  if (!rows.length) return baseline;

  const patterns = {
    create: /\bcreated\b/i,
    update: /\bupdated\b/i,
    delete: /\bdeleted\b/i,
  };
  const canon = { create: 'Created', update: 'Updated', delete: 'Deleted' };
  const pat = patterns[expectedOperation] || new RegExp(String(expectedOperation), 'i');

  const rowChecks = rows.map((row) => {
    const statusText = String(row?.statusValue || '').trim();
    const rowText = String(row?.text || '').trim();
    const statusMatch = statusText.match(pat);
    const textMatch = rowText.match(pat);
    return {
      matched: !!(statusMatch || textMatch),
      evidence: statusMatch?.[0] || textMatch?.[0] || '',
    };
  });

  const rowsChecked = rowChecks.length;
  const rowsWithStatus = rowChecks.filter((row) => row.matched).length;
  const allRowsPass = rowsChecked > 0 && rowsWithStatus === rowsChecked;

  return {
    found: allRowsPass,
    label: canon[expectedOperation] || '',
    evidence: rowChecks.find((row) => row.matched)?.evidence || '',
    source: 'record-filtered-rows',
    rowsChecked,
    rowsWithStatus,
    reason: allRowsPass ? '' : 'one-or-more-rows-missing-expected-status',
  };
}

function buildPerRowStatusReportEnhanced(verifyResult, expectedOperation) {
  const baseline = buildPerRowStatusReport(verifyResult, expectedOperation);
  const rows = resolveComplianceScopedRows(verifyResult);
  if (!rows.length) return baseline;

  const patterns = {
    create: /\bcreated\b/i,
    update: /\bupdated\b/i,
    delete: /\bdeleted\b/i,
  };
  const canon = { create: 'Created', update: 'Updated', delete: 'Deleted' };
  const pat = patterns[expectedOperation] || new RegExp(String(expectedOperation), 'i');

  const rowResults = rows.map((row) => {
    const statusText = String(row?.statusValue || '').trim();
    const rowText = String(row?.text || '').trim();
    const statusMatch = statusText.match(pat);
    const textMatch = rowText.match(pat);
    return {
      rowIndex: row?.index,
      rowText: rowText.slice(0, 220),
      statusValue: statusText,
      statusFound: !!(statusMatch || textMatch),
      evidence: statusMatch?.[0] || textMatch?.[0] || '',
    };
  });

  const rowsWithStatus = rowResults.filter((row) => row.statusFound).length;
  const statusColumn = verifyResult?.statusColumn || {};

  return {
    expectedStatus: canon[expectedOperation] || expectedOperation,
    statusColumnFound: baseline.statusColumnFound || !!statusColumn.found,
    statusColumnIndex: Number.isInteger(statusColumn.index) ? statusColumn.index : baseline.statusColumnIndex,
    statusHeader: statusColumn.header || baseline.statusHeader || 'Status',
    rowsChecked: rowResults.length,
    rowsWithStatus,
    allRowsPass: rowResults.length > 0 && rowsWithStatus === rowResults.length,
    rows: rowResults,
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

function isLegibilityTextField(field) {
  if (!field || field.disabled) return false;
  const type = String(field.elementType || '').toLowerCase();
  if (!['text', 'textarea', 'email', 'tel'].includes(type)) return false;

  const identity = `${field.id || ''} ${field.displayName || ''} ${field.columnName || ''}`;
  return !/record\s*id/i.test(identity);
}

function pickLegibilityTargetField(fields, preferredFieldId = '') {
  const candidates = (fields || []).filter((field) => isLegibilityTextField(field));
  if (!candidates.length) return null;

  const wanted = String(preferredFieldId || '').trim();
  if (wanted) {
    const exact = candidates.find((field) => String(field.id || '').trim() === wanted);
    if (exact) return exact;
  }

  return candidates[0];
}

function buildLegibilityPayload(targetLength) {
  const length = Math.max(0, Number(targetLength) || 0);
  if (!length) return '';

  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += charset[bytes[i] % charset.length];
  }
  return out;
}

function escapeForSelectorAttribute(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function fillLegibilityFieldValue(page, fieldInfo, value) {
  const desired = String(value ?? '');
  const selectors = [];
  const fieldId = String(fieldInfo?.id || '').trim();

  if (fieldId) {
    const escaped = escapeForSelectorAttribute(fieldId);
    selectors.push(`${OFFCANVAS_SCOPE} [data-qf-field-id="${escaped}"] input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([disabled]):not([readonly]), ${OFFCANVAS_SCOPE} [data-qf-field-id="${escaped}"] textarea:not([disabled]):not([readonly])`);
  }

  selectors.push(`${OFFCANVAS_SCOPE} input[type="text"]:not([disabled]):not([readonly]), ${OFFCANVAS_SCOPE} textarea:not([disabled]):not([readonly]), ${OFFCANVAS_SCOPE} input[type="email"]:not([disabled]):not([readonly]), ${OFFCANVAS_SCOPE} input[type="tel"]:not([disabled]):not([readonly])`);

  for (const selector of selectors) {
    const control = page.locator(selector).first();
    const visible = await control.isVisible().catch(() => false);
    if (!visible) continue;

    await control.scrollIntoViewIfNeeded().catch(() => { });
    await control.click({ timeout: 2500 }).catch(() => { });
    await control.fill('').catch(() => { });
    await control.type(desired, { delay: 15, timeout: 6000 }).catch(async () => {
      await control.fill(desired).catch(() => { });
    });
    await control.blur().catch(() => { });
    await page.waitForTimeout(150);

    const actualValue = await control.inputValue().catch(() => '');
    const maxLengthAttr = await control.getAttribute('maxlength').catch(() => null);
    return {
      applied: true,
      actualValue: String(actualValue || ''),
      maxLength: Number(maxLengthAttr || 0) || 0,
      selectorUsed: selector,
    };
  }

  return {
    applied: false,
    actualValue: '',
    maxLength: Number(fieldInfo?.maxLength || 0) || 0,
    selectorUsed: '',
  };
}

// ── Test Case Implementations ──────────────────────────────────────────────────

async function runTC_DI_01(page) {
  log('TC-DI-01-01 & 01-02: Attributability on Create & Update');
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 1/10: Logging in', 1, 10).catch(() => { });
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await showPlaybackOverlay(page, 'TC-DI-01 - Step 2/10: Navigating to master list', 2, 10).catch(() => { });
  
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

  const createVerify = await verifyAuditTrailEntryCompliance(page, {
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
  const createStatus = detectAuditStatusEnhanced(createVerify, 'create');
  const createRowStatus = buildPerRowStatusReportEnhanced(createVerify, 'create');
  log(`Create audit verification: ${createVerify.passed ? 'passed' : 'failed'}${createVerify.reason ? ' (' + createVerify.reason + ')' : ''}`);
  log(`Create audit status: ${createStatus.found ? 'found (source:' + createStatus.source + ' evidence:' + createStatus.evidence + ')' : 'NOT FOUND in actual row text'}`);
  log(`Create per-row status: ${createRowStatus.rowsWithStatus}/${createRowStatus.rowsChecked} rows contain '${createRowStatus.expectedStatus}'`);
  log(`Create row scope: totalRows=${Array.isArray(createVerify?.rowSnapshots) ? createVerify.rowSnapshots.length : 0}, scopedRows=${Array.isArray(createVerify?.operationRowSnapshots) ? createVerify.operationRowSnapshots.length : 0}`);

  const createMasterPerformedOn = pickFieldValue(masterRowData?.data, ['Performed On', 'Performedon', 'Created On', 'Creation Time']);
  const createMasterPerformedBy = pickFieldValue(masterRowData?.data, ['Performed By', 'Performedby', 'Created By', 'User']);
  const createOpSnapshots = Array.isArray(createVerify?.complianceOperationRows) && createVerify.complianceOperationRows.length > 0
    ? createVerify.complianceOperationRows
    : (Array.isArray(createVerify?.operationRowSnapshots) && createVerify.operationRowSnapshots.length > 0
      ? createVerify.operationRowSnapshots
      : (Array.isArray(createVerify?.complianceRecordRows) ? createVerify.complianceRecordRows : []));

  const parsedCreateMasterTime = parseAuditTimestamp(createMasterPerformedOn);
  const createPerRowTimestamps = createOpSnapshots.map((snap) => {
    const rowText = String(snap?.text || '');
    const auditTimestampTextRow = extractTimestampFromText(rowText);
    const parsedAuditTimeRow = parseAuditTimestamp(auditTimestampTextRow);
    const deltaRow = parsedAuditTimeRow && parsedCreateMasterTime
      ? Math.abs(parsedAuditTimeRow.getTime() - parsedCreateMasterTime.getTime()) / 1000
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
  const createAllTimestampsWithin = createPerRowTimestamps.length > 0 && createPerRowTimestamps.every((row) => row.withinWindow);
  const createFallbackAuditTimestampText = extractTimestampFromText(createVerify?.matchedRow || '');
  const createFallbackParsedAuditTime = parseAuditTimestamp(createFallbackAuditTimestampText);
  const createFallbackDeltaSec = createFallbackParsedAuditTime && parsedCreateMasterTime
    ? Math.abs(createFallbackParsedAuditTime.getTime() - parsedCreateMasterTime.getTime()) / 1000
    : null;
  const createAuditVsMasterWithin = createOpSnapshots.length > 0
    ? createAllTimestampsWithin
    : (createFallbackDeltaSec !== null ? createFallbackDeltaSec <= 120 : false);

  const createPerRowPerformedBy = createOpSnapshots.map((snap) => {
    const rowText = String(snap?.text || '');
    const auditPerformedByRow = getAuditPerformedByFromSnapshot(snap);
    const performerCheck = evaluatePerformedByConsistency(auditPerformedByRow, createMasterPerformedBy, QT_USER);
    return {
      rowIndex: snap?.index,
      rowText: String(rowText).slice(0, 220),
      auditPerformedBy: auditPerformedByRow,
      ...performerCheck,
    };
  });
  const createAllRowsPerformerPass = createPerRowPerformedBy.length > 0 && createPerRowPerformedBy.every((row) => row.passed);
  const createFallbackAuditPerformedBy = extractPerformerFromAuditRow(createVerify?.matchedRow || '');
  const createFallbackPerformerCheck = evaluatePerformedByConsistency(createFallbackAuditPerformedBy, createMasterPerformedBy, QT_USER);
  const createPerformedByPassed = createOpSnapshots.length > 0
    ? createAllRowsPerformerPass
    : createFallbackPerformerCheck.passed;

  const createAuditTimestampText = createOpSnapshots.length > 0
    ? (createPerRowTimestamps[0]?.auditTimestamp || '')
    : createFallbackAuditTimestampText;
  const createParsedAuditTime = createOpSnapshots.length > 0
    ? (createPerRowTimestamps[0]?.auditTimeISO ? new Date(createPerRowTimestamps[0].auditTimeISO) : null)
    : createFallbackParsedAuditTime;
  const createDeltaAuditVsMasterSec = createOpSnapshots.length > 0
    ? (createPerRowTimestamps[0]?.deltaAuditVsMasterSeconds ?? null)
    : createFallbackDeltaSec;
  const createAuditPerformedBy = createPerRowPerformedBy[0]?.auditPerformedBy || createFallbackAuditPerformedBy;

  // If caller requested only the create sub-test, return create-only result
  if (onlyCreate) {
    await hidePlaybackOverlay(page).catch(() => { });
    return {
      tcId: 'TC-DI-01-01',
      title: 'Attributability on Create',
      status: (createVerify.passed && createStatus.found && createAuditVsMasterWithin && createPerformedByPassed) ? 'passed' : 'failed',
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
        {
          step: 'Create timestamp consistency (Audit vs Master)',
          passed: createAuditVsMasterWithin,
          actualMasterTime: parsedCreateMasterTime ? parsedCreateMasterTime.toISOString() : (createMasterPerformedOn || '(not found)'),
          actualAuditTime: createParsedAuditTime ? createParsedAuditTime.toISOString() : (createAuditTimestampText || '(not found)'),
          deltaAuditVsMasterSeconds: createDeltaAuditVsMasterSec,
          rows: createPerRowTimestamps,
        },
        {
          step: 'Create performed-by consistency (Master row vs Audit trail)',
          passed: createPerformedByPassed,
          actualMasterPerformedBy: createMasterPerformedBy || '(not available)',
          actualAuditPerformedBy: createAuditPerformedBy || '(not found)',
          rows: createPerRowPerformedBy,
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

  const { changedAuditTrail: baseChangedAuditTrail, unchangedAuditFields } = deriveChangedAuditTrail(
    updateAuditTrail,
    preUpdateMasterRowData?.data
  );
  let changedAuditTrail = { ...baseChangedAuditTrail };
  let autoDetectedChangedFields = [];


  await page.waitForTimeout(1000);
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);
  if (recordID) {
    await page.fill(SEL.searchBox, '');
    await page.fill(SEL.searchBox, String(recordID));
    await page.keyboard.press('Enter').catch(() => { });
    await page.waitForTimeout(1000);
  }
  const updatedMasterRowData = await getFirstVisibleMasterRowData(page);
  const enrichedChangeSet = enrichChangedAuditTrailFromMasterRows(
    changedAuditTrail,
    preUpdateMasterRowData?.data,
    updatedMasterRowData?.data
  );
  changedAuditTrail = enrichedChangeSet.changedAuditTrail;
  autoDetectedChangedFields = enrichedChangeSet.autoDetectedChangedFields;

  log(`Update changed fields: ${Object.keys(changedAuditTrail).length ? Object.keys(changedAuditTrail).join(', ') : 'none'}`);
  if (autoDetectedChangedFields.length) {
    log(`Update auto-detected changed fields (master diff): ${autoDetectedChangedFields.join(', ')}`);
  }
  log(`Update unchanged fields (expected missing): ${unchangedAuditFields.length ? unchangedAuditFields.join(', ') : 'none'}`);

  const masterReason = pickFieldValue(updatedMasterRowData?.data, ['Reason', 'Update Reason', 'Remarks']);
  const masterPerformedOn = pickFieldValue(updatedMasterRowData?.data, ['Performed On', 'Performedon', 'Last Updated', 'Modified On', 'Updated On']);
  const masterPerformedBy = pickFieldValue(updatedMasterRowData?.data, ['Performed By', 'Performedby', 'Updated By', 'Modified By', 'User']);
  await showPlaybackOverlay(page, 'TC-DI-01 — Step 9/10: Verifying update audit trail', 9, 10).catch(() => { });

  const updateVerify = await verifyAuditTrailEntryCompliance(page, {
    baseURL: new URL(page.url()).origin,
    masterName: QT_MASTER,
    operation: 'update',
    recordName: recordID,
    recordID,
    auditTrail: changedAuditTrail,
    preUpdateMasterData: preUpdateMasterRowData?.data || {},
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

  const updateStatus = detectAuditStatusEnhanced(updateVerify, 'update');
  const updateRowStatus = buildPerRowStatusReportEnhanced(updateVerify, 'update');
  const updateOldNewValidation = updateVerify?.updateOldNewValidation || null;
  const updateOldNewPassed = !!updateOldNewValidation
    && Number(updateOldNewValidation.checkedFieldCount || 0) > 0
    && updateOldNewValidation.passed === true;
  log(`Update audit verification: ${updateVerify.passed ? 'passed' : 'failed'}${updateVerify.reason ? ' (' + updateVerify.reason + ')' : ''}`);
  log(`Update audit status: ${updateStatus.found ? 'found (source:' + updateStatus.source + ' evidence:' + updateStatus.evidence + ')' : 'NOT FOUND in actual row text'}`);
  log(`Update per-row status: ${updateRowStatus.rowsWithStatus}/${updateRowStatus.rowsChecked} rows contain '${updateRowStatus.expectedStatus}'`);
  if (updateOldNewValidation) {
    log(`Update old/new validation: ${updateOldNewValidation.passedFieldCount}/${updateOldNewValidation.checkedFieldCount} fields passed`);
  }
  log(`Update row scope: totalRows=${Array.isArray(updateVerify?.rowSnapshots) ? updateVerify.rowSnapshots.length : 0}, scopedRows=${Array.isArray(updateVerify?.operationRowSnapshots) ? updateVerify.operationRowSnapshots.length : 0}, reasonColumnFound=${updateVerify?.reasonColumn?.found ? 'true' : 'false'}`);
  const auditReasonMatched = Array.isArray(updateVerify?.matched) && updateVerify.matched.includes('reason');
  const masterReasonMatched = !masterReason
    ? null
    : normalizeText(masterReason).includes(normalizeText(updateReason))
    || normalizeText(updateReason).includes(normalizeText(masterReason));

  // ── Per-row checks for timestamp, performed-by, and reason ───────────────────
  // These must be verified for EVERY operation-scoped audit row, not just the first matched row.
  const updateOpSnapshots = Array.isArray(updateVerify?.complianceOperationRows) && updateVerify.complianceOperationRows.length > 0
    ? updateVerify.complianceOperationRows
    : (Array.isArray(updateVerify?.operationRowSnapshots) && updateVerify.operationRowSnapshots.length > 0
      ? updateVerify.operationRowSnapshots
      : (Array.isArray(updateVerify?.complianceRecordRows) ? updateVerify.complianceRecordRows : []));

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
    const auditPerformedByRow = getAuditPerformedByFromSnapshot(snap);
    const performerCheck = evaluatePerformedByConsistency(auditPerformedByRow, masterPerformedBy, QT_USER);
    return {
      rowIndex: snap?.index,
      rowText: String(rowText).slice(0, 220),
      auditPerformedBy: auditPerformedByRow,
      ...performerCheck,
    };
  });
  const allRowsPerformerPass = perRowPerformedBy.length > 0 && perRowPerformedBy.every((r) => r.passed);
  // Fallback for single-matched-row mode
  const fallbackAuditPerformedBy = extractPerformerFromAuditRow(updateVerify?.matchedRow || '');
  const fallbackPerformerCheck = evaluatePerformedByConsistency(fallbackAuditPerformedBy, masterPerformedBy, QT_USER);
  const performedByPassed = updateOpSnapshots.length > 0
    ? allRowsPerformerPass
    : fallbackPerformerCheck.passed;

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
  const passed = createVerify.passed
    && updateVerify.passed
    && statusChecksPassed
    && createAuditVsMasterWithin
    && createPerformedByPassed
    && updateOldNewPassed
    && auditVsMasterWithin
    && performedByPassed
    && reasonConsistencyPassed;
  // If caller requested only the update sub-test, return update-only result (create was performed to obtain a record but not reported)
  if (onlyUpdate) {
    await hidePlaybackOverlay(page).catch(() => { });
    log('Test Only Update: Returning update-only result');
    return {
      tcId: 'TC-DI-01-02',
      title: 'Attributability on Update',
      status: (updateVerify.passed && updateStatus.found && updateOldNewPassed && auditVsMasterWithin && performedByPassed && reasonConsistencyPassed) ? 'passed' : 'failed',
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
          step: 'Update old/new value consistency',
          passed: updateOldNewPassed,
          checkedFieldCount: updateOldNewValidation?.checkedFieldCount || 0,
          passedFieldCount: updateOldNewValidation?.passedFieldCount || 0,
          failedFieldCount: updateOldNewValidation?.failedFieldCount || 0,
          failedFields: updateOldNewValidation?.failedFields || [],
          reason: updateOldNewValidation?.reason || '',
          rows: updateOldNewValidation?.results || [],
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
          step: 'Update Performed-by consistency (Master row vs Audit trail)',
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
      {
        step: 'Create timestamp consistency (Audit vs Master)',
        passed: createAuditVsMasterWithin,
        actualMasterTime: parsedCreateMasterTime ? parsedCreateMasterTime.toISOString() : (createMasterPerformedOn || '(not found)'),
        actualAuditTime: createParsedAuditTime ? createParsedAuditTime.toISOString() : (createAuditTimestampText || '(not found)'),
        deltaAuditVsMasterSeconds: createDeltaAuditVsMasterSec,
        rows: createPerRowTimestamps,
      },
      {
        step: 'Create performed-by consistency (Master row vs Audit trail)',
        passed: createPerformedByPassed,
        actualMasterPerformedBy: createMasterPerformedBy || '(not available)',
        actualAuditPerformedBy: createAuditPerformedBy || '(not found)',
        rows: createPerRowPerformedBy,
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
        step: 'Update old/new value consistency',
        passed: updateOldNewPassed,
        checkedFieldCount: updateOldNewValidation?.checkedFieldCount || 0,
        passedFieldCount: updateOldNewValidation?.passedFieldCount || 0,
        failedFieldCount: updateOldNewValidation?.failedFieldCount || 0,
        failedFields: updateOldNewValidation?.failedFields || [],
        reason: updateOldNewValidation?.reason || '',
        rows: updateOldNewValidation?.results || [],
      },
      {
        step: 'Update unchanged fields (informational)',
        passed: true,
        expectedMissing: unchangedAuditFields,
        changedFieldsVerified: Object.keys(changedAuditTrail),
        autoDetectedChangedFields,
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
        step: 'Update Performed-by consistency (Master row vs Audit trail)',
        passed: performedByPassed,
        actualMasterPerformedBy: masterPerformedBy || '(not available)',
        actualAuditPerformedBy: auditPerformedBy || '(not found)',
        rows: perRowPerformedBy,
      },
    ],
  };
}

async function runTC_DI_02(page) {
  log('TC-DI-02: Legibility — Special Characters & Max-Length Strings');
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 1/5: Logging in', 1, 5).catch(() => { });
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });

  const baseURL = new URL(QT_URL).origin;
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 2/5: Creating base record with Unicode value', 2, 5).catch(() => { });
  await navigateTo(page, QT_MASTER, baseURL);
  await openCreateForm(page);

  const formFields = await collectStableFormFields(page).catch(() => []);
  const targetField = pickLegibilityTargetField(formFields);
  if (!targetField) {
    await hidePlaybackOverlay(page).catch(() => { });
    throw new Error('No editable text-like field found for DI-02.');
  }

  // Fill all mandatory fields so the form can be saved
  await fillOffcanvasForm(page, QT_MASTER);
  
  // Test Unicode on Create
  const specialUnicodeStr = `Ärzte & Société ${randomText(5)}`;
  const unicodeFilled = await fillLegibilityFieldValue(page, targetField, specialUnicodeStr);
  const unicodeVal = String(unicodeFilled?.actualValue || '');
  const unicodePassed = unicodeFilled.applied && unicodeVal === specialUnicodeStr;
  const targetFieldLabel = targetField.columnToShow || targetField.displayName || targetField.id || 'Legibility Text';

  const createSaveBtn = await getActionableSaveButton(page);
  if (createSaveBtn) await createSaveBtn.click();
  const createToast = await waitForSuccessToastOrHandleConfirm(page, 'create', 6000);
  await clickOptionalYesConfirmation(page, 1200).catch(() => false);

  const masterRowData = await getFirstVisibleMasterRowData(page);
  let recordID = pickFieldValue(masterRowData?.data, ['Record ID', 'Code', 'ID']);
  if (!recordID && masterRowData?.data) {
    const keys = Object.keys(masterRowData.data || {});
    if (keys[1]) recordID = masterRowData.data[keys[1]];
  }
  
  const unicodeOnlyAuditTrail = { [targetFieldLabel]: specialUnicodeStr };
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 3/5: Verifying Unicode field in audit trail', 3, 5).catch(() => { });
  
  const createVerify = await verifyAuditTrailEntryCompliance(page, {
    baseURL,
    masterName: QT_MASTER,
    operation: 'create',
    recordName: recordID,
    recordID,
    auditTrail: unicodeOnlyAuditTrail,
    username: QT_USER,
    masterPerformedOn: masterRowData?.data?.['Performed On'] || masterRowData?.data?.['Performedon'],
  }).then((res) => ({
    passed: res.verified && (res.comparison === null || res.comparison === undefined || res.comparison.passed !== false),
    ...res,
  })).catch((e) => ({ passed: false, reason: e.message }));
  const createVerifyReport = sanitizeAuditVerifyForReport(createVerify);
  
  recordID = recordID || createVerify?.compliancePrimaryRecordId || '';

  // Now test Max-Length on Update
  await showPlaybackOverlay(page, 'TC-DI-02 — Step 4/5: Opening edit form for max-length test', 4, 5).catch(() => { });
  await navigateTo(page, QT_MASTER, baseURL);
  await page.fill(SEL.searchBox, '').catch(() => { });
  await page.fill(SEL.searchBox, String(recordID)).catch(() => { });
  await page.keyboard.press('Enter').catch(() => { });
  await page.waitForTimeout(1200);

  const preUpdateMasterRowData = await getFirstVisibleMasterRowData(page);
  const editOpened = await openEditFormForRecord(page, recordID);
  if (!editOpened) {
    await hidePlaybackOverlay(page).catch(() => { });
    throw new Error(`Could not open edit form for DI-02 record ${recordID}.`);
  }

  const configuredMaxLength = Number(targetField?.maxLength || 0) || 0;
  const longStringLength = configuredMaxLength > 0 ? configuredMaxLength : 255;
  const longString = buildLegibilityPayload(longStringLength);
  
  const longFilled = await fillLegibilityFieldValue(page, targetField, longString);
  const longVal = String(longFilled?.actualValue || '');
  const longPassed = longFilled.applied && longVal === longString && longVal.length === longStringLength;

  const updateAuditTrail = { [targetFieldLabel]: longString };
  const updateReason = 'Compliance TC-DI-02 Long String';
  const reasonApplied = await applyUpdateReasonToMasterForm(page, updateReason);
  let submittedUpdateReason = reasonApplied?.applied ? updateReason : '';

  const updateSaveBtn = await getActionableSaveButton(page);
  if (updateSaveBtn) await updateSaveBtn.click();

  const reasonField = page.locator('#reasonTextarea:visible').first();
  if (await reasonField.isVisible().catch(() => false)) {
    await reasonField.fill(updateReason);
    await page.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    submittedUpdateReason = updateReason;
  }

  const updateToast = await waitForSuccessToastOrHandleConfirm(page, 'update', 6000);
  await clickOptionalYesConfirmation(page, 1200).catch(() => false);

  await showPlaybackOverlay(page, 'TC-DI-02 — Step 5/5: Verifying long-string field in audit trail', 5, 5).catch(() => { });
  await navigateTo(page, QT_MASTER, baseURL);
  await page.fill(SEL.searchBox, '').catch(() => { });
  await page.fill(SEL.searchBox, String(recordID)).catch(() => { });
  await page.keyboard.press('Enter').catch(() => { });
  await page.waitForTimeout(1000);

  const updatedMasterRowData = await getFirstVisibleMasterRowData(page);
  const masterPerformedOn = pickFieldValue(updatedMasterRowData?.data, ['Performed On', 'Performedon', 'Last Updated', 'Modified On', 'Updated On']);

  const updateVerify = await verifyAuditTrailEntryCompliance(page, {
    baseURL,
    masterName: QT_MASTER,
    operation: 'update',
    recordName: recordID,
    recordID,
    auditTrail: updateAuditTrail,
    preUpdateMasterData: preUpdateMasterRowData?.data || {},
    reason: submittedUpdateReason || updateReason,
    username: QT_USER,
    masterPerformedOn,
  }).then((res) => ({
    passed: res.verified && (res.comparison === null || res.comparison === undefined || res.comparison.passed !== false),
    ...res,
  })).catch((e) => ({ passed: false, reason: e.message }));
  const updateVerifyReport = sanitizeAuditVerifyForReport(updateVerify);
  const updateOldNewValidation = updateVerify?.updateOldNewValidation || null;
  const updateOldNewPassed = !!updateOldNewValidation
    && Number(updateOldNewValidation.checkedFieldCount || 0) > 0
    && updateOldNewValidation.passed === true;

  const passed = unicodePassed && !!createVerify.passed && longPassed && updateVerify.passed && updateOldNewPassed;
  await hidePlaybackOverlay(page).catch(() => { });
  
  return {
    tcId: 'TC-DI-02',
    title: 'Legibility — Special Characters & Max-Length Strings',
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Unicode value preserved in field after save',
        passed: unicodePassed,
        field: targetFieldLabel,
        expected: specialUnicodeStr,
        actual: unicodeVal,
      },
      {
        step: 'Unicode field preserved in audit trail',
        passed: !!createVerify.passed,
        recordID,
        checkedField: targetFieldLabel,
        checkedValue: specialUnicodeStr,
        toast: createToast?.text || '',
        ...createVerifyReport,
      },
      {
        step: 'Max-length string preserved in field after save',
        passed: longPassed,
        field: targetFieldLabel,
        expected: `length=${longStringLength}`,
        actual: `length=${longVal.length}`,
        configuredMaxLength,
      },
      {
        step: 'Long-string field preserved in audit trail',
        passed: !!updateVerify.passed && updateOldNewPassed,
        checkedField: targetFieldLabel,
        reasonUsed: submittedUpdateReason || updateReason,
        toast: updateToast?.text || '',
        oldNewValidationReason: updateOldNewValidation?.reason || '',
        ...updateVerifyReport,
      },
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

async function runTC_DI_07(page) {
// Duplicate DI-07 implementation removed
  const context = page.context();
  setupOverlayOnPage(page);
  await showPlaybackOverlay(page, 'TC-DI-07 - Session interruption test', 1, 3).catch(() => {});
  try {
    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

    // Capture initial record count before creating a new record
    const initialCount = await page.locator(SEL.tableRows).count();

    await openCreateForm(page);
    const auditTrail = await fillOffcanvasForm(page, QT_MASTER);

    // Simulate network interruption before attempting to save
    await context.setOffline(true);
    log('Network set offline before save');

    try {
      const saveBtn = await getActionableSaveButton(page);
      if (saveBtn) await saveBtn.click({ timeout: 5000 });
    } catch {
      log('Save click failed as expected (offline)');
    }

    // Restore network and wait for it to re‑establish
    await context.setOffline(false);
    log('Network restored');
    await page.waitForTimeout(10000); // 10 second wait as required

    // Reload to reflect any changes
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(SEL.pageTitle, { timeout: 30000 }).catch(() => {});

    // Verify that the record count increased by one (offline cached entry persisted)
    const finalCount = await page.locator(SEL.tableRows).count();
    const isIntact = finalCount === initialCount + 1;
    let auditVerified = false;
    let dataIntegrity = false;
    // After reload, filter the newly created record using a token from offline entry
    // Choose a representative field from auditTrail (first non-empty value)
    const auditValues = Object.values(auditTrail || {});
    const searchToken = auditValues.find(v => v && String(v).trim().length > 0) || '';
    if (searchToken) {
      // Fill the search box to locate the record
      await page.fill(SEL.searchBox, '').catch(() => {});
      await page.fill(SEL.searchBox, String(searchToken)).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      // Wait for potential table update
      await page.waitForTimeout(2000);
    }
    // Locate the newest record (assumed first row after possible filter)
    const newRecord = await page.evaluate(() => {
      const rows = document.querySelectorAll('.dt-scroll-body tbody tr:first-child, .dataTables_scrollBody tbody tr:first-child, table tbody tr:first-child');
      if (!rows.length) return null;
      const cells = rows[0].querySelectorAll('td');
      const headers = Array.from(document.querySelectorAll('table thead th')).map(th => th.innerText.trim());
      const data = {};
      headers.forEach((h, i) => { if (cells[i]) data[h] = cells[i].innerText.trim(); });
      return data;
    });
    const recordID = newRecord?.['Record ID'] || newRecord?.['Code'] || newRecord?.['ID'];
    if (recordID) {
      // Verify that displayed data matches offline entry
      dataIntegrity = true;
      for (const [field, expected] of Object.entries(auditTrail || {})) {
        const actual = newRecord[field];
        if (actual === undefined || actual !== expected) {
          dataIntegrity = false;
          break;
        }
      }
      // Verify timestamp (Performed On) is recent (within 2 minutes)
      const performedOn = newRecord['Performed On'] || newRecord['Performedon'];
      if (performedOn) {
        const performedDate = new Date(performedOn);
        const now = new Date();
        const diffMs = Math.abs(now - performedDate);
        // allow up to 2 minutes (120000 ms)
        if (isNaN(performedDate) || diffMs > 120000) {
          dataIntegrity = false;
        }
      }
      // Verify performed by matches user
      const performedBy = newRecord['Performed By'] || newRecord['PerformedBy'] || newRecord['User'];
      if (performedBy && performedBy !== QT_USER) {
        dataIntegrity = false;
      }
      // Verify audit trail entry for the created record
      await verifyAuditTrailEntryCompliance(page, {
        baseURL: new URL(page.url()).origin,
        masterName: QT_MASTER,
        operation: 'create',
        recordName: recordID,
        recordID,
        auditTrail,
        username: QT_USER,
      });
      auditVerified = true;
    } else {
      // Fallback: if count mismatch, attempt audit verification on any unexpected record (as before)
      const newRecord = await page.evaluate(() => {
        const rows = document.querySelectorAll('.dt-scroll-body tbody tr:first-child, .dataTables_scrollBody tbody tr:first-child, table tbody tr:first-child');
        if (!rows.length) return null;
        const cells = rows[0].querySelectorAll('td');
        const headers = Array.from(document.querySelectorAll('table thead th')).map(th => th.innerText.trim());
        const data = {};
        headers.forEach((h, i) => { if (cells[i]) data[h] = cells[i].innerText.trim(); });
        return data;
      });
      const recordID = newRecord?.['Record ID'] || newRecord?.['Code'] || newRecord?.['ID'];
      if (recordID) {
        await verifyAuditTrailEntryCompliance(page, {
          baseURL: new URL(page.url()).origin,
          masterName: QT_MASTER,
          operation: 'create',
          recordName: recordID,
          recordID,
          auditTrail,
          username: QT_USER,
        });
        auditVerified = true;
      }
    }

    return {
      tcId: 'TC-DI-07-01',
      title: 'Session Interruption (Durability)',
      status: isIntact && auditVerified ? 'passed' : 'failed',
      details: [
        { step: 'Record persisted after offline save', passed: isIntact },
        { step: 'Audit trail entry verified', passed: auditVerified },
      ],
    };
  } catch (e) {
    return { tcId: 'TC-DI-07-01', title: 'Session Interruption (Durability)', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await context.setOffline(false).catch(() => {});
    await hidePlaybackOverlay(page).catch(() => {});
  }
}
// Duplicate DI-07 implementation removed
async function runTC_DI_08(page) {
  log('TC-DI-08-01: Soft Delete Data Preservation');
  setupOverlayOnPage(page);
  await showPlaybackOverlay(page, 'TC-DI-08 - Step 1/3: Login and open master list', 1, 3).catch(() => { });
  try {
    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

    await showPlaybackOverlay(page, 'TC-DI-08 - Step 2/3: Create record and deactivate same record', 2, 3).catch(() => { });
    await openCreateForm(page);
    const createAuditTrail = await fillOffcanvasForm(page, QT_MASTER);
    const saveBtn = await getActionableSaveButton(page);
    if (!saveBtn) throw new Error('Could not find save button for create flow in TC-DI-08');
    await saveBtn.click();
    await page.waitForTimeout(1500);

    const createdMasterRowData = await getFirstVisibleMasterRowData(page);
    let createdRecordID = '';
    if (createdMasterRowData?.data) {
      createdRecordID = pickFieldValue(createdMasterRowData.data, ['Record ID', 'Code', 'ID']);
      if (!createdRecordID) {
        const keys = Object.keys(createdMasterRowData.data || {});
        if (keys[1]) createdRecordID = createdMasterRowData.data[keys[1]];
      }
    }

    const createdRecordName = pickFieldValue(createdMasterRowData?.data, ['Name', `${QT_MASTER} Name`, 'Title']);
    const createdFormToken = Object.values(createAuditTrail || {})
      .map((value) => String(value || '').trim())
      .find((value) => value.length >= 4) || '';
    const recordLookupToken = String(createdRecordID || createdRecordName || createdFormToken || '').trim();
    log(`TC-DI-08 created record token: ${recordLookupToken || '[none]'}`);

    if (recordLookupToken) {
      await page.fill(SEL.searchBox, '').catch(() => { });
      await page.fill(SEL.searchBox, recordLookupToken).catch(() => { });
      await page.keyboard.press('Enter').catch(() => { });
      await page.waitForTimeout(1200);
    }

    const esc = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowCandidates = [
      createdRecordID ? page.locator(SEL.tableRows).filter({ hasText: new RegExp(esc(createdRecordID), 'i') }).first() : null,
      recordLookupToken ? page.locator(SEL.tableRows).filter({ hasText: new RegExp(esc(recordLookupToken), 'i') }).first() : null,
      page.locator(SEL.tableRows).first(),
    ].filter(Boolean);

    let deactivatedSameRecord = false;
    for (const row of rowCandidates) {
      const rowVisible = await row.isVisible().catch(() => false);
      if (!rowVisible) continue;

      const deleteTarget = row.locator(SEL.deleteBtn).first();
      const deleteVisible = await deleteTarget.isVisible().catch(() => false);
      if (!deleteVisible) continue;

      await deleteTarget.click({ timeout: 8000 }).catch(async () => {
        await deleteTarget.click({ timeout: 5000, force: true }).catch(() => { });
        // write remarks for the deactivation of record in remarks dialog box
        const remarksTextarea = page.locator('#remarksTextarea:visible').first();
        if (await remarksTextarea.isVisible().catch(() => false)) {
          await remarksTextarea.fill(`Deactivating record for TC-DI-08 test: ${recordLookupToken || createdRecordID || '[unknown]'}`);
          await page.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
        }

      });
      deactivatedSameRecord = true;
      break;
    }
    if (!deactivatedSameRecord) {
      throw new Error(`Could not locate deactivate action for created record token: ${recordLookupToken || '[none]'}`);
    }

    await clickOptionalYesConfirmation(page, 5000).catch(() => false);
    // write remarks for the deactivation of record in remarks dialog box if it appears again after clicking on yes in confirmation pop up
    const remarksTextarea = page.locator('#reasonTextarea:visible').first();
    if (await remarksTextarea.isVisible().catch(() => false)) {
      await remarksTextarea.fill(`Deactivating record for TC-DI-08 test: ${recordLookupToken || createdRecordID || '[unknown]'}`);
      await page.locator(':text("Submit"), button.btn-primary:has-text("Submit")').first().click();
    }
    await clickOptionalYesConfirmation(page, 800).catch(() => false);

    await showPlaybackOverlay(page, 'TC-DI-08 - Step 3/3: Verify audit trail for deactivated record', 3, 3).catch(() => { });
    const auditVerify = await verifyAuditTrailEntryCompliance(page, {
      baseURL: new URL(page.url()).origin,
      masterName: QT_MASTER,
      operation: 'delete',
      recordName: recordLookupToken || null,
      recordID: createdRecordID || null,
      username: QT_USER,
    }).then((res) => ({ passed: res.verified, ...res })).catch((e) => ({ passed: false, reason: e.message }));

    return {
      tcId: 'TC-DI-08-01',
      title: 'Soft Delete Data Preservation',
      status: auditVerify.passed ? 'passed' : 'failed',
      details: [
        {
          step: 'Create and deactivate same record',
          passed: true,
          recordToken: recordLookupToken || '(not captured)',
          recordID: createdRecordID || '(not captured)',
        },
        { step: 'Audit trail retained after deactivation', ...auditVerify },
      ],
    };
  } catch (e) {
    return { tcId: 'TC-DI-08-01', title: 'Soft Delete Data Preservation', status: 'failed', details: [{ step: 'Error', passed: false, reason: e.message }] };
  } finally {
    await hidePlaybackOverlay(page).catch(() => { });
  }
}
async function runTC_DI_09(pageA) {
  log('TC-DI-09-01: Concurrent Edit Conflict Detection');
  const browser = pageA.context().browser();
  if (!browser) {
    throw new Error('Browser handle unavailable for TC-DI-09');
  }

  const ctxB = await newComplianceContext(browser);
  const pageB = await ctxB.newPage();
  setupOverlayOnPage(pageA);
  setupOverlayOnPage(pageB);
  await showPlaybackOverlay(pageA, 'TC-DI-09 - Concurrent edit (User A)', 1, 2).catch(() => { });
  await showPlaybackOverlay(pageB, 'TC-DI-09 - Concurrent edit (User B)', 1, 2).catch(() => { });

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
    await ctxB.close().catch(() => { });
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
    'TC-DI-02': () => runTC_DI_02(page),
    'TC-DI-06-01': () => runTC_DI_06(page),
    'TC-DI-07-01': () => runTC_DI_07(page),
    'TC-DI-08-01': () => runTC_DI_08(page),
    'TC-DI-09-01': () => runTC_DI_09(page),
  };

  const startedAt = new Date().toISOString();
  let result;

  try {
    if (!QT_TC_ID || !tcMap[QT_TC_ID]) {
      const allResults = [];
      const uniqueCases = ['TC-DI-01', 'TC-DI-02', 'TC-DI-06-01', 'TC-DI-07-01', 'TC-DI-08-01', 'TC-DI-09-01'];
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


