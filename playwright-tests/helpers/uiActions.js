const fs = require('fs');
const path = require('path');

// ── Selectors ──────────────────────────────────────────────────────────────
const SEL = {
  username:       '#txtUsername',
  password:       '#txtPassword',
  loginBtn:       '#btnLogin',
  unlockBtn:      '#btnUnlock',
  homeReady:      '#divAppButton',
  userMenu:       '#userMenu',
  pageTitle:      '.pageTitle',
  offcanvas:      '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body',
  saveBtn:        '#btnSave, #btnArchive, .offcanvas-body button[type="submit"]',
  confirmOk:      '.swal2-confirm',
  searchBox:      '[type="search"]',
  reasonTextarea: '#reasonTextarea',
  tableRows:      '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr',
  editBtn:        'a[data-action="edit"], .fa-pen-to-square, .fa-edit',
  deleteBtn:      'a[data-action="deactivate"], a[data-action="delete"], button.btn-deactive.delete, button[title*="Deactivate" i], .fa-trash, .fa-trash-alt, .fa-user-lock, .fa-times',
  createBtn:      'button.btn.btn-sm.btn-primary.d-flex.flex-center',
};

async function captureFailureScreenshot(page, context, masterName, operation) {
  if (!page || page.isClosed()) return '';

  const dir = path.resolve(__dirname, '..', 'test-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'master';
  const opSlug = String(operation || 'operation').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'operation';
  const fileName = `${stamp}-${masterSlug}-${opSlug}-failure.png`;
  const fullPath = path.join(dir, fileName);

  await page.screenshot({ path: fullPath, fullPage: true }).catch(() => {});
  return fs.existsSync(fullPath) ? fullPath : '';
}

async function getQuickFlowError(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const nodes = Array.from(document.querySelectorAll('.swal2-popup, .modal.show, [role="dialog"], .alert-danger')).filter(isVisible);

    for (const node of nodes) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      const title = String(node.querySelector('.swal2-title, .modal-title, h1, h2, h3, h4, .title')?.textContent || '').replace(/\s+/g, ' ').trim();
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

async function assertNoQuickFlowError(page, context, masterName, operation, stage) {
  const errorInfo = await getQuickFlowError(page);
  if (!errorInfo) return;

  const detail = errorInfo.title && !errorInfo.message.includes(errorInfo.title) ? `${errorInfo.title}: ${errorInfo.message}` : errorInfo.message;
  const isDuplicateLike = /already exists|duplicate|record already|already taken|already registered|duplicate entry/i.test(String(detail || ''));
  if (isDuplicateLike) throw new Error(`Duplicate validation during ${stage}: ${detail}`);

  const screenshotPath = await captureFailureScreenshot(page, context, masterName, operation).catch(() => '');
  const marker = screenshotPath ? `\n[FAIL_SCREENSHOT] ${screenshotPath}` : '';
  throw new Error(`QuickFlow error during ${stage}: ${detail}${marker}`);
}

async function login(page, { loginUrl, username, password }) {
  const base = new URL(loginUrl || 'https://ipdev.quickflow.in/login').origin;
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector(SEL.username, { timeout: 30000 });
  await assertNoQuickFlowError(page, page.context(), '', 'login', 'login page load');
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
  await assertNoQuickFlowError(page, page.context(), '', 'login', 'login');
  console.log('[LOGIN] ✓ Logged in');
}

async function navigateTo(page, name, baseURL) {
  const base = (baseURL || 'https://ipdev.quickflow.in').replace(/\/$/, '');
  const fullUrl = `${base}/${name}`;

  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector(SEL.pageTitle, { state: 'attached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await assertNoQuickFlowError(page, page.context(), name, 'navigate', `navigation to ${name}`);
  console.log(`[NAV] ✓ ${fullUrl}`);
}

async function dismissBlockingOverlays(page) {
  const candidates = [
    page.locator('.swal2-container .swal2-confirm:visible:not([disabled])').first(),
    page.locator('.swal2-container .swal2-cancel:visible:not([disabled])').first(),
    page.locator('.swal2-container button:visible:not([disabled])').first(),
    page.locator('.modal.show button:visible:not([disabled])', { hasText: /^\s*(ok|yes|close|cancel|done)\s*$/i }).first(),
    page.locator('[role="dialog"] button:visible:not([disabled])', { hasText: /^\s*(ok|yes|close|cancel|done)\s*$/i }).first(),
  ];

  for (const btn of candidates) {
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    const label = (await btn.textContent().catch(() => '') || '').trim();
    await btn.click({ timeout: 2000, force: true }).catch(() => {});
    console.log(`[CREATE] Dismissed blocking overlay button: ${label}`);
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

async function clickOptionalYesConfirmation(page, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(300, Number(timeoutMs) || 0);
  const candidates = [
    page.locator('.swal2-popup .swal2-confirm:visible:not([disabled])').first(),
    page.locator('.swal2-container .swal2-confirm:visible:not([disabled])').first(),
    page.locator('#btnConfirm:visible:not([disabled])').first(),
    page.locator('.modal.show button:visible:not([disabled])', { hasText: /^\s*(yes|ok|confirm|submit|deactivate|delete)\s*$/i }).first(),
    page.locator('[role="dialog"] button:visible:not([disabled])', { hasText: /^\s*(yes|ok|confirm|submit|deactivate|delete)\s*$/i }).first(),
  ];

  while (Date.now() < deadline) {
    for (const btn of candidates) {
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const label = (await btn.textContent().catch(() => '') || '').trim();
      await btn.click({ timeout: 1500, force: true }).catch(() => {});
      await page.waitForTimeout(200);
      console.log(`[UI] Clicked optional confirmation${label ? `: ${label}` : ''}`);
      return true;
    }
    await page.waitForTimeout(150);
  }

  return false;
}

async function openCreateForm(page) {
  const formBody = page.locator(SEL.offcanvas).first();

  const alreadyOpen = await formBody.isVisible().catch(() => false);
  if (alreadyOpen) {
    await assertNoQuickFlowError(page, page.context(), '', 'create', 'create form already open');
    console.log('[CREATE] Form already open, skipping Create click');
    return;
  }

  for (let i = 0; i < 3; i++) {
    const dismissed = await dismissBlockingOverlays(page);
    if (!dismissed) break;
  }

  const cancelBtn = page.locator('.offcanvas.show button:has-text("Cancel"), .offcanvas.show .btn-close').first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const candidates = [
    page.locator('#btnAdd:visible:not([disabled])').first(),
    page.locator(SEL.createBtn).filter({ has: page.locator('span', { hasText: /^\s*Create\s*$/ }) }).first(),
    page.locator('button.btn.btn-primary:visible', { hasText: /Create/i }).first(),
    page.getByRole('button', { name: /Create/i }).first(),
    page.locator('button:visible:not([disabled])', { hasText: /Create/i }).first(),
    page.locator('a.btn:visible', { hasText: /Create/i }).first(),
  ];

  let opened = false;
  let lastError = '';

  for (let round = 0; round < 3 && !opened; round++) {
    await dismissBlockingOverlays(page);
    await page.waitForTimeout(300);

    if (await formBody.isVisible().catch(() => false)) {
      opened = true;
      break;
    }

    for (const btn of candidates) {
      if (!(await btn.isVisible().catch(() => false))) continue;
      try {
        await btn.click({ timeout: 5000 });
      } catch (e) {
        lastError = e?.message || String(e);
        await dismissBlockingOverlays(page);
        await btn.click({ timeout: 4000, force: true }).catch(() => {});
      }
      opened = await formBody.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
      if (opened) break;
    }
  }

  if (!opened) throw new Error(`Create button click did not open form. ${lastError}`.trim());
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await assertNoQuickFlowError(page, page.context(), '', 'create', 'create form open');
}

async function getActiveOffcanvasSelector(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const roots = Array.from(document.querySelectorAll('#offcanvas, #masterFormOffcanvas, .offcanvas'));
    if (!roots.length) return null;

    const scored = roots.map((root) => {
      const body = root.querySelector('.offcanvas-body');
      if (!body) return { root, score: -1 };
      if (!isVisible(root) && !isVisible(body) && !root.classList?.contains('show')) return { root, score: -1 };
      const score = (isVisible(root) || isVisible(body) ? 180 : 0) + (root.classList?.contains('show') ? 200 : 0);
      return { root, score };
    }).sort((a, b) => b.score - a.score);

    const activeRoot = scored[0]?.root;
    if (!activeRoot) return null;
    const uid = `_pw_active_offcanvas_${Date.now()}`;
    activeRoot.setAttribute('data-pw-active-offcanvas', uid);
    return `[data-pw-active-offcanvas="${uid}"]`;
  }).catch(() => null);
}

async function getActionableSaveButton(page) {
  const activeOffcanvasSelector = await getActiveOffcanvasSelector(page);
  const scoped = activeOffcanvasSelector || '.offcanvas.show';
  const candidates = [
    page.locator(`${scoped} #btnSave:visible`).first(),
    page.locator(`${scoped} #btnSubmit:visible`).first(),
    page.locator(`${scoped} button:visible:not([disabled])`, { hasText: /^\s*Save\s*$/i }).first(),
    page.locator(`${scoped} button:visible:not([disabled])`, { hasText: /^\s*Submit\s*$/i }).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

module.exports = {
  SEL,
  login,
  navigateTo,
  dismissBlockingOverlays,
  clickOptionalYesConfirmation,
  openCreateForm,
  getActionableSaveButton,
  getQuickFlowError,
  assertNoQuickFlowError
};
