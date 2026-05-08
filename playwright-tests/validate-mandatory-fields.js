'use strict';

/**
 * validate-mandatory-fields.js
 *
 * Opens a master's Create form, clicks Save with all fields empty, then
 * collects every validation error message and the field it belongs to.
 *
 * Env vars:
 *   QT_URL, QT_USER, QT_PASS, QT_MASTER, QT_HEADLESS
 *
 * Writes JSON to stdout:
 * {
 *   master: string,
 *   totalFields: number,
 *   mandatoryFields: [{ fieldName, displayName, errorMessage, fieldType }],
 *   optionalFields:  [{ fieldName, displayName, fieldType }],
 *   validationWorking: boolean,   // true if at least one error appeared
 *   screenshotPath: string,
 *   testedAt: string
 * }
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  enableArtifactOverlayOnContext,
  enableArtifactOverlayOnPage,
  updateArtifactOverlay,
} = require('./helpers/artifactOverlay');

// ── Helpers ────────────────────────────────────────────────────────────────────

async function login(page, { loginUrl, username, password }) {
  const base = new URL(loginUrl || 'https://ipdev.quickflow.in/login').origin;
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtUsername', { timeout: 30000 });
  await page.waitForTimeout(500);

  await page.fill('#txtUsername', username);
  await page.fill('#txtPassword', password);
  await page.click('#btnLogin');
  await page.waitForTimeout(1000);

  // Handle unlock screen if present
  const unlock = await page.locator('#btnUnlock').isVisible().catch(() => false);
  if (unlock) {
    await page.click('#btnUnlock');
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector('#divAppButton', { timeout: 30000 });
  console.warn('[MAND] ✓ Logged in');
}

async function navigateTo(page, masterName, baseURL) {
  const slug = String(masterName || '').trim().replace(/\s+/g, '-');
  const url = `${baseURL}/${slug}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
  console.warn(`[MAND] ✓ Navigated to ${url}`);
}

async function openCreateForm(page) {
  const formBody = page.locator('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body').first();

  const alreadyOpen = await formBody.isVisible().catch(() => false);
  if (alreadyOpen) {
    console.warn('[MAND] Create form already open');
    return;
  }

  const candidates = [
    page.locator('button.btn.btn-sm.btn-primary.d-flex.flex-center').first(),
    page.locator('button.btn.btn-primary:visible:has(.fa-plus)').first(),
    page.locator('button.btn.btn-primary:visible', { hasText: /Create/i }).first(),
    page.locator('button:visible:not([disabled])', { hasText: /^\s*Create\s*$/i }).first(),
    page.locator('#btnAdd:visible').first(),
    page.locator('button:visible:not([disabled])', { hasText: /^\s*Add\s*$/i }).first(),
  ];

  let opened = false;
  let lastError = '';

  for (let round = 0; round < 3 && !opened; round++) {
    for (const target of candidates) {
      const visible = await target.isVisible().catch(() => false);
      if (!visible) continue;

      try {
        await target.click({ timeout: 5000 });
      } catch (error) {
        lastError = error?.message || String(error);
        await target.click({ timeout: 4000, force: true }).catch(() => { });
      }

      opened = await formBody.waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true)
        .catch(() => false);

      if (opened) break;
    }
  }

  if (!opened) {
    throw new Error(`Create button click did not open form. ${lastError}`.trim());
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
  await page.waitForSelector('.offcanvas-body .ele', { timeout: 15000 }).catch(() => { });
  await page.waitForTimeout(1000);
  console.warn('[MAND] ✓ Clicked Create and opened form');
}

async function clickSaveEmpty(page) {
  // Try #btnSave first
  let saveBtn = page.locator('#btnSave').first();
  let canClick = await saveBtn.isVisible({ timeout: 3000 }).catch(() => false);
  // Special case: Archive master uses #btnArchive
  const pageUrl = page.url ? await page.url() : '';
  if (!canClick && /\/Archive(\b|$)/i.test(pageUrl)) {
    saveBtn = page.locator('#btnArchive').first();
    canClick = await saveBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (canClick) {
      console.warn('[MAND] Found #btnArchive for Archive master');
    }
  }
  // Fallback: any visible submit button in .offcanvas-body
  if (!canClick) {
    saveBtn = page.locator('.offcanvas-body button[type="submit"]:visible').first();
    canClick = await saveBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (canClick) {
      console.warn('[MAND] Found generic submit button in .offcanvas-body');
    }
  }
  // Fallback: Save/Submit text
  if (!canClick) {
    saveBtn = page.locator('button:not([disabled]):has-text("Save"), button:not([disabled]):has-text("Submit")').first();
    canClick = await saveBtn.isVisible({ timeout: 3000 }).catch(() => false);
  }
  if (!canClick) {
    throw new Error('Save button not visible after opening Create form');
  }
  await saveBtn.click({ force: true });
  await page.waitForTimeout(1500); // let validation render
  console.warn('[MAND] ✓ Clicked Save on empty form');
}

// ── Core scraper ───────────────────────────────────────────────────────────────

async function scrapeFieldValidation(page) {
  return page.evaluate(() => {
    const offcanvas = document.querySelector(
      '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body, [role="dialog"] .modal-body'
    ) || document.body;

    const isVisible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    };

    // Collect concrete controls first so we can read required/data-val metadata reliably.
    const controls = Array.from(offcanvas.querySelectorAll('input, select, textarea'))
      .filter((el) => isVisible(el))
      .filter((el) => !el.disabled)
      .filter((el) => {
        const tag = (el.tagName || '').toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' && ['hidden', 'button', 'submit', 'reset'].includes(type)) return false;
        return true;
      });

    const seenKeys = new Set();
    const results = [];

    for (const control of controls) {
      const type = (control.getAttribute('type') || '').toLowerCase();
      const fieldId = control.id || control.name || '';
      const key = `${control.tagName}:${fieldId}:${type}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const container = control.closest('.ele, .form-group, .row, .col, .mb-3, .input-group') || control.parentElement || offcanvas;
      const labelEl = (fieldId ? offcanvas.querySelector(`label[for="${fieldId}"]`) : null)
        || container.querySelector('label')
        || (control.previousElementSibling && control.previousElementSibling.matches('label') ? control.previousElementSibling : null);

      const labelText = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const displayName = (labelText || control.getAttribute('placeholder') || control.getAttribute('name') || fieldId || '').replace(/\s*\*\s*$/, '').trim();

      const isRequiredAttr = control.required === true || String(control.getAttribute('aria-required') || '').toLowerCase() === 'true';
      const dataValRequired = (control.getAttribute('data-val-required') || '').trim();
      const hasDataVal = String(control.getAttribute('data-val') || '').toLowerCase() === 'true';
      const classSuggestsMandatory = /required|mandatory/i.test(control.className || '') || /required|mandatory/i.test(container.className || '');
      const labelSuggestsMandatory = /\*/.test(labelText)
        || !!(labelEl && labelEl.classList && (labelEl.classList.contains('required') || labelEl.classList.contains('mandatory')))
        || /required|mandatory/i.test(labelText);

      let fieldType = (control.tagName || '').toLowerCase();
      if (fieldType === 'input') fieldType = type || 'text';

      const errorSelectors = [
        '.invalid-feedback', '.text-danger', '.field-error', '.error-message',
        '.fv-plugins-message-container', '[class*="validation"]', '[class*="error"]',
        '.form-text.text-danger', 'small.text-danger', 'span.text-danger', '[data-valmsg-for]'
      ];
      const errors = [];
      for (const sel2 of errorSelectors) {
        for (const node of Array.from(container.querySelectorAll(sel2))) {
          if (!isVisible(node)) continue;
          const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && !errors.includes(t)) errors.push(t);
        }
      }

      const describedBy = control.getAttribute('aria-describedby');
      if (describedBy) {
        for (const id of describedBy.split(/\s+/).filter(Boolean)) {
          const descNode = document.getElementById(id);
          if (descNode && isVisible(descNode)) {
            const t = (descNode.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && !errors.includes(t)) errors.push(t);
          }
        }
      }

      if (dataValRequired && !errors.includes(dataValRequired)) {
        errors.push(dataValRequired);
      }

      const isMandatory = errors.length > 0
        || isRequiredAttr
        || (!!dataValRequired && hasDataVal)
        || classSuggestsMandatory
        || labelSuggestsMandatory;

      results.push({
        fieldId,
        displayName: displayName || fieldId || `field-${results.length + 1}`,
        fieldType,
        errors,
        isMandatory,
        labelSuggestsMandatory: !!labelSuggestsMandatory,
      });
    }

    // Also check for global SweetAlert / toast errors
    const globalErrors = [];
    for (const sel3 of ['.swal2-popup .swal2-content', '.toast-message', '.alert-danger']) {
      const node = document.querySelector(sel3);
      if (node && isVisible(node)) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) globalErrors.push(t);
      }
    }

    return { fields: results, globalErrors };
  });
}

// ── Screenshot ─────────────────────────────────────────────────────────────────

async function screenshot(page, masterName) {
  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(dir, `${stamp}-${slug}-mandatory.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => { });
  return fs.existsSync(file) ? file : '';
}

async function captureReportScreenshot(page, masterName, operation = 'mandatory-check', status = 'passed', step = 'complete') {
  if (!page || page.isClosed()) return '';

  await updateArtifactOverlay(page, {
    masterName: String(masterName || '').trim(),
    operation,
    status,
    step,
  });
  await page.waitForTimeout(120).catch(() => { });

  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
  const opSlug = String(operation || 'mandatory-check').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'mandatory-check';
  const statusSlug = String(status || 'passed').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'passed';
  const stepSlug = String(step || 'step').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'step';
  const file = path.join(dir, `${stamp}-${masterSlug}-${opSlug}-${statusSlug}-${stepSlug}.png`);

  await page.screenshot({ path: file, fullPage: true }).catch(() => { });
  return fs.existsSync(file) ? file : '';
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const masterName = process.env.QT_MASTER || '';
  const headless = String(process.env.QT_HEADLESS || 'false').toLowerCase() !== 'false';
  const recordVideo = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';

  if (!masterName) throw new Error('QT_MASTER is required');

  // Redirect console.log to stderr so stdout stays clean JSON
  const origLog = console.log;
  console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.warn = (...a) => process.stderr.write(a.join(' ') + '\n');

  let browser, context, page;
  let currentStep = 'launch-browser';
  try {
    currentStep = 'launch-browser';
    browser = await chromium.launch({ headless });
    const contextOptions = {
      viewport: { width: 1366, height: 900 },
    };
    if (recordVideo) {
      contextOptions.recordVideo = {
        dir: 'test-reports',
        size: { width: 1280, height: 720 },
      };
    }
    context = await browser.newContext(contextOptions);
    await enableArtifactOverlayOnContext(context);
    page = await context.newPage();
    await enableArtifactOverlayOnPage(page);
    await updateArtifactOverlay(page, {
      masterName,
      operation: 'mandatory-check',
      status: 'running',
      step: currentStep,
    });

    const baseURL = new URL(loginUrl).origin;

    currentStep = 'login';
    await login(page, { loginUrl, username, password });
    currentStep = 'navigate-master';
    await navigateTo(page, masterName, baseURL);
    currentStep = 'open-create-form';
    await openCreateForm(page);
    currentStep = 'save-empty-form';
    await clickSaveEmpty(page);

    currentStep = 'scrape-validations';
    const { fields, globalErrors } = await scrapeFieldValidation(page);
    const validationWorking = fields.filter((f) => f.isMandatory).length > 0;
    currentStep = validationWorking ? 'validation-detected' : 'validation-not-detected';
    const screenshotPath = await captureReportScreenshot(
      page,
      masterName,
      'mandatory-check',
      validationWorking ? 'passed' : 'failed',
      currentStep,
    ) || await screenshot(page, masterName);

    const mandatoryFields = fields
      .filter((f) => f.isMandatory)
      .map((f) => ({
        fieldName: f.fieldId,
        displayName: f.displayName,
        fieldType: f.fieldType,
        errorMessage: f.errors[0] || 'Required',
        allErrors: f.errors,
      }));

    const optionalFields = fields
      .filter((f) => !f.isMandatory)
      .map((f) => ({
        fieldName: f.fieldId,
        displayName: f.displayName,
        fieldType: f.fieldType,
      }));

    const result = {
      master: masterName,
      totalFields: fields.length,
      mandatoryFields,
      optionalFields,
      globalErrors,
      validationWorking,
      screenshotPath,
      testedAt: new Date().toISOString(),
    };

    await updateArtifactOverlay(page, {
      masterName,
      operation: 'mandatory-check',
      status: validationWorking ? 'passed' : 'failed',
      step: currentStep,
    });

    console.log = origLog;
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const failShot = await captureReportScreenshot(
      page,
      masterName,
      'mandatory-check',
      'failed',
      currentStep,
    ).catch(() => '');
    const detail = String(error?.stack || error?.message || error || 'Mandatory fields validation failed').trim();
    if (failShot) {
      throw new Error(`${detail}\n[FAIL_SCREENSHOT] ${failShot}`);
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
  }
}

run().catch((err) => {
  process.stderr.write(String(err?.stack || err?.message || err));
  process.exit(1);
});
