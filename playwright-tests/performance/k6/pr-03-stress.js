import http from 'k6/http';
import { check } from 'k6';

const vus = Number(__ENV.PR_VUS || 100);
const duration = String(__ENV.PR_DURATION || '30m');
const baseUrl = String(__ENV.PR_BASE_URL || '').replace(/\/$/, '');
const timeoutMs = Number(__ENV.PR_TIMEOUT_MS || 30000);
const authHeader = String(__ENV.PR_AUTH_HEADER || '').trim();
const cookieHeader = String(__ENV.PR_COOKIE_HEADER || '').trim();
const sessionsJson = String(__ENV.PR_SESSIONS_JSON || '').trim();

let sessions = [];
try {
  sessions = sessionsJson ? JSON.parse(sessionsJson) : [];
} catch (e) {
  // ignore
}

const mixedEndpoints = JSON.parse(__ENV.PR_MIXED_ENDPOINTS_JSON || '[]');

export const options = {
  vus,
  duration,
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

function buildUrl(endpoint) {
  if (!endpoint) return '';
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const normalized = String(endpoint).startsWith('/') ? String(endpoint) : `/${String(endpoint)}`;
  return `${baseUrl}${normalized}`;
}

function buildHeaders() {
  const headers = {
    Accept: 'application/json, text/plain, */*',
  };
  if (authHeader) headers.Authorization = authHeader;

  let currentCookie = cookieHeader;
  if (Array.isArray(sessions) && sessions.length > 0) {
    const session = sessions[(__VU - 1) % sessions.length];
    if (session && session.cookie) {
      currentCookie = session.cookie;
    }
  }
  if (currentCookie) headers.Cookie = currentCookie;

  return headers;
}

function pickScenario() {
  if (!Array.isArray(mixedEndpoints) || mixedEndpoints.length === 0) return null;

  const weights = mixedEndpoints.map((item) => Number(item?.weight || 1));
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (totalWeight <= 0) return mixedEndpoints[0];

  let random = Math.random() * totalWeight;
  for (let i = 0; i < mixedEndpoints.length; i += 1) {
    random -= Math.max(0, Number(mixedEndpoints[i]?.weight || 1));
    if (random <= 0) return mixedEndpoints[i];
  }
  return mixedEndpoints[mixedEndpoints.length - 1];
}

export default function () {
  const scenario = pickScenario();
  if (!scenario || !scenario.endpoint) {
    check(false, { 'mixed endpoint profile configured': () => false });
    return;
  }

  const method = String(scenario.method || 'GET').toUpperCase();
  const url = buildUrl(scenario.endpoint);
  const headers = buildHeaders();

  let response;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    response = http.post(url, JSON.stringify(scenario.body || {}), { headers, timeout: `${timeoutMs}ms` });
  } else {
    response = http.get(url, { headers, timeout: `${timeoutMs}ms` });
  }

  check(response, {
    'status is below 500': (r) => r.status < 500,
  });
}
