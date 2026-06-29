'use strict';

const {
  login,
  openCreateForm,
  getActionableSaveButton,
  clickOptionalYesConfirmation,
  getQuickFlowError,
  SEL,
} = require('../helpers/uiActions');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseOrigin(loginUrl) {
  try {
    return new URL(String(loginUrl || 'https://ipdev.quickflow.in/login')).origin;
  } catch {
    return 'https://ipdev.quickflow.in';
  }
}

function normalizePath(routePath) {
  const value = String(routePath || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith('/') ? value : `/${value}`;
}

function buildRouteUrl(loginUrl, routePath) {
  const normalized = normalizePath(routePath);
  if (!normalized) return '';
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `${baseOrigin(loginUrl)}${normalized}`;
}

function isUnauthorizedText(text) {
  return /unauthori[sz]ed|forbidden|access denied|permission denied|not allowed|insufficient privilege/i.test(String(text || ''));
}

function summarizeBodyText(text, max = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

async function GivenUserLoggedIn(page, { loginUrl, username, password }) {
  await login(page, { loginUrl, username, password });
  return { ok: true };
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

async function openFirstReachableRoute(page, { loginUrl, routePaths = [], probeRegex = '', requireEditable = false }) {
  const routes = Array.isArray(routePaths) ? routePaths : [];
  const probe = String(probeRegex || '').trim();
  const evalRegexSource = probe || '';

  for (const routePath of routes) {
    const url = buildRouteUrl(loginUrl, routePath);
    if (!url) continue;

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const status = Number(response?.status?.() || 0);
    const probeResult = await page.evaluate(({ regexSource, editableRequired }) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };

      const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const hasEditable = Array.from(document.querySelectorAll('input, select, textarea'))
        .some((el) => isVisible(el) && !el.disabled && !el.readOnly);

      const regex = regexSource ? new RegExp(regexSource, 'i') : null;
      const matched = regex ? regex.test(text) : true;
      return {
        text,
        hasEditable,
        matched,
        ok: matched && (!editableRequired || hasEditable),
      };
    }, { regexSource: evalRegexSource, editableRequired: !!requireEditable }).catch(() => ({ text: '', hasEditable: false, matched: false, ok: false }));

    if (status < 500 && probeResult.ok) {
      return {
        opened: true,
        routePath,
        url,
        status,
        bodySnippet: summarizeBodyText(probeResult.text),
      };
    }
  }

  return {
    opened: false,
    routePath: '',
    url: '',
    status: 0,
    bodySnippet: '',
  };
}

async function setPolicyControlByKeywords(page, { label, keywords = [], value = '', enforceBoolean = false }) {
  const result = await page.evaluate(({ labelText, keyList, nextValue, booleanMode }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const keywords = (Array.isArray(keyList) ? keyList : []).map((item) => norm(item)).filter(Boolean);
    if (!keywords.length) return { updated: false, reason: 'no-keywords' };

    const controls = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
      .filter((el) => String(el.type || '').toLowerCase() !== 'hidden');
    if (!controls.length) return { updated: false, reason: 'no-controls' };

    const scoreControl = (control) => {
      const id = control.id ? `#${control.id}` : '';
      const labels = [];

      if (id) {
        labels.push(...Array.from(document.querySelectorAll(`label[for="${control.id}"]`)).map((n) => n.textContent || ''));
      }

      const wrapper = control.closest('tr, .row, .form-group, .mb-2, .mb-3, .col, .card-body, li, .offcanvas-body') || control.parentElement;
      if (wrapper) labels.push(wrapper.textContent || '');

      labels.push(control.getAttribute('name') || '');
      labels.push(control.getAttribute('id') || '');
      labels.push(control.getAttribute('placeholder') || '');
      labels.push(control.getAttribute('aria-label') || '');

      const blob = norm(labels.join(' '));
      let score = 0;
      for (const keyword of keywords) {
        if (blob.includes(keyword)) score += 1;
      }
      return { control, score, blob };
    };

    const scored = controls
      .map(scoreControl)
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked = scored[0];
    if (!picked) return { updated: false, reason: 'no-matching-control' };

    const control = picked.control;
    const tag = String(control.tagName || '').toLowerCase();
    const type = String(control.type || '').toLowerCase();
    const before = tag === 'select'
      ? String(control.value || '')
      : (type === 'checkbox' || type === 'radio'
        ? String(!!control.checked)
        : String(control.value || ''));

    if (tag === 'select') {
      const options = Array.from(control.options || []);
      const target = booleanMode
        ? options.find((opt) => /yes|true|y|1/i.test(String(opt.textContent || '') + ' ' + String(opt.value || '')))
        : options.find((opt) => norm(opt.textContent).includes(norm(nextValue)) || norm(opt.value).includes(norm(nextValue)));
      const fallback = options.find((opt) => String(opt.value || '').trim()) || options[0];
      const chosen = target || fallback;
      if (chosen) control.value = String(chosen.value || '');
    } else if (type === 'checkbox' || type === 'radio') {
      control.checked = booleanMode ? true : String(nextValue || '').toLowerCase() === 'true';
    } else {
      const resolved = booleanMode ? 'Yes' : String(nextValue || '');
      control.value = resolved;
    }

    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    control.dispatchEvent(new Event('blur', { bubbles: true }));

    const after = tag === 'select'
      ? String(control.value || '')
      : (type === 'checkbox' || type === 'radio'
        ? String(!!control.checked)
        : String(control.value || ''));

    return {
      updated: true,
      label: labelText,
      score: picked.score,
      before,
      after,
      controlType: `${tag}:${type || 'na'}`,
    };
  }, {
    labelText: String(label || ''),
    keyList: Array.isArray(keywords) ? keywords : [],
    nextValue: String(value || ''),
    booleanMode: !!enforceBoolean,
  }).catch(() => ({ updated: false, reason: 'evaluate-error' }));

  return result;
}

async function setPasswordPolicyMinimumRules(page) {
  const rules = [
    { label: 'Minimum Password Length', keywords: ['minimum', 'password', 'length'], value: '8', enforceBoolean: false },
    { label: 'Uppercase Character Required', keywords: ['uppercase', 'required'], value: 'Yes', enforceBoolean: true },
    { label: 'Lowercase Character Required', keywords: ['lowercase', 'required'], value: 'Yes', enforceBoolean: true },
    { label: 'Numeric Character Required', keywords: ['numeric', 'required'], value: 'Yes', enforceBoolean: true },
    { label: 'Special Character Required', keywords: ['special', 'required'], value: 'Yes', enforceBoolean: true },
  ];

  const updates = [];
  for (const rule of rules) {
    // eslint-disable-next-line no-await-in-loop
    const updated = await setPolicyControlByKeywords(page, rule);
    updates.push({ rule: rule.label, ...updated });
  }

  return updates;
}

async function findAndFillOffcanvasField(page, { hints = [], value = '', preferPassword = false }) {
  const result = await page.evaluate(({ hintList, nextValue, passwordPreferred }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hints = (Array.isArray(hintList) ? hintList : []).map((h) => norm(h)).filter(Boolean);
    if (!hints.length) return { filled: false, reason: 'no-hints' };

    const roots = Array.from(document.querySelectorAll('#masterFormOffcanvas, #offcanvas, .offcanvas.show, .offcanvas'))
      .filter((root) => isVisible(root) || root.classList.contains('show'));
    const root = roots[0] || document.querySelector('.offcanvas-body')?.closest('.offcanvas') || document.body;

    const controls = Array.from(root.querySelectorAll('input, textarea, select'))
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
      .filter((el) => String(el.type || '').toLowerCase() !== 'hidden');
    if (!controls.length) return { filled: false, reason: 'no-controls' };

    const scored = controls.map((control) => {
      const blob = norm([
        control.getAttribute('name') || '',
        control.getAttribute('id') || '',
        control.getAttribute('placeholder') || '',
        control.getAttribute('aria-label') || '',
        control.closest('label, .form-group, .row, tr, td, .mb-2, .mb-3')?.textContent || '',
      ].join(' '));

      let score = 0;
      for (const hint of hints) {
        if (blob.includes(hint)) score += 1;
      }
      const type = String(control.type || '').toLowerCase();
      if (passwordPreferred && type === 'password') score += 3;
      return { control, score, blob, type };
    }).filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked = scored[0];
    if (!picked) return { filled: false, reason: 'no-match' };

    const control = picked.control;
    const tag = String(control.tagName || '').toLowerCase();
    if (tag === 'select') {
      const options = Array.from(control.options || []);
      const desired = options.find((opt) => norm(opt.textContent).includes(norm(nextValue)) || norm(opt.value).includes(norm(nextValue)));
      const fallback = options.find((opt) => String(opt.value || '').trim()) || options[0];
      const target = desired || fallback;
      if (target) control.value = String(target.value || '');
    } else if (String(control.type || '').toLowerCase() === 'checkbox') {
      control.checked = /^(1|true|yes|y)$/i.test(String(nextValue || ''));
    } else {
      control.value = String(nextValue || '');
    }

    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    control.dispatchEvent(new Event('blur', { bubbles: true }));

    return {
      filled: true,
      fieldType: `${tag}:${String(control.type || 'na').toLowerCase()}`,
      score: picked.score,
    };
  }, {
    hintList: Array.isArray(hints) ? hints : [],
    nextValue: String(value || ''),
    passwordPreferred: !!preferPassword,
  }).catch(() => ({ filled: false, reason: 'evaluate-error' }));

  return result;
}

async function openUserCreateForm(page, { loginUrl, userRoutes = [] }) {
  const opened = await openFirstReachableRoute(page, {
    loginUrl,
    routePaths: userRoutes,
    probeRegex: 'user|role|email|department|location',
    requireEditable: false,
  });
  if (!opened.opened) {
    return {
      ok: false,
      reason: 'User listing page is not reachable in current environment.',
      route: '',
    };
  }

  await openCreateForm(page).catch(() => {});
  const offcanvasVisible = await page.locator(SEL.offcanvas).first().isVisible().catch(() => false);
  if (!offcanvasVisible) {
    return {
      ok: false,
      reason: 'Create form did not open on User page.',
      route: opened.routePath,
    };
  }

  return {
    ok: true,
    reason: '',
    route: opened.routePath,
  };
}

async function populateUserIdentityFields(page, { username, email, firstName, lastName, employeeCode, roleName, siteName, department }) {
  const applied = [];

  const entries = [
    { key: 'username', value: username, hints: ['username', 'login name', 'user name'] },
    { key: 'email', value: email, hints: ['email', 'mail'] },
    { key: 'firstName', value: firstName, hints: ['first name', 'firstname'] },
    { key: 'lastName', value: lastName, hints: ['last name', 'lastname'] },
    { key: 'employeeCode', value: employeeCode, hints: ['employee code', 'emp code', 'code'] },
    { key: 'roleName', value: roleName, hints: ['role', 'user type'] },
    { key: 'siteName', value: siteName, hints: ['location', 'site', 'plant'] },
    { key: 'department', value: department, hints: ['department', 'dept'] },
  ];

  for (const item of entries) {
    if (!String(item.value || '').trim()) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await findAndFillOffcanvasField(page, { hints: item.hints, value: item.value, preferPassword: false });
    applied.push({ field: item.key, ...result });
  }

  return applied;
}

async function setUserPasswordFields(page, { password, confirmPassword }) {
  const result = await page.evaluate(({ pass, confirm }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const root = document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body') || document.body;
    const fields = Array.from(root.querySelectorAll('input[type="password"]')).filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
    if (!fields.length) return { filled: false, count: 0, reason: 'no-password-fields' };

    const values = [String(pass || ''), String(confirm || pass || '')];
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      const value = values[Math.min(i, values.length - 1)];
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    return { filled: true, count: fields.length };
  }, {
    pass: String(password || ''),
    confirm: String(confirmPassword || password || ''),
  }).catch(() => ({ filled: false, count: 0, reason: 'evaluate-error' }));

  return result;
}

async function collectValidationMessages(page) {
  const messages = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const nodes = Array.from(document.querySelectorAll('.text-danger, .invalid-feedback, [data-valmsg-for], .swal2-html-container, .alert-danger, .toast-message, .Toastify__toast-body'));
    return nodes
      .filter((node) => isVisible(node))
      .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);
  }).catch(() => []);

  const quickError = await getQuickFlowError(page).catch(() => null);
  if (quickError?.message) {
    messages.unshift(String(quickError.message));
  }

  return Array.from(new Set(messages.map((msg) => String(msg || '').trim()).filter(Boolean)));
}

async function detectSuccessSignal(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const nodes = Array.from(document.querySelectorAll('.swal2-html-container, .toast-message, .Toastify__toast-body, .alert-success'))
      .filter((node) => isVisible(node))
      .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const text = nodes.join(' | ');
    const matched = /success|saved|updated|created|submitted|completed|added/i.test(text);
    return {
      matched,
      text,
    };
  }).catch(() => ({ matched: false, text: '' }));
}

async function submitCurrentForm(page) {
  const saveButton = await getActionableSaveButton(page);
  let clicked = false;

  if (saveButton) {
    await saveButton.click().catch(() => {});
    clicked = true;
  } else {
    clicked = await clickVisibleTextTarget(page, /save|submit|update|confirm|apply/i);
  }

  if (!clicked) {
    return {
      clicked: false,
      success: { matched: false, text: '' },
      messages: [],
    };
  }

  await clickOptionalYesConfirmation(page, 2500).catch(() => false);
  await page.waitForTimeout(1200);
  await clickOptionalYesConfirmation(page, 1600).catch(() => false);
  await page.waitForTimeout(800);

  const success = await detectSuccessSignal(page);
  const messages = await collectValidationMessages(page);

  return {
    clicked: true,
    success,
    messages,
  };
}

async function tableHasText(page, text) {
  const query = String(text || '').trim();
  if (!query) return { found: false, rowText: '' };

  const searchVisible = await page.locator(SEL.searchBox).first().isVisible().catch(() => false);
  if (searchVisible) {
    await page.fill(SEL.searchBox, '').catch(() => {});
    await page.fill(SEL.searchBox, query).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
  }

  const rowText = await page.evaluate(({ value }) => {
    const rows = Array.from(document.querySelectorAll('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table tbody tr'));
    const queryText = String(value || '').toLowerCase();
    const row = rows.find((item) => String(item.textContent || '').toLowerCase().includes(queryText));
    if (!row) return '';
    return String(row.textContent || '').replace(/\s+/g, ' ').trim();
  }, { value: query }).catch(() => '');

  return {
    found: !!rowText,
    rowText,
  };
}

async function openUserRowForPasswordReset(page, username) {
  const query = String(username || '').trim();
  if (!query) return { opened: false, reason: 'username is required', action: '' };

  const searchVisible = await page.locator(SEL.searchBox).first().isVisible().catch(() => false);
  if (searchVisible) {
    await page.fill(SEL.searchBox, '').catch(() => {});
    await page.fill(SEL.searchBox, query).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(900);
  }

  const row = page.locator('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table tbody tr')
    .filter({ hasText: new RegExp(escapeRegex(query), 'i') })
    .first();

  const rowVisible = await row.isVisible().catch(() => false);
  if (!rowVisible) return { opened: false, reason: `User row not found for ${query}`, action: '' };

  const resetLike = row.locator('button:visible:not([disabled]), a:visible').filter({ hasText: /reset|password|change password/i }).first();
  if (await resetLike.isVisible().catch(() => false)) {
    await resetLike.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(700);
    const opened = await page.locator(SEL.offcanvas).first().isVisible().catch(() => false);
    if (opened) return { opened: true, reason: '', action: 'reset-password' };
  }

  const editLike = row.locator(`${SEL.editBtn}:visible, button:visible:not([disabled])`, { hasText: /edit|update|modify/i }).first();
  if (await editLike.isVisible().catch(() => false)) {
    await editLike.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(700);
    const opened = await page.locator(SEL.offcanvas).first().isVisible().catch(() => false);
    if (opened) return { opened: true, reason: '', action: 'edit' };
  }

  return {
    opened: false,
    reason: 'Reset/Edit action was not discoverable for the user row',
    action: '',
  };
}

async function WhenProbeRouteAccess(page, { loginUrl, routePath }) {
  const url = buildRouteUrl(loginUrl, routePath);
  if (!url) {
    return {
      ok: false,
      route: String(routePath || ''),
      reason: 'Route path is empty',
      status: 0,
      unauthorizedByStatus: false,
      unauthorizedByUi: false,
      bodySnippet: '',
    };
  }

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const status = Number(response?.status?.() || 0);
  const unauthorizedByStatus = status === 401 || status === 403;
  const unauthorizedByUi = isUnauthorizedText(bodyText);

  return {
    ok: true,
    route: String(routePath || ''),
    url,
    status,
    unauthorizedByStatus,
    unauthorizedByUi,
    bodySnippet: summarizeBodyText(bodyText),
  };
}

async function WhenProbeApiRequest(apiContext, { loginUrl, endpoint, method = 'GET', headers = {}, data }) {
  const url = buildRouteUrl(loginUrl, endpoint);
  if (!url) {
    return {
      ok: false,
      endpoint: String(endpoint || ''),
      reason: 'Endpoint is empty',
      status: 0,
      bodySnippet: '',
    };
  }

  const requestOptions = {
    method: String(method || 'GET').toUpperCase(),
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
    failOnStatusCode: false,
  };

  if (data !== undefined) {
    requestOptions.data = data;
  }

  const response = await apiContext.fetch(url, requestOptions).catch(() => null);
  if (!response) {
    return {
      ok: false,
      endpoint: String(endpoint || ''),
      url,
      reason: 'No response from endpoint probe',
      status: 0,
      bodySnippet: '',
    };
  }

  const status = Number(response.status() || 0);
  const bodyText = await response.text().catch(() => '');
  return {
    ok: true,
    endpoint: String(endpoint || ''),
    url,
    status,
    bodySnippet: summarizeBodyText(bodyText, 320),
  };
}

function ThenProbeShouldBeDenied(probeResult) {
  if (!probeResult || probeResult.ok === false) {
    return { passed: false, reason: probeResult?.reason || 'Probe did not execute' };
  }

  const denied = probeResult.unauthorizedByStatus || probeResult.unauthorizedByUi;
  return {
    passed: denied,
    reason: denied
      ? ''
      : `Unexpected response status=${probeResult.status}, body="${probeResult.bodySnippet || ''}"`,
  };
}

function ThenApiShouldBeDenied(probeResult) {
  if (!probeResult || probeResult.ok === false) {
    return { passed: false, reason: probeResult?.reason || 'API probe did not execute' };
  }

  const denied = probeResult.status === 401 || probeResult.status === 403;
  return {
    passed: denied,
    reason: denied ? '' : `Expected 401/403, got ${probeResult.status}`,
  };
}

module.exports = {
  normalizeText,
  baseOrigin,
  normalizePath,
  buildRouteUrl,
  clickVisibleTextTarget,
  openFirstReachableRoute,
  setPasswordPolicyMinimumRules,
  GivenUserLoggedIn,
  WhenProbeRouteAccess,
  WhenProbeApiRequest,
  openUserCreateForm,
  populateUserIdentityFields,
  setUserPasswordFields,
  submitCurrentForm,
  collectValidationMessages,
  detectSuccessSignal,
  tableHasText,
  openUserRowForPasswordReset,
  ThenProbeShouldBeDenied,
  ThenApiShouldBeDenied,
};
