#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { getDb, closeMongoClient } = require('../db/mongoClient');
const { COLLECTIONS } = require('../db/storage');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, 'data');
const dependencyConfigPath = path.resolve(rootDir, '..', 'playwright-tests', 'helpers', 'dependent-dropdowns.json');
const lastRunStatePath = path.resolve(rootDir, 'last-run-state.json');
const lastPassedStatePath = path.resolve(rootDir, 'last-passed-workflow-state.json');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

function normalizeMasterFields(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return Object.entries(source)
    .map(([masterName, value]) => ({
      masterName: String(masterName || '').trim(),
      fetchedAt: value && value.fetchedAt ? value.fetchedAt : null,
      fields: Array.isArray(value && value.fields) ? value.fields : [],
      updatedAt: new Date().toISOString(),
    }))
    .filter((doc) => doc.masterName);
}

function normalizeDependencyConfig(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return Object.entries(source)
    .map(([masterName, value]) => ({
      masterName: String(masterName || '').trim(),
      parentDropdowns: Array.isArray(value && value.parentDropdowns) ? value.parentDropdowns : [],
      dependentDropdowns: Array.isArray(value && value.dependentDropdowns) ? value.dependentDropdowns : [],
      updatedAt: new Date().toISOString(),
    }))
    .filter((doc) => doc.masterName);
}

function normalizeComplianceRuns(payload) {
  const runsById = payload && payload.runsById && typeof payload.runsById === 'object' ? payload.runsById : {};
  return Object.values(runsById)
    .filter((run) => run && run.runId)
    .map((run) => ({
      ...run,
      updatedAt: new Date().toISOString(),
    }));
}

function normalizeReportOrRecordingId(prefix, item, index) {
  const existing = String((item && item.id) || '').trim();
  if (existing) return existing;
  return `${prefix}-${Date.now()}-${index}`;
}

async function syncByUniqueField(collection, uniqueField, docs, { replace = true } = {}) {
  if (!docs.length) {
    if (replace) {
      await collection.deleteMany({});
    }
    return;
  }

  await collection.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { [uniqueField]: doc[uniqueField] },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  if (replace) {
    await collection.deleteMany({ [uniqueField]: { $nin: docs.map((doc) => doc[uniqueField]) } });
  }
}

async function runMigration() {
  const mastersRaw = readJsonIfExists(path.resolve(dataDir, 'masters.json'), { masters: [], fetchedAt: null });
  const masterFieldsRaw = readJsonIfExists(path.resolve(dataDir, 'master-fields.json'), {});
  const testReportsRaw = readJsonIfExists(path.resolve(dataDir, 'test-reports.json'), []);
  const recordingsRaw = readJsonIfExists(path.resolve(dataDir, 'recordings.json'), []);
  const complianceRunsRaw = readJsonIfExists(path.resolve(dataDir, 'compliance-runs.json'), { runsById: {} });
  const crudResultsRaw = readJsonIfExists(path.resolve(dataDir, 'crud-results.json'), { results: [], savedAt: null });
  const dependencyConfigRaw = readJsonIfExists(dependencyConfigPath, {});
  const lastRunRaw = readJsonIfExists(lastRunStatePath, null);
  const lastPassedRaw = readJsonIfExists(lastPassedStatePath, null);

  const mastersDoc = {
    _id: 'singleton',
    masters: Array.isArray(mastersRaw && mastersRaw.masters) ? mastersRaw.masters : [],
    fetchedAt: (mastersRaw && mastersRaw.fetchedAt) || null,
    updatedAt: new Date().toISOString(),
  };

  const masterFieldDocs = normalizeMasterFields(masterFieldsRaw);
  const reportDocs = (Array.isArray(testReportsRaw) ? testReportsRaw : []).map((entry, index) => ({
    ...entry,
    id: normalizeReportOrRecordingId('report', entry, index),
  }));
  const recordingDocs = (Array.isArray(recordingsRaw) ? recordingsRaw : []).map((entry, index) => ({
    ...entry,
    id: normalizeReportOrRecordingId('recording', entry, index),
  }));
  const complianceRunDocs = normalizeComplianceRuns(complianceRunsRaw);
  const dependencyDocs = normalizeDependencyConfig(dependencyConfigRaw);
  const templateStateDocs = [
    lastRunRaw ? { stateType: 'lastRun', ...lastRunRaw, updatedAt: new Date().toISOString() } : null,
    lastPassedRaw ? { stateType: 'lastPassed', ...lastPassedRaw, updatedAt: new Date().toISOString() } : null,
  ].filter(Boolean);
  const crudResultsDoc = {
    _id: 'latest',
    results: Array.isArray(crudResultsRaw && crudResultsRaw.results) ? crudResultsRaw.results : [],
    savedAt: (crudResultsRaw && crudResultsRaw.savedAt) || null,
    updatedAt: new Date().toISOString(),
  };

  const plan = {
    dryRun,
    collections: {
      [COLLECTIONS.mastersCache]: 1,
      [COLLECTIONS.masterFieldsCache]: masterFieldDocs.length,
      [COLLECTIONS.testReports]: reportDocs.length,
      [COLLECTIONS.recordings]: recordingDocs.length,
      [COLLECTIONS.complianceRuns]: complianceRunDocs.length,
      [COLLECTIONS.crudResults]: 1,
      [COLLECTIONS.dependencyConfigs]: dependencyDocs.length,
      [COLLECTIONS.templateWorkflowStates]: templateStateDocs.length,
    },
  };

  console.log('[migration] Source counts:', JSON.stringify(plan.collections, null, 2));

  if (dryRun) {
    console.log('[migration] Dry run complete. No database writes performed.');
    return;
  }

  const db = await getDb();

  await db.collection(COLLECTIONS.mastersCache).updateOne(
    { _id: 'singleton' },
    { $set: mastersDoc },
    { upsert: true }
  );

  await syncByUniqueField(db.collection(COLLECTIONS.masterFieldsCache), 'masterName', masterFieldDocs);
  await syncByUniqueField(db.collection(COLLECTIONS.testReports), 'id', reportDocs);
  await syncByUniqueField(db.collection(COLLECTIONS.recordings), 'id', recordingDocs);
  await syncByUniqueField(db.collection(COLLECTIONS.complianceRuns), 'runId', complianceRunDocs);
  await db.collection(COLLECTIONS.crudResults).updateOne(
    { _id: 'latest' },
    { $set: crudResultsDoc },
    { upsert: true }
  );
  await syncByUniqueField(db.collection(COLLECTIONS.dependencyConfigs), 'masterName', dependencyDocs);
  await syncByUniqueField(db.collection(COLLECTIONS.templateWorkflowStates), 'stateType', templateStateDocs);

  console.log('[migration] Migration completed successfully.');
}

runMigration()
  .catch((error) => {
    console.error('[migration] Failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoClient().catch(() => {});
  });
