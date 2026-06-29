'use strict';

const { log } = require('./session');

/** Wait briefly for a success/notification toast; non-fatal if none appears. */
async function waitToast(page, timeoutMs = 6000) {
  const toast = page.locator('.toast, .swal2-popup, .Toastify__toast, .alert-success').first();
  await toast.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  const text = await toast.textContent().catch(() => '');
  return (text || '').trim();
}

/** Save into the current template version (db.save("C")). */
async function save(page) {
  log('Saving template (current version)');
  const btn = page.locator('#btnSave').first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  const msg = await waitToast(page);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (msg) log(`  save response: ${msg}`);
  return msg;
}

/**
 * Publish a new version (#btnSaveNewVersion). Fills the "Reason for publish" modal
 * (#reasonTextarea) and submits.
 */
async function publish(page, reason) {
  log('Publishing new version');
  const btn = page.locator('#btnSaveNewVersion').first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();

  // Reason modal (ReasonPromptModal): textarea #reasonTextarea + Submit button.
  const textarea = page.locator('#reasonTextarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  await textarea.fill(reason);

  const submit = page
    .locator('button:has-text("Submit"), .modal.show button:has-text("Submit")')
    .first();
  await submit.click();

  const msg = await waitToast(page);
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);
  if (msg) log(`  publish response: ${msg}`);
  return msg;
}

module.exports = { save, publish, waitToast };
