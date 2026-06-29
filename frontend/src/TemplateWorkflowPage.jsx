import { useState, useEffect } from 'react';
import {
  runTemplateWorkflow,
  getLastWorkflowRun,
  getLastPassedWorkflowRun,
  runTemplateDesign,
  getTemplateDesignOptions,
} from './api/client';

const STEP_ORDER = [
  'login', 'createSite', 'createApp', 'createTemplate',
  'createSubTemplate', 'assignWorkflow', 'selectAppUnderSite', 'auditTrail',
];

const STEP_LABELS = {
  login:              '1. Login',
  createSite:         '2. Create Site',
  createApp:          '3. Create App',
  createTemplate:     '4. Create Template',
  createSubTemplate:  '5. Create Sub-Template',
  assignWorkflow:     '6. Template Workflow — Select & Add New',
  selectAppUnderSite: '7. Switch App Under Site',
  auditTrail:         '8. Verify Audit Trail',
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

const TD_STEP_LABELS = {
  login:           '1. Login',
  navigate:        '2. Navigate to Template Design',
  applyFilters:    '3. Apply Workflow Filters',
  discoverControls:'4. Discover All Controls',
  testTabs:        '5. Test Page Tabs',
  openRecord:      '6. Open Template Record',
  testCanvas:      '7. Test Design Canvas',
  testControls:    '8. Test All Controls',
};

const TD_STEP_ORDER = Object.keys(TD_STEP_LABELS);

function TdStepRow({ stepKey, stepData }) {
  const status = stepData?.status || 'pending';
  return (
    <li className="tw-step-row">
      <span className="tw-step-icon" style={{ color: STATUS_COLOR[status] || '#64748b' }}>
        {STATUS_ICON[status] || '○'}
      </span>
      <div className="tw-step-body">
        <div className="tw-step-title">{TD_STEP_LABELS[stepKey]}</div>
        {stepData?.message && (
          <div className={`tw-step-msg ${status === 'failed' ? 'tw-step-msg--fail' : ''}`}>
            {stepData.message}
          </div>
        )}
        {stepData?.count !== undefined && <div className="tw-step-meta">Count: {stepData.count}</div>}
        {stepData?.passed !== undefined && <div className="tw-step-meta">Passed: {stepData.passed} / Failed: {stepData.failed} / Skipped: {stepData.skipped}</div>}
        {Array.isArray(stepData?.applied) && stepData.applied.length > 0 && (
          <div className="tw-step-meta">Applied: {stepData.applied.map(a => `${a.label}="${a.value}"`).join(', ')}</div>
        )}
      </div>
    </li>
  );
}

function buildFallbackDesignApps(flowCandidates = []) {
  const uniq = new Map();

  flowCandidates.forEach((flow, idx) => {
    const appName = String(flow?.appName || '').trim();
    const templateName = String(flow?.templateName || '').trim();
    const subTemplateName = String(flow?.subTemplateName || '').trim();
    if (!appName || !templateName) return;

    const key = `${appName}::${templateName}`.toLowerCase();
    if (uniq.has(key)) return;

    const fallbackAppId = `fallback-app-${idx + 1}`;
    const fallbackTemplateValue = `fallback-template-${idx + 1}`;

    uniq.set(key, {
      appId: fallbackAppId,
      appName,
      templates: [
        {
          value: fallbackTemplateValue,
          label: templateName,
          objectId: '',
          publish: '',
          subTemplates: subTemplateName
            ? [{ value: `${fallbackTemplateValue}-sub-1`, label: subTemplateName, childId: '', objectId: '' }]
            : [],
        },
      ],
    });
  });

  return Array.from(uniq.values());
}

export default function TemplateWorkflowPage() {
  const [showBrowser, setShowBrowser] = useState(true);
  const [running,     setRunning]     = useState(false);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState('');
  const [logs,        setLogs]        = useState('');
  const [showLogs,    setShowLogs]    = useState(false);
  const [lastRun,     setLastRun]     = useState(null);
  const [lastPassedRun, setLastPassedRun] = useState(null);

  // ── Template Design state ──────────────────────────────────────────────────
  const [tdRunning,       setTdRunning]       = useState(false);
  const [tdResult,        setTdResult]        = useState(null);
  const [tdError,         setTdError]         = useState('');
  const [tdShowLogs,      setTdShowLogs]      = useState(false);
  const [tdFlowSource,    setTdFlowSource]    = useState('current'); // 'current' | 'last-passed' | 'manual-existing'
  const [tdShowControls,  setTdShowControls]  = useState(false);
  const [tdOptionsLoading, setTdOptionsLoading] = useState(false);
  const [tdOptionsFetched, setTdOptionsFetched] = useState(false);
  const [tdOptionsError, setTdOptionsError] = useState('');
  const [tdDesignApps, setTdDesignApps] = useState([]);
  const [tdManualFlow,    setTdManualFlow]    = useState({
    siteName: '',
    appId: '',
    appName: '',
    templateValue: '',
    templateName: '',
    subTemplateValue: '',
    subTemplateName: '',
    workflowName: '',
  });

  // Load last run state from backend JSON on mount
  useEffect(() => {
    getLastWorkflowRun().then(data => {
      if (data?.exists) setLastRun(data);
    }).catch(() => {});
    getLastPassedWorkflowRun().then(data => {
      if (data?.exists) setLastPassedRun(data);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tdFlowSource !== 'manual-existing') return;
    if (tdOptionsFetched || tdOptionsLoading) return;

    setTdOptionsLoading(true);
    setTdOptionsError('');
    getTemplateDesignOptions({ showBrowser: false }).then((data) => {
      const apps = Array.isArray(data?.apps) ? data.apps : [];
      setTdDesignApps(apps);
      if (apps.length === 0) {
        setTdOptionsError('No app/template options returned. Please ensure backend is running and credentials have access to Design Template.');
      }
    }).catch((err) => {
      setTdOptionsError(err.message || 'Failed to load Template Design options');
    }).finally(() => {
      setTdOptionsLoading(false);
      setTdOptionsFetched(true);
    });
  }, [tdFlowSource, tdOptionsFetched, tdOptionsLoading]);

  function retryLoadTemplateDesignOptions() {
    setTdOptionsFetched(false);
  }

  const steps       = result?.jsonResult?.steps    || result?.steps    || null;
  const flowState   = result?.jsonResult?.flowState || result?.flowState || null;
  const overallStatus = result?.jsonResult?.status || result?.status   || null;

  // Template Design derived data
  const tdSteps       = tdResult?.jsonResult?.steps    || tdResult?.steps    || null;
  const tdOverall     = tdResult?.jsonResult?.status   || tdResult?.status   || null;
  const tdSummary     = tdResult?.jsonResult?.summary  || tdResult?.summary  || null;
  const tdCtrlResults = tdResult?.jsonResult?.controlTestResults || tdResult?.controlTestResults || [];

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
      getLastPassedWorkflowRun().then(d => { if (d?.exists) setLastPassedRun(d); }).catch(() => {});
    } catch (err) {
      setError(err.message || 'Template Workflow failed');
    } finally {
      setRunning(false);
    }
  }

  // ── Template Design: resolve which flow state to use ──────────────────────
  function resolvedTdFlowState() {
    if (tdFlowSource === 'current' && flowState) return flowState;
    if (tdFlowSource === 'last-passed' && lastPassedRun?.flowState) return lastPassedRun.flowState;
    if (tdFlowSource === 'manual-existing') return tdManualFlow;
    return flowState || lastPassedRun?.flowState || {};
  }

  const fallbackDesignApps = buildFallbackDesignApps([
    flowState || {},
    lastPassedRun?.flowState || {},
  ]);
  const effectiveDesignApps = tdDesignApps.length > 0 ? tdDesignApps : fallbackDesignApps;

  const selectedManualApp = effectiveDesignApps.find((app) => String(app.appId) === String(tdManualFlow.appId)) || null;
  const selectedManualTemplate = selectedManualApp?.templates?.find((tpl) => String(tpl.value) === String(tdManualFlow.templateValue)) || null;
  const manualSubTemplates = selectedManualTemplate?.subTemplates || [];

  function selectManualApp(appId) {
    const app = effectiveDesignApps.find((item) => String(item.appId) === String(appId)) || null;
    setTdManualFlow((prev) => ({
      ...prev,
      appId: app ? String(app.appId) : '',
      appName: app?.appName || '',
      templateValue: '',
      templateName: '',
      subTemplateValue: '',
      subTemplateName: '',
    }));
  }

  function selectManualTemplate(templateValue) {
    const app = effectiveDesignApps.find((item) => String(item.appId) === String(tdManualFlow.appId)) || null;
    const template = app?.templates?.find((item) => String(item.value) === String(templateValue)) || null;
    setTdManualFlow((prev) => ({
      ...prev,
      templateValue: template ? String(template.value) : '',
      templateName: template?.label || '',
      subTemplateValue: '',
      subTemplateName: '',
    }));
  }

  function selectManualSubTemplate(subTemplateValue) {
    const subTemplate = manualSubTemplates.find((item) => String(item.value) === String(subTemplateValue)) || null;
    setTdManualFlow((prev) => ({
      ...prev,
      subTemplateValue: subTemplate ? String(subTemplate.value) : '',
      subTemplateName: subTemplate?.label || '',
    }));
  }

  async function runDesign() {
    const fs = resolvedTdFlowState();
    if (!fs?.appName || !fs?.templateName) {
      setTdError('App Name and Template Name are required to run Template Design automation.');
      return;
    }
    setTdRunning(true);
    setTdError('');
    setTdResult(null);
    setTdShowLogs(false);
    setTdShowControls(false);
    try {
      const data = await runTemplateDesign({ showBrowser, flowState: fs });
      setTdResult(data);
    } catch (err) {
      setTdError(err.message || 'Template Design automation failed');
    } finally {
      setTdRunning(false);
    }
  }

  // Determine if we have flow data available for Template Design
  const hasCurrentFlow = !!(flowState?.templateName || flowState?.appName || flowState?.siteName);
  const hasLastPassedFlow = !!(
    lastPassedRun?.flowState?.templateName
    || lastPassedRun?.flowState?.appName
    || lastPassedRun?.flowState?.siteName
  );
  const hasManualFlow = !!(tdManualFlow.appName && tdManualFlow.templateName);
  const canRunDesign   = hasCurrentFlow || hasLastPassedFlow || hasManualFlow;

  const activeFlowState = resolvedTdFlowState();

  return (
    <section className="page-section">
      <header className="page-header">
        <h1>Template Workflow</h1>
        <p className="muted">
          Full E2E: Site → App → Template → Sub-Template → Workflow Assignment → App Switch → Audit Check
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
            disabled={running || tdRunning}
          />
          Show Browser (headed mode)
        </label>

        <div className="tw-actions">

          {/* Run Full */}
          <button
            type="button"
            className="btn-primary tw-btn-run"
            onClick={() => execute()}
            disabled={running || tdRunning}
          >
            {running ? '⏳ Running...' : '▶ Run Full Workflow'}
          </button>

          {/* Resume — shown only when a previous failed run exists */}
          {canResume && (
            <button
              type="button"
              className="btn-resume"
              onClick={() => execute({ resumeFromStep: resumeStep, flowState: lastRun.flowState })}
              disabled={running || tdRunning}
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

      {/* ── Template Design Automation Section ────────────────────────────── */}
      <article className="card card-wide" style={{ marginTop: '1.5rem', borderTop: '2px solid #6366f1' }}>
        <h2 style={{ color: '#6366f1' }}>Template Design Automation</h2>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          Navigate to the Template Design page using data from a workflow run, then discover and test all available controls.
        </p>

        {/* Flow source selector */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.92rem' }}>Select Workflow Data Source:</div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: hasCurrentFlow ? 'pointer' : 'not-allowed', opacity: hasCurrentFlow ? 1 : 0.45 }}>
              <input
                type="radio"
                name="tdFlowSource"
                value="current"
                checked={tdFlowSource === 'current'}
                onChange={() => setTdFlowSource('current')}
                disabled={!hasCurrentFlow || tdRunning}
              />
              <span>
                Current Run
                {flowState?.templateName && <span className="tw-resume-meta" style={{ marginLeft: 6 }}>Template: {flowState.templateName}</span>}
                {flowState?.appName && <span className="tw-resume-meta" style={{ marginLeft: 6 }}>App: {flowState.appName}</span>}
                {!hasCurrentFlow && <span style={{ color: '#94a3b8', marginLeft: 6 }}>(no data yet)</span>}
              </span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: hasLastPassedFlow ? 'pointer' : 'not-allowed', opacity: hasLastPassedFlow ? 1 : 0.45 }}>
              <input
                type="radio"
                name="tdFlowSource"
                value="last-passed"
                checked={tdFlowSource === 'last-passed'}
                onChange={() => setTdFlowSource('last-passed')}
                disabled={!hasLastPassedFlow || tdRunning}
              />
              <span>
                Last Passed Workflow
                {hasLastPassedFlow && <span style={{ color: '#16a34a', marginLeft: 6, fontSize: '0.8rem' }}>(passed)</span>}
                {lastPassedRun?.flowState?.templateName && <span className="tw-resume-meta" style={{ marginLeft: 6 }}>Template: {lastPassedRun.flowState.templateName}</span>}
                {lastPassedRun?.flowState?.appName && <span className="tw-resume-meta" style={{ marginLeft: 6 }}>App: {lastPassedRun.flowState.appName}</span>}
                {!hasLastPassedFlow && <span style={{ color: '#94a3b8', marginLeft: 6 }}>(none saved)</span>}
              </span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="tdFlowSource"
                value="manual-existing"
                checked={tdFlowSource === 'manual-existing'}
                onChange={() => setTdFlowSource('manual-existing')}
                disabled={tdRunning}
              />
              <span>
                Use Existing App + Template (manual)
                {hasManualFlow && <span style={{ color: '#16a34a', marginLeft: 6, fontSize: '0.8rem' }}>(ready)</span>}
              </span>
            </label>
          </div>
        </div>

        {tdFlowSource === 'manual-existing' && (
          <div className="tw-flow-panel" style={{ marginBottom: '1rem' }}>
            <div className="tw-flow-panel-title">Select existing design details</div>
            {tdOptionsLoading && (
              <div style={{ marginBottom: 10, color: '#475569', fontSize: '0.85rem' }}>Loading App and Template options...</div>
            )}
            {tdOptionsError && (
              <div style={{ marginBottom: 10, color: '#dc2626', fontSize: '0.85rem' }}>{tdOptionsError}</div>
            )}
            {!tdOptionsLoading && effectiveDesignApps.length === 0 && (
              <div style={{ marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={retryLoadTemplateDesignOptions}
                  disabled={tdRunning}
                >
                  Retry loading options
                </button>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '0.6rem' }}>
              <label style={{ fontSize: '0.88rem' }}>
                Site Name (optional)
                <input
                  type="text"
                  value={tdManualFlow.siteName}
                  onChange={(e) => setTdManualFlow((prev) => ({ ...prev, siteName: e.target.value }))}
                  disabled={tdRunning}
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder="Existing site name"
                />
              </label>
              <label style={{ fontSize: '0.88rem' }}>
                App *
                <select
                  value={tdManualFlow.appId}
                  onChange={(e) => selectManualApp(e.target.value)}
                  disabled={tdRunning || tdOptionsLoading || effectiveDesignApps.length === 0}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  <option value="">Select app</option>
                  {effectiveDesignApps.map((app) => (
                    <option key={app.appId} value={app.appId}>{app.appName}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.88rem' }}>
                Template *
                <select
                  value={tdManualFlow.templateValue}
                  onChange={(e) => selectManualTemplate(e.target.value)}
                  disabled={tdRunning || !selectedManualApp}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  <option value="">Select template</option>
                  {(selectedManualApp?.templates || []).map((tpl) => (
                    <option key={tpl.value} value={tpl.value}>{tpl.label}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.88rem' }}>
                Sub-Template (optional)
                <select
                  value={tdManualFlow.subTemplateValue}
                  onChange={(e) => selectManualSubTemplate(e.target.value)}
                  disabled={tdRunning || !selectedManualTemplate || manualSubTemplates.length === 0}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  <option value="">Use parent template / All</option>
                  {manualSubTemplates.map((sub) => (
                    <option key={sub.value} value={sub.value}>{sub.label}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.88rem' }}>
                Workflow Name (optional)
                <input
                  type="text"
                  value={tdManualFlow.workflowName}
                  onChange={(e) => setTdManualFlow((prev) => ({ ...prev, workflowName: e.target.value }))}
                  disabled={tdRunning}
                  style={{ width: '100%', marginTop: 4 }}
                  placeholder="Existing workflow name"
                />
              </label>
            </div>
            <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#475569' }}>
              Required: App and Template. Sub-Template is optional.
            </div>
          </div>
        )}

        {/* Selected flow data preview */}
        {canRunDesign && (
          <div className="tw-flow-panel" style={{ marginBottom: '1rem' }}>
            <div className="tw-flow-panel-title">Will use this data for Template Design:</div>
            {activeFlowState.siteName        && <div className="tw-flow-line">Site: <strong>{activeFlowState.siteName}</strong></div>}
            {activeFlowState.appName         && <div className="tw-flow-line">App: <strong>{activeFlowState.appName}</strong></div>}
            {activeFlowState.templateName    && <div className="tw-flow-line">Template: <strong>{activeFlowState.templateName}</strong></div>}
            {activeFlowState.subTemplateName && <div className="tw-flow-line">Sub-Template: <strong>{activeFlowState.subTemplateName}</strong></div>}
            {activeFlowState.workflowName    && <div className="tw-flow-line">Workflow: <strong>{activeFlowState.workflowName}</strong></div>}
          </div>
        )}

        {!canRunDesign && (
          <div style={{ padding: '0.6rem 1rem', background: '#fef9c3', borderRadius: 6, color: '#854d0e', marginBottom: '1rem', fontSize: '0.88rem' }}>
            Run a Template Workflow first, use last passed data, or enter existing App + Template manually.
          </div>
        )}

        <button
          type="button"
          className="btn-primary tw-btn-run"
          style={{ background: '#6366f1' }}
          onClick={runDesign}
          disabled={tdRunning || running || !canRunDesign}
        >
          {tdRunning ? '⏳ Running Template Design...' : '▶ Run Template Design Automation'}
        </button>

        {/* Template Design Error */}
        {tdError && (
          <div className="status-error" style={{ marginTop: '0.75rem' }}>
            {tdError}
          </div>
        )}

        {/* Template Design Steps */}
        {tdSteps && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.95rem' }}>Automation Steps:</div>
            <ul className="tw-step-list">
              {TD_STEP_ORDER.map(key => (
                <TdStepRow key={key} stepKey={key} stepData={tdSteps[key]} />
              ))}
            </ul>
          </div>
        )}

        {/* Template Design Result */}
        {tdResult && (
          <div style={{ marginTop: '1rem' }}>
            <div className={`result-badge ${tdOverall === 'completed' ? 'badge-pass' : tdOverall === 'completed-with-issues' ? '' : 'badge-fail'}`}
              style={tdOverall === 'completed-with-issues' ? { background: '#fef3c7', color: '#92400e' } : {}}>
              {tdOverall === 'completed' ? '✅ ALL PASSED'
                : tdOverall === 'completed-with-issues' ? '⚠️ COMPLETED WITH ISSUES'
                : '❌ FAILED'}
            </div>
            <p className="tw-result-message" style={{ marginTop: '0.5rem' }}>{tdResult.message}</p>

            {/* Summary */}
            {tdSummary && (
              <div className="tw-flow-panel" style={{ marginTop: '0.75rem' }}>
                <div className="tw-flow-panel-title">Controls Summary</div>
                <div className="tw-flow-line">Total Controls Tested: <strong>{tdSummary.totalControls}</strong></div>
                <div className="tw-flow-line" style={{ color: '#16a34a' }}>Passed: <strong>{tdSummary.passed}</strong></div>
                {tdSummary.failed > 0 && <div className="tw-flow-line" style={{ color: '#dc2626' }}>Failed: <strong>{tdSummary.failed}</strong></div>}
                {tdSummary.skipped > 0 && <div className="tw-flow-line" style={{ color: '#ca8a04' }}>Skipped: <strong>{tdSummary.skipped}</strong></div>}
              </div>
            )}

            {/* Control test results toggle */}
            {tdCtrlResults.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setTdShowControls(v => !v)}
                >
                  {tdShowControls ? 'Hide' : 'Show'} Control Results ({tdCtrlResults.length})
                </button>
                {tdShowControls && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9' }}>
                        <th style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e2e8f0' }}>#</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e2e8f0' }}>Type</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e2e8f0' }}>Label</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e2e8f0' }}>Status</th>
                        <th style={{ padding: '4px 8px', textAlign: 'left', border: '1px solid #e2e8f0' }}>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tdCtrlResults.map((r, i) => (
                        <tr key={i} style={{ background: r.status === 'failed' ? '#fef2f2' : r.status === 'passed' ? '#f0fdf4' : '#fafafa' }}>
                          <td style={{ padding: '3px 8px', border: '1px solid #e2e8f0' }}>{i + 1}</td>
                          <td style={{ padding: '3px 8px', border: '1px solid #e2e8f0' }}>{r.type}</td>
                          <td style={{ padding: '3px 8px', border: '1px solid #e2e8f0', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</td>
                          <td style={{ padding: '3px 8px', border: '1px solid #e2e8f0', color: r.status === 'passed' ? '#16a34a' : r.status === 'failed' ? '#dc2626' : '#64748b' }}>
                            {STATUS_ICON[r.status] || '○'} {r.status}
                          </td>
                          <td style={{ padding: '3px 8px', border: '1px solid #e2e8f0', color: '#475569', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Logs */}
            {(tdResult?.jsonResult?._debug || tdResult?._debug) && (
              <div style={{ marginTop: '0.75rem' }}>
                <button type="button" className="btn-ghost-sm" onClick={() => setTdShowLogs(v => !v)}>
                  {tdShowLogs ? 'Hide' : 'Show'} Logs
                </button>
                {tdShowLogs && (
                  <pre className="log-output" style={{ marginTop: '0.5rem' }}>
                    {tdResult?.jsonResult?._debug || tdResult?._debug}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </article>
    </section>
  );
}
