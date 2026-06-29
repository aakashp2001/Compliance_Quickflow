'use strict';

const crypto = require('crypto');

function readFirstEnv(keys = [], fallback = '') {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return fallback;
}

function parseCsv(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeExecutionId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSuite(value) {
  return String(value || 'DI').trim().toUpperCase() || 'DI';
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'passed' || normalized === 'failed' || normalized === 'blocked' || normalized === 'not-performed') {
    return normalized;
  }
  return normalized || 'unknown';
}

function resolveLoginHost(urlValue) {
  try {
    return new URL(String(urlValue || '')).host;
  } catch {
    return '';
  }
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== '' && entry !== undefined && entry !== null)
  );
}

function getRequirementMap() {
  const raw = readFirstEnv(['QT_REQUIREMENT_IDS_JSON'], '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }
  return {};
}

function getRequirementIds(tcId, suite) {
  const byCaseEnvKey = `QT_REQUIREMENT_IDS_${String(tcId || '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
  const fromCaseEnv = parseCsv(readFirstEnv([byCaseEnvKey], ''));
  if (fromCaseEnv.length) return fromCaseEnv;

  const requirementMap = getRequirementMap();
  const mapped = requirementMap[String(tcId || '').trim()] || requirementMap[String(suite || '').trim()];
  if (Array.isArray(mapped)) {
    return mapped.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof mapped === 'string') {
    return parseCsv(mapped);
  }

  const generic = parseCsv(readFirstEnv(['QT_REQUIREMENT_IDS'], ''));
  return generic;
}

function buildActualResult(tcResult) {
  const details = Array.isArray(tcResult?.details) ? tcResult.details : [];
  const failedSteps = details.filter((item) => item && item.passed === false).length;
  if (!details.length) {
    return `status=${normalizeStatus(tcResult?.status)}`;
  }
  return `status=${normalizeStatus(tcResult?.status)}; failed_steps=${failedSteps}; total_steps=${details.length}`;
}

function buildRunTraceability({ suite, runnerName, result }) {
  const browser = readFirstEnv(['QT_BROWSER_NAME', 'QT_BROWSER', 'PW_BROWSER', 'BROWSER'], 'chromium');
  const executionToolOrMethod = readFirstEnv(
    ['QT_EXECUTION_TOOL', 'QT_EXECUTION_METHOD'],
    `Playwright ${browser} via Node.js (${runnerName})`
  );

  const testDataSet = cleanObject({
    suite,
    masterName: String(result?.masterName || process.env.QT_MASTER || '').trim(),
    requestedTcId: String(result?.tcId || process.env.QT_TC_ID || '').trim(),
    dataSetId: readFirstEnv(['QT_DATASET_ID', 'QT_TEST_DATASET_ID', 'TEST_DATASET_ID', 'QT_DATASET', 'TEST_DATASET'], ''),
    loginHost: resolveLoginHost(readFirstEnv(['QT_URL'], '')),
    headless: readFirstEnv(['QT_HEADLESS'], ''),
  });

  return {
    executionId: readFirstEnv(['QT_EXECUTION_ID', 'COMPLIANCE_EXECUTION_ID', 'EXECUTION_ID'], makeExecutionId()),
    suite,
    runner: runnerName,
    executionDate: new Date().toISOString(),
    tester: readFirstEnv(['EXECUTED_BY', 'QT_EXECUTED_BY', 'QT_USER', 'USERNAME', 'USER'], 'unknown'),
    environmentName: readFirstEnv(['QT_ENV_NAME', 'ENV', 'TEST_ENV', 'QT_ENV', 'NODE_ENV'], 'unspecified'),
    softwareVersionUnderTest: readFirstEnv(['QT_BUILD_VERSION', 'QT_VERSION_UNDER_TEST', 'APP_VERSION', 'BUILD_VERSION', 'RELEASE_VERSION', 'COMMIT_SHA'], 'unknown-version'),
    executionToolOrMethod,
    browser,
    testDataSet,
  };
}

function buildCaseTraceability(base, tcResult) {
  const testCaseId = String(tcResult?.tcId || '').trim();
  return {
    ...base,
    testCaseId,
    requirementIds: getRequirementIds(testCaseId, base.suite),
    objective: String(tcResult?.title || '').trim(),
    status: normalizeStatus(tcResult?.status),
    actualResult: buildActualResult(tcResult),
  };
}

function attachComplianceTraceability(result, options = {}) {
  if (!result || typeof result !== 'object') return result;

  const suite = normalizeSuite(options.suite || result.suite || process.env.QT_SUITE || 'DI');
  const runnerName = String(options.runnerName || 'compliance-runner.js').trim();
  const runTraceability = buildRunTraceability({ suite, runnerName, result });
  const output = { ...result };

  if (output.mode === 'all' && Array.isArray(output.results)) {
    output.results = output.results.map((entry) => ({
      ...entry,
      executionTraceability: buildCaseTraceability(runTraceability, entry),
    }));
    output.executionTraceability = {
      ...runTraceability,
      objective: `Compliance suite execution (${suite})`,
      status: normalizeStatus(output?.summary?.failed > 0 ? 'failed' : 'passed'),
      actualResult: `total=${Number(output?.summary?.total || 0)}, passed=${Number(output?.summary?.passed || 0)}, failed=${Number(output?.summary?.failed || 0)}`,
    };
    output.suite = output.suite || suite;
    return output;
  }

  output.executionTraceability = buildCaseTraceability(runTraceability, output);
  output.suite = output.suite || suite;
  return output;
}

module.exports = {
  attachComplianceTraceability,
};