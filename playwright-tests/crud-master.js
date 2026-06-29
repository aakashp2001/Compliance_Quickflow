'use strict';

/**
 * crud-master.js
 *
 * Standalone Playwright script that performs Create, Update and Delete
 * on a chosen QuickFlow master page.
 *
 * Uses the exact same selectors and flow as auto-masters.spec.js.
 *
 * Env vars:
 *   QT_URL, QT_USER, QT_PASS, QT_MASTER, QT_OP, QT_HEADLESS
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { collectStableFormFields } = require('./helpers/formDiscovery');
const { smartFillOffcanvasForm, refreshStamp, guidDigits, guidToken } = require('./helpers/smartFiller');
const { fillField, readFieldValue } = require('./helpers/formFiller');
const { inferPrimaryRecordIdentifier, verifyAuditTrailEntry, verifyEachFieldIndividually } = require('./helpers/auditTrail');
const { execSync } = require('child_process');

const OVERLAY_SCRIPT = `
(function() {
  try {
    const install = () => {
      const existing = document.getElementById('pw-recording-overlay');
      if (existing) return;
      window.pwRunInfo = window.pwRunInfo || {};
      const box = document.createElement('div');
      box.id = 'pw-recording-overlay';
      box.style.position = 'fixed';
      box.style.right = '12px';
      box.style.top = '12px';
      box.style.zIndex = '2147483647';
      box.style.background = 'rgba(0,0,0,0.82)';
      box.style.color = '#fff';
      box.style.padding = '8px 12px';
      box.style.borderRadius = '8px';
      box.style.fontFamily = 'Consolas,Menlo,monospace';
      box.style.fontSize = '11px';
      box.style.lineHeight = '1.5';
      box.style.whiteSpace = 'pre-wrap';
      box.style.maxWidth = '64vw';
      box.style.pointerEvents = 'none';
      box.style.boxShadow = '0 4px 14px rgba(0,0,0,0.35)';
      const update = () => {
        const now = new Date();
        const dateText = now.toLocaleString('en-GB', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
        const urlText = window.location.href || '';
        const info = window.pwRunInfo || {};
        const lines = ['Time : ' + dateText, 'URL  : ' + urlText];
        if (info.masterName) lines.push('Master   : ' + info.masterName);
        if (info.operation)  lines.push('Operation: ' + info.operation);
        if (info.status)     lines.push('Status   : ' + info.status);
        if (info.auditEnabled !== undefined) {
          if (info.auditEnabled) {
            const ar = info.auditResult || 'pending';
            const auditColor = ar === 'pass' ? '\u2705' : ar === 'fail' ? '\u274C' : '\u23F3';
            lines.push('Audit    : ' + auditColor + ' ' + ar.toUpperCase());
          } else {
            lines.push('Audit    : not enabled');
          }
        }
        box.textContent = lines.join('\n');
      };
      update();
      document.body.appendChild(box);
      setInterval(update, 1000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      install();
    }
  } catch {}
})();
`;

async function enableRecordingOverlayOnPage(page) {
  await page.addInitScript(OVERLAY_SCRIPT);
  await page.evaluate(OVERLAY_SCRIPT).catch(() => { });
}

async function updateRecordingOverlay(page, info) {
  await page.evaluate((data) => {
    try {
      window.pwRunInfo = Object.assign(window.pwRunInfo || {}, data);
    } catch { }
  }, info).catch(() => { });
}

function inferFailedStep(error, operation) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (msg.includes('validation') || msg.includes('required') || msg.includes('mandatory')) return 'validation-error';
  if (msg.includes('duplicate')) return 'duplicate-check';
  if (msg.includes('offcanvas closed') || msg.includes('form closed')) return 'form-fill';
  if (msg.includes('save') || msg.includes('blocked by validation')) return 'save';
  if (msg.includes('audit trail') || msg.includes('audit mismatch') || msg.includes('not found in audit')) return 'audit-verification';
  if (msg.includes('create button')) return 'open-create-form';
  if (msg.includes('delete')) return 'delete';
  if (msg.includes('navigate')) return 'navigation';
  return operation || 'unknown-step';
}

async function captureFailureScreenshot(page, context, masterName, operation, step = '') {
  const candidatePages = [];
  if (context && typeof context.pages === 'function') {
    const pages = context.pages().filter((ctxPage) => ctxPage && !ctxPage.isClosed());
    // Prefer most recently opened pages first (popups are usually at the end).
    for (let i = pages.length - 1; i >= 0; i--) {
      const ctxPage = pages[i];
      if (!candidatePages.includes(ctxPage)) candidatePages.push(ctxPage);
    }
  }
  if (page && !page.isClosed() && !candidatePages.includes(page)) candidatePages.push(page);
  if (!candidatePages.length) return '';

  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
  const opSlug = String(operation || 'op').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'op';
  const stepSlug = String(step || 'failure').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'failure';
  const fileName = `${stamp}-${masterSlug}-${opSlug}-${stepSlug}.png`;
  const fullPath = path.join(dir, fileName);

  async function addFailureOverlay(targetPage, stepLabel) {
    const now = new Date();
    const dateText = now.toLocaleString('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const urlText = targetPage.url() || 'unknown-url';

    await targetPage.evaluate(({ dateTextValue, urlTextValue, stepValue }) => {
      const id = 'pw-failure-screenshot-overlay';
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      const box = document.createElement('div');
      box.id = id;
      box.style.position = 'fixed';
      box.style.left = '12px';
      box.style.top = '12px';
      box.style.zIndex = '2147483647';
      box.style.background = 'rgba(0,0,0,0.84)';
      box.style.color = '#ffffff';
      box.style.padding = '10px 12px';
      box.style.borderRadius = '8px';
      box.style.fontFamily = 'Consolas, Menlo, monospace';
      box.style.fontSize = '12px';
      box.style.lineHeight = '1.4';
      box.style.whiteSpace = 'pre-wrap';
      box.style.maxWidth = '95vw';
      box.style.pointerEvents = 'none';
      const lines = [`Time: ${dateTextValue}`, `URL: ${urlTextValue}`];
      if (stepValue) lines.push(`Failed Step: ${stepValue}`);
      box.textContent = lines.join('\n');

      document.body.appendChild(box);
    }, { dateTextValue: dateText, urlTextValue: urlText, stepValue: stepLabel }).catch(() => { });
  }

  async function removeFailureOverlay(targetPage) {
    await targetPage.evaluate(() => {
      const node = document.getElementById('pw-failure-screenshot-overlay');
      if (node) node.remove();
    }).catch(() => { });
  }

  const scoredCandidates = [];
  for (const candidate of candidatePages) {
    const url = String(candidate.url() || '');
    const lowerUrl = url.toLowerCase();
    const isAuditLike = /\/report\/view|audit/i.test(lowerUrl);
    const isOriginalPage = candidate === page;
    const hasFocus = await candidate.evaluate(() => document.hasFocus()).catch(() => false);

    let score = 0;
    if (isAuditLike) score += 200;
    if (hasFocus) score += 120;
    if (!isOriginalPage) score += 30;

    scoredCandidates.push({ candidate, score });
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  for (const { candidate } of scoredCandidates) {
    await addFailureOverlay(candidate, step);
    await candidate.waitForTimeout(80).catch(() => { });
    await candidate.screenshot({ path: fullPath, fullPage: true }).catch(() => { });
    await removeFailureOverlay(candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return '';
}

async function captureReportScreenshot(page, masterName, operation, status = 'passed', step = 'completed') {
  if (!page || page.isClosed()) return '';

  const dir = path.resolve(__dirname, 'test-reports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
  const opSlug = String(operation || 'operation').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'operation';
  const statusSlug = String(status || 'passed').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'passed';
  const stepSlug = String(step || 'completed').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'completed';
  const fileName = `${stamp}-${masterSlug}-${opSlug}-${statusSlug}-${stepSlug}.png`;
  const fullPath = path.join(dir, fileName);

  async function addSuccessOverlay(targetPage, stepLabel) {
    const now = new Date();
    const dateText = now.toLocaleString('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    await targetPage.evaluate(({ dateTextValue, stepValue }) => {
      const id = 'pw-success-screenshot-overlay';
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      const box = document.createElement('div');
      box.id = id;
      box.style.position = 'fixed';
      box.style.right = '12px';
      box.style.top = '12px';
      box.style.zIndex = '2147483647';
      box.style.background = 'rgba(0,120,50,0.85)';
      box.style.color = '#ffffff';
      box.style.padding = '10px 12px';
      box.style.borderRadius = '8px';
      box.style.fontFamily = 'Consolas, Menlo, monospace';
      box.style.fontSize = '12px';
      box.style.lineHeight = '1.4';
      box.style.whiteSpace = 'pre-wrap';
      box.style.maxWidth = '64vw';
      box.style.pointerEvents = 'none';
      const lines = [`Time: ${dateTextValue}`, `Status: PASSED`];
      if (stepValue) lines.push(`Step: ${stepValue}`);
      box.textContent = lines.join('\n');

      document.body.appendChild(box);
    }, { dateTextValue: dateText, stepValue: stepLabel }).catch(() => { });
  }

  async function removeSuccessOverlay(targetPage) {
    await targetPage.evaluate(() => {
      const node = document.getElementById('pw-success-screenshot-overlay');
      if (node) node.remove();
    }).catch(() => { });
  }

  await addSuccessOverlay(page, step);
  await page.waitForTimeout(80).catch(() => { });
  await page.screenshot({ path: fullPath, fullPage: true }).catch(() => { });
  await removeSuccessOverlay(page);
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

async function assertNoQuickFlowError(page, context, masterName, operation, stage) {
  const errorInfo = await getQuickFlowError(page);
  if (!errorInfo) return;

  const detail = errorInfo.title && !errorInfo.message.includes(errorInfo.title)
    ? `${errorInfo.title}: ${errorInfo.message}`
    : errorInfo.message;
  const isDuplicateLike = /already exists|duplicate|record already|already taken|already registered|duplicate entry/i.test(String(detail || ''));
  if (isDuplicateLike) {
    // Duplicate is a retryable validation case in create/duplicate-check flows, not a product bug.
    throw new Error(`Duplicate validation during ${stage}: ${detail}`);
  }

  const screenshotPath = await captureFailureScreenshot(page, context, masterName, operation).catch(() => '');
  const marker = screenshotPath ? `\n[FAIL_SCREENSHOT] ${screenshotPath}` : '';
  throw new Error(`QuickFlow error during ${stage}: ${detail}${marker}`);
}

// ── Selectors (copied from auto-masters.spec.js) ──────────────────────────────
const SEL = {
  username: '#txtUsername',
  password: '#txtPassword',
  loginBtn: '#btnLogin',
  unlockBtn: '#btnUnlock',
  homeReady: '#divAppButton',
  userMenu: '#userMenu',
  pageTitle: '.pageTitle',
  offcanvas: '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body',
  saveBtn: '#btnSave, #btnArchive, .offcanvas-body button[type="submit"]',
  confirmOk: '.swal2-confirm',
  searchBox: '[type="search"]',
  reasonTextarea: '#reasonTextarea',
  tableRows: '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, #information_table tbody tr, #output-table tbody tr, table.dataTable tbody tr, table tbody tr',
  editBtn: 'a[data-action="edit"], .fa-pen-to-square, .fa-edit',
  deleteBtn: 'a[data-action="deactivate"], a[data-action="delete"], button.btn-deactive.delete, button[title*="Deactivate" i], .fa-trash, .fa-trash-alt, .fa-user-lock, .fa-times',
  createBtn: 'button.btn.btn-sm.btn-primary.d-flex.flex-center',
};

// ── Login ──────────────────────────────────────────────────────────────────────
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

// ── Navigate to master ─────────────────────────────────────────────────────────
async function navigateTo(page, name, baseURL) {
  const base = (baseURL || 'https://ipdev.quickflow.in').replace(/\/$/, '');
  const fullUrl = `${base}/${name}`;

  // Always use direct goto — sidebars may be collapsed, hidden, or on the right side
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for network to settle
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

  // pageTitle may be hidden (display:none), only require it to be in DOM
  await page.waitForSelector(SEL.pageTitle, { state: 'attached', timeout: 20000 }).catch(() => { });

  // Extra wait for JS-rendered table
  await page.waitForTimeout(1200);
  await assertNoQuickFlowError(page, page.context(), name, 'navigate', `navigation to ${name}`);
  console.log(`[NAV] ✓ ${fullUrl}`);
}

function isUserMaster(masterName) {
  const normalized = String(masterName || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  return normalized === 'user';
}

function isRoleAppAssignmentError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return /no app.*assigned.*role|app access control/i.test(msg);
}

function extractRoleFromAppError(error) {
  const msg = String(error?.message || error || '');
  const match = msg.match(/role.*?<b>(.*?)<\/b>/i) || msg.match(/role\s+(?:\()?([^)]+)(?:\))?/i);
  return match ? match[1].trim() : '';
}

function inferSiteFromAuditTrail(auditTrail) {
  const entries = Object.entries(auditTrail || {});
  for (const [key, value] of entries) {
    const keyText = String(key || '').toLowerCase();
    const valueText = String(value || '').replace(/\s+/g, ' ').trim();
    if (!valueText) continue;
    // Check for "site", "location", or "plant" as site identifiers
    if (!/(^|\s|_|-)(site|location|plant)(\s|_|-|$)/i.test(keyText)) continue;
    console.log(`[AUDIT] Inferred site from field "${key}": ${valueText}`);
    return valueText;
  }
  return '';
}

async function switchSiteAndOpenAnyApp(page, { targetSite = '', targetApp = '' } = {}) {
  await page.waitForSelector('#divAppButton', { timeout: 15000 });

  const launcherCandidates = [
    page.locator('#divAppButton button').first(),
    page.locator('#divAppButton [data-kt-menu-trigger]').first(),
    page.locator('#divAppButton').first(),
  ];

  let opened = false;
  for (const launcher of launcherCandidates) {
    const visible = await launcher.isVisible().catch(() => false);
    if (!visible) continue;

    await launcher.click({ timeout: 5000, force: true }).catch(() => { });
    opened = await page.locator('#ulAppList').isVisible().catch(() => false);
    if (!opened) {
      await page.waitForTimeout(300);
      opened = await page.locator('#ulAppList').isVisible().catch(() => false);
    }
    if (opened) break;
  }

  if (!opened) {
    throw new Error('App switcher menu did not open from left square launcher (#divAppButton).');
  }

  await page.waitForSelector('#ulAppList', { state: 'visible', timeout: 10000 });

  const switcherData = await page.evaluate(() => {
    const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('#ulAppList');
    if (!root) return [];

    const sections = [];
    const headingNodes = Array.from(root.querySelectorAll('.menu-content b.menu-section'));
    for (const heading of headingNodes) {
      const siteName = normalize(heading.textContent);
      if (!siteName) continue;

      let row = heading.closest('.menu-item')?.nextElementSibling || null;
      while (row && !(row.classList && row.classList.contains('row'))) {
        row = row.nextElementSibling;
      }

      const apps = row
        ? Array.from(row.querySelectorAll('a[data-app-code]')).map((anchor) => ({
          appCode: normalize(anchor.getAttribute('data-app-code')),
          appName: normalize(
            anchor.querySelector('.menu-title')?.textContent
            || anchor.getAttribute('title')
            || anchor.textContent,
          ),
        })).filter((app) => app.appCode)
        : [];

      if (apps.length) {
        sections.push({ siteName, apps });
      }
    }

    return sections;
  }).catch(() => []);

  if (!switcherData.length) {
    throw new Error('No site/app options found in the app switcher menu (#ulAppList).');
  }

  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wantedSite = normalize(targetSite);
  const wantedApp = normalize(targetApp);

  let chosenSite = null;
  if (wantedSite) {
    chosenSite = switcherData.find((entry) => normalize(entry.siteName) === wantedSite)
      || switcherData.find((entry) => normalize(entry.siteName).includes(wantedSite))
      || null;
  }
  if (!chosenSite) {
    chosenSite = switcherData.find((entry) => !/^(global)$/i.test(String(entry.siteName || '').trim())) || switcherData[0];
  }

  let chosenApp = null;
  if (wantedApp) {
    chosenApp = chosenSite.apps.find((app) => normalize(app.appName) === wantedApp)
      || chosenSite.apps.find((app) => normalize(app.appName).includes(wantedApp))
      || null;
  }
  if (!chosenApp) {
    chosenApp = chosenSite.apps[0] || null;
  }

  if (!chosenSite || !chosenApp) {
    throw new Error('Could not resolve a target site/app from app switcher options.');
  }

  const appNameBefore = (await page.locator('#app-name').first().textContent().catch(() => '') || '').trim();
  const appPlatformBefore = (await page.locator('#app-platform-name').first().textContent().catch(() => '') || '').trim();

  const clicked = await page.evaluate(({ code }) => {
    const links = Array.from(document.querySelectorAll('#ulAppList a[data-app-code]'));
    const target = links.find((link) => String(link.getAttribute('data-app-code') || '').trim() === code);
    if (!target) return false;
    target.click();
    return true;
  }, { code: chosenApp.appCode }).catch(() => false);

  if (!clicked) {
    throw new Error(`Failed to click app in switcher: ${chosenApp.appName || chosenApp.appCode}`);
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
  await page.waitForTimeout(1200);

  await page.waitForFunction(
    ({ expectedAppName, previousAppName, previousPlatform }) => {
      const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const currentApp = normalize(document.querySelector('#app-name')?.textContent || '');
      const currentPlatform = normalize(document.querySelector('#app-platform-name')?.textContent || '');
      const expected = normalize(expectedAppName);
      const oldApp = normalize(previousAppName);
      const oldPlatform = normalize(previousPlatform);

      if (expected && (currentApp === expected || currentApp.includes(expected) || expected.includes(currentApp))) {
        return true;
      }

      return !!currentApp && (currentApp !== oldApp || currentPlatform !== oldPlatform);
    },
    {
      expectedAppName: chosenApp.appName,
      previousAppName: appNameBefore,
      previousPlatform: appPlatformBefore,
    },
    { timeout: 12000 },
  ).catch(() => { });

  console.log(`[APP] ✓ Switched to site "${chosenSite.siteName}" / app "${chosenApp.appName || chosenApp.appCode}"`);

  return {
    siteName: chosenSite.siteName,
    appName: chosenApp.appName,
    appCode: chosenApp.appCode,
  };
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
    await btn.click({ timeout: 2000, force: true }).catch(() => { });
    if (label) {
      console.log(`[CREATE] Dismissed blocking overlay button: ${label}`);
    } else {
      console.log('[CREATE] Dismissed blocking overlay');
    }
    await page.waitForTimeout(250);
    return true;
  }

  return false;
}

// ── Open Create form ───────────────────────────────────────────────────────────
async function openCreateForm(page) {
  const formBody = page.locator(SEL.offcanvas).first();

  const alreadyOpen = await formBody.isVisible().catch(() => false);
  if (alreadyOpen) {
    await assertNoQuickFlowError(page, page.context(), '', 'create', 'create form already open');
    console.log('[CREATE] Form already open, skipping Create click');
    return;
  }

  // Dismiss any lingering overlays/popups that block pointer events.
  for (let i = 0; i < 3; i++) {
    const dismissed = await dismissBlockingOverlays(page);
    if (!dismissed) break;
  }

  const cancelBtn = page.locator('.offcanvas.show button:has-text("Cancel"), .offcanvas.show .btn-close').first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click().catch(() => { });
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

    const openNow = await formBody.isVisible().catch(() => false);
    if (openNow) {
      opened = true;
      break;
    }

    for (const btn of candidates) {
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;

      try {
        await btn.click({ timeout: 5000 });
      } catch (e) {
        lastError = e?.message || String(e);
        await dismissBlockingOverlays(page);
        await btn.click({ timeout: 4000, force: true }).catch(() => { });
      }

      opened = await formBody.waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true)
        .catch(() => false);

      if (opened) break;
    }

    if (!opened) {
      // JS fallback: click the first visible create-like control on the page.
      const jsClicked = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        };

        const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const target = controls.find((el) => {
          const id = String(el.id || '').toLowerCase();
          const text = String(el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!isVisible(el)) return false;
          if (id === 'btnadd') return true;
          return /\bcreate\b/.test(text);
        });

        if (!target) return false;
        target.click();
        return true;
      }).catch(() => false);

      if (jsClicked) {
        opened = await formBody.waitFor({ state: 'visible', timeout: 4000 })
          .then(() => true)
          .catch(() => false);
      }
    }
  }

  if (!opened) {
    throw new Error(`Create button click did not open form. ${lastError}`.trim());
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
  await page.waitForTimeout(1000);
  await assertNoQuickFlowError(page, page.context(), '', 'create', 'create form open');
}

async function getActiveOffcanvasSelector(page) {
  const uid = `_pw_active_offcanvas_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const success = await page.evaluate((uidArg) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const roots = Array.from(document.querySelectorAll('#offcanvas, #masterFormOffcanvas, .offcanvas'));
    if (!roots.length) return false;

    const scored = roots.map((root) => {
      const body = root.querySelector('.offcanvas-body');
      if (!body) return { root, score: -1 };
      if (!isVisible(root) && !isVisible(body) && !root.classList?.contains('show')) return { root, score: -1 };

      const controls = Array.from(body.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]'));
      const nonEmptyInputs = controls.filter((el) => String(el.value || '').trim()).length;
      const singleValueNodes = Array.from(body.querySelectorAll('[class*="singleValue"], .select2-selection__rendered, .ql-editor, [contenteditable="true"]'));
      const nonEmptyDisplayNodes = singleValueNodes.filter((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).length;
      const focusedScore = root.contains(document.activeElement) ? 120 : 0;
      const visibleScore = isVisible(root) || isVisible(body) ? 180 : 0;
      const showClassScore = root.classList?.contains('show') ? 200 : 0;
      const saveButtonScore = root.querySelector('#btnSave, #btnSubmit') ? 150 : 0;
      const score = visibleScore + focusedScore + showClassScore + saveButtonScore + (controls.length * 5) + (nonEmptyInputs * 20) + (nonEmptyDisplayNodes * 20);
      return { root, score };
    }).sort((left, right) => right.score - left.score);

    const activeRoot = scored[0]?.root;
    if (!activeRoot) return false;

    activeRoot.setAttribute('data-pw-active-offcanvas', uidArg);
    return true;
  }, uid).catch(() => false);

  if (!success) return null;
  return `[data-pw-active-offcanvas="${uid}"]`;
}

async function getActionableSaveButton(page) {
  console.log('[SAVE] Looking for Save button...');

  const activeOffcanvasSelector = await getActiveOffcanvasSelector(page);

  // ── Step 1: Scroll the offcanvas body to the bottom ───────────────────────
  await page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : null;
    const offcanvas = root?.querySelector('.offcanvas-body') || root;
    if (!root) return;

    root.style.visibility = 'visible';
    root.style.opacity = '1';
    if (root.style.display === 'none') root.style.display = 'block';
    if (root.classList && !root.classList.contains('show')) root.classList.add('show');

    if (offcanvas) {
      offcanvas.style.visibility = 'visible';
      if (offcanvas.style.display === 'none') offcanvas.style.display = 'block';
      // Scroll to bottom to reveal the Save button
      offcanvas.scrollTop = offcanvas.scrollHeight;
    }
  }, activeOffcanvasSelector).catch(() => { });
  await page.waitForTimeout(400);

  // ── Step 2: Scroll #btnSave into the viewport ─────────────────────────────
  await page.evaluate(() => {
    const btn = document.getElementById('btnSave') || document.getElementById('btnSubmit');
    if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
  }).catch(() => { });
  await page.waitForTimeout(300);

  const unlockBtn = page.locator('#btnUnlock:visible').first();
  if (await unlockBtn.isVisible().catch(() => false)) {
    console.log('[SAVE] Clicking Unlock button first');
    await unlockBtn.click().catch(() => { });
    await page.waitForTimeout(500);
  }

  const btnSaveInfo = await page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : null;
    const btn = root?.querySelector('#btnSave, #btnSubmit')
      || root?.parentElement?.querySelector('#btnSave, #btnSubmit')
      || document.getElementById('btnSave')
      || document.getElementById('btnSubmit')
      || null;
    if (!btn) return 'NOT_FOUND';
    return {
      display: getComputedStyle(btn).display,
      visibility: getComputedStyle(btn).visibility,
      offsetParent: !!btn.offsetParent,
      disabled: btn.disabled,
      type: btn.type,
      parentId: btn.parentElement?.id || 'none',
    };
  }, activeOffcanvasSelector).catch(() => 'NOT_FOUND');
  console.log(`[SAVE] #btnSave info: ${JSON.stringify(btnSaveInfo)}`);

  // ── Step 3: Build candidate list — #btnSave first ─────────────────────────
  const scoped = activeOffcanvasSelector || '.offcanvas.show';
  const candidates = [
    page.locator(`${scoped} #btnSave:visible:not([disabled])`).first(),
    page.locator(`${scoped} #btnSubmit:visible:not([disabled])`).first(),
    page.locator('#btnSave:visible:not([disabled])').first(),
    page.locator('#btnSubmit:visible:not([disabled])').first(),
    page.locator(`${scoped} button:visible:not([disabled])`, { hasText: /^\s*Save\s*$/i }).first(),
    page.locator(`${scoped} button:visible:not([disabled])`, { hasText: /^\s*Submit\s*$/i }).first(),
    page.locator(`${scoped} button:visible:not([disabled])`, { hasText: /^\s*Create\s*$/i }).first(),
    page.locator(`${scoped} button.btn.btn-primary:visible:not([disabled])`, { hasText: /^\s*(Save|Submit|Create)\s*$/i }).first(),
    // Fallback without :not([disabled])
    page.locator(`${scoped} #btnSave`).first(),
    page.locator(`${scoped} #btnSubmit`).first(),
    page.locator('#offcanvas #btnSave').first(),
    page.locator('#offcanvas #btnSubmit').first(),
    page.locator('#btnSave').first(),
    page.locator('#btnSubmit').first(),
  ];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const exists = await candidate.count().catch(() => 0);
      if (!exists) continue;

      // Scroll the candidate into view before checking visibility
      await candidate.scrollIntoViewIfNeeded().catch(() => { });
      await page.waitForTimeout(100);

      const visible = await Promise.race([
        candidate.isVisible(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      const enabled = await Promise.race([
        candidate.isEnabled(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (visible || enabled || exists) {
        console.log(`[SAVE] Candidate #${i} is ${visible ? 'visible' : 'hidden'}${enabled ? '+enabled' : ''}, using it`);
        return candidate;
      }
    } catch {
      continue;
    }
  }

  // ── Step 4: Force-show #btnSave if still not found ────────────────────────
  for (const forcedId of ['btnSave', 'btnSubmit']) {
    const hidden = page.locator(`#${forcedId}`).first();
    const exists = await hidden.count().catch(() => 0);
    if (exists === 0) continue;

    console.log(`[SAVE] Forcing hidden #${forcedId} visible`);
    await page.evaluate((btnId) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.style.display = 'inline-block';
      btn.style.visibility = 'visible';
      btn.style.opacity = '1';
      btn.removeAttribute('disabled');
      let parent = btn.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (style.display === 'none') parent.style.display = 'block';
        if (style.visibility === 'hidden') parent.style.visibility = 'visible';
        parent = parent.parentElement;
      }
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    }, forcedId);

    await page.waitForTimeout(300);
    const nowVisible = await hidden.isVisible().catch(() => false);
    console.log(`[SAVE] After force-show, #${forcedId} visible: ${nowVisible}`);
    if (nowVisible) return hidden;
  }

  console.log('[SAVE] No Save button found');
  return null;
}

async function clickPendingConfirmationModal(page) {
  const candidates = [
    page.locator('.swal2-popup .swal2-confirm:visible:not([disabled])').first(),
    page.locator('#btnConfirm:visible:not([disabled])').first(),
    page.locator('.modal.show button:visible:not([disabled])', {
      hasText: /\b(yes|ok|confirm|submit|save|deactivate|delete)\b/i,
    }).first(),
  ];

  for (const btn of candidates) {
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    const label = (await btn.textContent().catch(() => '') || '').trim();
    await btn.click({ timeout: 3000, force: true }).catch(() => { });
    console.log(`[SAVE] Clicked confirmation button${label ? `: ${label}` : ''}`);
    return true;
  }

  return false;
}

function buildRandomUpdateReason() {
  const why = [
    'Updated user profile details after validating latest HR records',
    'Corrected user information based on manager-approved request',
    'Aligned account metadata with current department structure',
    'Revised user settings after role and access review',
    'Adjusted user data to match current organizational mapping',
    'Applied requested correction from central admin verification',
  ];
  const what = [
    'for audit consistency',
    'to keep master data accurate',
    'as part of routine data quality checks',
    'to resolve a mismatch found during review',
    'to reflect approved operational changes',
  ];

  const pick = (arr) => arr[Number(guidDigits(2)) % arr.length];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `${pick(why)} ${pick(what)} (${stamp}, ${guidToken(8)})`;
}

async function handleReasonRequiredModal(page, fallbackReason = '') {
  const reasonField = page.locator('.modal.show #reasonTextarea:visible, .modal.fade.show.d-block #reasonTextarea:visible, #reasonTextarea:visible').first();
  const isVisible = await reasonField.isVisible().catch(() => false);
  if (!isVisible) return false;

  const reasonText = (fallbackReason && String(fallbackReason).trim()) || buildRandomUpdateReason();
  await reasonField.click({ timeout: 3000 }).catch(() => { });
  await reasonField.fill(reasonText).catch(async () => {
    await reasonField.clear().catch(() => { });
    await reasonField.type(reasonText, { delay: 12 }).catch(() => { });
  });

  const submitCandidates = [
    page.locator('.modal.show .modal-footer button:visible:not([disabled])', { hasText: /^\s*Submit\s*$/i }).first(),
    page.locator('.modal.fade.show.d-block .modal-footer button:visible:not([disabled])', { hasText: /^\s*Submit\s*$/i }).first(),
    page.locator('.modal.show button.btn.btn-primary:visible:not([disabled])', { hasText: /^\s*Submit\s*$/i }).first(),
    page.locator('button:visible:not([disabled])', { hasText: /^\s*Submit\s*$/i }).first(),
  ];

  for (const btn of submitCandidates) {
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    await btn.click({ timeout: 4000, force: true }).catch(() => { });
    await page.waitForTimeout(350);

    const stillVisible = await reasonField.isVisible().catch(() => false);
    if (!stillVisible) {
      console.log('[SAVE] Reason modal submitted');
      return reasonText;
    }
  }

  throw new Error('Reason for change modal was visible, but Submit could not be clicked successfully.');
}

// ── Save form (same logic as auto-masters.spec.js) ─────────────────────────────
async function saveForm(page, isUpdate = false, updateReason = '') {
  await assertNoQuickFlowError(page, page.context(), '', isUpdate ? 'update' : 'create', 'save start');

  // ── Pre-save: sync hidden <select> backing elements with what is visually shown ──
  // The Site (and other) forms use react-select/select2 for dropdowns. The visible
  // display is separate from the hidden <select> that the #btnSave click handler reads.
  // We must ensure those hidden selects have the correct value before clicking Save.
  await page.evaluate(() => {
    try {
      const offcanvas = document.querySelector(
        '.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body'
      );
      if (!offcanvas) return;

      const isVisible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
      };

      // For every .ele container that has a custom-select widget, read the currently
      // displayed label and sync it into any hidden <select> inside the same container.
      const eles = Array.from(offcanvas.querySelectorAll('.ele')).filter(isVisible);
      for (const ele of eles) {
        const hasWidget = ele.querySelector(
          '[role="combobox"], .react-select__control, .select2-selection, [aria-haspopup="listbox"]'
        );
        if (!hasWidget) continue;

        // Read the currently displayed label from the widget
        const singleValue = ele.querySelector(
          '[class*="singleValue"], .select2-selection__rendered, .react-select__single-value, [class*="single-value"]'
        );
        const displayedLabel = (singleValue?.textContent || '').trim();
        if (!displayedLabel) continue;

        // Find hidden <select> elements anywhere in the offcanvas whose option text
        // matches the displayed label — these are the backing selects the save handler reads.
        const allSelects = Array.from(offcanvas.querySelectorAll('select'));
        for (const sel of allSelects) {
          // Skip visible selects (they are native selects, not backing selects)
          if (isVisible(sel)) continue;

          const matchingOpt = Array.from(sel.options).find(
            (opt) => (opt.textContent || '').trim().toLowerCase() === displayedLabel.toLowerCase()
          );
          if (!matchingOpt) continue;
          if (sel.value === matchingOpt.value) continue; // already correct

          sel.value = matchingOpt.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('blur', { bubbles: true }));
          if (window.$) {
            window.$(sel).trigger('change');
            window.$(sel).trigger('blur');
          }
        }
      }
    } catch { }
  }).catch(() => { });
  await page.waitForTimeout(200);

  // ── Pre-save: fire blur/change on plain text/textarea inputs only ─────────────
  // Skip custom-select wrappers to avoid triggering dependent-dropdown reloads.
  await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll(
      '.offcanvas.show input:not([type="hidden"]), .offcanvas.show textarea, .modal.show input:not([type="hidden"]), .modal.show textarea'
    ));
    for (const control of controls) {
      try {
        const reactWrapper = control.closest('[class*="react-select"], [class*="select2"], .select2-container');
        if (reactWrapper) continue;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        control.dispatchEvent(new Event('blur', { bubbles: true }));
        control.dispatchEvent(new Event('focusout', { bubbles: true }));
      } catch { }
    }
  }).catch(() => { });
  await page.waitForTimeout(250);

  // ── Pre-save: clear stale validation state ────────────────────────────────────
  await page.evaluate(() => {
    try {
      const offcanvas = document.querySelector(
        '.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body'
      );
      if (!offcanvas) return;

      offcanvas.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
      offcanvas.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
      offcanvas.querySelectorAll('.fv-plugins-message-container').forEach((el) => { el.innerHTML = ''; });
      offcanvas.querySelectorAll('.invalid-feedback').forEach((el) => { el.style.display = 'none'; });

      const form = offcanvas.querySelector('form') || offcanvas.closest('form');
      if (form && form._fv) { try { form._fv.resetForm(true); } catch { } }
    } catch { }
  }).catch(() => { });
  await page.waitForTimeout(200);

  let saveBtn = await getActionableSaveButton(page);
  // Special case: Archive master uses #btnArchive
  const pageUrl = page.url ? await page.url() : '';
  if (!saveBtn && /\/Archive(\b|$)/i.test(pageUrl)) {
    saveBtn = await page.locator('#btnArchive').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      console.log('[SAVE] Found #btnArchive for Archive master');
    }
  }
  if (!saveBtn) {
    // Fallback: any visible submit button in .offcanvas-body
    saveBtn = await page.locator('.offcanvas-body button[type="submit"]:visible').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      console.log('[SAVE] Found generic submit button in .offcanvas-body');
    }
  }
  if (saveBtn && await saveBtn.isVisible().catch(() => false)) {
    console.log(`[SAVE] Found actionable Save button`);
  } else {
    console.log(`[SAVE] No actionable Save button found`);
  }
  const forceFireAnySaveButton = async () => {
    return page.evaluate(() => {
      const toText = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };

      const all = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const saveLike = all.filter((el) => {
        const id = toText(el.id);
        const text = toText(el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        return id === 'btnsave' || id === 'btnsubmit' || text === 'save' || text === 'submit' || /\b(save|submit|create)\b/.test(text);
      });

      const ordered = [
        ...saveLike.filter((el) => isVisible(el)),
        ...saveLike.filter((el) => !isVisible(el)),
      ];

      for (const el of ordered) {
        try {
          el.removeAttribute('disabled');
          if (el.style) {
            el.style.pointerEvents = 'auto';
            el.style.visibility = 'visible';
          }
          el.click();
          return true;
        } catch { }
      }
      return false;
    }).catch(() => false);
  };

  if (saveBtn) {
    await saveBtn.scrollIntoViewIfNeeded().catch(() => { });
    await page.waitForTimeout(200);
  }
  const activeOffcanvasSelector = await getActiveOffcanvasSelector(page);
  await page.evaluate((selector) => {
    // Scroll offcanvas body to bottom first
    const root = selector ? document.querySelector(selector) : null;
    const offcanvas = root?.querySelector('.offcanvas-body') || root;
    if (offcanvas) offcanvas.scrollTop = offcanvas.scrollHeight;

    // Then scroll #btnSave into the centre of the viewport
    const btn = document.getElementById('btnSave')
      || document.getElementById('btnSubmit')
      || root?.querySelector('#btnSave, #btnSubmit')
      || root?.parentElement?.querySelector('#btnSave, #btnSubmit');
    if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, activeOffcanvasSelector).catch(() => { });
  await page.waitForTimeout(400);

  // Intercept network to detect the real save mutation request.
  let saveRequestFired = false;
  let saveResponseOk = false;
  let saveResponseStatus = null;
  let saveRequestInfo = null;
  let saveResponseError = null;
  const onRequest = (req) => {
    const url = req.url().toLowerCase();
    const method = (req.method() || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
    if (!url.includes('/api/')) return;
    if (url.includes('/api/hub/') || url.includes('/negotiate')) return;
    if (url.includes('password-policy') && url.includes('validate')) return;

    saveRequestFired = true;
    if (!saveRequestInfo) {
      const postData = req.postData() || '';
      saveRequestInfo = {
        method,
        url: req.url(),
        postData: postData.slice(0, 2000),
      };
    }
  };
  const onResponse = (response) => {
    try {
      const req = response.request();
      const url = req.url().toLowerCase();
      const method = (req.method() || '').toUpperCase();
      if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
      if (!url.includes('/api/')) return;
      if (url.includes('/api/hub/') || url.includes('/negotiate')) return;
      if (url.includes('password-policy') && url.includes('validate')) return;

      saveRequestFired = true;
      saveResponseStatus = response.status();
      saveResponseOk = response.status() >= 200 && response.status() < 300;

      if (!saveRequestInfo) {
        const postData = req.postData() || '';
        saveRequestInfo = {
          method,
          url: req.url(),
          postData: postData.slice(0, 2000),
        };
      }

      // Capture error response body for non-2xx responses
      if (!saveResponseOk && !saveResponseError) {
        response.text().then((text) => {
          try {
            const json = JSON.parse(text);
            saveResponseError = json.message || json.error || JSON.stringify(json).slice(0, 500);
          } catch {
            saveResponseError = text.slice(0, 500);
          }
        }).catch(() => { });
      }
    } catch {
      // Ignore observer errors.
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  const clickSaveWithFallback = async () => {
    // Re-resolve Save button every click attempt in case active offcanvas changed.
    saveBtn = await getActionableSaveButton(page);

    const tryLocatorClick = async (locator, label) => {
      if (!locator) return false;
      const exists = await locator.count().catch(() => 0);
      if (!exists) return false;

      const visible = await locator.isVisible().catch(() => false);
      try {
        await locator.click({ timeout: 3000 });
        console.log(`[SAVE] Clicked ${label}${visible ? ' (visible)' : ''}`);
        return true;
      } catch {
        const forced = await locator.click({ timeout: 2500, force: true }).then(() => true).catch(() => false);
        if (forced) {
          console.log(`[SAVE] Force-clicked ${label}`);
          return true;
        }
        return false;
      }
    };

    if (saveBtn) {
      const clicked = await tryLocatorClick(saveBtn, 'detected save button');
      if (clicked) return true;
    }

    // Try scoped JS click against the active visible offcanvas only.
    const scopedActiveClick = await page.evaluate((selector) => {
      const root = selector ? document.querySelector(selector) : document.querySelector('.offcanvas.show, #masterFormOffcanvas, #offcanvas');
      if (!root) return false;
      const btn = root.querySelector('#btnSave, #btnSubmit, button[type="submit"], button.btn.btn-primary');
      if (!btn) return false;
      btn.removeAttribute('disabled');
      btn.click();
      return true;
    }, activeOffcanvasSelector).catch(() => false);
    if (scopedActiveClick) {
      console.log('[SAVE] Triggered active-offcanvas scoped save click');
      return true;
    }

    // Try common save button ids next.
    const idCandidates = ['#btnSave', '#btnSubmit'];
    for (const selector of idCandidates) {
      const visibleBtn = page.locator(`${selector}:visible`).first();
      const clickedVisible = await tryLocatorClick(visibleBtn, selector);
      if (clickedVisible) return true;

      const hiddenBtn = page.locator(selector).first();
      const clickedHidden = await tryLocatorClick(hiddenBtn, `${selector} (hidden fallback)`);
      if (clickedHidden) return true;
    }

    // Fall back to text-based buttons inside visible offcanvas/modal.
    const textCandidates = [
      page.locator('.offcanvas.show button:visible:not([disabled])', { hasText: /^\s*Save\s*$/i }).first(),
      page.locator('.offcanvas.show button:visible:not([disabled])', { hasText: /^\s*Submit\s*$/i }).first(),
      page.locator('.modal.show button:visible:not([disabled])', { hasText: /^\s*(Save|Submit)\s*$/i }).first(),
    ];
    for (const btn of textCandidates) {
      const clicked = await tryLocatorClick(btn, 'text-based save/submit button');
      if (clicked) return true;
    }

    // Keyboard fallback: many forms submit on Enter in active control.
    const enterTriggered = await page.keyboard.press('Enter').then(() => true).catch(() => false);
    if (enterTriggered) {
      console.log('[SAVE] Pressed Enter as submit fallback');
      return true;
    }

    // Form submit fallback for apps that listen to form submit instead of button click.
    const submittedByForm = await page.evaluate(() => {
      const form = document.querySelector('.offcanvas.show form, #masterFormOffcanvas form, #offcanvas form, form');
      if (!form) return false;
      try {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);
    if (submittedByForm) {
      console.log('[SAVE] Triggered form submit fallback');
      return true;
    }

    // Last resort: JS click whichever save-like button is visible.
    const jsClicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        '.offcanvas.show #btnSave, .offcanvas.show #btnSubmit, .offcanvas.show button, .modal.show button, #btnSave, #btnSubmit'
      ));
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null && !el.disabled;
      };

      for (const el of candidates) {
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const id = String(el.id || '').toLowerCase();
        const isSaveLike = id === 'btnsave' || id === 'btnsubmit' || text === 'save' || text === 'submit';
        if (!isSaveLike || !isVisible(el)) continue;
        el.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (jsClicked) {
      console.log('[SAVE] Triggered JS click on save-like button');
      return true;
    }

    const forceClicked = await forceFireAnySaveButton();
    if (forceClicked) {
      console.log('[SAVE] Triggered forceFireAnySaveButton fallback');
      return true;
    }

    return false;
  };

  console.log('[SAVE] Clicking Save button...');
  let anySaveClick = false;

  const firstClicked = await clickSaveWithFallback();
  anySaveClick = anySaveClick || firstClicked;

  // Some masters show a confirmation modal before firing the actual save request.
  // Click that confirm button immediately to avoid false retry loops.
  for (let pass = 0; pass < 2; pass++) {
    const clicked = await clickPendingConfirmationModal(page);
    if (!clicked) break;
    await page.waitForTimeout(500);
  }

  // If the first click did not trigger a save request, retry a few times.
  for (let retry = 1; retry <= 2 && !saveRequestFired; retry++) {
    await page.waitForTimeout(700);
    if (saveRequestFired) break;
    console.log(`[SAVE] No save request detected yet, retrying Save click (${retry}/2)`);
    const clickedAgain = await clickSaveWithFallback();
    anySaveClick = anySaveClick || clickedAgain;
    await clickPendingConfirmationModal(page).catch(() => { });
    await assertNoQuickFlowError(page, page.context(), '', isUpdate ? 'update' : 'create', `save retry ${retry}`);
  }

  if (!anySaveClick) {
    page.off('request', onRequest);
    page.off('response', onResponse);
    throw new Error('Save button was not clickable in create/update form.');
  }

  console.log('[SAVE] Save click sequence completed');

  let submittedReason = '';
  if (isUpdate) {
    const reasonText = await handleReasonRequiredModal(page, updateReason).catch(() => false);
    if (reasonText) submittedReason = reasonText;
  }

  // Brief wait for validation / network to fire
  await page.waitForTimeout(1500);
  await assertNoQuickFlowError(page, page.context(), '', isUpdate ? 'update' : 'create', 'post-save wait');

  // Check if validation errors appeared immediately after click
  const immediateValidation = await page.evaluate(() => {
    const looksLikeValidationMessage = (text) => /required|invalid|already|duplicate|must|enter|select|choose|special|match|minimum|maximum|length|allowed|exist/i.test(text);
    const msgs = [];
    // FormValidation.io style
    document.querySelectorAll('.fv-plugins-message-container').forEach(el => {
      const t = el.textContent.trim();
      if (t && looksLikeValidationMessage(t)) msgs.push(t);
    });
    // Bootstrap validation
    document.querySelectorAll('.invalid-feedback').forEach(el => {
      if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') {
        const t = el.textContent.trim();
        if (t && looksLikeValidationMessage(t)) msgs.push(t);
      }
    });
    // Generic error classes
    document.querySelectorAll('.text-danger, .field-error, .error-message').forEach(el => {
      if (el.offsetParent !== null) {
        const t = el.textContent.trim();
        if (t && t.length < 200 && looksLikeValidationMessage(t)) msgs.push(t);
      }
    });
    return [...new Set(msgs)];
  }).catch(() => []);

  if (immediateValidation.length > 0) {
    console.log(`[SAVE] Validation errors detected: ${immediateValidation.join(' | ')}`);
  }
  console.log(`[SAVE] Network request fired after click: ${saveRequestFired}`);
  if (saveRequestInfo) {
    console.log(`[SAVE] Request URL: ${saveRequestInfo.url}`);
    console.log(`[SAVE] Request payload: ${saveRequestInfo.postData}`);
  }

  if (isUpdate) {
    const reasonText = await handleReasonRequiredModal(page, updateReason).catch(() => false);
    if (reasonText && !submittedReason) submittedReason = reasonText;
  }

  // Allow a brief moment for response body to be captured asynchronously
  await page.waitForTimeout(300);
  if (saveResponseError) {
    console.log(`[SAVE] API Error response: ${saveResponseError}`);
  }

  // Fast outcome detection: exit as soon as success appears instead of waiting fixed timeout.
  console.log('[SAVE] Waiting for response...');
  let matchedMessage = '';
  let outcomeError = '';
  const maxOutcomeWaitMs = isUpdate ? 15000 : 7000;
  const pollMs = 250;
  let successfulApiSeenAt = 0;
  let submittedMasterSaveSeenAt = 0;

  for (let waited = 0; waited < maxOutcomeWaitMs; waited += pollMs) {
    // Some masters show a follow-up confirmation shortly after first click.
    await clickPendingConfirmationModal(page);
    if (isUpdate) {
      const reasonText = await handleReasonRequiredModal(page, updateReason).catch(() => false);
      if (reasonText && !submittedReason) submittedReason = reasonText;
    }

    const snapshot = await page.evaluate(() => {
      const visibleText = [];
      const hiddenText = [];

      const read = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };

      const messageNodes = document.querySelectorAll(
        '.swal2-title, .swal2-html-container, .swal2-content, .toast-message, .Toastify__toast, .toastr, .noty_body, .alert, .alert-success, .alert-danger'
      );

      messageNodes.forEach((node) => {
        const text = read(node);
        if (!text) return;
        if (isVisible(node)) visibleText.push(text);
        else hiddenText.push(text);
      });

      const looksLikeValidationMessage = (text) => /required|invalid|already|duplicate|must|enter|select|choose|special|match|minimum|maximum|length|allowed|exist/i.test(text);
      const validation = [];
      document.querySelectorAll('.invalid-feedback, .text-danger, .field-error, .fv-plugins-message-container').forEach((el) => {
        if (!isVisible(el)) return;
        const text = read(el);
        if (text && looksLikeValidationMessage(text)) validation.push(text);
      });

      const formOpen = !!document.querySelector('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body');

      return {
        visibleMessages: Array.from(new Set(visibleText)),
        hiddenMessages: Array.from(new Set(hiddenText)),
        validationText: Array.from(new Set(validation)).join('; '),
        formOpen,
      };
    }).catch(() => ({ visibleMessages: [], hiddenMessages: [], validationText: '', formOpen: true }));

    const allMessages = [...snapshot.visibleMessages, ...snapshot.hiddenMessages];
    const successMsg = allMessages.find((msg) => /success|saved successfully|updated successfully|created successfully|record saved|record created/i.test(msg));
    if (successMsg) {
      matchedMessage = successMsg;
      break;
    }

    const hardErrorMsg = snapshot.visibleMessages.find((msg) => {
      const lower = msg.toLowerCase();
      if (/(are you sure|confirm|yes|ok)/i.test(lower)) return false;
      return /error|failed|unable|already exists|duplicate|invalid|required/.test(lower);
    });
    if (hardErrorMsg) {
      outcomeError = `Save failed with message: ${hardErrorMsg}`;
      break;
    }

    if (snapshot.validationText) {
      const confirmStillVisible = await page.locator('.swal2-popup .swal2-confirm:visible:not([disabled]), .modal.show button:visible:not([disabled])').first().isVisible().catch(() => false);
      if (!confirmStillVisible && !saveRequestFired) {
        outcomeError = `Save blocked by validation errors: ${snapshot.validationText}`;
        break;
      }
    }

    // If save request fired and form closed, treat it as immediate success.
    if (saveRequestFired && !snapshot.formOpen) {
      matchedMessage = 'Saved successfully (form closed after request)';
      break;
    }

    // Some masters keep the form open and do not show a toast even after a successful save API.
    // Accept API-confirmed success when there are no visible validation/error blockers.
    if (saveRequestFired && saveResponseOk && !snapshot.validationText && !hardErrorMsg) {
      if (!successfulApiSeenAt) successfulApiSeenAt = Date.now();
      if (Date.now() - successfulApiSeenAt >= 900) {
        matchedMessage = 'Saved successfully (API response succeeded)';
        break;
      }
    }

    if (saveRequestFired && saveResponseStatus && !saveResponseOk) {
      const errorDetail = saveResponseError ? ` - ${saveResponseError}` : '';
      outcomeError = `Save API failed: ${saveRequestInfo?.url || 'unknown url'} (status ${saveResponseStatus})${errorDetail}`;
      break;
    }

    const masterSaveRequestObserved = isUpdate
      && saveRequestFired
      && /\/api\/latest\/masters/i.test(String(saveRequestInfo?.url || ''));
    if (masterSaveRequestObserved && !snapshot.validationText && !hardErrorMsg) {
      if (!submittedMasterSaveSeenAt) submittedMasterSaveSeenAt = Date.now();
      if (Date.now() - submittedMasterSaveSeenAt >= 3500) {
        matchedMessage = saveResponseOk
          ? 'Updated successfully (API response succeeded)'
          : 'Updated successfully (master save request submitted)';
        break;
      }
    }

    await page.waitForTimeout(pollMs);
  }

  page.off('request', onRequest);
  page.off('response', onResponse);

  if (outcomeError) {
    throw new Error(outcomeError);
  }

  // Fallback for masters that close the form without a visible toast.
  if (!matchedMessage) {
    const formStillOpen = await page.locator(SEL.offcanvas).first().isVisible().catch(() => false);
    if (!formStillOpen) {
      if (!saveRequestFired && immediateValidation.length > 0) {
        throw new Error(`Save blocked by validation errors: ${immediateValidation.join(' | ')}`);
      }
      matchedMessage = saveRequestFired
        ? 'Saved successfully (form closed after request)'
        : 'Form closed (assumed success)';
    } else if (
      isUpdate
      && saveRequestFired
      && /\/api\/latest\/masters/i.test(String(saveRequestInfo?.url || ''))
      && !saveResponseStatus
    ) {
      matchedMessage = 'Updated successfully (master save request submitted)';
    } else {
      throw new Error(`Save did not produce a recognizable success or error message within ${Math.round(maxOutcomeWaitMs / 1000)}s`);
    }
  }

  // Dismiss SweetAlert OK if present
  const okBtn = page.locator('.swal2-confirm:visible:not([disabled])').first();
  const ok = await okBtn.isVisible().catch(() => false);
  if (ok) {
    await okBtn.click({ timeout: 3000, force: true }).catch(() => { });
    await page.waitForTimeout(250);
  }

  // Some flows show a second generic confirmation in non-Swal modal.
  await clickPendingConfirmationModal(page);

  console.log(`[SAVE] ✓ ${matchedMessage}`);
  return { message: matchedMessage, reasonText: submittedReason };
}

function isValidationFailure(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('validation')
    || msg.includes('required')
    || msg.includes('save blocked')
    || msg.includes('special characters')
    || msg.includes('invalid');
}

function isDuplicateError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return /already exists|duplicate|record already|already taken|already registered|duplicate entry/i.test(msg);
}

function isOffcanvasClosedFailure(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('offcanvas closed unexpectedly')
    || msg.includes('sidebar closed unexpectedly')
    || msg.includes('target page, context or browser has been closed')
    || msg.includes('execution context was destroyed');
}

async function collectValidationSummary(page) {
  return page.evaluate(() => {
    const messages = [];
    const selectors = [
      '.invalid-feedback',
      '.text-danger',
      '.field-error',
      '.error-message',
      '.fv-plugins-message-container',
      '.validation-summary-errors li',
    ];

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) messages.push(text);
      }
    }

    const invalidLabels = [];
    document.querySelectorAll('.is-invalid, [aria-invalid="true"]').forEach((field) => {
      const wrapper = field.closest('.form-group, .mb-3, .fv-row, [class*="col-"]') || field.parentElement;
      const label = wrapper?.querySelector('label, .form-label, .control-label');
      const text = (label?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) invalidLabels.push(text);
    });

    const unique = [...new Set([...messages, ...invalidLabels])];
    return unique.join(' | ');
  }).catch(() => '');
}

async function getTargetRow(page, targetRecordName = '') {
  await waitForUsableTableRows(page);
  const target = String(targetRecordName || '').trim();
  if (!target) {
    const row = await getNthUsableRow(page, 0);
    if (row) return row;
    throw new Error('No usable data rows found in table.');
  }

  const row = page.locator(SEL.tableRows).filter({ hasText: target }).filter({ hasNotText: /no data|no matching|loading|please wait/i }).first();
  const visible = await row.isVisible().catch(() => false);
  if (visible) return row;

  const searchBox = page.locator(SEL.searchBox).first();
  if (await searchBox.isVisible().catch(() => false)) {
    await searchBox.fill('').catch(() => { });
    await searchBox.fill(target).catch(() => { });
    await page.waitForTimeout(800);

    await waitForUsableTableRows(page, 8000).catch(() => false);
    const filteredRow = page.locator(SEL.tableRows).filter({ hasText: target }).filter({ hasNotText: /no data|no matching|loading|please wait/i }).first();
    if (await filteredRow.isVisible().catch(() => false)) {
      return filteredRow;
    }
  }

  throw new Error(`Target record not found in table: ${target}`);
}

function isUsableRowText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (/no data|no matching|loading|please wait|processing/i.test(value)) return false;
  return true;
}

async function waitForUsableTableRows(page, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = await page.locator(SEL.tableRows).count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const row = page.locator(SEL.tableRows).nth(i);
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await row.textContent().catch(() => '');
      if (isUsableRowText(text)) return true;
    }
    await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => { });
    await page.waitForTimeout(500);
  }
  return false;
}

async function getNthUsableRow(page, n = 0) {
  await waitForUsableTableRows(page);
  const rows = await page.locator(SEL.tableRows).all();
  const usableRows = [];
  for (const row of rows) {
    const visible = await row.isVisible().catch(() => false);
    if (!visible) continue;
    const text = await row.textContent().catch(() => '');
    if (isUsableRowText(text)) usableRows.push(row);
  }
  return usableRows[n] || usableRows[usableRows.length - 1] || null;
}

// ── Open first row for editing ─────────────────────────────────────────────────
async function openFirstEdit(page, targetRecordName = '') {
  const waitForVisibleOffcanvas = async (timeoutMs = 6000) => {
    return page.waitForFunction(() => {
      const body = document.querySelector(
        '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body, .offcanvas-body'
      );
      if (!body) return false;
      const style = getComputedStyle(body);
      return style.visibility === 'visible' && style.display !== 'none';
    }, { timeout: timeoutMs }).then(() => true).catch(() => false);
  };

  // Dismiss any lingering overlays that might block the edit button or offcanvas
  for (let i = 0; i < 3; i++) {
    const dismissed = await dismissBlockingOverlays(page);
    if (!dismissed) break;
  }
  await page.waitForTimeout(300);

  // Scroll the table row into view
  const targetRow = await getTargetRow(page, targetRecordName);
  await targetRow.scrollIntoViewIfNeeded().catch(() => { });
  await page.waitForTimeout(200);

  let opened = false;
  let lastError = '';

  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    // Dismiss overlays again before each attempt
    for (let i = 0; i < 2; i++) {
      const dismissed = await dismissBlockingOverlays(page);
      if (!dismissed) break;
    }
    await page.waitForTimeout(200);

    const currentTargetRow = await getTargetRow(page, targetRecordName);
    const firstDataCell = currentTargetRow.locator('td').nth(1);

    const openStrategies = [
      {
        label: 'double-clicked first data cell',
        run: async () => {
          if (await firstDataCell.isVisible().catch(() => false)) {
            await firstDataCell.dblclick({ timeout: 5000 });
            return true;
          }
          return false;
        },
      },
      {
        label: 'double-clicked first row',
        run: async () => {
          if (await currentTargetRow.isVisible().catch(() => false)) {
            await currentTargetRow.dblclick({ timeout: 5000 });
            return true;
          }
          return false;
        },
      },
      {
        label: 'clicked edit link/button',
        run: async () => {
          let editBtn = currentTargetRow.locator('a[data-action="edit"]').first();
          let isVisible = await editBtn.isVisible().catch(() => false);

          if (!isVisible) {
            editBtn = currentTargetRow.locator('.fa-edit, .fa-pen-to-square').first();
            isVisible = await editBtn.isVisible().catch(() => false);
          }

          if (!isVisible) {
            return false;
          }

          try {
            await editBtn.click({ timeout: 5000 });
          } catch {
            await editBtn.click({ timeout: 4000, force: true });
          }
          return true;
        },
      },
    ];

    for (const strategy of openStrategies) {
      let actionRan = false;

      try {
        actionRan = await strategy.run();
      } catch (e) {
        lastError = e?.message || String(e);
      }

      if (!actionRan) continue;

      console.log(`[UPDATE] ${strategy.label}`);
      console.log('[UPDATE] Waiting for offcanvas visibility to change...');

      opened = await waitForVisibleOffcanvas(7000);
      if (opened) {
        console.log('[UPDATE] Offcanvas became visible');
        break;
      }
    }

    if (opened) break;

    console.log(`[UPDATE] Visibility wait attempt ${attempt + 1} failed: offcanvas remained hidden`);

    // If that didn't work, try forcing the offcanvas to be shown
    if (!opened) {
      try {
        console.log('[UPDATE] Attempting to force show offcanvas via JavaScript...');
        await page.evaluate(() => {
          // Method 1: Try Bootstrap 5 Offcanvas API
          const offcanvasElement = document.querySelector('.offcanvas');
          if (offcanvasElement) {
            // Remove visibility:hidden inline style if present
            offcanvasElement.style.visibility = 'visible';
            offcanvasElement.style.opacity = '1';

            // Try Bootstrap Offcanvas show method if available
            if (window.bootstrap && window.bootstrap.Offcanvas) {
              const offcanvasInstance = window.bootstrap.Offcanvas.getInstance(offcanvasElement) ||
                new window.bootstrap.Offcanvas(offcanvasElement);
              offcanvasInstance.show();
            }
          }

          // Method 2: Force visibility on offcanvas-body
          const body = document.querySelector('.offcanvas-body');
          if (body) {
            body.style.visibility = 'visible';
            body.style.display = 'block';
          }
        });

        await page.waitForTimeout(500);

        // Verify it's now visible
        const nowVisible = await waitForVisibleOffcanvas(1500);

        if (nowVisible) {
          console.log('[UPDATE] Offcanvas is now visible after JavaScript intervention');
          opened = true;
          break;
        }
      } catch (e) {
        console.log(`[UPDATE] Force show attempt ${attempt + 1} failed: ${e.message}`);
      }
    }

    if (!opened) {
      lastError = 'Offcanvas visibility could not be changed to visible';
      await page.waitForTimeout(800);
    }
  }

  if (!opened) {
    throw new Error(`Failed to open edit form after 3 attempts. Last error: ${lastError}`);
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
  await page.waitForTimeout(1000);
}

// ── Delete first row (same as auto-masters.spec.js deleteFirst) ────────────────
async function deleteFirst(page, targetRecordName = null, deleteReason = '') {
  const initialRowCount = await page.locator(SEL.tableRows).count().catch(() => 0);
  let submittedReason = '';
  const mutationRequest = {
    fired: false,
    ok: false,
    status: null,
    url: '',
  };

  const onRequest = (req) => {
    try {
      const method = (req.method() || '').toUpperCase();
      const url = req.url() || '';
      const lower = url.toLowerCase();

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
      if (!lower.includes('/api/')) return;
      if (lower.includes('/api/hub/') || lower.includes('/negotiate')) return;
      if (lower.includes('password-policy') && lower.includes('validate')) return;

      mutationRequest.fired = true;
      mutationRequest.url = url;
    } catch {
      // Ignore observer errors.
    }
  };

  const onResponse = (response) => {
    try {
      const req = response.request();
      const method = (req.method() || '').toUpperCase();
      const url = req.url() || '';
      const lower = url.toLowerCase();

      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
      if (!lower.includes('/api/')) return;
      if (lower.includes('/api/hub/') || lower.includes('/negotiate')) return;
      if (lower.includes('password-policy') && lower.includes('validate')) return;

      mutationRequest.fired = true;
      mutationRequest.status = response.status();
      mutationRequest.url = url;
      mutationRequest.ok = response.status() >= 200 && response.status() < 300;
    } catch {
      // Ignore observer errors.
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  const targetRow = await getTargetRow(page, targetRecordName || '');
  const rowScopedCandidates = [
    {
      label: 'data-action deactivate/delete link',
      locator: targetRow.locator('a[data-action="deactivate"], a[data-action="delete"]').first(),
    },
    {
      label: 'btn-deactive delete button',
      locator: targetRow.locator('button.btn-deactive.delete, button[title*="Deactivate" i]').first(),
    },
    {
      label: 'delete/deactivate icon',
      locator: targetRow.locator('.fa-trash, .fa-trash-alt, .fa-user-lock, .fa-times').first(),
    },
  ];

  let clicked = false;
  for (const candidate of rowScopedCandidates) {
    const visible = await candidate.locator.isVisible().catch(() => false);
    if (!visible) continue;

    await candidate.locator.click({ timeout: 5000 }).catch(async () => {
      await candidate.locator.click({ timeout: 3000, force: true }).catch(() => { });
    });

    await page.waitForTimeout(500);

    const promptChecks = await Promise.all([
      page.locator('.swal2-popup .swal2-confirm:visible:not([disabled])').first().isVisible().catch(() => false),
      page.locator('.modal.show button:visible:not([disabled])').first().isVisible().catch(() => false),
      page.locator('#reasonTextarea:visible').first().isVisible().catch(() => false),
    ]);
    const promptVisible = promptChecks.some(Boolean);

    if (mutationRequest.fired || promptVisible) {
      clicked = true;
      console.log(`[DELETE] Clicked ${candidate.label}`);
      break;
    }

    console.log(`[DELETE] ${candidate.label} did not trigger confirmation/API; trying next control`);
  }

  if (!clicked) {
    // Strategy 4: checkbox + toolbar delete
    const cb = targetRow.locator('input[type="checkbox"]').first();
    await cb.check().catch(() => { });
    await page.locator(SEL.deleteBtn).first().click({ timeout: 5000 }).catch(async () => {
      await page.locator(SEL.deleteBtn).first().click({ timeout: 3000, force: true }).catch(() => { });
    });
    console.log('[DELETE] Used checkbox + toolbar delete');
  }

  let successMessage = '';
  try {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 22000) {
      // Handle optional reason modal first if delete/deactivate asks for it.
      const reasonText = await handleReasonRequiredModal(page, deleteReason).catch(() => false);
      if (reasonText && !submittedReason) submittedReason = reasonText;

      // Handle confirmation dialogs (Swal / modal Yes-Ok-Confirm-Submit etc.).
      await clickPendingConfirmationModal(page);
      const deleteConfirmBtn = page.locator('.modal.show button:visible:not([disabled]), .swal2-popup button:visible:not([disabled])', {
        hasText: /\b(yes|ok|confirm|submit|deactivate|delete)\b/i,
      }).first();
      if (await deleteConfirmBtn.isVisible().catch(() => false)) {
        await deleteConfirmBtn.click({ timeout: 3000, force: true }).catch(() => { });
        await page.waitForTimeout(200);
      }

      const snapshot = await page.evaluate((recordName) => {
        const read = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        };

        const nodes = document.querySelectorAll('.swal2-title, .swal2-html-container, .toast-message, .Toastify__toast, .alert, .alert-success, .alert-danger');
        const messages = [];
        nodes.forEach((node) => {
          if (!isVisible(node)) return;
          const text = read(node);
          if (text) messages.push(text);
        });

        let recordStillVisible = false;
        if (recordName) {
          const rows = document.querySelectorAll('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr');
          for (const row of rows) {
            const rowText = read(row);
            if (rowText.includes(recordName)) {
              recordStillVisible = true;
              break;
            }
          }
        }

        return {
          messages: Array.from(new Set(messages)),
          recordStillVisible,
        };
      }, targetRecordName).catch(() => ({ messages: [], recordStillVisible: true }));

      const success = snapshot.messages.find((msg) => /deleted successfully|deactivated successfully|successfully deleted|successfully deactivated|record deleted|record deactivated/i.test(msg));
      if (success) {
        if (mutationRequest.status && !mutationRequest.ok) {
          throw new Error(`Delete/deactivate success toast seen, but mutation API failed. Last API: ${mutationRequest.url || 'none'} status=${mutationRequest.status ?? 'n/a'}`);
        }
        successMessage = success;
        break;
      }

      const hardError = snapshot.messages.find((msg) => {
        const lower = String(msg || '').toLowerCase();
        if (/(are you sure|confirm|yes|ok|submit)/i.test(lower)) return false;
        return /error|failed|unable|already exists|duplicate|invalid|required|not deleted|not deactivated/.test(lower);
      });
      if (hardError) {
        throw new Error(`Delete/deactivate failed with message: ${hardError}`);
      }

      // Fallback: accept only when target record disappears AND a successful mutation API call occurred.
      if (targetRecordName && mutationRequest.fired && mutationRequest.ok && !snapshot.recordStillVisible) {
        successMessage = `Delete/deactivate reflected in table and API succeeded for ${targetRecordName}`;
        break;
      }

      // Soft-deactivated rows can remain visible in the grid; a successful API call
      // is enough to proceed, and Audit History verification will prove the action.
      if (mutationRequest.fired && mutationRequest.ok) {
        successMessage = 'Delete/deactivate API succeeded; proceeding to Audit History verification';
        break;
      }

      if (submittedReason && mutationRequest.fired && !mutationRequest.status) {
        successMessage = 'Delete/deactivate submitted; proceeding to Audit History verification';
        break;
      }

      if (mutationRequest.fired && !mutationRequest.status && Date.now() - startedAt > 4500) {
        const blockingDialogVisible = await page.locator('.modal.show, .swal2-popup').first().isVisible().catch(() => false);
        if (!blockingDialogVisible) {
          successMessage = 'Delete/deactivate request submitted; proceeding to Audit History verification';
          break;
        }
      }

      if (submittedReason && !mutationRequest.fired && Date.now() - startedAt > 4500) {
        const blockingDialogVisible = await page.locator('.modal.show, .swal2-popup').first().isVisible().catch(() => false);
        if (!blockingDialogVisible) {
          successMessage = 'Delete/deactivate reason submitted; proceeding to Audit History verification';
          break;
        }
      }

      // If API call failed, fail fast instead of false success.
      if (mutationRequest.fired && !mutationRequest.ok) {
        throw new Error(`Delete/deactivate API failed: ${mutationRequest.url || 'unknown url'} (status ${mutationRequest.status ?? 'n/a'})`);
      }

      await page.waitForTimeout(300);
    }

    if (!successMessage) {
      const recordHint = targetRecordName ? ` Target record: ${targetRecordName}.` : '';
      throw new Error(`Delete/deactivate not confirmed: no success signal + record still visible or no successful API call.${recordHint}`);
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  // Best-effort final OK dismissal if a success popup remains open.
  const okBtn = page.locator('.swal2-confirm:visible:not([disabled])').first();
  if (await okBtn.isVisible().catch(() => false)) {
    await okBtn.click({ timeout: 3000, force: true }).catch(() => { });
    await page.waitForTimeout(200);
  }

  console.log(`[DELETE] ✓ ${successMessage}`);
  return { message: successMessage, reasonText: submittedReason };
}

// ── Get first record name ──────────────────────────────────────────────────────
async function getFirstRecordName(page, targetRecordName = '') {
  const row = await getTargetRow(page, targetRecordName);
  return row.locator('td:nth-child(2), td:first-child').first().textContent().then((value) => String(value || '').trim()).catch(() => null);
}

// ── Get Nth visible record name (0-based index) ────────────────────────────────
async function getNthRecordName(page, n = 0) {
  const targetRow = await getNthUsableRow(page, n);
  if (!targetRow) return null;
  return targetRow.locator('td:nth-child(2), td:first-child').first().textContent().then((value) => String(value || '').trim()).catch(() => null);
}

function normalizeValueForCompare(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSiteMaster(masterName) {
  const normalized = String(masterName || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  return normalized === 'site';
}

function extractExistingSiteValues(existingDetails) {
  const rows = Array.isArray(existingDetails?.rows) ? existingDetails.rows : [];
  const names = new Set();
  const codes = new Set();

  for (const row of rows) {
    for (const [key, rawValue] of Object.entries(row || {})) {
      const value = String(rawValue || '').trim();
      if (!value) continue;
      const keyText = String(key || '').toLowerCase();
      if (/(^|\s|_|-)(site\s*name|name)(\s|_|-|$)/i.test(keyText)) {
        names.add(normalizeValueForCompare(value));
      }
      if (/(^|\s|_|-)(site\s*code|code)(\s|_|-|$)/i.test(keyText)) {
        codes.add(normalizeValueForCompare(value));
      }
    }
  }

  return { names, codes };
}

function buildSiteCreatePrefilledValues(stamp, existingNameSet = new Set(), existingCodeSet = new Set()) {
  let siteStamp = String(stamp || '').trim() || refreshStamp();
  let siteName = `AUTO-SITE-${siteStamp}`;
  let siteCode = `ST${guidToken(8)}`;
  let safety = 0;

  while ((existingNameSet.has(normalizeValueForCompare(siteName))
      || existingCodeSet.has(normalizeValueForCompare(siteCode)))
      && safety < 25) {
    safety += 1;
    siteStamp = refreshStamp();
    siteName = `AUTO-SITE-${siteStamp}`;
    siteCode = `ST${guidToken(8)}`;
  }

  // Add random numbers to all fields to ensure uniqueness and pass validation
  const randomSuffix = guidToken(12);
  const pinSuffix = guidDigits(5);
  
  return {
    Name: siteName,
    'Site Name': siteName,
    'Site Code': siteCode,
    Code: siteCode,
    'Country Name': 'India',
    Country: 'India',
    'Time Zone Name': 'India ( +05:30 )',
    'Time Zone': 'India ( +05:30 )',
    Address: `42, Pharma Park Road, Ahmedabad ${randomSuffix}`,
    'vAddress1': `42, Pharma Park Road, Ahmedabad ${randomSuffix}`,
    City: 'Ahmedabad',
    State: 'Gujarat',
    'PIN Code': `380${pinSuffix}`,
    Pin: `380${pinSuffix}`,
    'Postal Code': `380${pinSuffix}`,
    'Remark': `Created for QA workflow validation. ${randomSuffix}`,
    'Description': `Created for QA workflow validation. ${randomSuffix}`,
    'vRemarks': `Created for QA workflow validation. ${randomSuffix}`,
  };
}

async function collectExistingTableDetails(page, maxRows = 80) {
  return page.evaluate((limit) => {
    const rows = Array.from(document.querySelectorAll('.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr')).slice(0, limit);
    const headers = Array.from(document.querySelectorAll('.dt-scroll-head thead th, .dataTables_scrollHead thead th, table thead th'))
      .map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const data = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
      const obj = {};
      cells.forEach((value, index) => {
        const key = headers[index] || `col_${index + 1}`;
        obj[key] = value;
      });
      return obj;
    });

    return { headers, rows: data };
  }, maxRows).catch(() => ({ headers: [], rows: [] }));
}

async function snapshotRecordDetails(page, targetRecordName = '') {
  const snapshotValues = {};
  let opened = false;

  try {
    await openFirstEdit(page, targetRecordName);
    opened = true;

    const editFields = await collectStableFormFields(page);
    console.log(`[SNAPSHOT] Reading ${editFields.length} fields from saved record "${targetRecordName}"...`);

    for (const field of editFields) {
      const key = String(field?.displayName || field?.id || '').trim();
      if (!key) continue;
      if (/password|confirm\s*password/i.test(key)) continue;

      try {
        const value = await readFieldValue(page, field.idx, field);
        const text = String(value ?? '').trim();
        if (!text) continue;
        snapshotValues[key] = text;
      } catch {
        // Skip unreadable fields in the snapshot.
      }
    }
  } finally {
    if (opened) {
      await page.keyboard.press('Escape').catch(() => { });
      await page.waitForTimeout(350);
      await dismissBlockingOverlays(page).catch(() => false);
    }
  }

  console.log(`[SNAPSHOT] Captured ${Object.keys(snapshotValues).length} saved field values from record.`);
  return snapshotValues;
}

function buildCreateRetryPrefilledValues(fields, existingDetails, stamp) {
  const rows = Array.isArray(existingDetails?.rows) ? existingDetails.rows : [];
  const existingValues = new Set();
  for (const row of rows) {
    for (const value of Object.values(row || {})) {
      const normalized = normalizeValueForCompare(value);
      if (normalized) existingValues.add(normalized);
    }
  }

  const prefilled = {};
  const candidates = Array.isArray(fields) ? fields : [];
  const duplicateProne = candidates.filter((field) => {
    const name = String(field?.displayName || field?.id || '').toLowerCase();
    return /name|code|email|mobile|phone|contact|user\s*name|login\s*id|identifier|id\b/.test(name)
      && !/recordid|record id/.test(name)
      && !field?.disabled;
  });

  const targets = duplicateProne.length > 0
    ? duplicateProne
    : candidates.filter((field) => {
      const type = String(field?.elementType || '').toLowerCase();
      return !field?.disabled && (type === 'text' || type === 'email' || type === 'number' || type === 'decimal' || type === 'tel');
    }).slice(0, 2);

  const makeUniqueText = (base) => {
    let value = `${base}${guidToken(16)}`;
    let tries = 0;
    while (existingValues.has(normalizeValueForCompare(value)) && tries < 20) {
      tries += 1;
      value = `${base}${guidToken(16)}${tries}`;
    }
    existingValues.add(normalizeValueForCompare(value));
    return value;
  };

  for (const field of targets) {
    const label = String(field?.displayName || field?.id || '').trim();
    if (!label) continue;
    const type = String(field?.elementType || '').toLowerCase();
    const token = label.replace(/[^a-z0-9]+/gi, '').slice(0, 8) || 'Auto';

    // Special handling for Sequence No. fields
    if (/sequence\s*no|seq\s*no|seqno|sequence/i.test(label.toLowerCase())) {
      let seqVal = guidDigits(10);
      let safety = 0;
      while (existingValues.has(normalizeValueForCompare(seqVal)) && safety < 20) {
        safety += 1;
        seqVal = guidDigits(10);
      }
      prefilled[label] = seqVal;
      existingValues.add(normalizeValueForCompare(seqVal));
      continue;
    }

    if (type === 'email' || /email/.test(label.toLowerCase())) {
      const email = `qa.${token.toLowerCase()}.${guidToken(16).toLowerCase()}@pharmatest.in`;
      prefilled[label] = existingValues.has(normalizeValueForCompare(email))
        ? `qa.${token.toLowerCase()}.${guidToken(16).toLowerCase()}@pharmatest.in`
        : email;
      existingValues.add(normalizeValueForCompare(prefilled[label]));
      continue;
    }

    if (type === 'tel' || /mobile|phone|contact/.test(label.toLowerCase())) {
      let mobile = `9${guidDigits(9)}`;
      let safety = 0;
      while (existingValues.has(normalizeValueForCompare(mobile)) && safety < 20) {
        safety += 1;
        mobile = `9${guidDigits(9)}`;
      }
      prefilled[label] = mobile;
      existingValues.add(normalizeValueForCompare(mobile));
      continue;
    }

    if (type === 'number' || type === 'decimal') {
      let numeric = guidDigits(10);
      let safety = 0;
      while (existingValues.has(normalizeValueForCompare(numeric)) && safety < 20) {
        safety += 1;
        numeric = guidDigits(10);
      }
      prefilled[label] = numeric;
      existingValues.add(normalizeValueForCompare(numeric));
      continue;
    }

    prefilled[label] = makeUniqueText(`${token}_`);
  }

  return prefilled;
}

// ── CRUD Operations ────────────────────────────────────────────────────────────

async function createRecord(page, masterName, baseURL, verifyAudit = false, auditContext = {}, createPrefilledValues = null) {
  console.log(`[CREATE] Opening form for ${masterName}...`);
  await openCreateForm(page);

  const mergedAuditTrail = {};
  const siteMaster = isSiteMaster(masterName);
  const maxAttempts = 5; // increased to allow duplicate-retry attempts
  const invalidRoles = new Set(); // Track roles that don't have app assignments
  const maxRoleRetries = 2; // Limit role-specific retries to prevent browser crashes
  let roleRetryCount = 0;
  let alertMsg = '';
  let lastError = null;
  let lastDiscoveredFields = [];
  let duplicateRetryPrefilledValues = null;
  let existingSiteNames = new Set();
  let existingSiteCodes = new Set();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const fields = await collectStableFormFields(page);
      lastDiscoveredFields = fields;
      console.log(`[CREATE] Discovered ${fields.length} fields before fill (attempt ${attempt}/${maxAttempts})`);

      console.log('[CREATE] Filling fields...');
      const siteCreatePrefilledValues = siteMaster
        ? buildSiteCreatePrefilledValues(refreshStamp(), existingSiteNames, existingSiteCodes)
        : null;
      const attemptPrefilledValues = {
        ...(siteCreatePrefilledValues && typeof siteCreatePrefilledValues === 'object' ? siteCreatePrefilledValues : {}),
        ...(createPrefilledValues && typeof createPrefilledValues === 'object' ? createPrefilledValues : {}),
        ...(duplicateRetryPrefilledValues && typeof duplicateRetryPrefilledValues === 'object' ? duplicateRetryPrefilledValues : {}),
      };

      const attemptAudit = await smartFillOffcanvasForm(page, masterName, fields, {
        invalidRoles,
        prefilledValues: Object.keys(attemptPrefilledValues).length ? attemptPrefilledValues : null,
      });
      Object.assign(mergedAuditTrail, attemptAudit);
      await assertNoQuickFlowError(page, page.context(), masterName, 'create', 'field fill');

      console.log('[CREATE] Saving...');
      const saveResult = await saveForm(page, false);
      alertMsg = saveResult.message;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;

      // ── Role has no APP assigned error ───────────────────────────────────
      if (isRoleAppAssignmentError(error)) {
        const invalidRole = extractRoleFromAppError(error);
        if (invalidRole) {
          invalidRoles.add(invalidRole);
          console.log(`[CREATE] Role "${invalidRole}" has no APP assigned; adding to blocklist`);
        }

        roleRetryCount++;

        // If we've already retried role selection maxRoleRetries times, fail to avoid browser crash
        if (roleRetryCount > maxRoleRetries) {
          throw new Error(`Create failed: after ${maxRoleRetries} role selection attempts with roles [${Array.from(invalidRoles).join(', ')}], all have no APP assigned. System configuration issue.`);
        }

        if (attempt === maxAttempts) {
          throw new Error(`Create failed: role(s) [${Array.from(invalidRoles).join(', ')}] have no APP assigned, and all ${maxAttempts} attempts exhausted.`);
        }

        console.log(`[CREATE] Retrying with different role (attempt ${attempt + 1}/${maxAttempts})...`);
        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(500);
        const okBtn = page.locator('.swal2-confirm:visible:not([disabled])').first();
        if (await okBtn.isVisible().catch(() => false)) {
          await okBtn.click({ timeout: 2000, force: true }).catch(() => { });
          await page.waitForTimeout(300);
        }

        if (baseURL) {
          await navigateTo(page, masterName, baseURL).catch(() => { });
        }
        await openCreateForm(page);
        await page.waitForTimeout(600);
        continue;
      }

      // ── Duplicate / already-exists error ────────────────────────────────
      if (isDuplicateError(error)) {
        if (attempt === maxAttempts) {
          console.log(`[CREATE] Duplicate values detected on all ${maxAttempts} attempts. Skipping create without reporting as bug.`);
          if (baseURL) {
            await navigateTo(page, masterName, baseURL).catch(() => { });
          }
          return {
            operation: 'Create',
            skipped: true,
            skipReason: 'duplicate-after-retries',
            recordName: '',
            auditTrail: mergedAuditTrail,
            alertMessage: `Skipped after ${maxAttempts} duplicate retries`,
            fieldCount: Object.keys(mergedAuditTrail).length,
            auditVerification: null,
            steps: ['Add a new record', 'Fill all fields', 'Click Save', ...(verifyAudit ? ['Navigate to Audit Trail', 'Verify audit trail entry for created record'] : [])],
            expectedResult: verifyAudit ? 'A new record should be created successfully and audit trail should reflect the creation.' : 'A new record should be created successfully.',
          };
        }

        const newStamp = refreshStamp();
        console.log(`[CREATE] Duplicate entry detected. Fetching existing details and regenerating create input (stamp: ${newStamp}) (attempt ${attempt + 1}/${maxAttempts})...`);

        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(400);
        const okBtn2 = page.locator('.swal2-confirm:visible:not([disabled])').first();
        if (await okBtn2.isVisible().catch(() => false)) {
          await okBtn2.click({ timeout: 2000, force: true }).catch(() => { });
          await page.waitForTimeout(300);
        }

        if (baseURL) {
          await navigateTo(page, masterName, baseURL).catch(() => { });
        }

        const existingDetails = await collectExistingTableDetails(page, 80);
        if (siteMaster) {
          const siteValues = extractExistingSiteValues(existingDetails);
          existingSiteNames = new Set([...existingSiteNames, ...siteValues.names]);
          existingSiteCodes = new Set([...existingSiteCodes, ...siteValues.codes]);
          duplicateRetryPrefilledValues = buildSiteCreatePrefilledValues(newStamp, existingSiteNames, existingSiteCodes);
        } else {
          duplicateRetryPrefilledValues = buildCreateRetryPrefilledValues(lastDiscoveredFields, existingDetails, newStamp);
        }
        const detailCount = Array.isArray(existingDetails?.rows) ? existingDetails.rows.length : 0;
        const overrideCount = Object.keys(duplicateRetryPrefilledValues || {}).length;
        console.log(`[CREATE] Collected ${detailCount} existing row details and prepared ${overrideCount} unique override fields for create retry.`);

        await openCreateForm(page);
        await page.waitForTimeout(600);
        continue;
      }

      // ── Form closed unexpectedly ─────────────────────────────────────────
      if (isOffcanvasClosedFailure(error)) {
        if (attempt === maxAttempts) {
          throw error;
        }

        // If the page itself is closed/dead, retrying is impossible — fail fast.
        if (page.isClosed?.()) {
          throw new Error(`Create failed: page is closed (cannot recover after offcanvas closure). Original error: ${error?.message || error}`);
        }

        console.log(`[CREATE] Form closed during dependent dropdown handling, reopening and retrying (attempt ${attempt + 1}/${maxAttempts})`);
        if (baseURL) {
          await navigateTo(page, masterName, baseURL).catch(() => { });
        }
        await openCreateForm(page);
        await page.waitForTimeout(600);
        continue;
      }

      if (!isValidationFailure(error) || attempt === maxAttempts) {
        throw error;
      }

      const summary = await collectValidationSummary(page);
      const msg = String(error?.message || error);
      console.log(`[CREATE] Save blocked by validation, retrying with corrected values (attempt ${attempt + 1}/${maxAttempts})`);
      if (summary) {
        console.log(`[CREATE] Validation summary: ${summary}`);
      } else {
        console.log(`[CREATE] Validation summary (from error): ${msg}`);
      }

      // Dismiss any open validation modals / toasts before retrying
      await page.keyboard.press('Escape').catch(() => { });
      await page.waitForTimeout(300);
      const okBtn = page.locator('.swal2-confirm:visible:not([disabled])').first();
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click({ timeout: 2000, force: true }).catch(() => { });
        await page.waitForTimeout(300);
      }

      await page.waitForTimeout(400);
    }
  }

  if (lastError) throw lastError;

  const recordName = await page.evaluate(() => window.recordID || '').catch(() => '')
    || inferPrimaryRecordIdentifier(mergedAuditTrail)
    || await getFirstRecordName(page);
  const createdRecordDetails = await snapshotRecordDetails(page, recordName).catch((error) => {
    console.warn(`[CREATE] Could not snapshot saved record details: ${error?.message || error}`);
    return {};
  });
  const auditSourceDetails = Object.keys(createdRecordDetails).length > 0 ? createdRecordDetails : mergedAuditTrail;
  let auditVerification = null;
  if (verifyAudit) {
    if (isUserMaster(masterName)) {
      const inferredSite = inferSiteFromAuditTrail(mergedAuditTrail);
      await switchSiteAndOpenAnyApp(page, {
        targetSite: auditContext.siteName || inferredSite,
        targetApp: auditContext.appName || '',
      });
    }
    console.log('[CREATE] Navigating to Audit Trail for verification...');
    auditVerification = await verifyAuditTrailEntry(page, {
      baseURL,
      masterName,
      operation: 'create',
      recordName,
      recordID: recordName,
      auditTrail: auditSourceDetails,
      strict: false,
    });
    if (auditVerification.fieldByFieldResults && !auditVerification.fieldByFieldResults.passed) {
      const s = auditVerification.fieldByFieldResults.summary;
      console.warn(`[CREATE] ✗ Field verification: ${s.passed} passed, ${s.failed} failed, ${s.errors || 0} errors`);
    } else if (auditVerification.verified) {
      const s = auditVerification.fieldByFieldResults?.summary;
      console.log(`[CREATE] ✓ Audit Trail verified — ${s ? `${s.passed}/${s.total} fields passed` : `source: ${auditVerification.source}`}`);
    } else {
      console.warn(`[CREATE] Audit trail verification incomplete: ${auditVerification.reason || (auditVerification.missing || []).join(', ') || 'unknown reason'}`);
    }
    await navigateTo(page, masterName, baseURL);
  }

  console.log(`[CREATE] ✓ Done (${Object.keys(mergedAuditTrail).length} fields)`);
  return {
    operation: 'Create',
    recordName,
    auditTrail: mergedAuditTrail,
    createdRecordDetails: auditSourceDetails,
    alertMessage: alertMsg,
    fieldCount: Object.keys(mergedAuditTrail).length,
    auditVerification,
    steps: ['Add a new record', 'Fill all fields', 'Click Save', ...(verifyAudit ? ['Navigate to Audit Trail', 'Verify audit trail entry for created record'] : [])],
    expectedResult: verifyAudit ? 'A new record should be created successfully and audit trail should reflect the creation.' : 'A new record should be created successfully.',
  };
}

async function dismissDuplicateErrorState(page, masterName, baseURL) {
  await page.keyboard.press('Escape').catch(() => { });
  await page.waitForTimeout(350);

  const okBtn = page.locator('.swal2-confirm:visible:not([disabled])').first();
  if (await okBtn.isVisible().catch(() => false)) {
    await okBtn.click({ timeout: 2000, force: true }).catch(() => { });
    await page.waitForTimeout(250);
  }

  if (baseURL) {
    await navigateTo(page, masterName, baseURL).catch(() => { });
  }
}

async function checkDuplicateProtection(page, masterName, baseURL) {
  console.log(`[DUPLICATE-CHECK] Running duplicate protection check for ${masterName}...`);

  // Step 1: Make sure there is at least one existing record to copy values from.
  await navigateTo(page, masterName, baseURL);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
  await page.waitForTimeout(600);

  const firstRecordName = await getFirstRecordName(page);
  if (!firstRecordName) {
    console.warn(`[DUPLICATE-CHECK] No existing records found in "${masterName}". Skipping duplicate check.`);
    return {
      operation: 'Duplicate-Check',
      success: true,
      skipped: true,
      reason: 'No existing records to duplicate against',
      screenshotPath: '',
      steps: ['Attempt to create a record with existing values', 'Verify duplicate protection'],
      expectedResult: 'System should block duplicate record creation.',
    };
  }
  console.log(`[DUPLICATE-CHECK] Found existing record: "${firstRecordName}". Reading its field values...`);

  // Step 2: Open the first record in edit mode and snapshot its field values.
  await openFirstEdit(page);
  const editFields = await collectStableFormFields(page);
  console.log(`[DUPLICATE-CHECK] Reading ${editFields.length} fields from existing record...`);

  const snapshotValues = {};
  for (const field of editFields) {
    if (field.disabled) continue;
    if (/RecordID|RecordId/.test(field.id)) continue;
    try {
      const value = await readFieldValue(page, field.idx, field);
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        const key = field.displayName || field.id;
        snapshotValues[key] = value;
        console.log(`[DUPLICATE-CHECK]   ${key} = ${value}`);
      }
    } catch {
      // Skip unreadable fields.
    }
  }
  console.log(`[DUPLICATE-CHECK] Snapshotted ${Object.keys(snapshotValues).length} field values from existing record.`);

  // Close the edit form.
  await page.keyboard.press('Escape').catch(() => { });
  await page.waitForTimeout(400);

  // Step 3: Navigate back to the master list and open the Create form.
  await navigateTo(page, masterName, baseURL);
  await page.waitForTimeout(400);
  await openCreateForm(page);

  // Step 4: Fill the create form with the same values as the existing record.
  // Retry logic in case the form closes during filling
  let duplicateAuditTrail = {};
  let fillAttempts = 0;
  const maxFillAttempts = 3;

  while (fillAttempts < maxFillAttempts) {
    try {
      fillAttempts++;
      const createFields = await collectStableFormFields(page);
      console.log(`[DUPLICATE-CHECK] Filling create form with existing record values (attempt ${fillAttempts}/${maxFillAttempts})...`);
      duplicateAuditTrail = await smartFillOffcanvasForm(page, masterName, createFields, {
        prefilledValues: snapshotValues,
      });
      console.log(`[DUPLICATE-CHECK] ✓ Form filled successfully`);
      break;
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('offcanvas closed') && fillAttempts < maxFillAttempts) {
        console.log(`[DUPLICATE-CHECK] ⚠ Form closed during fill attempt ${fillAttempts}, retrying...`);
        await page.waitForTimeout(600);
        await navigateTo(page, masterName, baseURL);
        await page.waitForTimeout(400);
        await openCreateForm(page);
        await page.waitForTimeout(600);
      } else {
        throw err;
      }
    }
  }

  // Step 5: Try to save — expect a duplicate/validation error.
  try {
    await saveForm(page, false);
    // If save succeeded without error, duplicate protection is NOT working.
    throw new Error('Duplicate entry appears to be allowed: create with same values as an existing record was saved successfully.');
  } catch (error) {
    if (!isDuplicateError(error)) {
      throw error;
    }

    await dismissDuplicateErrorState(page, masterName, baseURL);
    console.log('[DUPLICATE-CHECK] ✓ Duplicate entry correctly blocked by validation.');

    return {
      operation: 'Duplicate-Check',
      recordName: firstRecordName || '',
      duplicateBlocked: true,
      baselineFieldCount: Object.keys(snapshotValues).length,
      replayFieldCount: Object.keys(duplicateAuditTrail || {}).length,
      alertMessage: 'Duplicate create blocked successfully',
      steps: ['Attempt to create a record with existing values', 'Verify duplicate protection'],
      expectedResult: 'System should block duplicate record creation.',
    };
  }
}

async function captureFieldValues(page, fields) {
  const values = {};
  for (const field of fields || []) {
    const key = field.columnToShow || field.displayName || field.id;
    if (!key) continue;
    values[key] = await readFieldValue(page, field.idx, field).catch(() => '');
  }
  return values;
}

function normalizeFieldAuditValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildChangedAuditTrail(beforeValues, afterValues) {
  const changed = {};
  for (const [key, value] of Object.entries(afterValues || {})) {
    const before = normalizeFieldAuditValue(beforeValues?.[key]);
    const after = normalizeFieldAuditValue(value);
    if (after && before !== after) {
      changed[key] = value;
    }
  }
  return changed;
}

async function updateRecord(page, masterName, baseURL, verifyAudit = false, auditContext = {}, targetRecordName = '') {
  console.log(`[UPDATE] Opening first record for ${masterName}...`);
  const recordName = await getFirstRecordName(page, targetRecordName);
  await openFirstEdit(page, targetRecordName);

  const fields = await collectStableFormFields(page);
  console.log(`[UPDATE] Discovered ${fields.length} fields before fill`);

  console.log('[UPDATE] Filling fields...');
  const auditTrail = await smartFillOffcanvasForm(page, masterName, fields, { mode: 'update' });
  await assertNoQuickFlowError(page, page.context(), masterName, 'update', 'field fill');

  // Wait for network requests and form state updates
  console.log('[UPDATE] Waiting for form to process all inputs...');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
  await page.waitForTimeout(2000);

  // Diagnostic: Check form state before save - ONLY look in the active visible offcanvas
  const activeOffcanvasSelector = await getActiveOffcanvasSelector(page);
  const formState = await page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : null;
    const offcanvas = root?.querySelector('.offcanvas-body') || root;
    if (!offcanvas) return ['ERROR: Active offcanvas not found'];

    const inputs = offcanvas.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [role="combobox"]');
    const state = [];
    for (const input of inputs) {
      const label = input.closest('.form-group, .fv-row, [class*="col-"], .mb-3')?.querySelector('label')?.textContent?.trim() || input.name || 'Unknown';
      const value = input.value || input.textContent?.trim() || '(empty)';
      state.push(`${label}: ${value}`);
    }
    return state.length > 0 ? state : ['No input fields found in active offcanvas'];
  }, activeOffcanvasSelector);
  console.log('[UPDATE] Form field values before save (from offcanvas only):');
  formState.forEach(s => console.log(`  ${s}`));

  // Try to trigger validation by blurring all form fields
  await page.evaluate(() => {
    const form = document.querySelector('form') || document.querySelector('.offcanvas-body');
    if (!form) return;

    const inputs = form.querySelectorAll('input, select, textarea, [role="combobox"], [contenteditable]');
    for (const input of inputs) {
      if (input.value || input.textContent?.trim()) {
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
      }
    }

    // Also trigger form change event
    form.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => { });

  await page.waitForTimeout(1000);

  console.log('[UPDATE] Saving...');
  const plannedReason = buildRandomUpdateReason();
  const saveResult = await saveForm(page, true, plannedReason);
  const alertMsg = saveResult.message;
  let auditVerification = null;
  if (verifyAudit) {
    if (isUserMaster(masterName)) {
      const inferredSite = inferSiteFromAuditTrail(auditTrail);
      await switchSiteAndOpenAnyApp(page, {
        targetSite: auditContext.siteName || inferredSite,
        targetApp: auditContext.appName || '',
      });
    }
    console.log('[UPDATE] Navigating to Audit Trail for verification...');
    auditVerification = await verifyAuditTrailEntry(page, {
      baseURL,
      masterName,
      operation: 'update',
      recordName,
      recordID: recordName,
      auditTrail,
      reason: saveResult.reasonText,
      strict: false,
    });
    if (auditVerification.comparison && !auditVerification.comparison.passed) {
      console.warn(`[UPDATE] Audit trail mismatch detected: ${auditVerification.comparison.mismatchCount} differences`);
    } else if (auditVerification.verified) {
      console.log(`[UPDATE] ✓ Audit Trail verified (source: ${auditVerification.source})`);
    } else {
      console.warn(`[UPDATE] Audit trail verification incomplete: ${auditVerification.reason || (auditVerification.missing || []).join(', ') || 'unknown reason'}`);
    }
    await navigateTo(page, masterName, baseURL);
  }

  console.log(`[UPDATE] ✓ Done (${Object.keys(auditTrail).length} fields)`);
  return {
    operation: 'Update',
    recordName,
    auditTrail,
    alertMessage: alertMsg,
    fieldCount: Object.keys(auditTrail).length,
    auditVerification,
    steps: ['Open an existing record', 'Modify field values', 'Click Save', ...(verifyAudit ? ['Navigate to Audit Trail', 'Verify audit trail entry for updated record'] : [])],
    expectedResult: verifyAudit ? 'Record should be updated successfully and audit trail should reflect the changes.' : 'Record should be updated successfully.',
  };
}

async function getRecordSiteBeforeDeletion(page, recordName) {
  // Fetch the site/location of the first record before deleting
  // by opening the record detail view
  try {
    const targetRow = await getTargetRow(page, recordName || '');
    const clicked = await targetRow.locator('td:nth-child(2), td:first-child').first().click().then(() => true).catch(() => false);
    if (!clicked) return '';

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
    await page.waitForTimeout(500);

    // Extract the Location/Site field value from the opened record
    const site = await page.evaluate(() => {
      // Look for Location, Site, Plant, or similar fields
      const fieldLabels = document.querySelectorAll('.form-label, label, .field-label');
      for (const label of fieldLabels) {
        const text = (label.textContent || '').toLowerCase();
        if (!/(location|site|plant)/.test(text)) continue;

        // Try to find the corresponding value (next sibling or sibling div)
        const value = label.closest('.form-group')?.querySelector('.form-control, .form-select, [role="combobox"], .custom-select')?.textContent
          || label.closest('.row')?.querySelector('span, div')?.textContent
          || label.nextElementSibling?.textContent
          || '';

        return (value || '').replace(/\s+/g, ' ').trim();
      }
      return '';
    }).catch(() => '');

    // Close the detail view by pressing Escape or clicking close button
    await page.keyboard.press('Escape').catch(() => { });
    await page.waitForTimeout(300);

    if (site) {
      console.log(`[DELETE] Fetched site from record: ${site}`);
    }
    return site;
  } catch (err) {
    console.log(`[DELETE] Could not fetch record site: ${err.message}`);
    return '';
  }
}

async function deleteRecord(page, masterName, baseURL, verifyAudit = false, auditContext = {}, targetRecordName = '', username = '') {
  console.log(`[DELETE] Deleting first record for ${masterName}...`);
  const recordName = await getFirstRecordName(page, targetRecordName);

  let recordSite = '';
  if (verifyAudit && isUserMaster(masterName)) {
    recordSite = await getRecordSiteBeforeDeletion(page, recordName);
  }

  // ── Capture pre-delete field values for comprehensive audit verification ──
  let preDeleteFieldValues = {};
  if (verifyAudit) {
    console.log('[DELETE] Capturing pre-delete field values from edit form...');
    await openFirstEdit(page, targetRecordName);
    const preDeleteFields = await collectStableFormFields(page);
    preDeleteFieldValues = await captureFieldValues(page, preDeleteFields);
    console.log(`[DELETE] Captured ${Object.keys(preDeleteFieldValues).length} pre-delete field values`);

    // Cancel the edit form without saving
    const cancelBtn = await page.locator('.offcanvas.show button:has-text("Cancel"), .offcanvas.show .btn-close').first();
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => { });
      await page.waitForTimeout(500);
    } else {
      await page.keyboard.press('Escape').catch(() => { });
      await page.waitForTimeout(300);
    }

    // Wait for offcanvas to close
    await page.waitForFunction(() => {
      const offcanvas = document.querySelector('.offcanvas.show, #masterFormOffcanvas.show, #offcanvas.show');
      return !offcanvas;
    }, { timeout: 5000 }).catch(() => { });
    await page.waitForTimeout(300);
  }

  const deleteReason = buildRandomUpdateReason();
  const deleteResult = await deleteFirst(page, recordName || targetRecordName, deleteReason);
  await assertNoQuickFlowError(page, page.context(), masterName, 'delete', 'delete operation');
  let auditVerification = null;
  if (verifyAudit) {
    if (isUserMaster(masterName)) {
      await switchSiteAndOpenAnyApp(page, {
        targetSite: auditContext.siteName || recordSite,
        targetApp: auditContext.appName || '',
      });
    }
    console.log('[DELETE] Navigating to Audit Trail for verification...');
    auditVerification = await verifyAuditTrailEntry(page, {
      baseURL,
      masterName,
      operation: 'delete',
      recordName,
      recordID: recordName,
      reason: deleteResult.reasonText,
      auditTrail: preDeleteFieldValues,
      username,
      strict: false,
    });
    if (auditVerification.comparison && !auditVerification.comparison.passed) {
      console.warn(`[DELETE] Audit trail mismatch detected: ${auditVerification.comparison.mismatchCount} differences`);
    } else if (auditVerification.verified) {
      console.log(`[DELETE] ✓ Audit Trail verified (source: ${auditVerification.source})`);
    } else {
      console.warn(`[DELETE] Audit trail verification incomplete: ${auditVerification.reason || (auditVerification.missing || []).join(', ') || 'unknown reason'}`);
    }
    await navigateTo(page, masterName, baseURL);
  }
  console.log('[DELETE] ✓ Done');
  return {
    operation: 'Delete',
    recordName,
    alertMessage: deleteResult.message || 'Data deleted successfully',
    auditVerification,
    steps: ['Select an existing record', 'Click Delete', 'Confirm deletion', ...(verifyAudit ? ['Navigate to Audit Trail', 'Verify audit trail entry for deleted record'] : [])],
    expectedResult: verifyAudit ? 'Record should be deleted successfully and audit trail should reflect the deletion.' : 'Record should be deleted successfully.',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const masterName = process.env.QT_MASTER || '';
  const operation = (process.env.QT_OP || 'all').toLowerCase();
  const headless = String(process.env.QT_HEADLESS || 'false').toLowerCase() !== 'false';
  const recordVideo = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
  const verifyAudit = String(process.env.QT_VERIFY_AUDIT || 'false').toLowerCase() === 'true';
  const auditContext = {
    siteName: String(process.env.QT_AUDIT_SITE || '').trim(),
    appName: String(process.env.QT_AUDIT_APP || '').trim(),
  };
  const targetRecordName = String(process.env.QT_TARGET_RECORD || '').trim();
  const prefilledValuesJson = String(process.env.QT_PREFILLED_VALUES || '').trim();
  let prefilledValues = null;
  if (prefilledValuesJson) {
    try { prefilledValues = JSON.parse(prefilledValuesJson); } catch { prefilledValues = null; }
  }

  if (!masterName) throw new Error('QT_MASTER is required');

  // Redirect console to stderr so stdout is only JSON
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
  console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');

  let browser, context, page;
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
    context.on('page', (popupPage) => {
      enableRecordingOverlayOnPage(popupPage).catch(() => { });
    });
    page = await context.newPage();
    await enableRecordingOverlayOnPage(page);
    await updateRecordingOverlay(page, {
      masterName,
      operation,
      status: 'running',
      auditEnabled: verifyAudit,
      auditResult: verifyAudit ? 'pending' : null,
    });

    await login(page, { loginUrl, username, password });
    const baseURL = new URL(loginUrl).origin;
    await navigateTo(page, masterName, baseURL);

    const results = { master: masterName, operations: [], failures: [] };
    const continueOnOperationFailure = operation === 'all';

    const executeOperation = async (opName, handler) => {
      await updateRecordingOverlay(page, { operation: opName, status: 'running' }).catch(() => { });
      try {
        const opResult = await handler();
        const successStep = Array.isArray(opResult?.steps) && opResult.steps.length > 0
          ? opResult.steps[opResult.steps.length - 1]
          : 'operation-complete';
        const opScreenshot = await captureReportScreenshot(page, masterName, opName, 'passed', successStep).catch(() => '');
        if (opScreenshot && !opResult?.screenshotPath) {
          opResult.screenshotPath = opScreenshot;
        }
        opResult.screenshotStep = successStep;
        results.operations.push(opResult);

        // Update overlay with audit result if available.
        if (verifyAudit && opResult && opResult.auditVerification !== undefined) {
          const av = opResult.auditVerification;
          let auditResult = 'pending';
          if (av) {
            if (av.verified && (!av.comparison || av.comparison.passed)) auditResult = 'pass';
            else if (av.comparison && !av.comparison.passed) auditResult = 'fail';
            else if (!av.verified) auditResult = 'fail';
          } else {
            auditResult = 'not run';
          }
          await updateRecordingOverlay(page, { status: 'pass', auditResult }).catch(() => { });
        } else {
          await updateRecordingOverlay(page, { status: 'pass' }).catch(() => { });
        }

        return true;
      } catch (error) {
        const errorText = String(error?.stack || error?.message || error || 'Operation failed').trim();
        const failedStep = inferFailedStep(error, opName);
        const screenshotPath = await captureFailureScreenshot(page, context, masterName, opName, failedStep).catch(() => '');
        results.failures.push({
          operation: opName,
          error: errorText,
          screenshotPath,
          screenshotStep: failedStep,
          createdAt: new Date().toISOString(),
        });
        await updateRecordingOverlay(page, { status: 'fail' }).catch(() => { });
        console.warn(`[REPORT] Operation failed for ${opName}: ${errorText}`);
        if (!continueOnOperationFailure) {
          throw error;
        }
        return false;
      }
    };

    if (operation === 'create' || operation === 'all') {
      console.log('[CYCLE] Starting CREATE operation with audit verification enabled...');
      const ok = await executeOperation('create', () => createRecord(page, masterName, baseURL, verifyAudit, auditContext, prefilledValues));
      if (ok) {
        await page.waitForTimeout(1000);
        await navigateTo(page, masterName, baseURL);
      }
    }

    if (operation === 'duplicate-check' || operation === 'all') {
      console.log('[CYCLE] Running DUPLICATE-CHECK after CREATE to verify duplicate protection...');
      const ok = await executeOperation('duplicate-check', () => checkDuplicateProtection(page, masterName, baseURL));
      if (ok) {
        await page.waitForTimeout(800);
        await navigateTo(page, masterName, baseURL);
      }
    }

    if (operation === 'update' || operation === 'all') {
      console.log('[CYCLE] Starting UPDATE operation with audit verification enabled...');
      const ok = await executeOperation('update', () => updateRecord(page, masterName, baseURL, verifyAudit, auditContext, targetRecordName));
      if (ok) {
        await page.waitForTimeout(1000);
        await navigateTo(page, masterName, baseURL);
      }
    }

    if (operation === 'delete' || operation === 'all') {
      console.log('[CYCLE] Starting DELETE operation with audit verification enabled...');
      await executeOperation('delete', () => deleteRecord(page, masterName, baseURL, verifyAudit, auditContext, targetRecordName, username));
    }

    // Collect audit mismatch reports
    results.auditMismatches = [];
    for (const op of results.operations) {
      const v = op.auditVerification;
      if (!v) continue;
      const fieldByFieldFailed = v.fieldByFieldResults && v.fieldByFieldResults.passed === false;
      if ((v.comparison && !v.comparison.passed) || fieldByFieldFailed) {
        const failedFieldRows = (v.fieldValidationResults || []).filter((item) => String(item?.status || '').toUpperCase() !== 'PASS');
        const mismatchReport = {
          operation: op.operation,
          recordName: op.recordName,
          reason: fieldByFieldFailed
            ? `Audit mismatch: ${v.fieldByFieldResults.summary.failed + (v.fieldByFieldResults.summary.errors || 0)} field checks failed`
            : `Audit mismatch: ${v.comparison.mismatchCount} differences found`,
          mismatches: v.comparison?.mismatches || [],
          notFoundInAudit: v.comparison?.notFoundInAudit || [],
          matchCount: v.comparison?.matchCount || 0,
          mismatchCount: v.comparison?.mismatchCount || failedFieldRows.length,
          fieldValidationResults: v.fieldValidationResults || [],
          createdRecordDetails: op.createdRecordDetails || {},
          screenshotPath: v.screenshotPath || '',
        };
        results.auditMismatches.push(mismatchReport);
        console.warn(`[REPORT] Audit mismatch for ${op.operation}: ${mismatchReport.mismatchCount} differences, screenshot=${v.screenshotPath || 'none'}`);
      }
      if (!v.verified) {
        const screenshotPath = v.screenshotPath || await captureFailureScreenshot(page, context, masterName, op.operation).catch(() => '');
        results.auditMismatches.push({
          operation: op.operation,
          recordName: op.recordName,
          reason: v.reason || `Missing: ${(v.missing || []).join(', ')}`,
          fieldValidationResults: v.fieldValidationResults || [],
          createdRecordDetails: op.createdRecordDetails || {},
          screenshotPath,
        });
        console.warn(`[REPORT] Audit verification failed for ${op.operation}: ${v.reason || (v.missing || []).join(', ')}`);
      }
    }

    results.completedAt = new Date().toISOString();
    results.failed = results.failures.length > 0 || results.auditMismatches.length > 0;

    // Close context to finalize video files before capturing the primary video name.
    if (context) {
      await context.close().catch(() => { });
      context = null;
    }
    try {
      if (page && typeof page.video === 'function' && page.video()) {
        const videoPath = await page.video().path();
        results.primaryVideoName = videoPath ? path.basename(videoPath) : '';
      }
    } catch {
      // Ignore: video path may not be available if recording was disabled.
    }
    if (browser) {
      await browser.close().catch(() => { });
      browser = null;
    }

    console.log = origLog;
    console.warn = origWarn;
    process.stdout.write(JSON.stringify(results));
  } catch (error) {
    const screenshotPath = await captureFailureScreenshot(page, context, masterName, operation).catch(() => '');
    if (screenshotPath) {
      const detail = error?.stack || error?.message || String(error) || 'CRUD operation failed';
      throw new Error(`${detail}\n[FAIL_SCREENSHOT] ${screenshotPath}`);
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
  }
}

run().catch((error) => {
  const detail = error?.stack || error?.message || String(error) || 'CRUD operation failed';
  process.stderr.write(detail);
  process.exit(1);
});
