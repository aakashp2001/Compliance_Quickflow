import { useState, useEffect } from 'react';
import {
  fetchMasters,
  getDependencyConfig,
  getMasterFields,
  getMasters,
  runCrudOperation,
  saveDependencyConfig,
  validateMandatoryFields,
} from './api/client';

function CrudPage({ masters: propMasters = [] }) {
  const [config, setConfig] = useState({
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'dhruvi',
    password: '',
    showBrowser: true,
    verifyAuditTrail: false,
    runMandatoryAfterCrud: false,
    runDuplicateAfterCrud: false,
  });

  const [masters, setMasters] = useState(propMasters);
  const [selectedMaster, setSelectedMaster] = useState('');
  const [loadingMasters, setLoadingMasters] = useState(false);

  // Use shared masters from props, or allow manual fetch
  useEffect(() => {
    if (propMasters && propMasters.length > 0) {
      setMasters(propMasters);
    }
  }, [propMasters]);

  const [masterFields, setMasterFields] = useState([]);
  const [loadingFieldOptions, setLoadingFieldOptions] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState({
    parentDropdowns: [],
    dependentDropdowns: [],
  });
  const [dependencySaving, setDependencySaving] = useState(false);
  const [dependencyMessage, setDependencyMessage] = useState('');
  const [dependencyError, setDependencyError] = useState('');
  const [dependencyConfigMap, setDependencyConfigMap] = useState({});
  const [loadingDependencyTable, setLoadingDependencyTable] = useState(false);

  const [operation, setOperation] = useState('create');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [resultsSaving, setResultsSaving] = useState(false);
  const [error, setError] = useState('');

  function buildOperationStatuses(data, requestedOperation, verifyAuditTrail) {
    const requested = String(requestedOperation || '').toLowerCase();
    const targetOps = requested === 'all' ? ['create', 'update', 'delete'] : [requested];
    const failures = Array.isArray(data?.failures) ? data.failures : [];
    const auditMismatches = Array.isArray(data?.auditMismatches) ? data.auditMismatches : [];

    return targetOps.map((op) => {
      const hasCrudFailure = failures.some((f) => String(f?.operation || '').toLowerCase() === op);
      const hasAuditFailure = auditMismatches.some((m) => String(m?.operation || '').toLowerCase() === op);
      const skipped = Array.isArray(data?.operations)
        && data.operations.some((o) => String(o?.operation || '').toLowerCase() === op && o?.skipped === true);

      // Determine per-operation audit result from auditVerification field.
      const opData = Array.isArray(data?.operations)
        ? data.operations.find((o) => String(o?.operation || '').toLowerCase() === op)
        : null;
      const av = opData?.auditVerification;
      const auditRan = verifyAuditTrail && !!av;
      const auditPassed = auditRan
        && av.verified !== false
        && (!av.comparison || av.comparison.passed !== false);

      return {
        operation: op,
        status: hasCrudFailure || hasAuditFailure ? 'fail' : skipped ? 'skip' : 'pass',
        auditFailed: auditRan ? !auditPassed : hasAuditFailure,
        auditRan,
        auditPassed,
        skipped,
      };
    });
  }

  async function runPostCrudChecks(masterName, crudData) {
    const checks = [];

    // Extract audit trail from the create operation in CRUD result (if any)
    const createOp = Array.isArray(crudData?.operations)
      ? crudData.operations.find((op) => String(op.operation || '').toLowerCase() === 'create' && !op.skipped)
      : null;
    const createdAuditTrail = createOp?.auditTrail && typeof createOp.auditTrail === 'object'
      && Object.keys(createOp.auditTrail).length > 0
      ? createOp.auditTrail
      : null;

    if (config.runMandatoryAfterCrud) {
      try {
        const mandatory = await validateMandatoryFields(masterName, {
          loginUrl: config.loginUrl,
          username: config.username,
          password: config.password,
          showBrowser: config.showBrowser,
        });

        const validationWorking = mandatory?.validationWorking === true;
        checks.push({
          operation: 'mandatory-check',
          status: validationWorking ? 'pass' : 'fail',
          message: validationWorking
            ? 'Mandatory validation detected required field checks'
            : 'Mandatory validation signals were not detected',
        });
      } catch (err) {
        checks.push({
          operation: 'mandatory-check',
          status: 'fail',
          message: err?.message || 'Mandatory check failed',
        });
      }
    }

    if (config.runDuplicateAfterCrud) {
      try {
        const duplicate = await runCrudOperation(masterName, {
          operation: 'duplicate-check',
          loginUrl: config.loginUrl,
          username: config.username,
          password: config.password,
          showBrowser: config.showBrowser,
          // Pass the just-created field values so the duplicate attempt reuses them exactly
          prefilledValues: createdAuditTrail || undefined,
        });

        const duplicateBlocked = Array.isArray(duplicate?.operations)
          && duplicate.operations.some((op) => op.operation === 'duplicate-check' && op.duplicateBlocked === true);

        checks.push({
          operation: 'duplicate-check',
          status: duplicateBlocked ? 'pass' : 'fail',
          message: duplicateBlocked
            ? 'Duplicate entry was blocked successfully'
            : 'Duplicate entry appears to be allowed',
        });
      } catch (err) {
        checks.push({
          operation: 'duplicate-check',
          status: 'fail',
          message: err?.message || 'Duplicate check failed',
        });
      }
    }

    return checks;
  }

  const selectLikeFieldNames = masterFields
    .filter((field) => {
      const elementType = String(field?.elementType || '').toLowerCase().replace(/[^a-z]/g, '');
      return elementType.includes('select');
    })
    .map((field) => field.displayName)
    .filter(Boolean);

  const dependencyRows = masters
    .map((master) => {
      const key = Object.keys(dependencyConfigMap).find(
        (name) => String(name).trim().toLowerCase() === String(master.name).trim().toLowerCase()
      );
      const entry = key ? dependencyConfigMap[key] : null;
      return {
        masterName: master.name,
        displayName: master.displayName,
        parentDropdowns: Array.isArray(entry?.parentDropdowns) ? entry.parentDropdowns : [],
        dependentDropdowns: Array.isArray(entry?.dependentDropdowns) ? entry.dependentDropdowns : [],
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  async function loadDependencyConfigTable() {
    setLoadingDependencyTable(true);
    try {
      const data = await getDependencyConfig();
      setDependencyConfigMap(data?.config && typeof data.config === 'object' ? data.config : {});
    } catch {
      setDependencyConfigMap({});
    } finally {
      setLoadingDependencyTable(false);
    }
  }

  async function loadDependencyEditorData(masterName, requestConfig = config) {
    if (!masterName) {
      setMasterFields([]);
      setDependencyDraft({ parentDropdowns: [], dependentDropdowns: [] });
      return;
    }

    setLoadingFieldOptions(true);
    setDependencyError('');
    setDependencyMessage('');

    try {
      const [fieldData, configData] = await Promise.all([
        getMasterFields(masterName, {
          loginUrl: requestConfig.loginUrl,
          username: requestConfig.username,
          password: requestConfig.password,
          showBrowser: requestConfig.showBrowser,
        }),
        getDependencyConfig(masterName),
      ]);

      const nextFields = Array.isArray(fieldData?.fields) ? fieldData.fields : [];
      const nextConfig = configData?.config || {};
      const detected = fieldData?.detectedDependencies || null;

      // If saved config is empty but auto-detection found dependencies, use detected values
      // and reload the dependency table since backend already saved them
      const savedParents = Array.isArray(nextConfig.parentDropdowns) ? nextConfig.parentDropdowns : [];
      const savedDependents = Array.isArray(nextConfig.dependentDropdowns) ? nextConfig.dependentDropdowns : [];
      const hasExistingSaved = savedParents.length > 0 || savedDependents.length > 0;

      const finalParents = hasExistingSaved
        ? savedParents
        : (Array.isArray(detected?.parentDropdowns) ? detected.parentDropdowns : []);
      const finalDependents = hasExistingSaved
        ? savedDependents
        : (Array.isArray(detected?.dependentDropdowns) ? detected.dependentDropdowns : []);

      setMasterFields(nextFields);
      setDependencyDraft({
        parentDropdowns: finalParents,
        dependentDropdowns: finalDependents,
      });

      // Reload dependency table if auto-detection populated new entries
      if (!hasExistingSaved && (finalParents.length > 0 || finalDependents.length > 0)) {
        await loadDependencyConfigTable();
        if (finalParents.length > 0 || finalDependents.length > 0) {
          setDependencyMessage(`Auto-detected: ${finalParents.length} parent(s), ${finalDependents.length} dependent(s). Review and save if correct.`);
        }
      }
    } catch (err) {
      setMasterFields([]);
      setDependencyDraft({ parentDropdowns: [], dependentDropdowns: [] });
      setDependencyError(err.message || 'Failed to load dependency setup data');
    } finally {
      setLoadingFieldOptions(false);
    }
  }

  async function loadMasters() {
    setLoadingMasters(true);
    setError('');

    try {
      let list = [];

      try {
        // Prefer fresh data so dropdowns stay in sync with QuickFlow.
        const fetched = await fetchMasters({
          loginUrl: config.loginUrl,
          username: config.username,
          password: config.password,
          showBrowser: config.showBrowser,
        });
        list = Array.isArray(fetched) ? fetched : fetched?.masters || [];
      } catch {
        // Fall back to cached masters if live fetch fails.
        const cached = await getMasters();
        list = Array.isArray(cached) ? cached : cached?.masters || [];
      }

      setMasters(list);
      await loadDependencyConfigTable();

      const targetMaster = selectedMaster || (list.length ? list[0].name : '');
      setSelectedMaster(targetMaster);

      if (targetMaster) {
        await loadDependencyEditorData(targetMaster);
      } else {
        setMasterFields([]);
        setDependencyDraft({ parentDropdowns: [], dependentDropdowns: [] });
      }
    } catch (err) {
      setError(err.message || 'Failed to load masters');
    } finally {
      setLoadingMasters(false);
    }
  }

  function handleDependencySelectChange(key, event) {
    const values = Array.from(event.target.selectedOptions || []).map((option) => option.value);
    setDependencyDraft((prev) => ({ ...prev, [key]: values }));
  }

  async function handleSaveDependencyConfig() {
    if (!selectedMaster) return;

    setDependencySaving(true);
    setDependencyError('');
    setDependencyMessage('');

    try {
      await saveDependencyConfig(selectedMaster, {
        parentDropdowns: dependencyDraft.parentDropdowns,
        dependentDropdowns: dependencyDraft.dependentDropdowns,
      });
      await loadDependencyConfigTable();
      setDependencyMessage('Dependency configuration saved successfully. CRUD will use this mapping.');
    } catch (err) {
      setDependencyError(err.message || 'Failed to save dependency configuration');
    } finally {
      setDependencySaving(false);
    }
  }

  async function persistResults(updatedResults) {
    try {
      localStorage.setItem('crudResults', JSON.stringify({
        results: updatedResults,
        savedAt: new Date().toISOString(),
      }));
      await fetch('/api/save-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: updatedResults }),
      }).catch(() => { });
    } catch {
      // silent – auto-save is best-effort
    }
  }

  async function handleRun() {
    if (!selectedMaster) return;

    setRunning(true);
    setError('');

    const runningEntry = {
      id: Date.now(),
      status: 'running',
      master: selectedMaster,
      operation,
      verifyAuditTrail: config.verifyAuditTrail,
      startedAt: new Date().toLocaleTimeString(),
    };
    setResults((prev) => [runningEntry, ...prev]);

    try {
      const data = await runCrudOperation(selectedMaster, {
        operation,
        loginUrl: config.loginUrl,
        username: config.username,
        password: config.password,
        showBrowser: config.showBrowser,
        verifyAuditTrail: config.verifyAuditTrail,
      });

      const crudOperationStatuses = buildOperationStatuses(data, operation, config.verifyAuditTrail);
      const postCheckStatuses = await runPostCrudChecks(selectedMaster, data);
      const operationStatuses = [...crudOperationStatuses, ...postCheckStatuses];

      const hasAnyFailure = operationStatuses.some((op) => op.status === 'fail') || data?.failed;
      const allCrudSkipped = crudOperationStatuses.length > 0 && crudOperationStatuses.every((op) => op.skipped);
      const overallStatus = hasAnyFailure
        ? 'fail'
        : allCrudSkipped && postCheckStatuses.length === 0
          ? 'skip'
          : 'pass';

      const finishedEntry = {
        ...runningEntry,
        status: overallStatus,
        overallStatus,
        operationStatuses,
        finishedAt: new Date().toLocaleTimeString(),
      };

      setResults((prev) => {
        const updated = prev.map((entry) =>
          entry.id === runningEntry.id ? finishedEntry : entry
        );
        persistResults(updated);
        return updated;
      });
    } catch (err) {
      const failedEntry = {
        ...runningEntry,
        status: 'fail',
        overallStatus: 'fail',
        operationStatuses: [{ operation, status: 'fail' }],
        error: err.message,
        finishedAt: new Date().toLocaleTimeString(),
      };

      setResults((prev) => {
        const updated = prev.map((entry) =>
          entry.id === runningEntry.id ? failedEntry : entry
        );
        persistResults(updated);
        return updated;
      });
      setError(err.message || 'CRUD operation failed');
    } finally {
      setRunning(false);
    }
  }

  async function handleSaveResults() {
    if (!results.length) {
      alert('No results to save.');
      return;
    }

    setResultsSaving(true);
    try {
      await persistResults(results);
      alert('Results saved successfully!');
    } catch (err) {
      alert(`Error saving results: ${err.message}`);
    } finally {
      setResultsSaving(false);
    }
  }

  // Restore saved results from backend (fallback to localStorage) on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/saved-results');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.results) && data.results.length > 0) {
            setResults(data.results);
            return;
          }
        }
      } catch { /* ignore */ }
      // Fallback to localStorage
      try {
        const stored = localStorage.getItem('crudResults');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed?.results) && parsed.results.length > 0) {
            setResults(parsed.results);
          }
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Ensure dependency field options are loaded whenever a valid master is selected.
  useEffect(() => {
    if (!selectedMaster) return;
    loadDependencyEditorData(selectedMaster);
  }, [selectedMaster]);

  // Auto-save is now done inside handleRun via persistResults(), so no beforeunload warning needed.

  const thStyle = { padding: '8px 12px', borderBottom: '2px solid #dee2e6', fontWeight: 700, whiteSpace: 'nowrap' };
  const tdStyle = { padding: '8px 12px', verticalAlign: 'top' };

  return (
    <div className="crud-page">
      <h1>CRUD Operations</h1>

      <section className="grid">
        <article className="card card-wide">
          <h2>Configuration</h2>
          <div className="form crud-form">
            <div className="form-row">
              <label>
                Login URL
                <input
                  value={config.loginUrl}
                  onChange={(e) => setConfig((prev) => ({ ...prev, loginUrl: e.target.value }))}
                />
              </label>
              <label>
                Username
                <input
                  value={config.username}
                  onChange={(e) => setConfig((prev) => ({ ...prev, username: e.target.value }))}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={config.password}
                  onChange={(e) => setConfig((prev) => ({ ...prev, password: e.target.value }))}
                />
              </label>
            </div>

            <div className="form-row">
              <label>
                Master
                <div className="input-group">
                  <select
                    value={selectedMaster}
                    onChange={(e) => {
                      const nextMaster = e.target.value;
                      setSelectedMaster(nextMaster);
                      loadDependencyEditorData(nextMaster);
                    }}
                    disabled={!masters.length}
                  >
                    {!masters.length ? (
                      <option value="">Load masters first</option>
                    ) : (
                      masters.map((master) => (
                        <option key={master.name} value={master.name}>
                          {master.displayName} ({master.name})
                        </option>
                      ))
                    )}
                  </select>
                  <button type="button" onClick={loadMasters} disabled={loadingMasters} className="btn-sm">
                    {loadingMasters ? '...' : 'Load'}
                  </button>
                </div>
              </label>

              <label>
                Operation
                <select value={operation} onChange={(e) => setOperation(e.target.value)}>
                  <option value="create">Create</option>
                  <option value="update">Update</option>
                  <option value="delete">Delete</option>
                  <option value="all">All (Create to Update to Delete)</option>
                </select>
              </label>
            </div>

            <div className="form-row dependency-row">
              <label>
                Parent Dropdown Fields
                <select
                  multiple
                  className="multi-select"
                  value={dependencyDraft.parentDropdowns}
                  onChange={(e) => handleDependencySelectChange('parentDropdowns', e)}
                  disabled={!selectedMaster || loadingFieldOptions || !selectLikeFieldNames.length}
                >
                  {selectLikeFieldNames.map((fieldName) => (
                    <option key={`parent-${fieldName}`} value={fieldName}>{fieldName}</option>
                  ))}
                </select>
              </label>

              <label>
                Dependent Dropdown Fields
                <select
                  multiple
                  className="multi-select"
                  value={dependencyDraft.dependentDropdowns}
                  onChange={(e) => handleDependencySelectChange('dependentDropdowns', e)}
                  disabled={!selectedMaster || loadingFieldOptions || !selectLikeFieldNames.length}
                >
                  {selectLikeFieldNames.map((fieldName) => (
                    <option key={`dependent-${fieldName}`} value={fieldName}>{fieldName}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-row dependency-actions">
              <button
                type="button"
                className="btn-sm"
                onClick={handleSaveDependencyConfig}
                disabled={!selectedMaster || dependencySaving || loadingFieldOptions}
              >
                {dependencySaving ? 'Saving...' : 'Save Dependency Mapping'}
              </button>
              <span className="muted">Use Ctrl/Cmd for multi-select.</span>
            </div>

            <div className="form-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.showBrowser}
                  onChange={(e) => setConfig((prev) => ({ ...prev, showBrowser: e.target.checked }))}
                />
                Show browser
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.verifyAuditTrail}
                  onChange={(e) => setConfig((prev) => ({ ...prev, verifyAuditTrail: e.target.checked }))}
                />
                Verify Audit Trail
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.runMandatoryAfterCrud}
                  onChange={(e) => setConfig((prev) => ({ ...prev, runMandatoryAfterCrud: e.target.checked }))}
                />
                Mandatory Field Check After CRUD
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.runDuplicateAfterCrud}
                  onChange={(e) => setConfig((prev) => ({ ...prev, runDuplicateAfterCrud: e.target.checked }))}
                />
                Duplicate Check After CRUD
              </label>

              <button
                type="button"
                className="btn-run"
                onClick={handleRun}
                disabled={running || !selectedMaster}
              >
                {running ? `Running ${operation}...` : `Run ${operation.charAt(0).toUpperCase() + operation.slice(1)}`}
              </button>
            </div>

            {dependencyMessage && <p className="status-ok">{dependencyMessage}</p>}
            {dependencyError && <p className="status-error">{dependencyError}</p>}
            {error && <p className="status-error">{error}</p>}
          </div>
        </article>

        <article className="card card-wide">
          <div className="dependency-table-header">
            <h2>Saved Dependency Mapping</h2>
            <button
              type="button"
              className="btn-sm"
              onClick={loadDependencyConfigTable}
              disabled={loadingDependencyTable}
            >
              {loadingDependencyTable ? 'Refreshing...' : 'Refresh Mapping'}
            </button>
          </div>

          {!masters.length ? (
            <p className="muted">Load masters to view mapping table.</p>
          ) : (
            <div className="dependency-table-wrap">
              <table className="dependency-table">
                <thead>
                  <tr>
                    <th>Master</th>
                    <th>Parent Dropdowns</th>
                    <th>Dependent Dropdowns</th>
                  </tr>
                </thead>
                <tbody>
                  {dependencyRows.map((row) => (
                    <tr key={row.masterName} className={row.masterName === selectedMaster ? 'active' : ''}>
                      <td>
                        <strong>{row.displayName}</strong>
                        <div className="muted">{row.masterName}</div>
                      </td>
                      <td>
                        {row.parentDropdowns.length
                          ? row.parentDropdowns.join(', ')
                          : <span className="muted">None</span>}
                      </td>
                      <td>
                        {row.dependentDropdowns.length
                          ? row.dependentDropdowns.join(', ')
                          : <span className="muted">None</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="card card-wide">
          <h2>
            Results
            {results.length > 0 && (
              <button
                type="button"
                className="btn-sm"
                onClick={handleSaveResults}
                disabled={resultsSaving || running}
                style={{ marginLeft: '1rem' }}
              >
                {resultsSaving ? 'Saving...' : 'Save Results'}
              </button>
            )}
          </h2>
          {!results.length ? (
            <p className="muted">No operations run yet. Select a master and click Run.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: '#f0f2f5', textAlign: 'left' }}>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Master</th>
                    <th style={thStyle}>Operation</th>
                    <th style={thStyle}>Audit Trail</th>
                    <th style={thStyle}>Started</th>
                    <th style={thStyle}>Finished</th>
                    <th style={thStyle}>Sub-operations</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((entry) => {
                    const st = String(entry.overallStatus || entry.status || '').toLowerCase();
                    const rowBg = st === 'pass' ? '#f0fff4' : st === 'fail' ? '#fff0f0' : st === 'running' ? '#fffbea' : '#f8f9fa';
                    const badgeBg = st === 'pass' ? '#28a745' : st === 'fail' ? '#dc3545' : st === 'running' ? '#fd7e14' : '#6c757d';

                    const postCheckOps = ['mandatory-check', 'duplicate-check'];
                    const crudStatuses = (entry.operationStatuses || []).filter((op) => !postCheckOps.includes(String(op.operation || '').toLowerCase()));
                    const postStatuses = (entry.operationStatuses || []).filter((op) => postCheckOps.includes(String(op.operation || '').toLowerCase()));
                    const allSubOps = [...crudStatuses, ...postStatuses];

                    const auditEnabled = entry.verifyAuditTrail === true;
                    const auditOps = (entry.operationStatuses || []).filter((op) => op.auditRan);
                    const auditFailed = auditEnabled && ((entry.operationStatuses || []).some((op) => op.auditFailed === true));
                    const auditText = !auditEnabled
                      ? '—'
                      : auditOps.length === 0
                        ? '⏳ Pending'
                        : auditFailed ? '❌ Fail' : '✅ Pass';

                    return (
                      <tr key={entry.id} style={{ background: rowBg, borderBottom: '1px solid #dee2e6' }}>
                        <td style={tdStyle}>
                          <span style={{ background: badgeBg, color: '#fff', borderRadius: '10px', padding: '2px 8px', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                            {st === 'running' ? '⏳ RUNNING' : st === 'pass' ? '✅ PASS' : st === 'fail' ? '❌ FAIL' : st.toUpperCase()}
                          </span>
                        </td>
                        <td style={tdStyle}><strong>{entry.master}</strong></td>
                        <td style={tdStyle}>{entry.operation}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{auditText}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: '#555' }}>{entry.startedAt || '—'}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: '#555' }}>{entry.finishedAt || (st === 'running' ? '...' : '—')}</td>
                        <td style={tdStyle}>
                          {allSubOps.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {allSubOps.map((op, i) => {
                                const opSt = String(op.status || '').toLowerCase();
                                const bg = opSt === 'pass' ? '#d4edda' : opSt === 'fail' ? '#f8d7da' : opSt === 'skip' ? '#e9ecef' : '#fff3cd';
                                const col = opSt === 'pass' ? '#155724' : opSt === 'fail' ? '#721c24' : opSt === 'skip' ? '#495057' : '#856404';
                                const label = op.skipped ? 'SKIP' : op.auditFailed ? 'AUDIT FAIL' : opSt.toUpperCase();
                                return (
                                  <span key={i} title={op.message || ''} style={{ background: bg, color: col, borderRadius: '8px', padding: '1px 7px', fontSize: '0.73rem', fontWeight: 600, border: `1px solid ${col}33` }}>
                                    {op.operation}: {label}
                                  </span>
                                );
                              })}
                            </div>
                          ) : entry.error ? (
                            <span style={{ color: '#dc3545', fontSize: '0.78rem' }}>{entry.error.slice(0, 120)}</span>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default CrudPage;
