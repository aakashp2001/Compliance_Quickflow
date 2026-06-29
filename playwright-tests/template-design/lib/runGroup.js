'use strict';

const palette = require('./palette');
const propPanel = require('./propPanel');
const { propsFor } = require('../config/fieldProps');
const { log } = require('./session');

/**
 * Drop every control of a group onto the canvas and apply representative props.
 * `group` is a { panel, controls } entry from config/paletteGroups.
 * Returns a per-control result summary.
 */
async function placeGroupControls(page, groupName, group) {
  log(`=== Group: ${groupName} (${group.controls.length} controls) ===`);
  const results = [];

  for (const { ctl, label } of group.controls) {
    const added = await palette.addControl(page, group.panel, ctl);
    let propTally = { set: 0, skipped: 0, error: 0 };

    if (added) {
      const selected = await palette.selectLastControl(page);
      if (selected) {
        propTally = await propPanel.applyProps(page, propsFor(ctl, label));
      }
    }
    results.push({ ctl, label, added, props: propTally });
  }

  const addedCount = results.filter((r) => r.added).length;
  log(`=== ${groupName}: ${addedCount}/${group.controls.length} controls added ===`);
  return results;
}

module.exports = { placeGroupControls };
