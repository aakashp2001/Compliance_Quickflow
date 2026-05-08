'use strict';

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  enableArtifactOverlayOnContext,
  enableArtifactOverlayOnPage,
  updateArtifactOverlay,
} = require('./helpers/artifactOverlay');

const SEL = {
  username: '#txtUsername',
  password: '#txtPassword',
  loginBtn: '#btnLogin',
  unlockBtn: '#btnUnlock',
  homeReady: '#divAppButton',
  userMenu: '#userMenu',
  createBtn: 'button:visible, a:visible:not(.menu-link)',
  offcanvas: '.offcanvas.show, .offcanvas-body',
};

async function captureFailureScreenshot(page, masterName, operation = 'fetch-fields') {
  if (!page || page.isClosed()) return '';

  await updateArtifactOverlay(page, {
    masterName: String(masterName || '').trim(),
    operation,
    status: 'failed',
    step: 'failure',
  });
  await page.waitForTimeout(120).catch(() => { });

  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
  const opSlug = String(operation || 'op').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'op';
  const fileName = `${stamp}-${masterSlug}-${opSlug}-failure.png`;
  const fullPath = path.join(dir, fileName);

  await page.screenshot({ path: fullPath, fullPage: true }).catch(() => { });
  return fs.existsSync(fullPath) ? fullPath : '';
}

async function getQuickFlowError(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const nodes = Array.from(document.querySelectorAll('.swal2-popup, .modal.show, [role="dialog"], .alert-danger'))
      .filter(isVisible);

    for (const node of nodes) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      const title = String(
        node.querySelector('.swal2-title, .modal-title, h1, h2, h3, h4, .title')?.textContent || ''
      ).replace(/\s+/g, ' ').trim();
      const hasErrorIcon = !!node.querySelector('.swal2-error, .swal2-icon.swal2-error, .text-danger, .fa-circle-xmark, .fa-times-circle');

      if (!text) continue;
      if (!hasErrorIcon && /are you sure|confirm|yes|ok|cancel|close/i.test(text) && !/does not exist|does not exists|error|failed|unable|exception|not found/i.test(text)) {
        continue;
      }

      if (hasErrorIcon || /does not exist|does not exists|object .* does not|error|failed|unable|exception|not found|sql/i.test(text)) {
        return { title, message: text };
      }
    }

    return null;
  }).catch(() => null);
}

async function throwIfQuickFlowError(page, masterName, stage) {
  const errorInfo = await getQuickFlowError(page);
  if (!errorInfo) return;

  const screenshotPath = await captureFailureScreenshot(page, masterName, 'fetch-fields').catch(() => '');
  const detail = errorInfo.title && !errorInfo.message.includes(errorInfo.title)
    ? `${errorInfo.title}: ${errorInfo.message}`
    : errorInfo.message;
  const marker = screenshotPath ? `\n[FAIL_SCREENSHOT] ${screenshotPath}` : '';
  throw new Error(`QuickFlow error during ${stage}: ${detail}${marker}`);
}

function buildCandidates(loginUrl) {
  const normalized = loginUrl || 'https://ipdev.quickflow.in/login';
  const base = new URL(normalized).origin;
  return [normalized, `${base}/`, base];
}

async function openLoginPage(page, loginUrl) {
  const candidates = buildCandidates(loginUrl);

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.locator(SEL.username).waitFor({ state: 'visible', timeout: 10000 });
      return;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Could not open login page using: ${candidates.join(', ')}`);
}

async function login(page, { loginUrl, username, password }) {
  await openLoginPage(page, loginUrl);
  await throwIfQuickFlowError(page, '', 'login page load');
  await page.fill(SEL.username, username);
  await page.fill(SEL.password, password);
  await page.click(SEL.loginBtn);

  await page.waitForTimeout(1200);

  const unlockVisible = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
  if (unlockVisible) {
    await page.click(SEL.unlockBtn);
    await page.waitForTimeout(800);
  }

  let authenticated = false;

  try {
    await page.locator(SEL.homeReady).first().waitFor({ state: 'visible', timeout: 45000 });
    authenticated = true;
  } catch {
    // Fall through to alternate auth indicators.
  }

  if (!authenticated) {
    try {
      await page.locator(SEL.userMenu).first().waitFor({ state: 'visible', timeout: 15000 });
      authenticated = true;
    } catch {
      // Fall through to final check.
    }
  }

  if (!authenticated) {
    try {
      await page.locator(SEL.username).waitFor({ state: 'hidden', timeout: 10000 });
      authenticated = true;
    } catch {
      // Ignore and throw clearer error below.
    }
  }

  if (!authenticated) {
    throw new Error('Login did not reach an authenticated state in time');
  }

  await throwIfQuickFlowError(page, '', 'login');
}

async function openMasterAndForm(page, baseURL, masterName) {
  const href = `/${masterName}`;
  await page.goto(`${baseURL}${href}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => { });
  await throwIfQuickFlowError(page, masterName, 'master navigation');

  // Some masters auto-open their form on landing (e.g. User).
  const alreadyOpen = await page
    .locator('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body')
    .first()
    .isVisible()
    .catch(() => false);

  if (alreadyOpen) {
    await throwIfQuickFlowError(page, masterName, 'master form open');
    return;
  }

  const createAction = page.locator(SEL.createBtn, { hasText: /^\s*Create\s*$/ }).first();

  await createAction.waitFor({ state: 'visible', timeout: 30000 });
  await createAction.click();
  await throwIfQuickFlowError(page, masterName, 'create click');
  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });

  // Wait for the AJAX call triggered by opening the form to settle
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

  // Wait for at least one .ele field to appear in the offcanvas
  await page.waitForSelector('.offcanvas-body .ele', { timeout: 15000 }).catch(() => { });

  // Wait for window.data (form metadata) to be populated by the app
  await page.waitForFunction(
    () => window.data != null && (Array.isArray(window.data.tblFormDtl) || Array.isArray(window.data.tblFormSubDtl)),
    { timeout: 10000 }
  ).catch(() => { });

  await page.waitForTimeout(500);
  await throwIfQuickFlowError(page, masterName, 'form metadata load');
}

async function getFields(page) {
  return page.evaluate(() => {
    const normalizeControlType = (rawType, item = {}) => {
      const raw = String(rawType || '').trim();
      const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isMulti = ['y', 'yes', 'true', '1'].includes(
        String(item.isMultiSelect ?? item.cMultiSelect ?? item.bMultiSelect ?? item.multiSelect ?? '').toLowerCase()
      );

      if (!normalized) return '';
      if (normalized === 'textarea' || normalized === 'editor') return normalized;
      if (normalized === 'text' || normalized === 'password' || normalized === 'encryptedtext') return normalized;
      if (normalized === 'email' || normalized === 'emailto') return 'email';
      if (normalized === 'tel' || normalized === 'phone' || normalized === 'mobile') return 'tel';
      if (normalized === 'number' || normalized === 'numeric' || normalized === 'integer') return 'number';
      if (normalized === 'decimal' || normalized === 'float' || normalized === 'double' || normalized === 'decimalfieldcontroller') return 'decimal';
      if (normalized === 'date') return 'date';
      if (normalized === 'time') return 'time';
      if (normalized === 'datetime' || normalized === 'dateandtime' || normalized === 'serverdatetime' || normalized === 'approvedatetime') return 'dateandtime';
      if (normalized === 'radio') return 'radio';
      if (normalized === 'checkbox' || normalized === 'checkboxlist') return 'checkbox';
      if (normalized === 'multiselect') return 'multiselect';
      if (normalized === 'select' || normalized === 'dropdown' || normalized === 'combobox' || normalized === 'optionlist' || normalized === 'lookup') {
        return isMulti ? 'multiselect' : 'select';
      }
      if (normalized === 'file' || normalized === 'emailattachment') return 'file';
      return raw.toLowerCase();
    };

    const detectElementTypeFromDom = (el) => {
      const tag = (el.tagName || '').toLowerCase();
      const className = el.getAttribute('class') || '';
      const inputType = (el.getAttribute('type') || '').toLowerCase();

      if (tag === 'input') {
        if (inputType === 'radio') return 'radio';
        if (inputType === 'checkbox') return 'checkbox';
        if (inputType === 'email') return 'email';
        if (inputType === 'tel') return 'tel';
        if (inputType === 'password') return 'password';
        if (inputType === 'time') return 'time';
        if (inputType === 'date') return 'date';
        if (inputType === 'datetime-local') return 'dateandtime';
        if (inputType === 'number') return 'number';
        if (className.includes('numeric')) return 'number';
        if (className.includes('datetimepicker-input')) return 'date';
        if (
          el.matches('[role="combobox"], [aria-autocomplete]') ||
          el.closest('.react-select__control, .select2, .select2-container, [role="combobox"]')
        ) {
          return 'select';
        }
        return 'text';
      }

      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return el.multiple ? 'multiselect' : 'select';
      if (tag === 'div' && className.includes('checkboxlist')) return 'checkbox';
      if (
        tag === 'div' &&
        (el.querySelector('input[aria-autocomplete], input[role="combobox"], .react-select__input input') ||
          className.includes('react-select') ||
          className.includes('select2') ||
          className.includes('container'))
      ) {
        return 'select';
      }

      return tag || 'text';
    };

    const combined = [
      ...(window.data?.tblFormDtl || []),
      ...(window.data?.tblFormSubDtl || []),
    ];

    const metaById = new Map();
    const metaByColName = new Map();
    for (const item of combined) {
      const id = `${item.vColName}${item.iFormDtlId}`;
      const controlType = normalizeControlType(
        item.vControlType || item.cControlType || item.controlType || item.vElementType || item.vType,
        item
      );

      metaById.set(id, {
        displayName: item.vDisplayName || id,
        maxLength: Number(item.iMaxLength || item.vMaxLength || 0) || 0,
        required: String(item.cMandatory || item.isMandatory || '').toUpperCase() === 'Y',
        controlType,
      });

      if (item.vColName) {
        metaByColName.set(String(item.vColName), {
          displayName: item.vDisplayName || String(item.vColName),
          maxLength: Number(item.iMaxLength || item.vMaxLength || 0) || 0,
          required: String(item.cMandatory || item.isMandatory || '').toUpperCase() === 'Y',
          controlType,
        });
      }
    }

    const fields = [];
    const offcanvasBody = document.querySelector(
      '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body'
    ) || document.querySelector('.offcanvas-body');

    if (!offcanvasBody) {
      return fields;
    }

    let elements = Array.from(offcanvasBody.querySelectorAll('.ele'));
    let usingFallback = false;

    // Fallback for masters where fields are not marked with .ele wrappers.
    // Instead of scanning individual inputs (which misses <select> siblings),
    // scan form-group containers and pick the primary control from each.
    if (!elements.length) {
      usingFallback = true;

      // Collect all form-group-like containers inside the offcanvas
      const groups = Array.from(offcanvasBody.querySelectorAll(
        '.form-group, .mb-3, .fv-row, [class*="col-"]'
      )).filter((g) => {
        // Only keep leaf groups that directly contain a control
        return g.querySelector(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, .form-check-input, .form-switch, [role="combobox"], .react-select__control, div.checkboxlist'
        );
      });

      // From each group, pick the best representative control element
      for (const group of groups) {
        // Priority order: select > textarea > react-select > checkboxlist > toggle > input
        const ctrl =
          group.querySelector('select') ||
          group.querySelector('textarea') ||
          group.querySelector('.react-select__control, [role="combobox"]') ||
          group.querySelector('div.checkboxlist') ||
          group.querySelector('.form-switch, .form-check') ||
          group.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
        if (ctrl && !elements.includes(ctrl)) {
          elements.push(ctrl);
        }
      }

      // Deduplicate: if a group yielded the same element twice, keep first
      elements = [...new Set(elements)];
    }

    const guessLabel = (node, fallback) => {
      // Walk up to the nearest form group container
      const formGroup = node.closest('.form-group, .mb-3, .fv-row, [class*="col-"]');
      if (formGroup) {
        const label = formGroup.querySelector('label, .form-label, .control-label');
        const text = (label?.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      // Try direct label association
      const directLabel = node.closest('label');
      if (directLabel) {
        const text = (directLabel.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      // Try aria-label or placeholder as last resort
      const ariaLabel = node.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      const placeholder = node.getAttribute('placeholder') || '';
      if (placeholder) {
        // Convert "Please Select Location" → "Location", "Enter username" → "username"
        return placeholder.replace(/^(please\s+)?(select|enter|choose|type)\s+/i, '').trim() || placeholder;
      }
      return fallback;
    };

    // Helper to detect type from a form-group container (for fallback mode)
    const detectTypeFromContainer = (el) => {
      const tag = (el.tagName || '').toLowerCase();
      const className = el.getAttribute('class') || '';

      // Native select
      if (tag === 'select') return el.multiple ? 'multiselect' : 'select';
      // Textarea
      if (tag === 'textarea') return 'textarea';
      // Checkbox list
      if (tag === 'div' && className.includes('checkboxlist')) return 'checkbox';
      // Toggle / form-switch / form-check (like Active Directory User)
      if (className.includes('form-switch') || className.includes('form-check')) {
        const input = el.querySelector('input[type="checkbox"]');
        if (input) return 'checkbox';
        const radio = el.querySelector('input[type="radio"]');
        if (radio) return 'radio';
        return 'checkbox';
      }
      // React Select / custom combobox
      if (
        className.includes('react-select') ||
        el.matches('[role="combobox"]') ||
        el.querySelector?.('.react-select__control, [role="combobox"]')
      ) {
        return 'select';
      }
      // Fall through to standard DOM detection
      return detectElementTypeFromDom(el);
    };

    for (let idx = 0; idx < elements.length; idx++) {
      const el = elements[idx];
      const tag = (el.tagName || '').toLowerCase();
      const id = el.getAttribute('id') || el.getAttribute('name') || `field_${idx + 1}`;
      const className = el.getAttribute('class') || '';
      const inputType = el.getAttribute('type') || '';
      const disabled = !!el.disabled;
      const maxLengthAttr = Number(el.getAttribute('maxlength') || 0) || 0;

      const meta = metaById.get(id) || metaByColName.get(id) || {};
      const metaType = normalizeControlType(meta.controlType || '', meta);
      const domType = usingFallback ? detectTypeFromContainer(el) : detectElementTypeFromDom(el);
      const elementType = metaType || domType;
      const displayName = meta.displayName || guessLabel(el, id || `field_${idx + 1}`);

      const options = [];
      if (elementType === 'select' || elementType === 'multiselect') {
        // Collect from native <select> options
        const optionHost = tag === 'select' ? el : el.querySelector('select');
        Array.from((optionHost || el).querySelectorAll('option')).forEach((opt) => {
          if (opt.value && opt.value !== '-1' && opt.value !== '') {
            options.push({ value: opt.value, label: (opt.textContent || '').trim() });
          }
        });
      }

      fields.push({
        idx,
        id,
        displayName,
        elementType,
        disabled,
        required: !!meta.required,
        maxLength: Math.max(maxLengthAttr, meta.maxLength || 0),
        options,
      });
    }

    // De-duplicate by id+type; keep first occurrence.
    const seen = new Set();
    return fields.filter((f) => {
      const key = `${f.id}::${f.elementType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

async function detectDependencies(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const offcanvasBody = document.querySelector(
      '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body'
    ) || document.querySelector('.offcanvas-body');
    if (!offcanvasBody) return { parentDropdowns: [], dependentDropdowns: [] };

    const parentDropdowns = [];
    const dependentDropdowns = [];

    // Collect all select-like fields visible in the form
    const selectLike = Array.from(offcanvasBody.querySelectorAll(
      'select, .react-select__control, [role="combobox"], .select2-container'
    )).filter(isVisible);

    for (const el of selectLike) {
      // Resolve label for this control
      const group = el.closest('.form-group, .mb-3, .fv-row, [class*="col-"]');
      const labelEl = group?.querySelector('label, .form-label, .control-label');
      const labelText = (labelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!labelText) continue;

      // Count available options
      let optionCount = 0;
      const tag = (el.tagName || '').toLowerCase();

      if (tag === 'select') {
        // Native select: count non-empty, non-placeholder options
        optionCount = Array.from(el.options).filter(
          (o) => o.value && o.value !== '-1' && o.value !== '0' && o.value !== ''
        ).length;
      } else {
        // React-select / select2: count visible option indicators
        const container = el.closest('.react-select, [class*="select2"]') || el.parentElement;
        const singleVal = container?.querySelector('.react-select__single-value, .select2-selection__rendered, .select2-selection__placeholder');
        // For custom selects with no loaded options we look for placeholder-only state
        const placeholder = container?.querySelector('.react-select__placeholder, .select2-selection__placeholder');
        const hasSingleValue = singleVal && !/select|choose|--/i.test(singleVal.textContent || '');

        // Check if it's disabled or read-only (dependent fields often start disabled)
        const isDisabled = el.disabled
          || el.getAttribute('aria-disabled') === 'true'
          || !!el.closest('[class*="disabled"], [disabled]');

        if (isDisabled) {
          optionCount = 0; // treat disabled as dependent
        } else {
          optionCount = hasSingleValue ? 1 : 0;
        }
      }

      // A field that starts with NO options = dependent (populated by parent)
      // A field that starts WITH options = parent
      if (optionCount === 0) {
        dependentDropdowns.push(labelText);
      } else {
        parentDropdowns.push(labelText);
      }
    }

    return { parentDropdowns, dependentDropdowns };
  }).catch(() => ({ parentDropdowns: [], dependentDropdowns: [] }));
}

async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const masterName = process.env.QT_MASTER || '';
  const headless = String(process.env.QT_HEADLESS || 'true').toLowerCase() !== 'false';
  const recordVideo = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';

  if (!masterName) {
    throw new Error('QT_MASTER is required');
  }

  let browser;
  let context;

  try {
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
    const page = await context.newPage();
    await enableArtifactOverlayOnPage(page);
    await updateArtifactOverlay(page, {
      masterName,
      operation: 'fetch-fields',
      status: 'running',
      step: 'login',
    });

    await login(page, { loginUrl, username, password });
    const baseURL = new URL(page.url()).origin;

    await updateArtifactOverlay(page, {
      masterName,
      operation: 'fetch-fields',
      status: 'running',
      step: 'open-master-form',
    });
    await openMasterAndForm(page, baseURL, masterName);
    await throwIfQuickFlowError(page, masterName, 'field fetch start');

    await updateArtifactOverlay(page, {
      masterName,
      operation: 'fetch-fields',
      status: 'running',
      step: 'extract-fields',
    });
    const fields = await getFields(page);
    await throwIfQuickFlowError(page, masterName, 'field extraction');
    const detectedDependencies = await detectDependencies(page);

    await updateArtifactOverlay(page, {
      masterName,
      operation: 'fetch-fields',
      status: 'completed',
      step: 'done',
    });

    const payload = {
      master: masterName,
      fetchedAt: new Date().toISOString(),
      fields,
      detectedDependencies,
    };

    process.stdout.write(JSON.stringify(payload));
  } finally {
    if (context) {
      await context.close().catch(() => { });
    }
    if (browser) {
      await browser.close().catch(() => { });
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(error?.message || 'Failed to fetch fields');
    process.exit(1);
  });
}

module.exports = {
  login,
  openMasterAndForm,
  getFields,
  detectDependencies,
  throwIfQuickFlowError,
};
