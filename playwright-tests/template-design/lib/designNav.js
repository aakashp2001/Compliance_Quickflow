'use strict';

const { BASE_URL, log } = require('./session');

/** Open the Design-Template page and wait for the top-bar dropdowns. */
async function open(page) {
  await page.goto(`${BASE_URL}/Design-Template`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#MainContent_ddlAppList', { timeout: 20000 });
  await page.waitForSelector('#MainContent_ddlTemplateSheet', { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

function readOptions(page, selectId) {
  return page.evaluate((id) => {
    const select = document.getElementById(id);
    if (!select) return [];
    return Array.from(select.options || [])
      .map((opt) => ({
        value: String(opt.value || ''),
        label: String(opt.textContent || opt.text || '').trim(),
        disabled: !!opt.disabled,
      }))
      .filter((opt) => opt.value && opt.label && !/^select\b/i.test(opt.label));
  }, selectId).catch(() => []);
}

async function waitOptions(page, selectId, { allowDisabled = false, timeoutMs = 20000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const opts = await readOptions(page, selectId);
    const usable = allowDisabled ? opts : opts.filter((o) => !o.disabled);
    if (usable.length > 0) return usable;
    await page.waitForTimeout(700);
  }
  return [];
}

/** Live App options (enabled only). */
async function getApps(page) {
  return waitOptions(page, '#MainContent_ddlAppList'.replace('#', ''), { allowDisabled: false });
}

/** Live Template/sub-template options (includes disabled parent rows so user sees hierarchy). */
async function getTemplates(page) {
  return waitOptions(page, 'MainContent_ddlTemplateSheet', { allowDisabled: true });
}

function selectOption(page, selectId, value) {
  return page.evaluate(({ id, val }) => {
    const select = document.getElementById(id);
    if (!select) return false;
    select.value = val;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.$) {
      try { window.$(select).trigger('change.select2'); } catch (_) { /* ignore */ }
    }
    return true;
  }, { id: selectId, val: value });
}

async function selectApp(page, appValue) {
  log(`Selecting app: ${appValue}`);
  const ok = await selectOption(page, 'MainContent_ddlAppList', appValue);
  if (!ok) throw new Error('App dropdown not found');
  await page.waitForTimeout(1400);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function selectTemplate(page, templateValue) {
  log(`Selecting template: ${templateValue}`);
  const ok = await selectOption(page, 'MainContent_ddlTemplateSheet', templateValue);
  if (!ok) throw new Error('Template dropdown not found');
  await page.waitForTimeout(1600);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  // canvas should be present after a template loads
  await page.waitForSelector('#drawpad', { timeout: 15000 });
}

module.exports = { open, getApps, getTemplates, selectApp, selectTemplate };
