'use strict';

/**
 * interactive-crud.js
 * 
 * Interactive CLI for selecting CRUD operation and running the workflow
 */

const readline = require('readline');
const { execSync, execFile } = require('child_process');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const OPERATIONS = ['create', 'update', 'delete'];

const MASTERS = [
  'Country',
  'TimeZone',
  'Create-App',
  'Site',
  'Create-Template',
  'Create-Sub-Templates',
  'Master-Workflow',
];

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function selectFromList(items, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Select ${label}:`);
  console.log('='.repeat(60));

  items.forEach((item, index) => {
    console.log(`${index + 1}. ${item}`);
  });

  while (true) {
    const answer = await prompt(`\nEnter number (1-${items.length}): `);
    const num = parseInt(answer, 10);

    if (num >= 1 && num <= items.length) {
      return items[num - 1];
    }

    console.log(`Invalid selection. Please enter a number between 1 and ${items.length}.`);
  }
}

async function run() {
  try {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║         QUICKFLOW INTERACTIVE CRUD AUTOMATION              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Step 1: Select Master
    const selectedMaster = await selectFromList(MASTERS, 'Master');
    console.log(`\n✓ Selected Master: ${selectedMaster}`);

    // Step 2: Select Operation
    const selectedOp = await selectFromList(OPERATIONS, 'Operation');
    console.log(`\n✓ Selected Operation: ${selectedOp.toUpperCase()}`);

    // Step 3: Confirm
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Master  : ${selectedMaster}`);
    console.log(`Operation: ${selectedOp.toUpperCase()}`);
    console.log('='.repeat(60));

    const confirm = await prompt('\nProceed with this operation? (yes/no): ');

    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('\n✗ Operation cancelled.');
      rl.close();
      process.exit(0);
    }

    // Step 4: Run CRUD Master
    console.log('\n⏳ Starting CRUD operation...\n');

    const env = Object.assign({}, process.env, {
      QT_URL: 'https://ipdev.quickflow.in/login',
      QT_USER: 'dhruvi',
      QT_PASS: '',
      QT_MASTER: selectedMaster,
      QT_OP: selectedOp,
      QT_HEADLESS: 'true',
      QT_VERIFY_AUDIT: 'true',
    });

    // Run crud-master.js with the selected operation
    const crudScriptPath = path.join(__dirname, 'crud-master.js');

    try {
      execSync(`node "${crudScriptPath}"`, {
        env,
        cwd: __dirname,
        stdio: 'inherit',
      });

      console.log('\n✓ CRUD operation completed successfully!');
    } catch (error) {
      console.error('\n✗ CRUD operation failed.');
      process.exit(1);
    }

    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    rl.close();
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n✗ Operation interrupted by user.');
  rl.close();
  process.exit(0);
});

run();
