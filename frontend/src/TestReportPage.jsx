import { useEffect, useState } from 'react';
import { getTestReports, getRecordings } from './api/client';

function cleanErrorPrefix(value) {
  return String(value || '')
    .replace(/^Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

function isLogLikeReason(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return /^\[[^\]]+\]\s*/.test(text);
}

function simplifyReason(reason, report) {
  const raw = String(reason || '').trim();
  if (!raw) return isTemplateWorkflowReport(report) ? 'Template workflow result is available in the step details.' : '-';

  const text = raw.toLowerCase();

  if (text.includes('rows.filter is not a function')) {
    return 'Audit data format was not valid. Please run this test again.';
  }
  if (text.includes('timeout')) {
    return 'The page took too long to respond.';
  }
  if (text.includes('target page, context or browser has been closed')) {
    return 'The test browser closed unexpectedly during execution.';
  }
  if (text.includes('this field is required')) {
    return 'Some required fields were empty, so the form could not be saved.';
  }
  if (text.includes('duplicate values detected')) {
    return 'The record value already exists. Please use a unique value.';
  }
  if (text.includes('audit trail entry not found')) {
    return 'Record was saved, but matching audit entry was not found.';
  }
  if (text.includes('audit trail module could not be opened')) {
    return 'Audit Trail page could not be opened.';
  }
  if (text.includes('create button click did not open form')) {
    return 'Create form did not open after clicking the Create button.';
  }
  if (text.includes('offcanvas closed unexpectedly')) {
    return 'The form closed unexpectedly while entering data.';
  }
  if (text.includes('selected master audit report not found')) {
    return 'Audit report for this master was not found.';
  }

  const plain = cleanErrorPrefix(raw)
    .replace(/\s+at\s+.+$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const displayPlain = isTemplateWorkflowReport(report) ? plain.replace(/-/g, ' ') : plain;
  if (!displayPlain) return isTemplateWorkflowReport(report) ? 'Template workflow result is available in the step details.' : '-';
  if (displayPlain.length > 160) return `${displayPlain.slice(0, 157)}...`;

  return displayPlain;
}

function isTemplateWorkflowReport(report) {
  const op = String(report?.operation || '').toLowerCase().trim();
  const master = String(report?.masterName || '').toLowerCase().trim();
  return op === 'template-workflow-e2e' || master === 'template workflow';
}

function emptyText(report, label = 'Not available') {
  return isTemplateWorkflowReport(report) ? label : '-';
}

function extractReasonFromTextBlock(sourceText) {
  const text = String(sourceText || '').trim();
  if (!text) return '';

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const operationFailedLine = lines.find((line) => /operation failed for\s+/i.test(line));
  if (operationFailedLine) {
    const afterColon = operationFailedLine.split(/:\s*/).slice(1).join(': ').trim();
    if (afterColon) return cleanErrorPrefix(afterColon);
  }

  const auditFailedLine = lines.find((line) => /audit verification failed/i.test(line));
  if (auditFailedLine) {
    const afterColon = auditFailedLine.split(/:\s*/).slice(1).join(': ').trim();
    if (afterColon) return cleanErrorPrefix(afterColon);
  }

  const reasonLine = lines.find((line) => /^reason\s*:/i.test(line));
  if (reasonLine) return cleanErrorPrefix(reasonLine.replace(/^reason\s*:\s*/i, ''));

  const firstMeaningful = lines.find((line) => !/^\[[^\]]+\]\s*/.test(line) && !/^at\s+/i.test(line));
  return cleanErrorPrefix(firstMeaningful || lines[0] || '');
}

function getDisplayReason(report) {
  const directReason = cleanErrorPrefix(report?.reason || '');
  if (directReason && !isLogLikeReason(directReason)) return simplifyReason(directReason, report);

  const fromError = extractReasonFromTextBlock(report?.error || '');
  if (fromError && !isLogLikeReason(fromError)) return simplifyReason(fromError, report);

  const fromLogs = extractReasonFromTextBlock(report?.logs || '');
  if (fromLogs && !isLogLikeReason(fromLogs)) return simplifyReason(fromLogs, report);

  if (directReason) return simplifyReason(directReason, report);
  return isTemplateWorkflowReport(report)
    ? 'Template workflow result is available in the step details.'
    : '-';
}

function getLogBullets(report) {
  if (isTemplateWorkflowReport(report)) {
    const status = String(report?.status || '').toLowerCase();
    return [
      status === 'passed'
        ? 'Template workflow completed successfully.'
        : 'Template workflow did not complete successfully.',
      'The test creates a site, app, main template, child sub template, workflow assignment, app switch, and audit check.',
      'Screenshots and recordings are shown in their own columns when they are available.',
    ];
  }

  const source = String(report?.logs || report?.error || '').trim();
  if (!source) return [];

  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 180)
    .map((line) => cleanErrorPrefix(line));
}

function formatOperation(value) {
  const text = String(value || '').trim();
  if (!text) return 'Not available';
  return text
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

function getTestCaseBullets(report, reasonText) {
  const op = String(report?.operation || '').toLowerCase().trim();
  const masterLabel = report?.masterName ? `the ${report.masterName} master` : 'the selected master';
  const bullets = [];

  if (isTemplateWorkflowReport(report)) {
    bullets.push('1. Login to QuickFlow');
    bullets.push('2. Create a site');
    bullets.push('3. Create an app under that site');
    bullets.push('4. Create a main template and select Template Type as Main');
    bullets.push('5. Create a sub template and select Template Type as Child');
    bullets.push('6. Assign a workflow only after the sub template is created');
  } else if (op === 'create') {
    bullets.push('1. Add a new record');
    bullets.push('2. Fill all fields');
    bullets.push('3. Click Save');
  } else if (op === 'update') {
    bullets.push('1. Open a record');
    bullets.push('2. Edit one field');
    bullets.push('3. Click Save');
  } else if (op === 'delete') {
    bullets.push('1. Select a record');
    bullets.push('2. Click Delete');
    bullets.push('3. Confirm');
  } else if (op === 'duplicate-check') {
    bullets.push('1. Try saving duplicate values');
    bullets.push('2. Check for warning');
  } else if (op === 'mandatory-fields' || op === 'mandatory-check') {
    bullets.push('1. Leave required fields blank');
    bullets.push('2. Try to save');
    bullets.push('3. Check error appears');
  } else if (op === 'compare-field') {
    bullets.push('1. Read dropdown options from source form');
    bullets.push('2. Read records from target master');
    bullets.push('3. Compare both data sets');
  } else if (op === 'audit-verified') {
    bullets.push(`1. Open Audit Trail for ${masterLabel}`);
    bullets.push('2. Match record details with executed operation');
    bullets.push('3. Verify audit evidence is present');
  } else {
    bullets.push(`Test: ${formatOperation(report?.operation).toLowerCase()}`);
  }

  if (reasonText && reasonText !== '-') {
    const shortReason = reasonText.length > 100 ? `${reasonText.slice(0, 97)}...` : reasonText;
    bullets.push(`Expected Result: ${shortReason}`);
  }

  return bullets;
}

function findMatchingRecording(report, recordings) {
  if (!recordings || recordings.length === 0) return null;
  const normalize = (value) => String(value || '').trim().toLowerCase();
  const masterLower = normalize(report.masterName);
  const opLower = normalize(report.operation);
  const verifiedOpLower = normalize(report.verifiedOperation);
  const sourceMasterLower = normalize(report.sourceMaster || report.masterName);
  const targetMasterLower = normalize(report.targetMaster);
  const fieldLower = normalize(report.fieldName);
  const reportTime = report.createdAt ? new Date(report.createdAt).getTime() : 0;

  const candidates = recordings.filter((rec) => {
    const recMaster = normalize(rec.masterName);
    const recOp = normalize(rec.operation);
    const recKind = normalize(rec.kind);
    const recSourceMaster = normalize(rec.sourceMaster || rec.masterName);
    const recTargetMaster = normalize(rec.targetMaster);
    const recField = normalize(rec.fieldName);

    if (recMaster === masterLower && recOp === opLower) return true;

    if (opLower === 'mandatory-check') {
      return recKind === 'mandatory' && recMaster === masterLower;
    }

    if (opLower === 'compare-field') {
      return recKind === 'compare-field'
        && recSourceMaster === sourceMasterLower
        && (!targetMasterLower || recTargetMaster === targetMasterLower)
        && (!fieldLower || recField === fieldLower);
    }

    if (['create', 'update', 'delete', 'duplicate-check'].includes(opLower)) {
      return recKind === 'crud'
        && recMaster === masterLower
        && (recOp === opLower || recOp === 'all');
    }

    if (opLower === 'audit-mismatch') {
      return recKind === 'crud' && recMaster === masterLower;
    }

    if (opLower === 'audit-verified') {
      return recKind === 'crud'
        && recMaster === masterLower
        && (
          !verifiedOpLower
          || recOp === verifiedOpLower
          || recOp === 'all'
          || recOp === 'duplicate-check'
        );
    }

    if (opLower === 'template-workflow-e2e' || masterLower === 'template workflow') {
      return recKind === 'template-workflow';
    }

    return false;
  });

  if (!candidates.length) return null;

  // Return the recording whose createdAt is closest to the report time
  return candidates.reduce((best, rec) => {
    const recTime = rec.createdAt ? new Date(rec.createdAt).getTime() : 0;
    const bestTime = best.createdAt ? new Date(best.createdAt).getTime() : 0;
    return Math.abs(recTime - reportTime) < Math.abs(bestTime - reportTime) ? rec : best;
  });
}

/** Generate and download a full HTML report for a single row */
function downloadReport(report, matchedRec) {
  const isDevEnv = Boolean(import.meta?.env?.DEV);
  const fallbackText = emptyText(report);
  const ts = report.createdAt ? new Date(report.createdAt).toLocaleString() : fallbackText;
  const statusColor = report.status === 'passed' ? '#22c55e' : report.status === 'audit-mismatch' ? '#f59e0b' : '#ef4444';
  const statusLabel = report.status === 'passed' ? '✓ PASSED' : report.status === 'audit-mismatch' ? '⚠ AUDIT MISMATCH' : '✗ FAILED';
  const reason = getDisplayReason(report);
  const testCases = getTestCaseBullets(report, reason);
  const logs = String(report.logs || report.error || '').trim();
  const logLines = logs.split(/\r?\n/).filter(Boolean);
  const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const urlRegex = /(https?:\/\/[^\s"'<>)\]]+)/gi;
  const linkify = (value) => escapeHtml(value).replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
  const toMultilineHtml = (value) => linkify(value).replace(/\r?\n/g, '<br/>');
  const extractUrls = (obj) => {
    const found = new Set();
    const walk = (val) => {
      if (typeof val === 'string') {
        const matches = val.match(urlRegex) || [];
        matches.forEach((url) => found.add(url));
        return;
      }
      if (Array.isArray(val)) {
        val.forEach(walk);
        return;
      }
      if (val && typeof val === 'object') {
        Object.values(val).forEach(walk);
      }
    };
    walk(obj);
    return Array.from(found);
  };
  const normalizeForRawJson = (obj) => {
    if (typeof obj === 'string') {
      return obj.includes('\n') ? obj.split(/\r?\n/) : obj;
    }
    if (Array.isArray(obj)) return obj.map(normalizeForRawJson);
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalizeForRawJson(v)]));
    }
    return obj;
  };
  const rawJson = JSON.stringify(normalizeForRawJson(report), null, 2);
  const discoveredLinks = [
    ...extractUrls(report),
    report.screenshotUrl,
    matchedRec?.url,
  ].filter(Boolean);
  const classifyLinkLabel = (url, idx) => {
    const text = String(url || '').toLowerCase();
    if (/\/test-report-artifacts\/.+\.(webm|mp4)(\?|$)/.test(text)) return 'Recording Video';
    if (/\/test-report-artifacts\/.+\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(text)) return 'Screenshot Image';
    if (/template-workflow/i.test(text)) return 'Template Workflow Page';
    if (/localhost|127\.0\.0\.1/.test(text)) return 'Local Server Link';
    return `Reference Link ${idx + 1}`;
  };

  const row = (label, value, isCode = false) => `
    <tr>
      <td style="width:160px;font-weight:600;color:#64748b;padding:10px 14px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;${isCode ? 'font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word' : ''}">${value || fallbackText}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Test Report — ${report.masterName || 'Report'} — ${ts}</title>
  <style>
    :root[data-theme="dark"] {
      --bg: #0b1220;
      --panel: #111a2e;
      --line: #26344f;
      --text: #dbe7ff;
      --muted: #9fb2d1;
      --title: #f8fbff;
      --link: #7cc6ff;
      --badge-text: #ffffff;
      --shadow: rgba(0, 0, 0, 0.35);
    }
    :root[data-theme="light"] {
      --bg: #f3f6fb;
      --panel: #ffffff;
      --line: #d7e0ee;
      --text: #0f1b2d;
      --muted: #5d708f;
      --title: #0b1a2f;
      --link: #0b63d9;
      --badge-text: #ffffff;
      --shadow: rgba(15, 23, 42, 0.12);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, "Segoe UI", Roboto, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.45;
    }
    .report-shell {
      width: 90%;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 12px 28px var(--shadow);
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    h1 { font-size: 34px; font-weight: 900; color: var(--title); margin-bottom: 6px; letter-spacing: 0.01em; line-height: 1.15; }
    .subtitle { color: var(--muted); font-size: 13px; }
    .env-note {
      margin-top: 8px;
      color: #ffd281;
      font-size: 12px;
      background: rgba(245, 158, 11, 0.16);
      border: 1px solid rgba(245, 158, 11, 0.45);
      padding: 8px 10px;
      border-radius: 8px;
      max-width: 700px;
    }
    .hero-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .theme-toggle {
      border: 1px solid var(--line);
      background: transparent;
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
      border-radius: 999px;
      padding: 7px 12px;
      cursor: pointer;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 13px;
      background: ${statusColor};
      color: var(--badge-text);
      white-space: nowrap;
      margin-top: 2px;
      box-shadow: none;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
    }
    .card-title {
      padding: 11px 14px;
      font-weight: 800;
      font-size: 12px;
      color: #9ecfff;
      border-bottom: 1px solid var(--line);
      letter-spacing: 0.07em;
      text-transform: uppercase;
      background: transparent;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td {
      padding: 9px 12px;
      border-bottom: 1px solid rgba(38, 52, 79, 0.7);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    td:first-child {
      width: 190px;
      color: var(--muted);
      font-weight: 700;
      white-space: nowrap;
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    details summary { list-style: none; cursor: pointer; }
    details summary::-webkit-details-marker { display: none; }
    .logs-box {
      background: transparent;
      margin: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 480px;
      overflow-y: auto;
      color: #c1d3ee;
      line-height: 1.6;
    }
    :root[data-theme="light"] .logs-box { color: #2c3f5d; }
    :root[data-theme="light"] .card-title { color: #2459a8; }
    @media (max-width: 1200px) {
      .report-shell { width: 92%; }
    }
    @media (max-width: 860px) {
      .report-shell { width: 98%; padding: 14px; }
      .hero { flex-direction: column; }
      .hero-right { width: 100%; justify-content: space-between; }
    }
    .footer {
      margin-top: 14px;
      font-size: 11px;
      color: #6f84a7;
      text-align: center;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
  </style>
</head>
<body>
  <div class="report-shell">
  <div class="hero">
    <div>
      <h1>Automation Test Execution Report</h1>
      <p class="subtitle">Generated on ${new Date().toLocaleString()}</p>
      ${isDevEnv ? '<p class="env-note">Note: Media links in this report currently point to the local development server. After deployment, these links will resolve from the hosted server environment.</p>' : ''}
    </div>
    <div class="hero-right">
      <button type="button" class="theme-toggle" id="themeToggle">Switch to Light</button>
      <div class="badge">${statusLabel}</div>
    </div>
  </div>

  <div class="grid">
  <div class="card">
    <div class="card-title">📋 Test Details</div>
    <table>
      ${row('Master / Module', report.masterName)}
      ${row('Operation', formatOperation(report.operation))}
      ${row('Status', statusLabel)}
      ${row('Executed At', ts)}
      ${row('Report ID', report.id)}
    </table>
  </div>

  <div class="card">
    <div class="card-title">Test Cases</div>
    <table>
      ${testCases.map((line, index) => row(`Step ${index + 1}`, line)).join('')}
    </table>
  </div>

  <div class="card">
    <div class="card-title">📝 Result</div>
    <table>
      ${row('Reason', reason)}
      ${row('Screenshot', report.screenshotUrl ? `<a href="${report.screenshotUrl}" target="_blank">${report.screenshotUrl}</a>` : emptyText(report, 'No screenshot saved'))}
      ${row('Recording', matchedRec ? `<a href="${matchedRec.url}" target="_blank">${matchedRec.url}</a>` : emptyText(report, 'No recording found'))}
    </table>
  </div>

  ${discoveredLinks.length ? `
  <div class="card">
    <div class="card-title">🔗 Links</div>
    <table>
      ${discoveredLinks.map((url, index) => row(classifyLinkLabel(url, index), `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)).join('')}
    </table>
  </div>` : ''}

  ${logLines.length ? `
  <div class="card">
    <details>
      <summary class="card-title">🪵 Full Logs (${logLines.length} lines)</summary>
      <div class="logs-box">${escapeHtml(logLines.join('\n'))}</div>
    </details>
  </div>` : ''}

  <div class="card">
    <details>
      <summary class="card-title">🔍 Raw Data (JSON)</summary>
      <div class="logs-box">${escapeHtml(rawJson)}</div>
    </details>
  </div>

  </div>
  <p class="footer">QuickFlow Automation • Auto-generated report</p>
  </div>
  <script>
    (function () {
      const root = document.documentElement;
      const storageKey = 'quickflow-report-theme';
      const toggleBtn = document.getElementById('themeToggle');
      const saved = localStorage.getItem(storageKey);
      const initial = saved === 'light' || saved === 'dark' ? saved : 'dark';
      root.setAttribute('data-theme', initial);
      function syncLabel() {
        if (!toggleBtn) return;
        const current = root.getAttribute('data-theme') || 'dark';
        toggleBtn.textContent = current === 'dark' ? 'Switch to Light' : 'Switch to Dark';
      }
      syncLabel();
      if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
          const current = root.getAttribute('data-theme') || 'dark';
          const next = current === 'dark' ? 'light' : 'dark';
          root.setAttribute('data-theme', next);
          localStorage.setItem(storageKey, next);
          syncLabel();
        });
      }
    })();
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report-${report.masterName || 'test'}-${report.status}-${(report.createdAt || Date.now()).toString().replace(/[^0-9]/g, '').slice(0, 14)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function TestReportPage({ masters = [] }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reports, setReports] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState('');
  const [expandedVideo, setExpandedVideo] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  // Pagination config and state
  const REPORTS_PER_PAGE = 10;
  const RECORDINGS_PER_PAGE = 8;
  const [reportsPage, setReportsPage] = useState(1);
  const [recordingsPage, setRecordingsPage] = useState(1);

  async function loadReports() {
    setLoading(true);
    setError('');
    try {
      const data = await getTestReports();
      const list = Array.isArray(data) ? data : data?.reports || [];
      setReports(list);
    } catch (err) {
      setError(err.message || 'Failed to load test reports');
    } finally {
      setLoading(false);
    }
  }

  async function loadRecordings() {
    setRecLoading(true);
    setRecError('');
    try {
      const data = await getRecordings();
      const list = Array.isArray(data) ? data : data?.recordings || [];
      setRecordings(list);
    } catch (err) {
      setRecError(err?.message || 'Failed to load recordings');
    } finally {
      setRecLoading(false);
    }
  }

  useEffect(() => {
    loadReports();
    loadRecordings();
    document.body.classList.add('page-test-report');
    return () => document.body.classList.remove('page-test-report');
  }, []);

  const complianceCount = reports.filter((r) => String(r.operation || '').toLowerCase().includes('compliance')).length;

  const filteredReports = reports.filter((report) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'passed') return report.status === 'passed';
    if (statusFilter === 'failed') return report.status === 'failed';
    if (statusFilter === 'audit-mismatch') return report.status === 'audit-mismatch';
    if (statusFilter === 'compliance') return String(report.operation || '').toLowerCase().includes('compliance');
    return true;
  });

  // Reports pagination
  const totalReportPages = Math.max(1, Math.ceil(filteredReports.length / REPORTS_PER_PAGE));
  const currentReportsPage = Math.min(Math.max(1, reportsPage), totalReportPages);
  const paginatedReports = filteredReports.slice((currentReportsPage - 1) * REPORTS_PER_PAGE, currentReportsPage * REPORTS_PER_PAGE);

  useEffect(() => {
    setReportsPage(1);
  }, [statusFilter]);

  useEffect(() => {
    if (reportsPage > totalReportPages) setReportsPage(totalReportPages);
    if (reportsPage < 1 && totalReportPages > 0) setReportsPage(1);
  }, [reportsPage, totalReportPages]);

  const passedCount = reports.filter((r) => r.status === 'passed').length;
  const failedCount = reports.filter((r) => r.status === 'failed').length;
  const auditMismatchCount = reports.filter((r) => r.status === 'audit-mismatch').length;

  // Recordings pagination
  const totalRecordingsPages = Math.max(1, Math.ceil(recordings.length / RECORDINGS_PER_PAGE));
  const currentRecordingsPage = Math.min(Math.max(1, recordingsPage), totalRecordingsPages);
  const paginatedRecordings = recordings.slice((currentRecordingsPage - 1) * RECORDINGS_PER_PAGE, currentRecordingsPage * RECORDINGS_PER_PAGE);
  useEffect(() => {
    if (recordingsPage > totalRecordingsPages) setRecordingsPage(totalRecordingsPages);
    if (recordingsPage < 1 && totalRecordingsPages > 0) setRecordingsPage(1);
  }, [recordingsPage, totalRecordingsPages]);

  return (
    <section className="grid test-report-page-grid">
      {/* ── Test Reports Table ── */}
      <article className="card card-wide">
        <h2>Test Report</h2>
        <div className="row card-toolbar">
          <div>
            <p className="muted">Test execution results with pass/fail status.</p>
            {reports.length > 0 && (
              <div className="report-stat-row">
                <span className="report-stat report-stat--pass">Passed: {passedCount}</span>
                <span className="report-stat report-stat--fail">Failed: {failedCount}</span>
                <span className="report-stat report-stat--audit">Audit issues: {auditMismatchCount}</span>
              </div>
            )}
          </div>
          <button type="button" className="btn-sm" onClick={loadReports} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {reports.length > 0 && (
          <div className="filter-chip-row">
            <button
              type="button"
              className={`filter-chip ${statusFilter === 'all' ? 'filter-chip--active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All ({reports.length})
            </button>
            <button
              type="button"
              className={`filter-chip filter-chip--pass ${statusFilter === 'passed' ? 'filter-chip--active' : ''}`}
              onClick={() => setStatusFilter('passed')}
            >
              Passed ({passedCount})
            </button>
            <button
              type="button"
              className={`filter-chip filter-chip--fail ${statusFilter === 'failed' ? 'filter-chip--active' : ''}`}
              onClick={() => setStatusFilter('failed')}
            >
              Failed ({failedCount})
            </button>
            <button
              type="button"
              className={`filter-chip filter-chip--audit ${statusFilter === 'audit-mismatch' ? 'filter-chip--active' : ''}`}
              onClick={() => setStatusFilter('audit-mismatch')}
              
            >
              Audit Issues ({auditMismatchCount})
            </button>
            <button
              type="button"
              className={`filter-chip filter-chip--compliance ${statusFilter === 'compliance' ? 'filter-chip--active' : ''}`}
              onClick={() => setStatusFilter('compliance')}
            >
              Compliance ({complianceCount})
            </button>
          </div>
        )}

        {error && <p className="status-error">{error}</p>}

        {!loading && reports.length === 0 && !error && (
          <p className="muted">No test reports found yet.</p>
        )}

        {!!filteredReports.length && (
          <>
            <div className="test-report-table-wrap">
              <table className="test-report-table">
                <thead>
                  <tr>
                    <th className="test-report-col-status">Status</th>
                    <th className="test-report-col-time">Time</th>
                    <th className="test-report-col-master">Master</th>
                    <th className="test-report-col-operation">Operation</th>
                    <th className="test-report-testcases-col">Test Cases</th>
                    <th className="test-report-reason-col">Reason</th>
                    <th className="test-report-logs-col">Logs</th>
                    <th className="test-report-col-url">Screenshot</th>
                    <th className="test-report-col-url">Recording URL</th>
                    {/* <th className="test-report-col-download">Download</th> */}
                    <th style={{ whiteSpace: 'nowrap' }}>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedReports.map((report) => {
                    const reasonText = getDisplayReason(report);
                    const logBullets = getLogBullets(report);
                    const testCaseBullets = getTestCaseBullets(report, reasonText);
                    const matchedRec = findMatchingRecording(report, recordings);
                    const statusBadgeStyle = report.status === 'passed'
                      ? { backgroundColor: '#22c55e', color: '#fff', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: '500' }
                      : report.status === 'audit-mismatch'
                        ? { backgroundColor: '#f59e0b', color: '#fff', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: '500' }
                        : { backgroundColor: '#ef4444', color: '#fff', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: '500' };
                    const statusText = report.status === 'passed' ? 'Pass' : report.status === 'audit-mismatch' ? 'Audit' : 'Fail';
                    return (
                      <tr key={report.id}>
                        <td><span style={statusBadgeStyle}>{statusText}</span></td>
                        <td>{report.createdAt ? new Date(report.createdAt).toLocaleString() : emptyText(report)}</td>
                        <td>{report.masterName || emptyText(report)}</td>
                        <td>{formatOperation(report.operation)}</td>
                        <td className="test-report-testcases-cell">
                          <details className="test-report-logs" open={false}>
                            <summary>View steps ({testCaseBullets.length})</summary>
                            <div className="test-report-case-lines">
                              {testCaseBullets.map((line, idx) => (
                                <div key={`${report.id}-case-${idx}`}>{line}</div>
                              ))}
                            </div>
                          </details>
                        </td>
                        <td className="test-report-reason-cell">{reasonText}</td>
                        <td className="test-report-logs-cell">
                          {logBullets.length > 0 ? (
                            <details className="test-report-logs" open={false}>
                              <summary>View logs ({logBullets.length})</summary>
                              <ul className="test-report-log-list">
                                {logBullets.map((line, idx) => (
                                  <li key={`${report.id}-log-${idx}`}>{line}</li>
                                ))}
                              </ul>
                            </details>
                          ) : (
                            emptyText(report, 'No log details')
                          )}
                        </td>
                        <td className="test-report-url-cell">
                          {report.screenshotUrl ? (
                            <a href={report.screenshotUrl} target="_blank" rel="noreferrer" className="test-report-link">
                              Open Screenshot
                            </a>
                          ) : emptyText(report, 'No screenshot saved')}
                        </td>
                        <td className="test-report-url-cell">
                          {recLoading ? (
                            <span className="muted">Loading...</span>
                          ) : matchedRec ? (
                            <a href={matchedRec.url} target="_blank" rel="noreferrer" className="test-report-link">
                              Open Recording URL
                            </a>
                          ) : (
                            <span className="muted">{emptyText(report, 'No recording found')}</span>
                          )}
                        </td>
                        {/* ── Download column ── */}
                        <td className="test-report-download-cell">
                          <button
                            type="button"
                            className="btn-download-report"
                            title="Download full report as HTML"
                            onClick={() => downloadReport(report, matchedRec)}
                          >
                            Download
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div className="muted">
                Showing {Math.min((currentReportsPage - 1) * REPORTS_PER_PAGE + 1, filteredReports.length)} - {Math.min(currentReportsPage * REPORTS_PER_PAGE, filteredReports.length)} of {filteredReports.length}
              </div>
              <div>
                <button type="button" className="btn-sm" onClick={() => setReportsPage(1)} disabled={currentReportsPage === 1}>First</button>
                <button type="button" className="btn-sm" onClick={() => setReportsPage(currentReportsPage - 1)} disabled={currentReportsPage === 1}>Prev</button>
                <span className="muted" style={{ margin: '0 8px' }}>Page {currentReportsPage} / {totalReportPages}</span>
                <button type="button" className="btn-sm" onClick={() => setReportsPage(currentReportsPage + 1)} disabled={currentReportsPage === totalReportPages}>Next</button>
                <button type="button" className="btn-sm" onClick={() => setReportsPage(totalReportPages)} disabled={currentReportsPage === totalReportPages}>Last</button>
              </div>
            </div>
          </>
        )}
      </article>

      {/* ── Recordings / Videos Section ── */}
      <article className="card card-wide">
        <div className="row card-toolbar card-toolbar--tight">
          <h2 className="card-heading-inline">Test Recordings</h2>
          <button type="button" className="btn-sm" onClick={loadRecordings} disabled={recLoading}>
            {recLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <p className="muted">Videos captured automatically during test runs.</p>

        {recError && <p className="status-error">{recError}</p>}

        {!recLoading && recordings.length === 0 && !recError && (
          <p className="muted">No recordings found yet. Run any test and refresh.</p>
        )}

        {recordings.length > 0 && (
          <>
            <div className="tr-recordings-grid">
              {paginatedRecordings.map((item, idx) => {
                const isExpanded = expandedVideo === (item.id || idx);
                return (
                  <div key={item.id || idx} className="tr-recording-card">
                    <div className="tr-recording-meta">
                      <strong>{item.title || item.name}</strong>
                      {item.masterName && <span>Master: <em>{item.masterName}</em></span>}
                      {item.operation && <span>Operation: <em>{item.operation}</em></span>}
                      {item.kind && item.kind !== 'unknown' && <span>Type: <em>{item.kind}</em></span>}
                      {item.status && <span className={item.status === 'completed' ? 'tr-rec-status-ok' : 'tr-rec-status-fail'}>{item.status}</span>}
                      <span className="muted">{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</span>
                    </div>

                    {isExpanded ? (
                      <>
                        <video
                          className="tr-recording-video"
                          controls
                          autoPlay={false}
                          preload="metadata"
                          src={item.url}
                        />
                        <div className="tr-recording-actions">
                          <button type="button" className="btn-sm" onClick={() => setExpandedVideo(null)}>Collapse</button>
                          <a className="test-report-link" href={item.url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
                        </div>
                      </>
                    ) : (
                      <div className="tr-recording-actions">
                        <button type="button" className="btn-sm" onClick={() => setExpandedVideo(item.id || idx)}>▶ Play Video</button>
                        <a className="test-report-link" href={item.url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div className="muted">
                Showing {Math.min((currentRecordingsPage - 1) * RECORDINGS_PER_PAGE + 1, recordings.length)} - {Math.min(currentRecordingsPage * RECORDINGS_PER_PAGE, recordings.length)} of {recordings.length}
              </div>
              <div>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(1)} disabled={currentRecordingsPage === 1}>First</button>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(currentRecordingsPage - 1)} disabled={currentRecordingsPage === 1}>Prev</button>
                <span className="muted" style={{ margin: '0 8px' }}>Page {currentRecordingsPage} / {totalRecordingsPages}</span>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(currentRecordingsPage + 1)} disabled={currentRecordingsPage === totalRecordingsPages}>Next</button>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(totalRecordingsPages)} disabled={currentRecordingsPage === totalRecordingsPages}>Last</button>
              </div>
            </div>
          </>
        )}
      </article>
    </section>
  );
}

export default TestReportPage;