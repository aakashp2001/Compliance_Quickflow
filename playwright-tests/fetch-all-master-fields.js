'use strict';

const { chromium } = require('@playwright/test');
const {
  enableArtifactOverlayOnContext,
  enableArtifactOverlayOnPage,
  updateArtifactOverlay,
} = require('./helpers/artifactOverlay');
const {
  login,
  openMasterAndForm,
  getFields,
  detectDependencies,
  throwIfQuickFlowError,
} = require('./fetch-master-fields');

function parseMasterNames() {
  const raw = process.env.QT_MASTERS_JSON || '[]';
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const headless = String(process.env.QT_HEADLESS || 'true').toLowerCase() !== 'false';
  const recordVideo = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
  const masterNames = parseMasterNames();

  if (!masterNames.length) {
    process.stdout.write(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      count: 0,
      results: [],
    }));
    return;
  }

  let browser;
  let context;

  try {
    browser = await chromium.launch({ headless });
    const contextOptions = {
      viewport: { width: 1366, height: 900 },
    };
    if (recordVideo) {
      contextOptions.recordVideo = {
        dir: 'test-reports',
        size: { width: 1280, height: 720 },
      };
    }
    context = await browser.newContext(contextOptions);
    await enableArtifactOverlayOnContext(context);

    const page = await context.newPage();
    await enableArtifactOverlayOnPage(page);
    await updateArtifactOverlay(page, {
      operation: 'fetch-all-fields',
      status: 'running',
      step: 'login',
    });

    await login(page, { loginUrl, username, password });
    const baseURL = new URL(page.url()).origin;

    const results = [];
    for (const masterName of masterNames) {
      await updateArtifactOverlay(page, {
        masterName,
        operation: 'fetch-all-fields',
        status: 'running',
        step: 'extract-fields',
      });

      try {
        await openMasterAndForm(page, baseURL, masterName);
        await throwIfQuickFlowError(page, masterName, 'bulk field fetch');
        const fields = await getFields(page);
        const detectedDependencies = await detectDependencies(page);
        results.push({
          master: masterName,
          fetchedAt: new Date().toISOString(),
          fields: Array.isArray(fields) ? fields : [],
          detectedDependencies: detectedDependencies || { parentDropdowns: [], dependentDropdowns: [] },
          error: '',
        });
      } catch (error) {
        results.push({
          master: masterName,
          fetchedAt: new Date().toISOString(),
          fields: [],
          detectedDependencies: { parentDropdowns: [], dependentDropdowns: [] },
          error: String(error?.message || 'Field extraction failed'),
        });
      }
    }

    await updateArtifactOverlay(page, {
      operation: 'fetch-all-fields',
      status: 'completed',
      step: 'done',
    });

    process.stdout.write(JSON.stringify({
      fetchedAt: new Date().toISOString(),
      count: results.length,
      results,
    }));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

run().catch((error) => {
  process.stderr.write(error?.message || 'Failed to fetch all master fields');
  process.exit(1);
});

