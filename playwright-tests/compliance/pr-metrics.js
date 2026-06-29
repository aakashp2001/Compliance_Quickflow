'use strict';

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values, p) {
  const arr = Array.isArray(values)
    ? values.map((value) => toNumber(value, NaN)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    : [];
  if (!arr.length) return 0;
  const clamped = Math.max(0, Math.min(100, toNumber(p, 95)));
  const rank = (clamped / 100) * (arr.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return arr[low];
  const weight = rank - low;
  return arr[low] * (1 - weight) + arr[high] * weight;
}

function summarizeTimings(values = [], extra = {}) {
  const arr = Array.isArray(values)
    ? values.map((value) => toNumber(value, NaN)).filter((value) => Number.isFinite(value) && value >= 0)
    : [];

  return {
    count: arr.length,
    minMs: arr.length ? Math.min(...arr) : 0,
    maxMs: arr.length ? Math.max(...arr) : 0,
    avgMs: arr.length ? arr.reduce((sum, item) => sum + item, 0) / arr.length : 0,
    p90Ms: percentile(arr, 90),
    p95Ms: percentile(arr, 95),
    p99Ms: percentile(arr, 99),
    ...extra,
  };
}

function evaluateThresholds(summary = {}, thresholds = {}) {
  const checks = [];

  if (Number.isFinite(Number(thresholds.maxP95Ms))) {
    checks.push({
      key: 'p95Ms',
      passed: Number(summary.p95Ms || 0) <= Number(thresholds.maxP95Ms),
      expected: `<= ${Number(thresholds.maxP95Ms)} ms`,
      actual: `${Number(summary.p95Ms || 0).toFixed(2)} ms`,
    });
  }

  if (Number.isFinite(Number(thresholds.maxErrorRatePct))) {
    checks.push({
      key: 'errorRatePct',
      passed: Number(summary.errorRatePct || 0) <= Number(thresholds.maxErrorRatePct),
      expected: `<= ${Number(thresholds.maxErrorRatePct)}%`,
      actual: `${Number(summary.errorRatePct || 0).toFixed(2)}%`,
    });
  }

  if (Number.isFinite(Number(thresholds.maxTimeoutCount))) {
    checks.push({
      key: 'timeoutCount',
      passed: Number(summary.timeoutCount || 0) <= Number(thresholds.maxTimeoutCount),
      expected: `<= ${Number(thresholds.maxTimeoutCount)}`,
      actual: String(Number(summary.timeoutCount || 0)),
    });
  }

  if (Number.isFinite(Number(thresholds.maxDurationMs))) {
    checks.push({
      key: 'durationMs',
      passed: Number(summary.durationMs || 0) <= Number(thresholds.maxDurationMs),
      expected: `<= ${Number(thresholds.maxDurationMs)} ms`,
      actual: `${Number(summary.durationMs || 0).toFixed(2)} ms`,
    });
  }

  if (Number.isFinite(Number(thresholds.minUptimePct))) {
    checks.push({
      key: 'uptimePct',
      passed: Number(summary.uptimePct || 0) >= Number(thresholds.minUptimePct),
      expected: `>= ${Number(thresholds.minUptimePct)}%`,
      actual: `${Number(summary.uptimePct || 0).toFixed(4)}%`,
    });
  }

  return {
    passed: checks.every((item) => item.passed),
    checks,
  };
}

module.exports = {
  percentile,
  summarizeTimings,
  evaluateThresholds,
};
