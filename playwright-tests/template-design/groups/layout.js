'use strict';

/**
 * Layout group (reference implementation).
 *
 * Drops every Layout control (Placeholder, Divider, Table, Modal, Card) onto the
 * canvas and applies representative properties. Pure group logic — navigation,
 * save and publish are orchestrated by runDesign.js so the same browser session
 * is reused. The other 7 groups mirror this file (only GROUP_NAME changes).
 */

const { GROUPS } = require('../config/paletteGroups');
const { placeGroupControls } = require('../lib/runGroup');

const GROUP_NAME = 'Layout';

async function run(page) {
  return placeGroupControls(page, GROUP_NAME, GROUPS[GROUP_NAME]);
}

module.exports = { GROUP_NAME, run };
