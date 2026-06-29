const { getDb } = require('./mongoClient');

const COLLECTIONS = {
  mastersCache: 'masters_cache',
  masterFieldsCache: 'master_fields_cache',
  testReports: 'test_reports',
  recordings: 'recordings',
  complianceRuns: 'compliance_runs',
  crudResults: 'crud_results',
  dependencyConfigs: 'dependency_configs',
  templateWorkflowStates: 'template_workflow_states',
};

const state = {
  masters: [],
  mastersFetchedAt: null,
  masterFieldsMap: new Map(),
  testReports: [],
  recordings: [],
  complianceRunsStore: { runsById: {} },
  dependencyConfig: {},
  crudResults: { results: [], savedAt: null },
  templateWorkflowStates: {
    lastRun: null,
    lastPassed: null,
  },
};

let initialized = false;
let initPromise = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMasterFieldEntry(entry, fallbackFetchedAt = null) {
  const fields = Array.isArray(entry && entry.fields) ? entry.fields : [];
  return {
    fetchedAt: (entry && entry.fetchedAt) || fallbackFetchedAt || null,
    fields,
  };
}

function normalizeRunsStore(store) {
  const runsById =
    store && typeof store === 'object' && store.runsById && typeof store.runsById === 'object'
      ? store.runsById
      : {};
  return { runsById: cloneValue(runsById) };
}

function normalizeCrudResults(payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return {
    results: cloneValue(results),
    savedAt: (payload && payload.savedAt) || null,
  };
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection(COLLECTIONS.masterFieldsCache).createIndex({ masterName: 1 }, { unique: true }),
    db.collection(COLLECTIONS.testReports).createIndex({ createdAt: -1 }),
    db.collection(COLLECTIONS.testReports).createIndex({ masterName: 1, operation: 1, createdAt: -1 }),
    db.collection(COLLECTIONS.recordings).createIndex({ createdAt: -1 }),
    db.collection(COLLECTIONS.recordings).createIndex({ masterName: 1, createdAt: -1 }),
    db.collection(COLLECTIONS.complianceRuns).createIndex({ runId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.dependencyConfigs).createIndex({ masterName: 1 }, { unique: true }),
    db.collection(COLLECTIONS.templateWorkflowStates).createIndex({ stateType: 1 }, { unique: true }),
  ]);
}

async function loadMastersState(db) {
  const doc = await db.collection(COLLECTIONS.mastersCache).findOne({ _id: 'singleton' });
  state.masters = Array.isArray(doc && doc.masters) ? doc.masters : [];
  state.mastersFetchedAt = (doc && doc.fetchedAt) || null;
}

async function loadMasterFieldsState(db) {
  const docs = await db.collection(COLLECTIONS.masterFieldsCache).find({}).toArray();
  const nextMap = new Map();
  docs.forEach((doc) => {
    const masterName = String((doc && doc.masterName) || '').trim();
    if (!masterName) return;
    nextMap.set(masterName, normalizeMasterFieldEntry(doc));
  });
  state.masterFieldsMap = nextMap;
}

async function loadTestReportsState(db) {
  const docs = await db
    .collection(COLLECTIONS.testReports)
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  state.testReports = docs.map((doc) => {
    const { _id, ...rest } = doc;
    return rest;
  });
}

async function loadRecordingsState(db) {
  const docs = await db
    .collection(COLLECTIONS.recordings)
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  state.recordings = docs.map((doc) => {
    const { _id, ...rest } = doc;
    return rest;
  });
}

async function loadComplianceRunsState(db) {
  const docs = await db.collection(COLLECTIONS.complianceRuns).find({}).toArray();
  const runsById = {};
  docs.forEach((doc) => {
    if (!doc || !doc.runId) return;
    const { _id, ...rest } = doc;
    runsById[doc.runId] = rest;
  });
  state.complianceRunsStore = { runsById };
}

async function loadDependencyConfigState(db) {
  const docs = await db.collection(COLLECTIONS.dependencyConfigs).find({}).toArray();
  const config = {};
  docs.forEach((doc) => {
    const masterName = String((doc && doc.masterName) || '').trim();
    if (!masterName) return;
    config[masterName] = {
      parentDropdowns: Array.isArray(doc.parentDropdowns) ? doc.parentDropdowns : [],
      dependentDropdowns: Array.isArray(doc.dependentDropdowns) ? doc.dependentDropdowns : [],
    };
  });
  state.dependencyConfig = config;
}

async function loadCrudResultsState(db) {
  const doc = await db.collection(COLLECTIONS.crudResults).findOne({ _id: 'latest' });
  if (!doc) {
    state.crudResults = { results: [], savedAt: null };
    return;
  }
  const { _id, ...rest } = doc;
  state.crudResults = normalizeCrudResults(rest);
}

async function loadTemplateWorkflowState(db) {
  const docs = await db.collection(COLLECTIONS.templateWorkflowStates).find({}).toArray();
  const next = { lastRun: null, lastPassed: null };
  docs.forEach((doc) => {
    const stateType = String((doc && doc.stateType) || '').trim();
    if (!stateType) return;
    const { _id, ...rest } = doc;
    delete rest.stateType;
    if (stateType === 'lastRun') next.lastRun = rest;
    if (stateType === 'lastPassed') next.lastPassed = rest;
  });
  state.templateWorkflowStates = next;
}

async function initStorage() {
  if (initialized) return state;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = await getDb();
    await ensureIndexes(db);
    await Promise.all([
      loadMastersState(db),
      loadMasterFieldsState(db),
      loadTestReportsState(db),
      loadRecordingsState(db),
      loadComplianceRunsState(db),
      loadDependencyConfigState(db),
      loadCrudResultsState(db),
      loadTemplateWorkflowState(db),
    ]);
    initialized = true;
    return state;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

function isInitialized() {
  return initialized;
}

function getMastersCache() {
  return {
    masters: cloneValue(state.masters),
    fetchedAt: state.mastersFetchedAt,
  };
}

async function setMastersCache(masters, fetchedAt) {
  state.masters = Array.isArray(masters) ? cloneValue(masters) : [];
  state.mastersFetchedAt = fetchedAt || new Date().toISOString();

  const db = await getDb();
  await db.collection(COLLECTIONS.mastersCache).updateOne(
    { _id: 'singleton' },
    {
      $set: {
        masters: state.masters,
        fetchedAt: state.mastersFetchedAt,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

function getMasterFieldsMap() {
  return new Map(Array.from(state.masterFieldsMap.entries()).map(([key, value]) => [key, cloneValue(value)]));
}

async function setMasterFieldsMap(cacheMap) {
  const nextMap = new Map();
  const inputEntries = cacheMap instanceof Map ? Array.from(cacheMap.entries()) : Object.entries(cacheMap || {});

  inputEntries.forEach(([masterName, value]) => {
    const normalizedMasterName = String(masterName || '').trim();
    if (!normalizedMasterName) return;
    nextMap.set(normalizedMasterName, normalizeMasterFieldEntry(value));
  });

  state.masterFieldsMap = nextMap;

  const docs = Array.from(nextMap.entries()).map(([masterName, value]) => ({
    masterName,
    fetchedAt: value.fetchedAt || null,
    fields: Array.isArray(value.fields) ? value.fields : [],
    updatedAt: new Date().toISOString(),
  }));

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.masterFieldsCache);

  if (!docs.length) {
    await collection.deleteMany({});
    return;
  }

  await collection.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { masterName: doc.masterName },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  await collection.deleteMany({ masterName: { $nin: docs.map((doc) => doc.masterName) } });
}

function getTestReports() {
  return cloneValue(state.testReports);
}

async function appendTestReport(entry) {
  const payload = cloneValue(entry || {});
  state.testReports = [payload, ...state.testReports];

  const db = await getDb();
  await db.collection(COLLECTIONS.testReports).insertOne(payload);
}

function getComplianceRunsStore() {
  return normalizeRunsStore(state.complianceRunsStore);
}

async function setComplianceRunsStore(store) {
  state.complianceRunsStore = normalizeRunsStore(store);

  const runsById = state.complianceRunsStore.runsById;
  const docs = Object.values(runsById).filter((run) => run && run.runId);
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.complianceRuns);

  if (!docs.length) {
    await collection.deleteMany({});
    return;
  }

  await collection.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { runId: doc.runId },
        update: { $set: { ...cloneValue(doc), updatedAt: new Date().toISOString() } },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  await collection.deleteMany({ runId: { $nin: docs.map((doc) => doc.runId) } });
}

function getRecordingsIndex() {
  return cloneValue(state.recordings);
}

async function setRecordingsIndex(entries) {
  const normalized = Array.isArray(entries) ? cloneValue(entries) : [];
  state.recordings = normalized;

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.recordings);

  await collection.deleteMany({});
  if (state.recordings.length) {
    await collection.insertMany(state.recordings);
  }
}

function getDependencyConfig() {
  return cloneValue(state.dependencyConfig);
}

async function setDependencyConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  state.dependencyConfig = cloneValue(source);

  const docs = Object.entries(state.dependencyConfig).map(([masterName, value]) => ({
    masterName,
    parentDropdowns: Array.isArray(value && value.parentDropdowns) ? value.parentDropdowns : [],
    dependentDropdowns: Array.isArray(value && value.dependentDropdowns) ? value.dependentDropdowns : [],
    updatedAt: new Date().toISOString(),
  }));

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.dependencyConfigs);

  if (!docs.length) {
    await collection.deleteMany({});
    return;
  }

  await collection.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { masterName: doc.masterName },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  await collection.deleteMany({ masterName: { $nin: docs.map((doc) => doc.masterName) } });
}

function getCrudResults() {
  return normalizeCrudResults(state.crudResults);
}

async function setCrudResults(payload) {
  state.crudResults = normalizeCrudResults(payload);

  const db = await getDb();
  await db.collection(COLLECTIONS.crudResults).updateOne(
    { _id: 'latest' },
    {
      $set: {
        ...cloneValue(state.crudResults),
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

function getTemplateWorkflowState(stateType) {
  if (stateType === 'lastRun') return state.templateWorkflowStates.lastRun ? cloneValue(state.templateWorkflowStates.lastRun) : null;
  if (stateType === 'lastPassed') return state.templateWorkflowStates.lastPassed ? cloneValue(state.templateWorkflowStates.lastPassed) : null;
  return null;
}

async function setTemplateWorkflowState(stateType, payload) {
  if (stateType !== 'lastRun' && stateType !== 'lastPassed') {
    throw new Error(`Invalid stateType ${stateType}`);
  }

  const safePayload = payload && typeof payload === 'object' ? cloneValue(payload) : null;
  state.templateWorkflowStates[stateType] = safePayload;

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.templateWorkflowStates);

  if (!safePayload) {
    await collection.deleteOne({ stateType });
    return;
  }

  await collection.updateOne(
    { stateType },
    {
      $set: {
        stateType,
        ...safePayload,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

module.exports = {
  COLLECTIONS,
  initStorage,
  isInitialized,
  getMastersCache,
  setMastersCache,
  getMasterFieldsMap,
  setMasterFieldsMap,
  getTestReports,
  appendTestReport,
  getComplianceRunsStore,
  setComplianceRunsStore,
  getRecordingsIndex,
  setRecordingsIndex,
  getDependencyConfig,
  setDependencyConfig,
  getCrudResults,
  setCrudResults,
  getTemplateWorkflowState,
  setTemplateWorkflowState,
};
 