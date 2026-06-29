'use strict';

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvList(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function baseOrigin(loginUrl) {
  try {
    return new URL(String(loginUrl || 'https://ipdev.quickflow.in/login')).origin;
  } catch {
    return 'https://ipdev.quickflow.in';
  }
}

function buildUrl(baseUrl, endpoint) {
  const endpointText = String(endpoint || '').trim();
  if (!endpointText) return '';
  if (/^https?:\/\//i.test(endpointText)) return endpointText;
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '');
  const normalizedPath = endpointText.startsWith('/') ? endpointText : `/${endpointText}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function timedApiCall(request, {
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = 30000,
}) {
  const started = Date.now();
  const upperMethod = String(method || 'GET').trim().toUpperCase();
  let response = null;
  let timedOut = false;
  let failed = false;
  let errorText = '';

  try {
    const options = {
      headers: headers || {},
      timeout: Math.max(1000, toNumber(timeoutMs, 30000)),
    };

    if (body !== undefined && body !== null && upperMethod !== 'GET') {
      if (typeof body === 'string') {
        options.data = body;
      } else {
        options.data = JSON.stringify(body);
        if (!options.headers['Content-Type'] && !options.headers['content-type']) {
          options.headers['Content-Type'] = 'application/json';
        }
      }
    }

    if (upperMethod === 'GET') response = await request.get(url, options);
    else if (upperMethod === 'POST') response = await request.post(url, options);
    else if (upperMethod === 'PUT') response = await request.put(url, options);
    else if (upperMethod === 'PATCH') response = await request.patch(url, options);
    else if (upperMethod === 'DELETE') response = await request.delete(url, options);
    else response = await request.fetch(url, { method: upperMethod, ...options });
  } catch (error) {
    failed = true;
    errorText = String(error?.message || error || 'request failed');
    timedOut = /timeout|timed out/i.test(errorText);
  }

  const durationMs = Date.now() - started;
  const status = response ? Number(response.status()) : 0;
  const ok = response ? response.ok() : false;

  return {
    method: upperMethod,
    url,
    status,
    ok,
    failed,
    timedOut,
    errorText,
    durationMs,
  };
}

async function runConcurrentCalls(request, {
  baseUrl,
  endpoints = [],
  method = 'GET',
  headers = {},
  body,
  concurrency = 10,
  totalRequests = 100,
  timeoutMs = 30000,
}) {
  const normalizedEndpoints = Array.isArray(endpoints)
    ? endpoints.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (!normalizedEndpoints.length) {
    return {
      responses: [],
      timings: [],
      errorCount: 0,
      timeoutCount: 0,
      statusBuckets: {},
    };
  }

  const responses = [];
  const timings = [];
  const statusBuckets = {};
  let timeoutCount = 0;
  let errorCount = 0;
  let pointer = 0;
  const total = Math.max(1, toNumber(totalRequests, 100));
  const workerCount = Math.max(1, Math.min(toNumber(concurrency, 10), total));

  async function worker() {
    while (pointer < total) {
      const current = pointer;
      pointer += 1;
      const endpoint = normalizedEndpoints[current % normalizedEndpoints.length];
      const url = buildUrl(baseUrl, endpoint);
      const headersObj = Array.isArray(headers) ? headers[current % headers.length] : headers;
      // eslint-disable-next-line no-await-in-loop
      const result = await timedApiCall(request, { method, url, headers: headersObj, body, timeoutMs });
      responses.push(result);
      timings.push(result.durationMs);
      if (result.timedOut) timeoutCount += 1;
      if (result.failed || !result.ok) errorCount += 1;
      const bucketKey = String(result.status || 0);
      statusBuckets[bucketKey] = Number(statusBuckets[bucketKey] || 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    responses,
    timings,
    errorCount,
    timeoutCount,
    statusBuckets,
  };
}

module.exports = {
  baseOrigin,
  parseCsvList,
  buildUrl,
  timedApiCall,
  runConcurrentCalls,
};
