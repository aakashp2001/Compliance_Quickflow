import { useState, useEffect, useRef } from 'react';
import { startComplianceRun, getComplianceRun, stopComplianceRun, openComplianceRunStream, getMasters } from './api/client';
import MultiSelect from './components/MultiSelect';

const SUITE_OPTIONS = [
  { value: 'DI', label: 'Data Integrity (DI)' },
  { value: 'MD', label: 'Master Data (MD)' },
  { value: 'AT', label: 'Audit Trail (AT)' },
];

const TC_OPTIONS_BY_SUITE = {
  DI: [
    { id: '', label: 'Run ALL Data Integrity Compliance Tests' },
    { id: 'TC-DI-01', label: 'TC-DI-01 - Attributability (Create & Update)' },
    { id: 'TC-DI-02-01', label: 'TC-DI-02-01 - Legibility (Unicode / Special Chars)' },
    { id: 'TC-DI-02-02', label: 'TC-DI-02-02 - Legibility (Long Strings / 255 chars)' },
    { id: 'TC-DI-06-01', label: 'TC-DI-06-01 - Mandatory Field Enforcement' },
    { id: 'TC-DI-07-01', label: 'TC-DI-07-01 - Session Interruption (Durability)' },
    { id: 'TC-DI-08-01', label: 'TC-DI-08-01 - Soft Delete Data Preservation' },
    { id: 'TC-DI-09-01', label: 'TC-DI-09-01 - Concurrent Edit Conflict Detection' },
  ],
  MD: [
    { id: '', label: 'Run ALL Master Data Compliance Tests' },
    { id: 'TC-MD-01-01', label: 'TC-MD-01-01 - Stage Skip Prevention' },
    { id: 'TC-MD-01-02', label: 'TC-MD-01-02 - Lifecycle Positive Sequence' },
    { id: 'TC-MD-02-01', label: 'TC-MD-02-01 - Uniqueness Constraint' },
    { id: 'TC-MD-03-01', label: 'TC-MD-03-01 - Self-Approval Prevention' },
    { id: 'TC-MD-04-01', label: 'TC-MD-04-01 - Approved Edit Creates Draft Version' },
    { id: 'TC-MD-05-01', label: 'TC-MD-05-01 - Retired Master Warning/Block' },
    { id: 'TC-MD-06-01', label: 'TC-MD-06-01 - Import Validation Before Commit' },
    { id: 'TC-MD-07-01', label: 'TC-MD-07-01 - Mass Update Authorization + Audit Granularity' },
    { id: 'TC-MD-08-01', label: 'TC-MD-08-01 - Parent-Child Hierarchy Integrity' },
  ],
  AT: [
    { id: '', label: 'Run ALL Audit Trail Compliance Tests' },
    { id: 'TC-AT-01-01', label: 'TC-AT-01-01 - Create Operation Audit Trail' },
    { id: 'TC-AT-01-02', label: 'TC-AT-01-02 - Update Operation Audit Trail' },
    { id: 'TC-AT-01-03', label: 'TC-AT-01-03 - Deactivate Operation Audit Trail' },
    { id: 'TC-AT-02-01', label: 'TC-AT-02-01 - Audit Entries Not Editable via UI' },
    { id: 'TC-AT-02-02', label: 'TC-AT-02-02 - Audit Entries Not Deletable via API' },
    { id: 'TC-AT-03-01', label: 'TC-AT-03-01 - Bulk Delete Protection for Audit Data' },
    { id: 'TC-AT-04-01', label: 'TC-AT-04-01 - E-Signature Event Details in Audit Trail' },
    { id: 'TC-AT-05-01', label: 'TC-AT-05-01 - Filter Audit Trail by User' },
    { id: 'TC-AT-05-02', label: 'TC-AT-05-02 - Filter Audit Trail by Date Range' },
    { id: 'TC-AT-05-03', label: 'TC-AT-05-03 - Combined Filters (User + Action)' },
    { id: 'TC-AT-06-01', label: 'TC-AT-06-01 - Failed Login Attempts Logged' },
    { id: 'TC-AT-06-02', label: 'TC-AT-06-02 - Configuration Changes Logged' },
    { id: 'TC-AT-07-01', label: 'TC-AT-07-01 - Audit Trail Export to PDF' },
    { id: 'TC-AT-08-01', label: 'TC-AT-08-01 - Timestamp ISO 8601 UTC Consistency' },
    { id: 'TC-AT-08-02', label: 'TC-AT-08-02 - Admin Time Change Logging' },
    { id: 'TC-AT-09-01', label: 'TC-AT-09-01 - Audit Retention Policy Configuration' },
    { id: 'TC-AT-09-02', label: 'TC-AT-09-02 - Archived Audit Records Accessibility' },
    { id: 'TC-AT-10-01', label: 'TC-AT-10-01 - Post-Deactivation Audit Accessibility' },
  ],
};

const SUITE_META = {
  DI: {
    title: 'Data Integrity Compliance Suite',
    label: 'Data Integrity (DI)',
    displayName: 'Data Integrity',
  },
  MD: {
    title: 'Master Data Compliance Suite',
    label: 'Master Data (MD)',
    displayName: 'Master Data',
  },
  AT: {
    title: 'Audit Trail Compliance Suite',
    label: 'Audit Trail (AT)',
    displayName: 'Audit Trail',
  },
};

const COMPLIANCE_ACTIVE_RUN_STORAGE_KEY = 'complianceActiveRun';

function normalizeStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'passed') return 'passed';
  if (value === 'failed') return 'failed';
  if (value === 'blocked') return 'blocked';
  if (value === 'not-performed') return 'not-performed';
  if (value === 'running' || value === 'in-progress' || value === 'in progress') return 'running';
  if (value === 'stopped') return 'stopped';
  return 'unknown';
}

function StatusBadge({ status }) {
  const normalized = normalizeStatus(status);
  const style = {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: '12px',
    fontWeight: 600,
    fontSize: '0.78rem',
    letterSpacing: '0.04em',
    background: normalized === 'passed'
      ? '#166534'
      : normalized === 'failed'
        ? '#991b1b'
        : normalized === 'blocked'
          ? '#7c2d12'
          : normalized === 'not-performed'
            ? '#1f2937'
            : normalized === 'stopped'
              ? '#78350f'
              : normalized === 'running'
                ? '#0369a1'
              : '#374151',
    color: normalized === 'passed'
      ? '#bbf7d0'
      : normalized === 'failed'
        ? '#fecaca'
        : normalized === 'blocked'
          ? '#fed7aa'
          : normalized === 'not-performed'
            ? '#d1d5db'
            : normalized === 'stopped'
              ? '#fde68a'
              : normalized === 'running'
                ? '#e0f2fe'
              : '#d1d5db',
  };
  return <span style={style}>{String(status || 'UNKNOWN').toUpperCase()}</span>;
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
  const normalizedStatus = normalizeStatus(status);

  const cardStyle = {
    background: '#111827',
    border: `1px solid ${
      normalizedStatus === 'passed'
        ? '#166534'
        : normalizedStatus === 'blocked'
          ? '#9a3412'
          : normalizedStatus === 'not-performed'
            ? '#374151'
            : normalizedStatus === 'stopped'
              ? '#92400e'
              : normalizedStatus === 'running'
                ? '#0369a1'
              : '#7f1d1d'
    }`,
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
        <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>{expanded ? 'Hide' : 'Details'}</span>
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
    suite: 'DI',
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'aakash',
    password: 'admin@123',
    username2: '',
    password2: '',
    masterNames: [],
    tcIds: [],
    showBrowser: true,
  });

  const [localMasters, setLocalMasters] = useState(Array.isArray(masters) && masters.length ? masters : []);
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [activeRun, setActiveRun] = useState(null);
  const [streamError, setStreamError] = useState('');
  const streamRef = useRef(null);

  const availableMasters = Array.isArray(localMasters) && localMasters.length ? localMasters : masters;
  const requestedSuite = String(config.suite || 'DI').toUpperCase();
  const activeSuite = Object.prototype.hasOwnProperty.call(TC_OPTIONS_BY_SUITE, requestedSuite) ? requestedSuite : 'DI';
  const activeSuiteMeta = SUITE_META[activeSuite] || SUITE_META.DI;
  const suiteTcOptions = TC_OPTIONS_BY_SUITE[activeSuite] || TC_OPTIONS_BY_SUITE.DI;
  const masterOptions = availableMasters.map((m) => m.name).sort();
  const masterOptionObjs = masterOptions.map((m) => ({ value: m, label: m }));
  const testOptionObjs = suiteTcOptions.filter((tc) => tc.id).map((tc) => ({ value: tc.id, label: tc.label }));

  function closeRunStream() {
    if (streamRef.current) {
      try {
        streamRef.current.close();
      } catch (_) {
        // ignore
      }
      streamRef.current = null;
    }
  }

  function clearActiveRunTracking() {
    localStorage.removeItem(COMPLIANCE_ACTIVE_RUN_STORAGE_KEY);
    setActiveRun(null);
  }

  function toResultFromSnapshot(snapshot) {
    if (!snapshot) return null;
    const summary = snapshot?.summary || {};
    return {
      mode: 'batch',
      suite: snapshot?.suite,
      runStatus: String(snapshot?.status || '').toLowerCase(),
      results: Array.isArray(snapshot?.results) ? snapshot.results : [],
      summary: {
        total: Number(summary?.total || 0),
        passed: Number(summary?.passed || 0),
        failed: Number(summary?.failed || 0),
        blocked: Number(summary?.blocked || 0),
        notPerformed: Number(summary?.notPerformed || 0),
      },
    };
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return;
    setProgress(String(snapshot?.progressMessage || ''));
    setResult(toResultFromSnapshot(snapshot));
    const runStillActive = String(snapshot?.status || '').toLowerCase() === 'running';
    setRunning(runStillActive);
    if (!runStillActive) {
      setStreamError('');
      closeRunStream();
      clearActiveRunTracking();
    }
  }

  function startRunStream(runId, clientToken) {
    closeRunStream();
    const eventSource = openComplianceRunStream(runId, clientToken);
    streamRef.current = eventSource;
    setStreamError('');

    eventSource.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse(String(event?.data || '{}'));
        applySnapshot(payload);
      } catch (_) {
        // ignore parse errors
      }
    });

    eventSource.addEventListener('progress', (event) => {
      try {
        const payload = JSON.parse(String(event?.data || '{}'));
        if (payload?.progressMessage) setProgress(String(payload.progressMessage));
      } catch (_) {
        // ignore parse errors
      }
    });

    eventSource.onerror = () => {
      setStreamError('Live updates disconnected. Use Reconnect to continue tracking.');
    };
  }

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (Array.isArray(localMasters) && localMasters.length) return;
      try {
        const data = await getMasters();
        if (!mounted) return;
        const list = Array.isArray(data?.masters) ? data.masters : [];
        setLocalMasters(list);
      } catch (_) {
        // ignore
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function restoreRun() {
      try {
        const raw = localStorage.getItem(COMPLIANCE_ACTIVE_RUN_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const runId = String(parsed?.runId || '').trim();
        const clientToken = String(parsed?.clientToken || '').trim();
        if (!runId || !clientToken) {
          localStorage.removeItem(COMPLIANCE_ACTIVE_RUN_STORAGE_KEY);
          return;
        }
        if (!mounted) return;
        setActiveRun({ runId, clientToken, startedAt: parsed?.startedAt || '' });
        const snapshot = await getComplianceRun(runId, clientToken);
        if (!mounted) return;
        applySnapshot(snapshot);
        if (String(snapshot?.status || '').toLowerCase() === 'running') {
          startRunStream(runId, clientToken);
        }
      } catch (_) {
        localStorage.removeItem(COMPLIANCE_ACTIVE_RUN_STORAGE_KEY);
      }
    }

    restoreRun();
    return () => {
      mounted = false;
      closeRunStream();
    };
  }, []);

  function handleChange(field) {
    return (e) => {
      const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setConfig((prev) => ({ ...prev, [field]: value }));
    };
  }

  async function handleRun() {
    if (running || activeRun?.runId) return;
    setRunning(true);
    setResult(null);
    setError('');
    setStreamError('');
    setProgress('Starting compliance run...');

    try {
      const payload = {
        suite: activeSuite,
        loginUrl: config.loginUrl,
        username: config.username,
        password: config.password,
        username2: config.username2 || undefined,
        password2: config.password2 || undefined,
        masterNames: Array.isArray(config.masterNames) ? config.masterNames : [],
        masterName: Array.isArray(config.masterNames) && config.masterNames.length
          ? undefined
          : (availableMasters.map((m) => m.name).slice(0, 1)[0] || 'Country'),
        tcIds: Array.isArray(config.tcIds) && config.tcIds.length ? config.tcIds : [''],
        showBrowser: config.showBrowser,
      };

      const started = await startComplianceRun(payload);
      const runId = String(started?.runId || '').trim();
      const clientToken = String(started?.clientToken || '').trim();
      if (!runId || !clientToken) throw new Error('Compliance run start failed');

      const runRef = { runId, clientToken, startedAt: new Date().toISOString() };
      localStorage.setItem(COMPLIANCE_ACTIVE_RUN_STORAGE_KEY, JSON.stringify(runRef));
      setActiveRun(runRef);

      const snapshot = await getComplianceRun(runId, clientToken);
      applySnapshot(snapshot);
      if (String(snapshot?.status || '').toLowerCase() === 'running') {
        startRunStream(runId, clientToken);
      }
    } catch (err) {
      setRunning(false);
      setProgress('');
      setError(err?.message || 'Compliance run failed');
      clearActiveRunTracking();
    }
  }

  async function handleReconnect() {
    if (!activeRun?.runId || !activeRun?.clientToken) return;
    setStreamError('');
    try {
      const snapshot = await getComplianceRun(activeRun.runId, activeRun.clientToken);
      applySnapshot(snapshot);
      if (String(snapshot?.status || '').toLowerCase() === 'running') {
        startRunStream(activeRun.runId, activeRun.clientToken);
      }
    } catch (err) {
      setStreamError(err?.message || 'Reconnect failed');
    }
  }

  async function handleStop() {
    if (!activeRun?.runId || !activeRun?.clientToken || !running) return;
    try {
      setProgress('Stopping compliance run...');
      setStreamError('');
      await stopComplianceRun(activeRun.runId, activeRun.clientToken);
    } catch (err) {
      setStreamError(err?.message || 'Stop request failed');
    }
  }

  const allResultsList = result?.mode === 'all' || result?.mode === 'batch' ? (result?.results || []) : (result ? [result] : []);
  const summary = result?.summary;
  const summaryBlocked = Number(summary?.blocked || 0);
  const summaryFailed = Number(summary?.failed || 0);
  const summaryNotPerformed = Number(summary?.notPerformed || 0);
  const runStatus = String(result?.runStatus || '').toLowerCase();
  const summaryStatus = running || runStatus === 'running' || runStatus === 'in-progress' || runStatus === 'in progress'
    ? 'running'
    : runStatus === 'stopped'
      ? 'stopped'
      : summaryFailed > 0
        ? 'failed'
        : summaryBlocked > 0
          ? 'blocked'
          : summaryNotPerformed > 0
            ? 'not-performed'
            : 'passed';
  const runActionDisabled = running || Boolean(activeRun?.runId);

  return (
    <>
      <section className="grid">
        <article className="card card-wide">
          <h2>{activeSuiteMeta.title}</h2>
          <p style={{ color: '#9ca3af', marginBottom: '18px', fontSize: '0.9rem' }}>
            Trigger automated {activeSuiteMeta.label} compliance verification tests directly from the TestHive UI.
            Each test case maps to a compliance point and outputs a structured pass/fail report.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', width: '100%' }}>
            <div className="form-group" style={{ width: '100%' }}>
              <label>Compliance Suite</label>
              <MultiSelect
                options={SUITE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                value={[config.suite]}
                onChange={(vals) => {
                  setConfig((prev) => {
                    const incoming = Array.isArray(vals) ? vals : [];
                    let selected = prev.suite || 'DI';

                    if (incoming.length === 1) {
                      selected = incoming[0];
                    } else if (incoming.length > 1) {
                      selected = incoming.find((v) => v !== prev.suite) || incoming[0] || selected;
                    }

                    return { ...prev, suite: selected, tcIds: [] };
                  });
                }}
                placeholder="Select compliance suite..."
                selectAll={false}
                searchable={false}
                id="compliance-suite-select"
                rootClassName="multi-select-compliance compliance-suite-single-select"
                wrapTags={false}
                closeOnSelect={true}
              />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Login URL</label>
              <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} value={config.loginUrl} onChange={handleChange('loginUrl')} />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Username (Primary)</label>
              <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} value={config.username} onChange={handleChange('username')} />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Password (Primary)</label>
              <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} type="password" value={config.password} onChange={handleChange('password')} />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Username 2 (for review/concurrent scenarios)</label>
              <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} value={config.username2} onChange={handleChange('username2')} placeholder="Same as primary if blank" />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Password 2</label>
              <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} type="password" value={config.password2} onChange={handleChange('password2')} placeholder="Same as primary if blank" />
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Master(s) Under Test</label>
              {masterOptions.length > 0 ? (
                <MultiSelect
                  options={masterOptionObjs}
                  value={config.masterNames}
                  onChange={(vals) => setConfig((p) => ({ ...p, masterNames: vals }))}
                  placeholder="Select masters..."
                  selectAll={true}
                  id="masters-select"
                  searchable={true}
                  wrapTags={true}
                />
              ) : (
                <input className="input" style={{ width: '100%', boxSizing: 'border-box' }} value={(config.masterNames || []).join(', ')} onChange={(e) => setConfig((p) => ({ ...p, masterNames: [e.target.value] }))} placeholder="e.g. Country" />
              )}
            </div>

            <div className="form-group" style={{ width: '100%' }}>
              <label>Test Case(s) to Run</label>
              <MultiSelect
                options={testOptionObjs}
                value={config.tcIds}
                onChange={(vals) => setConfig((p) => ({ ...p, tcIds: vals }))}
                placeholder="Select test steps ..."
                selectAll={true}
                id="tc-select"
                searchable={testOptionObjs.length > 6}
                wrapTags={true}
              />
              <div style={{ color: '#6b7280', fontSize: '0.7rem', marginTop: '5px' }}>No selection = run ALL tests.</div>
            </div>
            
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginTop: '18px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#d1d5db' }}>
              <input type="checkbox" checked={config.showBrowser} onChange={handleChange('showBrowser')} />
              Show Browser
            </label>
            <button className="btn btn-primary" onClick={handleRun} disabled={runActionDisabled}>
              {runActionDisabled ? 'Run in progress...' : (Array.isArray(config.tcIds) && config.tcIds.length ? `Run ${config.tcIds.length} test(s)` : `Run All ${activeSuiteMeta.displayName || activeSuite} Compliance Tests`)}
            </button>
            {running && activeRun?.runId && (
              <>
                <button type="button" className="btn btn-secondary" onClick={handleReconnect}>
                  Reconnect
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleStop}>
                  Stop
                </button>
              </>
            )}
            {progress && <div style={{ color: '#9ca3af', fontSize: '0.9rem' }}>{progress}</div>}
            {streamError && <div style={{ color: '#fbbf24', fontSize: '0.85rem' }}>{streamError}</div>}
          </div>
        </article>
      </section>

      {summary && (
        <section className="grid">
          <article className="card card-wide" style={{ display: 'flex', gap: '28px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#6a6a6a' }}>{summary.total}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Total</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#4ade80' }}>{summary.passed}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Passed</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f87171' }}>{summary.failed}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Failed</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fb923c' }}>{summaryBlocked}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Blocked</div></div>
            <div><span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#9ca3af' }}>{summaryNotPerformed}</span><div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Not Performed</div></div>
            <div style={{ marginLeft: 'auto' }}><StatusBadge status={summaryStatus} /></div>
          </article>
        </section>
      )}

      {result && result.mode === 'single' && (
        <section className="grid">
          <article className="card card-wide">
            <h3 style={{ marginBottom: '14px' }}>Result</h3>
            <TcResultCard result={result} sharedDebug={result?._debug || ''} />
          </article>
        </section>
      )}

      {allResultsList.length > 0 && (result?.mode === 'all' || result?.mode === 'batch') && (
        <section className="grid">
          <article className="card card-wide">
            <h3 style={{ marginBottom: '14px' }}>Test Results</h3>
            {allResultsList.map((r, i) => <TcResultCard key={i} result={r} sharedDebug={result?._debug || ''} />)}
          </article>
        </section>
      )}

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
