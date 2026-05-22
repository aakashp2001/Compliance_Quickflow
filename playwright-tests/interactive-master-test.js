'use strict';

const { chromium } = require('@playwright/test');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { discoverMasters } = require('./helpers/discoverMasters');

const SEL = {
  username: '#txtUsername',
  password: '#txtPassword',
  loginBtn: '#btnLogin',
  unlockBtn: '#btnUnlock',
  homeReady: '#divAppButton',
  pageTitle: '.pageTitle',
  createBtn: 'button:has-text("Create"):visible, a:has-text("Create"):visible, [role="button"]:has-text("Create"):visible',
  offcanvas: '#masterFormOffcanvas .offcanvas-body',
  saveBtn: '#btnSave',
  reasonTextarea: '#reasonTextarea',
  submitBtn: ':text("Submit")',
  successCreate: ':text("Data saved successfully")',
  confirmOk: '.swal2-confirm',
};

const CFG = {
  loginUrl: process.env.QT_URL || 'https://ipdev.quickflow.in/login',
  username: process.env.QT_USER || 'dhruvi',
    password: process.env.QT_PASS || '',
}
const BASE_ORIGIN = new URL(CFG.loginUrl).origin;

function randomText(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseIndexSelection(raw, max) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= max)
    .map((n) => n - 1);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const txt = String(raw || '').trim();
    if (!txt) continue;
    const key = normalizeText(txt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(txt);
  }
  return out;
}

function inferSourceMaster(fieldDisplayName, fieldId, currentMasterName) {
  const hay = `${fieldDisplayName || ''} ${fieldId || ''}`.toLowerCase();
  const current = String(currentMasterName || '').toLowerCase();

  const rules = [
    { re: /country/, master: 'Country' },
    { re: /time\s*zone|timezone/, master: 'TimeZone' },
    { re: /department/, master: 'Department' },
    { re: /designation/, master: 'Designation' },
    { re: /employee\s*type|employeetype/, master: 'Employee-Type' },
    { re: /location/, master: 'Location' },
    { re: /site/, master: 'Site' },
    { re: /role/, master: 'Role' },
    { re: /user/, master: 'User' },
  ];

  for (const rule of rules) {
    if (rule.re.test(hay) && rule.master.toLowerCase() !== current) {
      return rule.master;
    }
  }

  return null;
}

async function collectDropdownOptions(page, field) {
  const selector = field.id ? `[id="${field.id}"]` : null;
  if (!selector) return [];

  const isNativeSelect = await page.locator(selector).evaluate((el) => el.tagName.toLowerCase() === 'select').catch(() => false);
  if (isNativeSelect) {
    const nativeOptions = await page.evaluate((fieldId) => {
      const el = document.getElementById(fieldId);
      if (!el) return [];
      return Array.from(el.querySelectorAll('option'))
        .map((o) => (o.textContent || '').trim())
        .filter((t) => t && t !== '-1');
    }, field.id);
    return uniqueNonEmpty(nativeOptions);
  }

  const container = page.locator(selector).first();
  await container.click({ force: true });
  await page.waitForTimeout(500);

  const options = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.react-select__option'))
      .map((o) => (o.textContent || '').trim())
      .filter(Boolean);
  }).catch(() => []);

  await page.keyboard.press('Escape').catch(() => { });
  return uniqueNonEmpty(options);
}

async function collectMasterPrimaryValues(page, masterName, baseURL) {
  await navigateToMaster(page, masterName, baseURL);
  await page.waitForSelector('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr', { timeout: 20000 });
  await page.waitForTimeout(800);

  const values = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr'));
    const result = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'))
        .map((td) => (td.textContent || '').trim())
        .filter(Boolean);

      if (!cells.length) continue;
      if (cells.join(' ').toLowerCase().includes('no data')) continue;
      if (cells.join(' ').toLowerCase().includes('no matching')) continue;

      const nonNumeric = cells.find((c) => !/^\d+$/.test(c));
      result.push(nonNumeric || cells[0]);
    }

    return result;
  });

  return uniqueNonEmpty(values);
}

async function verifyDropdownAgainstMaster({ page, field, sourceMaster, getMasterValues }) {
  const dropdownOptions = await collectDropdownOptions(page, field);
  const masterValues = await getMasterValues(sourceMaster);

  const optionSet = new Set(dropdownOptions.map((v) => normalizeText(v)));
  const missing = masterValues.filter((v) => !optionSet.has(normalizeText(v)));

  console.log(`  [VERIFY] ${field.displayName} <- ${sourceMaster}`);
  console.log(`  [VERIFY] master values: ${masterValues.length}, dropdown options: ${dropdownOptions.length}`);

  if (missing.length) {
    const sample = missing.slice(0, 10).join(', ');
    throw new Error(
      `Dropdown verification failed for "${field.displayName}". Missing ${missing.length} value(s) from ${sourceMaster}. Sample: ${sample}`
    );
  }

  console.log('  [VERIFY] PASS: all master values are available in the dropdown.');
}

async function ask(rl, question, fallback = '') {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

async function askYesNo(rl, question, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const raw = (await rl.question(question + suffix)).trim().toLowerCase();
  if (!raw) return defaultYes;
  return raw === 'y' || raw === 'yes';
}

async function askNumber(rl, question, def, min, max) {
  while (true) {
    const raw = await ask(rl, `${question} (${min}-${max}) [${def}]: `, String(def));
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    console.log(`Please enter an integer between ${min} and ${max}.`);
  }
}

async function openLoginPage(page) {
  const candidates = [
    CFG.loginUrl,
    `${BASE_ORIGIN}/`,
    BASE_ORIGIN,
  ];

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      // Wait up to 10 s for the login form to render (SPA needs time after load)
      const hasLogin = await page.locator(SEL.username).waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      if (hasLogin) {
        return;
      }
    } catch {
      // Try next candidate URL.
    }
  }

  throw new Error(`Could not open a login page using: ${candidates.join(', ')}`);
}

async function login(page, username, password) {
  await openLoginPage(page);
  await page.waitForSelector(SEL.username, { timeout: 30000 });
  await page.fill(SEL.username, username);
  await page.fill(SEL.password, password);
  await page.click(SEL.loginBtn);

  const unlockVisible = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
  if (unlockVisible) {
    await page.click(SEL.unlockBtn);
  }

  await page.waitForSelector(SEL.homeReady, { timeout: 30000 });
}

async function navigateToMaster(page, name, baseURL) {
  // Always navigate via absolute URL — avoids unreliable sidebar click after discovery.
  const url = `${baseURL}/${name}`;
  console.log(`[NAV] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait until any .pageTitle is visible with non-empty text.
  // Some pages render multiple .pageTitle nodes and the first one can stay hidden.
  await page.waitForFunction(
    () => {
      const nodes = Array.from(document.querySelectorAll('.pageTitle'));
      return nodes.some((el) => {
        const style = window.getComputedStyle(el);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          el.offsetHeight > 0 &&
          el.offsetWidth > 0;
        return visible && (el.textContent || '').trim().length > 0;
      });
    },
    { timeout: 45000 }
  );

  // Ensure create action is visible before moving ahead to form open.
  await page.locator(SEL.createBtn).first().waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(800);
}

async function openCreateForm(page) {
  await page.locator(SEL.createBtn).first().click();
  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function getFields(page) {
  return page.evaluate(() => {
    const combined = [
      ...(window.data?.tblFormDtl || []),
      ...(window.data?.tblFormSubDtl || []),
    ];

    const metaById = new Map();
    for (const item of combined) {
      const id = `${item.vColName}${item.iFormDtlId}`;
      metaById.set(id, {
        displayName: item.vDisplayName || id,
        columnToShow: item.vColumnToShow || item.vDisplayName || id,
        maxLength: Number(item.iMaxLength || item.vMaxLength || 0) || 0,
        required: String(item.cMandatory || item.isMandatory || '').toUpperCase() === 'Y',
      });
    }

    const fields = [];
    const elements = Array.from(document.querySelectorAll('.offcanvas-body .ele'));

    for (let idx = 0; idx < elements.length; idx++) {
      const el = elements[idx];
      const tag = (el.tagName || '').toLowerCase();
      const id = el.getAttribute('id') || '';
      const className = el.getAttribute('class') || '';
      const inputType = el.getAttribute('type') || '';
      const disabled = !!el.disabled;
      const maxLengthAttr = Number(el.getAttribute('maxlength') || 0) || 0;

      let elementType = tag;
      if (tag === 'input') {
        elementType = inputType || 'text';
        if (className.includes('numeric')) elementType = 'number';
        if (className.includes('datetimepicker-input')) elementType = 'date';
      } else if (tag === 'div' && className.includes('checkboxlist')) {
        elementType = 'checkbox';
      } else if (
        tag === 'div' &&
        (el.querySelector('input[aria-autocomplete], input[role="combobox"], .react-select__input input') ||
          className.includes('container'))
      ) {
        // Many masters render dropdowns with React Select inside a DIV container.
        elementType = 'select';
      } else if (tag === 'select') {
        elementType = el.multiple ? 'multiselect' : 'select';
      }

      const meta = metaById.get(id) || {};

      const options = [];
      if (elementType === 'select' || elementType === 'multiselect') {
        Array.from(el.querySelectorAll('option')).forEach((opt) => {
          if (opt.value && opt.value !== '-1') {
            options.push({ value: opt.value, label: (opt.textContent || '').trim() });
          }
        });
      }

      if (elementType === 'checkbox' || elementType === 'radio') {
        Array.from(el.querySelectorAll('input[type="checkbox"], input[type="radio"]')).forEach((opt, i) => {
          const label = opt.closest('label')?.textContent?.trim() || opt.id || `option_${i + 1}`;
          options.push({ value: opt.id || `option_${i + 1}`, label });
        });
      }

      fields.push({
        idx,
        id,
        displayName: meta.displayName || id || `field_${idx + 1}`,
        elementType,
        disabled,
        required: !!meta.required,
        maxLength: Math.max(maxLengthAttr, meta.maxLength || 0),
        options,
      });
    }

    return fields;
  });
}

async function triggerChange(page, id) {
  if (!id) return;
  await page.evaluate((fieldId) => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.$) {
      window.$(el).trigger('change');
    }
  }, id);
}

async function fillField(page, field, payload) {
  const selector = field.id ? `[id="${field.id}"]` : null;
  if (!selector) return;

  if (payload.type === 'text') {
    await page.fill(selector, payload.value);
    await triggerChange(page, field.id);
    return;
  }

  if (payload.type === 'select') {
    // Try native <select> first.
    const isNativeSelect = await page.locator(selector).evaluate((el) => el.tagName.toLowerCase() === 'select').catch(() => false);

    if (isNativeSelect) {
      await page.selectOption(selector, payload.value);
      await triggerChange(page, field.id);
      return;
    }

    // Fallback for React-select style DIV containers.
    const searchText = String(payload.label || payload.value || '').trim();
    const container = page.locator(selector).first();
    await container.click({ force: true });

    const comboInput = container.locator('input').first();
    const hasInput = await comboInput.isVisible().catch(() => false);

    if (hasInput) {
      await comboInput.fill('');
      if (searchText) {
        await comboInput.type(searchText, { delay: 25 });
      }
    }

    const optionByText = page.locator('.react-select__option').filter({ hasText: searchText }).first();
    const optionVisible = await optionByText.isVisible().catch(() => false);
    if (optionVisible) {
      await optionByText.click();
    } else {
      // If exact match is not found, pick a random available option.
      const options = page.locator('.react-select__option');
      const count = await options.count().catch(() => 0);
      if (count > 0) {
        const randomIndex = Math.floor(Math.random() * count);
        await options.nth(randomIndex).click().catch(async () => {
          // Fallback if random target is not interactable.
          const firstOption = options.first();
          const firstVisible = await firstOption.isVisible().catch(() => false);
          if (firstVisible) {
            await firstOption.click();
          }
        });
      } else if (hasInput) {
        await comboInput.press('ArrowDown').catch(() => { });
        await comboInput.press('Enter').catch(() => { });
      }
    }

    await triggerChange(page, field.id);
    return;
  }

  if (payload.type === 'multiselect') {
    await page.selectOption(selector, payload.values);
    await triggerChange(page, field.id);
    return;
  }

  if (payload.type === 'checkbox') {
    for (const optId of payload.values) {
      const cb = page.locator(`[id="${optId}"]`).first();
      await cb.check({ force: true });
    }
    return;
  }

  if (payload.type === 'radio') {
    const radio = page.locator(`[id="${payload.value}"]`).first();
    await radio.check({ force: true });
  }
}

async function saveForm(page) {
  await page.click(SEL.saveBtn);

  const hasReason = await page.locator(SEL.reasonTextarea).isVisible().catch(() => false);
  if (hasReason) {
    await page.fill(SEL.reasonTextarea, `Interactive automation save ${Date.now()}`);
    await page.locator(SEL.submitBtn).click();
  }

  await page.waitForSelector(SEL.successCreate, { timeout: 20000 });
  const hasOk = await page.locator(SEL.confirmOk).isVisible().catch(() => false);
  if (hasOk) {
    await page.click(SEL.confirmOk);
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  let browser;
  let context;
  let verificationPage;

  try {
    const username = await ask(rl, `Username [${CFG.username}]: `, CFG.username);
    const password = await ask(rl, `Password [${CFG.password}]: `, CFG.password);

    browser = await chromium.launch({ headless: CFG.headless });
    context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page2 = await context.newPage();

    console.log('\nLogging in...');
    await login(page2, username, password);

    // Derive baseURL from the real page URL after login — always correct.
    const baseURL = new URL(page2.url()).origin;
    console.log(`[INFO] Base URL: ${baseURL}`);

    const masterValueCache = new Map();
    const getMasterValues = async (masterName) => {
      if (masterValueCache.has(masterName)) {
        return masterValueCache.get(masterName);
      }

      if (!verificationPage) {
        verificationPage = await context.newPage();
        await login(verificationPage, username, password);
      }

      const values = await collectMasterPrimaryValues(verificationPage, masterName, baseURL);
      masterValueCache.set(masterName, values);
      return values;
    };

    console.log('Discovering masters from navigation...');
    const masters = await discoverMasters(page2, baseURL, [], []);

    if (!masters.length) {
      console.log('No master pages were discovered.');
      return;
    }

    console.log('\nDiscovered masters:');
    masters.forEach((m, i) => console.log(`${i + 1}. ${m.displayName} (${m.name})`));

    const chosenIndex = await askNumber(rl, 'Select one master by number', 1, 1, masters.length);
    const selected = masters[chosenIndex - 1];

    console.log(`\nOpening master: ${selected.displayName}`);
    await navigateToMaster(page2, selected.name, baseURL);
    await openCreateForm(page2);

    const fields = await getFields(page2);
    const editableFields = fields.filter((f) => !f.disabled && f.id && !/RecordID/i.test(f.id));

    if (!editableFields.length) {
      console.log('No editable fields found in this master form.');
      return;
    }

    // ── Step 1: Show all field names upfront ──────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Fields in ${selected.displayName} Create form:`);
    console.log('─'.repeat(60));
    editableFields.forEach((f, i) => {
      const req = f.required ? ' *' : '';
      const maxL = f.maxLength > 0 ? `  max=${f.maxLength}` : '';
      console.log(`  ${String(i + 1).padStart(2)}. [${f.elementType.padEnd(12)}] ${f.displayName}${req}${maxL}`);
    });
    console.log('─'.repeat(60));
    console.log('  * = required field');

    // ── Step 2: Ask which fields to configure ────────────────────────────────
    const selRaw = await ask(
      rl,
      `\nEnter field numbers to fill (comma-separated, e.g. 1,3,5) or type 'all': `,
      'all'
    );

    let selectedIndices;
    if (selRaw.trim().toLowerCase() === 'all') {
      selectedIndices = editableFields.map((_, i) => i);
    } else {
      selectedIndices = parseIndexSelection(selRaw, editableFields.length);
      if (!selectedIndices.length) {
        console.log('No valid field numbers entered. Exiting.');
        return;
      }
    }

    const chosenFields = selectedIndices.map((i) => editableFields[i]);
    console.log(`\nConfiguring ${chosenFields.length} field(s)...`);

    // ── Step 3: Ask validation details per selected field ────────────────────
    const summary = [];

    for (const field of chosenFields) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`Field : ${field.displayName}`);
      console.log(`Type  : ${field.elementType}${field.required ? '  (required)' : ''}`);
      if (field.maxLength > 0) console.log(`MaxLen: ${field.maxLength}`);
      console.log('─'.repeat(50));

      if (['text', 'email', 'tel', 'textarea', 'encryptedtext', 'password'].includes(field.elementType)) {
        const max = field.maxLength > 0 ? Math.min(field.maxLength, 300) : 100;
        const defLen = Math.min(8, max);
        const len = await askNumber(rl, `  Text length to use`, defLen, 1, max);
        const value = randomText(len);
        console.log(`  → Filling with: "${value}"`);
        await fillField(page2, field, { type: 'text', value });
        summary.push({ field: field.displayName, action: `text (len=${len})`, value });
        continue;
      }

      if (['number', 'decimal'].includes(field.elementType)) {
        const def = String(randomNumber(1, 9999));
        const raw = await ask(rl, `  Number value to enter [${def}]: `, def);
        console.log(`  → Filling with: ${raw}`);
        await fillField(page2, field, { type: 'text', value: raw });
        summary.push({ field: field.displayName, action: 'number', value: raw });
        continue;
      }

      if (field.elementType === 'date') {
        const def = todayISO();
        const value = await ask(rl, `  Date value YYYY-MM-DD [${def}]: `, def);
        console.log(`  → Filling with: ${value}`);
        await fillField(page2, field, { type: 'text', value });
        summary.push({ field: field.displayName, action: 'date', value });
        continue;
      }

      if (field.elementType === 'time') {
        const def = nowHHMM();
        const value = await ask(rl, `  Time value HH:MM [${def}]: `, def);
        console.log(`  → Filling with: ${value}`);
        await fillField(page2, field, { type: 'text', value });
        summary.push({ field: field.displayName, action: 'time', value });
        continue;
      }

      if (field.elementType === 'dateandtime') {
        const def = `${todayISO()} ${nowHHMM()}`;
        const value = await ask(rl, `  DateTime value [${def}]: `, def);
        console.log(`  → Filling with: ${value}`);
        await fillField(page2, field, { type: 'text', value });
        summary.push({ field: field.displayName, action: 'datetime', value });
        continue;
      }

      if (field.elementType === 'select') {
        const sourceMaster = inferSourceMaster(field.displayName, field.id, selected.name);
        if (sourceMaster) {
          await verifyDropdownAgainstMaster({
            page: page2,
            field,
            sourceMaster,
            getMasterValues,
          });
        } else {
          console.log('  [VERIFY] No source master mapping found for this dropdown; skipping source-master verification.');
        }

        if (!field.options.length) {
          const hint = await ask(rl, '  Type text to search in dropdown (leave blank to auto-pick first): ', '');
          const showHint = hint || '(auto-pick first)';
          console.log(`  → Selecting using search text: "${showHint}"`);
          await fillField(page2, field, { type: 'select', value: hint, label: hint });
          summary.push({ field: field.displayName, action: 'select (dynamic)', value: showHint });
          continue;
        }

        console.log('  Options:');
        field.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt.label}`));
        const pick = await askNumber(rl, '  Select option number', 1, 1, field.options.length);
        const option = field.options[pick - 1];
        console.log(`  → Selecting: "${option.label}"`);
        await fillField(page2, field, { type: 'select', value: option.value, label: option.label });
        summary.push({ field: field.displayName, action: 'select', value: option.label });
        continue;
      }

      if (field.elementType === 'multiselect') {
        if (!field.options.length) {
          console.log('  No options found, skipping.');
          summary.push({ field: field.displayName, action: 'skipped (no options)' });
          continue;
        }
        console.log('  Options (comma-separate multiple numbers):');
        field.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt.label}`));
        const raw = await ask(rl, '  Enter option numbers (e.g. 1,3): ', '1');
        const indices = parseIndexSelection(raw, field.options.length);
        if (!indices.length) {
          summary.push({ field: field.displayName, action: 'skipped (invalid selection)' });
          continue;
        }
        const values = indices.map((i) => field.options[i].value);
        const labels = indices.map((i) => field.options[i].label).join(', ');
        console.log(`  → Selecting: "${labels}"`);
        await fillField(page2, field, { type: 'multiselect', values });
        summary.push({ field: field.displayName, action: 'multiselect', value: labels });
        continue;
      }

      if (field.elementType === 'checkbox') {
        if (!field.options.length) {
          summary.push({ field: field.displayName, action: 'skipped (no options)' });
          continue;
        }
        console.log('  Checkboxes (comma-separate multiple numbers):');
        field.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt.label}`));
        const raw = await ask(rl, '  Enter option numbers to check (e.g. 1,2): ', '1');
        const indices = parseIndexSelection(raw, field.options.length);
        if (!indices.length) {
          summary.push({ field: field.displayName, action: 'skipped (invalid selection)' });
          continue;
        }
        const ids = indices.map((i) => field.options[i].value);
        const labels = indices.map((i) => field.options[i].label).join(', ');
        console.log(`  → Checking: "${labels}"`);
        await fillField(page2, field, { type: 'checkbox', values: ids });
        summary.push({ field: field.displayName, action: 'checkbox', value: labels });
        continue;
      }

      if (field.elementType === 'radio') {
        if (!field.options.length) {
          summary.push({ field: field.displayName, action: 'skipped (no options)' });
          continue;
        }
        console.log('  Radio options:');
        field.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt.label}`));
        const pick = await askNumber(rl, '  Select option number', 1, 1, field.options.length);
        const option = field.options[pick - 1];
        console.log(`  → Selecting: "${option.label}"`);
        await fillField(page2, field, { type: 'radio', value: option.value });
        summary.push({ field: field.displayName, action: 'radio', value: option.label });
        continue;
      }

      // Fallback for unrecognised types
      console.log('  → Unsupported field type in interactive mode, skipping safely.');
      summary.push({ field: field.displayName, action: `skipped (${field.elementType})` });
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('FILL SUMMARY');
    console.log('═'.repeat(60));
    summary.forEach((s, i) => {
      const val = s.value ? ` → ${s.value}` : '';
      console.log(`  ${String(i + 1).padStart(2)}. ${s.field}: ${s.action}${val}`);
    });
    console.log('═'.repeat(60));

    const shouldSave = await askYesNo(rl, '\nSave this form now?', true);
    if (shouldSave) {
      await saveForm(page2);
      console.log('Form saved successfully.');
    } else {
      console.log('Form not saved.');
    }

    await ask(rl, '\nPress Enter to close browser...');
  } finally {
    rl.close();
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error('\nInteractive test failed:', err.message);
  process.exitCode = 1;
});
