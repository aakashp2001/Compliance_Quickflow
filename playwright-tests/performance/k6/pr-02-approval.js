import http from 'k6/http';
import { check } from 'k6';

const vus = Number(__ENV.PR_VUS || 50);
const duration = String(__ENV.PR_DURATION || '2m');
const baseUrl = String(__ENV.PR_BASE_URL || '').replace(/\/$/, '');
const endpoint = String(__ENV.PR_APPROVE_ENDPOINT || '').trim();
const timeoutMs = Number(__ENV.PR_TIMEOUT_MS || 30000);
const authHeader = String(__ENV.PR_AUTH_HEADER || '').trim();
const cookieHeader = String(__ENV.PR_COOKIE_HEADER || '').trim();
const bodyRaw = String(__ENV.PR_APPROVE_BODY || '{}').trim();
const sessionsJson = String(__ENV.PR_SESSIONS_JSON || '').trim();

let sessions = [];
try {
  sessions = sessionsJson ? JSON.parse(sessionsJson) : [];
} catch (e) {
  // ignore
}

export const options = {
  vus,
  duration,
  thresholds: {
    http_req_failed: ['rate<=0'],
    http_req_duration: ['p(95)<=5000'],
  },
};

function buildUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalized}`;
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
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

export default function () {
  if (!endpoint) {
    check(false, { 'approve endpoint configured': () => false });
    return;
  }

  const res = http.post(buildUrl(endpoint), bodyRaw, {
    headers: buildHeaders(),
    timeout: `${timeoutMs}ms`,
  });

  check(res, {
    'status is below 500': (r) => r.status < 500,
  });
}
