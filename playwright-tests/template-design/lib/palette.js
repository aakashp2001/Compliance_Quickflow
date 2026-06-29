'use strict';

const { log } = require('./session');

/** Count controls currently on the canvas. */
function countControls(page) {
  return page.evaluate(() => document.querySelectorAll('#drawpad .ctrl').length).catch(() => 0);
}

/** Open a palette category panel by its data-panel id (e.g. 'catPanelLayout'). */
async function openGroup(page, panel) {
  const btn = page.locator(`.cbar-cat-btn[data-panel="${panel}"]`).first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  // Open only if not already open.
  const isOpen = await page.evaluate((p) => {
    const el = document.getElementById(p);
    return !!(el && el.classList.contains('open'));
  }, panel);
  if (!isOpen) {
    await btn.click();
    await page.waitForSelector(`#${panel}.open`, { timeout: 8000 });
  }
  await page.waitForTimeout(300);
}

/**
 * Add a control to the canvas by clicking the tile's `+` (.float-end) button.
 * This invokes controls.add($drawpad, ctlType) without needing a jQuery-UI drag.
 * Returns true if the canvas control count increased.
 */
async function addControl(page, panel, ctl) {
  await openGroup(page, panel);
  const before = await countControls(page);

  const tile = page.locator(`#${panel}.open .ctl-tile.ctl[data-ctl="${ctl}"]`).first();
  await tile.waitFor({ state: 'visible', timeout: 10000 });
  const plus = tile.locator('.float-end').first();
  await plus.click();

  // Wait for the canvas to grow.
  const grew = await page.waitForFunction(
    ({ n }) => document.querySelectorAll('#drawpad .ctrl').length > n,
    { n: before },
    { timeout: 8000 },
  ).then(() => true).catch(() => false);

  const after = await countControls(page);
  if (grew) log(`  + added ${ctl} (canvas ${before} -> ${after})`);
  else log(`  ! ${ctl} did not add (canvas still ${after})`);
  return grew;
}

/**
 * Select the most-recently-added control on the canvas so the property panel
 * populates for it. Returns true if a control was clicked.
 */
async function selectLastControl(page) {
  const handle = page.locator('#drawpad .ctrl').last();
  const has = await handle.count();
  if (!has) return false;
  await handle.click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

module.exports = { countControls, openGroup, addControl, selectLastControl };
