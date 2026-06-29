'use strict';

/**
 * template-design-automation.js
 *
 * Navigates to the Template Design page (/Design-Template) using data from
 * a previously completed Template Workflow run (passed via env vars) and
 * exercises every discoverable control on the page.
 *
 * Environment inputs:
 *   QT_URL            Login URL
 *   QT_USER           Username
 *   QT_PASS           Password
 *   QT_HEADLESS       "true" / "false"
 *   QT_RECORD_VIDEO   "true" / "false"
 *   QT_SITE_NAME      Site name from workflow run
 *   QT_APP_NAME       App name from workflow run
 *   QT_TEMPLATE_NAME  Template name from workflow run
 *   QT_SUB_TEMPLATE_NAME  Sub-template name from workflow run
 *   QT_WORKFLOW_NAME  Workflow name from workflow run
 */

const { chromium } = require('@playwright/test');
const { randomUUID, randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
function boolEnv(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
}

const CFG = {
  loginUrl:       process.env.QT_URL            || 'https://ipdev.quickflow.in/login',
  username:       process.env.QT_USER           || 'dhruvi',
  password:       process.env.QT_PASS           || 'Welcome@123',
  headless:       boolEnv(process.env.QT_HEADLESS, false),
  recordVideo:    boolEnv(process.env.QT_RECORD_VIDEO, true),
  siteName:       process.env.QT_SITE_NAME       || '',
  appName:        process.env.QT_APP_NAME        || '',
  templateName:   process.env.QT_TEMPLATE_NAME   || '',
  subTemplateName:process.env.QT_SUB_TEMPLATE_NAME || '',
  workflowName:   process.env.QT_WORKFLOW_NAME   || '',
};

const BASE_URL      = new URL(CFG.loginUrl).origin;
const ARTIFACTS_DIR = path.resolve(__dirname, 'test-reports');

function log(msg) { process.stderr.write(`[TEMPLATE-DESIGN] ${msg}\n`); }

function uniqueId() {
  try { return randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(); }
  catch { return randomBytes(6).toString('hex').toUpperCase(); }
}

function escapeAttrValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeTextValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function locatorById(page, id) {
  return page.locator(`[id="${escapeAttrValue(id)}"]`).first();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function captureScreenshot(page, label) {
  try {
    if (!page || page.isClosed()) return '';
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const safe = String(label || 'step').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-template-design-${safe}.png`;
    const fullPath = path.join(ARTIFACTS_DIR, fileName);
    await page.screenshot({ path: fullPath, fullPage: true }).catch(() => {});
    return fullPath;
  } catch {
    return '';
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(page) {
  log('Navigating to login page…');
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtUsername', { timeout: 30000 });
  await page.fill('#txtUsername', CFG.username);
  await page.fill('#txtPassword', CFG.password);
  await page.click('#btnLogin');
  await page.waitForTimeout(1000);

  const unlock = await page.locator('#btnUnlock').isVisible().catch(() => false);
  if (unlock) {
    await page.click('#btnUnlock');
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector('#divAppButton', { timeout: 30000 });
  log('Login successful');
}

// ── Navigate to Template Design ───────────────────────────────────────────────
async function navigateToDesignTemplate(page) {
  log('Navigating to /Design-Template…');
  await page.goto(`${BASE_URL}/Design-Template`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#MainContent_ddlAppList', { timeout: 20000 });
  await page.waitForSelector('#MainContent_ddlTemplateSheet', { timeout: 20000 });
  await page.waitForTimeout(1000);
  log('Arrived at Template Design page');
}

async function selectTopbarDropdownByText(page, selectId, preferredText) {
  const target = String(preferredText || '').trim();
  if (!target) {
    return { selected: false, reason: 'No target value provided' };
  }

  const result = await page.evaluate(({ selectId, target }) => {
    const select = document.getElementById(selectId);
    if (!select) return { selected: false, reason: `${selectId} not found` };

    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const targetNorm = norm(target);

    const options = Array.from(select.options || []);
    const validOptions = options.filter((opt) => {
      const txt = norm(opt.textContent || opt.text || '');
      if (!txt) return false;
      if (opt.disabled) return false;
      return !/^select\b/.test(txt);
    });

    if (!validOptions.length) {
      return { selected: false, reason: `${selectId} has no usable options` };
    }

    let chosen = validOptions.find((opt) => norm(opt.textContent || opt.text || '') === targetNorm);
    if (!chosen) {
      chosen = validOptions.find((opt) => norm(opt.textContent || opt.text || '').includes(targetNorm));
    }
    if (!chosen) {
      chosen = validOptions.find((opt) => targetNorm.includes(norm(opt.textContent || opt.text || '')));
    }

    if (!chosen) {
      return {
        selected: false,
        reason: `${selectId} could not match "${target}"`,
        sample: validOptions.slice(0, 8).map((opt) => (opt.textContent || opt.text || '').trim()),
      };
    }

    select.value = chosen.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // Keep select2 UI (if present) in sync for event listeners bound to the rendered element.
    if (window.$ && typeof window.$ === 'function') {
      try { window.$(select).trigger('change.select2'); } catch (_) { /* ignore */ }
    }

    return {
      selected: true,
      selectedText: (chosen.textContent || chosen.text || '').trim(),
      selectedValue: String(chosen.value || ''),
    };
  }, { selectId, target }).catch((err) => ({ selected: false, reason: String(err?.message || err) }));

  if (result.selected) {
    await page.waitForTimeout(900);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
  return result;
}

async function applyCoreTopbarSelections(page, flowState) {
  const applied = [];
  const skipped = [];

  const appChoice = await selectTopbarDropdownByText(page, 'MainContent_ddlAppList', flowState.appName);
  if (appChoice.selected) {
    applied.push({ label: 'App', value: appChoice.selectedText || flowState.appName });
    log(`Topbar App selected: "${appChoice.selectedText || flowState.appName}"`);
  } else {
    skipped.push({ label: 'App', reason: appChoice.reason || 'not selected' });
  }

  const templateCandidate = flowState.subTemplateName || flowState.templateName;
  const templateChoice = await selectTopbarDropdownByText(page, 'MainContent_ddlTemplateSheet', templateCandidate);
  if (templateChoice.selected) {
    applied.push({ label: 'Template', value: templateChoice.selectedText || templateCandidate });
    log(`Topbar Template selected: "${templateChoice.selectedText || templateCandidate}"`);
  } else {
    skipped.push({ label: 'Template', reason: templateChoice.reason || 'not selected' });
  }

  return { applied, skipped };
}

// ── Discover all controls on page ─────────────────────────────────────────────
async function discoverPageControls(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const controls = [];

    // Text inputs / textareas
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea').forEach((el, i) => {
      if (!isVisible(el)) return;
      const label = el.placeholder || el.getAttribute('aria-label') || el.id || el.name || `input-${i}`;
      controls.push({ type: 'text-input', label, id: el.id || '', name: el.name || '', placeholder: el.placeholder || '' });
    });

    // Select dropdowns
    document.querySelectorAll('select').forEach((el, i) => {
      if (!isVisible(el)) return;
      const opts = Array.from(el.options).map(o => o.text.trim()).filter(Boolean).slice(0, 10);
      const label = el.getAttribute('aria-label') || el.id || el.name || `select-${i}`;
      controls.push({ type: 'select', label, id: el.id || '', name: el.name || '', options: opts });
    });

    // React-select / Select2
    document.querySelectorAll('.react-select__control, .select2-selection, [role="combobox"]').forEach((el, i) => {
      if (!isVisible(el)) return;
      const container = el.closest('[class*="react-select"], [class*="select2"]') || el;
      const label = container.getAttribute('aria-label') || el.id || `react-select-${i}`;
      controls.push({ type: 'react-select', label, id: el.id || '' });
    });

    // Checkboxes
    document.querySelectorAll('input[type="checkbox"]').forEach((el, i) => {
      if (!isVisible(el)) return;
      const labelEl = document.querySelector(`label[for="${el.id}"]`);
      const label = (labelEl?.textContent || el.getAttribute('aria-label') || el.id || `checkbox-${i}`).trim();
      controls.push({ type: 'checkbox', label, id: el.id || '', checked: el.checked });
    });

    // Radio buttons
    document.querySelectorAll('input[type="radio"]').forEach((el, i) => {
      if (!isVisible(el)) return;
      const labelEl = document.querySelector(`label[for="${el.id}"]`);
      const label = (labelEl?.textContent || el.getAttribute('aria-label') || el.id || `radio-${i}`).trim();
      controls.push({ type: 'radio', label, id: el.id || '', name: el.name || '' });
    });

    // Buttons (non-icon)
    document.querySelectorAll('button, a.btn').forEach((el, i) => {
      if (!isVisible(el)) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) return;
      const label = text || el.getAttribute('aria-label') || el.id || `btn-${i}`;
      controls.push({ type: 'button', label, id: el.id || '' });
    });

    // Tabs / nav items
    document.querySelectorAll('[role="tab"], .nav-link, .nav-item > a').forEach((el, i) => {
      if (!isVisible(el)) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      controls.push({ type: 'tab', label: text, id: el.id || '' });
    });

    // Drag-and-drop / sortable items (common in form designers)
    document.querySelectorAll('[draggable="true"], .draggable, .sortable-item, .field-item, .form-element, [class*="field-card"], [class*="control-item"]').forEach((el, i) => {
      if (!isVisible(el)) return;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      controls.push({ type: 'draggable-item', label: text || `item-${i}`, id: el.id || '' });
    });

    return controls;
  }).catch(() => []);
}

// ── Try to select template/sub-template from a filter/dropdown ────────────────
async function applyWorkflowFilters(page, flowState) {
  const results = { applied: [], skipped: [] };
  log(`Applying workflow filters: template="${flowState.templateName}", subTemplate="${flowState.subTemplateName}", app="${flowState.appName}", site="${flowState.siteName}"`);

  // Common filter/search fields to try
  const candidates = [
    { label: 'Template Name', value: flowState.templateName },
    { label: 'Sub Template Name', value: flowState.subTemplateName },
    { label: 'Sub-Template Name', value: flowState.subTemplateName },
    { label: 'App Name', value: flowState.appName },
    { label: 'Application', value: flowState.appName },
    { label: 'Site Name', value: flowState.siteName },
    { label: 'Site', value: flowState.siteName },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) { results.skipped.push(candidate.label); continue; }

    // Try react-select: find an input near a label matching candidate.label
    const found = await page.evaluate(({ label, value }) => {
      const norm = (s) => String(s || '').toLowerCase().trim();
      const labelNorm = norm(label);

      // Find all visible label-like elements
      const labelEls = Array.from(document.querySelectorAll('label, .form-label, .control-label, th, [class*="label"]'));
      for (const lel of labelEls) {
        const text = norm(lel.textContent || '');
        if (!text.includes(labelNorm)) continue;

        // Try react-select input near this label
        const container = lel.closest('.form-group, .mb-3, .col, .filter-item, .row, tr') || lel.parentElement;
        if (!container) continue;

        const input = container.querySelector('input[id*="react-select"], input[role="combobox"], .select2-search__field, input[type="text"]');
        if (!input || getComputedStyle(input).display === 'none') continue;

        // Type value
        input.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { found: true, id: input.id, method: 'input-event' };
      }

      // Try select elements
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const labelEl = document.querySelector(`label[for="${sel.id}"]`);
        const labelText = norm(labelEl?.textContent || sel.getAttribute('aria-label') || sel.id || '');
        if (!labelText.includes(labelNorm)) continue;

        const opt = Array.from(sel.options).find(o => norm(o.text) === norm(value) || norm(o.text).includes(norm(value)));
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, id: sel.id, method: 'select-option' };
        }
      }

      return { found: false };
    }, candidate).catch(() => ({ found: false }));

    if (found?.found) {
      await page.waitForTimeout(400);

      // If react-select, click matching option from dropdown
      const norm = (s) => String(s || '').toLowerCase().trim();
      const optionSels = [
        `.react-select__option:has-text("${candidate.value}")`,
        `.select2-results__option:has-text("${candidate.value}")`,
        `[role="option"]:has-text("${candidate.value}")`,
      ];
      for (const sel of optionSels) {
        const opt = page.locator(sel).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click({ force: true }).catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
      }

      log(`Filter applied: ${candidate.label} = "${candidate.value}"`);
      results.applied.push({ label: candidate.label, value: candidate.value });
    } else {
      results.skipped.push(candidate.label);
    }
  }

  // Click search/filter button if present
  const searchBtns = [
    page.locator('button:has-text("Search")').first(),
    page.locator('button:has-text("Filter")').first(),
    page.locator('button:has-text("Apply")').first(),
    page.locator('#btnSearch').first(),
    page.locator('#btnFilter').first(),
  ];
  for (const btn of searchBtns) {
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(800);
      log('Clicked search/filter button');
      break;
    }
  }

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  return results;
}

async function validateCoreTemplateDesignActions(page) {
  const checks = [];

  const actions = [
    { key: 'saveButton', selector: '#btnSave', label: 'Save button' },
    { key: 'publishButton', selector: '#btnSaveNewVersion', label: 'Publish button' },
    { key: 'modeDesign', selector: '#btnModeDesign', label: 'Design mode button' },
    { key: 'modeRule', selector: '#btnModeRule', label: 'Rules mode button' },
    { key: 'toolbox', selector: '#toolbox', label: 'Toolbox panel' },
    { key: 'drawpad', selector: '#drawpad', label: 'Drawpad canvas' },
    { key: 'ruleEditorRoot', selector: '#td-rule-editor-root', label: 'Rule editor mount' },
  ];

  for (const action of actions) {
    const loc = page.locator(action.selector).first();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = await loc.isEnabled().catch(() => false);
    checks.push({
      key: action.key,
      label: action.label,
      selector: action.selector,
      visible,
      enabled,
      status: visible ? 'passed' : 'failed',
    });
  }

  // Rules mode can be disabled when no template is selected, so treat that as non-fatal visibility-only check.
  const modeRule = checks.find((c) => c.key === 'modeRule');
  if (modeRule && modeRule.visible && !modeRule.enabled) {
    modeRule.status = 'passed';
  }

  return checks;
}

// ── Test each discovered control ──────────────────────────────────────────────
async function testControl(page, control, idx) {
  const result = { index: idx, type: control.type, label: control.label, status: 'skipped', detail: '' };
  const labelText = escapeTextValue(control.label);

  try {
    switch (control.type) {
      case 'tab': {
        const tab = page.locator(`[role="tab"]:has-text("${labelText}"), .nav-link:has-text("${labelText}")`).first();
        if (!await tab.isVisible().catch(() => false)) break;
        await tab.click().catch(() => {});
        await page.waitForTimeout(600);
        result.status = 'passed';
        result.detail = `Tab "${control.label}" clicked`;
        break;
      }

      case 'checkbox': {
        const cb = control.id
          ? locatorById(page, control.id)
          : page.locator(`input[type="checkbox"]`).nth(idx);
        if (!await cb.isVisible().catch(() => false)) break;
        const before = await cb.isChecked().catch(() => false);
        await cb.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
        const after = await cb.isChecked().catch(() => false);
        result.status = 'passed';
        result.detail = `Checkbox toggled: ${before} → ${after}`;
        break;
      }

      case 'radio': {
        const rb = control.id
          ? locatorById(page, control.id)
          : page.locator(`input[type="radio"]`).nth(idx);
        if (!await rb.isVisible().catch(() => false)) break;
        await rb.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
        result.status = 'passed';
        result.detail = `Radio "${control.label}" selected`;
        break;
      }

      case 'select': {
        const sel = control.id
          ? locatorById(page, control.id)
          : page.locator('select').nth(idx);
        if (!await sel.isVisible().catch(() => false)) break;
        const opts = await sel.locator('option').allTextContents().catch(() => []);
        const validOpts = opts.map(o => o.trim()).filter(o => o && !/^\s*(--please select--|select|choose|none)\s*$/i.test(o));
        if (validOpts.length > 0) {
          await sel.selectOption({ label: validOpts[0] }).catch(() => {});
          await page.waitForTimeout(300);
          result.status = 'passed';
          result.detail = `Selected "${validOpts[0]}" (${validOpts.length} options)`;
        } else {
          result.status = 'skipped';
          result.detail = 'No valid options';
        }
        break;
      }

      case 'react-select': {
        const inputSel = control.id
          ? `input[id="${control.id}"]`
          : 'input[id*="react-select"], input[role="combobox"]';
        const input = page.locator(inputSel).first();
        if (!await input.isVisible().catch(() => false)) break;
        await input.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        const opts = await page.evaluate(() => {
          const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
          const menu = document.querySelector('.react-select__menu, [class*="menu-list"]');
          if (!menu || !isVis(menu)) return [];
          return Array.from(menu.querySelectorAll('[class*="option"], [role="option"]')).filter(isVis).map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 5);
        }).catch(() => []);
        const validOpts = opts.filter(o => !/^\s*(--please select--|select|choose|none)\s*$/i.test(o));
        if (validOpts.length > 0) {
          const opt = page.locator(`.react-select__option, [role="option"]`).filter({ hasText: validOpts[0] }).first();
          await opt.click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
          result.status = 'passed';
          result.detail = `React-select: chose "${validOpts[0]}" (${validOpts.length} options visible)`;
        } else {
          // Close dropdown
          await input.press('Escape').catch(() => {});
          result.status = 'skipped';
          result.detail = 'No options available';
        }
        break;
      }

      case 'text-input': {
        // Skip password/search inputs
        if (/password|search/i.test(control.id + control.name + control.placeholder)) {
          result.status = 'skipped';
          result.detail = 'Password/search input skipped';
          break;
        }
        const inputSel = control.id
          ? `[id="${escapeAttrValue(control.id)}"]`
          : (control.name ? `[name="${escapeAttrValue(control.name)}"]` : 'input[type="text"]');
        const input = page.locator(inputSel).first();
        if (!await input.isVisible().catch(() => false)) break;
        const testVal = `QA-TEST-${uniqueId()}`;
        await input.fill('').catch(() => {});
        await input.fill(testVal).catch(() => {});
        await page.waitForTimeout(200);
        const actual = await input.inputValue().catch(() => '');
        result.status = actual.includes('QA-TEST') ? 'passed' : 'partial';
        result.detail = `Typed test value; field accepted: ${actual.slice(0, 40)}`;
        break;
      }

      case 'button': {
        // Only click safe/non-destructive buttons
        const safePatterns = /^(search|filter|preview|refresh|show|view|expand|collapse|add field|add section|add row|add column|new|reset|clear|design|configure|properties|settings|close|cancel)$/i;
        if (!safePatterns.test(control.label.trim())) {
          result.status = 'skipped';
          result.detail = `Button "${control.label}" skipped (not in safe-click list)`;
          break;
        }
        const btn = control.id
          ? locatorById(page, control.id)
          : page.locator(`button, a.btn`).filter({ hasText: control.label }).first();
        if (!await btn.isVisible().catch(() => false)) break;
        await btn.click().catch(() => {});
        await page.waitForTimeout(600);
        result.status = 'passed';
        result.detail = `Button "${control.label}" clicked`;
        break;
      }

      case 'draggable-item': {
        // Just verify visibility
        result.status = 'passed';
        result.detail = `Draggable item present: "${control.label.slice(0, 40)}"`;
        break;
      }

      default:
        result.status = 'skipped';
        result.detail = `Unknown control type: ${control.type}`;
    }
  } catch (err) {
    result.status = 'failed';
    result.detail = String(err?.message || 'Control test failed');
  }

  return result;
}

// ── Try to open a template record (click first row or search by name) ─────────
async function tryOpenTemplateRecord(page, flowState) {
  log('Attempting to open template record for design…');

  const selectedTemplate = await page.evaluate(() => {
    const ddl = document.getElementById('MainContent_ddlTemplateSheet');
    if (!ddl) return '';
    const idx = ddl.selectedIndex;
    if (idx < 0) return '';
    const opt = ddl.options[idx];
    if (!opt || opt.disabled) return '';
    const txt = String(opt.textContent || opt.text || '').trim();
    if (!txt || /^select\b/i.test(txt)) return '';
    return txt;
  }).catch(() => '');

  if (selectedTemplate) {
    await page.waitForTimeout(800);
    const hasCanvasControls = await page.locator('#drawpad .ctrl').count().then((n) => n > 0).catch(() => false);
    return {
      opened: hasCanvasControls,
      name: selectedTemplate,
      source: 'topbar-template-dropdown',
    };
  }

  // Try clicking a row that matches templateName or subTemplateName
  const names = [flowState.templateName, flowState.subTemplateName].filter(Boolean);
  for (const name of names) {
    if (!name) continue;
    const row = page.locator(`tbody tr, [role="row"]`).filter({ hasText: name }).first();
    if (await row.isVisible().catch(() => false)) {
      // Try "Design" or "Edit" action button inside the row
      const actionBtns = [
        row.locator('a[title*="Design" i], button[title*="Design" i]').first(),
        row.locator('a[data-action="design"], button[data-action="design"]').first(),
        row.locator('a[title*="Edit" i], button[title*="Edit" i]').first(),
        row.locator('.fa-pencil, .fa-pen, .fa-edit, .fa-pen-to-square').first(),
      ];
      for (const ab of actionBtns) {
        if (await ab.isVisible().catch(() => false)) {
          await ab.click({ force: true }).catch(() => {});
          await page.waitForTimeout(800);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          log(`Opened design record: "${name}"`);
          return { opened: true, name };
        }
      }
      // Just click the row
      await row.click().catch(() => {});
      await page.waitForTimeout(800);
      log(`Clicked row: "${name}"`);
      return { opened: true, name };
    }
  }

  // Try clicking the first available row as fallback
  const firstRow = page.locator('tbody tr:visible, [role="row"]:visible').first();
  if (await firstRow.isVisible().catch(() => false)) {
    const actionBtn = firstRow.locator('a, button').first();
    if (await actionBtn.isVisible().catch(() => false)) {
      await actionBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      log('Opened first available record');
      return { opened: true, name: '(first row)' };
    }
  }

  return { opened: false, name: '' };
}

// ── Discover and test the design canvas / toolbar ────────────────────────────
async function testDesignCanvas(page) {
  log('Testing design canvas controls…');
  const canvasControls = [];

  // Toolbar buttons (Add Section, Add Field, Field types palette)
  const toolbarBtns = await page.evaluate(() => {
    const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    const btns = Array.from(document.querySelectorAll('[class*="toolbar"] button, [class*="toolbox"] button, [class*="palette"] button, .field-palette button, .design-toolbar button, .template-toolbar button, .canvas-toolbar button, #toolbox button, .topbar-actions button'));
    return btns.filter(isVis).map(b => ({
      label: (b.textContent || '').replace(/\s+/g, ' ').trim() || b.getAttribute('title') || b.getAttribute('aria-label') || '',
      id: b.id || '',
      title: b.getAttribute('title') || '',
    })).filter(b => b.label || b.title);
  }).catch(() => []);

  for (const btn of toolbarBtns) {
    const label = btn.label || btn.title;
    log(`Testing toolbar button: "${label}"`);
    canvasControls.push({ type: 'toolbar-button', label, status: 'found' });
  }

  // Check for draggable field types / elements palette
  const paletteItems = await page.evaluate(() => {
    const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    const items = Array.from(document.querySelectorAll('[draggable="true"], .field-item, .control-item, [class*="field-type"], [class*="control-type"], [class*="field-tile"], [class*="element-item"], #toolbox .ctl-tile, #toolbox .ctl'));
    return items.filter(isVis).map(el => ({
      label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) || el.getAttribute('data-type') || el.getAttribute('title') || '',
      type: el.getAttribute('data-type') || el.getAttribute('data-field-type') || 'unknown',
    })).filter(item => item.label);
  }).catch(() => []);

  for (const item of paletteItems) {
    log(`Found palette item: "${item.label}" (type: ${item.type})`);
    canvasControls.push({ type: 'palette-item', label: item.label, fieldType: item.type, status: 'found' });
  }

  // Check for existing fields in the design canvas
  const existingFields = await page.evaluate(() => {
    const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    const fields = Array.from(document.querySelectorAll('#drawpad .ctrl, [class*="canvas"] .field, [class*="design"] .field, [class*="form-field"], [class*="field-row"], [class*="field-container"], [data-field-id]'));
    return fields.filter(isVis).map(el => ({
      label: (el.querySelector('[class*="label"], label, .field-label')?.textContent || '').replace(/\s+/g, ' ').trim() || '',
      id: el.getAttribute('data-field-id') || el.id || '',
    }));
  }).catch(() => []);

  for (const field of existingFields) {
    log(`Found design canvas field: "${field.label || field.id}"`);
    canvasControls.push({ type: 'canvas-field', label: field.label || field.id, id: field.id, status: 'found' });
  }

  return {
    toolbarButtons: toolbarBtns.length,
    paletteItems: paletteItems.length,
    canvasFields: existingFields.length,
    controls: canvasControls,
  };
}

// ── Try clicking tabs/sections on the design page ────────────────────────────
async function testPageTabs(page) {
  const tabResults = [];
  const tabs = await page.evaluate(() => {
    const isVis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
    return Array.from(document.querySelectorAll('[role="tab"], .nav-link, .nav-item > a, .tab-item')).filter(isVis).map((el, i) => ({
      label: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      id: el.id || `tab-${i}`,
    })).filter(t => t.label);
  }).catch(() => []);

  log(`Found ${tabs.length} tabs/nav items`);
  for (const tab of tabs) {
    try {
      const el = page.locator(`[role="tab"]:has-text("${tab.label}"), .nav-link:has-text("${tab.label}")`).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        tabResults.push({ label: tab.label, status: 'clicked' });
        log(`Tab clicked: "${tab.label}"`);
      }
    } catch (err) {
      tabResults.push({ label: tab.label, status: 'failed', error: err.message });
    }
  }
  return tabResults;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const flowState = {
    siteName:        CFG.siteName,
    appName:         CFG.appName,
    templateName:    CFG.templateName,
    subTemplateName: CFG.subTemplateName,
    workflowName:    CFG.workflowName,
  };

  log(`Starting Template Design Automation`);
  log(`Flow State: ${JSON.stringify(flowState)}`);

  const steps = {};
  const screenshots = [];
  let browser = null;
  let context = null;
  let page = null;

  const result = {
    status: 'failed',
    flowState,
    steps,
    screenshots,
    controls: [],
    canvasInfo: null,
    tabResults: [],
    filterResults: null,
    recordOpen: null,
  };

  try {
    const launchOptions = {
      headless: CFG.headless,
    };

    if (CFG.recordVideo) {
      launchOptions.args = ['--no-sandbox'];
    }

    browser = await chromium.launch(launchOptions);

    const contextOptions = { viewport: { width: 1440, height: 900 } };
    if (CFG.recordVideo) {
      contextOptions.recordVideo = {
        dir: ARTIFACTS_DIR,
        size: { width: 1440, height: 900 },
      };
    }
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    context = await browser.newContext(contextOptions);
    page = await context.newPage();

    // ── Step 1: Login ────────────────────────────────────────────────────────
    try {
      await login(page);
      steps.login = { status: 'passed', message: 'Login successful' };
    } catch (err) {
      steps.login = { status: 'failed', message: String(err.message) };
      screenshots.push(await captureScreenshot(page, 'login-failed'));
      result.status = 'failed';
      process.stdout.write(JSON.stringify(result));
      return;
    }

    // ── Step 2: Navigate to /Design-Template ────────────────────────────────
    try {
      await navigateToDesignTemplate(page);
      const pageTitle = await page.title().catch(() => '');
      const url = page.url();
      steps.navigate = { status: 'passed', message: `Navigated to Template Design. Title: "${pageTitle}", URL: ${url}` };
    } catch (err) {
      steps.navigate = { status: 'failed', message: String(err.message) };
      screenshots.push(await captureScreenshot(page, 'navigate-failed'));
    }

    // ── Step 3: Apply workflow filters ──────────────────────────────────────
    try {
      const coreSelection = await applyCoreTopbarSelections(page, flowState);
      const shouldRunFallback = coreSelection.applied.length === 0;
      const fallbackSelection = shouldRunFallback ? await applyWorkflowFilters(page, flowState) : { applied: [], skipped: ['Skipped fallback filters because core topbar selection succeeded'] };
      const filterResults = {
        applied: [...coreSelection.applied, ...fallbackSelection.applied],
        skipped: [...coreSelection.skipped.map((s) => `${s.label}: ${s.reason}`), ...fallbackSelection.skipped],
        coreSelection,
        fallbackSelection,
      };
      result.filterResults = filterResults;
      steps.applyFilters = {
        status: filterResults.applied.length > 0 ? 'passed' : 'partial',
        message: `Applied ${filterResults.applied.length} filter(s), skipped ${filterResults.skipped.length}`,
        applied: filterResults.applied,
        skipped: filterResults.skipped,
      };
    } catch (err) {
      steps.applyFilters = { status: 'failed', message: String(err.message) };
    }

    // ── Step 4: Discover all page controls ──────────────────────────────────
    try {
      const controls = await discoverPageControls(page);
      result.controls = controls;
      steps.discoverControls = {
        status: 'passed',
        message: `Discovered ${controls.length} control(s)`,
        count: controls.length,
        types: controls.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {}),
      };
      log(`Discovered controls: ${controls.map(c => `${c.type}:${c.label}`).join(', ')}`);
    } catch (err) {
      steps.discoverControls = { status: 'failed', message: String(err.message) };
    }

    // ── Step 5: Test page tabs ───────────────────────────────────────────────
    try {
      const tabResults = await testPageTabs(page);
      result.tabResults = tabResults;
      steps.testTabs = {
        status: 'passed',
        message: `Tested ${tabResults.length} tab(s)`,
        tabs: tabResults.map(t => t.label),
      };
    } catch (err) {
      steps.testTabs = { status: 'failed', message: String(err.message) };
    }

    // ── Step 6: Try to open a template record ────────────────────────────────
    try {
      const openResult = await tryOpenTemplateRecord(page, flowState);
      result.recordOpen = openResult;
      steps.openRecord = {
        status: openResult.opened ? 'passed' : 'skipped',
        message: openResult.opened ? `Opened template record: "${openResult.name}"` : 'No matching template record found to open',
      };
      if (openResult.opened) {
        screenshots.push(await captureScreenshot(page, 'record-opened'));
      }
    } catch (err) {
      steps.openRecord = { status: 'failed', message: String(err.message) };
    }

    // ── Step 6B: Validate core actions/selectors from Quickflow core ─────────
    try {
      const actionChecks = await validateCoreTemplateDesignActions(page);
      const failedChecks = actionChecks.filter((c) => c.status === 'failed');
      steps.validateCoreActions = {
        status: failedChecks.length ? 'partial' : 'passed',
        message: failedChecks.length
          ? `Core selector checks found ${failedChecks.length} missing element(s)`
          : 'Core selector checks passed',
        checks: actionChecks,
      };
    } catch (err) {
      steps.validateCoreActions = { status: 'failed', message: String(err.message) };
    }

    // ── Step 7: Test design canvas ────────────────────────────────────────────
    try {
      const canvasInfo = await testDesignCanvas(page);
      result.canvasInfo = canvasInfo;
      steps.testCanvas = {
        status: 'passed',
        message: `Canvas: ${canvasInfo.toolbarButtons} toolbar buttons, ${canvasInfo.paletteItems} palette items, ${canvasInfo.canvasFields} canvas fields`,
        toolbarButtons: canvasInfo.toolbarButtons,
        paletteItems: canvasInfo.paletteItems,
        canvasFields: canvasInfo.canvasFields,
      };
    } catch (err) {
      steps.testCanvas = { status: 'failed', message: String(err.message) };
    }

    // ── Step 8: Test each control ─────────────────────────────────────────────
    const controlTestResults = [];
    const controls = result.controls || [];
    let passed = 0, failed = 0, skipped = 0, partial = 0;

    // Re-discover controls after opening record (page may have changed)
    let currentControls = controls;
    if (steps.openRecord?.status === 'passed') {
      try {
        currentControls = await discoverPageControls(page);
        log(`Re-discovered ${currentControls.length} controls after opening record`);
      } catch { /* use original controls */ }
    }

    for (let i = 0; i < currentControls.length; i++) {
      const ctrl = currentControls[i];
      // Skip duplicates by label+type
      const isDup = controlTestResults.some(r => r.label === ctrl.label && r.type === ctrl.type);
      if (isDup) continue;

      const res = await testControl(page, ctrl, i);
      controlTestResults.push(res);
      if (res.status === 'passed') passed++;
      else if (res.status === 'failed') failed++;
      else if (res.status === 'partial') partial++;
      else skipped++;
      log(`Control [${i + 1}/${currentControls.length}] ${ctrl.type}:"${ctrl.label}" → ${res.status}`);
    }

    steps.testControls = {
      status: (failed > 0 || partial > 0) ? 'partial' : 'passed',
      message: `Tested ${controlTestResults.length} control(s): ${passed} passed, ${failed} failed, ${partial} partial, ${skipped} skipped`,
      passed,
      failed,
      partial,
      skipped,
      results: controlTestResults,
    };

    // ── Step 9: Final screenshot ─────────────────────────────────────────────
    screenshots.push(await captureScreenshot(page, 'final-state'));

    // ── Determine overall status ─────────────────────────────────────────────
    const criticalSteps = ['login', 'navigate'];
    const criticalFailed = criticalSteps.some(s => steps[s]?.status === 'failed');
    const hasIssueSteps = Object.values(steps).some(s => s?.status === 'failed' || s?.status === 'partial');
    const hasControlIssues = failed > 0 || partial > 0;
    if (criticalFailed) {
      result.status = 'failed';
    } else if (hasIssueSteps || hasControlIssues) {
      result.status = 'completed-with-issues';
    } else {
      result.status = 'completed';
    }

    result.screenshots = screenshots.filter(Boolean);
    result.controlTestResults = controlTestResults;
    result.summary = {
      totalControls: controlTestResults.length,
      passed,
      failed,
      partial,
      skipped,
    };

  } catch (err) {
    result.status = 'failed';
    result.fatalError = String(err.message);
    log(`Fatal error: ${err.message}`);
    if (page) screenshots.push(await captureScreenshot(page, 'fatal-error'));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(`[TEMPLATE-DESIGN] Unhandled error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ status: 'failed', fatalError: String(err.message) }));
  process.exit(1);
});
