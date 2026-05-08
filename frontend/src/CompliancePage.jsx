import { useState } from 'react';
import { runComplianceTest } from './api/client';

const TC_OPTIONS = [
  { id: '', label: 'Run ALL Compliance Tests' },
  { id: 'TC-DI-01-01', label: 'TC-DI-01-01 — Attributability (Create)' },
  { id: 'TC-DI-01-02', label: 'TC-DI-01-02 — Attributability (Update)' },
  { id: 'TC-DI-02-01', label: 'TC-DI-02-01 — Legibility (Unicode / Special Chars)' },
  { id: 'TC-DI-02-02', label: 'TC-DI-02-02 — Legibility (Long Strings / 255 chars)' },
  { id: 'TC-DI-06-01', label: 'TC-DI-06-01 — Mandatory Field Enforcement' },
  { id: 'TC-DI-07-01', label: 'TC-DI-07-01 — Session Interruption (Durability)' },
  { id: 'TC-DI-08-01', label: 'TC-DI-08-01 — Soft Delete Data Preservation' },
  { id: 'TC-DI-09-01', label: 'TC-DI-09-01 — Concurrent Edit Conflict Detection' },
];

function StatusBadge({ status }) {
  const style = {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: '12px',
    fontWeight: 600,
    fontSize: '0.78rem',
    letterSpacing: '0.04em',
    background: status === 'passed' ? '#166534' : status === 'failed' ? '#991b1b' : '#374151',
    color: status === 'passed' ? '#bbf7d0' : status === 'failed' ? '#fecaca' : '#d1d5db',
  };
  return <span style={style}>{status?.toUpperCase() || 'UNKNOWN'}</span>;
}

function DetailRow({ step, passed, expected, actual, reason }) {
  return (
    <tr style={{ borderBottom: '1px solid #1f2937' }}>
      <td style={{ padding: '6px 12px' }}>{step}</td>
      <td style={{ padding: '6px 12px', textAlign: 'center' }}>
        <StatusBadge status={passed ? 'passed' : 'failed'} />
      </td>
      {expected !== undefined && <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: '0.8rem', color: '#9ca3af' }}>{expected}</td>}
      {actual !== undefined && <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: '0.8rem', color: '#9ca3af' }}>{actual}</td>}
      {reason && <td colSpan={2} style={{ padding: '6px 12px', color: '#f87171', fontSize: '0.82rem' }}>{reason}</td>}
    </tr>
  );
}

function buildComplianceLogLines(result, sharedDebug = '') {
  const lines = [];
  const logs = String(result?.logs || '').trim();
  const debug = String(result?._debug || sharedDebug || '').trim();
  const error = String(result?.error || '').trim();
  const detailJson = result?.details ? JSON.stringify(result.details, null, 2) : '';

  if (logs) lines.push(logs);
  if (debug) lines.push(debug);
  if (error) lines.push(error);
  if (detailJson) lines.push(detailJson);

  const merged = lines.join('\n\n').trim();
  if (!merged) return [];
  return merged
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function TcResultCard({ result, sharedDebug = '' }) {
  const [expanded, setExpanded] = useState(false);
  if (!result) return null;
  const { tcId, title, status, details } = result;
  const logLines = buildComplianceLogLines(result, sharedDebug);
  const cardStyle = {
    background: '#111827',
    border: `1px solid ${status === 'passed' ? '#166534' : '#7f1d1d'}`,
    borderRadius: '10px',
    marginBottom: '14px',
    overflow: 'hidden',
  };
  return (
    <div style={cardStyle}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <StatusBadge status={status} />
          <span style={{ fontWeight: 600, color: '#f3f4f6' }}>{tcId}</span>
          <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>{title}</span>
        </div>
        <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>{expanded ? '▲ Hide' : '▼ Details'}</span>
      </div>
      {expanded && Array.isArray(details) && details.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem', color: '#e5e7eb' }}>
            <thead>
              <tr style={{ background: '#1f2937', color: '#9ca3af', fontSize: '0.78rem' }}>
                <th style={{ padding: '6px 12px', textAlign: 'left' }}>Step</th>
                <th style={{ padding: '6px 12px', textAlign: 'center' }}>Result</th>
                <th style={{ padding: '6px 12px', textAlign: 'left' }}>Info</th>
              </tr>
            </thead>
            <tbody>
              {details.map((d, i) => <DetailRow key={i} {...d} />)}
            </tbody>
          </table>
        </div>
      )}
      {expanded && logLines.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '10px 14px 14px' }}>
          <details>
            <summary style={{ cursor: 'pointer', color: '#93c5fd', fontSize: '0.82rem' }}>
              View Logs ({logLines.length})
            </summary>
            <pre
              style={{
                marginTop: '10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#d1d5db',
                background: '#0b1220',
                border: '1px solid #1f2937',
                borderRadius: '8px',
                padding: '10px',
                fontSize: '0.78rem',
                maxHeight: '280px',
                overflow: 'auto',
              }}
            >
              {logLines.join('\n')}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export default function CompliancePage({ masters = [] }) {
  const [config, setConfig] = useState({
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'aakash',
    password: 'qwer1234',
    username2: '',
    password2: '',
    masterName: 'Country',
    tcId: '',
    showBrowser: true,
  });

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  function handleChange(field) {
    return (e) => {
      const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setConfig((prev) => ({ ...prev, [field]: value }));
    };
  }

  async function handleRun() {
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const data = await runComplianceTest({
        loginUrl: config.loginUrl,
        username: config.username,
        password: config.password,
        username2: config.username2 || undefined,
        password2: config.password2 || undefined,
        masterName: config.masterName,
        tcId: config.tcId,
        showBrowser: config.showBrowser,
      });
      setResult(data);
    } catch (err) {
      setError(err?.message || 'Compliance run failed');
    } finally {
      setRunning(false);
    }
  }

  const masterOptions = masters.map((m) => m.name).sort();
  const allResultsList = result?.mode === 'all' ? (result?.results || []) : (result ? [result] : []);
  const summary = result?.summary;

  return (
    <>
      <section className="grid">
        <article className="card card-wide">
          <h2>Data Integrity Compliance Suite</h2>
          <p style={{ color: '#9ca3af', marginBottom: '18px', fontSize: '0.9rem' }}>
            Trigger automated Data Integrity (DI) compliance verification tests directly from the TestHive UI.
            Each test case maps to a compliance point and outputs a structured pass/fail report.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            {/* Login Config */}
            <div className="form-group">
              <label>Login URL</label>
              <input className="input" value={config.loginUrl} onChange={handleChange('loginUrl')} />
            </div>
            <div className="form-group">
              <label>Master Under Test</label>
              {masterOptions.length > 0 ? (
                <select className="input" value={config.masterName} onChange={handleChange('masterName')}>
                  {masterOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input className="input" value={config.masterName} onChange={handleChange('masterName')} placeholder="e.g. Country" />
              )}
            </div>
            <div className="form-group">
              <label>Username (Primary)</label>
              <input className="input" value={config.username} onChange={handleChange('username')} />
            </div>
            <div className="form-group">
              <label>Password (Primary)</label>
              <input className="input" type="password" value={config.password} onChange={handleChange('password')} />
            </div>
            <div className="form-group">
              <label>Username 2 <span style={{ color: '#6b7280', fontSize: '0.78rem' }}>(for TC-DI-09 concurrent edit)</span></label>
              <input className="input" value={config.username2} onChange={handleChange('username2')} placeholder="Same as primary if blank" />
            </div>
            <div className="form-group">
              <label>Password 2</label>
              <input className="input" type="password" value={config.password2} onChange={handleChange('password2')} placeholder="Same as primary if blank" />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>Test Case to Run</label>
              <select className="input" value={config.tcId} onChange={handleChange('tcId')}>
                {TC_OPTIONS.map((tc) => <option key={tc.id} value={tc.id}>{tc.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginTop: '18px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#d1d5db' }}>
              <input type="checkbox" checked={config.showBrowser} onChange={handleChange('showBrowser')} />
              Show Browser
            </label>
            <button
              className="btn btn-primary"
              onClick={handleRun}
              disabled={running}
              style={{ minWidth: '180px' }}
            >
              {running ? '⏳ Running…' : config.tcId ? `▶ Run ${config.tcId}` : '▶ Run All Compliance Tests'}
            </button>
          </div>
        </article>
      </section>

      {/* Summary Banner */}
      {summary && (
        <section className="grid">
          <article className="card card-wide" style={{ display: 'flex', gap: '28px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f3f4f6' }}>{summary.total}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Total</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#4ade80' }}>{summary.passed}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Passed</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f87171' }}>{summary.failed}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Failed</div></div>
            <div style={{ marginLeft: 'auto' }}><StatusBadge status={summary.failed === 0 ? 'passed' : 'failed'} /></div>
          </article>
        </section>
      )}

      {/* Single TC result (non-all mode) */}
      {result && result.mode === 'single' && (
        <section className="grid">
          <article className="card card-wide">
            <h3 style={{ marginBottom: '14px' }}>Result</h3>
            <TcResultCard result={result} sharedDebug={result?._debug || ''} />
          </article>
        </section>
      )}

      {/* All TC results */}
      {allResultsList.length > 0 && result?.mode === 'all' && (
        <section className="grid">
          <article className="card card-wide">
            <h3 style={{ marginBottom: '14px' }}>Test Results</h3>
            {allResultsList.map((r, i) => <TcResultCard key={i} result={r} sharedDebug={result?._debug || ''} />)}
          </article>
        </section>
      )}

      {/* Error */}
      {error && (
        <section className="grid">
          <article className="card card-wide status-card error">
            <h3>Run Error</h3>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#f87171', fontSize: '0.82rem', margin: 0 }}>{error}</pre>
          </article>
        </section>
      )}
    </>
  );
}
