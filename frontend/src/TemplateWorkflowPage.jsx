import { useState, useEffect } from 'react';
import { runTemplateWorkflow, getLastWorkflowRun } from './api/client';

const STEP_ORDER = [
  'login', 'createSite', 'createApp', 'createTemplate',
  'createSubTemplate', 'assignWorkflow',
];

const STEP_LABELS = {
  login:              '1. Login',
  createSite:         '2. Create Site',
  createApp:          '3. Create App',
  createTemplate:     '4. Create Template',
  createSubTemplate:  '5. Create Sub-Template',
  assignWorkflow:     '6. Template Workflow — Select & Add New',
};

const STATUS_ICON  = { passed: '✅', failed: '❌', skipped: '⏭', pending: '○', running: '⏳' };
const STATUS_COLOR = { passed: '#22c55e', failed: '#ef4444', skipped: '#f59e0b', pending: '#6b7280', running: '#3b82f6' };

/** First step that is failed or pending — that is where we resume */
function findResumeStep(steps) {
  for (const key of STEP_ORDER) {
    const s = steps?.[key]?.status;
    if (s === 'failed' || s === 'pending') return key;
  }
  return null;
}

function StepRow({ stepKey, stepData, isCurrent }) {
  const status = isCurrent ? 'running' : (stepData?.status || 'pending');
  return (
    <li style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid #1e293b' }}>
      <span style={{ fontSize: 18, minWidth: 24, color: STATUS_COLOR[status] || '#6b7280' }}>
        {STATUS_ICON[status] || '○'}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: '#e2e8f0' }}>{STEP_LABELS[stepKey]}</div>
        {stepData?.message && (
          <div style={{ fontSize: 12, color: status === 'failed' ? '#f87171' : '#94a3b8', marginTop: 2 }}>
            {stepData.message}
          </div>
        )}
        {stepData?.siteName        && <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 1 }}>Site: {stepData.siteName}</div>}
        {stepData?.appName         && <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 1 }}>App: {stepData.appName}</div>}
        {stepData?.templateName    && <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 1 }}>Template: {stepData.templateName}</div>}
        {stepData?.subTemplateName && <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 1 }}>Sub-Template: {stepData.subTemplateName}</div>}
        {stepData?.wfName          && <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 1 }}>Workflow: {stepData.wfName}</div>}
      </div>
    </li>
  );
}

export default function TemplateWorkflowPage() {
  const [showBrowser, setShowBrowser] = useState(true);
  const [running,     setRunning]     = useState(false);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState('');
  const [logs,        setLogs]        = useState('');
  const [showLogs,    setShowLogs]    = useState(false);
  const [lastRun,     setLastRun]     = useState(null);

  // Load last run state from backend JSON on mount
  useEffect(() => {
    getLastWorkflowRun().then(data => {
      if (data?.exists) setLastRun(data);
    }).catch(() => {});
  }, []);

  const resumeStep = lastRun ? findResumeStep(lastRun.steps) : null;
  const canResume  = !!resumeStep && !!lastRun?.flowState;

  async function execute(opts = {}) {
    setRunning(true);
    setError('');
    setResult(null);
    setLogs('');
    setShowLogs(false);
    try {
      const payload = { showBrowser };
      if (opts.resumeFromStep) {
        payload.resumeFromStep     = opts.resumeFromStep;
        payload.prefilledFlowState = opts.flowState;
      }
      const data = await runTemplateWorkflow(payload);
      setResult(data);
      setLogs(data.logs || '');
      // Refresh resume state from backend after run
      getLastWorkflowRun().then(d => { if (d?.exists) setLastRun(d); }).catch(() => {});
    } catch (err) {
      setError(err.message || 'Template Workflow failed');
    } finally {
      setRunning(false);
    }
  }

  const steps       = result?.jsonResult?.steps    || result?.steps    || null;
  const flowState   = result?.jsonResult?.flowState || result?.flowState || null;
  const overallStatus = result?.jsonResult?.status || result?.status   || null;

  return (
    <section className="page-section">
      <header className="page-header">
        <h1>Template Workflow</h1>
        <p className="muted">
          Full E2E: Site → App → Template → Sub-Template → Workflow Assignment
        </p>
      </header>

      {/* Steps */}
      <article className="card card-wide">
        <h2>Workflow Steps</h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {STEP_ORDER.map(key => (
            <StepRow key={key} stepKey={key} stepData={steps?.[key]} isCurrent={running && !steps} />
          ))}
        </ul>
      </article>

      {/* Controls */}
      <article className="card card-wide">
        <h2>Run Controls</h2>

        <label className="config-label" style={{ marginBottom: 20 }}>
          <input
            type="checkbox"
            checked={showBrowser}
            onChange={e => setShowBrowser(e.target.checked)}
            disabled={running}
          />
          Show Browser (headed mode)
        </label>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>

          {/* Run Full */}
          <button
            type="button"
            className="btn-primary"
            onClick={() => execute()}
            disabled={running}
            style={{ minWidth: 210 }}
          >
            {running ? '⏳ Running...' : '▶ Run Full Workflow'}
          </button>

          {/* Resume — shown only when a previous failed run exists */}
          {canResume && (
            <button
              type="button"
              onClick={() => execute({ resumeFromStep: resumeStep, flowState: lastRun.flowState })}
              disabled={running}
              style={{
                minWidth: 210,
                padding: '10px 20px',
                borderRadius: 8,
                border: '2px solid #f59e0b',
                background: '#1c1400',
                color: '#fbbf24',
                fontWeight: 700,
                fontSize: 14,
                cursor: running ? 'not-allowed' : 'pointer',
                opacity: running ? 0.5 : 1,
              }}
            >
              ⏩ Resume from Step {STEP_ORDER.indexOf(resumeStep) + 1}
            </button>
          )}
        </div>

        {/* Resume info — small pill below buttons */}
        {canResume && !running && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#0c1e0c', border: '1px solid #166534', borderRadius: 6, fontSize: 12, color: '#86efac' }}>
            Will resume from: <strong>{STEP_LABELS[resumeStep]}</strong>
            {lastRun.flowState.siteName     && <span style={{ marginLeft: 12, color: '#6ee7b7' }}>Site: {lastRun.flowState.siteName}</span>}
            {lastRun.flowState.appName      && <span style={{ marginLeft: 8, color: '#6ee7b7' }}>App: {lastRun.flowState.appName}</span>}
            {lastRun.flowState.templateName && <span style={{ marginLeft: 8, color: '#6ee7b7' }}>Template: {lastRun.flowState.templateName}</span>}
          </div>
        )}
      </article>

      {/* Error */}
      {error && (
        <article className="card card-wide status-error-card">
          <h3>Error</h3>
          <p className="status-error">{error}</p>
        </article>
      )}

      {/* Result */}
      {result && (
        <article className="card card-wide">
          <h2>Result</h2>
          <div className={`result-badge ${overallStatus === 'completed' ? 'badge-pass' : 'badge-fail'}`}>
            {overallStatus === 'completed' ? '✅ ALL PASSED'
              : overallStatus === 'completed-with-issues' ? '⚠️ COMPLETED WITH ISSUES'
              : '❌ FAILED'}
          </div>
          {result?.jsonResult?.resumedFrom && (
            <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 6 }}>
              ⏩ Resumed from: <strong>{STEP_LABELS[result.jsonResult.resumedFrom] || result.jsonResult.resumedFrom}</strong>
            </div>
          )}
          <p style={{ color: '#94a3b8', marginTop: 8 }}>{result.message}</p>
          {flowState && (
            <div style={{ marginTop: 12, padding: 12, background: '#0f172a', borderRadius: 8, fontSize: 13 }}>
              <div style={{ fontWeight: 600, color: '#60a5fa', marginBottom: 6 }}>📋 Data From This Run</div>
              {flowState.siteName        && <div style={{ color: '#e2e8f0' }}>📍 Site: <strong>{flowState.siteName}</strong></div>}
              {flowState.appName         && <div style={{ color: '#e2e8f0', marginTop: 4 }}>🅰 App: <strong>{flowState.appName}</strong></div>}
              {flowState.templateName    && <div style={{ color: '#e2e8f0', marginTop: 4 }}>📄 Template: <strong>{flowState.templateName}</strong></div>}
              {flowState.subTemplateName && <div style={{ color: '#e2e8f0', marginTop: 4 }}>📄 Sub-Template: <strong>{flowState.subTemplateName}</strong></div>}
              {flowState.workflowName    && <div style={{ color: '#e2e8f0', marginTop: 4 }}>⚙️ Workflow: <strong>{flowState.workflowName}</strong></div>}
            </div>
          )}
        </article>
      )}

      {/* Logs */}
      {logs && (
        <article className="card card-wide">
          <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            Logs
            <button type="button" onClick={() => setShowLogs(v => !v)} style={{ fontSize: 12, padding: '4px 10px' }}>
              {showLogs ? 'Hide' : 'Show'}
            </button>
          </h2>
          {showLogs && <pre className="log-output">{logs}</pre>}
        </article>
      )}
    </section>
  );
}
