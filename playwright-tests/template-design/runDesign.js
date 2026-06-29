'use strict';

/**
 * Interactive Template Design automation.
 *
 *   node template-design/runDesign.js
 *
 * Prompts (live values read from the page):
 *   1. App            (from #MainContent_ddlAppList)
 *   2. Template/sub   (from #MainContent_ddlTemplateSheet)
 *   3. Group          (Layout ... RPA) — only built groups are runnable
 *   4. Action         (save only / publish / publish + verify issuance)
 *
 * CLI overrides skip the matching prompt:
 *   --app="eLog Book"   --template="details"   --group=Layout
 *   --publish   --issuance   --reason="..."   --yes (no confirm)
 */

const readline = require('readline');
const session = require('./lib/session');
const designNav = require('./lib/designNav');
const savePublish = require('./lib/savePublish');
const issuance = require('./lib/issuance');
const { GROUP_NAMES } = require('./config/paletteGroups');

// Registry of built group modules. Add entries here as groups are implemented.
const GROUP_MODULES = {
  Layout: () => require('./groups/layout'),
  // Input:   () => require('./groups/input'),
  // Email:   () => require('./groups/email'),
  // Editors: () => require('./groups/editors'),
  // Select:  () => require('./groups/select'),
  // Display: () => require('./groups/display'),
  // Intg:    () => require('./groups/intg'),
  // RPA:     () => require('./groups/rpa'),
};

function parseArgs(argv) {
  const args = { flags: new Set(), opts: {} };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] === undefined) args.flags.add(m[1]);
    else args.opts[m[1]] = m[2];
  }
  return args;
}

function makePrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
  return { ask, close: () => rl.close() };
}

async function pickFromList(ask, items, label, renderFn) {
  console.log(`\n${'='.repeat(60)}\nSelect ${label}:\n${'='.repeat(60)}`);
  items.forEach((it, i) => console.log(`${i + 1}. ${renderFn ? renderFn(it) : it}`));
  while (true) {
    const ans = await ask(`\nEnter number (1-${items.length}): `);
    const n = parseInt(ans, 10);
    if (n >= 1 && n <= items.length) return items[n - 1];
    console.log(`Invalid. Enter 1-${items.length}.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const interactive = !args.flags.has('yes') || !args.opts.app || !args.opts.template || !args.opts.group;
  const prompt = interactive ? makePrompt() : null;
  const ask = prompt ? prompt.ask : async () => '';

  let browser, context, page;
  const summary = { app: null, template: null, group: null, results: null };

  try {
    ({ browser, context, page } = await session.launch());
    session.log('Logging in');
    await session.login(page);
    session.log('Opening Design Template');
    await designNav.open(page);

    // --- App ---
    const apps = await designNav.getApps(page);
    if (!apps.length) throw new Error('No apps available');
    let app;
    if (args.opts.app) {
      app = apps.find((a) => a.label.toLowerCase().includes(args.opts.app.toLowerCase()));
      if (!app) throw new Error(`App not found: ${args.opts.app}`);
    } else {
      app = await pickFromList(ask, apps, 'App', (a) => a.label);
    }
    await designNav.selectApp(page, app.value);
    summary.app = app.label;

    // --- Template / sub-template ---
    const templates = await designNav.getTemplates(page);
    if (!templates.length) throw new Error('No templates for this app');
    const selectable = templates.filter((t) => !t.disabled);
    if (!selectable.length) throw new Error('No selectable sub-templates for this app');
    let tpl;
    if (args.opts.template) {
      tpl = selectable.find((t) => t.label.toLowerCase().includes(args.opts.template.toLowerCase()));
      if (!tpl) throw new Error(`Template not found: ${args.opts.template}`);
    } else {
      tpl = await pickFromList(ask, selectable, 'Template / sub-template', (t) => t.label);
    }
    await designNav.selectTemplate(page, tpl.value);
    summary.template = tpl.label;

    // --- Group ---
    let groupName;
    if (args.opts.group) {
      groupName = GROUP_NAMES.find((g) => g.toLowerCase() === args.opts.group.toLowerCase());
      if (!groupName) throw new Error(`Unknown group: ${args.opts.group}`);
    } else {
      groupName = await pickFromList(
        ask, GROUP_NAMES, 'Group',
        (g) => `${g}${GROUP_MODULES[g] ? '' : '  (not built yet)'}`,
      );
    }
    if (!GROUP_MODULES[groupName]) {
      throw new Error(`Group "${groupName}" is not built yet. Only: ${Object.keys(GROUP_MODULES).join(', ')}`);
    }
    summary.group = groupName;

    // --- Action ---
    const doPublish = args.flags.has('publish') ||
      (interactive && /publish/i.test(await ask('\nAction? [s]ave only / [p]ublish / [i] publish+issuance: ') || 's'));
    const doIssuance = args.flags.has('issuance');

    // --- Run group ---
    const groupMod = GROUP_MODULES[groupName]();
    summary.results = await groupMod.run(page);

    // --- Save (always) ---
    await savePublish.save(page);

    // --- Publish ---
    if (doPublish || args.flags.has('issuance')) {
      const reason = args.opts.reason || 'Automated template design run';
      await savePublish.publish(page, reason);
    }

    // --- Issuance verify ---
    if (doIssuance) {
      const res = await issuance.verify(page, summary.template);
      summary.issuance = res.found;
    }

    const addedCount = summary.results.filter((r) => r.added).length;
    console.log('\n' + JSON.stringify({
      status: 'completed',
      app: summary.app,
      template: summary.template,
      group: summary.group,
      controlsAdded: `${addedCount}/${summary.results.length}`,
      issuance: summary.issuance,
    }, null, 2));
  } catch (err) {
    console.error('\nFAILED:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    if (prompt) prompt.close();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main();
