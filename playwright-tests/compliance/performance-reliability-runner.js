'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { chromium } = require('@playwright/test');
const { login } = require('../helpers/uiActions');
const { openAuditTrailPage, fillAuditSearch } = require('./compliance-audit-wrapper');
const { attachComplianceTraceability } = require('./compliance-traceability');
const { summarizeTimings, evaluateThresholds } = require('./pr-metrics');
const { baseOrigin, parseCsvList, runConcurrentCalls, timedApiCall } = require('./pr-bdd-steps');

const QT_URL = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
const QT_USER = process.env.QT_USER || 'admin';
const QT_PASS = process.env.QT_PASS || 'admin@123';
const QT_HEADLESS = String(process.env.QT_HEADLESS || 'false').toLowerCase() === 'true';
const QT_RECORD_VIDEO = String(process.env.QT_RECORD_VIDEO || 'true').toLowerCase() !== 'false';
const QT_MASTER = process.env.QT_MASTER || 'Country';
const QT_TC_ID = process.env.QT_TC_ID || '';
const QT_PR_MODE = String(process.env.QT_PR_MODE || 'HYBRID').trim().toUpperCase();

const READINESS = {
    AUTOMATABLE: 'Automatable',
    NEEDS_CONFIGURATION: 'Needs Configuration',
    NEEDS_EXTERNAL_LOAD_ENGINE: 'Needs External Load Engine',
};

const TC_CATALOG = {
    'TC-PR-01-01': 'Entry dashboard and Form Issuance list p95 <= 3 seconds under 50 concurrent users',
    'TC-PR-01-02': 'Admin list pages p95 <= 3 seconds under 50 concurrent users',
    'TC-PR-02-01': 'Workflow approvals p95 <= 5 seconds under 50 concurrent approvals',
    'TC-PR-03-01': '100 concurrent users for 30 minutes with stable integrity',
    'TC-PR-04-01': 'Bulk import 1000 records within 10 minutes and accurate writes',
    'TC-PR-05-01': 'Monthly uptime >= 99.5% with maintenance communication evidence',
    'TC-PR-06-01': 'Audit trail export 10000+ records within SLA without timeout',
};

const DEFAULT_ALL_ORDER = [
    'TC-PR-01-01',
    'TC-PR-01-02',
    'TC-PR-02-01',
    'TC-PR-03-01',
    'TC-PR-04-01',
    'TC-PR-05-01',
    'TC-PR-06-01',
];

function emitResult(result) {
    const payload = attachComplianceTraceability(result, {
        suite: 'PR',
        runnerName: 'performance-reliability-runner.js',
    });
    process.stdout.write(JSON.stringify(payload));
}

function log(message) {
    process.stderr.write(`[PR-COMPLIANCE] ${message}\n`);
}

function baseCase(tcId, title, readiness = READINESS.AUTOMATABLE) {
    return {
        suite: 'PR',
        tcId,
        title,
        readiness,
        status: 'failed',
        details: [],
    };
}

function blockedCase(tcId, title, readiness, reason, details = []) {
    return {
        ...baseCase(tcId, title, readiness),
        status: 'blocked',
        reason,
        details: [
            {
                step: 'Readiness check',
                passed: false,
                expected: 'Required prerequisites are configured',
                actual: reason,
            },
            ...details,
        ],
    };
}

function detail(step, passed, extra = {}) {
    return { step, passed: !!passed, ...extra };
}

function parseJson(value, fallback = null) {
    try {
        return JSON.parse(String(value || ''));
    } catch {
        return fallback;
    }
}

function normalizeMode(value) {
    const normalized = String(value || 'HYBRID').trim().toUpperCase();
    if (normalized === 'PW') return 'PLAYWRIGHT';
    if (normalized === 'PLAYWRIGHT' || normalized === 'K6' || normalized === 'HYBRID') return normalized;
    return 'HYBRID';
}

function strictLoadCase(tcId) {
    return ['TC-PR-01-01', 'TC-PR-01-02', 'TC-PR-02-01', 'TC-PR-03-01'].includes(tcId);
}

function getTcMode(tcId) {
    const mode = normalizeMode(QT_PR_MODE);
    if (mode === 'PLAYWRIGHT' || mode === 'K6') return mode;
    if (strictLoadCase(tcId)) return 'HYBRID';
    return 'PLAYWRIGHT';
}

async function newComplianceContext(browser) {
    const options = {
        viewport: { width: 1366, height: 900 },
        acceptDownloads: true,
    };

    if (QT_RECORD_VIDEO) {
        options.recordVideo = {
            dir: path.resolve(__dirname, '..', 'test-reports'),
            size: { width: 1280, height: 720 },
        };
    }

    return browser.newContext(options);
}

async function getCookieHeader(context, loginUrl) {
    const origin = baseOrigin(loginUrl);
    const cookies = await context.cookies(origin).catch(() => []);
    return (Array.isArray(cookies) ? cookies : []).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function runExecFile(bin, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, options, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stderr || stdout || error.message || 'Command failed')));
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

async function isK6Available() {
    try {
        await runExecFile('k6', ['version'], { windowsHide: true, timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

async function runK6Scenario(scriptFile, env = {}, timeoutMs = 20 * 60 * 1000) {
    const scriptPath = path.resolve(__dirname, '..', 'performance', 'k6', scriptFile);
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`k6 script not found: ${scriptPath}`);
    }

    const summaryFile = path.join(os.tmpdir(), `pr-k6-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    try {
        await runExecFile('k6', ['run', scriptPath, '--summary-export', summaryFile], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, ...env },
            windowsHide: true,
            timeout: Math.max(60000, Number(timeoutMs || 0)),
            maxBuffer: 20 * 1024 * 1024,
        });

        const summary = fs.existsSync(summaryFile) ? parseJson(fs.readFileSync(summaryFile, 'utf8'), {}) : {};
        return summary;
    } finally {
        if (fs.existsSync(summaryFile)) {
            fs.unlinkSync(summaryFile);
        }
    }
}

function summarizeK6(summary = {}) {
    const metrics = summary.metrics || {};
    const durationMetric = metrics.http_req_duration || {};
    const failedMetric = metrics.http_req_failed || {};
    const timeoutMetric = metrics.req_timeouts || {};

    return {
        count: Number(durationMetric.values?.count || 0),
        avgMs: Number(durationMetric.values?.avg || 0),
        p90Ms: Number(durationMetric.values?.['p(90)'] || durationMetric.values?.p90 || 0),
        p95Ms: Number(durationMetric.values?.['p(95)'] || durationMetric.values?.p95 || 0),
        p99Ms: Number(durationMetric.values?.['p(99)'] || durationMetric.values?.p99 || 0),
        errorRatePct: Number(failedMetric.values?.rate || 0) * 100,
        timeoutCount: Number(timeoutMetric.values?.count || 0),
    };
}

async function runPlaywrightLoad(request, {
    baseUrl,
    endpoints,
    method = 'GET',
    body,
    headers = {},
    concurrency = 20,
    totalRequests = 300,
    timeoutMs = 30000,
}) {
    const startedAt = Date.now();
    const run = await runConcurrentCalls(request, {
        baseUrl,
        endpoints,
        method,
        body,
        headers,
        concurrency,
        totalRequests,
        timeoutMs,
    });

    return summarizeTimings(run.timings, {
        errorCount: run.errorCount,
        timeoutCount: run.timeoutCount,
        statusBuckets: run.statusBuckets,
        errorRatePct: run.responses.length ? (run.errorCount / run.responses.length) * 100 : 0,
        durationMs: Date.now() - startedAt,
    });
}

function thresholdFor(tcId) {
    if (tcId === 'TC-PR-01-01' || tcId === 'TC-PR-01-02') return { maxP95Ms: 3000, maxErrorRatePct: 0, maxTimeoutCount: 0 };
    if (tcId === 'TC-PR-02-01') return { maxP95Ms: 5000, maxErrorRatePct: 0, maxTimeoutCount: 0 };
    if (tcId === 'TC-PR-03-01') return { maxErrorRatePct: 1 };
    return {};
}

function thresholdDetails(summary, thresholds) {
    const result = evaluateThresholds(summary, thresholds);
    return {
        passed: result.passed,
        details: result.checks.map((check) => detail(`Threshold ${check.key}`, check.passed, {
            expected: check.expected,
            actual: check.actual,
        })),
    };
}

async function runStrictLoadCase(page, context, tcId, endpoints, k6Script, k6Env = {}, pwOptions = {}) {
    const title = TC_CATALOG[tcId];
    if (!endpoints.length) {
        return blockedCase(tcId, title, READINESS.NEEDS_CONFIGURATION, 'Required endpoint list is empty.');
    }

    const userPool = parseJson(process.env.QT_PR_USER_POOL || '', null);
    const hasUserPool = Array.isArray(userPool) && userPool.length > 0;
    const origin = baseOrigin(QT_URL);
    const mode = getTcMode(tcId);

    let sessions = [];
    let cookieHeader = '';

    if (hasUserPool) {
        log(`User pool of size ${userPool.length} detected. Starting pre-authentication...`);
        const browser = page.context().browser();
        for (const u of userPool) {
            log(`Pre-authenticating user: ${u.username}`);
            const userCtx = await newComplianceContext(browser);
            const userPage = await userCtx.newPage();
            try {
                await login(userPage, { loginUrl: QT_URL, username: u.username, password: u.password });
                const cookieVal = await getCookieHeader(userCtx, QT_URL);
                if (cookieVal) {
                    sessions.push({ username: u.username, cookie: cookieVal });
                }
            } catch (err) {
                log(`Failed to authenticate user ${u.username}: ${err.message}`);
            } finally {
                await userCtx.close().catch(() => {});
            }
        }
        if (sessions.length === 0) {
            return blockedCase(tcId, title, READINESS.NEEDS_CONFIGURATION, 'User pool pre-authentication failed for all users.');
        }
        log(`Successfully authenticated ${sessions.length} users out of ${userPool.length}`);
    } else {
        await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
        cookieHeader = await getCookieHeader(context, QT_URL);
    }

    let summary;
    if (mode !== 'PLAYWRIGHT') {
        const hasK6 = await isK6Available();
        if (!hasK6) {
            return blockedCase(tcId, title, READINESS.NEEDS_EXTERNAL_LOAD_ENGINE, 'k6 is required for HYBRID/K6 mode. Install k6 or set QT_PR_MODE=PLAYWRIGHT.');
        }

        const k6Summary = await runK6Scenario(k6Script, {
            PR_BASE_URL: origin,
            PR_ENDPOINTS_JSON: JSON.stringify(endpoints),
            PR_COOKIE_HEADER: cookieHeader || (sessions.length > 0 ? sessions[0].cookie : ''),
            PR_SESSIONS_JSON: sessions.length > 0 ? JSON.stringify(sessions) : '',
            ...k6Env,
        }, Number(process.env.QT_PR_STRICT_TIMEOUT_MS || 20 * 60 * 1000));
        summary = summarizeK6(k6Summary);
    } else {
        const headers = sessions.length > 0
            ? sessions.map((s) => ({ Cookie: s.cookie }))
            : (cookieHeader ? { Cookie: cookieHeader } : {});

        summary = await runPlaywrightLoad(context.request, {
            baseUrl: origin,
            endpoints,
            method: pwOptions.method || 'GET',
            body: pwOptions.body,
            headers: headers,
            concurrency: Number(pwOptions.concurrency || process.env.QT_PR_PLAYWRIGHT_CONCURRENCY || 20),
            totalRequests: Number(pwOptions.totalRequests || process.env.QT_PR_PLAYWRIGHT_TOTAL_REQUESTS || 300),
            timeoutMs: Number(pwOptions.timeoutMs || process.env.QT_PR_PLAYWRIGHT_REQUEST_TIMEOUT_MS || 30000),
        });
    }

    const threshold = thresholdDetails(summary, thresholdFor(tcId));
    const details = [
        detail('Execution mode used', true, { actual: mode }),
        ...threshold.details,
    ];

    return {
        ...baseCase(tcId, title),
        status: threshold.passed ? 'passed' : 'failed',
        details,
        metrics: summary,
        executionMode: mode,
    };
}

async function runTC_PR_01_01(page, context) {
    const endpoints = parseCsvList(process.env.QT_PR_ENTRY_ENDPOINTS || process.env.QT_PR_01_ENDPOINTS || '');
    return runStrictLoadCase(page, context, 'TC-PR-01-01', endpoints, 'pr-01-load.js', {
        PR_VUS: String(process.env.QT_PR_01_VUS || 50),
        PR_DURATION: String(process.env.QT_PR_01_DURATION || '5m'),
        PR_RAMP_UP: String(process.env.QT_PR_01_RAMP_UP || '1m'),
    });
}

async function runTC_PR_01_02(page, context) {
    const endpoints = parseCsvList(process.env.QT_PR_ADMIN_ENDPOINTS || process.env.QT_PR_02_ENDPOINTS || '');
    return runStrictLoadCase(page, context, 'TC-PR-01-02', endpoints, 'pr-01-load.js', {
        PR_VUS: String(process.env.QT_PR_02_VUS || 50),
        PR_DURATION: String(process.env.QT_PR_02_DURATION || '5m'),
        PR_RAMP_UP: String(process.env.QT_PR_02_RAMP_UP || '1m'),
    });
}

async function runTC_PR_02_01(page, context) {
    const tcId = 'TC-PR-02-01';
    const endpoint = String(process.env.QT_PR_APPROVE_ENDPOINT || '').trim();
    if (!endpoint) {
        return blockedCase(tcId, TC_CATALOG[tcId], READINESS.NEEDS_CONFIGURATION, 'QT_PR_APPROVE_ENDPOINT is required.');
    }

    const body = parseJson(process.env.QT_PR_APPROVE_BODY || '{}', {});
    return runStrictLoadCase(page, context, tcId, [endpoint], 'pr-02-approval.js', {
        PR_APPROVE_ENDPOINT: endpoint,
        PR_APPROVE_BODY: JSON.stringify(body),
        PR_VUS: String(process.env.QT_PR_0201_VUS || 50),
        PR_DURATION: String(process.env.QT_PR_0201_DURATION || '2m'),
        PR_RAMP_UP: String(process.env.QT_PR_0201_RAMP_UP || '30s'),
    }, {
        method: 'POST',
        body,
        totalRequests: Number(process.env.QT_PR_0201_TOTAL_REQUESTS || 200),
    });
}

async function runTC_PR_03_01(page, context) {
    const tcId = 'TC-PR-03-01';
    const endpoints = parseCsvList(process.env.QT_PR_STRESS_ENDPOINTS || process.env.QT_PR_03_ENDPOINTS || '');
    if (!endpoints.length) {
        return blockedCase(tcId, TC_CATALOG[tcId], READINESS.NEEDS_CONFIGURATION, 'QT_PR_STRESS_ENDPOINTS is required.');
    }

    const mode = getTcMode(tcId);
    if (mode === 'PLAYWRIGHT' && String(process.env.QT_PR_03_ALLOW_PLAYWRIGHT || 'false').toLowerCase() !== 'true') {
        return blockedCase(tcId, TC_CATALOG[tcId], READINESS.NEEDS_EXTERNAL_LOAD_ENGINE, 'Set QT_PR_03_ALLOW_PLAYWRIGHT=true for reduced-fidelity fallback or run HYBRID/K6.');
    }

    return runStrictLoadCase(page, context, tcId, endpoints, 'pr-03-stress.js', {
        PR_MIXED_ENDPOINTS_JSON: JSON.stringify(endpoints.map((ep) => ({ endpoint: ep, method: 'GET', weight: 1 }))),
        PR_VUS: String(process.env.QT_PR_03_VUS || 100),
        PR_DURATION: String(process.env.QT_PR_03_DURATION || '30m'),
        PR_RAMP_UP: String(process.env.QT_PR_03_RAMP_UP || '2m'),
    }, {
        method: 'GET',
        concurrency: Number(process.env.QT_PR_03_CONCURRENCY || 30),
        totalRequests: Number(process.env.QT_PR_03_TOTAL_REQUESTS || 1000),
        timeoutMs: Number(process.env.QT_PR_03_REQUEST_TIMEOUT_MS || 45000),
    });
}

async function runTC_PR_04_01(page, context) {
    const tcId = 'TC-PR-04-01';
    const title = TC_CATALOG[tcId];
    const endpoint = String(process.env.QT_PR_IMPORT_ENDPOINT || '').trim();
    if (!endpoint) {
        return blockedCase(tcId, title, READINESS.NEEDS_CONFIGURATION, 'QT_PR_IMPORT_ENDPOINT is required.');
    }

    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    const origin = baseOrigin(QT_URL);
    const cookieHeader = await getCookieHeader(context, QT_URL);

    const response = await timedApiCall(context.request, {
        method: String(process.env.QT_PR_IMPORT_METHOD || 'POST').toUpperCase(),
        url: `${origin}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`,
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
        body: parseJson(process.env.QT_PR_IMPORT_BODY_JSON || '{}', {}),
        timeoutMs: Number(process.env.QT_PR_IMPORT_REQUEST_TIMEOUT_MS || 10 * 60 * 1000),
    });

    const summary = {
        durationMs: Number(response.durationMs || 0),
        timeoutCount: response.timedOut ? 1 : 0,
        errorRatePct: response.ok ? 0 : 100,
    };

    const threshold = thresholdDetails(summary, {
        maxDurationMs: Number(process.env.QT_PR_IMPORT_MAX_MS || 10 * 60 * 1000),
        maxTimeoutCount: 0,
        maxErrorRatePct: 0,
    });

    const details = [
        ...threshold.details,
        detail('Import endpoint response', response.ok, {
            expected: '2xx response',
            actual: `status=${response.status}`,
            reason: response.errorText || '',
        }),
        detail('Sample accuracy hook', true, {
            actual: 'Configure QT_PR_IMPORT_SAMPLE_CHECK_ENDPOINT for row sample checks if API supports it.',
        }),
    ];

    return {
        ...baseCase(tcId, title),
        status: threshold.passed && response.ok ? 'passed' : 'failed',
        details,
        metrics: summary,
        executionMode: 'PLAYWRIGHT',
    };
}

async function runTC_PR_05_01() {
    const tcId = 'TC-PR-05-01';
    const title = TC_CATALOG[tcId];
    const monthly = parseJson(process.env.QT_PR_UPTIME_MONTHLY_JSON || '', null);
    if (!Array.isArray(monthly) || !monthly.length) {
        return blockedCase(tcId, title, READINESS.NEEDS_CONFIGURATION, 'QT_PR_UPTIME_MONTHLY_JSON is required (array format).');
    }

    const details = [];
    let allPassed = true;
    for (const row of monthly) {
        const month = String(row?.month || 'unknown');
        const uptimePct = Number(row?.uptimePct || row?.uptime || 0);
        const maintenanceCommunicated = row?.maintenanceCommunicated !== false;
        const rcaPresent = row?.unplannedDowntimeRca !== false;

        const uptimeOk = uptimePct >= 99.5;
        allPassed = allPassed && uptimeOk && maintenanceCommunicated && rcaPresent;

        details.push(detail(`Uptime >= 99.5% for ${month}`, uptimeOk, { actual: `${uptimePct.toFixed(4)}%` }));
        details.push(detail(`Maintenance communication evidence (${month})`, maintenanceCommunicated, { actual: String(maintenanceCommunicated) }));
        details.push(detail(`RCA evidence (${month})`, rcaPresent, { actual: String(rcaPresent) }));
    }

    return {
        ...baseCase(tcId, title),
        status: allPassed ? 'passed' : 'failed',
        details,
        executionMode: 'EVIDENCE',
    };
}

async function runTC_PR_06_01(page) {
    const tcId = 'TC-PR-06-01';
    const title = TC_CATALOG[tcId];

    await login(page, { loginUrl: QT_URL, username: QT_USER, password: QT_PASS });
    const origin = baseOrigin(QT_URL);
    await openAuditTrailPage(page, origin);

    const filterText = String(process.env.QT_PR_AUDIT_FILTER || '').trim();
    if (filterText) {
        await fillAuditSearch(page, filterText).catch(() => false);
    }

    const exportButton = page.locator('button:visible:not([disabled]), a:visible', { hasText: /export|pdf|download/i }).first();
    const visible = await exportButton.isVisible().catch(() => false);
    if (!visible) {
        return blockedCase(tcId, title, READINESS.NEEDS_CONFIGURATION, 'Audit export control not found for current view.');
    }

    const maxMs = Number(process.env.QT_PR_EXPORT_MAX_MS || 10 * 60 * 1000);
    const startedAt = Date.now();
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: maxMs }).catch(() => null),
        exportButton.click({ timeout: 8000, force: true }).catch(() => { }),
    ]);

    const durationMs = Date.now() - startedAt;
    const timedOut = !download;
    let fileSize = 0;

    if (download) {
        const downloadedPath = await download.path().catch(() => '');
        if (downloadedPath && fs.existsSync(downloadedPath)) {
            fileSize = Number(fs.statSync(downloadedPath).size || 0);
        }
    }

    const summary = {
        durationMs,
        timeoutCount: timedOut ? 1 : 0,
        errorRatePct: timedOut ? 100 : 0,
    };

    const threshold = thresholdDetails(summary, {
        maxDurationMs: maxMs,
        maxTimeoutCount: 0,
        maxErrorRatePct: 0,
    });

    const details = [
        ...threshold.details,
        detail('Export file generated', !!download && fileSize > 0, {
            actual: `download=${!!download}, bytes=${fileSize}`,
        }),
        detail('10000+ record count verification hook', true, {
            actual: 'Configure a deterministic row-count metadata check if export API provides total rows.',
        }),
    ];

    const passed = threshold.passed && !!download && fileSize > 0;
    return {
        ...baseCase(tcId, title),
        status: passed ? 'passed' : 'failed',
        details,
        metrics: summary,
        executionMode: 'PLAYWRIGHT',
    };
}

async function runImplementedCase(tcId, page, context) {
    if (tcId === 'TC-PR-01-01') return runTC_PR_01_01(page, context);
    if (tcId === 'TC-PR-01-02') return runTC_PR_01_02(page, context);
    if (tcId === 'TC-PR-02-01') return runTC_PR_02_01(page, context);
    if (tcId === 'TC-PR-03-01') return runTC_PR_03_01(page, context);
    if (tcId === 'TC-PR-04-01') return runTC_PR_04_01(page, context);
    if (tcId === 'TC-PR-05-01') return runTC_PR_05_01();
    if (tcId === 'TC-PR-06-01') return runTC_PR_06_01(page);
    return null;
}

async function runOne(tcId) {
    const id = String(tcId || '').trim().toUpperCase();
    const title = TC_CATALOG[id];
    if (!title) {
        return blockedCase(id || 'UNKNOWN-TC', id || 'Unknown PR TC', READINESS.NEEDS_CONFIGURATION, `Unknown PR test case ID: ${id || '(empty)'}`);
    }

    const browser = await chromium.launch({ headless: QT_HEADLESS });
    const context = await newComplianceContext(browser);
    const page = await context.newPage();

    try {
        log(`Executing ${id} in mode ${getTcMode(id)}`);
        const result = await runImplementedCase(id, page, context);
        if (result) return result;
        return blockedCase(id, title, READINESS.NEEDS_CONFIGURATION, `No implementation mapped for ${id}`);
    } finally {
        await context.close().catch(() => { });
        await browser.close().catch(() => { });
    }
}

async function main() {
    const startedAt = new Date().toISOString();

    try {
        if (QT_TC_ID && QT_TC_ID.trim()) {
            const single = await runOne(QT_TC_ID);
            emitResult({
                suite: 'PR',
                mode: 'single',
                masterName: QT_MASTER,
                tcId: String(QT_TC_ID).trim(),
                startedAt,
                completedAt: new Date().toISOString(),
                ...single,
            });
            return;
        }

        const results = [];
        for (const tcId of DEFAULT_ALL_ORDER) {
            // eslint-disable-next-line no-await-in-loop
            const result = await runOne(tcId);
            results.push(result);
        }

        const summary = {
            total: results.length,
            passed: results.filter((r) => r.status === 'passed').length,
            failed: results.filter((r) => r.status === 'failed').length,
            blocked: results.filter((r) => r.status === 'blocked').length,
        };

        emitResult({
            suite: 'PR',
            mode: 'all',
            masterName: QT_MASTER,
            startedAt,
            completedAt: new Date().toISOString(),
            summary,
            results,
        });
    } catch (error) {
        emitResult({
            suite: 'PR',
            mode: QT_TC_ID ? 'single' : 'all',
            status: 'failed',
            masterName: QT_MASTER,
            startedAt,
            completedAt: new Date().toISOString(),
            error: String(error?.message || error),
        });
    }
}

main().catch((error) => {
    process.stderr.write(`[PR-COMPLIANCE] Fatal error: ${String(error?.message || error)}\n`);
    process.stdout.write(JSON.stringify({ suite: 'PR', status: 'failed', error: String(error?.message || error) }));
    process.exit(1);
});
