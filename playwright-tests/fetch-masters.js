'use strict';

const { chromium } = require('@playwright/test');
const { discoverMasters } = require('./helpers/discoverMasters');
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
};

const dbg = (...args) => process.stderr.write('[fetch-masters] ' + args.join(' ') + '\n');

async function login(page, { loginUrl, username, password }) {
  const targetLoginUrl = loginUrl || 'https://ipdev.quickflow.in/login';

  async function gotoWithRetry(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('load', { timeout: 12000 }).catch(() => { });
        return true;
      } catch (errDom) {
        dbg(`goto(domcontentloaded) attempt ${attempt} failed:`, errDom?.message || String(errDom));
        try {
          await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
          return true;
        } catch (errCommit) {
          dbg(`goto(commit) attempt ${attempt} failed:`, errCommit?.message || String(errCommit));
          await page.waitForTimeout(1000);
        }
      }
    }
    return false;
  }

  const loaded = await gotoWithRetry(targetLoginUrl);
  if (!loaded) {
    throw new Error(`Unable to open login page: ${targetLoginUrl}`);
  }

  let usernameVisible = await page.locator(SEL.username).isVisible().catch(() => false);

  // Sometimes the first navigation lands on an already-authenticated page.
  if (!usernameVisible) {
    const hasHomeUrl = /\/home/i.test(page.url());
    const navCount = await page.locator('a[href^="/"]').count().catch(() => 0);
    const unlockVisible = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);

    if (hasHomeUrl || unlockVisible || navCount > 10) {
      dbg('Login form not visible; existing authenticated session detected.');
      if (unlockVisible) {
        dbg('Unlock screen detected, clicking unlock...');
        await page.click(SEL.unlockBtn).catch(() => { });
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2000);
      dbg('Login complete (session reused). Current URL:', page.url());
      return;
    }

    // Retry once with full load wait in case login form was still bootstrapping.
    dbg('Login form not found on first load; retrying login page once...');
    await page.goto(targetLoginUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1000);
    usernameVisible = await page.locator(SEL.username).isVisible().catch(() => false);
  }

  if (!usernameVisible) {
    throw new Error('Login form did not appear (#txtUsername not visible).');
  }

  await page.waitForTimeout(500);

  await page.fill(SEL.username, username);
  await page.fill(SEL.password, password);

  const loginBtn = page.locator(SEL.loginBtn);
  let clicked = false;

  try {
    await loginBtn.click({ timeout: 3000 });
    clicked = true;
  } catch (err) {
    dbg('Normal login click failed, trying force click...', err?.message || String(err));
  }

  if (!clicked) {
    try {
      await loginBtn.click({ timeout: 3000, force: true });
      clicked = true;
    } catch (err) {
      dbg('Force click failed, trying JS click...', err?.message || String(err));
    }
  }

  if (!clicked) {
    clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }, SEL.loginBtn).catch(() => false);
  }

  if (!clicked) {
    dbg('All click methods failed, trying Enter key on password field...');
    await page.locator(SEL.password).press('Enter').catch(() => { });
  }

  await page.waitForTimeout(1500);

  const unlockVisible = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
  if (unlockVisible) {
    dbg('Unlock screen detected, clicking unlock...');
    await page.click(SEL.unlockBtn);
    await page.waitForTimeout(1000);
  }

  // Wait for login form to disappear (username gone = authenticated)
  await page.locator(SEL.username).waitFor({ state: 'hidden', timeout: 30000 }).catch(() => { });
  // Extra wait for SPA to fully render nav menu
  await page.waitForTimeout(3000);
  dbg('Login complete. Current URL:', page.url());
}

async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const headless = String(process.env.QT_HEADLESS || 'true').toLowerCase() !== 'false';
  const recordVideo = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
  const fetchFieldsWithMasters = String(process.env.QT_FETCH_FIELDS_WITH_MASTERS || 'true').toLowerCase() !== 'false';

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
      operation: 'fetch-masters',
      status: 'running',
      step: 'login',
    });

    await login(page, { loginUrl, username, password });
    const baseURL = new URL(page.url()).origin;
    dbg('baseURL:', baseURL);
    await updateArtifactOverlay(page, {
      operation: 'fetch-masters',
      status: 'running',
      step: 'discover-masters',
    });

    // Wait for nav links to appear before collecting
    await page.waitForSelector('a[href^="/"]', { timeout: 15000 }).catch(() => {
      dbg('No a[href^="/"] found within 15s — proceeding anyway');
    });

    // Collect all nav hrefs visible right now for debugging
    const allHrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href'))
    );
    dbg(`Nav links found (${allHrefs.length}):`, allHrefs.join(', '));

    // Route console.log to stderr so stdout stays clean for JSON output
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
    console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');

    let masters = [];
    try {
      masters = await discoverMasters(page, baseURL, [], [], { includeFields: fetchFieldsWithMasters });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    dbg(`Discovery complete. Masters found: ${masters.length}`);
    await updateArtifactOverlay(page, {
      operation: 'fetch-masters',
      status: 'completed',
      step: 'done',
    });

    const payload = {
      baseURL,
      fetchedAt: new Date().toISOString(),
      masters,
    };

    process.stdout.write(JSON.stringify(payload));
  } finally {
    if (context) await context.close().catch(() => { });
    if (browser) await browser.close().catch(() => { });
  }
}

run().catch((error) => {
  process.stderr.write(error?.message || 'Failed to fetch masters');
  process.exit(1);
});
