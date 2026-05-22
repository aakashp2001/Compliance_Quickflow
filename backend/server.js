const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const items = [];
const masterFieldsDataPath = path.resolve(__dirname, 'data', 'master-fields.json');

function readMasterFields() {
  try {
    if (!fs.existsSync(masterFieldsDataPath)) return new Map();
    const raw = fs.readFileSync(masterFieldsDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function writeMasterFields(cacheMap) {
  ensureDir(path.dirname(masterFieldsDataPath));
  const obj = Object.fromEntries(cacheMap);
  fs.writeFileSync(masterFieldsDataPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
}

const masterFieldsCache = readMasterFields();
// Ensure the cache file exists on startup so frontend can reload from disk-backed JSON.
writeMasterFields(masterFieldsCache);
const dependencyConfigPath = path.resolve(__dirname, '..', 'playwright-tests', 'helpers', 'dependent-dropdowns.json');
const testReportArtifactsDir = path.resolve(__dirname, '..', 'playwright-tests', 'test-reports');
const testReportsDataPath = path.resolve(__dirname, 'data', 'test-reports.json');
const complianceRunsDataPath = path.resolve(__dirname, 'data', 'compliance-runs.json');
const recordingsDataPath = path.resolve(__dirname, 'data', 'recordings.json');
const mastersDataPath = path.resolve(__dirname, 'data', 'masters.json');
const templateWorkflowFlowStatePath = path.resolve(__dirname, '..', 'playwright-tests', '.template-workflow-flow.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readTestReports() {
  try {
    if (!fs.existsSync(testReportsDataPath)) return [];
    const raw = fs.readFileSync(testReportsDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTestReports(entries) {
  ensureDir(path.dirname(testReportsDataPath));
  fs.writeFileSync(testReportsDataPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

function appendTestReport(entry) {
  const existing = readTestReports();
  existing.unshift(entry);
  writeTestReports(existing.slice(0, 500));
}

function readComplianceRunsStore() {
  try {
    if (!fs.existsSync(complianceRunsDataPath)) return { runsById: {} };
    const raw = fs.readFileSync(complianceRunsDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const runsById = parsed && typeof parsed === 'object' && parsed.runsById && typeof parsed.runsById === 'object'
      ? parsed.runsById
      : {};
    return { runsById };
  } catch {
    return { runsById: {} };
  }
}

function writeComplianceRunsStore(store) {
  ensureDir(path.dirname(complianceRunsDataPath));
  fs.writeFileSync(complianceRunsDataPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function readRecordingsIndex() {
  try {
    if (!fs.existsSync(recordingsDataPath)) return [];
    const raw = fs.readFileSync(recordingsDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecordingsIndex(entries) {
  ensureDir(path.dirname(recordingsDataPath));
  fs.writeFileSync(recordingsDataPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

function readMasters() {
  try {
    if (!fs.existsSync(mastersDataPath)) return { masters: [], fetchedAt: null };
    const raw = fs.readFileSync(mastersDataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      masters: Array.isArray(parsed?.masters) ? parsed.masters : [],
      fetchedAt: parsed?.fetchedAt || null,
    };
  } catch {
    return { masters: [], fetchedAt: null };
  }
}

function writeMasters(masters, fetchedAt) {
  ensureDir(path.dirname(mastersDataPath));
  const payload = { masters, fetchedAt: fetchedAt || new Date().toISOString() };
  fs.writeFileSync(mastersDataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

// Initialize masters cache from file
const initialMasters = readMasters();
let mastersCache = initialMasters.masters;
let mastersFetchedAt = initialMasters.fetchedAt;

function normalizeFieldCacheEntry(entry, fallbackFetchedAt = null) {
  const fields = Array.isArray(entry?.fields) ? entry.fields : [];
  return {
    fetchedAt: entry?.fetchedAt || fallbackFetchedAt || null,
    fields,
  };
}

function getSerializableMasterFieldsMap() {
  const out = {};
  for (const [masterName, value] of masterFieldsCache.entries()) {
    out[masterName] = normalizeFieldCacheEntry(value);
  }
  return out;
}

function syncMasterFieldsCacheForMasters(masters, fallbackFetchedAt) {
  const list = Array.isArray(masters) ? masters : [];

  for (const master of list) {
    const masterName = String(master?.name || '').trim();
    if (!masterName) continue;

    const embeddedFields = Array.isArray(master?.fields) ? master.fields : null;
    const existing = masterFieldsCache.get(masterName);

    if (embeddedFields) {
      masterFieldsCache.set(masterName, {
        fetchedAt: fallbackFetchedAt || new Date().toISOString(),
        fields: embeddedFields,
      });
      continue;
    }

    if (existing) {
      masterFieldsCache.set(masterName, normalizeFieldCacheEntry(existing, fallbackFetchedAt));
      continue;
    }

    masterFieldsCache.set(masterName, {
      fetchedAt: null,
      fields: [],
    });
  }

  writeMasterFields(masterFieldsCache);
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatOperation(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}`;
}

function getVideoArtifactSnapshot() {
  ensureDir(testReportArtifactsDir);
  const entries = fs.readdirSync(testReportArtifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(webm|mp4)$/i.test(name))
    .map((name) => {
      const absolutePath = path.join(testReportArtifactsDir, name);
      const stats = fs.statSync(absolutePath);
      return {
        name,
        absolutePath,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        createdAt: stats.mtime.toISOString(),
      };
    });

  return new Map(entries.map((entry) => [entry.name, entry]));
}

function beginRecordingCapture() {
  return {
    startedAt: Date.now(),
    snapshot: getVideoArtifactSnapshot(),
  };
}

function stripNumberedRecordingSuffix(name) {
  const ext = path.extname(name || '');
  const base = ext ? String(name || '').slice(0, -ext.length) : String(name || '');
  return `${base.replace(/-\d+$/, '')}${ext}`;
}

function collapseRecordingVariants(files, index) {
  const grouped = new Map();

  files.forEach((file) => {
    const meta = index.find((entry) => entry.name === file.name);
    const kind = meta?.kind || '';
    const isFetchMasters = kind === 'fetch-masters' || /fetch-masters/i.test(file.name);
    const groupKey = isFetchMasters ? stripNumberedRecordingSuffix(file.name) : file.name;
    const existing = grouped.get(groupKey);

    if (!existing) {
      grouped.set(groupKey, { file, meta });
      return;
    }

    const existingSize = existing.file?.sizeBytes || 0;
    const nextSize = file?.sizeBytes || 0;
    const existingTime = new Date(existing.meta?.createdAt || existing.file?.createdAt || 0).getTime();
    const nextTime = new Date(meta?.createdAt || file?.createdAt || 0).getTime();

    if (nextSize > existingSize || (nextSize === existingSize && nextTime > existingTime)) {
      grouped.set(groupKey, { file, meta });
    }
  });

  return Array.from(grouped.values());
}

function buildRecordingTitle(meta) {
  if (meta.kind === 'crud') {
    return `CRUD ${String(meta.operation || 'all').toUpperCase()} - ${meta.masterName || 'Master'}`;
  }
  if (meta.kind === 'mandatory') {
    return `Mandatory Fields - ${meta.masterName || 'Master'}`;
  }
  if (meta.kind === 'compare-field') {
    return `Compare ${meta.sourceMaster || 'Source'} vs ${meta.targetMaster || 'Target'}`;
  }
  if (meta.kind === 'fetch-fields') {
    return `Fetch Fields - ${meta.masterName || 'Master'}`;
  }
  if (meta.kind === 'fetch-masters') {
    return 'Fetch Masters';
  }
  if (meta.kind === 'create-template') {
    return `Create Template Entry${meta.templateName ? ` - ${meta.templateName}` : ''}`;
  }
  if (meta.kind === 'template-workflow') {
    return 'Template Workflow Full Test';
  }
  return meta.kind || 'Test Recording';
}

function buildRecordingDescription(meta) {
  if (meta.kind === 'crud') {
    return `QuickFlow CRUD run for ${meta.masterName || 'master'} using ${meta.operation || 'all'} operation${meta.verifyAuditTrail ? ' with audit verification' : ''}.`;
  }
  if (meta.kind === 'mandatory') {
    return `Mandatory field validation run for ${meta.masterName || 'master'}: navigate, click Create, click Save on empty form, capture required validations.`;
  }
  if (meta.kind === 'compare-field') {
    return `Dropdown/table comparison from ${meta.sourceMaster || 'source master'} to ${meta.targetMaster || 'target master'}${meta.fieldName ? ` for field ${meta.fieldName}` : ''}.`;
  }
  if (meta.kind === 'fetch-fields') {
    return `Field discovery run for ${meta.masterName || 'master'} create form.`;
  }
  if (meta.kind === 'fetch-masters') {
    return 'Master discovery run that logs in and fetches the available QuickFlow masters.';
  }
  if (meta.kind === 'create-template') {
    return `Template entry creation run${meta.templateName ? ` for template ${meta.templateName}` : ''}.`;
  }
  if (meta.kind === 'template-workflow') {
    return 'Full template workflow run: create site, app, main template, child sub-template, assign workflow, switch app, and check audit trail.';
  }
  return 'QuickFlow automated test recording.';
}

function buildLegacyRecordingFallback(fileName) {
  const rawName = String(fileName || '');
  const lowerName = rawName.toLowerCase();
  const withoutExt = rawName.replace(/\.[^.]+$/, '');
  const cleanedName = withoutExt
    .replace(/^\d{4}-\d{2}-\d{2}t\d{2}(?:[-:])\d{2}(?:[-:])\d{2}(?:[-:.])\d+z-?/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (
    /template-workflow/.test(lowerName) ||
    /create-template-(run|temp)/.test(lowerName) ||
    /^page@.+\.webm$/i.test(rawName)
  ) {
    return {
      kind: 'template-workflow',
      title: 'Template Workflow Full Test',
      description: 'Legacy Template Workflow recording (metadata backfilled from filename).',
    };
  }

  return {
    kind: 'legacy-recording',
    title: cleanedName ? `Legacy Recording - ${cleanedName}` : 'Legacy Recording',
    description: 'Older recording without saved metadata.',
  };
}

async function finalizeRecordingCapture(capture, meta = {}) {
  if (!capture || !capture.snapshot) return [];

  const afterSnapshot = getVideoArtifactSnapshot();
  let newEntries = Array.from(afterSnapshot.values())
    .filter((entry) => {
      const before = capture.snapshot.get(entry.name);
      if (!before) return true;
      return entry.mtimeMs > capture.startedAt && entry.sizeBytes !== before.sizeBytes;
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let discardedEntries = [];

  if (meta.keepPrimaryOnly) {
    const preferredName = path.basename(String(meta.primaryVideoName || ''));
    const preferredEntry = preferredName
      ? newEntries.find((entry) => entry.name === preferredName)
      : null;

    if (preferredEntry) {
      discardedEntries = newEntries.filter((entry) => entry.name !== preferredEntry.name);
      newEntries = [preferredEntry];
    } else if (newEntries.length > 1) {
      const chosen = newEntries.reduce((largest, entry) => (
        (entry.sizeBytes || 0) > (largest.sizeBytes || 0) ? entry : largest
      ));
      discardedEntries = newEntries.filter((entry) => entry.name !== chosen.name);
      newEntries = [chosen];
    }

    // Remove extra freshly created recordings for this run so only one appears in listing.
    for (const entry of discardedEntries) {
      try {
        if (entry?.absolutePath && fs.existsSync(entry.absolutePath)) {
          fs.unlinkSync(entry.absolutePath);
        }
      } catch {
        // Non-fatal: ignore cleanup failures.
      }
    }
  }

  if (newEntries.length === 0) return [];

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseParts = [
    timestamp,
    normalizeSlug(meta.kind || 'test'),
    normalizeSlug(meta.masterName || meta.sourceMaster || meta.targetMaster || meta.templateName || 'run'),
    normalizeSlug(meta.operation || meta.fieldName || ''),
  ].filter(Boolean);
  const baseName = baseParts.join('-');

  const existingIndex = readRecordingsIndex();
  const saved = [];


  for (let [index, entry] of newEntries.entries()) {
    const ext = path.extname(entry.name) || '.webm';
    const preferredName = `${baseName}${newEntries.length > 1 ? `-${index + 1}` : ''}${ext}`;
    const finalName = preferredName && preferredName !== entry.name ? preferredName : entry.name;
    const finalPath = path.join(testReportArtifactsDir, finalName);

    // Robust retry for EBUSY/locked files (Windows/Playwright video)
    async function tryRenameWithRetry(src, dest, maxAttempts = 5, delayMs = 300) {
      // Increase attempts and delay for Windows file locks
      maxAttempts = 15;
      delayMs = 500;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          fs.renameSync(src, dest);
          return true;
        } catch (err) {
          if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
            if (attempt === maxAttempts) throw err;
            await new Promise((res) => setTimeout(res, delayMs));
            continue;
          }
          throw err;
        }
      }
      return false;
    }

    if (finalName !== entry.name && !fs.existsSync(finalPath)) {
      await tryRenameWithRetry(entry.absolutePath, finalPath);
      entry.name = finalName;
      entry.absolutePath = finalPath;
    }

    const finalStats = fs.statSync(entry.absolutePath);
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: entry.name,
      title: buildRecordingTitle(meta),
      description: buildRecordingDescription(meta),
      kind: meta.kind || 'test',
      masterName: meta.masterName || '',
      operation: meta.operation || '',
      sourceMaster: meta.sourceMaster || '',
      targetMaster: meta.targetMaster || '',
      fieldName: meta.fieldName || '',
      templateName: meta.templateName || '',
      status: meta.status || 'completed',
      verifyAuditTrail: meta.verifyAuditTrail === true,
      createdAt: finalStats.mtime.toISOString(),
      sizeBytes: finalStats.size,
    };
    saved.push(record);
  }

  const filteredExisting = existingIndex.filter((item) => !saved.some((record) => record.name === item.name));
  writeRecordingsIndex([...saved.reverse(), ...filteredExisting].slice(0, 500));
  return saved;
}

async function finalizeRecordingCaptureSafe(capture, meta = {}) {
  try {
    return await finalizeRecordingCapture(capture, meta);
  } catch (error) {
    const kind = String(meta?.kind || 'unknown');
    const master = String(meta?.masterName || '');
    const op = String(meta?.operation || '');
    const details = [kind, master, op].filter(Boolean).join(' | ');
    console.error(`[recordings] finalize failed${details ? ` (${details})` : ''}:`, error?.message || error);
    return [];
  }
}

ensureDir(testReportArtifactsDir);
app.use('/test-report-artifacts', express.static(testReportArtifactsDir));

function readDependencyConfig() {
  try {
    if (!fs.existsSync(dependencyConfigPath)) {
      return {};
    }
    const raw = fs.readFileSync(dependencyConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUniqueStringList(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  values.forEach((item) => {
    const text = String(item || '').trim();
    if (text) unique.add(text);
  });
  return Array.from(unique);
}

function writeDependencyConfig(config) {
  const dir = path.dirname(dependencyConfigPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dependencyConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function getMasterDependencyEntry(config, masterName) {
  const target = String(masterName || '').trim().toLowerCase();
  const key = Object.keys(config).find((name) => String(name).trim().toLowerCase() === target);
  const entry = key ? config[key] : null;

  if (!entry || typeof entry !== 'object') {
    return {
      key: masterName,
      value: {
        parentDropdowns: [],
        dependentDropdowns: [],
      },
    };
  }

  return {
    key,
    value: {
      parentDropdowns: normalizeUniqueStringList(entry.parentDropdowns),
      dependentDropdowns: normalizeUniqueStringList(entry.dependentDropdowns),
    },
  };
}

function autoSaveDetectedDependencies(masterName, detected) {
  if (
    !detected ||
    (detected.parentDropdowns?.length || 0) === 0 &&
    (detected.dependentDropdowns?.length || 0) === 0
  ) {
    return;
  }

  try {
    const existingConfig = readDependencyConfig();
    const existingEntry = getMasterDependencyEntry(existingConfig, masterName);
    const hasExisting =
      existingEntry.value.parentDropdowns.length > 0 ||
      existingEntry.value.dependentDropdowns.length > 0;

    if (!hasExisting) {
      const keyToUse = existingEntry.key || masterName;
      existingConfig[keyToUse] = {
        parentDropdowns: normalizeUniqueStringList(detected.parentDropdowns),
        dependentDropdowns: normalizeUniqueStringList(detected.dependentDropdowns),
      };
      writeDependencyConfig(existingConfig);
      process.stderr.write(
        `[AUTO-DEP] Saved detected dependency config for "${masterName}": ` +
        `parents=[${(detected.parentDropdowns || []).join(', ')}] ` +
        `dependents=[${(detected.dependentDropdowns || []).join(', ')}]\n`
      );
    }
  } catch {
    // Non-fatal: dependency save failure should not break field fetch response
  }
}

function runFetchMastersScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'fetch-masters.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 80 * 1024 * 1024,
      timeout: 30 * 60 * 1000, // 30 min max (inline master+field discovery can take longer)
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Failed to run master fetch script'));
        return;
      }

      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        // Attach debug log so frontend can show if 0 masters are found
        parsed._debug = (stderr || '').toString().trim();
        resolve(parsed);
      } catch {
        const debug = (stderr || '').toString().trim();
        reject(new Error('Master fetch script did not return valid JSON output' + (debug ? ': ' + debug : '')));
      }
    });
  });
}

function runFetchMasterFieldsScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'fetch-master-fields.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Failed to run field fetch script'));
        return;
      }

      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        resolve(parsed);
      } catch {
        reject(new Error('Field fetch script did not return valid JSON output'));
      }
    });
  });
}

function runFetchAllMasterFieldsScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'fetch-all-master-fields.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 40 * 1024 * 1024,
      timeout: 20 * 60 * 1000, // 20 min max for bulk field extraction
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Failed to run bulk field fetch script'));
        return;
      }

      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        resolve(parsed);
      } catch {
        reject(new Error('Bulk field fetch script did not return valid JSON output'));
      }
    });
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/items', (req, res) => {
  res.json(items);
});

app.post('/api/items', (req, res) => {
  const { name, description = '' } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'name is required' });
  }

  const item = {
    id: items.length + 1,
    name: name.trim(),
    description: String(description || '').trim(),
  };

  items.push(item);
  return res.status(201).json(item);
});

app.get('/api/masters', (req, res) => {
  res.json({
    count: mastersCache.length,
    fetchedAt: mastersFetchedAt,
    masters: mastersCache,
    masterFieldsCache: getSerializableMasterFieldsMap(),
  });
});

app.get('/api/test-reports', (req, res) => {
  const reports = readTestReports();
  return res.json({
    count: reports.length,
    reports,
  });
});

app.get('/api/recordings', (req, res) => {
  try {
    ensureDir(testReportArtifactsDir);
    const index = readRecordingsIndex();
    const snapshot = collapseRecordingVariants(Array.from(getVideoArtifactSnapshot().values()), index);

    const recordings = snapshot.map(({ file, meta }) => {
      const fallback = (!meta || !meta.title || !meta.description || !meta.kind)
        ? buildLegacyRecordingFallback(file?.name)
        : null;

      return {
        id: meta?.id || file.name,
        name: file.name,
        url: `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(file.name)}`,
        sizeBytes: file.sizeBytes,
        createdAt: meta?.createdAt || file.createdAt,
        title: meta?.title || fallback?.title || 'Recording details unavailable',
        description: meta?.description || fallback?.description || 'Older recording without saved test metadata.',
        kind: meta?.kind || fallback?.kind || 'unknown',
        masterName: meta?.masterName || '',
        operation: meta?.operation || '',
        sourceMaster: meta?.sourceMaster || '',
        targetMaster: meta?.targetMaster || '',
        fieldName: meta?.fieldName || '',
        templateName: meta?.templateName || '',
        status: meta?.status || 'completed',
        verifyAuditTrail: meta?.verifyAuditTrail === true,
      };
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.json({
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    return res.status(500).json({
      message: error?.message || 'Failed to list recordings',
    });
  }
});

// ─── Save CRUD results from frontend ──────────────────────────────────────────
const crudResultsPath = path.resolve(__dirname, 'data', 'crud-results.json');

app.post('/api/save-results', (req, res) => {
  try {
    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    const payload = { results, savedAt: new Date().toISOString() };
    fs.writeFileSync(crudResultsPath, JSON.stringify(payload, null, 2), 'utf8');
    return res.json({ ok: true, count: results.length });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Failed to save results' });
  }
});

app.get('/api/saved-results', (req, res) => {
  try {
    if (!fs.existsSync(crudResultsPath)) return res.json({ results: [], savedAt: null });
    const data = JSON.parse(fs.readFileSync(crudResultsPath, 'utf8'));
    return res.json(data);
  } catch {
    return res.json({ results: [], savedAt: null });
  }
});

app.post('/api/masters/fetch', async (req, res) => {
  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const showBrowser = req.body?.showBrowser !== false;
  const fetchFieldsOnMasterFetch = req.body?.fetchFieldsOnMasterFetch !== false;
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runFetchMastersScript({
      ...process.env,
      QT_URL: loginUrl,
      QT_USER: username,
      QT_PASS: password,
      QT_HEADLESS: showBrowser ? 'false' : 'true',
      QT_FETCH_FIELDS_WITH_MASTERS: fetchFieldsOnMasterFetch ? 'true' : 'false',
    });

    mastersCache = result.masters || [];
    mastersFetchedAt = result.fetchedAt || new Date().toISOString();
    writeMasters(mastersCache, mastersFetchedAt);
    syncMasterFieldsCacheForMasters(mastersCache, mastersFetchedAt);

    const embeddedFieldMasters = mastersCache.filter((m) => Array.isArray(m?.fields));
    const hasInlineFieldsForAllMasters = mastersCache.length > 0 && embeddedFieldMasters.length === mastersCache.length;

    let bulkFieldFetch = { attempted: false, completed: false, count: 0, failedCount: 0 };
    if (fetchFieldsOnMasterFetch && hasInlineFieldsForAllMasters) {
      bulkFieldFetch = {
        attempted: true,
        completed: true,
        count: embeddedFieldMasters.length,
        failedCount: 0,
        mode: 'inline-discovery',
      };
    } else if (fetchFieldsOnMasterFetch && mastersCache.length > 0) {
      bulkFieldFetch.attempted = true;
      const masterNames = mastersCache
        .filter((m) => !Array.isArray(m?.fields))
        .map((m) => String(m?.name || '').trim())
        .filter(Boolean);
      if (masterNames.length === 0) {
        bulkFieldFetch = {
          attempted: true,
          completed: true,
          count: embeddedFieldMasters.length,
          failedCount: 0,
          mode: 'inline-discovery',
        };
      } else {
      try {
        const allFieldResult = await runFetchAllMasterFieldsScript({
          ...process.env,
          QT_URL: loginUrl,
          QT_USER: username,
          QT_PASS: password,
          QT_HEADLESS: showBrowser ? 'false' : 'true',
          QT_MASTERS_JSON: JSON.stringify(masterNames),
        });

        const results = Array.isArray(allFieldResult?.results) ? allFieldResult.results : [];
        let failedCount = 0;

        results.forEach((entry) => {
          const masterName = String(entry?.master || '').trim();
          if (!masterName) return;

          const hasError = String(entry?.error || '').trim().length > 0;
          const fields = Array.isArray(entry?.fields) ? entry.fields : [];
          const current = masterFieldsCache.get(masterName);

          if (hasError) failedCount += 1;
          const shouldOverwrite = !hasError || !current || (Array.isArray(current.fields) ? current.fields.length === 0 : true);
          if (shouldOverwrite) {
            masterFieldsCache.set(masterName, {
              fetchedAt: entry?.fetchedAt || allFieldResult?.fetchedAt || new Date().toISOString(),
              fields,
            });
          }

          autoSaveDetectedDependencies(masterName, entry?.detectedDependencies);
        });

        writeMasterFields(masterFieldsCache);
        bulkFieldFetch = {
          attempted: true,
          completed: true,
          count: results.length,
          failedCount,
        };
      } catch (bulkError) {
        bulkFieldFetch = {
          attempted: true,
          completed: false,
          count: 0,
          failedCount: masterNames.length,
          error: String(bulkError?.message || 'Bulk field fetch failed'),
        };
      }
      }
    }

    return res.json({
      count: mastersCache.length,
      fetchedAt: mastersFetchedAt,
      baseURL: result.baseURL,
      masters: mastersCache,
      masterFieldsCache: getSerializableMasterFieldsMap(),
      bulkFieldFetch,
      recordings: await finalizeRecordingCaptureSafe(recordingCapture, {
        kind: 'fetch-masters',
        status: 'completed',
        keepPrimaryOnly: true,
      }),
    });
  } catch (error) {
    // Enhanced error logging
    console.error('Error in /api/masters/fetch:', error);
    if (error && error.stack) {
      console.error('Stack trace:', error.stack);
    }
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'fetch-masters',
      status: 'failed',
      keepPrimaryOnly: true,
    });
    return res.status(500).json({
      message: error?.message || 'Failed to fetch masters',
      stack: error?.stack,
    });
  }
});

app.get('/api/masters/:masterName/fields', async (req, res) => {
  const masterName = String(req.params.masterName || '').trim();
  const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';

  if (!masterName) {
    return res.status(400).json({ message: 'masterName is required' });
  }

  if (!forceRefresh && masterFieldsCache.has(masterName)) {
    const cached = masterFieldsCache.get(masterName);
    return res.json({
      master: masterName,
      fetchedAt: cached.fetchedAt,
      fields: cached.fields,
      source: 'cache',
    });
  }

  const loginUrl = req.query.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.query.username || process.env.QT_USER || 'dhruvi';
  const password = req.query.password || process.env.QT_PASS || '';
  const showBrowser = String(req.query.showBrowser || 'true').toLowerCase() !== 'false';
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runFetchMasterFieldsScript({
      ...process.env,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_MASTER: masterName,
      QT_HEADLESS: showBrowser ? 'false' : 'true',
    });

    const payload = {
      fetchedAt: result.fetchedAt || new Date().toISOString(),
      fields: Array.isArray(result.fields) ? result.fields : [],
    };

    masterFieldsCache.set(masterName, payload);
    writeMasterFields(masterFieldsCache);

    // Auto-save detected dependency mapping when the existing saved config is empty
    const detected = result.detectedDependencies;
    autoSaveDetectedDependencies(masterName, detected);

    return res.json({
      master: masterName,
      fetchedAt: payload.fetchedAt,
      fields: payload.fields,
      source: 'live',
      detectedDependencies: detected || null,
      recordings: await finalizeRecordingCaptureSafe(recordingCapture, {
        kind: 'fetch-fields',
        masterName,
        status: 'completed',
      }),
    });
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'fetch-fields',
      masterName,
      status: 'failed',
    });
    const message = error?.message || 'Failed to fetch master fields';
    const markerPath = extractFailureScreenshotPath(message);
    const screenshotPath = markerPath || findRecentFailureScreenshot(masterName, 'fetch-fields');
    const sanitizedMessage = message.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    const shortMessage = buildReasonFromFailureText(sanitizedMessage, 'Failed to fetch master fields');
    const fileName = screenshotPath ? path.basename(screenshotPath) : '';
    const screenshotUrl = fileName ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(fileName)}` : '';

    const reportPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName,
      operation: 'fetch-fields',
      status: 'failed',
      reason: buildReasonFromFailureText(sanitizedMessage, 'Field fetch failed'),
      logs: trimReportText(sanitizedMessage),
      screenshotUrl,
      screenshotFile: fileName,
      error: sanitizedMessage,
      createdAt: new Date().toISOString(),
    };
    appendTestReport(reportPayload);

    return res.status(500).json({
      message: shortMessage,
      testReport: reportPayload,
    });
  }
});

app.get('/api/dependency-config', (req, res) => {
  const config = readDependencyConfig();
  const masterName = String(req.query.masterName || '').trim();

  if (!masterName) {
    return res.json({
      config,
      path: dependencyConfigPath,
    });
  }

  const entry = getMasterDependencyEntry(config, masterName);
  return res.json({
    masterName,
    key: entry.key,
    config: entry.value,
  });
});

app.put('/api/dependency-config/:masterName', (req, res) => {
  const masterName = String(req.params.masterName || '').trim();
  if (!masterName) {
    return res.status(400).json({ message: 'masterName is required' });
  }

  const incoming = req.body || {};
  const parentDropdowns = normalizeUniqueStringList(incoming.parentDropdowns);
  const dependentDropdowns = normalizeUniqueStringList(incoming.dependentDropdowns);

  try {
    const config = readDependencyConfig();
    const existing = getMasterDependencyEntry(config, masterName);
    const keyToUse = existing.key || masterName;

    config[keyToUse] = {
      parentDropdowns,
      dependentDropdowns,
    };

    writeDependencyConfig(config);

    return res.json({
      masterName,
      key: keyToUse,
      config: config[keyToUse],
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      message: error?.message || 'Failed to save dependency config',
    });
  }
});

// ─── Compare select field vs master table data ────────────────────────────────

function runCompareFieldScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'compare-field-master.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120000,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Compare script failed'));
        return;
      }
      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        const debugLog = (stderr || '').toString().trim();
        if (debugLog) {
          process.stderr.write(`${debugLog}\n`);
        }
        parsed._debug = debugLog;
        resolve(parsed);
      } catch {
        reject(new Error('Compare script did not return valid JSON'));
      }
    });
  });
}

app.post('/api/masters/compare-field', async (req, res) => {
  const { sourceMaster, targetMaster, fieldId, fieldIndex, fieldName } = req.body || {};

  if (!sourceMaster) return res.status(400).json({ message: 'sourceMaster is required' });
  if (!targetMaster) return res.status(400).json({ message: 'targetMaster is required' });

  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const showBrowser = req.body?.showBrowser !== false;
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runCompareFieldScript({
      ...process.env,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_MASTER: sourceMaster,
      QT_TARGET_MASTER: targetMaster,
      QT_FIELD_ID: fieldId || '',
      QT_FIELD_INDEX: String(fieldIndex || 0),
      QT_FIELD_NAME: fieldName || '',
      QT_HEADLESS: showBrowser ? 'false' : 'true',
    });

    result.recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compare-field',
      masterName: sourceMaster,
      operation: 'compare-field',
      sourceMaster,
      targetMaster,
      fieldName: fieldName || fieldId || '',
      status: 'completed',
    });
    const compareScreenshot = buildScreenshotFromPath(req, result?.screenshotPath || '');

    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: sourceMaster,
      operation: 'compare-field',
      status: result?.comparison?.isFullMatch ? 'passed' : 'failed',
      reason: buildCompareSummary(result, sourceMaster, targetMaster, fieldName || fieldId || ''),
      logs: trimReportText(result?._debug || JSON.stringify(result?.comparison || {}, null, 2)),
      screenshotUrl: compareScreenshot.screenshotUrl,
      screenshotFile: compareScreenshot.fileName,
      error: result?.comparison?.isFullMatch ? '' : trimReportText(JSON.stringify(result?.comparison || {}, null, 2)),
      sourceMaster,
      targetMaster,
      fieldName: fieldName || fieldId || '',
      createdAt: new Date().toISOString(),
    });

    return res.json(result);
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compare-field',
      masterName: sourceMaster,
      operation: 'compare-field',
      sourceMaster,
      targetMaster,
      fieldName: fieldName || fieldId || '',
      status: 'failed',
    });
    const rawMessage = String(error?.message || 'Comparison failed');
    const markerPath = extractFailureScreenshotPath(rawMessage);
    const screenshotPath = markerPath || findRecentFailureScreenshot(sourceMaster, 'compare-field');
    const message = rawMessage.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    const compareScreenshot = buildScreenshotFromPath(req, screenshotPath);
    const reportPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: sourceMaster,
      operation: 'compare-field',
      status: 'failed',
      reason: buildReasonFromFailureText(message, 'Comparison failed'),
      logs: trimReportText(message),
      screenshotUrl: compareScreenshot.screenshotUrl,
      screenshotFile: compareScreenshot.fileName,
      error: message,
      sourceMaster,
      targetMaster,
      fieldName: fieldName || fieldId || '',
      createdAt: new Date().toISOString(),
    };
    appendTestReport(reportPayload);
    return res.status(500).json({ message, testReport: reportPayload });
  }
});

// ─── CRUD operations on a master ───────────────────────────────────────────────

function runCrudMasterScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'crud-master.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 420000,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'CRUD script failed'));
        return;
      }
      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        const debugLog = (stderr || '').toString().trim();
        if (debugLog) {
          // Surface Playwright diagnostics in backend terminal.
          process.stderr.write(`${debugLog}\n`);
        }
        parsed._debug = debugLog;
        resolve(parsed);
      } catch {
        const debug = (stderr || '').toString().trim();
        reject(new Error('CRUD script did not return valid JSON' + (debug ? ': ' + debug : '')));
      }
    });
  });
}

function runCreateTemplateEntryScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'create-template-entry.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 420000,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Create template entry script failed'));
        return;
      }

      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        parsed._debug = (stderr || '').toString().trim();
        resolve(parsed);
      } catch {
        reject(new Error('Create template entry script did not return valid JSON'));
      }
    });
  });
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function buildAuditMismatchSummary(mismatch) {
  const lines = [`Audit trail mismatch for ${mismatch.operation || 'unknown'} operation (record: ${mismatch.recordName || 'unknown'})`];
  if (mismatch.reason) {
    lines.push(`Reason: ${mismatch.reason}`);
  }
  if (Array.isArray(mismatch.mismatches)) {
    for (const m of mismatch.mismatches) {
      lines.push(`  MISMATCH: "${m.field}" expected="${m.expected}" actual="${m.actual}"`);
    }
  }
  if (Array.isArray(mismatch.notFoundInAudit)) {
    for (const m of mismatch.notFoundInAudit) {
      lines.push(`  NOT FOUND: "${m.field}" expected="${m.expected}"`);
    }
  }
  return lines.join('\n');
}

function trimReportText(value, max = 120000) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated]`;
}

function buildReasonFromFailureText(value, fallback = 'Operation failed') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const firstLine = text.split(/\r?\n/).find((line) => String(line || '').trim());
  return String(firstLine || fallback).trim();
}

function buildCompareSummary(result, sourceMaster, targetMaster, fieldName) {
  const comparison = result?.comparison || {};
  const totalOptions = Number(comparison.totalOptions || 0);
  const totalRecords = Number(comparison.totalRecords || 0);
  const matchedCount = Number(comparison.matchedCount || 0);
  const isFullMatch = comparison.isFullMatch === true;
  const fieldLabel = String(fieldName || 'field').trim() || 'field';

  if (isFullMatch) {
    return `Dropdown and master data matched for ${fieldLabel} against ${targetMaster}.`;
  }

  return `Dropdown vs master comparison mismatch for ${fieldLabel}: options=${totalOptions}, records=${totalRecords}, matched=${matchedCount} (source=${sourceMaster}, target=${targetMaster}).`;
}

function extractFailureScreenshotPath(messageText) {
  const text = String(messageText || '');
  const markerRegex = /\[FAIL_SCREENSHOT\]\s*([^\r\n]+)/ig;
  let match = null;
  let lastPath = '';
  while ((match = markerRegex.exec(text)) !== null) {
    lastPath = String(match[1] || '').trim();
  }
  return lastPath;
}

function findRecentFailureScreenshot(masterName, operation) {
  try {
    if (!fs.existsSync(testReportArtifactsDir)) return '';
    const masterSlug = normalizeSlug(masterName);
    const opSlug = normalizeSlug(operation);
    const now = Date.now();
    const lookbackMs = 20 * 60 * 1000;

    // Look for PNG files with matching master and operation, regardless of status/step suffix
    const files = fs.readdirSync(testReportArtifactsDir)
      .filter((file) => /\.png$/i.test(file))
      .filter((file) => file.includes(`-${masterSlug}-`) && file.includes(`-${opSlug}-`))
      .map((file) => {
        const fullPath = path.join(testReportArtifactsDir, file);
        const stat = fs.statSync(fullPath);
        return { file, fullPath, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => now - entry.mtimeMs <= lookbackMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files[0]?.fullPath || '';
  } catch {
    return '';
  }
}

function buildScreenshotFromPath(req, screenshotPath) {
  const fileName = screenshotPath ? path.basename(String(screenshotPath)) : '';
  const screenshotUrl = fileName
    ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(fileName)}`
    : '';
  return { fileName, screenshotUrl };
}

function buildArtifactUrl(req, fileName) {
  const name = String(fileName || '').trim();
  return name ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(name)}` : '';
}

function getLatestWorkflowScreenshot(jsonResult) {
  const steps = jsonResult?.steps && typeof jsonResult.steps === 'object' ? jsonResult.steps : {};
  const failedStep = Object.values(steps).find((step) => step?.status === 'failed' && (step?.screenshotFile || step?.screenshotPath));
  if (failedStep) {
    const file = failedStep.screenshotFile || path.basename(String(failedStep.screenshotPath || ''));
    if (file) return file;
  }

  const screenshots = Array.isArray(jsonResult?.flowState?.screenshots) ? jsonResult.flowState.screenshots : [];
  const last = [...screenshots].reverse().find((item) => item?.fileName || item?.path);
  return last?.fileName || (last?.path ? path.basename(String(last.path)) : '');
}

function findRecentTemplateWorkflowScreenshot(runStartedAt = 0) {
  try {
    ensureDir(testReportArtifactsDir);
    const files = fs.readdirSync(testReportArtifactsDir)
      .filter((name) => /\.png$/i.test(name))
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(testReportArtifactsDir, name)).mtimeMs,
      }))
      .filter((entry) => entry.mtime >= Number(runStartedAt || 0))
      .sort((a, b) => b.mtime - a.mtime);

    const workflowShot = files.find((entry) => /template-workflow/i.test(entry.name));
    return workflowShot?.name || files[0]?.name || '';
  } catch {
    return '';
  }
}

function buildTemplateWorkflowSummary(jsonResult, fallbackLogs = '') {
  const steps = jsonResult?.steps && typeof jsonResult.steps === 'object' ? jsonResult.steps : {};
  const flow = jsonResult?.flowState || {};
  const labels = {
    login: 'Logged in',
    createSite: 'Created site',
    createApp: 'Created app',
    createTemplate: 'Created main template',
    createSubTemplate: 'Created child sub template',
    assignWorkflow: 'Assigned workflow',
    selectAppUnderSite: 'Opened app from dashboard',
    auditTrail: 'Checked audit trail',
  };

  const lines = Object.entries(labels).map(([key, label]) => {
    const step = steps[key] || {};
    const status = String(step.status || 'pending').toLowerCase();
    const statusText = status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : status === 'skipped' ? 'Skipped' : 'Pending';
    const message = String(step.message || '').trim();
    return `${label}: ${statusText}${message ? `. ${message}` : ''}`;
  });

  const dataLines = [
    flow.siteName ? `Site used: ${flow.siteName}` : '',
    flow.appName ? `App used: ${flow.appName}` : '',
    flow.templateName ? `Main template used: ${flow.templateName}` : '',
    flow.subTemplateName ? `Child sub-template used: ${flow.subTemplateName}` : '',
    flow.workflowName ? `Workflow used: ${flow.workflowName}` : '',
  ].filter(Boolean);

  const fallback = String(fallbackLogs || '').trim();
  return trimReportText([...lines, ...dataLines, fallback ? `Technical log: ${fallback}` : ''].filter(Boolean).join('\n'));
}

function buildTemplateWorkflowReason(passed, jsonResult) {
  if (passed) return 'Template workflow passed. Site, app, main template, child sub template, workflow assignment, app switch, and audit check were completed.';
  const steps = jsonResult?.steps || {};
  const failed = Object.entries(steps).find(([, step]) => step?.status === 'failed');
  if (failed) {
    const label = failed[0].replace(/([A-Z])/g, ' $1').toLowerCase();
    return `Template workflow failed at ${label}. ${failed[1]?.message || 'Please check the step log.'}`;
  }
  return 'Template workflow failed. Please check the step log.';
}

app.post('/api/templates/create-entry', async (req, res) => {
  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const showBrowser = req.body?.showBrowser !== false;
  const templateName = String(req.body?.templateName || '').trim();
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runCreateTemplateEntryScript({
      ...process.env,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_HEADLESS: showBrowser ? 'false' : 'true',
      QT_TEMPLATE_NAME: templateName,
    });

    result.recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'create-template',
      templateName,
      status: 'completed',
    });

    const saveMsg = String(result?.saveMessage || '').toLowerCase();
    const passed = result?.status !== 'failed'
      && !saveMsg.includes('error')
      && !saveMsg.includes('failed');

    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: templateName || '(auto)',
      operation: 'create-template',
      status: passed ? 'passed' : 'failed',
      reason: passed
        ? `Template entry created successfully${result?.templateName ? ` (${result.templateName})` : ''}`
        : `Template entry save was not confirmed: ${result?.saveMessage || 'no message'}`,
      logs: trimReportText(JSON.stringify({
        route: result?.route || '',
        templateName: result?.templateName || '',
        fieldsFilled: Array.isArray(result?.fieldsFilled) ? result.fieldsFilled.length : 0,
        saveMessage: result?.saveMessage || '',
      }, null, 2)),
      screenshotUrl: '',
      screenshotFile: '',
      error: passed ? '' : (result?.saveMessage || 'Template save may have failed'),
      createdAt: result?.executedAt || new Date().toISOString(),
    });

    return res.json(result);
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'create-template',
      templateName,
      status: 'failed',
    });
    const rawMessage = String(error?.message || 'Template workflow failed');
    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: templateName || '(auto)',
      operation: 'create-template',
      status: 'failed',
      reason: buildReasonFromFailureText(rawMessage, 'Template workflow failed'),
      logs: trimReportText(rawMessage),
      screenshotUrl: '',
      screenshotFile: '',
      error: rawMessage,
      createdAt: new Date().toISOString(),
    });
    return res.status(500).json({
      message: buildReasonFromFailureText(rawMessage, 'Failed to create template entry'),
    });
  }
});



function createFlowName(prefix, provided = '') {
  const clean = String(provided || '').trim();
  if (clean) return clean;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

function createShortCode(prefix = 'AUTO') {
  return `${prefix}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function createCompactCode(length = 3) {
  return Math.random().toString(36).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(2, 2 + length);
}

function buildCrudPrefilledValues(kind, values) {
  const countryName = String(values.countryName || '').trim();
  const timeZoneName = String(values.timeZoneName || '').trim();
  const appName = String(values.appName || '').trim();
  const siteName = String(values.siteName || '').trim();
  const templateName = String(values.templateName || '').trim();
  const subTemplateName = String(values.subTemplateName || '').trim();
  const workflowName = String(values.workflowName || '').trim();

  switch (kind) {
    case 'country':
      return {
        Name: countryName,
        'Country Name': countryName,
        'Country Code': createShortCode('CO').slice(0, 3),
        Code: createShortCode('C'),
      };
    case 'timezone':
      return {
        Name: timeZoneName,
        'Time Zone Name': timeZoneName,
        Country: countryName,
        'Country Name': countryName,
        'UTC Offeset': '+05:30',
        'Time Zone Abbreviation': createShortCode('TZ').slice(0, 4),
      };
    case 'app':
      return {
        Name: appName,
        'App Name': appName,
        'App Code': createCompactCode(3),
        Site: 'Ahmedabad',
        'Form Submission To': 'Role',
        Application: appName,
        'Short Name': createShortCode('APP'),
        Code: createCompactCode(3),
      };
    case 'site':
      return {
        Name: siteName,
        'Site Name': siteName,
        'Site Code': createShortCode('AS').slice(0, 4),
        'Country Name': countryName || 'India',
        'Time Zone Name': timeZoneName || 'India ( +05:30 )',
        Site: siteName,
        Location: siteName,
        Plant: siteName,
        'Short Name': createShortCode('SIT'),
        Code: createShortCode('ST'),
      };
    case 'template':
      return {
        Name: templateName,
        'Template Name': templateName,
        Template: templateName,
        'Template Code': createShortCode('TPL'),
        Site: siteName,
        'Site Name': siteName,
        'Country Name': countryName,
        'Time Zone Name': timeZoneName,
        App: appName,
        Application: appName,
      };
    case 'sub-template':
      return {
        Name: subTemplateName,
        'Sub Template Name': subTemplateName,
        'Sub-Template Name': subTemplateName,
        Site: siteName,
        'Site Name': siteName,
        'Country Name': countryName,
        'Time Zone Name': timeZoneName,
        'Template Name': templateName,
        Template: templateName,
        'Parent Template': templateName,
        App: appName,
        Application: appName,
      };
    default:
      return {};
  }
}

async function runWebsiteCrudStep({
  key,
  label,
  masterName,
  operation,
  verifyAudit = true,
  prefilledValues = null,
  targetRecordName = '',
  loginUrl,
  username,
  password,
  showBrowser,
}) {
  const env = {
    ...process.env,
    QT_URL: String(loginUrl),
    QT_USER: String(username),
    QT_PASS: String(password),
    QT_MASTER: String(masterName),
    QT_OP: String(operation),
    QT_HEADLESS: showBrowser ? 'false' : 'true',
    QT_VERIFY_AUDIT: verifyAudit ? 'true' : 'false',
    QT_RECORD_VIDEO: 'true',
  };

  if (prefilledValues && typeof prefilledValues === 'object') {
    env.QT_PREFILLED_VALUES = JSON.stringify(prefilledValues);
  }
  if (targetRecordName) {
    env.QT_TARGET_RECORD = String(targetRecordName);
  }

  let result = null;
  let runError = null;
  try {
    result = await runCrudMasterScript(env);
  } catch (error) {
    runError = error;
  }

  if (runError) {
    return {
      key,
      label,
      status: 'failed',
      message: String(runError?.message || `${label} failed`),
      masterName,
      operation,
      recordName: targetRecordName || '',
      fieldCount: 0,
      auditVerified: !verifyAudit,
      auditVerification: null,
      raw: null,
    };
  }

  const opResult = Array.isArray(result?.operations)
    ? result.operations.find((entry) => String(entry?.operation || '').toLowerCase() === String(operation).toLowerCase())
    : null;
  const failure = Array.isArray(result?.failures) ? result.failures[0] : null;
  const auditVerification = opResult?.auditVerification || null;
  const auditPassed = !verifyAudit || (
    auditVerification
    && auditVerification.verified === true
    && (!auditVerification.comparison || auditVerification.comparison.passed !== false)
  );
  const passed = !!opResult && !failure && auditPassed;
  const message = passed
    ? (opResult?.alertMessage || `${label} completed successfully`)
    : (failure?.error || auditVerification?.reason || opResult?.alertMessage || `${label} failed`);

  return {
    key,
    label,
    status: passed ? 'passed' : 'failed',
    message,
    masterName,
    operation,
    recordName: opResult?.recordName || targetRecordName || '',
    fieldCount: Number(opResult?.fieldCount || 0),
    auditVerified: auditPassed,
    auditVerification,
    raw: result,
  };
}

app.post('/api/masters/:masterName/crud', async (req, res) => {
  const masterName = String(req.params.masterName || '').trim();
  const operation = String(req.body?.operation || 'all').toLowerCase();

  if (!masterName) {
    return res.status(400).json({ message: 'masterName is required' });
  }

  if (!['create', 'update', 'delete', 'all', 'duplicate-check'].includes(operation)) {
    return res.status(400).json({ message: 'operation must be create, update, delete, all, or duplicate-check' });
  }

  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const showBrowser = req.body?.showBrowser !== false;
  const verifyAuditTrail = req.body?.verifyAuditTrail === true;
  const incomingPrefilledValues = req.body?.prefilledValues && typeof req.body.prefilledValues === 'object'
    ? req.body.prefilledValues
    : null;
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runCrudMasterScript({
      ...process.env,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_MASTER: masterName,
      QT_OP: operation,
      QT_HEADLESS: showBrowser ? 'false' : 'true',
      QT_VERIFY_AUDIT: verifyAuditTrail ? 'true' : 'false',
      QT_PREFILLED_VALUES: incomingPrefilledValues ? JSON.stringify(incomingPrefilledValues) : '',
    });

    result.recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'crud',
      masterName,
      operation,
      verifyAuditTrail,
      status: 'completed',
      keepPrimaryOnly: !verifyAuditTrail,
    });

    const runLogs = trimReportText(result?._debug || '');

    // Server-side strict audit verdict: when verifyAuditTrail is enabled,
    // each CRUD operation must produce a verified audit result, and when
    // operation data includes expected field values, comparison must pass.
    const meaningfulAuditFieldCount = (auditTrail) => Object.entries(auditTrail || {}).filter(([key, value]) => {
      const keyText = String(key || '');
      const val = String(value || '').trim();
      if (!val) return false;
      if (/password|confirm\s*password|update\s*remarks?|reason|description/i.test(keyText)) return false;
      return true;
    }).length;

    const normalizeOperationName = (value) => String(value || '').toLowerCase();
    const ensureArray = (value) => (Array.isArray(value) ? value : []);

    result.auditMismatches = ensureArray(result.auditMismatches);

    // Save successful operations to test reports
    if (Array.isArray(result.operations) && result.operations.length > 0) {
      for (const op of result.operations) {
        const opName = op.operation || operation;
        const normalizedOpName = normalizeOperationName(opName);
        const duplicateBlocked = opName === 'duplicate-check' ? op.duplicateBlocked === true : undefined;
        const opScreenshot = buildScreenshotFromPath(req, op.screenshotPath || '');
        const auditScreenshot = buildScreenshotFromPath(req, op.auditVerification?.screenshotPath || op.screenshotPath || '');

        const comparisonSource = meaningfulAuditFieldCount(op.createdRecordDetails) > 0
          ? op.createdRecordDetails
          : op.auditTrail;
        const fieldValidationResults = ensureArray(op.auditVerification?.fieldValidationResults);
        const fieldByFieldPassed = op.auditVerification?.fieldByFieldResults?.passed === true;

        const expectedFieldCount = meaningfulAuditFieldCount(comparisonSource);
        const requiresAudit = verifyAuditTrail === true && duplicateBlocked === undefined;
        const requiresFieldComparison = requiresAudit && expectedFieldCount > 0;
        const hasAuditVerification = !!op.auditVerification;
        const hasComparison = !!op.auditVerification?.comparison;
        const comparisonPassed = fieldValidationResults.length > 0
          ? fieldByFieldPassed
          : (hasComparison && op.auditVerification.comparison.passed === true);
        const verifiedByAudit = op.auditVerification?.verified === true;

        const auditPassed = !requiresAudit
          ? true
          : (hasAuditVerification && verifiedByAudit && (!requiresFieldComparison || comparisonPassed));

        const existingMismatchForOp = result.auditMismatches.some((m) => normalizeOperationName(m?.operation) === normalizedOpName);
        if (requiresAudit && !auditPassed && !existingMismatchForOp) {
          const reason = !hasAuditVerification
            ? 'Audit verification result missing from CRUD response'
            : !verifiedByAudit
              ? (op.auditVerification?.reason || 'Audit verification did not pass')
              : (requiresFieldComparison && !comparisonPassed
                ? 'Audit field-by-field comparison failed'
                : 'Audit verification failed');

          result.auditMismatches.push({
            operation: opName,
            recordName: op.recordName || '',
            reason,
            mismatches: op.auditVerification?.comparison?.mismatches || [],
            notFoundInAudit: op.auditVerification?.comparison?.notFoundInAudit || [],
            matchCount: op.auditVerification?.comparison?.matchCount || 0,
            mismatchCount: op.auditVerification?.comparison?.mismatchCount || 0,
            fieldValidationResults,
            createdRecordDetails: op.createdRecordDetails || {},
            screenshotPath: op.auditVerification?.screenshotPath || op.screenshotPath || '',
          });
        }

        // Expose explicit server audit verdict for frontend consumers.
        op.auditRequired = requiresAudit;
        op.auditFieldCount = expectedFieldCount;
        op.auditPassed = auditPassed;

        appendTestReport({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          masterName,
          operation: opName,
          status: opName === 'duplicate-check'
            ? (duplicateBlocked !== true ? 'failed' : 'passed')
            : 'passed',
          reason: opName === 'duplicate-check'
            ? (duplicateBlocked
              ? 'Duplicate check blocked the duplicate entry successfully'
              : 'Duplicate check ran but the duplicate entry was not blocked')
            : `${formatOperation(opName)} operation completed successfully`,
          logs: runLogs,
          screenshotUrl: opScreenshot.screenshotUrl,
          screenshotFile: opScreenshot.fileName,
          error: '',
          recordName: op.recordName || '',
          fieldCount: op.fieldCount || 0,
          duplicateBlocked,
          enteredValues: op.auditTrail || {},
          createdRecordDetails: op.createdRecordDetails || {},
          createdAt: new Date().toISOString(),
        });

        if (verifyAuditTrail && op.auditVerification && auditPassed) {
          appendTestReport({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            masterName,
            operation: 'audit-verified',
            status: 'passed',
            reason: `Audit trail verified successfully for ${formatOperation(opName).toLowerCase()} operation`,
            logs: runLogs,
            screenshotUrl: auditScreenshot.screenshotUrl,
            screenshotFile: auditScreenshot.fileName,
            error: '',
            recordName: op.recordName || '',
            verifiedOperation: opName,
            enteredValues: op.auditTrail || {},
            createdRecordDetails: op.createdRecordDetails || {},
            auditFieldResults: fieldValidationResults,
            auditFieldSummary: op.auditVerification?.fieldValidationSummary || null,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // Save audit mismatch reports even on CRUD success
    if (Array.isArray(result.auditMismatches) && result.auditMismatches.length > 0) {
      for (const mismatch of result.auditMismatches) {
        const fileName = mismatch.screenshotPath ? path.basename(mismatch.screenshotPath) : '';
        const screenshotUrl = fileName ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(fileName)}` : '';
        const reason = String(mismatch.reason || '').trim() || 'Audit verification mismatch';
        appendTestReport({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          masterName,
          operation: 'audit-check',
          status: 'audit-mismatch',
          reason,
          logs: runLogs,
          screenshotUrl,
          screenshotFile: fileName,
          error: buildAuditMismatchSummary(mismatch),
          recordName: mismatch.recordName || '',
          verifiedOperation: mismatch.operation || operation,
          mismatches: mismatch.mismatches || [],
          notFoundInAudit: mismatch.notFoundInAudit || [],
          matchCount: mismatch.matchCount || 0,
          mismatchCount: mismatch.mismatchCount || 0,
          createdRecordDetails: mismatch.createdRecordDetails || {},
          auditFieldResults: mismatch.fieldValidationResults || [],
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Save per-operation failures returned by CRUD runner (especially useful in QT_OP=all mode).
    if (Array.isArray(result.failures) && result.failures.length > 0) {
      for (const failure of result.failures) {
        const fileName = failure.screenshotPath ? path.basename(failure.screenshotPath) : '';
        const screenshotUrl = fileName ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(fileName)}` : '';
        const errorText = String(failure.error || 'Operation failed').trim();
        appendTestReport({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          masterName,
          operation: failure.operation || operation,
          status: 'failed',
          reason: buildReasonFromFailureText(errorText, 'Operation failed'),
          logs: runLogs || trimReportText(errorText),
          screenshotUrl,
          screenshotFile: fileName,
          error: errorText,
          createdAt: failure.createdAt || new Date().toISOString(),
        });
      }
    }

    // Final overall flag after strict audit verdicts and synthesized mismatches.
    result.failed = (Array.isArray(result.failures) && result.failures.length > 0)
      || (Array.isArray(result.auditMismatches) && result.auditMismatches.length > 0);

    return res.json(result);
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'crud',
      masterName,
      operation,
      verifyAuditTrail,
      status: 'failed',
      keepPrimaryOnly: !verifyAuditTrail,
    });
    const message = error?.message || 'CRUD operation failed';
    const markerPath = extractFailureScreenshotPath(message);
    const screenshotPath = markerPath || findRecentFailureScreenshot(masterName, operation);
    const sanitizedMessage = message.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    const shortMessage = buildReasonFromFailureText(sanitizedMessage, 'CRUD operation failed');
    const fileName = screenshotPath ? path.basename(screenshotPath) : '';
    const screenshotUrl = fileName ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(fileName)}` : '';

    const reportPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName,
      operation,
      status: 'failed',
      reason: buildReasonFromFailureText(sanitizedMessage, 'Operation failed'),
      logs: trimReportText(sanitizedMessage),
      screenshotUrl,
      screenshotFile: fileName,
      error: sanitizedMessage,
      createdAt: new Date().toISOString(),
    };
    appendTestReport(reportPayload);

    return res.status(500).json({
      message: shortMessage,
      testReport: reportPayload,
    });
  }
});

// ─── Mandatory field validation ────────────────────────────────────────────────

function runMandatoryFieldsScript(env) {
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'validate-mandatory-fields.js');
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Mandatory fields script failed'));
        return;
      }
      try {
        const parsed = JSON.parse((stdout || '').toString().trim());
        const debugLog = (stderr || '').toString().trim();
        if (debugLog) process.stderr.write(`${debugLog}\n`);
        parsed._debug = debugLog;
        resolve(parsed);
      } catch {
        const debug = (stderr || '').toString().trim();
        reject(new Error('Script did not return valid JSON' + (debug ? ': ' + debug : '')));
      }
    });
  });
}

app.post('/api/masters/:masterName/validate-mandatory', async (req, res) => {
  const masterName = String(req.params.masterName || '').trim();
  if (!masterName) {
    return res.status(400).json({ message: 'masterName is required' });
  }

  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const showBrowser = req.body?.showBrowser !== false;
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runMandatoryFieldsScript({
      ...process.env,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_MASTER: masterName,
      QT_HEADLESS: showBrowser ? 'false' : 'true',
    });
    result.recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'mandatory',
      masterName,
      operation: 'mandatory-check',
      status: 'completed',
    });

    const screenshotFile = result?.screenshotPath ? path.basename(result.screenshotPath) : '';
    const screenshotUrl = screenshotFile ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(screenshotFile)}` : '';
    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName,
      operation: 'mandatory-check',
      status: result?.validationWorking ? 'passed' : 'failed',
      reason: result?.validationWorking
        ? `Mandatory validation detected ${Array.isArray(result?.mandatoryFields) ? result.mandatoryFields.length : 0} required field checks`
        : 'Mandatory validation did not detect any required field errors',
      logs: trimReportText(result?._debug || JSON.stringify({
        totalFields: result?.totalFields,
        mandatoryCount: Array.isArray(result?.mandatoryFields) ? result.mandatoryFields.length : 0,
        globalErrors: result?.globalErrors || [],
      }, null, 2)),
      screenshotUrl,
      screenshotFile,
      error: result?.validationWorking ? '' : trimReportText(JSON.stringify(result?.globalErrors || [], null, 2)),
      fieldCount: Number(result?.totalFields || 0),
      createdAt: result?.testedAt || new Date().toISOString(),
    });

    return res.json(result);
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'mandatory',
      masterName,
      operation: 'mandatory-check',
      status: 'failed',
    });
    const rawMessage = String(error?.message || 'Mandatory fields check failed');
    const markerPath = extractFailureScreenshotPath(rawMessage);
    const screenshotPath = markerPath || findRecentFailureScreenshot(masterName, 'mandatory-check');
    const message = rawMessage.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    const mandatoryScreenshot = buildScreenshotFromPath(req, screenshotPath);
    const reportPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName,
      operation: 'mandatory-check',
      status: 'failed',
      reason: buildReasonFromFailureText(message, 'Mandatory check failed'),
      logs: trimReportText(message),
      screenshotUrl: mandatoryScreenshot.screenshotUrl,
      screenshotFile: mandatoryScreenshot.fileName,
      error: message,
      createdAt: new Date().toISOString(),
    };
    appendTestReport(reportPayload);
    return res.status(500).json({ message, testReport: reportPayload });
  }
});

// ─── Template Workflow: Run template-workflow-full.js via Node ─────────────────

app.post('/api/template-workflow/run', async (req, res) => {
  const showBrowser     = req.body?.showBrowser !== false;
  const resumeFromStep  = req.body?.resumeFromStep  || '';        // e.g. 'assignWorkflow'
  const prefilledState  = req.body?.prefilledFlowState || null;   // { siteName, appName, … }

  const env = {
    ...process.env,
    QT_HEADLESS: showBrowser ? 'false' : 'true',
    ...(resumeFromStep ? { RESUME_FROM_STEP: resumeFromStep } : {}),
    ...(prefilledState  ? { RESUME_FLOW_STATE: JSON.stringify(prefilledState) } : {}),
  };

  const testFile = path.resolve(__dirname, '..', 'playwright-tests', 'template-workflow-full.js');
  const playwrightDir = path.resolve(__dirname, '..', 'playwright-tests');

  // ── Capture recording snapshot BEFORE running ────────────────────────────
  const recordingCapture = beginRecordingCapture();
  const runStartedAt = Date.now();

  try {
    const result = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [testFile],
        { cwd: playwrightDir, env, timeout: 360000, maxBuffer: 20 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            return reject(new Error(stderr || error.message));
          }
          resolve({ stdout, stderr, exitCode: error ? error.code : 0 });
        }
      );
    });

    let jsonResult = null;
    try {
      jsonResult = JSON.parse(result.stdout);
    } catch {
      // stdout may not be valid JSON if test produced console output
    }

    const hasFailedStep = jsonResult && jsonResult.steps
      ? Object.values(jsonResult.steps).some((step) => step && step.status === 'failed')
      : false;
    const passed = result.exitCode === 0
      && !!jsonResult
      && jsonResult.status === 'completed'
      && !hasFailedStep;

        // ── Finalize recording (register new video in recordings index) ──────────
    const savedRecordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind:            'template-workflow',
      masterName:      'Template Workflow',
      operation:       'template-workflow-e2e',
      status:          passed ? 'completed' : 'failed',
      keepPrimaryOnly: true,
    });
    const twRecName = savedRecordings?.[0]?.name || '';
    const twRecUrl  = twRecName
      ? `${req.protocol}://${req.get('host')}/test-report-artifacts/${encodeURIComponent(twRecName)}`
      : '';

    const twScreenshotFile = getLatestWorkflowScreenshot(jsonResult) || findRecentTemplateWorkflowScreenshot(runStartedAt);
    const twScreenshotUrl = buildArtifactUrl(req, twScreenshotFile);

    // ── Persist run state for one-click Resume ────────────────────────────────
    if (jsonResult) {
      const lastRunPath = path.resolve(__dirname, 'last-run-state.json');
      try {
        fs.writeFileSync(lastRunPath, JSON.stringify({
          savedAt:   new Date().toISOString(),
          status:    jsonResult.status,
          flowState: jsonResult.flowState || {},
          steps:     jsonResult.steps || {},
        }, null, 2));
      } catch { /* non-fatal */ }
    }

    const reportReason = buildTemplateWorkflowReason(passed, jsonResult);
    const reportLogs = buildTemplateWorkflowSummary(jsonResult, result.stderr || result.stdout || '');

    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: 'Template Workflow',
      operation: 'template-workflow-e2e',
      status: passed ? 'passed' : 'failed',
      reason: reportReason,
      logs: reportLogs,
      screenshotUrl: twScreenshotUrl,
      screenshotFile: twScreenshotFile,
      recordingUrl: twRecUrl,
      error: passed ? '' : reportReason,
      createdAt: new Date().toISOString(),
    });

    return res.json({
      status: passed ? 'passed' : 'failed',
      message: passed
        ? 'Template workflow completed successfully.'
        : 'Template workflow failed. Check the report for the failed step.',
      logs: reportLogs,
      jsonResult,
      recordings: savedRecordings,
      screenshotUrl: twScreenshotUrl,
      screenshotFile: twScreenshotFile,
    });
  } catch (error) {
    const rawMessage = String(error?.message || 'Template Workflow E2E failed');
    const fallbackShotFile = findRecentTemplateWorkflowScreenshot(runStartedAt);
    const fallbackShotUrl = buildArtifactUrl(req, fallbackShotFile);
    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: 'Template Workflow',
      operation: 'template-workflow-e2e',
      status: 'failed',
      reason: buildReasonFromFailureText(rawMessage, 'Template Workflow E2E failed'),
      logs: trimReportText(rawMessage),
      screenshotUrl: fallbackShotUrl,
      screenshotFile: fallbackShotFile,
      error: rawMessage,
      createdAt: new Date().toISOString(),
    });
    return res.status(500).json({
      status: 'failed',
      message: buildReasonFromFailureText(rawMessage, 'Template Workflow E2E failed'),
    });
  }
});

// ─── Compliance Test Runner ────────────────────────────────────────────────────

function normalizeComplianceSuite(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'MD' || normalized === 'AT') return normalized;
  return 'DI';
}

function runComplianceScript(env, suite = 'DI') {
  const normalizedSuite = normalizeComplianceSuite(suite);
  const runnerFile = normalizedSuite === 'MD'
    ? 'master-data-runner.js'
    : normalizedSuite === 'AT'
      ? 'audit-trail-runner.js'
      : 'compliance-runner.js';
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'compliance', runnerFile);
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600000, // 10 min max — some tests (TC-DI-03) wait 5 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Compliance script failed'));
        return;
      }
      try {
        const stdoutStr = (stdout || '').toString().trim();
        // The script might print logs to stdout. We want the LAST JSON object in the output.
        const jsonMatch = stdoutStr.match(/\{[\s\S]*\}$/);
        const jsonStr = jsonMatch ? jsonMatch[0] : stdoutStr;
        
        const parsed = JSON.parse(jsonStr);
        const debugLog = (stderr || '').toString().trim();
        if (debugLog) process.stderr.write(`${debugLog}\n`);
        parsed._debug = debugLog;
        parsed.suite = normalizeComplianceSuite(parsed?.suite || normalizedSuite);
        resolve(parsed);
      } catch (err) {
        const debug = (stderr || '').toString().trim();
        const output = (stdout || '').toString().trim();
        reject(new Error('Compliance script did not return valid JSON' + (debug ? ': ' + debug : '') + (output ? '\nOutput: ' + output : '')));
      }
    });
  });
}

app.post('/api/compliance/run', async (req, res) => {
  const suite = normalizeComplianceSuite(req.body?.suite || process.env.QT_SUITE || 'DI');
  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const username2 = req.body?.username2 || process.env.QT_USER2 || username;
  const password2 = req.body?.password2 || process.env.QT_PASS2 || password;
  const masterName = req.body?.masterName || process.env.QT_MASTER || 'Country';
  const tcId = req.body?.tcId || '';
  const showBrowser = req.body?.showBrowser !== false;
  const recordingCapture = beginRecordingCapture();

  try {
    const result = await runComplianceScript({
      ...process.env,
      QT_SUITE: suite,
      QT_URL: String(loginUrl),
      QT_USER: String(username),
      QT_PASS: String(password),
      QT_USER2: String(username2),
      QT_PASS2: String(password2),
      QT_MASTER: String(masterName),
      QT_TC_ID: String(tcId),
      QT_HEADLESS: showBrowser ? 'false' : 'true',
    }, suite);

    result.suite = normalizeComplianceSuite(result?.suite || suite);

    const overallPassed = result?.mode === 'all'
      ? Number(result?.summary?.failed || 0) === 0
      : result?.status !== 'failed';

    const reportResults = result?.mode === 'all' ? (result?.results || []) : [result];
    for (const r of reportResults) {
      const normalizedStatus = String(r?.status || '').toLowerCase() === 'blocked'
        ? 'blocked'
        : (String(r?.status || '').toLowerCase() === 'passed' ? 'passed' : 'failed');

      appendTestReport({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        masterName: String(masterName),
        operation: `compliance-${suite.toLowerCase()}-${String(r?.tcId || tcId || 'all').toLowerCase().replace(/\s+/g, '-')}`,
        status: normalizedStatus,
        reason: normalizedStatus === 'passed'
          ? `${r?.title || r?.tcId || 'Compliance test'} passed`
          : normalizedStatus === 'blocked'
            ? `${r?.title || r?.tcId || 'Compliance test'} blocked`
            : `${r?.title || r?.tcId || 'Compliance test'} failed`,
        logs: trimReportText(`${r?._debug || ''}\n\n${JSON.stringify(r?.details || {}, null, 2)}`),
        screenshotUrl: '',
        screenshotFile: '',
        error: normalizedStatus !== 'passed' ? trimReportText(JSON.stringify(r?.details || '', null, 2)) : '',
        createdAt: new Date().toISOString(),
      });
    }

    result.recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compliance',
      masterName: String(masterName),
      operation: `${suite.toLowerCase()}-${tcId || 'all'}`,
      status: overallPassed ? 'completed' : 'failed',
    });

    return res.json(result);
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compliance',
      masterName: String(masterName),
      operation: `${suite.toLowerCase()}-${tcId || 'all'}`,
      status: 'failed',
    });
    const rawMessage = String(error?.message || 'Compliance run failed');
    const sanitized = rawMessage.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    appendTestReport({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      masterName: String(masterName),
      operation: `compliance-${suite.toLowerCase()}-${String(tcId || 'all')}`,
      status: 'failed',
      reason: buildReasonFromFailureText(sanitized, 'Compliance run failed'),
      logs: trimReportText(`${rawMessage}\n\n${sanitized}`),
      screenshotUrl: '',
      screenshotFile: '',
      error: sanitized,
      createdAt: new Date().toISOString(),
    });
    return res.status(500).json({ message: sanitized });
  }
});

const REALTIME_COMPLIANCE_RETENTION_LIMIT = 100;
const REALTIME_COMPLIANCE_DI_DEFAULT_TC_IDS = ['TC-DI-01', 'TC-DI-02-01', 'TC-DI-06-01', 'TC-DI-07-01', 'TC-DI-08-01', 'TC-DI-09-01'];
const REALTIME_COMPLIANCE_MD_DEFAULT_TC_IDS = ['TC-MD-01-01', 'TC-MD-01-02', 'TC-MD-02-01', 'TC-MD-03-01', 'TC-MD-04-01', 'TC-MD-05-01', 'TC-MD-06-01', 'TC-MD-07-01', 'TC-MD-08-01'];
const REALTIME_COMPLIANCE_AT_DEFAULT_TC_IDS = [
  'TC-AT-01-01',
  'TC-AT-01-02',
  'TC-AT-01-03',
  'TC-AT-02-01',
  'TC-AT-02-02',
  'TC-AT-03-01',
  'TC-AT-04-01',
  'TC-AT-05-01',
  'TC-AT-05-02',
  'TC-AT-05-03',
  'TC-AT-06-01',
  'TC-AT-06-02',
  'TC-AT-07-01',
  'TC-AT-08-01',
  'TC-AT-08-02',
  'TC-AT-09-01',
  'TC-AT-09-02',
  'TC-AT-10-01',
];
const realtimeComplianceRunsStore = readComplianceRunsStore();
const realtimeComplianceSseClients = new Map(); // runId -> Set(response)
const realtimeComplianceRunSecrets = new Map(); // runId -> sensitive config (passwords)
const realtimeComplianceRunTasks = new Map(); // runId -> { stopRequested: boolean, child: ChildProcess | null }

Object.values(realtimeComplianceRunsStore?.runsById || {}).forEach((run) => {
  if (String(run?.status || '').toLowerCase() === 'running') {
    run.status = 'failed';
    run.error = run.error || 'Compliance run was interrupted by a server restart.';
    run.progressMessage = run.error;
    run.completedAt = run.completedAt || new Date().toISOString();
    run.updatedAt = new Date().toISOString();
  }
});
writeComplianceRunsStore(realtimeComplianceRunsStore);

function isRealtimeComplianceTerminal(status) {
  const normalized = String(status || '').toLowerCase().trim();
  return normalized === 'completed' || normalized === 'failed' || normalized === 'stopped';
}

function normalizeRealtimeComplianceStatus(status) {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'passed') return 'passed';
  if (value === 'blocked') return 'blocked';
  if (value === 'not-performed') return 'not-performed';
  return 'failed';
}

function getRealtimeComplianceTask(runId) {
  if (!realtimeComplianceRunTasks.has(runId)) {
    realtimeComplianceRunTasks.set(runId, { stopRequested: false, child: null });
  }
  return realtimeComplianceRunTasks.get(runId);
}

function isRealtimeStopRequested(runId) {
  return getRealtimeComplianceTask(runId)?.stopRequested === true;
}

function markRealtimeStopRequested(runId) {
  const task = getRealtimeComplianceTask(runId);
  task.stopRequested = true;
}

function setRealtimeActiveChild(runId, child) {
  const task = getRealtimeComplianceTask(runId);
  task.child = child || null;
}

function clearRealtimeRunTask(runId) {
  realtimeComplianceRunTasks.delete(runId);
}

async function killRealtimeChildProcess(runId) {
  const task = getRealtimeComplianceTask(runId);
  const child = task?.child;
  if (!child || !child.pid) return false;

  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      });
    } else {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    setRealtimeActiveChild(runId, null);
  }
}

function buildRealtimeComplianceRunId() {
  return `cr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildRealtimeComplianceClientToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function getRealtimeComplianceDefaultTcIds(suite) {
  const normalized = normalizeComplianceSuite(suite);
  if (normalized === 'MD') return [...REALTIME_COMPLIANCE_MD_DEFAULT_TC_IDS];
  if (normalized === 'AT') return [...REALTIME_COMPLIANCE_AT_DEFAULT_TC_IDS];
  return [...REALTIME_COMPLIANCE_DI_DEFAULT_TC_IDS];
}

function expandRealtimeComplianceMasterNames(payload = {}) {
  const fromArray = Array.isArray(payload?.masterNames)
    ? payload.masterNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const fallback = String(payload?.masterName || process.env.QT_MASTER || 'Country').trim();
  const candidate = fromArray.length ? fromArray : [fallback];
  const seen = new Set();
  const out = [];
  candidate.forEach((name) => {
    const key = name.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}

function expandRealtimeComplianceTcIds(suite, tcIdsInput) {
  const normalizedInput = (Array.isArray(tcIdsInput) ? tcIdsInput : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0);

  if (!normalizedInput.length || normalizedInput.includes('')) {
    return getRealtimeComplianceDefaultTcIds(suite);
  }

  const seen = new Set();
  const out = [];
  normalizedInput.forEach((tcId) => {
    const key = tcId.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tcId);
  });
  return out;
}

function sanitizeRealtimeComplianceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { clientToken, runConfig, ...safe } = snapshot;
  return safe;
}

function pruneRealtimeComplianceRunsStore() {
  const entries = Object.values(realtimeComplianceRunsStore?.runsById || {});
  entries.sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());
  const kept = entries.slice(0, REALTIME_COMPLIANCE_RETENTION_LIMIT);
  realtimeComplianceRunsStore.runsById = Object.fromEntries(kept.map((entry) => [entry.runId, entry]));
}

function persistRealtimeComplianceRunsStore() {
  pruneRealtimeComplianceRunsStore();
  writeComplianceRunsStore(realtimeComplianceRunsStore);
}

function getRealtimeComplianceSnapshot(runId) {
  const key = String(runId || '').trim();
  if (!key) return null;
  return realtimeComplianceRunsStore?.runsById?.[key] || null;
}

function saveRealtimeComplianceSnapshot(snapshot) {
  if (!snapshot?.runId) return;
  realtimeComplianceRunsStore.runsById[snapshot.runId] = snapshot;
  persistRealtimeComplianceRunsStore();
}

function verifyRealtimeComplianceAccess(runId, clientToken) {
  const snapshot = getRealtimeComplianceSnapshot(runId);
  if (!snapshot) return { ok: false, code: 404, message: 'Compliance run not found', snapshot: null };
  if (!clientToken || String(clientToken) !== String(snapshot.clientToken || '')) {
    return { ok: false, code: 403, message: 'Invalid run token', snapshot: null };
  }
  return { ok: true, code: 200, message: '', snapshot };
}

function writeRealtimeComplianceSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastRealtimeComplianceEvent(runId, eventName, payload) {
  const clients = realtimeComplianceSseClients.get(runId);
  if (!clients || !clients.size) return;
  clients.forEach((res) => {
    try {
      writeRealtimeComplianceSseEvent(res, eventName, payload);
    } catch {
      // Ignore dead sockets; close listener handles cleanup.
    }
  });
}

function normalizeRealtimeComplianceResultPayload(payload, fallback = {}) {
  const normalized = payload && typeof payload === 'object' ? { ...payload } : {};
  const tcId = String(normalized?.tcId || fallback?.tcId || '').trim();
  const title = String(normalized?.title || fallback?.title || tcId || 'Compliance test').trim();
  return {
    ...normalized,
    tcId,
    title,
    suite: normalizeComplianceSuite(normalized?.suite || fallback?.suite),
    status: normalizeRealtimeComplianceStatus(normalized?.status),
  };
}

function buildNotPerformedComplianceResult({ suite, masterName, tcId, sequence, masterIndex, tcIndex }) {
  return {
    suite: normalizeComplianceSuite(suite),
    status: 'not-performed',
    tcId: String(tcId || '').trim() || 'unknown',
    title: String(tcId || 'Compliance test'),
    masterName: String(masterName || ''),
    requestedMaster: String(masterName || ''),
    requestedTcId: String(tcId || ''),
    createdAt: new Date().toISOString(),
    sequence,
    masterIndex,
    tcIndex,
    recordings: [],
    details: [
      {
        step: 'Execution',
        passed: false,
        reason: 'Not performed because run was stopped by user.',
      },
    ],
    error: '',
    _debug: '',
  };
}

function appendRealtimeComplianceReportEntry({
  runId = '',
  suite = 'DI',
  masterName = '',
  result = {},
  fallbackTcId = '',
  sequence = 0,
  masterIndex = -1,
  tcIndex = -1,
}) {
  const normalizedSuite = normalizeComplianceSuite(suite);
  const normalizedResult = normalizeRealtimeComplianceResultPayload(result, { tcId: fallbackTcId, suite: normalizedSuite });
  const normalizedStatus = normalizeRealtimeComplianceStatus(normalizedResult?.status);
  const tcId = String(normalizedResult?.tcId || fallbackTcId || 'all').trim();

  appendTestReport({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: String(runId || ''),
    suite: normalizedSuite,
    tcId,
    sequence: Number(sequence || 0),
    masterIndex: Number(masterIndex),
    tcIndex: Number(tcIndex),
    masterName: String(masterName || ''),
    operation: `compliance-${normalizedSuite.toLowerCase()}-${tcId.toLowerCase().replace(/\s+/g, '-')}`,
    status: normalizedStatus,
    reason: normalizedStatus === 'passed'
      ? `${normalizedResult?.title || tcId || 'Compliance test'} passed`
      : normalizedStatus === 'blocked'
        ? `${normalizedResult?.title || tcId || 'Compliance test'} blocked`
        : normalizedStatus === 'not-performed'
          ? `${normalizedResult?.title || tcId || 'Compliance test'} not performed`
          : `${normalizedResult?.title || tcId || 'Compliance test'} failed`,
    logs: trimReportText(`${normalizedResult?._debug || ''}\n\n${JSON.stringify(normalizedResult?.details || {}, null, 2)}`),
    screenshotUrl: '',
    screenshotFile: '',
    error: (normalizedStatus !== 'passed' && normalizedStatus !== 'not-performed')
      ? trimReportText(String(normalizedResult?.error || JSON.stringify(normalizedResult?.details || '', null, 2)))
      : '',
    createdAt: new Date().toISOString(),
  });
}

function buildRealtimeComplianceEnv({
  suite,
  loginUrl,
  username,
  password,
  username2,
  password2,
  masterName,
  tcId,
  showBrowser,
}) {
  return {
    ...process.env,
    QT_SUITE: normalizeComplianceSuite(suite),
    QT_URL: String(loginUrl),
    QT_USER: String(username),
    QT_PASS: String(password),
    QT_USER2: String(username2),
    QT_PASS2: String(password2),
    QT_MASTER: String(masterName),
    QT_TC_ID: String(tcId || ''),
    QT_HEADLESS: showBrowser ? 'false' : 'true',
  };
}

function runComplianceScriptInterruptible(env, suite = 'DI', runId = '') {
  const normalizedSuite = normalizeComplianceSuite(suite);
  const runnerFile = normalizedSuite === 'MD'
    ? 'master-data-runner.js'
    : normalizedSuite === 'AT'
      ? 'audit-trail-runner.js'
      : 'compliance-runner.js';
  const scriptPath = path.resolve(__dirname, '..', 'playwright-tests', 'compliance', runnerFile);
  const cwd = path.resolve(__dirname, '..', 'playwright-tests');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    setRealtimeActiveChild(runId, child);

    let stdout = '';
    let stderr = '';
    let killedByStop = false;

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      setRealtimeActiveChild(runId, null);
      reject(new Error(String(error?.message || 'Compliance script failed')));
    });
    child.on('close', (code, signal) => {
      setRealtimeActiveChild(runId, null);
      if (isRealtimeStopRequested(runId)) {
        killedByStop = true;
      }
      if (killedByStop || signal) {
        reject(new Error('Compliance run stopped by user'));
        return;
      }
      if (code !== 0) {
        const message = (stderr || stdout || `Compliance script failed with code ${code}`).toString().trim();
        reject(new Error(message || 'Compliance script failed'));
        return;
      }
      try {
        const stdoutStr = String(stdout || '').trim();
        const jsonMatch = stdoutStr.match(/\{[\s\S]*\}$/);
        const jsonStr = jsonMatch ? jsonMatch[0] : stdoutStr;
        const parsed = JSON.parse(jsonStr);
        const debugLog = String(stderr || '').trim();
        if (debugLog) process.stderr.write(`${debugLog}\n`);
        parsed._debug = debugLog;
        parsed.suite = normalizeComplianceSuite(parsed?.suite || normalizedSuite);
        resolve(parsed);
      } catch {
        const debug = String(stderr || '').trim();
        const output = String(stdout || '').trim();
        reject(new Error('Compliance script did not return valid JSON' + (debug ? `: ${debug}` : '') + (output ? `\nOutput: ${output}` : '')));
      }
    });
  });
}

async function runRealtimeComplianceSingleCase({
  runId,
  suite,
  loginUrl,
  username,
  password,
  username2,
  password2,
  masterName,
  tcId,
  showBrowser,
}) {
  const recordingCapture = beginRecordingCapture();
  const normalizedSuite = normalizeComplianceSuite(suite);
  try {
    const raw = await runComplianceScriptInterruptible(buildRealtimeComplianceEnv({
      suite: normalizedSuite,
      loginUrl,
      username,
      password,
      username2,
      password2,
      masterName,
      tcId,
      showBrowser,
    }), normalizedSuite, runId);

    const normalized = normalizeRealtimeComplianceResultPayload(raw, {
      suite: normalizedSuite,
      tcId,
      title: tcId,
    });
    const recordingStatus = normalizeRealtimeComplianceStatus(normalized?.status) === 'passed' ? 'completed' : 'failed';
    const recordings = await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compliance',
      masterName: String(masterName),
      operation: `${normalizedSuite.toLowerCase()}-${String(tcId || normalized?.tcId || 'all').toLowerCase()}`,
      status: recordingStatus,
    });

    return { ok: true, result: normalized, recordings };
  } catch (error) {
    await finalizeRecordingCaptureSafe(recordingCapture, {
      kind: 'compliance',
      masterName: String(masterName),
      operation: `${normalizedSuite.toLowerCase()}-${String(tcId || 'all').toLowerCase()}`,
      status: 'failed',
    });
    const rawMessage = String(error?.message || 'Compliance run failed');
    const sanitized = rawMessage.replace(/\s*\[FAIL_SCREENSHOT\][^\r\n]*/i, '').trim();
    return {
      ok: false,
      error: sanitized,
      result: normalizeRealtimeComplianceResultPayload({
        suite: normalizedSuite,
        tcId: String(tcId || '').trim() || 'all',
        title: String(tcId || 'Compliance test'),
        status: 'failed',
        error: sanitized,
        details: [{ step: 'Execution failed', passed: false, reason: sanitized }],
        _debug: rawMessage,
      }, { suite: normalizedSuite, tcId }),
      recordings: [],
    };
  }
}

async function processRealtimeComplianceRun(runId) {
  const initialSnapshot = getRealtimeComplianceSnapshot(runId);
  if (!initialSnapshot) return;

  const snapshot = { ...initialSnapshot };
  snapshot.status = 'running';
  snapshot.startedAt = snapshot.startedAt || new Date().toISOString();
  snapshot.updatedAt = new Date().toISOString();
  saveRealtimeComplianceSnapshot(snapshot);
  broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));

  const runConfig = realtimeComplianceRunSecrets.get(runId) || {};
  const suite = normalizeComplianceSuite(snapshot.suite);
  const mastersToRun = Array.isArray(snapshot.masterNames) ? snapshot.masterNames : [];
  const tcIdsToRun = Array.isArray(snapshot.tcIds) ? snapshot.tcIds : [];

  try {
    let sequence = Number(snapshot?.summary?.completed || 0);
    let stopped = false;
    for (let mi = 0; mi < mastersToRun.length; mi += 1) {
      const masterName = mastersToRun[mi];
      for (let ti = 0; ti < tcIdsToRun.length; ti += 1) {
        if (isRealtimeStopRequested(runId)) {
          stopped = true;
          break;
        }
        const tcId = tcIdsToRun[ti];
        snapshot.currentMaster = masterName;
        snapshot.currentTcId = tcId;
        snapshot.currentMasterIndex = mi;
        snapshot.currentTcIndex = ti;
        snapshot.progressMessage = `Running ${tcId} (${suite}) on ${masterName} (${mi + 1}/${mastersToRun.length}, test ${ti + 1}/${tcIdsToRun.length})`;
        snapshot.updatedAt = new Date().toISOString();
        saveRealtimeComplianceSnapshot(snapshot);
        broadcastRealtimeComplianceEvent(runId, 'progress', {
          runId,
          progressMessage: snapshot.progressMessage,
          currentMaster: masterName,
          currentTcId: tcId,
          summary: snapshot.summary,
        });
        broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));

        const single = await runRealtimeComplianceSingleCase({
          runId,
          suite,
          loginUrl: runConfig.loginUrl,
          username: runConfig.username,
          password: runConfig.password,
          username2: runConfig.username2,
          password2: runConfig.password2,
          masterName,
          tcId,
          showBrowser: runConfig.showBrowser,
        });

        if (isRealtimeStopRequested(runId)) {
          stopped = true;
        }

        const normalizedResult = normalizeRealtimeComplianceResultPayload(single.result, { suite, tcId });
        const resultEntry = {
          ...normalizedResult,
          suite,
          masterName,
          requestedMaster: masterName,
          requestedTcId: tcId,
          createdAt: new Date().toISOString(),
          sequence: sequence + 1,
          masterIndex: mi,
          tcIndex: ti,
          recordings: single.recordings || [],
        };

        snapshot.results.push(resultEntry);
        sequence += 1;
        snapshot.summary.completed = sequence;
        const status = normalizeRealtimeComplianceStatus(resultEntry?.status);
        if (status === 'passed') snapshot.summary.passed += 1;
        else if (status === 'blocked') snapshot.summary.blocked += 1;
        else if (status === 'not-performed') snapshot.summary.notPerformed = Number(snapshot.summary.notPerformed || 0) + 1;
        else snapshot.summary.failed += 1;
        snapshot.updatedAt = new Date().toISOString();

        appendRealtimeComplianceReportEntry({
          runId,
          suite,
          masterName,
          result: resultEntry,
          fallbackTcId: tcId,
          sequence,
          masterIndex: mi,
          tcIndex: ti,
        });

        saveRealtimeComplianceSnapshot(snapshot);
        broadcastRealtimeComplianceEvent(runId, 'tc_result', {
          runId,
          result: resultEntry,
          summary: snapshot.summary,
        });
        broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));
      }

      if (stopped) break;

      broadcastRealtimeComplianceEvent(runId, 'master_complete', {
        runId,
        masterName,
        masterIndex: mi,
        summary: snapshot.summary,
      });
    }

    if (stopped) {
      for (let mi = 0; mi < mastersToRun.length; mi += 1) {
        const masterName = mastersToRun[mi];
        for (let ti = 0; ti < tcIdsToRun.length; ti += 1) {
          const tcId = tcIdsToRun[ti];
          const alreadyExists = snapshot.results.some((entry) => entry?.masterName === masterName && entry?.requestedTcId === tcId);
          if (alreadyExists) continue;
          const notPerformedEntry = buildNotPerformedComplianceResult({
            suite,
            masterName,
            tcId,
            sequence: sequence + 1,
            masterIndex: mi,
            tcIndex: ti,
          });
          snapshot.results.push(notPerformedEntry);
          sequence += 1;
          snapshot.summary.completed = sequence;
          snapshot.summary.notPerformed = Number(snapshot.summary.notPerformed || 0) + 1;

          appendRealtimeComplianceReportEntry({
            runId,
            suite,
            masterName,
            result: notPerformedEntry,
            fallbackTcId: tcId,
            sequence,
            masterIndex: mi,
            tcIndex: ti,
          });

          broadcastRealtimeComplianceEvent(runId, 'tc_result', {
            runId,
            result: notPerformedEntry,
            summary: snapshot.summary,
          });
        }
      }
    }

    snapshot.status = stopped ? 'stopped' : 'completed';
    snapshot.currentMaster = '';
    snapshot.currentTcId = '';
    snapshot.currentMasterIndex = -1;
    snapshot.currentTcIndex = -1;
    snapshot.progressMessage = stopped ? 'Compliance run stopped by user.' : 'Compliance run completed.';
    snapshot.completedAt = new Date().toISOString();
    snapshot.updatedAt = snapshot.completedAt;
    saveRealtimeComplianceSnapshot(snapshot);
    broadcastRealtimeComplianceEvent(runId, stopped ? 'run_stopped' : 'run_complete', sanitizeRealtimeComplianceSnapshot(snapshot));
    broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));
    realtimeComplianceRunSecrets.delete(runId);
    clearRealtimeRunTask(runId);
  } catch (error) {
    const message = String(error?.message || 'Compliance run failed');
    snapshot.status = 'failed';
    snapshot.error = message;
    snapshot.progressMessage = message;
    snapshot.completedAt = new Date().toISOString();
    snapshot.updatedAt = snapshot.completedAt;
    saveRealtimeComplianceSnapshot(snapshot);
    broadcastRealtimeComplianceEvent(runId, 'run_failed', {
      runId,
      error: message,
      snapshot: sanitizeRealtimeComplianceSnapshot(snapshot),
    });
    broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));
    realtimeComplianceRunSecrets.delete(runId);
    clearRealtimeRunTask(runId);
  }
}

app.post('/api/compliance/runs', (req, res) => {
  const suite = normalizeComplianceSuite(req.body?.suite || process.env.QT_SUITE || 'DI');
  const loginUrl = req.body?.loginUrl || process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = req.body?.username || process.env.QT_USER || 'dhruvi';
  const password = req.body?.password || process.env.QT_PASS || '';
  const username2 = req.body?.username2 || process.env.QT_USER2 || username;
  const password2 = req.body?.password2 || process.env.QT_PASS2 || password;
  const showBrowser = req.body?.showBrowser !== false;
  const masterNames = expandRealtimeComplianceMasterNames(req.body || {});
  const tcIds = expandRealtimeComplianceTcIds(suite, req.body?.tcIds || [req.body?.tcId || '']);
  const total = masterNames.length * tcIds.length;
  const runId = buildRealtimeComplianceRunId();
  const clientToken = buildRealtimeComplianceClientToken();
  const nowIso = new Date().toISOString();

  const snapshot = {
    runId,
    clientToken,
    suite,
    status: 'running',
    createdAt: nowIso,
    startedAt: nowIso,
    updatedAt: nowIso,
    completedAt: '',
    progressMessage: 'Compliance run queued.',
    currentMaster: '',
    currentTcId: '',
    currentMasterIndex: -1,
    currentTcIndex: -1,
    masterNames,
    tcIds,
    results: [],
    summary: {
      total,
      completed: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      notPerformed: 0,
    },
    runConfig: {
      suite,
      loginUrl: String(loginUrl),
      username: String(username),
      username2: String(username2),
      showBrowser: !!showBrowser,
    },
    requestMeta: {
      suite,
      loginUrl: String(loginUrl),
      username: String(username),
      username2: String(username2),
      showBrowser: !!showBrowser,
      masterNames,
      tcIds,
    },
  };

  realtimeComplianceRunSecrets.set(runId, {
    suite,
    loginUrl: String(loginUrl),
    username: String(username),
    password: String(password),
    username2: String(username2),
    password2: String(password2),
    showBrowser: !!showBrowser,
  });
  realtimeComplianceRunTasks.set(runId, { stopRequested: false, child: null });
  saveRealtimeComplianceSnapshot(snapshot);
  setImmediate(() => {
    processRealtimeComplianceRun(runId).catch((error) => {
      const current = getRealtimeComplianceSnapshot(runId);
      if (!current || isRealtimeComplianceTerminal(current.status)) return;
      current.status = 'failed';
      current.error = String(error?.message || 'Compliance run failed');
      current.progressMessage = current.error;
      current.completedAt = new Date().toISOString();
      current.updatedAt = current.completedAt;
      saveRealtimeComplianceSnapshot(current);
      broadcastRealtimeComplianceEvent(runId, 'run_failed', {
        runId,
        error: current.error,
        snapshot: sanitizeRealtimeComplianceSnapshot(current),
      });
      realtimeComplianceRunSecrets.delete(runId);
      clearRealtimeRunTask(runId);
    });
  });

  return res.status(202).json({
    runId,
    clientToken,
    status: snapshot.status,
  });
});

app.get('/api/compliance/runs/:runId', (req, res) => {
  const runId = String(req.params?.runId || '').trim();
  const clientToken = String(req.query?.clientToken || '').trim();
  const access = verifyRealtimeComplianceAccess(runId, clientToken);
  if (!access.ok) return res.status(access.code).json({ message: access.message });
  return res.json(sanitizeRealtimeComplianceSnapshot(access.snapshot));
});

app.post('/api/compliance/runs/:runId/stop', async (req, res) => {
  const runId = String(req.params?.runId || '').trim();
  const clientToken = String(req.body?.clientToken || req.query?.clientToken || '').trim();
  const access = verifyRealtimeComplianceAccess(runId, clientToken);
  if (!access.ok) return res.status(access.code).json({ message: access.message });

  const snapshot = { ...access.snapshot };
  if (isRealtimeComplianceTerminal(snapshot.status)) {
    return res.json({
      runId,
      status: snapshot.status,
      alreadyTerminal: true,
      snapshot: sanitizeRealtimeComplianceSnapshot(snapshot),
    });
  }

  markRealtimeStopRequested(runId);
  const killed = await killRealtimeChildProcess(runId);
  snapshot.progressMessage = 'Stop requested. Finalizing results...';
  snapshot.updatedAt = new Date().toISOString();
  saveRealtimeComplianceSnapshot(snapshot);
  broadcastRealtimeComplianceEvent(runId, 'progress', {
    runId,
    progressMessage: snapshot.progressMessage,
    currentMaster: snapshot.currentMaster,
    currentTcId: snapshot.currentTcId,
    summary: snapshot.summary,
  });
  broadcastRealtimeComplianceEvent(runId, 'snapshot', sanitizeRealtimeComplianceSnapshot(snapshot));

  return res.json({
    runId,
    status: 'stopping',
    killed,
  });
});

app.get('/api/compliance/runs/:runId/stream', (req, res) => {
  const runId = String(req.params?.runId || '').trim();
  const clientToken = String(req.query?.clientToken || '').trim();
  const access = verifyRealtimeComplianceAccess(runId, clientToken);
  if (!access.ok) return res.status(access.code).json({ message: access.message });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let clients = realtimeComplianceSseClients.get(runId);
  if (!clients) {
    clients = new Set();
    realtimeComplianceSseClients.set(runId, clients);
  }
  clients.add(res);

  writeRealtimeComplianceSseEvent(res, 'snapshot', sanitizeRealtimeComplianceSnapshot(access.snapshot));
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // Ignore dead socket write errors.
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const currentClients = realtimeComplianceSseClients.get(runId);
    if (!currentClients) return;
    currentClients.delete(res);
    if (currentClients.size === 0) {
      realtimeComplianceSseClients.delete(runId);
    }
  });
});

// ─── Template Workflow: Get last run state (for Resume) ───────────────────────
app.get('/api/template-workflow/last-run', (req, res) => {
  const lastRunPath = path.resolve(__dirname, 'last-run-state.json');
  try {
    if (!fs.existsSync(lastRunPath)) return res.json({ exists: false });
    const data = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'));
    return res.json({ exists: true, ...data });
  } catch {
    return res.json({ exists: false });
  }
});

app.listen(PORT, () => {
  console.log(`Node backend running on http://127.0.0.1:${PORT}`);
});
