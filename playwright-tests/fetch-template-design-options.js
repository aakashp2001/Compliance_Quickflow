'use strict';

const { chromium } = require('@playwright/test');

function boolEnv(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true';
}

const CFG = {
  loginUrl: process.env.QT_URL || 'https://ipdev.quickflow.in/login',
  username: process.env.QT_USER || 'dhruvi',
  password: process.env.QT_PASS || 'Welcome@123',
  headless: boolEnv(process.env.QT_HEADLESS, true),
};

const BASE_URL = new URL(CFG.loginUrl).origin;

function log(msg) {
  process.stderr.write(`[TD-OPTIONS] ${msg}\n`);
}

async function login(page) {
  await page.goto(CFG.loginUrl, { waitUntil: 'load', timeout: 30000 });
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
}

async function navigate(page) {
  await page.goto(`${BASE_URL}/Design-Template`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#MainContent_ddlAppList', { timeout: 20000 });
  await page.waitForSelector('#MainContent_ddlTemplateSheet', { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function waitForAppOptions(page, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const apps = await getAppOptions(page);
    if (apps.length > 0) return apps;
    await page.waitForTimeout(800);
  }
  return [];
}

async function waitForTemplateOptions(page, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const templates = await getTemplateOptions(page);
    if (templates.length > 0) return templates;
    await page.waitForTimeout(600);
  }
  return [];
}

async function getAppOptions(page) {
  return page.evaluate(() => {
    const select = document.getElementById('MainContent_ddlAppList');
    if (!select) return [];
    return Array.from(select.options || [])
      .map((opt) => ({
        value: String(opt.value || ''),
        label: String(opt.textContent || opt.text || '').trim(),
        disabled: !!opt.disabled,
      }))
      .filter((opt) => opt.value && opt.label && !opt.disabled && !/^select\b/i.test(opt.label));
  }).catch(() => []);
}

async function selectApp(page, appValue) {
  await page.evaluate((appValue) => {
    const select = document.getElementById('MainContent_ddlAppList');
    if (!select) return;
    select.value = appValue;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.$) {
      try { window.$(select).trigger('change.select2'); } catch (_) { /* ignore */ }
    }
  }, appValue);
  await page.waitForTimeout(1400);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function getTemplateOptions(page) {
  return page.evaluate(() => {
    const select = document.getElementById('MainContent_ddlTemplateSheet');
    if (!select) return [];
    return Array.from(select.options || []).map((opt) => ({
      value: String(opt.value || ''),
      label: String(opt.textContent || opt.text || '').trim(),
      disabled: !!opt.disabled,
      publish: String(opt.getAttribute('data-publish') || ''),
      group: String(opt.getAttribute('data-group') || ''),
    })).filter((opt) => opt.value && opt.label);
  }).catch(() => []);
}

function mapTemplateHierarchy(rawOptions) {
  const templates = [];
  let currentTemplate = null;

  for (const opt of rawOptions) {
    const parts = String(opt.value || '').split('###');
    const childPart = parts[1] || '';
    const objectId = parts[2] || '';
    const isParent = childPart === '0';

    if (isParent) {
      currentTemplate = {
        value: opt.value,
        label: opt.label,
        objectId,
        publish: opt.publish,
        subTemplates: [],
      };
      templates.push(currentTemplate);
      continue;
    }

    if (!opt.disabled && currentTemplate) {
      currentTemplate.subTemplates.push({
        value: opt.value,
        label: opt.label,
        childId: childPart,
        objectId,
      });
    }
  }

  return templates.filter((tpl) => tpl.label);
}

async function main() {
  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({ headless: CFG.headless });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    log('Logging in');
    await login(page);
    log('Opening Design Template');
    await navigate(page);

    const apps = await waitForAppOptions(page, 25000);
    log(`Found ${apps.length} app option(s)`);

    const result = [];
    for (const app of apps) {
      log(`Reading templates for app: ${app.label}`);
      await selectApp(page, app.value);
      const templateOptions = await waitForTemplateOptions(page, 15000);
      const templates = mapTemplateHierarchy(templateOptions);
      result.push({
        appId: app.value,
        appName: app.label,
        templates,
      });
    }

    process.stdout.write(JSON.stringify({ status: 'completed', apps: result }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ status: 'failed', error: String(err?.message || err) }));
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main();