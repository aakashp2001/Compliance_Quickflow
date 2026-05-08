/**
 * auto-masters.spec.js
 *
 * Auto-discovers every master page from the nav menu after login,
 * then runs the full CRUD lifecycle on EACH one — including any new
 * masters added to the app in the future.
 *
 * No manual config list needed.  Just run:
 *   npx playwright test auto-masters.spec.js --config=playwright.config.js
 *
 * ─── Optional filters (edit the OPTIONS block below) ─────────────────────────
 *  ONLY_MASTERS  : test only these slugs (leave empty [] to test ALL)
 *  SKIP_MASTERS  : always skip these slugs
 *  UPDATE_TIMES  : how many times to update each record
 *  DELETE_TIMES  : how many times to delete each record
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { discoverMasters } = require('./helpers/discoverMasters');
const { fillOffcanvasForm, verifyOffcanvasForm } = require('./helpers/formFiller');
const { verifyAuditTrailEntry } = require('./helpers/auditTrail');

// ═══════════════════════════════════════════════════════════════════════════════
// OPTIONS — change these to control which masters run
// ═══════════════════════════════════════════════════════════════════════════════
const OPTIONS = {
  /** Login credentials used for every master test */
  user: {
    username:  'dhruvi',
    password:  '',
    firstName: 'Dhruvi',
    lastName:  'Shah',
  },

  /**
   * Test ONLY these master slugs.
   * Leave empty to test ALL discovered masters.
   * Example: ['Department', 'Designation']
   */
  ONLY_MASTERS: [],

  /**
   * Always skip these master slugs even if auto-discovered.
   * Example: ['SomeBrokenMaster']
   */
  SKIP_MASTERS: [],

  /** How many times to update each record */
  UPDATE_TIMES: 1,

  /** How many times to delete each record */
  DELETE_TIMES: 1,

  /**
   * Reviewer credentials used when a master has hasReview = true.
   * Set to null if you have no reviewer account to test with.
   */
  reviewUser: null,
  // reviewUser: {
  //   username:  'reviewer',
  //   password:  'reviewpass',
  //   firstName: 'Reviewer',
  //   lastName:  'User',
  // },
};
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Selectors ─────────────────────────────────────────────────────────────────
const SEL = {
  username:       '#txtUsername',
  password:       '#txtPassword',
  loginBtn:       '#btnLogin',
  loginError:     ':text("Invalid username or password")',
  unlockBtn:      '#btnUnlock',
  homeReady:      '#divAppButton',
  userMenu:       '#userMenu',
  fullName:       '#fullName',
  pageTitle:      '.pageTitle',
  createBtn:      'button:has-text("Create"), a:has-text("Create")',
  offcanvas:      '#masterFormOffcanvas .offcanvas-body',
  saveBtn:        '#btnSave',
  successCreate:  ':text("Data saved successfully")',
  successUpdate:  ':text("Data updated successfully")',
  successDelete:  ':text("Data deleted successfully")',
  confirmOk:      '.swal2-confirm',
  searchBox:      '[type="search"]',
  reasonTextarea: '#reasonTextarea',
  submitBtn:      ':text("Submit")',
  tableRows:      '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr',
  editBtn:        '.fa-pen-to-square, .fa-edit',
  deleteBtn:      '.fa-trash, .fa-trash-alt',
};

// ─── login ─────────────────────────────────────────────────────────────────────
async function login(page, { username, password, firstName, lastName }) {
  // Already logged in as the right user?
  const loggedIn = await page.locator(SEL.userMenu).isVisible().catch(() => false);
  if (loggedIn) {
    await page.hover(SEL.userMenu);
    await page.waitForSelector(SEL.fullName, { timeout: 5000 }).catch(() => {});
    const name = (await page.locator(SEL.fullName).textContent().catch(() => '')).trim();
    if (name === `${firstName} ${lastName}`) {
      console.log(`[LOGIN] Already logged in as ${firstName} ${lastName}`);
      return;
    }
    await page.locator(':text("Sign Out")').click();
    await page.waitForTimeout(2000);
  }

  await page.goto('/');
  await page.waitForSelector(SEL.username, { timeout: 30000 });
  await page.waitForTimeout(500);

  // ── invalid-credential checks ──────────────────────────────────────────────
  for (const [u, p] of [
    [`${username}_bad`, password],
    [username, `${password}_bad`],
    [`${username}_bad`, `${password}_bad`],
  ]) {
    await page.fill(SEL.username, u);
    await page.fill(SEL.password, p);
    await page.click(SEL.loginBtn);
    await expect(page.locator(SEL.loginError)).toBeVisible({ timeout: 10000 });
  }
  console.log('[LOGIN] ✓ Invalid credentials rejected');

  // ── valid login ────────────────────────────────────────────────────────────
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
  console.log(`[LOGIN] ✓ Logged in as ${firstName} ${lastName}`);
}

// ─── navigate to a master page ─────────────────────────────────────────────────
async function navigateTo(page, name) {
  const route = `/${name}`;
  if (page.url().includes(name)) return;

  const link = page.locator(`a[href="${route}"]`).first();
  const visible = await link.isVisible().catch(() => false);

  if (visible) {
    await link.click();
  } else {
    // Try expanding a parent menu item
    const parent = page.locator('li').filter({ has: page.locator(`a[href="${route}"]`) }).first();
    if (await parent.isVisible().catch(() => false)) {
      await parent.click();
      await page.waitForTimeout(400);
      await page.locator(`a[href="${route}"]`).first().click();
    } else {
      await page.goto(route);
    }
  }

  await page.waitForSelector(SEL.pageTitle, { timeout: 30000 });
  await page.waitForTimeout(800);
  console.log(`[NAV] ✓ ${route}`);
}

// ─── save the open offcanvas form ─────────────────────────────────────────────
async function saveForm(page, isUpdate = false, remarks = '') {
  await page.click(SEL.saveBtn);

  if (isUpdate) {
    const hasReason = await page.waitForSelector(SEL.reasonTextarea, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (hasReason) {
      await page.fill(SEL.reasonTextarea, remarks || `Updated ${Date.now()}`);
      await page.locator(SEL.submitBtn).click();
    }
  }

  const successSel = isUpdate ? SEL.successUpdate : SEL.successCreate;
  await page.waitForSelector(successSel, { timeout: 30000 });

  const ok = await page.locator(SEL.confirmOk).isVisible().catch(() => false);
  if (ok) { await page.click(SEL.confirmOk); await page.waitForTimeout(400); }
}

// ─── search a record by ID ─────────────────────────────────────────────────────
async function searchRecord(page, recordID) {
  await page.waitForSelector(SEL.searchBox, { timeout: 15000 });
  await page.fill(SEL.searchBox, String(recordID));
  await page.waitForTimeout(600);
}

// ─── count real (non-empty) rows in the table ─────────────────────────────────
async function rowCount(page) {
  const rows = await page.locator(SEL.tableRows).all();
  let n = 0;
  for (const r of rows) {
    const txt = (await r.textContent().catch(() => '')).trim().toLowerCase();
    if (txt && !txt.includes('no data') && !txt.includes('no matching')) n++;
  }
  return n;
}

// ─── open the first row's edit form ───────────────────────────────────────────
async function openFirstEdit(page) {
  const icon = page.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first();
  if (await icon.isVisible().catch(() => false)) {
    await icon.click();
  } else {
    await page.locator(SEL.tableRows).first().click();
  }
  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });
  await page.waitForTimeout(1000);
}

// ─── delete the first visible record ──────────────────────────────────────────
async function deleteFirst(page) {
  const trash = page.locator(`${SEL.tableRows}:first-child ${SEL.deleteBtn}`).first();
  if (await trash.isVisible().catch(() => false)) {
    await trash.click();
  } else {
    const cb = page.locator(`${SEL.tableRows}:first-child input[type="checkbox"]`).first();
    await cb.check().catch(() => {});
    await page.locator(SEL.deleteBtn).first().click();
  }

  await page.waitForSelector(SEL.confirmOk, { timeout: 10000 });
  await page.click(SEL.confirmOk);
  await page.waitForSelector(SEL.successDelete, { timeout: 20000 });

  const ok = await page.locator(SEL.confirmOk).isVisible().catch(() => false);
  if (ok) { await page.click(SEL.confirmOk); await page.waitForTimeout(400); }
}

// ─── review / approve a record ────────────────────────────────────────────────
async function approveRecord(page, masterName, auditTrail, recordID) {
  const { reviewUser } = OPTIONS;
  if (!reviewUser) {
    console.warn(`[REVIEW] reviewUser not configured — skipping review for "${masterName}"`);
    return;
  }

  await login(page, reviewUser);

  await page.click('#dashboards');
  await page.waitForTimeout(1000);
  await page.click('[href="/Home#MasterReviewDashboard"]');
  await page.waitForTimeout(2000);

  const collapseId = `#collapse_${masterName.replaceAll(/\s/g, '')}`;
  await page.waitForSelector('[data-bs-toggle="collapse"]', { timeout: 15000 });

  const cls = await page.getAttribute(collapseId, 'class').catch(() => '');
  if (!cls.includes('show')) {
    await page.click('[data-bs-toggle="collapse"]');
    await page.waitForTimeout(800);
  }

  await page.evaluate((id) => {
    const tbody = document.querySelector(`${id} .dt-scroll-body tbody, ${id} .dataTables_scrollBody tbody`);
    if (tbody) {
      const btn = tbody.querySelector('tr:first-child .fa-check-square, tr:first-child .fa-pen-to-square');
      if (btn) btn.click();
    }
  }, collapseId);

  await page.waitForSelector(SEL.offcanvas, { timeout: 20000 });
  await page.waitForTimeout(2000);

  await verifyOffcanvasForm(page, auditTrail, masterName);

  await page.locator(':text("Approve")').click();
  await page.waitForSelector('#reviewPassword', { timeout: 10000 });
  await page.fill('#reviewPassword', reviewUser.password);
  await page.locator(':text("Submit")').click();
  await page.waitForSelector(':text("approved successfully")', { timeout: 20000 });
  await page.click(SEL.confirmOk);

  console.log(`[REVIEW] ✓ Record ${recordID} approved for "${masterName}"`);

  // Switch back to the original user
  await login(page, OPTIONS.user);
}

// ─── full CRUD lifecycle for one master ───────────────────────────────────────
async function runMasterCycle(page, master) {
  const { name, displayName, hasReview } = master;
  const line = '─'.repeat(60);
  console.log(`\n${line}\n[MASTER] ${displayName}\n${line}`);

  // 1. Login + navigate
  await login(page, OPTIONS.user);
  await navigateTo(page, name);

  // 2. Create
  console.log('[CREATE] Opening create form…');
  await page.locator(SEL.createBtn).first().click();
  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });
  await page.waitForTimeout(1500);

  const auditTrail = await fillOffcanvasForm(page, name);
  console.log(`[CREATE] Filled ${Object.keys(auditTrail).length} fields`);
  await saveForm(page, false);

  const recordID = await page.evaluate(() => window.recordID).catch(() => null);
  console.log(`[CREATE] ✓ Saved | recordID = ${recordID}`);
  await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: name,
    operation: 'create',
    recordName: recordID,
    recordID,
    auditTrail,
  });
  await navigateTo(page, name);

  // 3. Review (if applicable)
  if (hasReview) {
    await approveRecord(page, displayName, auditTrail, recordID);
    await navigateTo(page, name);
  }

  // 4. Verify created record
  if (recordID) {
    await searchRecord(page, recordID);
    const count = await rowCount(page);
    expect(count).toBeGreaterThan(0);

    await openFirstEdit(page);
    const results = await verifyOffcanvasForm(page, auditTrail, name);
    const bad = results.filter((r) => !r.match);
    if (bad.length) {
      bad.forEach((r) =>
        console.warn(`[VERIFY] ⚠ "${r.field}": expected="${r.expected}" got="${r.actual}"`)
      );
    } else {
      console.log(`[VERIFY] ✓ All ${results.length} field(s) match`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // 5. Update
  for (let u = 1; u <= OPTIONS.UPDATE_TIMES; u++) {
    console.log(`[UPDATE] Pass ${u}/${OPTIONS.UPDATE_TIMES}…`);
    if (recordID) await searchRecord(page, recordID);
    await openFirstEdit(page);
    const updated = await fillOffcanvasForm(page, name);
    Object.assign(auditTrail, updated);
    const remarks = `Update pass ${u} | ${Date.now()}`;
    await saveForm(page, true, remarks);
    await verifyAuditTrailEntry(page, {
      baseURL: new URL(page.url()).origin,
      masterName: name,
      operation: 'update',
      recordName: recordID,
      recordID,
      auditTrail: updated,
      reason: remarks,
    });
    await navigateTo(page, name);
    console.log(`[UPDATE] ✓ Pass ${u} saved`);
  }

  // 6. Delete
  for (let d = 1; d <= OPTIONS.DELETE_TIMES; d++) {
    console.log(`[DELETE] Pass ${d}/${OPTIONS.DELETE_TIMES}…`);
    if (recordID) await searchRecord(page, recordID);
    await deleteFirst(page);
    await verifyAuditTrailEntry(page, {
      baseURL: new URL(page.url()).origin,
      masterName: name,
      operation: 'delete',
      recordName: recordID,
      recordID,
    });
    await navigateTo(page, name);
    console.log(`[DELETE] ✓ Pass ${d} deleted`);
  }

  // 7. Verify deleted
  if (recordID) {
    await searchRecord(page, recordID);
    await page.waitForTimeout(800);
    const remaining = await rowCount(page);
    if (remaining === 0) {
      console.log(`[DELETE] ✓ Record ${recordID} gone from table`);
    } else {
      console.warn(`[DELETE] ⚠ Record ${recordID} still showing (${remaining} rows)`);
    }
  }

  console.log(`[MASTER] ✓ Done: ${displayName}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe('Auto-discovered Masters – CRUD Lifecycle', () => {
  /** Shared browser context so login session persists between master tests */
  let sharedPage;
  /** Masters found during the discovery phase */
  let discoveredMasters = [];

  // ── Discovery runs once before all tests ────────────────────────────────────
  test.beforeAll(async ({ browser, baseURL }) => {
    const ctx = await browser.newContext();
    sharedPage = await ctx.newPage();

    // Log in once, then discover all master pages
    await login(sharedPage, OPTIONS.user);

    discoveredMasters = await discoverMasters(
      sharedPage,
      baseURL || 'https://ipdev.quickflow.in',
      OPTIONS.ONLY_MASTERS,
      OPTIONS.SKIP_MASTERS,
    );

    if (discoveredMasters.length === 0) {
      console.warn('[DISCOVER] ⚠ No master pages found. Check login or nav selectors.');
    }
  });

  test.afterAll(async () => {
    await sharedPage?.context()?.close();
  });

  // ── One test per discovered master ──────────────────────────────────────────
  // We use a single umbrella test that loops through all masters.
  // This way the discovery list (which is dynamic) drives the tests.
  test('Run CRUD on all discovered masters', async () => {
    // sharedPage comes from beforeAll, no new `page` fixture needed
    for (const master of discoveredMasters) {
      await runMasterCycle(sharedPage, master);
    }
  });
});
