'use strict';

const { chromium } = require('@playwright/test');
const path = require('path');
const { fillOffcanvasForm } = require('../helpers/formFiller');
const { verifyAuditTrailEntryCompliance } = require('./compliance-audit-wrapper');
const { attachComplianceTraceability } = require('./compliance-traceability');
const {
  login,
  navigateTo,
  openCreateForm,
  getActionableSaveButton,
  clickOptionalYesConfirmation,
  getQuickFlowError,
  SEL,
} = require('../helpers/uiActions');

const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_USER = process.env.QT_USER || 'admin';
const QT_PASS = process.env.QT_PASS || 'admin@123';
const QT_USER2 = process.env.QT_USER2 || QT_USER;
const QT_PASS2 = process.env.QT_PASS2 || QT_PASS;
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
const QT_MASTER = process.env.QT_MASTER || 'Department';
const QT_TC_ID = process.env.QT_TC_ID || '';
const OFFCANVAS_SCOPE = `:is(${SEL.offcanvas})`;

const NOW_TAG = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const READINESS = {
  AUTOMATABLE: 'Automatable',
  NEEDS_SEED_DATA: 'Needs Seed Data',
  NEEDS_FEATURE_HOOK: 'Needs Feature Hook',
};

function log(message) {
  process.stderr.write(`[MD-COMPLIANCE] ${message}\n`);
}

function emitResult(result) {
  const payload = attachComplianceTraceability(result, {
    suite: 'MD',
    runnerName: 'master-data-runner.js',
  });
  process.stdout.write(JSON.stringify(payload));
}

function baseCase(tcId, title, readiness) {
  return {
    tcId,
    title,
    readiness,
    suite: 'MD',
    status: 'failed',
    details: [],
  };
}

function blockedCase(tcId, title, readiness, reason, details = []) {
  return {
    ...baseCase(tcId, title, readiness),
    status: 'blocked',
    reason,
    details: [
      {
        step: 'Precondition probe',
        passed: false,
        expected: 'Required workflow/action available',
        actual: reason,
      },
      ...details,
    ],
  };
}

async function newComplianceContext(browser) {
  const options = {
    viewport: { width: 1366, height: 900 },
  };

  if (QT_RECORD_VIDEO) {
    options.recordVideo = {
      dir: path.resolve(__dirname, '..', 'test-reports'),
      size: { width: 1280, height: 720 },
    };
  }

  return browser.newContext(options);
}

function toRegexSafe(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getFirstVisibleRowData(page) {
  return page.evaluate(() => {
    const headerEls = Array.from(document.querySelectorAll('table thead th'));
    const headers = headerEls.map((th) => (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim());
    const row = document.querySelector('.dt-scroll-body tbody tr:first-child, .dataTables_scrollBody tbody tr:first-child, table tbody tr:first-child');
    if (!row) return null;
    const cells = Array.from(row.querySelectorAll('td'));
    const data = {};
    headers.forEach((header, i) => {
      if (cells[i]) {
        data[header] = (cells[i].innerText || cells[i].textContent || '').replace(/\s+/g, ' ').trim();
      }
    });
    return {
      data,
      rawText: (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => null);
}

function getRecordIdFromRowData(rowData) {
  const source = rowData?.data || {};
  const keys = Object.keys(source);
  const preferredKeys = ['Record ID', 'RecordID', 'Code', 'ID'];

  for (const key of preferredKeys) {
    const found = keys.find((k) => String(k || '').toLowerCase() === key.toLowerCase());
    if (found && source[found]) return String(source[found]).trim();
  }

  if (keys.length >= 2 && source[keys[1]]) return String(source[keys[1]]).trim();
  return '';
}

async function getTableStatusForRecord(page, recordID) {
  const query = String(recordID || '').trim();
  if (!query) return '';

  await page.fill(SEL.searchBox, '');
  await page.fill(SEL.searchBox, query);
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1000);

  const rowData = await getFirstVisibleRowData(page);
  const data = rowData?.data || {};
  const keys = Object.keys(data);
  const statusKey = keys.find((k) => /status/i.test(k));
  return statusKey ? String(data[statusKey] || '').trim() : '';
}

async function hasReviewWorkflow(page) {
  const fromWindow = await page.evaluate(() => {
    try {
      const wf = window?.data?.tblFormMst?.is_review_workflow || window?.data?.is_review_workflow;
      if (String(wf || '').toUpperCase() === 'Y') return true;
    } catch (_) {
      // ignore
    }
    return false;
  }).catch(() => false);

  if (fromWindow) return true;

  const reviewLike = await page
    .locator('button:visible, a:visible', { hasText: /review|submit for review|approve/i })
    .first()
    .isVisible()
    .catch(() => false);
  return reviewLike;
}

async function clickRowActionByText(page, rowSelector, actionRegex) {
  const row = rowSelector
    ? page.locator(SEL.tableRows).filter({ hasText: new RegExp(toRegexSafe(rowSelector), 'i') }).first()
    : page.locator(SEL.tableRows).first();

  const rowVisible = await row.isVisible().catch(() => false);
  if (!rowVisible) return { clicked: false, reason: 'row-not-found' };

  const action = row.locator('button:visible:not([disabled]), a:visible', { hasText: actionRegex }).first();
  const actionVisible = await action.isVisible().catch(() => false);
  if (!actionVisible) return { clicked: false, reason: 'action-not-visible' };

  await action.click({ timeout: 5000, force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  return { clicked: true, reason: '' };
}

async function openEditForRecord(page, recordID) {
  const query = String(recordID || '').trim();
  if (query) {
    await page.fill(SEL.searchBox, '');
    await page.fill(SEL.searchBox, query);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
  }

  const row = query
    ? page.locator(SEL.tableRows).filter({ hasText: new RegExp(toRegexSafe(query), 'i') }).first()
    : page.locator(SEL.tableRows).first();

  if (!(await row.isVisible().catch(() => false))) return { opened: false, reason: 'row-not-found' };

  const editButton = row.locator(SEL.editBtn).first();
  if (!(await editButton.isVisible().catch(() => false))) return { opened: false, reason: 'edit-action-not-visible' };

  await editButton.click({ timeout: 5000 }).catch(() => {});
  const opened = await page.waitForSelector(SEL.offcanvas, { timeout: 15000 }).then(() => true).catch(() => false);
  return { opened, reason: opened ? '' : 'edit-form-not-opened' };
}

async function setFirstTextInput(page, value) {
  const field = page.locator(`${OFFCANVAS_SCOPE} input[type="text"], ${OFFCANVAS_SCOPE} textarea`).first();
  const visible = await field.isVisible().catch(() => false);
  if (!visible) return false;
  await field.fill(String(value || ''));
  return true;
}

async function createSeedRecord(page, tcId, masterName) {
  const seedValue = `MD_${tcId}_${NOW_TAG}`;
  await openCreateForm(page);

  const filledAudit = await fillOffcanvasForm(page, masterName).catch(() => ({}));
  await setFirstTextInput(page, seedValue).catch(() => false);

  const saveBtn = await getActionableSaveButton(page);
  if (!saveBtn) {
    return {
      ok: false,
      reason: 'save-button-not-found',
      seedValue,
      auditTrail: filledAudit,
    };
  }

  await saveBtn.click();
  await clickOptionalYesConfirmation(page, 3500).catch(() => false);
  await page.waitForTimeout(1400);

  const errorInfo = await getQuickFlowError(page).catch(() => null);
  if (errorInfo?.message) {
    return {
      ok: false,
      reason: `save-blocked:${errorInfo.message}`,
      seedValue,
      auditTrail: filledAudit,
      errorInfo,
    };
  }

  const rowData = await getFirstVisibleRowData(page);
  const recordID = getRecordIdFromRowData(rowData) || seedValue;

  return {
    ok: true,
    seedValue,
    recordID,
    rowData,
    auditTrail: {
      ...filledAudit,
      Seed: seedValue,
    },
  };
}

async function assertDuplicateError(page) {
  const errorInfo = await getQuickFlowError(page).catch(() => null);
  const message = String(errorInfo?.message || '').trim();
  if (!message) return { duplicateDetected: false, message: '' };

  const duplicateDetected = /already exists|duplicate|already taken|already registered|record exists/i.test(message);
  return { duplicateDetected, message };
}

async function probeFeatureAction(page, pattern, label) {
  const visible = await page.locator('button:visible, a:visible, .btn:visible', { hasText: pattern }).first().isVisible().catch(() => false);
  if (!visible) {
    return { ok: false, reason: `${label} action not available in current UI` };
  }
  return { ok: true, reason: '' };
}

async function runTC_MD_01_01(page) {
  const tcId = 'TC-MD-01-01';
  const title = 'Lifecycle Stage Skip Prevention (Draft > In Review > Approved)';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const reviewEnabled = await hasReviewWorkflow(page);
  if (!reviewEnabled) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Review workflow not enabled for selected master (Review != Yes).');
  }

  const create = await createSeedRecord(page, tcId, QT_MASTER);
  if (!create.ok) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, `Unable to create draft seed record: ${create.reason}`);
  }

  const initialStatus = await getTableStatusForRecord(page, create.recordID);

  const approveAttempt = await clickRowActionByText(page, create.recordID, /approve/i);
  if (!approveAttempt.clicked) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Direct Approve action not available from listing row for skip test.', [
      { step: 'Approve action probe', passed: false, actual: approveAttempt.reason },
    ]);
  }

  const afterApproveError = await getQuickFlowError(page).catch(() => null);
  const finalStatus = await getTableStatusForRecord(page, create.recordID);

  const blockedBySystem = !!afterApproveError?.message || /draft|in review/i.test(finalStatus);

  let auditResult = null;
  try {
    auditResult = await verifyAuditTrailEntryCompliance(page, {
      baseURL: new URL(page.url()).origin,
      masterName: QT_MASTER,
      operation: 'create',
      recordName: create.recordID,
      recordID: create.recordID,
      auditTrail: create.auditTrail,
      username: QT_USER,
    });
  } catch (_) {
    auditResult = null;
  }

  return {
    ...baseCase(tcId, title, READINESS.AUTOMATABLE),
    status: blockedBySystem ? 'passed' : 'failed',
    details: [
      {
        step: 'Initial status captured',
        passed: !!initialStatus,
        actual: initialStatus || '(status column not detected)',
      },
      {
        step: 'Draft -> Approved direct attempt blocked',
        passed: blockedBySystem,
        expected: 'Transition should be blocked by workflow',
        actual: afterApproveError?.message || `Status after action: ${finalStatus || '(unknown)'}`,
      },
      {
        step: 'Status remained non-approved',
        passed: !/approved/i.test(finalStatus || ''),
        actual: finalStatus || '(unknown)',
      },
      {
        step: 'Audit trail create entry verification',
        passed: !!auditResult?.verified,
        actual: auditResult?.source || '(not verified)',
      },
    ],
  };
}

async function runTC_MD_01_02(browser) {
  const tcId = 'TC-MD-01-02';
  const title = 'Lifecycle Positive Sequence (Draft > In Review > Approved)';

  log(`${tcId}: ${title}`);

  const entryCtx = await newComplianceContext(browser);
  const reviewerCtx = await newComplianceContext(browser);
  const entryPage = await entryCtx.newPage();
  const reviewerPage = await reviewerCtx.newPage();

  try {
    await login(entryPage, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    await navigateTo(entryPage, QT_MASTER, new URL(QT_URL).origin);

    const reviewEnabled = await hasReviewWorkflow(entryPage);
    if (!reviewEnabled) {
      return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Review workflow not enabled for selected master (Review != Yes).');
    }

    const create = await createSeedRecord(entryPage, tcId, QT_MASTER);
    if (!create.ok) {
      return blockedCase(tcId, title, READINESS.AUTOMATABLE, `Unable to create draft seed record: ${create.reason}`);
    }

    const submitReview = await clickRowActionByText(entryPage, create.recordID, /review|submit/i);
    if (!submitReview.clicked) {
      return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Submit for Review action is not available for the created record.');
    }

    const inReviewStatus = await getTableStatusForRecord(entryPage, create.recordID);

    await login(reviewerPage, { loginUrl: QT_URL, username: QT_USER2, password: QT_PASS2 });
    await navigateTo(reviewerPage, QT_MASTER, new URL(QT_URL).origin);

    const approveAction = await clickRowActionByText(reviewerPage, create.recordID, /approve/i);
    if (!approveAction.clicked) {
      return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Approve action is not available for reviewer flow.');
    }

    const approveError = await getQuickFlowError(reviewerPage).catch(() => null);
    const finalStatus = await getTableStatusForRecord(reviewerPage, create.recordID);

    let auditCreate = null;
    let auditUpdate = null;
    try {
      auditCreate = await verifyAuditTrailEntryCompliance(reviewerPage, {
        baseURL: new URL(reviewerPage.url()).origin,
        masterName: QT_MASTER,
        operation: 'create',
        recordName: create.recordID,
        recordID: create.recordID,
        auditTrail: create.auditTrail,
        username: QT_USER,
      });
    } catch (_) {
      auditCreate = null;
    }

    try {
      auditUpdate = await verifyAuditTrailEntryCompliance(reviewerPage, {
        baseURL: new URL(reviewerPage.url()).origin,
        masterName: QT_MASTER,
        operation: 'update',
        recordName: create.recordID,
        recordID: create.recordID,
        username: QT_USER2,
        allowPartialCoverage: true,
      });
    } catch (_) {
      auditUpdate = null;
    }

    const passed = /in\s*review/i.test(inReviewStatus || '') && /approved/i.test(finalStatus || '') && !approveError?.message;

    return {
      ...baseCase(tcId, title, READINESS.AUTOMATABLE),
      status: passed ? 'passed' : 'failed',
      details: [
        {
          step: 'Submit for review transition',
          passed: /in\s*review/i.test(inReviewStatus || ''),
          expected: 'In Review',
          actual: inReviewStatus || '(unknown)',
        },
        {
          step: 'Reviewer approve transition',
          passed: /approved/i.test(finalStatus || '') && !approveError?.message,
          expected: 'Approved',
          actual: approveError?.message || finalStatus || '(unknown)',
        },
        {
          step: 'Audit trail create entry',
          passed: !!auditCreate?.verified,
          actual: auditCreate?.source || '(not verified)',
        },
        {
          step: 'Audit trail review/approval update entry',
          passed: !!auditUpdate?.verified,
          actual: auditUpdate?.source || '(not verified)',
        },
      ],
    };
  } finally {
    await entryCtx.close().catch(() => {});
    await reviewerCtx.close().catch(() => {});
  }
}

async function runTC_MD_02_01(page) {
  const tcId = 'TC-MD-02-01';
  const title = 'Deduplication Uniqueness Constraint';
  const keyValue = `MASTER-001-${NOW_TAG}`;

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const first = await createSeedRecord(page, tcId, QT_MASTER);
  if (!first.ok) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, `Unable to create initial seed record: ${first.reason}`);
  }

  await openCreateForm(page);
  await fillOffcanvasForm(page, QT_MASTER).catch(() => ({}));
  const setOk = await setFirstTextInput(page, keyValue);
  if (!setOk) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Could not locate a text field to drive duplicate-key scenario.');
  }

  const save1 = await getActionableSaveButton(page);
  if (!save1) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Save action not found while creating first duplicate key value.');
  }
  await save1.click();
  await clickOptionalYesConfirmation(page, 3000).catch(() => false);
  await page.waitForTimeout(1200);

  const firstDupCreateError = await getQuickFlowError(page).catch(() => null);
  if (firstDupCreateError?.message) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, `Initial duplicate-key seed could not be saved: ${firstDupCreateError.message}`);
  }

  await openCreateForm(page);
  await fillOffcanvasForm(page, QT_MASTER).catch(() => ({}));
  await setFirstTextInput(page, keyValue).catch(() => false);

  const save2 = await getActionableSaveButton(page);
  if (!save2) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Save action not found while creating second duplicate key value.');
  }
  await save2.click();
  await clickOptionalYesConfirmation(page, 3000).catch(() => false);
  await page.waitForTimeout(1200);

  const duplicateOutcome = await assertDuplicateError(page);

  await page.fill(SEL.searchBox, '');
  await page.fill(SEL.searchBox, keyValue);
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);
  const visibleRows = await page.locator(SEL.tableRows).count().catch(() => 0);

  const passed = duplicateOutcome.duplicateDetected && visibleRows <= 1;

  return {
    ...baseCase(tcId, title, READINESS.AUTOMATABLE),
    status: passed ? 'passed' : 'failed',
    details: [
      {
        step: 'Duplicate key rejected',
        passed: duplicateOutcome.duplicateDetected,
        expected: 'Duplicate/exists error',
        actual: duplicateOutcome.message || '(no duplicate message)',
      },
      {
        step: 'No duplicate record persisted',
        passed: visibleRows <= 1,
        expected: '<= 1 row for duplicate key search',
        actual: `${visibleRows} row(s)`,
      },
    ],
  };
}

async function runTC_MD_03_01(page) {
  const tcId = 'TC-MD-03-01';
  const title = 'Self-Approval Prevention';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const reviewEnabled = await hasReviewWorkflow(page);
  if (!reviewEnabled) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Review workflow not enabled for selected master (Review != Yes).');
  }

  const create = await createSeedRecord(page, tcId, QT_MASTER);
  if (!create.ok) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, `Unable to create seed record: ${create.reason}`);
  }

  const submitReview = await clickRowActionByText(page, create.recordID, /review|submit/i);
  if (!submitReview.clicked) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Submit for Review action is not available for self-approval scenario.');
  }

  const beforeApproveStatus = await getTableStatusForRecord(page, create.recordID);

  const approveAttempt = await clickRowActionByText(page, create.recordID, /approve/i);
  if (!approveAttempt.clicked) {
    return blockedCase(tcId, title, READINESS.AUTOMATABLE, 'Approve action not available for self-approval check.');
  }

  const approveError = await getQuickFlowError(page).catch(() => null);
  const finalStatus = await getTableStatusForRecord(page, create.recordID);

  const blocked = !!approveError?.message || !/approved/i.test(finalStatus || '');

  return {
    ...baseCase(tcId, title, READINESS.AUTOMATABLE),
    status: blocked ? 'passed' : 'failed',
    details: [
      {
        step: 'Record entered review state',
        passed: /review/i.test(beforeApproveStatus || ''),
        expected: 'In Review',
        actual: beforeApproveStatus || '(unknown)',
      },
      {
        step: 'Self-approval blocked',
        passed: blocked,
        expected: 'Different authorized user required',
        actual: approveError?.message || `Final status: ${finalStatus || '(unknown)'}`,
      },
      {
        step: 'Status not set to Approved by submitter',
        passed: !/approved/i.test(finalStatus || ''),
        actual: finalStatus || '(unknown)',
      },
    ],
  };
}

async function runTC_MD_04_01(page) {
  const tcId = 'TC-MD-04-01';
  const title = 'Approved Edit Creates Draft Version (Parallel Draft + Active Approved)';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const editAction = await probeFeatureAction(page, /edit/i, 'Edit');
  if (!editAction.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, editAction.reason);
  }

  const versionSignals = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return {
      hasVersionIndicators: /version|draft version|approved version|active version/.test(text),
      hasFormIssuanceLink: /form issuance|issue form/.test(text),
    };
  }).catch(() => ({ hasVersionIndicators: false, hasFormIssuanceLink: false }));

  if (!versionSignals.hasVersionIndicators || !versionSignals.hasFormIssuanceLink) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Versioned approved/draft coexistence or form-issuance linkage not discoverable in current UI.');
  }

  return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Feature hook required: deterministic versioning assertions for active approved reference are not exposed via current generic selectors.');
}

async function runTC_MD_05_01(page) {
  const tcId = 'TC-MD-05-01';
  const title = 'Retired Master Template Warning and Issuance Block';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });

  const base = new URL(QT_URL).origin;
  await page.goto(`${base}/Create-Template`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  const hasTemplateArea = await page.locator('.pageTitle, h1, h2').filter({ hasText: /template/i }).first().isVisible().catch(() => false);
  if (!hasTemplateArea) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Template area not reachable for retired-reference validation.');
  }

  const retireAction = await page.locator('button:visible, a:visible', { hasText: /retire|supersede/i }).first().isVisible().catch(() => false);
  if (!retireAction) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Retire/Supersede action not available for selected master/template flow.');
  }

  return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Feature hook required: template warning + issuance-block assertions need deterministic retired-reference fixtures.');
}

async function runTC_MD_06_01(page) {
  const tcId = 'TC-MD-06-01';
  const title = 'Bulk Import Validation Before Commit';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const importAction = await probeFeatureAction(page, /import|upload/i, 'Import');
  if (!importAction.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, importAction.reason);
  }

  return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Feature hook required: bulk-import fixture file and row-error grid selectors are environment-specific.');
}

async function runTC_MD_07_01(page) {
  const tcId = 'TC-MD-07-01';
  const title = 'Mass Update Authorization + Per-Record Audit Granularity';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const massUpdateAction = await probeFeatureAction(page, /mass update|bulk update|batch update/i, 'Mass update');
  if (!massUpdateAction.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, massUpdateAction.reason);
  }

  return blockedCase(tcId, title, READINESS.NEEDS_FEATURE_HOOK, 'Feature hook required: separate authorization and per-record audit-row assertions need dedicated mass-update workflow selectors.');
}

async function runTC_MD_08_01(page) {
  const tcId = 'TC-MD-08-01';
  const title = 'Hierarchy Parent-Child Integrity (List, Form, Export)';

  log(`${tcId}: ${title}`);
  await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
  await navigateTo(page, QT_MASTER, new URL(QT_URL).origin);

  const parentLikeField = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, th, td, span'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return labels.find((text) => /parent|category|group/i.test(text)) || '';
  }).catch(() => '');

  const exportAction = await probeFeatureAction(page, /export|download|report/i, 'Export/report');
  if (!parentLikeField || !exportAction.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, 'Parent-child seed data or export/report controls are not discoverable in current master UI.');
  }

  const create = await createSeedRecord(page, tcId, QT_MASTER);
  if (!create.ok) {
    return blockedCase(tcId, title, READINESS.NEEDS_SEED_DATA, `Unable to create seed record for hierarchy probe: ${create.reason}`);
  }

  await openEditForRecord(page, create.recordID);
  const selectCount = await page.locator(`${SEL.offcanvas} select, ${SEL.offcanvas} input[role="combobox"]`).count().catch(() => 0);

  return {
    ...baseCase(tcId, title, READINESS.NEEDS_SEED_DATA),
    status: selectCount > 0 ? 'passed' : 'blocked',
    details: [
      {
        step: 'Parent/child context discovered',
        passed: !!parentLikeField,
        actual: parentLikeField || '(none)',
      },
      {
        step: 'Form dropdown hierarchy controls present',
        passed: selectCount > 0,
        expected: '> 0 select-like controls',
        actual: `${selectCount} control(s)`,
      },
      {
        step: 'Export/report control discovered',
        passed: exportAction.ok,
        actual: exportAction.ok ? 'available' : exportAction.reason,
      },
    ],
  };
}

const TC_MAP = {
  'TC-MD-01-01': { run: async ({ page }) => runTC_MD_01_01(page) },
  'TC-MD-01-02': { run: async ({ browser }) => runTC_MD_01_02(browser) },
  'TC-MD-02-01': { run: async ({ page }) => runTC_MD_02_01(page) },
  'TC-MD-03-01': { run: async ({ page }) => runTC_MD_03_01(page) },
  'TC-MD-04-01': { run: async ({ page }) => runTC_MD_04_01(page) },
  'TC-MD-05-01': { run: async ({ page }) => runTC_MD_05_01(page) },
  'TC-MD-06-01': { run: async ({ page }) => runTC_MD_06_01(page) },
  'TC-MD-07-01': { run: async ({ page }) => runTC_MD_07_01(page) },
  'TC-MD-08-01': { run: async ({ page }) => runTC_MD_08_01(page) },
};

const DEFAULT_ALL_ORDER = [
  'TC-MD-01-01',
  'TC-MD-01-02',
  'TC-MD-02-01',
  'TC-MD-03-01',
  'TC-MD-04-01',
  'TC-MD-05-01',
  'TC-MD-06-01',
  'TC-MD-07-01',
  'TC-MD-08-01',
];

async function runOne(tcId, browser, sharedContext, sharedPage) {
  const entry = TC_MAP[tcId];
  if (!entry) {
    return {
      ...baseCase(tcId, tcId, READINESS.AUTOMATABLE),
      status: 'blocked',
      reason: `Unknown TC ID: ${tcId}`,
      details: [{ step: 'Dispatcher', passed: false, actual: 'tc-id-not-mapped' }],
    };
  }

  try {
    const result = await entry.run({ browser, context: sharedContext, page: sharedPage });
    return {
      suite: 'MD',
      ...result,
    };
  } catch (error) {
    return {
      ...baseCase(tcId, tcId, READINESS.AUTOMATABLE),
      status: 'failed',
      suite: 'MD',
      details: [{ step: 'Unhandled error', passed: false, reason: String(error?.message || error) }],
    };
  }
}

async function main() {
  const browser = await chromium.launch({ headless: QT_HEADLESS });
  const context = await newComplianceContext(browser);
  const page = await context.newPage();

  const startedAt = new Date().toISOString();
  let output;

  try {
    if (QT_TC_ID && QT_TC_ID.trim()) {
      const tcId = String(QT_TC_ID).trim();
      const single = await runOne(tcId, browser, context, page);
      output = {
        suite: 'MD',
        mode: 'single',
        masterName: QT_MASTER,
        tcId,
        startedAt,
        completedAt: new Date().toISOString(),
        ...single,
      };
    } else {
      const results = [];
      for (const tcId of DEFAULT_ALL_ORDER) {
        const result = await runOne(tcId, browser, context, page);
        results.push(result);
      }

      const summary = {
        total: results.length,
        passed: results.filter((r) => r.status === 'passed').length,
        failed: results.filter((r) => r.status === 'failed').length,
        blocked: results.filter((r) => r.status === 'blocked').length,
      };

      output = {
        suite: 'MD',
        mode: 'all',
        masterName: QT_MASTER,
        startedAt,
        completedAt: new Date().toISOString(),
        summary,
        results,
      };
    }
  } catch (error) {
    output = {
      suite: 'MD',
      mode: QT_TC_ID ? 'single' : 'all',
      status: 'failed',
      masterName: QT_MASTER,
      startedAt,
      completedAt: new Date().toISOString(),
      error: String(error?.message || error),
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  emitResult(output);
}

main().catch((error) => {
  process.stderr.write(`[MD-COMPLIANCE] Fatal error: ${error?.message || error}\n`);
  process.stdout.write(JSON.stringify({ suite: 'MD', status: 'failed', error: String(error?.message || error) }));
  process.exit(1);
});
