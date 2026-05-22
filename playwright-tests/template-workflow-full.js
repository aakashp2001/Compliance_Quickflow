'use strict';

/**
 * template-workflow-full.js
 * Steps: Login → CreateApp → CreateSite → CreateTemplate → CreateSubTemplate
 *        → AssignWorkflow → SwitchAppUnderSite → VerifyAuditTrail
 */

const { chromium } = require('@playwright/test');
const { randomBytes, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { smartFillOffcanvasForm } = require('./helpers/smartFiller');
const { verifyAuditTrailEntry } = require('./helpers/auditTrail');
const {
  enableArtifactOverlayOnContext,
  enableArtifactOverlayOnPage,
  updateArtifactOverlay,
} = require('./helpers/artifactOverlay');

// ── Config ────────────────────────────────────────────────────────────────────
function boolEnv(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
}
const CFG = {
  loginUrl:    process.env.QT_URL  || 'https://ipdev.quickflow.in/login',
  username:    process.env.QT_USER || 'dhruvi',
  password:    process.env.QT_PASS || 'Welcome@123',
  headless:    boolEnv(process.env.QT_HEADLESS, false),
  recordVideo: boolEnv(process.env.QT_RECORD_VIDEO, true),
};
const BASE_URL     = new URL(CFG.loginUrl).origin;
const COUNTRY_NAME  = 'India';
const TIMEZONE_NAME = 'India ( +05:30 )';
const RUN_STAMP    = compactGuid(createGuid()).slice(0, 16);
const ARTIFACTS_DIR = path.resolve(__dirname, 'test-reports');

function createGuid() {
  if (typeof randomUUID === 'function') return randomUUID();
  return randomBytes(16).toString('hex');
}

function compactGuid(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function codeFromStamp(prefix, stamp, length = 8) {
  const clean = compactGuid(stamp);
  const token = (clean.slice(-length) || clean || compactGuid(createGuid())).slice(0, length);
  return `${prefix}${token}`;
}

function uniqueStamp(length = 16) {
  return compactGuid(createGuid()).slice(0, length);
}

function log(msg) { process.stderr.write(`[WORKFLOW] ${msg}\n`); }

async function captureStepFailureScreenshot(page, stepKey) {
  try {
    if (!page || page.isClosed()) return '';
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const safeStep = String(stepKey || 'step').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-template-workflow-${safeStep}-failed.png`;
    const fullPath = path.join(ARTIFACTS_DIR, fileName);
    await page.screenshot({ path: fullPath, fullPage: true }).catch(() => {});
    return fullPath;
  } catch {
    return '';
  }
}

async function markStepFailedWithScreenshot(page, steps, flowState, stepKey, message) {
  const screenshotPath = await captureStepFailureScreenshot(page, stepKey);
  steps[stepKey] = {
    status: 'failed',
    message: String(message || 'Step failed'),
    screenshotPath,
  };
  if (screenshotPath) {
    if (!Array.isArray(flowState.screenshots)) flowState.screenshots = [];
    flowState.screenshots.push({
      step: stepKey,
      path: screenshotPath,
      fileName: path.basename(screenshotPath),
      capturedAt: new Date().toISOString(),
    });
    log(`[STEP-FAIL] ${stepKey} screenshot saved: ${screenshotPath}`);
  }
}

/**
 * Detects if an error message indicates a duplicate record.
 * Returns true if the error is a duplicate/already exists error.
 */
function isDuplicateError(errorMsg) {
  const msg = String(errorMsg || '').toLowerCase();
  return /duplicate|already exist|already in use|conflict|unique constraint/i.test(msg);
}

/**
 * Generates a new unique stamp for retry attempts.
 * Used when duplicate errors occur to create alternative names.
 */
function generateRetryStamp(attemptNum = 1) {
  const base = uniqueStamp(16);
  const suffix = String(attemptNum).padStart(2, '0');
  return `${base}-R${suffix}`;
}

/**
 * Extracts the duplicate field name from error message.
 * Examples:
 *   "Duplicate entry 'ABC' for key 'Name'" → 'Name'
 *   "Site Name 'ABC' already exists" → 'Site Name'
 *   "Duplicate App Code" → 'App Code'
 */
function extractDuplicateFieldFromError(errorMsg) {
  const msg = String(errorMsg || '');
  
  // Try: "Duplicate entry for key 'FieldName'" or "for key 'FieldName'"
  let match = msg.match(/(?:for key|for field)\s+['\"]?([^'\"]+)['\"]?(?:\s|$|[,.])/i);
  if (match) return match[1].trim();
  
  // Try: "FieldName already exists" or "FieldName already in use"
  match = msg.match(/^([^:]+)\s+(?:already exists|already in use|is duplicate)/i);
  if (match) return match[1].trim();
  
  // Try: "Duplicate FieldName"
  match = msg.match(/duplicate\s+([^\s]+(?:\s+[^\s]+)?)/i);
  if (match) return match[1].trim();
  
  // Try: "Field 'FieldName' - duplicate"
  match = msg.match(/field\s+['\"]?([^'\"]+)['\"]?\s*-\s*duplicate/i);
  if (match) return match[1].trim();
  
  return '';
}

/**
 * Fetches all values of a specific field from a paginated table on the dashboard.
 * Navigates through all pages and collects unique field values.
 * Returns array of field values found in the table.
 */
async function fetchExistingValuesFromDashboard(page, fieldLabel) {
  try {
    log(`[FETCH-VALUES] Fetching existing values for field: "${fieldLabel}"`);
    
    const allValues = [];
    const maxPages = 50; // safety limit
    let pageNum = 1;
    
    for (let p = 0; p < maxPages; p++) {
      log(`[FETCH-VALUES] Scanning page ${pageNum}`);
      
      // Find column index by header text
      const columnIndex = await page.evaluate((label) => {
        const headers = Array.from(document.querySelectorAll('th, [role="columnheader"], .dataTables_wrapper th'));
        for (let i = 0; i < headers.length; i++) {
          const headerText = (headers[i].textContent || '').trim().toLowerCase();
          const labelLower = String(label || '').toLowerCase();
          if (headerText === labelLower || headerText.includes(labelLower)) {
            return i;
          }
        }
        return -1;
      }, fieldLabel).catch(() => -1);
      
      if (columnIndex < 0) {
        log(`[FETCH-VALUES] ⚠️ Column "${fieldLabel}" not found in table headers`);
        break;
      }
      
      // Extract all values from this page for the column
      const pageValues = await page.evaluate((colIdx) => {
        const rows = Array.from(document.querySelectorAll('tbody tr, [role="row"]'));
        const values = [];
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
          if (cells[colIdx]) {
            const val = (cells[colIdx].textContent || '').trim();
            if (val && !values.includes(val)) values.push(val);
          }
        }
        return values;
      }, columnIndex).catch(() => []);
      
      for (const val of pageValues) {
        if (!allValues.includes(val)) allValues.push(val);
      }
      
      log(`[FETCH-VALUES] Found ${pageValues.length} value(s) on page ${pageNum}`);
      
      // Check if there's a next page
      const hasNextPage = await page.evaluate(() => {
        // Look for Next button or pagination
        const nextBtn = document.querySelector('a:contains("Next"), button:contains("Next"), [aria-label*="Next"]');
        if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('disabled')) return true;
        
        // Try DataTables pagination
        const paginate = document.querySelector('.dataTables_paginate');
        if (paginate) {
          const nextLink = paginate.querySelector('a.next:not(.disabled)');
          if (nextLink) return true;
        }
        
        // Try Bootstrap pagination
        const pagination = document.querySelector('ul.pagination, nav[aria-label="Page navigation"]');
        if (pagination) {
          const nextItem = pagination.querySelector('li:last-child:not(.disabled) a, li:has(> a[aria-label*="Next"]) a');
          if (nextItem) return true;
        }
        
        return false;
      }).catch(() => false);
      
      if (!hasNextPage) {
        log(`[FETCH-VALUES] Reached last page at page ${pageNum}`);
        break;
      }
      
      // Click next page button
      const nextClicked = await page.evaluate(() => {
        // Try DataTables next
        const nextLink = document.querySelector('.dataTables_paginate a.next:not(.disabled)');
        if (nextLink) { nextLink.click(); return true; }
        
        // Try Bootstrap pagination next
        const pagination = document.querySelector('ul.pagination');
        if (pagination) {
          const nextItem = pagination.querySelector('li:last-child:not(.disabled) a');
          if (nextItem) { nextItem.click(); return true; }
        }
        
        // Try aria-label next
        const ariaNext = document.querySelector('[aria-label*="Next"]');
        if (ariaNext && !ariaNext.disabled) { ariaNext.click(); return true; }
        
        return false;
      }).catch(() => false);
      
      if (!nextClicked) {
        log(`[FETCH-VALUES] Could not click next page button`);
        break;
      }
      
      // Wait for page load
      await page.waitForTimeout(1000);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(600);
      
      pageNum++;
    }
    
    log(`[FETCH-VALUES] ✅ Collected ${allValues.length} unique value(s) for field "${fieldLabel}": [${allValues.slice(0, 5).join(', ')}${allValues.length > 5 ? '...' : ''}]`);
    return allValues;
  } catch (err) {
    log(`[FETCH-VALUES] Error fetching values: ${err.message}`);
    return [];
  }
}

/**
 * Checks if a value already exists in the list of existing values.
 * Returns true if value is already taken.
 */
function isValueTaken(value, existingValues) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const valNorm = norm(value);
  return existingValues.some(v => norm(v) === valNorm);
}

/**
 * Generates a new value that doesn't exist in the provided list.
 * Keeps trying with different suffixes until finding an unused value.
 */
function generateUniqueValue(baseValue, existingValues, attemptNum = 1) {
  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    const suffix = i === 0 ? uniqueStamp(16) : `${uniqueStamp(16)}${attemptNum}${i}`;
    const candidate = `${suffix}`;
    if (!isValueTaken(candidate, existingValues)) {
      return candidate;
    }
  }
  // Fallback: use a full fresh GUID fragment instead of reusing any earlier name/id.
  return uniqueStamp(20);
}

async function verifyRecentlyCreatedEntry(page, routes, expectedText, entityLabel = 'record') {
  const targets = Array.isArray(routes) ? routes : [routes];
  const needle = String(expectedText || '').trim();
  if (!needle || !targets.length) return false;

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const needleNorm = norm(needle);

  for (const route of targets) {
    try {
      await navigateTo(page, route);
      await dismissOverlays(page).catch(() => {});

      const searchInputs = [
        '#txtSearch',
        'input[type="search"]',
        '.dataTables_filter input',
        'input[placeholder*="Search"]',
      ];

      for (const sel of searchInputs) {
        const input = page.locator(sel).first();
        if (!await input.isVisible().catch(() => false)) continue;
        await input.fill('').catch(() => {});
        await input.fill(needle).catch(() => {});
        await page.waitForTimeout(500);
        await input.press('Enter').catch(() => {});
        await page.waitForTimeout(900);
        break;
      }

      for (let i = 0; i < 3; i++) {
        const rows = await page.evaluate(() => {
          const getText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
          return Array.from(document.querySelectorAll('tbody tr, [role="row"]')).map(getText).filter(Boolean);
        }).catch(() => []);

        const found = rows.some((row) => norm(row).includes(needleNorm));
        if (found) {
          log(`[VERIFY] ${entityLabel} found in list: "${needle}" on route "${route}"`);
          return true;
        }
        await page.waitForTimeout(700);
      }

      log(`[VERIFY] ${entityLabel} not found on route "${route}", trying next route if available`);
    } catch (err) {
      log(`[VERIFY] Could not verify ${entityLabel} on route "${route}": ${err.message}`);
    }
  }

  return false;
}

// ── Shared page helpers ───────────────────────────────────────────────────────
async function navigateTo(page, route) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
  await page.waitForTimeout(1200);
}

async function dismissOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const swal = page.locator('.swal2-confirm:visible:not([disabled])').first();
    if (await swal.isVisible().catch(() => false)) {
      await swal.click({ force: true }).catch(() => { });
      await page.waitForTimeout(400);
    }
    const modal = page.locator('.modal.show button:visible', { hasText: /ok|yes|confirm/i }).first();
    if (await modal.isVisible().catch(() => false)) {
      await modal.click({ force: true }).catch(() => { });
      await page.waitForTimeout(400);
    }
  }
}

async function openCreateForm(page) {
  const offSel = '.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas.show .offcanvas-body';
  const offcanvas = page.locator(offSel).first();
  if (await offcanvas.isVisible().catch(() => false)) return;
  await dismissOverlays(page);

  const btns = [
    page.locator('#btnAdd:visible:not([disabled])').first(),
    page.locator('button.btn-primary:visible', { hasText: /Create/i }).first(),
    page.getByRole('button', { name: /Create/i }).first(),
    page.locator('button:visible:not([disabled])', { hasText: /Create/i }).first(),
  ];

  let opened = false;
  for (let round = 0; round < 3 && !opened; round++) {
    for (const btn of btns) {
      if (!await btn.isVisible().catch(() => false)) continue;
      await btn.click({ force: true }).catch(() => { });
      opened = await offcanvas.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
      if (opened) break;
    }
    if (!opened) await page.waitForTimeout(800);
  }
  if (!opened) throw new Error('Could not open Create form offcanvas');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
  await page.waitForTimeout(800);
}

async function syncHiddenSelects(page) {
  await page.evaluate(() => {
    try {
      const oc = document.querySelector('.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body');
      if (!oc) return;
      const isVis = (el) => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.offsetParent !== null;
      for (const ele of Array.from(oc.querySelectorAll('.ele')).filter(isVis)) {
        if (!ele.querySelector('[role="combobox"], .react-select__control, .select2-selection')) continue;
        const sv = ele.querySelector('[class*="singleValue"], .react-select__single-value, [class*="single-value"]');
        const label = (sv?.textContent || '').trim();
        if (!label) continue;
        for (const sel of Array.from(oc.querySelectorAll('select'))) {
          if (isVis(sel)) continue;
          const opt = Array.from(sel.options).find(o => (o.textContent || '').trim().toLowerCase() === label.toLowerCase());
          if (!opt || sel.value === opt.value) continue;
          sel.value = opt.value;
          ['input', 'change', 'blur'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
          if (window.$) { window.$(sel).trigger('change'); }
        }
      }
    } catch {}
  }).catch(() => {});
}

async function saveOffcanvas(page) {
  await page.evaluate(() => {
    const body = document.querySelector('.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas.show .offcanvas-body');
    if (body) body.scrollTop = body.scrollHeight;
  }).catch(() => {});
  await page.waitForTimeout(400);
  await syncHiddenSelects(page);

  const offcanvasSel = '.offcanvas.show, #masterFormOffcanvas.show, #offcanvas.show';

  const candidates = [
    page.locator('#btnSave:visible:not([disabled])').first(),
    page.locator('#btnSubmit:visible:not([disabled])').first(),
    page.locator('.offcanvas.show #btnSave:visible').first(),
    page.locator('.offcanvas.show button[type="submit"]:visible:not([disabled])').first(),
    page.locator('.offcanvas.show button:visible:not([disabled])', { hasText: /^\s*Save\s*$/i }).first(),
    page.locator('#btnSave').first(),
  ];

  let clicked = false;
  for (const btn of candidates) {
    if (!await btn.isVisible().catch(() => false)) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);
    try { await btn.click({ timeout: 4000 }); }
    catch { try { await btn.click({ force: true }); } catch { continue; } }
    clicked = true;
    break;
  }

  if (!clicked) {
    // force-show fallback
    for (const id of ['btnSave', 'btnSubmit']) {
      if (!await page.locator(`#${id}`).count().catch(() => 0)) continue;
      await page.evaluate((bid) => {
        const b = document.getElementById(bid); if (!b) return;
        b.style.cssText = 'display:inline-block!important;visibility:visible!important;opacity:1!important';
        b.removeAttribute('disabled');
        b.scrollIntoView({ block: 'center' });
      }, id);
      await page.waitForTimeout(300);
      const btn = page.locator(`#${id}`).first();
      if (!await btn.isVisible().catch(() => false)) continue;
      await btn.click({ force: true });
      clicked = true;
      break;
    }
  }

  if (!clicked) throw new Error('Save button not found in offcanvas');

  // ── Wait for save to complete ────────────────────────────────────────────────
  // Primary signal: offcanvas closes → record was saved successfully
  const offcanvasClosed = await page
    .waitForSelector(offcanvasSel, { state: 'hidden', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  // Read any toast/alert message for diagnostics
  await page.waitForTimeout(500);
  await dismissOverlays(page);
  const toastMsg = await page.evaluate(() => {
    for (const n of document.querySelectorAll('.swal2-title,.swal2-html-container,.toast-message,[role="alert"],.alert-success,.alert-danger,.Toastify__toast-body')) {
      const t = (n.textContent || '').trim();
      if (t) return t;
    }
    return '';
  }).catch(() => '');

  // ── Determine success / failure ──────────────────────────────────────────────
  const isErrorMsg = /error|fail|invalid|required|mandatory|duplicate|already exist/i.test(toastMsg);

  if (isErrorMsg) {
    throw new Error(`Save rejected by server: "${toastMsg}"`);
  }

  if (!offcanvasClosed) {
    // If the offcanvas is still showing AND we have no success message, treat as failure
    const isSuccessMsg = /saved|success|created|added/i.test(toastMsg);
    if (!isSuccessMsg) {
      throw new Error(`Save did not complete — offcanvas still open${toastMsg ? ` ("${toastMsg}")` : '. Check for validation errors.'}`);
    }
    // Some apps show a success toast without closing the offcanvas — allow it
    log(`[SAVE] Offcanvas still open but success message detected: "${toastMsg}"`);
  }

  const msg = toastMsg || 'Saved';
  log(`[SAVE] ✅ ${msg}`);
  return msg;
}



/**
 * Pick from react-select / select2. Returns label of chosen option or ''.
 * preferredText: exact/partial match preferred; falls back to first option.
 */
async function pickDropdown(page, inputSelector, searchText = '', preferredText = '') {
  const input = page.locator(inputSelector).first();
  if (!await input.isVisible().catch(() => false)) return '';
  await input.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  if (searchText) {
    await input.fill('').catch(() => { });
    await input.type(searchText, { delay: 30 }).catch(() => { });
    await page.waitForTimeout(800);
  }

  const options = await page.evaluate(() => {
    const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    const containers = Array.from(document.querySelectorAll('.select2-container--open .select2-results, .react-select__menu, [role="listbox"]')).filter(isVis);
    const src = containers[containers.length - 1] || document;
    const found = [];
    for (const sel of ['.select2-results__option', '.react-select__option', '[class*="menu-list"] [class*="option"]', '[role="option"]', '[role="listbox"] > *']) {
      for (const n of Array.from(src.querySelectorAll(sel)).filter(isVis)) {
        const label = (n.textContent || '').trim();
        if (label && !/^\s*(please\s+select|select|choose|none|--)\s*$/i.test(label) && !found.includes(label)) found.push(label);
      }
      if (found.length) break;
    }
    return found;
  }).catch(() => []);

  if (!options.length) return '';
  const norm = (s) => String(s || '').trim().toLowerCase();
  const chosen = preferredText
    ? (options.find(o => norm(o) === norm(preferredText)) || options.find(o => norm(o).includes(norm(preferredText))) || options.find(o => norm(preferredText).includes(norm(o))) || options[0])
    : options[0];
  if (!chosen) return '';

  const esc = chosen.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  for (const loc of [
    page.locator(`.react-select__option:has-text("${esc}")`).first(),
    page.locator(`.select2-results__option:has-text("${esc}")`).first(),
    page.locator(`[role="option"]:has-text("${esc}")`).first(),
  ]) {
    if (!await loc.isVisible().catch(() => false)) continue;
    await loc.click({ force: true, timeout: 2500 }).catch(() => { });
    await page.waitForTimeout(500);
    return chosen;
  }
  await input.press('ArrowDown').catch(() => {});
  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(400);
  return chosen;
}

/**
 * Scans EVERY react-select / select2 input inside the offcanvas, opens each one,
 * types targetText, and clicks the matching option.
 * When targetText is EMPTY, picks the FIRST available option (useful for Level/Role).
 * Throws if targetText cannot be found in any dropdown (strict mode).
 * Returns the label that was selected.
 */
async function forceSelectInOffcanvas(page, targetText, fieldHint = '', strict = true) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const targetNorm = norm(targetText);
  const pickFirst = !targetNorm; // empty targetText → just pick first available

  log(`[FORCE-SELECT] Searching for "${targetText || '(first available)'}" ${fieldHint ? `(${fieldHint})` : ''} in offcanvas dropdowns`);

  // Collect all react-select inputs inside the offcanvas
  const inputIds = await page.evaluate(() => {
    const oc = document.querySelector('.offcanvas.show .offcanvas-body, #masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body');
    if (!oc) return [];
    const isVis = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null && !el.disabled;
    };
    const inputs = Array.from(oc.querySelectorAll('input[id*="react-select"], input[role="combobox"], .select2-search__field'));
    return inputs.filter(isVis).map(el => ({ id: el.id, name: el.name || '', placeholder: el.placeholder || '' }));
  }).catch(() => []);

  log(`[FORCE-SELECT] Found ${inputIds.length} dropdown inputs in offcanvas`);

  for (const inputMeta of inputIds) {
    const input = page.locator(`input[id="${inputMeta.id}"]`).first();
    if (!await input.isVisible().catch(() => false)) continue;

    // Open and optionally type
    await input.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    if (!pickFirst) {
      await input.fill('').catch(() => {});
      await input.type(targetText, { delay: 25 }).catch(() => {});
    }
    await page.waitForTimeout(800);

    // Get all visible options
    const options = await page.evaluate((tgt) => {
      const isVis = (el) => {
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
      };
      const containers = Array.from(document.querySelectorAll('.react-select__menu, [role="listbox"], .select2-container--open .select2-results')).filter(isVis);
      const src = containers[containers.length - 1] || document;
      const items = [];
      for (const sel of ['.react-select__option', '[role="option"]', '.select2-results__option', '[role="listbox"] > *']) {
        for (const n of Array.from(src.querySelectorAll(sel)).filter(isVis)) {
          const label = (n.textContent || '').trim();
          if (label && !/^\s*(please\s+select|select|choose|none|--)\s*$/i.test(label)) items.push(label);
        }
        if (items.length) break;
      }
      const norm = (s) => String(s || '').trim().toLowerCase();
      if (!tgt) return { match: items[0] || null, all: items.slice(0, 5) }; // pick first
      const exact = items.find(o => norm(o) === norm(tgt));
      const partial = items.find(o => norm(o).includes(norm(tgt)) || norm(tgt).includes(norm(o)));
      return { match: exact || partial || null, all: items.slice(0, 5) };
    }, targetText).catch(() => ({ match: null, all: [] }));

    if (options.match) {
      // Use Playwright filter locator (handles special chars natively)
      const allOptLoc = page.locator('.react-select__option, [role="option"], .select2-results__option');
      const matched = allOptLoc.filter({ hasText: options.match }).first();
      if (await matched.isVisible({ timeout: 1000 }).catch(() => false)) {
        await matched.click({ force: true }).catch(() => {});
      } else {
        await input.press('Enter').catch(() => {});
      }
      await page.waitForTimeout(600);
      log(`[FORCE-SELECT] ✅ Selected "${options.match}" for "${fieldHint || targetText || 'first'}"`);
      return options.match;
    }

    // This dropdown didn't have the value — close it and move on
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    log(`[FORCE-SELECT] Not found in input "${inputMeta.id}" (options: ${options.all.join(', ') || 'No options available'})`);
  }

  if (strict) {
    throw new Error(`[FORCE-SELECT] Could not find "${targetText}" in any offcanvas dropdown. Is the record created and saved before this step?`);
  }
  log(`[FORCE-SELECT] ⚠️ "${targetText || 'first'}" not found in any dropdown (non-strict, continuing)`);
  return '';
}



// ── STEP 1: Login ─────────────────────────────────────────────────────────────
async function stepLogin(page) {
  log('Step 1: Login');
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtUsername', { timeout: 30000 });
  await page.fill('#txtUsername', CFG.username);
  await page.fill('#txtPassword', CFG.password);
  await page.click('#btnLogin');
  await page.waitForTimeout(1000);
  if (await page.locator('#btnUnlock').isVisible().catch(() => false)) {
    await page.click('#btnUnlock');
    await page.waitForTimeout(1000);
  }
  await page.waitForSelector('#divAppButton', { timeout: 30000 });
  log('Login – PASSED');
}

// ── STEP 2: Create Site ───────────────────────────────────────────────────────
// Site is created FIRST so the App can be linked to it in Step 3.
async function stepCreateSite(page, flowState) {
  log('Step 2: Create Site');
  let stamp = RUN_STAMP;
  let existingNames = [];
  let existingCodes = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0) {
        log(`[STEP2] Retry attempt ${attempt + 1} for Site creation`);
        await page.waitForTimeout(2000);
        // Dismiss any leftover overlays from the previous attempt
        await dismissOverlays(page).catch(() => {});
        
        // On duplicate error, fetch existing values to avoid conflicts
        if (attempt === 1 && (existingNames.length === 0 || existingCodes.length === 0)) {
          log(`[STEP2] Fetching existing Site values from dashboard...`);
          try {
            await navigateTo(page, '/Site');
            existingNames = await fetchExistingValuesFromDashboard(page, 'Site Name');
            existingCodes = await fetchExistingValuesFromDashboard(page, 'Site Code');
            log(`[STEP2] Found ${existingNames.length} existing names, ${existingCodes.length} existing codes`);
          } catch (err) {
            log(`[STEP2] Could not fetch existing values: ${err.message}`);
          }
        }
        
        // Generate new unique values
        const baseStamp = generateRetryStamp(attempt);
        stamp = generateUniqueValue(baseStamp, [...existingNames, ...existingCodes], attempt);
        log(`[STEP2] Generated new stamp for retry: ${stamp}`);
      }

      const siteName = `AUTO-SITE-${stamp}`;
      const siteCode = codeFromStamp('ST', stamp);
      
      // Check locally if value likely exists
      if (existingNames.length > 0 && isValueTaken(siteName, existingNames)) {
        log(`[STEP2] ⚠️ Value "${siteName}" appears to exist locally, generating alternative...`);
        stamp = generateUniqueValue(stamp, existingNames, attempt);
        continue;
      }
      
      await navigateTo(page, '/Site');
      // Extra wait for the page to stabilise before opening the form
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
      await openCreateForm(page);

      const audit = await smartFillOffcanvasForm(page, 'Site', null, {
        mode: 'create',
        prefilledValues: {
          Name: siteName, 'Site Name': siteName,
          'Site Code': siteCode, Code: siteCode,
          'Country Name': COUNTRY_NAME, Country: COUNTRY_NAME, 'Time Zone Name': TIMEZONE_NAME,
        },
      });

      const saveMsg = await saveOffcanvas(page);
      log(`Site save: ${saveMsg}`);
      flowState.siteName    = audit['Site Name'] || audit['Name'] || siteName;
      flowState.countryName  = COUNTRY_NAME;
      flowState.timeZoneName = TIMEZONE_NAME;
      log(`Site stored: ${flowState.siteName}`);
      return { siteName: flowState.siteName, saveMessage: saveMsg };

    } catch (err) {
      const isOffcanvasClose = /offcanvas closed unexpectedly/i.test(err.message);
      const isDuplicate = isDuplicateError(err.message);
      
      if (isDuplicate && attempt < 4) {
        const dupField = extractDuplicateFieldFromError(err.message);
        log(`[STEP2] Duplicate detected on field "${dupField || 'unknown'}" (attempt ${attempt + 1}) — will fetch dashboard and retry: ${err.message}`);
        
        // On first duplicate, fetch existing values
        if (attempt === 1) {
          try {
            await navigateTo(page, '/Site');
            await page.waitForTimeout(1000);
            if (dupField.toLowerCase().includes('name') || !dupField) {
              existingNames = await fetchExistingValuesFromDashboard(page, 'Site Name');
            }
            if (dupField.toLowerCase().includes('code') || !dupField) {
              existingCodes = await fetchExistingValuesFromDashboard(page, 'Site Code');
            }
          } catch (err2) {
            log(`[STEP2] Could not fetch dashboard values: ${err2.message}`);
          }
        }
        continue;
      }
      
      if (isOffcanvasClose && attempt < 4) {
        log(`[STEP2] Offcanvas closed during fill (attempt ${attempt + 1}) — retrying: ${err.message}`);
        continue;
      }
      
      throw err;
    }
  }
}


// ── STEP 3: Create App (MUST be linked to Site from Step 2) ─────────────────
/**
 * Selects a site by clicking its radio button in the offcanvas.
 * The App-creation form renders Site as a table/list of radio buttons.
 * Tries multiple strategies:
 *   1. Radio button inside a row/cell that contains the site name text
 *   2. Label element whose text matches the site name
 *   3. Evaluates the DOM to find and click it
 */
async function selectSiteByRadio(page, siteName) {
  log(`[RADIO-SELECT] Looking for Site radio: "${siteName}"`);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const siteNorm = norm(siteName);

  // Strategy 1: row in a table contains the siteName → click the radio in that row
  const rowWithSite = page.locator(
    '.offcanvas.show tr:visible, #offcanvas.show tr:visible, #masterFormOffcanvas.show tr:visible'
  ).filter({ hasText: siteName }).first();

  if (await rowWithSite.isVisible().catch(() => false)) {
    const radioInRow = rowWithSite.locator('input[type="radio"]').first();
    if (await radioInRow.isVisible().catch(() => false)) {
      await radioInRow.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      log(`[RADIO-SELECT] ✅ Clicked radio in table row for "${siteName}"`);
      return true;
    }
    // Click the row itself (sometimes the row is the clickable element)
    await rowWithSite.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    log(`[RADIO-SELECT] ✅ Clicked table row for "${siteName}"`);
    return true;
  }

  // Strategy 2: label whose text matches siteName
  const labelMatch = page.locator(
    '.offcanvas.show label:visible, #offcanvas.show label:visible'
  ).filter({ hasText: siteName }).first();
  if (await labelMatch.isVisible().catch(() => false)) {
    await labelMatch.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    log(`[RADIO-SELECT] ✅ Clicked label for "${siteName}"`);
    return true;
  }

  // Strategy 3: evaluate DOM — find radio whose adjacent text matches
  const clicked = await page.evaluate((target) => {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const isVis = (el) => el && el.offsetParent !== null;
    const oc = document.querySelector('.offcanvas.show .offcanvas-body, #masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body');
    if (!oc) return false;

    // Find all radio buttons in the offcanvas
    const radios = Array.from(oc.querySelectorAll('input[type="radio"]')).filter(isVis);
    for (const radio of radios) {
      // Check the row/parent text
      let parent = radio.parentElement;
      for (let d = 0; d < 5 && parent && parent !== oc; d++, parent = parent.parentElement) {
        if (norm(parent.textContent || '').includes(norm(target))) {
          radio.click();
          return true;
        }
      }
      // Check associated label
      const id = radio.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl && norm(lbl.textContent || '').includes(norm(target))) {
          radio.click();
          return true;
        }
      }
    }
    return false;
  }, siteName).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(400);
    log(`[RADIO-SELECT] ✅ Selected via DOM evaluation for "${siteName}"`);
    return true;
  }

  log(`[RADIO-SELECT] ⚠️ Could not find radio button for "${siteName}" — site may not appear in list yet`);
  return false;
}

// ── STEP 3: Create App (MUST be linked to Site from Step 2) ─────────────────
async function stepCreateApp(page, flowState) {
  log('Step 3: Create App');
  if (!flowState.siteName) throw new Error('Cannot create App: siteName not set from Step 2');
  
  let stamp = RUN_STAMP;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0) {
        log(`[STEP3] Retry attempt ${attempt + 1} for App creation`);
        await page.waitForTimeout(2000);
        if (attempt > 1) {
          stamp = generateRetryStamp(attempt);
          log(`[STEP3] Generated new stamp for retry: ${stamp}`);
        }
        await dismissOverlays(page).catch(() => {});
      }

      const appName = `AUTO-APP-${stamp}`;
      await navigateTo(page, '/Create-App');
      await openCreateForm(page);

      // ✅ MANDATORY: Select the Site created in Step 2.
      // The App form uses RADIO BUTTONS for site selection, not a dropdown.
      log(`[STEP3] Selecting Site "${flowState.siteName}" via radio button in App form`);
      const siteSelected = await selectSiteByRadio(page, flowState.siteName);
      if (!siteSelected) {
        throw new Error(`[STEP3] Could not select Site "${flowState.siteName}" in App form. Ensure Site was saved successfully in Step 2.`);
      }
      await page.waitForTimeout(600);

      // Fill remaining fields via smartFiller (site radio already selected above)
      const audit = await smartFillOffcanvasForm(page, 'Create-App', null, {
        mode: 'create',
        prefilledValues: {
          Name: appName, 'App Name': appName,
          'App Code': codeFromStamp('AP', stamp), 'Short Name': codeFromStamp('AS', stamp, 6), Code: codeFromStamp('AP', stamp),
          Site: flowState.siteName, 'Site Name': flowState.siteName,
          'Form Submission To': 'Role',
        },
      });

      // Mandatory business rule: App creation must use Form Submission To = Role.
      // Re-apply after smart filler so any auto-selection gets corrected.
      log('[STEP3] Enforcing Form Submission To = "Role"');
      await forceSelectInOffcanvas(page, 'Role', 'Form Submission To', true);
      await page.waitForTimeout(400);

      const saveMsg = await saveOffcanvas(page);
      log(`App save: ${saveMsg}`);
      flowState.appName = audit['App Name'] || audit['Name'] || appName;
      log(`App stored: ${flowState.appName}`);
      return { appName: flowState.appName, saveMessage: saveMsg };

    } catch (err) {
      const isDuplicate = isDuplicateError(err.message);
      const dupField = extractDuplicateFieldFromError(err.message);
      
      if (isDuplicate && attempt < 4) {
        log(`[STEP3] Duplicate detected on field "${dupField || 'unknown'}" (attempt ${attempt + 1}) — will fetch dashboard and retry: ${err.message}`);
        
        // On first duplicate, fetch existing values
        if (attempt === 1) {
          try {
            await navigateTo(page, '/Create-App');
            await page.waitForTimeout(1000);
            const existingNames = await fetchExistingValuesFromDashboard(page, 'App Name');
            const existingCodes = await fetchExistingValuesFromDashboard(page, 'App Code');
            
            if (existingNames.length > 0 || existingCodes.length > 0) {
              // Generate new app name/code that doesn't conflict
              stamp = generateUniqueValue(generateRetryStamp(attempt), [...existingNames, ...existingCodes], attempt);
              log(`[STEP3] Generated new stamp based on dashboard values: ${stamp}`);
            }
          } catch (err2) {
            log(`[STEP3] Could not fetch dashboard values: ${err2.message}`);
          }
        }
        continue;
      }
      throw err;
    }
  }
}

// ── STEP 4: Create Template (MUST use App from Step 3) ───────────────────────
async function stepCreateTemplate(page, flowState) {
  log('Step 4: Create Template');
  if (!flowState.appName) throw new Error('Cannot create Template: appName not set from Step 3');
  
  let stamp = RUN_STAMP;
  for (let attempt = 0; attempt < 5; attempt++) {
    let audit = {}, ok = false;
    try {
      if (attempt > 0) {
        log(`[STEP4] Retry attempt ${attempt + 1} for Template creation`);
        await page.waitForTimeout(2000);
        if (attempt > 1) {
          stamp = generateRetryStamp(attempt);
          log(`[STEP4] Generated new stamp for retry: ${stamp}`);
        }
        await dismissOverlays(page).catch(() => {});
      }

      const tplName = `AUTO-TPL-${stamp}`;
      await navigateTo(page, '/Create-Template');
      await openCreateForm(page);

      for (let innerAttempt = 0; innerAttempt < 2 && !ok; innerAttempt++) {
        try {
          // ✅ MANDATORY pass 1: select App BEFORE smartFiller
          log(`[STEP4] Selecting App "${flowState.appName}" in Template form (pre-fill)`);
          await forceSelectInOffcanvas(page, flowState.appName, 'App pre-fill', true);
          await page.waitForTimeout(600);

          // SmartFiller fills text fields/codes — may override App dropdown, corrected after
          audit = await smartFillOffcanvasForm(page, 'Create-Template', null, {
            mode: 'create',
            prefilledValues: {
              Name: tplName, 'Template Name': tplName, 'Template Code': codeFromStamp('TP', stamp),
              App: flowState.appName, Application: flowState.appName, 'App Name': flowState.appName,
            },
          });

          // ✅ MANDATORY pass 2: re-confirm App AFTER smartFiller overrides
          log(`[STEP4] Re-confirming App "${flowState.appName}" after smartFiller`);
          await forceSelectInOffcanvas(page, flowState.appName, 'App re-confirm', true);
          await page.waitForTimeout(500);

          ok = true;
        } catch (err) {
          if (!/context was destroyed|navigation|frame was detached/i.test(err.message) || innerAttempt >= 1) throw err;
          log(`[STEP4] Template fill retry: ${err.message}`);
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1500);
          if (!/create.template/i.test(new URL(page.url()).pathname)) await navigateTo(page, '/Create-Template');
          await openCreateForm(page);
        }
      }

      const saveMsg = await saveOffcanvas(page);
      log(`Template save: ${saveMsg}`);
      flowState.templateName = audit['Template Name'] || audit['Name'] || tplName;
      log(`Template stored: ${flowState.templateName}`);
      return { templateName: flowState.templateName, saveMessage: saveMsg };

    } catch (err) {
      const isDuplicate = isDuplicateError(err.message);
      const dupField = extractDuplicateFieldFromError(err.message);
      
      if (isDuplicate && attempt < 4) {
        log(`[STEP4] Duplicate detected on field "${dupField || 'unknown'}" (attempt ${attempt + 1}) — will fetch dashboard and retry: ${err.message}`);
        
        // On first duplicate, fetch existing values
        if (attempt === 1) {
          try {
            await navigateTo(page, '/Create-Template');
            await page.waitForTimeout(1000);
            const existingNames = await fetchExistingValuesFromDashboard(page, 'Template Name');
            const existingCodes = await fetchExistingValuesFromDashboard(page, 'Template Code');
            
            if (existingNames.length > 0 || existingCodes.length > 0) {
              stamp = generateUniqueValue(generateRetryStamp(attempt), [...existingNames, ...existingCodes], attempt);
              log(`[STEP4] Generated new stamp based on dashboard values: ${stamp}`);
            }
          } catch (err2) {
            log(`[STEP4] Could not fetch dashboard values: ${err2.message}`);
          }
        }
        continue;
      }
      throw err;
    }
  }
}

// ── STEP 5: Create Sub-Template (MUST use Template from Step 4) ──────────────
async function stepCreateSubTemplate(page, flowState) {
  log('Step 5: Create Sub-Template');
  if (!flowState.templateName) throw new Error('Cannot create Sub-Template: templateName not set from Step 4');
  
  let stamp = RUN_STAMP;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0) {
        log(`[STEP5] Retry attempt ${attempt + 1} for Sub-Template creation`);
        await page.waitForTimeout(2000);
        if (attempt > 1) {
          stamp = generateRetryStamp(attempt);
          log(`[STEP5] Generated new stamp for retry: ${stamp}`);
        }
        await dismissOverlays(page).catch(() => {});
      }

      let found = false;
      for (const route of ['/Create-Sub-Templates', '/Sub-Template', '/Create-Sub-Template']) {
        try {
          await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(800);
          const p = new URL(page.url()).pathname.toLowerCase();
          if (p !== '/login' && p !== '/home' && p !== '/' && await page.locator('.pageTitle').count().catch(() => 0) > 0) { found = true; break; }
        } catch { /* try next */ }
      }
      if (!found) { log('Sub-Template page not found – skipping'); return { subTemplateName: '', saveMessage: 'skipped', skipped: true }; }

      await openCreateForm(page);
      const subName = `AUTO-SUBTPL-${stamp}`;

      // ✅ MANDATORY step A: select App FIRST — this populates the Template cascading dropdown
      if (flowState.appName) {
        log(`[STEP5] Selecting App "${flowState.appName}" first (cascading parent for Template)`);
        await forceSelectInOffcanvas(page, flowState.appName, 'App (cascade parent)', false);
        await page.waitForTimeout(1500); // wait for Template dropdown to be populated
      }

      // ✅ MANDATORY step B: select Template BEFORE smartFiller
      log(`[STEP5] Selecting Template "${flowState.templateName}" in Sub-Template form (pre-fill)`);
      await forceSelectInOffcanvas(page, flowState.templateName, 'Template pre-fill', true);
      await page.waitForTimeout(600);

      // SmartFiller fills remaining text fields — may override Template dropdown, corrected after
      const audit = await smartFillOffcanvasForm(page, 'Create-Sub-Templates', null, {
        mode: 'create',
        prefilledValues: {
          Name: subName, 'Sub Template Name': subName, 'Sub-Template Name': subName,
          Template: flowState.templateName, 'Template Name': flowState.templateName, 'Parent Template': flowState.templateName,
          App: flowState.appName, Application: flowState.appName, 'App Name': flowState.appName,
        },
      });

      // ✅ MANDATORY step C: re-confirm Template AFTER smartFiller overrides
      log(`[STEP5] Re-confirming Template "${flowState.templateName}" after smartFiller`);
      await forceSelectInOffcanvas(page, flowState.templateName, 'Template re-confirm', true);
      await page.waitForTimeout(500);

      const saveMsg = await saveOffcanvas(page);
      log(`Sub-Template save: ${saveMsg}`);
      flowState.subTemplateName = audit['Sub Template Name'] || audit['Name'] || subName;
      log(`Sub-Template stored: ${flowState.subTemplateName}`);
      return { subTemplateName: flowState.subTemplateName, saveMessage: saveMsg, skipped: false };

    } catch (err) {
      const isDuplicate = isDuplicateError(err.message);
      if (isDuplicate && attempt < 4) {
        const dupField = extractDuplicateFieldFromError(err.message);
        log(`[STEP5] Duplicate detected on field "${dupField || 'unknown'}" (attempt ${attempt + 1}) — will fetch dashboard and retry: ${err.message}`);
        
        // On first duplicate, fetch existing values
        if (attempt === 1) {
          try {
            // Try to find the Sub-Template list page
            for (const route of ['/Create-Sub-Templates', '/Sub-Template', '/Create-Sub-Template']) {
              try {
                await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
                await page.waitForTimeout(1000);
                const existingNames = await fetchExistingValuesFromDashboard(page, 'Sub Template Name');
                const existingCodes = await fetchExistingValuesFromDashboard(page, 'Sub-Template Code');
                
                if (existingNames.length > 0 || existingCodes.length > 0) {
                  stamp = generateUniqueValue(generateRetryStamp(attempt), [...existingNames, ...existingCodes], attempt);
                  log(`[STEP5] Generated new stamp based on dashboard values: ${stamp}`);
                }
                break;
              } catch (err2) {
                log(`[STEP5] Could not fetch from ${route}: ${err2.message}`);
              }
            }
          } catch (err2) {
            log(`[STEP5] Could not fetch dashboard values: ${err2.message}`);
          }
        }
        
        // Close the offcanvas before retrying
        await page.keyboard.press('Escape').catch(() => {});
        await dismissOverlays(page).catch(() => {});
        await page.locator('.btn-close:visible, [data-bs-dismiss="offcanvas"]:visible').first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
        continue;
      }
      // Close the offcanvas before giving up so the next step starts on a clean page
      log(`[STEP5] Error: ${err.message} — dismissing offcanvas before continuing`);
      await page.keyboard.press('Escape').catch(() => {});
      await dismissOverlays(page).catch(() => {});
      await page.locator('.btn-close:visible, [data-bs-dismiss="offcanvas"]:visible').first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      throw err;
    }
  }
}


// ── STEP 6: Assign Workflow (/Template-Workflow) ──────────────────────────────

/**
 * Scans all visible react-select inputs on the MAIN PAGE (not offcanvas),
 * types targetText, then uses Playwright locators (not CSS string eval) to click.
 */
async function pickDropdownOnPage(page, targetText, hint = '', strict = false) {
  log(`[PAGE-SELECT] Searching for "${targetText}" (${hint || 'no hint'})`);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const tgtNorm = norm(targetText);

  const inputIds = await page.evaluate(() => {
    const isVis = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null && !el.disabled;
    };
    return Array.from(document.querySelectorAll('input[id*="react-select"], input[role="combobox"]'))
      .filter(isVis)
      .map(el => el.id || '')
      .filter(Boolean);
  }).catch(() => []);

  log(`[PAGE-SELECT] Found ${inputIds.length} dropdown inputs on page`);

  for (const id of inputIds) {
    const input = page.locator(`input[id="${id}"]`).first();
    if (!await input.isVisible().catch(() => false)) continue;

    // Open and type search text
    await input.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    await input.fill('').catch(() => {});
    await input.type(targetText, { delay: 30 }).catch(() => {});
    await page.waitForTimeout(1000);

    // ── Strategy A: Playwright filter locator (exact substring match) ──────────
    // Use .filter({ hasText }) — Playwright handles special chars natively
    const allOptions = page.locator('.react-select__option, [role="option"]');

    // Try exact text first
    const exactOpt = allOptions.filter({ hasText: new RegExp(`^${targetText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
    if (await exactOpt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await exactOpt.click({ force: true });
      await page.waitForTimeout(700);
      log(`[PAGE-SELECT] ✅ Exact match clicked for "${hint}": "${targetText}"`);
      return targetText;
    }

    // Partial match: iterate visible options
    const count = await allOptions.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const opt = allOptions.nth(i);
      if (!await opt.isVisible().catch(() => false)) continue;
      const txt = (await opt.textContent().catch(() => '')).trim();
      if (!txt) continue;
      if (norm(txt).includes(tgtNorm) || tgtNorm.includes(norm(txt))) {
        await opt.click({ force: true }).catch(() => {});
        await page.waitForTimeout(700);
        log(`[PAGE-SELECT] ✅ Partial match clicked for "${hint}": "${txt}"`);
        return txt;
      }
    }

    // ── Strategy B: press Enter if dropdown is showing any option ──────────────
    const anyOpt = allOptions.first();
    if (await anyOpt.isVisible({ timeout: 500 }).catch(() => false)) {
      const txt = (await anyOpt.textContent().catch(() => '')).trim();
      if (txt && (norm(txt).includes(tgtNorm) || tgtNorm.includes(norm(txt)))) {
        await anyOpt.click({ force: true }).catch(() => {});
        await page.waitForTimeout(700);
        log(`[PAGE-SELECT] ✅ First option match for "${hint}": "${txt}"`);
        return txt;
      }
      // Enter press as last resort when text matches but element is tricky
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(700);
      const afterEnterVal = await input.inputValue().catch(() => '');
      if (afterEnterVal && norm(afterEnterVal).includes(tgtNorm)) {
        log(`[PAGE-SELECT] ✅ Enter-selected for "${hint}": "${afterEnterVal}"`);
        return afterEnterVal;
      }
    }

    // Close and try next input
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  if (strict) throw new Error(`[PAGE-SELECT] Could not find "${targetText}" (${hint}) in any page dropdown`);
  log(`[PAGE-SELECT] ⚠️ "${targetText}" not found in any page dropdown`);
  return '';
}


/**
 * Selects a value in the Nth react-select dropdown on the page (0-indexed).
 * Waits up to waitMs for that input to become enabled (for cascading dropdowns).
 */
async function pickNthDropdownOnPage(page, nth, targetText, hint = '', waitMs = 8000) {
  log(`[NTH-SELECT] Targeting dropdown #${nth} for "${targetText}" (${hint})`);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const tgtNorm = norm(targetText);

  // Wait until at least (nth+1) enabled react-select inputs exist on the page
  await page.waitForFunction((n) => {
    const isVis = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null && !el.disabled && !el.readOnly;
    };
    const inputs = Array.from(document.querySelectorAll('input[id*="react-select"], input[role="combobox"]')).filter(isVis);
    return inputs.length > n;
  }, nth, { timeout: waitMs }).catch(() => {
    log(`[NTH-SELECT] ⚠️ Timed out waiting for dropdown #${nth} to be enabled`);
  });

  // Grab the IDs of all visible enabled react-select inputs
  const inputIds = await page.evaluate(() => {
    const isVis = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null && !el.disabled && !el.readOnly;
    };
    return Array.from(document.querySelectorAll('input[id*="react-select"], input[role="combobox"]'))
      .filter(isVis)
      .map(el => el.id || '')
      .filter(Boolean);
  }).catch(() => []);

  log(`[NTH-SELECT] Available inputs: [${inputIds.join(', ')}] — picking index ${nth}`);
  const id = inputIds[nth];
  if (!id) {
    throw new Error(`[NTH-SELECT] Dropdown #${nth} not found. Found only ${inputIds.length} inputs.`);
  }

  const input = page.locator(`input[id="${id}"]`).first();

  // Open and type
  await input.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  await input.fill('').catch(() => {});
  await input.type(targetText, { delay: 30 }).catch(() => {});
  await page.waitForTimeout(1000);

  // --- Click matching option via Playwright locator ---
  const allOptions = page.locator('.react-select__option, [role="option"]');

  // Exact match first
  const exactOpt = allOptions.filter({
    hasText: new RegExp(`^${targetText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  }).first();
  if (await exactOpt.isVisible({ timeout: 1500 }).catch(() => false)) {
    await exactOpt.click({ force: true });
    await page.waitForTimeout(800);
    log(`[NTH-SELECT] ✅ Exact match for "${hint}": "${targetText}"`);
    return targetText;
  }

  // Partial match: iterate
  const count = await allOptions.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const opt = allOptions.nth(i);
    if (!await opt.isVisible().catch(() => false)) continue;
    const txt = (await opt.textContent().catch(() => '')).trim();
    if (!txt) continue;
    if (norm(txt).includes(tgtNorm) || tgtNorm.includes(norm(txt))) {
      await opt.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      log(`[NTH-SELECT] ✅ Partial match for "${hint}": "${txt}"`);
      return txt;
    }
  }

  // Last resort: Enter key
  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(700);
  const afterVal = await input.inputValue().catch(() => '');
  if (afterVal && norm(afterVal).includes(tgtNorm)) {
    log(`[NTH-SELECT] ✅ Enter-selected for "${hint}": "${afterVal}"`);
    return afterVal;
  }

  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`[NTH-SELECT] Could not select "${targetText}" in dropdown #${nth} (${hint})`);
}

async function captureWorkflowFieldSnapshot(page) {
  const snapshot = await page.evaluate(() => {
    const out = {};
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const body = document.querySelector('#offcanvas.show .offcanvas-body, .offcanvas.show .offcanvas-body');
    if (!body) return out;

    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const add = (key, value) => {
      const k = norm(key);
      const v = norm(value);
      if (!k || !v) return;
      out[k] = v;
    };

    const getFieldLabel = (el, idx, fallbackPrefix) => {
      const id = el.getAttribute('id') || '';
      const byFor = id ? body.querySelector(`label[for="${id}"]`) : null;
      if (byFor) {
        const txt = norm(byFor.textContent);
        if (txt) return txt;
      }
      const nearest = el.closest('.form-group, .mb-2, .mb-3, .col, .row, .ele, .input-group, .form-floating');
      if (nearest) {
        const lbl = nearest.querySelector('label, .form-label, .title, .field-title, .label');
        if (lbl) {
          const txt = norm(lbl.textContent);
          if (txt) return txt;
        }
      }
      const ph = norm(el.getAttribute('placeholder') || '');
      if (ph) return ph;
      return `${fallbackPrefix} ${idx + 1}`;
    };

    const textLike = Array.from(body.querySelectorAll('input[type="text"], input:not([type]), textarea, input[type="number"], input[type="email"], input[type="tel"]'));
    textLike.filter(isVisible).forEach((el, idx) => {
      const val = norm(el.value || '');
      if (!val) return;
      add(getFieldLabel(el, idx, 'Field'), val);
    });

    const selectValues = Array.from(body.querySelectorAll('select'));
    selectValues.filter(isVisible).forEach((el, idx) => {
      const selected = el.options?.[el.selectedIndex]?.textContent || '';
      const val = norm(selected || el.value || '');
      if (!val) return;
      add(getFieldLabel(el, idx, 'Select'), val);
    });

    const reactSingles = Array.from(body.querySelectorAll('.react-select__single-value, [class*="single-value"]'));
    reactSingles.filter(isVisible).forEach((el, idx) => {
      const val = norm(el.textContent || '');
      if (!val) return;
      const host = el.closest('.ele, .form-group, .mb-2, .mb-3, .row, .col, .input-group') || el.parentElement;
      let label = '';
      if (host) {
        const lbl = host.querySelector('label, .form-label, .title, .field-title, .label');
        label = norm(lbl?.textContent || '');
      }
      add(label || `Dropdown ${idx + 1}`, val);
    });

    const radios = Array.from(body.querySelectorAll('input[type="radio"]')).filter((el) => isVisible(el) && el.checked);
    radios.forEach((el, idx) => {
      const id = el.getAttribute('id') || '';
      const byFor = id ? body.querySelector(`label[for="${id}"]`) : null;
      let label = norm(byFor?.textContent || '');
      const name = norm(el.getAttribute('name') || '');
      const value = norm(el.getAttribute('value') || byFor?.textContent || 'yes');
      if (!label) label = name || `Radio ${idx + 1}`;
      add(label, value);
    });

    return out;
  }).catch(() => ({}));

  return snapshot && typeof snapshot === 'object' ? snapshot : {};
}

async function stepAssignWorkflow(page, flowState) {
  log('Step 6: Template-Workflow page');
  await navigateTo(page, '/Template-Workflow');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // 6a. Site — always the FIRST (index 0) react-select on the page
  log(`6a. Select Site: "${flowState.siteName}"`);
  const siteLabel = await pickNthDropdownOnPage(page, 0, flowState.siteName, 'Site');
  log(`Site selected: "${siteLabel}"`);
  await page.waitForTimeout(1500); // allow cascading to enable App dropdown

  // 6b. App — SECOND (index 1) react-select, enabled after Site selection
  log(`6b. Select App: "${flowState.appName}"`);
  const appLabel = await pickNthDropdownOnPage(page, 1, flowState.appName, 'App');
  log(`App selected: "${appLabel}"`);
  await page.waitForTimeout(1500); // allow cascading to enable Template dropdown

  // 6c. Template — THIRD (index 2) react-select, enabled after App selection
  log(`6c. Select Template: "${flowState.templateName}"`);
  const tplLabel = await pickNthDropdownOnPage(page, 2, flowState.templateName, 'Template');
  log(`Template selected: "${tplLabel}"`);
  await page.waitForTimeout(1000);

  // 6d. Add New
  log('6d. Click Add New');
  const addNewBtn = page.locator('button:visible', { hasText: /Add New/i }).first();
  if (!await addNewBtn.isVisible().catch(() => false)) throw new Error('"Add New" button not found');
  await addNewBtn.click({ force: true });
  const offcanvas = page.locator('#offcanvas.show .offcanvas-body, .offcanvas.show .offcanvas-body').first();
  await offcanvas.waitFor({ state: 'visible', timeout: 10000 });
  log('Workflow offcanvas opened');
  await page.waitForTimeout(800);

  // 6e. Level (first dropdown in offcanvas)
  const levelLabel = await forceSelectInOffcanvas(page, '', 'Level', false);
  log(`Level: "${levelLabel}"`);

  // 6f. Workflow Name and other text fields
  const workflowStamp = uniqueStamp(16);
  const wfName = `AUTO-WF-${workflowStamp}`;
  flowState.workflowName = wfName;
  const textInputs = offcanvas.locator('input[type="text"]:visible:not([disabled]), input:not([type]):visible:not([disabled])');
  const inputCount = await textInputs.count().catch(() => 0);
  for (let i = 0; i < inputCount; i++) {
    const inp = textInputs.nth(i);
    const ph = (await inp.getAttribute('placeholder').catch(() => '')) || '';
    const val = (await inp.inputValue().catch(() => '')) || '';
    if (val) continue;
    if (/workflow\s*name/i.test(ph) || i === 0) await inp.fill(wfName).catch(() => {});
    else if (/esign|signature|meaning/i.test(ph)) await inp.fill(`Signed-${uniqueStamp(12)}`).catch(() => {});
    else if (/status/i.test(ph)) await inp.fill('Completed').catch(() => {});
    else await inp.fill(`Auto-${uniqueStamp(12)}`).catch(() => {});
  }

  // 6g. Task Type = Input Task
  const taskTypeRadio = page.locator('#task_type_1');
  if (await taskTypeRadio.isVisible().catch(() => false)) await taskTypeRadio.click({ force: true }).catch(() => {});

  // 6h. Print = None
  const printRadio = page.locator('#is_print_0');
  if (await printRadio.isVisible().catch(() => false)) await printRadio.click({ force: true }).catch(() => {});

  // 6i. Role (pick first available)
  const roleLabel = await forceSelectInOffcanvas(page, '', 'Role', false);
  log(`Role: "${roleLabel}"`);

  // 6j. Condition Workflow = No (mandatory radio)
  const condNoRadio = page.locator('#isConditionWorkflowAvailable_no, input[name="isConditionWorkflowAvailable"][value="no"], input[name="isConditionWorkflowAvailable"][value="0"], input[name*="ConditionWorkflow"][value="no"]').first();
  if (await condNoRadio.isVisible().catch(() => false)) {
    await condNoRadio.click({ force: true }).catch(() => {});
    log('Condition Workflow = No');
  } else {
    const condLabel = page.locator('label:visible', { hasText: /^No$/i }).filter({ has: page.locator('input[type="radio"]') }).first();
    if (await condLabel.isVisible().catch(() => false)) await condLabel.click({ force: true }).catch(() => {});
  }

  // 6k. Scroll and sync
  await page.evaluate(() => {
    const oc = document.querySelector('#offcanvas.show .offcanvas-body, .offcanvas.show .offcanvas-body');
    if (oc) oc.scrollTop = oc.scrollHeight;
  }).catch(() => {});
  await syncHiddenSelects(page);
  await page.waitForTimeout(300);

  const snapshot = await captureWorkflowFieldSnapshot(page);
  flowState.workflowAuditTrail = {
    ...snapshot,
    'Workflow Name': wfName,
    Site: siteLabel || flowState.siteName,
    App: appLabel || flowState.appName,
    Template: tplLabel || flowState.templateName,
    Level: levelLabel,
    Role: roleLabel,
    'Task Type': 'Input Task',
    Print: 'None',
    'Condition Workflow': 'No',
  };
  log(`[STEP6] Captured ${Object.keys(flowState.workflowAuditTrail).length} workflow field(s) for audit comparison`);

  // 6l. Save
  log('6l. Save workflow');
  const saveBtn = page.locator('#offcanvas.show #btnSave:visible, .offcanvas.show #btnSave:visible, #offcanvas.show button[type="submit"]:visible').first();
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click({ force: true }).catch(() => {});
  } else {
    await page.locator('button[type="submit"]:visible').first().click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  await dismissOverlays(page);

  const wfSaveMsg = await page.evaluate(() => {
    for (const n of document.querySelectorAll('.swal2-title,.swal2-html-container,.toast-message,[role="alert"],.alert-success,.alert-danger')) {
      const t = (n.textContent || '').trim(); if (t) return t;
    }
    return '';
  }).catch(() => '') || 'Saved';

  log(`Workflow save: ${wfSaveMsg}`);
  return { siteLabel, appLabel, tplLabel, levelLabel, roleLabel, wfName, saveMessage: wfSaveMsg };
}

// ── STEP 7: Click top-left grid icon → /Home#AdminDashboard → select App under Site ──
async function stepSwitchAppUnderSite(page, flowState) {
  log('Step 7: Click grid icon → select App under Site');

  // Click the top-left grid icon
  const gridIcon = page.locator('i.appIcon.bi-grid-3x3-gap-fill, i.bi-grid-3x3-gap-fill, .appIcon').first();
  const gridBtn = page.locator('#divAppButton, button:has(i.bi-grid-3x3-gap-fill), a:has(i.bi-grid-3x3-gap-fill)').first();

  if (await gridBtn.isVisible().catch(() => false)) {
    await gridBtn.click({ force: true }).catch(() => {});
  } else if (await gridIcon.isVisible().catch(() => false)) {
    await gridIcon.click({ force: true }).catch(() => {});
  } else {
    throw new Error('Top-left grid icon not found');
  }

  // Wait for navigation to /Home#AdminDashboard
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  log(`Navigated to: ${page.url()}`);

  // Find the created App under the created Site on the dashboard
  // The dashboard shows Sites as headings/sections with Apps listed under them
  const norm = (s) => String(s || '').trim().toLowerCase();
  const siteNorm = norm(flowState.siteName);
  const appNorm  = norm(flowState.appName);

  // Strategy 1: find a link/element containing appName near a siteName heading
  let appClicked = false;

  // Look for the app link directly (sometimes apps are shown as cards/links)
  const appLocators = [
    page.locator(`a:visible:has-text("${flowState.appName}")`).first(),
    page.locator(`div:visible:has-text("${flowState.appName}") >> a:visible`).first(),
    page.locator(`[class*="app"]:visible:has-text("${flowState.appName}")`).first(),
    page.locator(`td:visible:has-text("${flowState.appName}")`).first(),
    page.locator(`li:visible:has-text("${flowState.appName}")`).first(),
  ];
  for (const loc of appLocators) {
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ force: true }).catch(() => {});
      appClicked = true;
      log(`Clicked app link: "${flowState.appName}"`);
      break;
    }
  }

  if (!appClicked) {
    // Strategy 2: evaluate and find by text proximity
    appClicked = await page.evaluate(({ siteText, appText }) => {
      const isVis = (el) => el && el.offsetParent !== null;
      const norm = (s) => String(s || '').toLowerCase().trim();
      // find all visible links containing appText
      const links = Array.from(document.querySelectorAll('a, button, [role="button"], [class*="app-item"], [class*="appItem"]'))
        .filter(isVis)
        .filter(el => norm(el.textContent).includes(norm(appText)));
      if (links.length === 1) { links[0].click(); return true; }
      if (links.length > 1) {
        // prefer the one closest to a heading with siteText
        for (const link of links) {
          let parent = link.parentElement;
          for (let d = 0; d < 10 && parent; d++, parent = parent.parentElement) {
            if (norm(parent.textContent).includes(norm(siteText))) { link.click(); return true; }
          }
        }
        links[0].click();
        return true;
      }
      return false;
    }, { siteText: flowState.siteName, appText: flowState.appName });
    if (appClicked) log(`Clicked app via JS: "${flowState.appName}"`);
  }

  if (!appClicked) log(`Warning: Could not click App "${flowState.appName}" on dashboard — continuing`);

  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const finalUrl = page.url();
  log(`After app switch URL: ${finalUrl}`);
  return { appClicked, finalUrl };
}

// ── STEP 8: Audit Trail → Configuration Audit Trail → Master Workflow Audit Trail ──
async function stepVerifyAuditTrail(page, flowState) {
  log('Step 8: Audit Trail verification (field-by-field)');

  const expectedAuditTrail = flowState.workflowAuditTrail && typeof flowState.workflowAuditTrail === 'object'
    ? flowState.workflowAuditTrail
    : {};
  if (!Object.keys(expectedAuditTrail).length) {
    throw new Error('No workflow field snapshot available for audit comparison.');
  }

  const verification = await verifyAuditTrailEntry(page, {
    baseURL: BASE_URL,
    masterName: 'Master-Workflow',
    operation: 'create',
    recordName: flowState.workflowName || '',
    recordID: flowState.workflowName || '',
    auditTrail: expectedAuditTrail,
    strict: true,
  });

  const comparison = verification.comparison || null;
  if (!verification.verified) {
    throw new Error(`Audit row verification failed: ${verification.reason || (verification.missing || []).join(', ') || 'unknown reason'}`);
  }
  if (!comparison) {
    throw new Error('Audit detail comparison is unavailable (no extracted field rows).');
  }
  if (!comparison.passed) {
    throw new Error(`Audit field mismatch: ${comparison.mismatchCount} mismatch/not-found out of ${comparison.totalChecked} checked.`);
  }

  log(`[AUDIT] Field comparison passed: ${comparison.matchCount}/${comparison.totalChecked} fields matched`);
  return {
    verified: true,
    matchedRow: verification.matchedRow || '',
    rowCount: comparison.totalChecked,
    comparison,
    source: verification.source || 'audit-report',
  };
}

// ── Main run() ────────────────────────────────────────────────────────────────

// Step order for resume logic
const STEP_ORDER = [
  'login', 'createSite', 'createApp', 'createTemplate',
  'createSubTemplate', 'assignWorkflow', 'selectAppUnderSite', 'auditTrail',
];

// Read resume env vars
const RESUME_FROM_STEP = process.env.RESUME_FROM_STEP || '';
const RESUME_FLOW_STATE = (() => {
  try { return process.env.RESUME_FLOW_STATE ? JSON.parse(process.env.RESUME_FLOW_STATE) : null; }
  catch { return null; }
})();
const RESUME_IDX = RESUME_FROM_STEP ? Math.max(0, STEP_ORDER.indexOf(RESUME_FROM_STEP)) : 0;

function shouldSkip(stepKey) {
  if (!RESUME_FROM_STEP) return false;
  return STEP_ORDER.indexOf(stepKey) < RESUME_IDX;
}

async function run() {
  const origLog  = console.log;
  const origWarn = console.warn;
  console.log  = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.warn = (...a) => process.stderr.write(a.join(' ') + '\n');

  let browser, context;

  const flowState = {
    appName: '', siteName: '', countryName: COUNTRY_NAME, timeZoneName: TIMEZONE_NAME,
    templateName: '', subTemplateName: '', workflowName: '',
    screenshots: [],
  };

  // Merge prefilled state from resume
  if (RESUME_FLOW_STATE) {
    Object.assign(flowState, RESUME_FLOW_STATE);
    log(`[RESUME] Starting from step "${RESUME_FROM_STEP}" with prefilled state: ${JSON.stringify(RESUME_FLOW_STATE)}`);
  }

  const steps = {
    login:              { status: 'pending', message: '' },
    createSite:         { status: 'pending', message: '' },
    createApp:          { status: 'pending', message: '' },
    createTemplate:     { status: 'pending', message: '' },
    createSubTemplate:  { status: 'pending', message: '' },
    assignWorkflow:     { status: 'pending', message: '' },
    selectAppUnderSite: { status: 'pending', message: '' },
    auditTrail:         { status: 'pending', message: '' },
  };

  // Mark skipped steps immediately
  for (const key of STEP_ORDER) {
    if (shouldSkip(key)) steps[key] = { status: 'skipped', message: `Skipped — resuming from ${RESUME_FROM_STEP}` };
  }

  try {
    browser = await chromium.launch({ headless: CFG.headless });
    const ctxOpts = { viewport: { width: 1366, height: 900 } };
    if (CFG.recordVideo) ctxOpts.recordVideo = { dir: 'test-reports', size: { width: 1280, height: 720 } };
    context = await browser.newContext(ctxOpts);
    await enableArtifactOverlayOnContext(context);
    const page = await context.newPage();
    await enableArtifactOverlayOnPage(page);

    const hasFailureSignal = (msg) => /error|fail|failed|invalid|duplicate|already exist|already in use|required|mandatory|rejected|exception/i.test(String(msg || ''));
    const hasSuccessSignal = (msg) => /success|saved|created|added|completed/i.test(String(msg || ''));
    const stepPass = (saveMessage, verified) => {
      if (!verified) return false;
      if (hasFailureSignal(saveMessage)) return false;
      return hasSuccessSignal(saveMessage);
    };

    // ── Step 1: Login (always runs — needed to authenticate) ──────────────────
    await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'login' });
    await stepLogin(page);
    steps.login = { status: 'passed', message: 'Login successful' };

    // ── Step 2: Create Site ───────────────────────────────────────────────────
    if (!shouldSkip('createSite')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'create-site' });
      try {
        const r = await stepCreateSite(page, flowState);
        const verified = await verifyRecentlyCreatedEntry(page, '/Site', flowState.siteName, 'Site');
        const status = stepPass(r.saveMessage, verified) ? 'passed' : 'failed';
        steps.createSite = {
          status,
          message: verified ? r.saveMessage : `Created value was not found in list after save. Save message: ${r.saveMessage}`,
          siteName: flowState.siteName,
          verified,
        };
        if (status !== 'passed') throw new Error(`CreateSite validation failed: ${steps.createSite.message}`);
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'createSite', e.message);
        log(`CreateSite error: ${e.message}`);
        throw e;
      }
    }

    // ── Step 3: Create App ────────────────────────────────────────────────────
    if (!shouldSkip('createApp')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'create-app' });
      try {
        const r = await stepCreateApp(page, flowState);
        const verified = await verifyRecentlyCreatedEntry(page, '/Create-App', flowState.appName, 'App');
        const status = stepPass(r.saveMessage, verified) ? 'passed' : 'failed';
        steps.createApp = {
          status,
          message: verified ? r.saveMessage : `Created value was not found in list after save. Save message: ${r.saveMessage}`,
          appName: flowState.appName,
          verified,
        };
        if (status !== 'passed') throw new Error(`CreateApp validation failed: ${steps.createApp.message}`);
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'createApp', e.message);
        log(`CreateApp error: ${e.message}`);
        throw e;
      }
    }

    // ── Step 4: Create Template ───────────────────────────────────────────────
    if (!shouldSkip('createTemplate')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'create-template' });
      try {
        const r = await stepCreateTemplate(page, flowState);
        const verified = await verifyRecentlyCreatedEntry(page, '/Create-Template', flowState.templateName, 'Template');
        const status = stepPass(r.saveMessage, verified) ? 'passed' : 'failed';
        steps.createTemplate = {
          status,
          message: verified ? r.saveMessage : `Created value was not found in list after save. Save message: ${r.saveMessage}`,
          templateName: flowState.templateName,
          verified,
        };
        if (status !== 'passed') throw new Error(`CreateTemplate validation failed: ${steps.createTemplate.message}`);
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'createTemplate', e.message);
        log(`CreateTemplate error: ${e.message}`);
        throw e;
      }
    }

    // ── Step 5: Create Sub-Template ───────────────────────────────────────────
    if (!shouldSkip('createSubTemplate')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'create-sub-template' });
      try {
        const r = await stepCreateSubTemplate(page, flowState);
        const verified = r.skipped
          ? false
          : await verifyRecentlyCreatedEntry(page, ['/Create-Sub-Templates', '/Sub-Template', '/Create-Sub-Template'], flowState.subTemplateName, 'Sub-Template');
        const status = r.skipped ? 'skipped' : (stepPass(r.saveMessage, verified) ? 'passed' : 'failed');
        steps.createSubTemplate = r.skipped
          ? { status: 'skipped', message: 'Sub-Template page not found' }
          : {
            status,
            message: verified ? r.saveMessage : `Created value was not found in list after save. Save message: ${r.saveMessage}`,
            subTemplateName: flowState.subTemplateName,
            verified,
          };
        if (!r.skipped && status !== 'passed') throw new Error(`CreateSubTemplate validation failed: ${steps.createSubTemplate.message}`);
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'createSubTemplate', e.message);
        log(`CreateSubTemplate error: ${e.message}`);
        // Navigate to a neutral page so Step 6 starts fresh (no leftover offcanvas/state)
        await page.goto(`${BASE_URL}/Home`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // ── Step 6: Assign Workflow ───────────────────────────────────────────────
    if (!shouldSkip('assignWorkflow')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'assign-workflow' });
      try {
        const r = await stepAssignWorkflow(page, flowState);
        steps.assignWorkflow = { status: hasFailureSignal(r.saveMessage) ? 'failed' : (hasSuccessSignal(r.saveMessage) ? 'passed' : 'failed'), message: r.saveMessage, wfName: flowState.workflowName };
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'assignWorkflow', e.message);
        log(`AssignWorkflow error: ${e.message}`);
      }
    }

    // ── Step 7: Switch App ────────────────────────────────────────────────────
    if (!shouldSkip('selectAppUnderSite')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'switch-app' });
      try {
        const r = await stepSwitchAppUnderSite(page, flowState);
        steps.selectAppUnderSite = { status: r.appClicked ? 'passed' : 'failed', message: r.appClicked ? `Navigated to ${r.finalUrl}` : 'Could not click App on dashboard', url: r.finalUrl };
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'selectAppUnderSite', e.message);
        log(`SwitchApp error: ${e.message}`);
      }
    }

    // ── Step 8: Audit Trail ───────────────────────────────────────────────────
    if (!shouldSkip('auditTrail')) {
      await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'running', step: 'audit-trail' });
      try {
        const r = await stepVerifyAuditTrail(page, flowState);
        const auditMsg = r.comparison
          ? `${r.comparison.matchCount}/${r.comparison.totalChecked} fields matched`
          : `Found: ${(r.matchedRow || '').slice(0, 80)}`;
        steps.auditTrail = {
          status: 'passed',
          message: auditMsg,
          verified: true,
          matchedRow: r.matchedRow || '',
          comparison: r.comparison || null,
          source: r.source || 'audit-report',
        };
      } catch (e) {
        await markStepFailedWithScreenshot(page, steps, flowState, 'auditTrail', e.message);
        log(`AuditTrail error: ${e.message}`);
      }
    }

    await updateArtifactOverlay(page, { operation: 'template-workflow', status: 'completed', step: 'done' });

    const allPassed = Object.values(steps).every(s => s.status === 'passed' || s.status === 'skipped');
    console.log = origLog; console.warn = origWarn;
    process.stdout.write(JSON.stringify({
      executedAt: new Date().toISOString(),
      resumedFrom: RESUME_FROM_STEP || null,
      status: allPassed ? 'completed' : 'completed-with-issues',
      flowState,
      steps,
    }));

  } catch (err) {
    console.log = origLog; console.warn = origWarn;
    process.stderr.write((err?.stack || err?.message || String(err)) + '\n');
    process.stdout.write(JSON.stringify({
      executedAt: new Date().toISOString(),
      resumedFrom: RESUME_FROM_STEP || null,
      status: 'failed',
      flowState,
      steps,
      error: err?.message || String(err),
    }));
  } finally {
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
  }
}

run().catch(err => {
  process.stderr.write((err?.stack || err?.message || String(err)) + '\n');
  process.exit(1);
});

