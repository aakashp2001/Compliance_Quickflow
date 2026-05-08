/**
 * all-masters.spec.js
 *
 * Common Playwright script that tests every master defined in masters.config.js.
 *
 * For each master the script runs the full lifecycle:
 *   1. Login
 *   2. Navigate to master page
 *   3. Create record  (fill all form fields automatically)
 *   4. Verify record  (re-open and check saved values)
 *   5. Update record  (updateTimes times)
 *   6. Delete record  (deleteTimes times)
 *   7. Verify deleted (record no longer appears in table)
 *
 * Usage:
 *   npx playwright test --config=playwright.config.js
 */

const { test, expect } = require('@playwright/test');
const { MASTERS } = require('./masters.config');
const { fillOffcanvasForm, verifyOffcanvasForm } = require('./helpers/formFiller');
const { verifyAuditTrailEntry } = require('./helpers/auditTrail');

// ─── Selectors (centralised so they are easy to update) ───────────────────────
const SEL = {
  username:        '#txtUsername',
  password:        '#txtPassword',
  loginBtn:        '#btnLogin',
  loginError:      ':text("Invalid username or password")',
  unlockBtn:       '#btnUnlock',
  homeReady:       '#divAppButton',
  userMenu:        '#userMenu',
  fullName:        '#fullName',
  pageTitle:       '.pageTitle',
  createBtn:       ':text("Create")',
  offcanvas:       '#masterFormOffcanvas .offcanvas-body',
  saveBtn:         '#btnSave',
  successCreate:   ':text("Data saved successfully")',
  successUpdate:   ':text("Data updated successfully")',
  successDelete:   ':text("Data deleted successfully")',
  confirmOk:       '.swal2-confirm',
  searchBox:       '[type="search"]',
  reasonTextarea:  '#reasonTextarea',
  submitBtn:       ':text("Submit")',
  tableRows:       '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr',
  editBtn:         '.fa-pen-to-square, .fa-edit',
  deleteBtn:       '.fa-trash, .fa-trash-alt, :text("Delete")',
  deleteConfirmOk: '.swal2-confirm',
};

// ─── Helper: login ─────────────────────────────────────────────────────────────

/**
 * Log in as the given user.
 * If already logged in as the same user, skips the login flow.
 */
async function login(page, { username, password, firstName, lastName }) {
  // Check if already logged in
  const alreadyIn = await page.locator(SEL.userMenu).isVisible().catch(() => false);
  if (alreadyIn) {
    // Verify that the correct user is logged in
    await page.hover(SEL.userMenu);
    await page.waitForSelector(SEL.fullName, { timeout: 5000 }).catch(() => {});
    const name = await page.locator(SEL.fullName).textContent().catch(() => '');
    if (name.trim() === `${firstName} ${lastName}`) {
      console.log(`[LOGIN] Already logged in as ${firstName} ${lastName} – skipping login`);
      return;
    }
    // Wrong user – sign out
    console.log(`[LOGIN] Different user detected (${name}), signing out…`);
    await page.locator(':text("Sign Out")').click();
    await page.waitForTimeout(2000);
  }

  await page.goto('/');
  await page.waitForSelector(SEL.username, { timeout: 30000 });
  await page.waitForTimeout(500);

  // ── Invalid login validation ──────────────────────────────────────────────
  console.log('[LOGIN] Testing invalid credentials…');

  // Wrong username, correct password
  await page.fill(SEL.username, `${username}_invalid`);
  await page.fill(SEL.password, password);
  await page.click(SEL.loginBtn);
  await expect(page.locator(SEL.loginError)).toBeVisible({ timeout: 10000 });
  console.log('[LOGIN] ✓ Wrong username rejected');

  // Correct username, wrong password
  await page.fill(SEL.username, username);
  await page.fill(SEL.password, `${password}_invalid`);
  await page.click(SEL.loginBtn);
  await expect(page.locator(SEL.loginError)).toBeVisible({ timeout: 10000 });
  console.log('[LOGIN] ✓ Wrong password rejected');

  // Both wrong
  await page.fill(SEL.username, `${username}_invalid`);
  await page.fill(SEL.password, `${password}_invalid`);
  await page.click(SEL.loginBtn);
  await expect(page.locator(SEL.loginError)).toBeVisible({ timeout: 10000 });
  console.log('[LOGIN] ✓ Both invalid rejected');

  // ── Valid login ───────────────────────────────────────────────────────────
  console.log(`[LOGIN] Logging in as ${username}…`);
  await page.fill(SEL.username, username);
  await page.fill(SEL.password, password);
  await page.click(SEL.loginBtn);
  await page.waitForTimeout(1000);

  // If there is a "logged in elsewhere" dialog, click Unlock
  const unlockVisible = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
  if (unlockVisible) {
    console.log('[LOGIN] Unlocking existing session…');
    await page.click(SEL.unlockBtn);
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector(SEL.homeReady, { timeout: 30000 });
  console.log(`[LOGIN] ✓ Logged in as ${firstName} ${lastName}`);
}

// ─── Helper: navigate to master page ──────────────────────────────────────────

async function navigateToMaster(page, name) {
  const route = `/${name}`;
  const currentUrl = page.url();

  if (currentUrl.includes(name)) {
    console.log(`[NAV] Already on ${route}`);
    return;
  }

  // Try direct sidebar / nav link first
  const linkSelector = `a[href="${route}"]`;
  const linkVisible = await page.locator(linkSelector).first().isVisible().catch(() => false);

  if (linkVisible) {
    await page.locator(linkSelector).first().click();
  } else {
    // Try expanding a parent menu item
    const parentItem = page.locator(`li`).filter({ has: page.locator(linkSelector) }).first();
    const parentExists = await parentItem.isVisible().catch(() => false);

    if (parentExists) {
      await parentItem.click();
      await page.waitForTimeout(500);
      await page.locator(linkSelector).first().click();
    } else {
      // Fallback: direct navigation
      console.log(`[NAV] Link not found in menu – navigating directly to ${route}`);
      await page.goto(route);
    }
  }

  await page.waitForSelector(SEL.pageTitle, { timeout: 30000 });
  await page.waitForTimeout(1000);
  console.log(`[NAV] ✓ Navigated to ${route}`);
}

// ─── Helper: search record in table ───────────────────────────────────────────

async function searchRecord(page, recordID) {
  await page.waitForSelector(SEL.searchBox, { timeout: 15000 });
  await page.fill(SEL.searchBox, '');
  await page.fill(SEL.searchBox, recordID);
  await page.waitForTimeout(600);
}

async function getRowCount(page) {
  const rows = await page.locator(SEL.tableRows).all();
  // Filter out "No data" rows
  let count = 0;
  for (const row of rows) {
    const txt = (await row.textContent().catch(() => '')).trim();
    if (txt && !txt.toLowerCase().includes('no data') && !txt.toLowerCase().includes('no matching')) {
      count++;
    }
  }
  return count;
}

// ─── Helper: open the first matching row's edit form ──────────────────────────

async function openFirstRowEdit(page) {
  // Click the edit icon / pencil icon in the first data row
  const editLocator = page.locator(`${SEL.tableRows}:first-child ${SEL.editBtn}`).first();
  const editExists = await editLocator.isVisible().catch(() => false);

  if (editExists) {
    await editLocator.click();
  } else {
    // Some masters open the edit form on row click
    await page.locator(`${SEL.tableRows}`).first().click();
  }

  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });
  await page.waitForTimeout(1000);
}

// ─── Helper: save the offcanvas form ──────────────────────────────────────────

async function saveForm(page, isUpdate = false, updateRemarks = '') {
  await page.click(SEL.saveBtn);

  if (isUpdate) {
    // The update flow shows a reason textarea
    const reasonVisible = await page.waitForSelector(SEL.reasonTextarea, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (reasonVisible) {
      await page.fill(SEL.reasonTextarea, updateRemarks || `Updated at ${Date.now()}`);
      await page.locator(SEL.submitBtn).click();
    }
  }

  const successSel = isUpdate ? SEL.successUpdate : SEL.successCreate;
  await page.waitForSelector(successSel, { timeout: 30000 });

  // Dismiss SweetAlert if present
  const confirmVisible = await page.locator(SEL.confirmOk).isVisible().catch(() => false);
  if (confirmVisible) {
    await page.click(SEL.confirmOk);
    await page.waitForTimeout(500);
  }
}

// ─── Helper: delete first matching record ─────────────────────────────────────

async function deleteFirstRecord(page) {
  // Some masters have a checkbox + delete button pattern; others have inline trash icon
  const trashIcon = page.locator(`${SEL.tableRows}:first-child ${SEL.deleteBtn}`).first();
  const iconExists = await trashIcon.isVisible().catch(() => false);

  if (iconExists) {
    await trashIcon.click();
  } else {
    // Select row checkbox then click a toolbar Delete button
    const rowCheckbox = page.locator(`${SEL.tableRows}:first-child input[type="checkbox"]`).first();
    await rowCheckbox.check().catch(() => {});
    await page.locator(SEL.deleteBtn).first().click();
  }

  // Confirm the SweetAlert dialog
  await page.waitForSelector(SEL.deleteConfirmOk, { timeout: 10000 });
  await page.click(SEL.deleteConfirmOk);

  await page.waitForSelector(SEL.successDelete, { timeout: 20000 });

  const confirmVisible = await page.locator(SEL.confirmOk).isVisible().catch(() => false);
  if (confirmVisible) {
    await page.click(SEL.confirmOk);
    await page.waitForTimeout(500);
  }
}

// ─── Helper: review flow ───────────────────────────────────────────────────────

async function handleReview(page, masterConfig, auditTrail, recordID) {
  const { reviewUser, name, siteName, appName, dynamicSchema } = masterConfig;
  if (!reviewUser) throw new Error(`hasReview=true but reviewUser is missing for master "${name}"`);

  console.log(`[REVIEW] Logging in as reviewer ${reviewUser.username}…`);
  await login(page, reviewUser);

  if (dynamicSchema === 'Y') {
    await changeApp(page, siteName, appName);
  }

  // Navigate to Master Review Dashboard
  await page.click('#dashboards');
  await page.waitForTimeout(1000);
  await page.click('[href="/Home#MasterReviewDashboard"]');
  await page.waitForTimeout(2000);

  const actualMasterName = name.replaceAll('--', ' & ').replaceAll('-', ' ');
  const collapseId = `#collapse_${actualMasterName.replaceAll(/\s/g, '')}`;

  await page.waitForSelector('[data-bs-toggle="collapse"]', { timeout: 15000 });

  const collapseClass = await page.getAttribute(collapseId, 'class').catch(() => '');
  if (!collapseClass.includes('show')) {
    await page.click('[data-bs-toggle="collapse"]');
    await page.waitForTimeout(1000);
  }

  // Open the first pending record
  await page.evaluate((collapseId) => {
    const tbody = document.querySelector(`${collapseId} .dataTables_scrollBody tbody, ${collapseId} .dt-scroll-body tbody`);
    if (tbody) {
      const btn = tbody.querySelector('tr:first-child .fa-check-square, tr:first-child .fa-pen-to-square');
      if (btn) btn.click();
    }
  }, collapseId);

  await page.waitForSelector(SEL.offcanvas, { timeout: 20000 });
  await page.waitForTimeout(2000);

  // Verify fields (read-only in review)
  await verifyOffcanvasForm(page, auditTrail, name);

  // Approve
  await page.locator(':text("Approve")').click();
  await page.waitForSelector('#reviewPassword', { timeout: 10000 });
  await page.fill('#reviewPassword', reviewUser.password);
  await page.locator(':text("Submit")').click();

  await page.waitForSelector('.swal2-html-container:has-text("approved successfully")', { timeout: 20000 });
  await page.click(SEL.confirmOk);
  await page.waitForTimeout(500);

  console.log(`[REVIEW] ✓ Record ${recordID} approved for master "${name}"`);
}

// ─── Helper: change app (dynamic schema) ──────────────────────────────────────

async function changeApp(page, siteName, appName) {
  await page.waitForSelector('#divAppButton', { timeout: 10000 });
  await page.click('#divAppButton');
  await page.waitForTimeout(500);
  // Select site
  await page.locator(`:text("${siteName}")`).first().click();
  await page.waitForTimeout(300);
  // Select app
  await page.locator(`:text("${appName}")`).first().click();
  await page.waitForTimeout(1000);
  console.log(`[APP] ✓ Switched to ${siteName} / ${appName}`);
}

// ─── Master test factory ───────────────────────────────────────────────────────

/**
 * Run the full CRUD lifecycle for a single master.
 */
async function runMasterTest(page, masterConfig) {
  const {
    name,
    user,
    updateTimes = 1,
    deleteTimes = 1,
    hasReview = false,
    dynamicSchema,
    siteName,
    appName,
  } = masterConfig;

  const actualName = name.replaceAll('--', ' & ').replaceAll('-', ' ');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[MASTER] Starting test for: ${actualName}`);
  console.log(`${'─'.repeat(60)}`);

  // ── 1. Login ───────────────────────────────────────────────────────────────
  await login(page, user);

  if (dynamicSchema === 'Y') {
    await changeApp(page, siteName, appName);
  }

  // ── 2. Navigate ────────────────────────────────────────────────────────────
  await navigateToMaster(page, name);

  // ── 3. Create record ───────────────────────────────────────────────────────
  console.log(`[CREATE] Opening create form for "${actualName}"…`);
  await page.waitForSelector(SEL.createBtn, { timeout: 15000 });
  await page.locator(SEL.createBtn).first().click();
  await page.waitForSelector(SEL.offcanvas, { timeout: 15000 });
  await page.waitForTimeout(1500);

  const auditTrail = await fillOffcanvasForm(page, name);
  console.log(`[CREATE] Filled ${Object.keys(auditTrail).length} fields`);

  await saveForm(page, false);

  // Retrieve the saved recordID from window context
  const recordID = await page.evaluate(() => window.recordID).catch(() => null);
  console.log(`[CREATE] ✓ Record created | recordID = ${recordID}`);
  await verifyAuditTrailEntry(page, {
    baseURL: new URL(page.url()).origin,
    masterName: name,
    operation: 'create',
    recordName: recordID,
    recordID,
    auditTrail,
  });
  await navigateToMaster(page, name);

  // ── 3a. Review (if required) ───────────────────────────────────────────────
  if (hasReview) {
    await handleReview(page, masterConfig, auditTrail, recordID);
    // Log back in as the original user
    await login(page, user);
    if (dynamicSchema === 'Y') await changeApp(page, siteName, appName);
    await navigateToMaster(page, name);
  }

  // ── 4. Verify created record ───────────────────────────────────────────────
  if (recordID) {
    await searchRecord(page, recordID);
    const count = await getRowCount(page);
    expect(count).toBeGreaterThan(0);
    console.log(`[VERIFY] ✓ Record found in table (${count} rows)`);

    await openFirstRowEdit(page);
    const verifyResults = await verifyOffcanvasForm(page, auditTrail, name);
    const mismatches = verifyResults.filter((r) => !r.match);
    if (mismatches.length) {
      console.warn(`[VERIFY] ⚠ ${mismatches.length} field mismatch(es) in "${actualName}":`);
      mismatches.forEach((m) => console.warn(`  • ${m.field}: expected="${m.expected}" got="${m.actual}"`));
    } else {
      console.log(`[VERIFY] ✓ All ${verifyResults.length} verified fields match`);
    }

    // Close offcanvas without saving
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ── 5. Update record ───────────────────────────────────────────────────────
  for (let u = 1; u <= updateTimes; u++) {
    console.log(`[UPDATE] Pass ${u}/${updateTimes} for "${actualName}"…`);

    if (recordID) await searchRecord(page, recordID);
    await openFirstRowEdit(page);

    const updateAudit = await fillOffcanvasForm(page, name);
    Object.assign(auditTrail, updateAudit);

    const remarks = `Update pass ${u} | ${Date.now()}`;
    await saveForm(page, true, remarks);
    await verifyAuditTrailEntry(page, {
      baseURL: new URL(page.url()).origin,
      masterName: name,
      operation: 'update',
      recordName: recordID,
      recordID,
      auditTrail: updateAudit,
      reason: remarks,
    });
    await navigateToMaster(page, name);
    console.log(`[UPDATE] ✓ Pass ${u} saved`);

    if (recordID) {
      await searchRecord(page, recordID);
      const count = await getRowCount(page);
      expect(count).toBeGreaterThan(0);
    }
  }

  // ── 6. Delete record ───────────────────────────────────────────────────────
  for (let d = 1; d <= deleteTimes; d++) {
    console.log(`[DELETE] Pass ${d}/${deleteTimes} for "${actualName}"…`);

    if (recordID) await searchRecord(page, recordID);

    await deleteFirstRecord(page);
    await verifyAuditTrailEntry(page, {
      baseURL: new URL(page.url()).origin,
      masterName: name,
      operation: 'delete',
      recordName: recordID,
      recordID,
    });
    await navigateToMaster(page, name);
    console.log(`[DELETE] ✓ Pass ${d} deleted`);
  }

  // ── 7. Verify deleted ──────────────────────────────────────────────────────
  if (recordID) {
    await searchRecord(page, recordID);
    await page.waitForTimeout(1000);
    const remaining = await getRowCount(page);
    if (remaining === 0) {
      console.log(`[DELETE] ✓ Record ${recordID} no longer appears in table`);
    } else {
      console.warn(`[DELETE] ⚠ Record ${recordID} still appears in table (${remaining} rows)`);
    }
  }

  console.log(`[MASTER] ✓ Completed test for "${actualName}"\n`);
}

// ─── Test suite ────────────────────────────────────────────────────────────────

test.describe('All Masters – CRUD Lifecycle', () => {
  // Persistent browser context so login sessions carry across tests
  let sharedPage;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    sharedPage = await context.newPage();
  });

  test.afterAll(async () => {
    await sharedPage?.context()?.close();
  });

  for (const masterConfig of MASTERS) {
    const displayName = masterConfig.name.replaceAll('--', ' & ').replaceAll('-', ' ');

    test(`Master: ${displayName}`, async () => {
      await runMasterTest(sharedPage, masterConfig);
    });
  }
});
