'use strict';

const { BASE_URL, log } = require('./session');

/**
 * Verify a published template is available on the Form > Issuance page.
 * Navigates to /Issuance and checks the form/template select (#MainContent_ddlTemplate)
 * options for `templateLabel`. Returns { found, options }.
 */
async function verify(page, templateLabel) {
  log(`Verifying issuance dropdown for: ${templateLabel}`);
  await page.goto(`${BASE_URL}/Issuance`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

  const select = page.locator('#MainContent_ddlTemplate').first();
  await select.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});

  const options = await page.evaluate(() => {
    const sel = document.getElementById('MainContent_ddlTemplate');
    if (!sel) return [];
    return Array.from(sel.options || []).map((o) => String(o.textContent || o.text || '').trim());
  }).catch(() => []);

  const norm = (s) => String(s || '').toLowerCase().trim();
  const target = norm(templateLabel);
  const found = options.some((o) => norm(o) === target || norm(o).includes(target));
  log(found ? '  template present in issuance dropdown' : '  template NOT found in issuance dropdown');
  return { found, options };
}

module.exports = { verify };
