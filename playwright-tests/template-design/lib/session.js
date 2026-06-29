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
  headless: boolEnv(process.env.QT_HEADLESS, false),
};

const BASE_URL = new URL(CFG.loginUrl).origin;

function log(msg) {
  process.stderr.write(`[TD] ${msg}\n`);
}

async function launch() {
  const browser = await chromium.launch({ headless: CFG.headless });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  return { browser, context, page };
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

module.exports = { CFG, BASE_URL, log, launch, login };
