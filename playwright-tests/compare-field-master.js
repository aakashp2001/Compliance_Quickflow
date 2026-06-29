'use strict';

/**
 * compare-field-master.js
 *
 * Opens the source master's Create form, extracts dropdown options for
 * the given select field, then navigates to the target master and scrapes
 * its table data.  Returns a JSON comparison on stdout.
 *
 * Env vars:
 *   QT_URL, QT_USER, QT_PASS
 *   QT_MASTER        – source master (the form that contains the select field)
 *   QT_FIELD_ID      – element id of the select field
 *   QT_FIELD_INDEX   – fallback: 0-based index among .ele elements
 *   QT_TARGET_MASTER – master whose table data to compare against
 *   QT_HEADLESS      – "true" / "false"
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  enableArtifactOverlayOnContext,
  enableArtifactOverlayOnPage,
  updateArtifactOverlay,
} = require('./helpers/artifactOverlay');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

async function captureReportScreenshot(page, masterName, operation = 'compare-field', status = 'passed', step = 'complete') {
  if (!page || page.isClosed()) return '';

  await updateArtifactOverlay(page, {
    masterName: String(masterName || '').trim(),
    operation,
    status,
    step,
  });
  await page.waitForTimeout(120).catch(() => {});

  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
  const opSlug = String(operation || 'compare-field').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'compare-field';
  const statusSlug = String(status || 'passed').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'passed';
  const stepSlug = String(step || 'step').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'step';
  const file = path.join(dir, `${stamp}-${masterSlug}-${opSlug}-${statusSlug}-${stepSlug}.png`);

  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return fs.existsSync(file) ? file : '';
}

function normalizeLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let dependencyConfigCache = null;
let dependencyConfigPromise = null;

async function loadDependencyConfig() {
  if (dependencyConfigCache) return dependencyConfigCache;
  if (!dependencyConfigPromise) {
    dependencyConfigPromise = (async () => {
      const res = await fetch(`${BACKEND_URL}/api/dependency-config`);
      if (!res.ok) {
        throw new Error(`GET /api/dependency-config -> HTTP ${res.status}`);
      }
      const body = await res.json();
      const config = body && typeof body.config === 'object' && body.config ? body.config : {};
      dependencyConfigCache = config;
      return config;
    })();
  }
  try {
    return await dependencyConfigPromise;
  } catch (error) {
    dependencyConfigPromise = null;
    throw error;
  }
}

async function getMasterDependencyConfig(masterName) {
  const config = await loadDependencyConfig();
  const target = normalizeLabel(masterName);
  if (!target) return { parentDropdowns: [], dependentDropdowns: [] };

  const key = Object.keys(config).find((candidate) => normalizeLabel(candidate) === target);
  const found = key ? config[key] : null;
  if (!found || typeof found !== 'object') {
    return { parentDropdowns: [], dependentDropdowns: [] };
  }

  return {
    parentDropdowns: Array.isArray(found.parentDropdowns) ? found.parentDropdowns : [],
    dependentDropdowns: Array.isArray(found.dependentDropdowns) ? found.dependentDropdowns : [],
  };
}

function isConfiguredDependentField(cfg, fieldName, fieldId) {
  const probeList = [fieldName, fieldId].map(normalizeLabel).filter(Boolean);
  if (!probeList.length) return false;

  return (cfg.dependentDropdowns || []).some((item) => {
    const normalized = normalizeLabel(item);
    return normalized && probeList.includes(normalized);
  });
}

const SEL = {
  username:   '#txtUsername',
  password:   '#txtPassword',
  loginBtn:   '#btnLogin',
  unlockBtn:  '#btnUnlock',
  homeReady:  '#divAppButton',
  userMenu:   '#userMenu',
  pageTitle:  '.pageTitle',
  offcanvas:  '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body, .offcanvas-body',
};

// ── Login ──────────────────────────────────────────────────────────────────────

async function login(page, { loginUrl, username, password }) {
  const base = new URL(loginUrl || 'https://ipdev.quickflow.in/login').origin;
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector(SEL.username, { timeout: 30000 });
  await page.waitForTimeout(500);

  await page.fill(SEL.username, username);
  await page.fill(SEL.password, password);
  await page.click(SEL.loginBtn);
  await page.waitForTimeout(1000);

  const unlock = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
  if (unlock) {
    await page.click(SEL.unlockBtn);
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector(SEL.homeReady, { timeout: 30000 });
  console.log('[LOGIN] OK');
}

// ── Navigate ───────────────────────────────────────────────────────────────────

async function navigateTo(page, name, baseURL) {
  const base = (baseURL || 'https://ipdev.quickflow.in').replace(/\/$/, '');
  const fullUrl = `${base}/${name}`;

  // Always use direct goto — sidebars may be collapsed, hidden, or on the right
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for network to settle
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Wait for the master page to render (pageTitle may be hidden, just needs to be in DOM)
  await page.waitForSelector(SEL.pageTitle, { state: 'attached', timeout: 20000 }).catch(() => {});

  // Extra wait for JS-rendered tables
  await page.waitForTimeout(1200);
  console.log(`[NAV] OK ${fullUrl}`);
}

// ── Open Create form ───────────────────────────────────────────────────────────

async function openCreateForm(page) {
  const formBody = page.locator('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body').first();

  const alreadyOpen = await formBody.isVisible().catch(() => false);
  if (alreadyOpen) {
    console.log('[CREATE] Form already open, skipping Create click');
    return;
  }

  const candidates = [
    page.locator('button.btn.btn-primary:visible:has(.fa-plus)').first(),
    page.locator('button.btn.btn-primary:visible', { hasText: /Create/i }).first(),
    page.locator('button:visible:not([disabled])', { hasText: /^\s*Create\s*$/i }).first(),
    page.locator('a:visible', { hasText: /^\s*Create\s*$/i }).first(),
  ];

  let opened = false;
  let lastError = '';

  for (let round = 0; round < 3 && !opened; round++) {
    const openNow = await formBody.isVisible().catch(() => false);
    if (openNow) {
      opened = true;
      break;
    }

    for (const target of candidates) {
      const visible = await target.isVisible().catch(() => false);
      if (!visible) continue;

      try {
        await target.click({ timeout: 5000 });
      } catch (error) {
        lastError = error?.message || String(error);
        await target.click({ timeout: 4000, force: true }).catch(() => {});
      }

      opened = await formBody.waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true)
        .catch(() => false);

      if (opened) break;
    }
  }

  if (!opened) {
    throw new Error(`Create button click did not open comparison form. ${lastError}`.trim());
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.offcanvas-body .ele', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
}
// ── Handle dependent dropdowns ─────────────────────────────────────────────────

/**
 * Resolve the target field element and determine whether it is empty (has no options).
 * Works for both native <select> and React Select / custom dropdowns.
 * 
 * For custom selects, we try opening it to see if options appear.
 */
async function isTargetFieldEmpty(page, fieldId, fieldIndex) {
  const isEmpty = await page.evaluate(({ fid, fidx }) => {
    const offcanvas =
      document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body') ||
      document.querySelector('.offcanvas-body');
    if (!offcanvas) return true;

    let el = null;
    if (fid) {
      el = offcanvas.querySelector(`#${CSS.escape(fid)}`) || offcanvas.querySelector(`[id="${fid}"]`);
    }
    if (!el) {
      const allEle = offcanvas.querySelectorAll('.ele');
      el = allEle[fidx] || null;
    }
    if (!el) return true;

    const tag = el.tagName.toLowerCase();

    // Native <select>
    if (tag === 'select') {
      const opts = Array.from(el.options).filter(o => o.value && o.value !== '-1' && o.value !== '');
      return opts.length === 0;
    }

    // Nested native <select> inside a wrapper div
    const nestedSelect = el.querySelector('select');
    if (nestedSelect) {
      const opts = Array.from(nestedSelect.options).filter(o => o.value && o.value !== '-1' && o.value !== '');
      return opts.length === 0;
    }

    // React Select / custom combobox: conservative approach
    // Even if it looks like it has a value, it might not have any selectable options
    // We'll return true (empty) unless we can definitively see it's populated
    const isDisabled =
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      !!el.closest('[disabled]') ||
      !!el.querySelector('[aria-disabled="true"]');

    if (isDisabled) return true;

    // If it shows a placeholder, it's definitely empty
    const placeholder = el.querySelector(
      '.react-select__placeholder, .select2-selection__placeholder, [class*="placeholder"]'
    );
    if (placeholder) return true;

    // A custom select that looks "filled" might still have no options
    // We can't reliably detect this from DOM alone, so we return true
    // and let the extraction logic handle opening it and checking
    // This is conservative but safe
    return true;
  }, { fid: fieldId, fidx: fieldIndex });

  if (!isEmpty) return false;

  // Double-check: try to actually open the field and see if options appear
  const fieldSelector = await resolveFieldSelector(page, fieldId, fieldIndex);
  if (!fieldSelector) return true;

  // Attempt to open and check for options
  const hasOptions = await page.evaluate(({ sel }) => {
    const el = document.querySelector(sel);
    if (!el) return false;

    // Try to find any option elements already visible
    const optionSelectors = [
      '[class*="menu-list"] [class*="option"]',
      '[class*="MenuList"] [class*="Option"]',
      '[role="option"]',
      '.select2-results__option',
      '[role="listbox"] > div',
    ];

    for (const optSel of optionSelectors) {
      const opts = document.querySelectorAll(optSel);
      if (opts.length > 0) return true;
    }

    return false;
  }, { sel: fieldSelector }).catch(() => false);

  return !hasOptions;
}

async function selectFirstCustomOption(page, rootSelector) {
  const control = page.locator(rootSelector).first();
  const visible = await control.isVisible().catch(() => false);
  if (!visible) return false;

  await control.scrollIntoViewIfNeeded().catch(() => {});
  await control.click({ timeout: 3000, force: true }).catch(() => {});
  await page.waitForTimeout(600);

  const optionSelectors = [
    '[class*="menu-list"] [class*="option"]',
    '[class*="MenuList"] [class*="Option"]',
    '[class*="menu"] [class*="option"]',
    '[id*="react-select"][id*="option"]',
    '[role="option"]',
    '.select2-results__option',
    '[role="listbox"] > div',
  ];

  for (const selector of optionSelectors) {
    const option = page.locator(selector).filter({ hasText: /\S/ }).first();
    const canClick = await option.isVisible().catch(() => false);
    if (!canClick) continue;
    await option.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }

  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function collectConfiguredParentSelectors(page, parentNames) {
  return page.evaluate((configuredParents) => {
    const offcanvas =
      document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body') ||
      document.querySelector('.offcanvas-body');
    if (!offcanvas || !Array.isArray(configuredParents) || configuredParents.length === 0) return [];

    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const entries = Array.from(offcanvas.querySelectorAll('.ele')).map((container, idx) => {
      const labelEl = container.querySelector('label, .lblText, .form-label, .control-label');
      const labelText = (labelEl?.textContent || '').trim();

      const native = container.querySelector('select');
      if (native) {
        const validOpts = Array.from(native.options).filter(
          (o) => o.value && o.value !== '-1' && o.value !== ''
        );
        const uid = `_cfg_dep_native_${idx}_${Date.now()}`;
        native.setAttribute('data-dep-uid', uid);
        return {
          labelText,
          id: native.id || '',
          kind: 'native',
          selector: `[data-dep-uid="${uid}"]`,
          firstValue: validOpts[0]?.value || '',
          firstLabel: (validOpts[0]?.textContent || '').trim(),
        };
      }

      const custom = container.querySelector('.react-select__control, [role="combobox"], .select2-selection');
      if (custom) {
        const uid = `_cfg_dep_custom_${idx}_${Date.now()}`;
        custom.setAttribute('data-dep-uid', uid);
        return {
          labelText,
          id: custom.id || '',
          kind: 'custom',
          selector: `[data-dep-uid="${uid}"]`,
        };
      }

      return null;
    }).filter(Boolean);

    const mapped = [];
    for (const name of configuredParents) {
      const probe = normalize(name);
      if (!probe) continue;
      const hit = entries.find((entry) => {
        const label = normalize(entry.labelText);
        const id = normalize(entry.id);
        return label === probe || id === probe;
      });
      if (hit) mapped.push(hit);
    }

    return mapped;
  }, parentNames);
}

/**
 * If a dropdown field is empty (has no options), it may be dependent on other dropdowns.
 * This function fills any parent dropdowns first to trigger loading of dependent dropdown options.
 * Handles both native <select> and React Select / custom dropdowns.
 * 
 * Enhanced strategy:
 * 1. Try configured parent dropdowns first
 * 2. If no configured parents or they don't work, try auto-detecting all potential parents
 * 3. For each parent candidate, fill it and check if target field gets populated
 */
async function handleDependentDropdowns(page, fieldId, fieldIndex, sourceMaster, fieldName) {
  const empty = await isTargetFieldEmpty(page, fieldId, fieldIndex);

  if (!empty) {
    console.log('[DEP] Target field has options, not dependent');
    return;
  }

  const dependencyCfg = await getMasterDependencyConfig(sourceMaster);
  const isConfiguredDependent = isConfiguredDependentField(dependencyCfg, fieldName, fieldId);

  console.log(`[DEP] Field "${fieldName}" empty check: dependent=${isConfiguredDependent}, configured_parents=${dependencyCfg.parentDropdowns.length}`);

  // ─ STRATEGY 1: Try configured parent dropdowns ─
  if (isConfiguredDependent && dependencyCfg.parentDropdowns.length > 0) {
    console.log(`[DEP] STRATEGY 1: Trying ${dependencyCfg.parentDropdowns.length} configured parent(s)`);

    const configuredParents = await collectConfiguredParentSelectors(page, dependencyCfg.parentDropdowns);
    console.log(`[DEP] Matched ${configuredParents.length} configured parent control(s) in form`);

    for (const parent of configuredParents) {
      if (parent.kind === 'native' && parent.firstValue) {
        console.log(`[DEP] Filling configured native parent "${parent.labelText || parent.id}" with "${parent.firstLabel}"`);
        await page.locator(parent.selector).first().selectOption(parent.firstValue, { timeout: 3000 }).catch(() => {});
      }

      if (parent.kind === 'custom') {
        console.log(`[DEP] Filling configured custom parent "${parent.labelText || parent.id}"`);
        await selectFirstCustomOption(page, parent.selector).catch(() => false);
      }

      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);

      const nowEmpty = await isTargetFieldEmpty(page, fieldId, fieldIndex);
      if (!nowEmpty) {
        console.log('[DEP] STRATEGY 1 SUCCESS: Target field populated via configured parent');
        return;
      }
    }

    console.log('[DEP] STRATEGY 1 FAILED: Configured parents did not populate target field');
  }

  // ─ STRATEGY 2: Auto-detect and try all potential parent dropdowns ─
  console.log('[DEP] STRATEGY 2: Auto-detecting all potential parent dropdowns...');

  const allSelectLikes = await page.evaluate(() => {
    const offcanvas =
      document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body') ||
      document.querySelector('.offcanvas-body');
    if (!offcanvas) return [];

    const results = [];

    // Collect ALL select-like fields (not just populated ones)
    Array.from(offcanvas.querySelectorAll('.ele')).forEach((container, idx) => {
      const labelEl = container.querySelector('label, .lblText, .form-label, .control-label');
      const labelText = (labelEl?.textContent || '').trim();

      // Native <select>
      const native = container.querySelector('select');
      if (native) {
        const validOpts = Array.from(native.options).filter(o => o.value && o.value !== '-1' && o.value !== '');
        if (validOpts.length > 0) {
          const uid = `_auto_native_${idx}_${Date.now()}`;
          native.setAttribute('data-dep-uid', uid);
          results.push({
            kind: 'native',
            label: labelText,
            uid,
            id: native.id || '',
            index: idx,
            firstValue: validOpts[0].value,
            firstLabel: (validOpts[0].textContent || '').trim(),
          });
        }
        return;
      }

      // React Select / custom combobox - TRY ALL, not just those with values
      const custom = container.querySelector('.react-select__control, [role="combobox"], .select2-selection');
      if (custom) {
        const uid = `_auto_custom_${idx}_${Date.now()}`;
        custom.setAttribute('data-dep-uid', uid);
        
        // Try to find out if it has a value already
        const singleValue = custom.querySelector('.react-select__single-value, .select2-selection__rendered, [class*="singleValue"]');
        const hasValue = singleValue && !/^\s*(select|choose|--)/i.test(singleValue.textContent || '');
        
        results.push({
          kind: 'custom',
          label: labelText,
          uid,
          id: custom.id || '',
          index: idx,
          hasValue,
          parentIndicator: hasValue ? 'LIKELY_PARENT' : 'UNKNOWN',
        });
      }
    });

    return results;
  });

  console.log(`[DEP] Found ${allSelectLikes.length} total select-like field(s) in form`);
  allSelectLikes.forEach((field, i) => {
    const indicator = field.parentIndicator || (field.kind === 'native' ? 'HAS_OPTIONS' : '');
    console.log(`[DEP]   ${i}: "${field.label}" (${field.kind}) ${indicator}`);
  });

  // Try parents in order: native selects first (more reliable), then custom
  const nativeParents = allSelectLikes.filter(f => f.kind === 'native');
  const customParents = allSelectLikes.filter(f => f.kind === 'custom');
  const prioritizedParents = [...nativeParents, ...customParents];

  for (const candidate of prioritizedParents) {
    console.log(`[DEP] Trying parent: "${candidate.label || '(no label)'}" (${candidate.kind}, idx=${candidate.index})`);

    if (candidate.kind === 'native') {
      const selector = `[data-dep-uid="${candidate.uid}"]`;
      try {
        await page.locator(selector).first().selectOption(candidate.firstValue, { timeout: 3000 });
        console.log(`[DEP]   OK selected native option "${candidate.firstLabel}"`);
      } catch (err) {
        console.log(`[DEP]   ✗ selectOption failed: ${err.message}`);
        await page.evaluate(({ sel, val }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          if (window.$) {
            window.$(el).trigger('change');
            window.$(el).trigger('blur');
          }
        }, { sel: selector, val: candidate.firstValue });
        console.log('[DEP]   OK dispatched change events for native');
      }
    } else {
      // Custom select - try clicking to open
      const selector = `[data-dep-uid="${candidate.uid}"]`;
      const clicked = await selectFirstCustomOption(page, selector).catch(() => false);
      if (clicked) {
        console.log('[DEP]   OK clicked and selected first custom option');
      } else {
        console.log(`[DEP]   ✗ Could not open/select custom option`);
      }
    }

    // Wait for network + JS to populate the dependent dropdown
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Check if the target field now has options
    const nowEmpty = await isTargetFieldEmpty(page, fieldId, fieldIndex);
    if (!nowEmpty) {
      console.log(`[DEP] STRATEGY 2 SUCCESS: Target field populated after filling parent at index ${candidate.index}`);
      return;
    }
  }

  console.log('[DEP] WARNING: Target field still empty after trying all strategies');
}
// ── Extract select options ─────────────────────────────────────────────────────

/**
 * Resolve the target field element inside the offcanvas and tag it with a
 * unique attribute so subsequent steps can locate it reliably.
 */
async function resolveFieldSelector(page, fieldId, fieldIndex) {
  return page.evaluate(({ fid, fidx }) => {
    const offcanvas =
      document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body') ||
      document.querySelector('.offcanvas-body');
    if (!offcanvas) return null;

    let el = null;
    if (fid) {
      el = offcanvas.querySelector(`#${CSS.escape(fid)}`) || offcanvas.querySelector(`[id="${fid}"]`);
    }
    if (!el) {
      const allEle = offcanvas.querySelectorAll('.ele');
      el = allEle[fidx] || null;
    }
    // Fallback: nth select-like element in the offcanvas
    if (!el) {
      const allSelects = offcanvas.querySelectorAll(
        'select, .react-select__control, [role="combobox"], .select2-selection'
      );
      el = allSelects[fidx] || null;
    }
    if (!el) return null;

    const uid = `_cmp_field_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    el.setAttribute('data-cmp-field', uid);
    return `[data-cmp-field="${uid}"]`;
  }, { fid: fieldId, fidx: fieldIndex });
}

async function extractSelectOptions(page, fieldId, fieldIndex) {
  // Handle dependent dropdowns: if field has no options, fill parent fields first
  await handleDependentDropdowns(
    page,
    fieldId,
    fieldIndex,
    process.env.QT_MASTER || '',
    process.env.QT_FIELD_NAME || ''
  );

  // Resolve a stable selector for the target field
  const fieldSelector = await resolveFieldSelector(page, fieldId, fieldIndex);
  if (!fieldSelector) {
    console.log('[OPTIONS] Field element not found in offcanvas');
    return [];
  }

  // Step 1: Try to read options directly from a native <select>
  const nativeOptions = await page.evaluate(({ sel }) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, tag: '', options: [] };

    const tag = el.tagName.toLowerCase();

    // Direct native select
    if (tag === 'select') {
      const SKIP = /^\s*(please\s+select|select\s+an?\s+option|--\s*select|choose|none)\s*$/i;
      const opts = Array.from(el.options)
        .filter(o => o.value && o.value !== '-1' && o.value !== '' && !SKIP.test(o.textContent))
        .map(o => ({ value: o.value, label: o.textContent.trim() }));
      return { found: true, tag, options: opts };
    }

    // Nested native select inside a wrapper div
    const nestedSelect = el.querySelector('select');
    if (nestedSelect) {
      const SKIP = /^\s*(please\s+select|select\s+an?\s+option|--\s*select|choose|none)\s*$/i;
      const opts = Array.from(nestedSelect.options)
        .filter(o => o.value && o.value !== '-1' && o.value !== '' && !SKIP.test(o.textContent))
        .map(o => ({ value: o.value, label: o.textContent.trim() }));
      return { found: true, tag: 'select', options: opts };
    }

    // Custom select — needs click-to-open
    return { found: true, tag, options: [] };
  }, { sel: fieldSelector });

  if (nativeOptions.options.length > 0) {
    console.log(`[OPTIONS] Got ${nativeOptions.options.length} native <select> options`);
    return nativeOptions.options;
  }

  if (!nativeOptions.found) {
    console.log('[OPTIONS] Field element not found');
    return [];
  }

  // Step 2: Open react-select / custom dropdown via Playwright click
  const clickTargets = [
    `${fieldSelector} input[role="combobox"]`,
    `${fieldSelector} [aria-haspopup="listbox"]`,
    `${fieldSelector} .react-select__control`,
    `${fieldSelector} .select2-selection`,
    `${fieldSelector} input:not([type="hidden"]):not([disabled])`,
    fieldSelector,
  ];

  let opened = false;
  for (const sel of clickTargets) {
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 3000, force: true });
      opened = true;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!opened) {
    // Last resort: dispatch mouse events via JS
    opened = await page.evaluate(({ sel }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      const input = el.querySelector('input[role="combobox"], input:not([type="hidden"])') || el;
      for (const node of [input, el]) {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (typeof node.focus === 'function') node.focus();
      }
      return true;
    }, { sel: fieldSelector }).catch(() => false);
  }

  if (!opened) {
    console.log('[OPTIONS] Could not open custom dropdown control');
    return [];
  }

  // Wait for the dropdown menu to render
  await page.waitForTimeout(800);

  // Step 3: Read rendered dropdown options — scoped to visible menus only
  const options = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const SKIP = /^\s*(please\s+select|select\s+an?\s+option|--\s*select|choose|none)\s*$/i;

    const selectors = [
      '[class*="menu-list"] [class*="option"]',
      '[class*="MenuList"] [class*="Option"]',
      '[class*="menu"] [class*="option"]',
      '[id*="react-select"][id*="option"]',
      '[role="option"]',
      '.select2-results__option',
      '[role="listbox"] > div',
    ];

    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (nodes.length) {
        return nodes
          .map(n => ({
            value: n.getAttribute('data-value') || n.getAttribute('data-option-value') || n.id || n.textContent.trim(),
            label: n.textContent.trim(),
          }))
          .filter(o => o.label && !SKIP.test(o.label));
      }
    }
    return [];
  });

  // Close dropdown
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log(`[OPTIONS] Got ${options.length} custom dropdown options`);
  return options;
}

// ── Extract table data ─────────────────────────────────────────────────────────

const TABLE_ROW_SEL = '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table.dataTable tbody tr';
const THEAD_SEL     = '.dt-scroll-head thead th, .dataTables_scrollHead thead th, table.dataTable thead th';
const GENERIC_THEAD = 'table thead th, table th, .table thead th, thead th';
const GENERIC_ROW   = 'table tbody tr, .table tbody tr, tbody tr';

/**
 * Return the 0-based column index whose header best matches fieldName.
 * Scoring: exact match > fieldName contains header > header contains fieldName > word overlap
 * Requires a minimum score of 40 to avoid false positives on short word overlaps.
 */
function findColumnIndex(headers, fieldName) {
  if (!fieldName) return -1;
  const fn = fieldName.toLowerCase().trim();
  // Strip common suffixes like "name", "master", "id" for fuzzy matching
  const fnCore = fn.replace(/\b(name|master|id|code|mst|list)\b/g, '').replace(/\s+/g, ' ').trim();
  const fnWords = fn.split(/\s+/).filter(w => w.length > 2);

  let bestIdx = -1, bestScore = -1;
  headers.forEach((h, i) => {
    const hh = h.toLowerCase().trim();
    if (!hh) return;
    const hhCore = hh.replace(/\b(name|master|id|code|mst|list)\b/g, '').replace(/\s+/g, ' ').trim();

    let score = 0;
    if (hh === fn)                        score = 100; // exact
    else if (hhCore && hhCore === fnCore) score = 90;  // exact after stripping suffixes
    else if (fn.includes(hh) && hh.length >= 4)  score = 80;
    else if (hh.includes(fn) && fn.length >= 4)  score = 80;
    else if (fnCore && hh.includes(fnCore) && fnCore.length >= 4) score = 70;
    else if (fnCore && hhCore && hhCore.includes(fnCore) && fnCore.length >= 4) score = 65;
    else {
      // word overlap — require at least 2 meaningful words or one long word
      const overlap = fnWords.filter(w => w.length > 3 && hh.includes(w)).length;
      score = overlap >= 2 ? overlap * 25 : overlap * 15;
    }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  // Raise minimum threshold to avoid wrong-column matches
  return bestScore >= 40 ? bestIdx : -1;
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|amp|nbsp|lt|gt|quot|apos);/gi, (match, entity) => {
    const key = String(entity || '').toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'nbsp') return ' ';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";

    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }

    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }

    return match;
  });
}

function normalizeCompareValue(value) {
  return decodeHtmlEntities(value)
    .replace(/[\u00a0\u2000-\u200d\ufeff]/g, ' ')
    // Remove parenthetical codes like "(GJ)" or "[ABC]" appended to names
    .replace(/\s*[\(\[][A-Z0-9\-_]{1,10}[\)\]]\s*/g, ' ')
    .replace(/\s*&\s*/g, ' & ')
    // Collapse punctuation differences: hyphens/underscores treated as spaces
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function scrapeCurrentPage(page, colIdx, headers) {
  return page.evaluate(({ colIdx, headers }) => {
    const norm = t => t.replace(/[\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
    const ROW_SEL = '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table.dataTable tbody tr';
    const rows = document.querySelectorAll(ROW_SEL);
    const records = [];
    const isAutoCode = v => /^[A-Z]{1,8}-\d{3,}$/.test(v) || /^\d{4,}$/.test(v);
    const hasLetter  = v => /[a-zA-Z\u00C0-\u024F]/.test(v);

    for (const row of rows) {
      // Skip "no data" / colspan rows
      if (row.cells.length === 1 && row.cells[0].hasAttribute('colspan')) continue;
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) continue;

      // Skip rows that appear to be inactive/deleted (strikethrough or muted styling)
      const rowStyle = window.getComputedStyle(row);
      if (rowStyle.textDecoration && rowStyle.textDecoration.includes('line-through')) continue;
      if (rowStyle.opacity && parseFloat(rowStyle.opacity) < 0.5) continue;

      const hasCheckbox = cells[0]?.querySelector('input[type="checkbox"]') ? 1 : 0;
      let name = '';

      if (colIdx >= 0) {
        // Try the exact column, then shifted by checkbox offset
        const directCell  = cells[colIdx];
        const shiftedCell = cells[colIdx + hasCheckbox];

        // Prefer the cell whose text looks like a name (has letters, not an auto-code)
        const directText  = directCell  ? norm(directCell.textContent)  : '';
        const shiftedText = shiftedCell ? norm(shiftedCell.textContent) : '';

        if (directText && hasLetter(directText) && !isAutoCode(directText)) {
          name = directText;
        } else if (shiftedText && hasLetter(shiftedText) && !isAutoCode(shiftedText)) {
          name = shiftedText;
        } else {
          name = directText || shiftedText;
        }
      }

      if (!name) {
        // Fallback: first cell with letters that is not an auto-code or pure number
        const dataCells = cells.slice(hasCheckbox);
        name = dataCells.map(c => norm(c.textContent))
          .find(v => v && hasLetter(v) && !isAutoCode(v) && !/^\d+$/.test(v)) || '';
      }

      if (!name) continue;
      records.push({ name });
    }
    return records;
  }, { colIdx, headers });
}

async function extractTableData(page, fieldName) {
  // Extended wait for table rows to appear — try DataTable first, then generic tables
  console.log(`[TABLE] Waiting for table to load...`);
  const dtLoaded = await page.waitForSelector(TABLE_ROW_SEL, { timeout: 20000 }).then(() => true).catch(() => false);

  if (!dtLoaded) {
    // Fallback: wait for any table structure
    await page.waitForSelector(GENERIC_ROW, { timeout: 10000 }).catch(() => {});
  }

  // Extra wait to ensure table fully renders
  await page.waitForTimeout(1500);

  // Dump a diagnostic of what we can see on the page
  const pageInfo = await page.evaluate(() => {
    const allTables = document.querySelectorAll('table');
    const dtHeaders = document.querySelectorAll('.dt-scroll-head thead th, .dataTables_scrollHead thead th, table.dataTable thead th');
    const genericHeaders = document.querySelectorAll('table thead th, table th, .table thead th, thead th');
    const allRows = document.querySelectorAll('table tbody tr, tbody tr');
    const pageTitle = document.querySelector('.pageTitle, h1, h2, .page-title');

    return {
      tableCount: allTables.length,
      dtHeaderCount: dtHeaders.length,
      genericHeaderCount: genericHeaders.length,
      rowCount: allRows.length,
      pageTitle: pageTitle?.textContent?.trim() || '',
      bodyText: document.body?.textContent?.slice(0, 200) || '',
    };
  });
  console.log(`[TABLE] Page info: tables=${pageInfo.tableCount}, dtHeaders=${pageInfo.dtHeaderCount}, genericHeaders=${pageInfo.genericHeaderCount}, rows=${pageInfo.rowCount}, title="${pageInfo.pageTitle}"`);

  // Read column headers — try DataTable first, then generic
  let headers = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map(th => th.textContent.trim());
  }, THEAD_SEL);

  if (headers.length === 0) {
    console.log(`[TABLE] DataTable headers not found, trying generic table headers...`);
    headers = await page.evaluate((sel) => {
      // Get headers from the table with the most rows (most likely the data table)
      const tables = Array.from(document.querySelectorAll('table'));
      if (tables.length === 0) return [];

      // Pick table with most rows
      const bestTable = tables.reduce((best, t) => {
        const rows = t.querySelectorAll('tbody tr').length;
        return rows > (best ? t.querySelectorAll('tbody tr').length : 0) ? t : best;
      }, null);

      if (bestTable) {
        const ths = bestTable.querySelectorAll('thead th, th');
        if (ths.length > 0) return Array.from(ths).map(th => th.textContent.trim());
      }

      // Fall back to all headers
      return Array.from(document.querySelectorAll(sel)).map(th => th.textContent.trim());
    }, GENERIC_THEAD);

    if (headers.length > 0) {
      console.log(`[TABLE] Found ${headers.length} generic table headers`);
    }
  }

  console.log(`[TABLE] Headers: ${JSON.stringify(headers)}`);

  // Find which column matches the field name
  const colIdx = findColumnIndex(headers, fieldName);
  console.log(`[TABLE] Matching column for "${fieldName}": index ${colIdx} => "${headers[colIdx] || 'fallback'}"`);

  // Try setting page length to "All" or the largest option to minimise pages
  try {
    const lengthSel = page.locator('select[name*="length"], .dataTables_length select').first();
    if (await lengthSel.isVisible({ timeout: 3000 }).catch(() => false)) {
      const opts = await lengthSel.evaluate(el =>
        Array.from(el.options).map(o => ({ v: o.value, t: o.textContent.trim().toLowerCase() }))
      );
      const allOpt  = opts.find(o => o.t === 'all' || o.v === '-1');
      const bigOpt  = opts.filter(o => /^\d+$/.test(o.v)).sort((a, b) => +b.v - +a.v)[0];
      const chosen  = allOpt || bigOpt;
      if (chosen) {
        await lengthSel.selectOption({ value: chosen.v }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
  } catch { /* ignore */ }

  // Helper: is the Next button currently disabled?
  async function isNextDisabled() {
    const disabled = await page.evaluate(() => {
      const btn = document.querySelector('button.page-link.next, a.page-link.next');
      if (!btn) return true;
      const li = btn.closest('li');
      return (
        (li && li.classList.contains('disabled')) ||
        btn.getAttribute('aria-disabled') === 'true' ||
        btn.hasAttribute('disabled')
      );
    });
    return disabled;
  }

  async function getInfoText() {
    return page.evaluate(() => {
      const el = document.querySelector('.dataTables_info, .dt-info');
      return el ? el.textContent.trim() : '';
    });
  }

  async function waitForTableRefresh(prevInfo) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const info = await getInfoText();
      if (info && info !== prevInfo) return;
      await page.waitForTimeout(200);
    }
  }

  const allRecords = [];
  let pageNum = 1;

  while (true) {
    let rows = await scrapeCurrentPage(page, colIdx, headers);

    // If DataTable rows return nothing, try scraping generic table rows
    if (rows.length === 0 && pageNum === 1) {
      console.log(`[TABLE] DataTable rows empty, trying generic table scrape...`);
      rows = await page.evaluate(({ colIdx, fieldName }) => {
        const norm = t => t.replace(/[\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
        const isAutoCode = v => /^[A-Z]{1,8}-\d{3,}$/.test(v) || /^\d{4,}$/.test(v);
        const hasLetter  = v => /[a-zA-Z\u00C0-\u024F]/.test(v);

        // Try all tables, pick the one with the most data rows
        const tables = Array.from(document.querySelectorAll('table'));
        let bestRows = [];

        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          if (rows.length === 0) continue;

          const records = [];
          for (const row of rows) {
            if (row.cells.length === 1 && row.cells[0].hasAttribute('colspan')) continue;
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 1) continue;

            const hasCheckbox = cells[0]?.querySelector('input[type="checkbox"]') ? 1 : 0;
            let name = '';

            if (colIdx >= 0) {
              const directCell = cells[colIdx];
              const shiftedCell = cells[colIdx + hasCheckbox];
              const directText = directCell ? norm(directCell.textContent) : '';
              const shiftedText = shiftedCell ? norm(shiftedCell.textContent) : '';
              if (directText && hasLetter(directText) && !isAutoCode(directText)) name = directText;
              else if (shiftedText && hasLetter(shiftedText) && !isAutoCode(shiftedText)) name = shiftedText;
              else name = directText || shiftedText;
            }

            if (!name) {
              const dataCells = cells.slice(hasCheckbox);
              name = dataCells.map(c => norm(c.textContent))
                .find(v => v && hasLetter(v) && !isAutoCode(v) && !/^\d+$/.test(v)) || '';
            }

            if (name) records.push({ name });
          }

          if (records.length > bestRows.length) bestRows = records;
        }

        return bestRows;
      }, { colIdx, fieldName });

      if (rows.length > 0) {
        console.log(`[TABLE] Generic scrape found ${rows.length} rows`);
      }
    }

    console.log(`[TABLE] Page ${pageNum}: ${rows.length} rows`);
    allRecords.push(...rows);

    if (await isNextDisabled()) break;

    const prevInfo = await getInfoText();

    const nextBtn = page.locator('button.page-link.next, a.page-link.next').first();
    await nextBtn.click();

    await waitForTableRefresh(prevInfo);
    await page.waitForTimeout(400);

    pageNum++;
  }

  console.log(`[TABLE] Total: ${allRecords.length} rows across ${pageNum} page(s), ${headers.length} columns`);
  return { headers, records: allRecords };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const loginUrl     = process.env.QT_URL            || 'https://ipdev.quickflow.in/login';
  const username     = process.env.QT_USER           || 'dhruvi';
  const password     = process.env.QT_PASS           || '';
  const sourceMaster = process.env.QT_MASTER         || '';
  const fieldId      = process.env.QT_FIELD_ID       || '';
  const fieldIndex   = parseInt(process.env.QT_FIELD_INDEX || '0', 10);
  const fieldName    = process.env.QT_FIELD_NAME     || '';
  const targetMaster = process.env.QT_TARGET_MASTER  || '';
  const headless     = String(process.env.QT_HEADLESS || 'false').toLowerCase() !== 'false';
  const recordVideo  = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';

  if (!sourceMaster) throw new Error('QT_MASTER (source master) is required');
  if (!targetMaster) throw new Error('QT_TARGET_MASTER is required');

  // Redirect console to stderr so stdout is only JSON
  const origLog  = console.log;
  const origWarn = console.warn;
  console.log  = (...args) => process.stderr.write(args.join(' ') + '\n');
  console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');

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
      masterName: sourceMaster,
      operation: 'compare-field',
      status: 'running',
      step: 'init',
    });

    currentStep = 'login';
    await login(page, { loginUrl, username, password });
    const baseURL = new URL(loginUrl).origin;

    // ─ Step 1: Extract select options from source master's Create form ─
    console.log(`[STEP 1] Navigate to source master: ${sourceMaster}`);
    console.log(`[STEP 1] Field: name="${fieldName}" id="${fieldId}" index=${fieldIndex}`);
    currentStep = 'source-master-navigation';
    await navigateTo(page, sourceMaster, baseURL);
    currentStep = 'open-source-create-form';
    await openCreateForm(page);

    currentStep = 'extract-source-dropdown-options';
    const selectOptions = await extractSelectOptions(page, fieldId, fieldIndex);
    console.log(`[STEP 1] OK extracted ${selectOptions.length} options from dropdown`);

    if (selectOptions.length === 0) {
      console.log('[STEP 1] WARNING: No options found in dropdown. This may indicate:');
      console.log(`[STEP 1]   - Field is dependent but parents were not populated correctly`);
      console.log(`[STEP 1]   - Field doesn't exist at the specified id/index`);
      console.log(`[STEP 1]   - Field is read-only or disabled`);
    }

    // Close offcanvas
    currentStep = 'close-source-form';
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ─ Step 2: Navigate to target master and get table data ─
    console.log(`[STEP 2] Navigate to target master: ${targetMaster}`);
    currentStep = 'target-master-navigation';
    await navigateTo(page, targetMaster, baseURL);

    currentStep = 'extract-target-master-table';
    const tableResult = await extractTableData(page, fieldName);
    console.log(`[STEP 2] OK scraped ${tableResult.records.length} records from table`);

    if (tableResult.records.length === 0) {
      console.log("[STEP 2] WARNING: No records found in master table. Table may be empty or field name doesn't match.");
    }

    // ─ Step 3: Compare ─
    console.log(`[STEP 3] Comparing dropdown options with table data...`);
    currentStep = 'compare-source-and-target-data';
    const SKIP_LABEL = /^\s*(please\s+select|select\s+an?\s+option|--\s*select|choose|none)\s*$/i;
    const optionLabels = selectOptions
      .filter(o => !SKIP_LABEL.test(o.label))
      .map(o => String(o.label || '').trim())
      .filter(Boolean);

    const tableNames = tableResult.records
      .map(r => String(r.name || '').trim())
      .filter(n => n && /[a-zA-Z\u00C0-\u024F\d]/.test(n));

    console.log(`[STEP 3] Options after filtering: ${optionLabels.length}`);
    console.log(`[STEP 3] Table records after filtering: ${tableNames.length}`);

    const optionNormalizedMap = new Map();
    for (const label of optionLabels) {
      const normalized = normalizeCompareValue(label);
      if (!normalized || optionNormalizedMap.has(normalized)) continue;
      optionNormalizedMap.set(normalized, label);
    }

    const tableNormalizedMap = new Map();
    for (const name of tableNames) {
      const normalized = normalizeCompareValue(name);
      if (!normalized || tableNormalizedMap.has(normalized)) continue;
      tableNormalizedMap.set(normalized, name);
    }

    const matched = [];
    for (const [normalized, original] of optionNormalizedMap) {
      if (tableNormalizedMap.has(normalized)) {
        matched.push(original);
      }
    }

    // missingInDropdown: records in the master table that are NOT in the dropdown
    // Only meaningful when we actually got dropdown options
    const missingInDropdown = optionLabels.length > 0
      ? Array.from(tableNormalizedMap.entries())
          .filter(([normalized]) => !optionNormalizedMap.has(normalized))
          .map(([, original]) => original)
      : [];

    // extraInDropdown: options in the dropdown that are NOT in the master table
    // Only meaningful when we actually scraped table records
    const extraInDropdown = tableNames.length > 0
      ? Array.from(optionNormalizedMap.entries())
          .filter(([normalized]) => !tableNormalizedMap.has(normalized))
          .map(([, original]) => original)
      : [];

    // isFullMatch: only true when both sides have data AND there are no discrepancies
    const hasData = optionLabels.length > 0 && tableNames.length > 0;
    const isFullMatch = hasData && missingInDropdown.length === 0 && extraInDropdown.length === 0;
    const screenshotPath = await captureReportScreenshot(
      page,
      sourceMaster,
      'compare-field',
      isFullMatch ? 'passed' : 'failed',
      currentStep,
    );

    console.log(`[STEP 3] Matched: ${matched.length}, Missing: ${missingInDropdown.length}, Extra: ${extraInDropdown.length}`);
    console.log(`[STEP 3] OK isFullMatch: ${isFullMatch}`);

    const result = {
      sourceMaster,
      targetMaster,
      fieldId,
      fieldName,
      selectOptions,
      tableData: tableResult,
      comparison: {
        totalOptions:       selectOptions.length,
        totalRecords:       tableResult.records.length,
        matchedCount:       matched.length,
        matched,
        missingInDropdown,
        extraInDropdown,
        isFullMatch,
      },
      screenshotPath,
      completedAt: new Date().toISOString(),
    };

    await updateArtifactOverlay(page, {
      masterName: sourceMaster,
      operation: 'compare-field',
      status: isFullMatch ? 'passed' : 'failed',
      step: currentStep,
    });

    console.log = origLog;
    console.warn = origWarn;
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const failShot = await captureReportScreenshot(
      page,
      sourceMaster,
      'compare-field',
      'failed',
      currentStep,
    ).catch(() => '');
    const detail = String(error?.stack || error?.message || error || 'Comparison failed').trim();
    if (failShot) {
      throw new Error(`${detail}\n[FAIL_SCREENSHOT] ${failShot}`);
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

run().catch(error => {
  process.stderr.write(String(error?.stack || error?.message || 'Comparison failed'));
  process.exit(1);
});
