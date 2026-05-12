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
const STATUS_COLOR = { passed: '#16a34a', failed: '#dc2626', skipped: '#ca8a04', pending: '#64748b', running: '#2563eb' };

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
    <li className="tw-step-row">
      <span className="tw-step-icon" style={{ color: STATUS_COLOR[status] || '#64748b' }}>
        {STATUS_ICON[status] || '○'}
      </span>
      <div className="tw-step-body">
        <div className="tw-step-title">{STEP_LABELS[stepKey]}</div>
        {stepData?.message && (
          <div className={`tw-step-msg ${status === 'failed' ? 'tw-step-msg--fail' : ''}`}>
            {stepData.message}
          </div>
        )}
        {stepData?.siteName        && <div className="tw-step-meta">Site: {stepData.siteName}</div>}
        {stepData?.appName         && <div className="tw-step-meta">App: {stepData.appName}</div>}
        {stepData?.templateName    && <div className="tw-step-meta">Template: {stepData.templateName}</div>}
        {stepData?.subTemplateName && <div className="tw-step-meta">Sub-Template: {stepData.subTemplateName}</div>}
        {stepData?.wfName          && <div className="tw-step-meta">Workflow: {stepData.wfName}</div>}
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
        <ul className="tw-step-list">
          {STEP_ORDER.map(key => (
            <StepRow key={key} stepKey={key} stepData={steps?.[key]} isCurrent={running && !steps} />
          ))}
        </ul>
      </article>

      {/* Controls */}
      <article className="card card-wide">
        <h2>Run Controls</h2>

        <label className="config-label tw-config-label">
          <input
            type="checkbox"
            checked={showBrowser}
            onChange={e => setShowBrowser(e.target.checked)}
            disabled={running}
          />
          Show Browser (headed mode)
        </label>

        <div className="tw-actions">

          {/* Run Full */}
          <button
            type="button"
            className="btn-primary tw-btn-run"
            onClick={() => execute()}
            disabled={running}
          >
            {running ? '⏳ Running...' : '▶ Run Full Workflow'}
          </button>

          {/* Resume — shown only when a previous failed run exists */}
          {canResume && (
            <button
              type="button"
              className="btn-resume"
              onClick={() => execute({ resumeFromStep: resumeStep, flowState: lastRun.flowState })}
              disabled={running}
            >
              ⏩ Resume from Step {STEP_ORDER.indexOf(resumeStep) + 1}
            </button>
          )}
        </div>

        {/* Resume info — small pill below buttons */}
        {canResume && !running && (
          <div className="tw-resume-banner">
            Will resume from: <strong>{STEP_LABELS[resumeStep]}</strong>
            {lastRun.flowState.siteName     && <span className="tw-resume-meta">Site: {lastRun.flowState.siteName}</span>}
            {lastRun.flowState.appName      && <span className="tw-resume-meta">App: {lastRun.flowState.appName}</span>}
            {lastRun.flowState.templateName && <span className="tw-resume-meta">Template: {lastRun.flowState.templateName}</span>}
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
            <div className="tw-resumed-note">
              ⏩ Resumed from: <strong>{STEP_LABELS[result.jsonResult.resumedFrom] || result.jsonResult.resumedFrom}</strong>
            </div>
          )}
          <p className="tw-result-message">{result.message}</p>
          {flowState && (
            <div className="tw-flow-panel">
              <div className="tw-flow-panel-title">Data from this run</div>
              {flowState.siteName        && <div className="tw-flow-line">Site: <strong>{flowState.siteName}</strong></div>}
              {flowState.appName         && <div className="tw-flow-line">App: <strong>{flowState.appName}</strong></div>}
              {flowState.templateName    && <div className="tw-flow-line">Template: <strong>{flowState.templateName}</strong></div>}
              {flowState.subTemplateName && <div className="tw-flow-line">Sub-Template: <strong>{flowState.subTemplateName}</strong></div>}
              {flowState.workflowName    && <div className="tw-flow-line">Workflow: <strong>{flowState.workflowName}</strong></div>}
            </div>
          )}
        </article>
      )}

      {/* Logs */}
      {logs && (
        <article className="card card-wide">
          <h2 className="tw-logs-heading">
            Logs
            <button type="button" className="btn-ghost-sm" onClick={() => setShowLogs(v => !v)}>
              {showLogs ? 'Hide' : 'Show'}
            </button>
          </h2>
          {showLogs && <pre className="log-output">{logs}</pre>}
        </article>
      )}
    </section>
  );
}
