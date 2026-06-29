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
import MultiSelect from './components/MultiSelect';

function getMasterName(master) {
  if (typeof master === 'string') return master.trim();
  if (!master || typeof master !== 'object') return '';
  return String(master.name || master.masterName || master.value || master.id || '').trim();
}

function getMasterDisplayName(master) {
  if (typeof master === 'string') return master.trim();
  if (!master || typeof master !== 'object') return '';
  const name = getMasterName(master);
  return String(master.displayName || master.display || master.label || name).trim();
}

function normalizeMasters(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((master) => {
      const name = getMasterName(master);
      const displayName = getMasterDisplayName(master);
      if (!name) return null;
      return {
        ...((master && typeof master === 'object') ? master : {}),
        name,
        displayName: displayName || name,
      };
    })
    .filter((master) => {
      if (!master || !master.name) return false;
      const key = master.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getAuditRowsFromVerification(auditVerification) {
  if (!auditVerification || typeof auditVerification !== 'object') return [];
  // Primary source: verifyAuditTrailEntry() normalized payload.
  // Fallbacks support previously saved result shapes.
  const rows = [
    asArray(auditVerification.fieldValidationResults),
    asArray(auditVerification.fieldByFieldResults?.results),
    asArray(auditVerification.comparison?.fieldValidationResults),
  ].find((sourceRows) => sourceRows.length > 0) || [];

  if (rows.length > 0) {
    const seen = new Set();
    return rows.filter((row) => {
      const key = [
        row?.fieldName,
        row?.expected,
        row?.actual,
        row?.status,
      ].map((part) => String(part ?? '')).join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return [
    ...asArray(auditVerification.comparison?.mismatches).map((item) => ({
      fieldName: item.field,
      expected: item.expected,
      actual: item.actual,
      status: 'MISMATCH',
      error: item.error || '',
    })),
    ...asArray(auditVerification.comparison?.notFoundInAudit).map((item) => ({
      fieldName: item.field,
      expected: item.expected,
      actual: null,
      status: 'NOT_FOUND',
      error: 'Field not found in audit trail',
    })),
  ];
}

function getAuditSummary(auditVerification, rows) {
  const fieldValidationSummary = auditVerification?.fieldValidationSummary;
  if (fieldValidationSummary && typeof fieldValidationSummary === 'object') {
    return {
      passed: Number(fieldValidationSummary.passed ?? fieldValidationSummary.passedFields?.length ?? 0),
      total: Number(fieldValidationSummary.total ?? rows.length ?? 0),
    };
  }

  const summary = auditVerification?.fieldByFieldResults?.summary;
  if (summary && typeof summary === 'object') {
    return {
      passed: Number(summary.passed || 0),
      total: Number(summary.total || rows.length || 0),
    };
  }

  const comparison = auditVerification?.comparison;
  if (comparison && typeof comparison === 'object') {
    return {
      passed: Number(comparison.matchCount || 0),
      total: Number(comparison.totalChecked || rows.length || 0),
    };
  }

  return {
    passed: rows.filter((row) => String(row?.status || '').toUpperCase() === 'PASS').length,
    total: rows.length,
  };
}

function getAuditComparisonDetails(entry) {
  const details = [];

  for (const rawOp of asArray(entry?.rawOperations)) {
    const auditVerification = rawOp?.auditVerification;
    const fields = getAuditRowsFromVerification(auditVerification);
    if (fields.length > 0) {
      details.push({
        operation: rawOp.operation,
        fields,
        summary: getAuditSummary(auditVerification, fields),
      });
    }
  }

  const operationsWithRows = new Set(details.map((detail) => String(detail.operation || '').toLowerCase()));
  for (const mismatch of asArray(entry?.auditMismatches)) {
    const opName = String(mismatch?.operation || '').toLowerCase();
    if (operationsWithRows.has(opName)) continue;

    const fields = [
      ...asArray(mismatch?.fieldValidationResults),
      ...asArray(mismatch?.mismatches).map((item) => ({
        fieldName: item.field,
        expected: item.expected,
        actual: item.actual,
        status: 'MISMATCH',
        error: item.error || '',
      })),
      ...asArray(mismatch?.notFoundInAudit).map((item) => ({
        fieldName: item.field,
        expected: item.expected,
        actual: null,
        status: 'NOT_FOUND',
        error: 'Field not found in audit trail',
      })),
    ];

    if (fields.length > 0) {
      details.push({
        operation: mismatch.operation,
        fields,
        summary: {
          passed: Number(mismatch.matchCount || 0),
          total: fields.length || Number(mismatch.matchCount || 0) + Number(mismatch.mismatchCount || 0),
        },
      });
    }
  }

  return details;
}

function getAuditStatusMessage(entry, auditEnabled) {
  if (!auditEnabled) return '-';
  const reasons = [
    ...asArray(entry?.rawOperations).map((op) => op?.auditVerification?.reason),
    ...asArray(entry?.auditMismatches).map((item) => item?.reason),
    entry?.error,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return reasons[0] || 'No comparison data returned';
}

function displayAuditValue(value) {
  const text = String(value ?? '').trim();
  return text || '-';
}

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
  const [selectedMasters, setSelectedMasters] = useState([]);
  const [loadingMasters, setLoadingMasters] = useState(false);

  // Use shared masters from props, or allow manual fetch
  useEffect(() => {
    if (propMasters && propMasters.length > 0) {
      const normalized = normalizeMasters(propMasters);
      setMasters(normalized);
      if (!selectedMaster && normalized.length > 0) {
        setSelectedMaster(normalized[0].name);
      }
      setSelectedMasters((prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        if (prevList.length > 0) return prevList;
        return normalized.length > 0 ? [normalized[0].name] : [];
      });
    }
  }, [propMasters, selectedMaster]);

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
  const [targetRecordName, setTargetRecordName] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [resultsSaving, setResultsSaving] = useState(false);
  const [error, setError] = useState('');

  function isAuditVerificationPassed(auditVerification) {
    return !!auditVerification
      && auditVerification.verified === true
      && (!auditVerification.comparison || auditVerification.comparison.passed !== false);
  }

  function buildOperationStatuses(data, requestedOperation, verifyAuditTrail) {
    const requested = String(requestedOperation || '').toLowerCase();
    const targetOps = requested === 'all' ? ['create', 'update', 'delete'] : [requested];
    const failures = Array.isArray(data?.failures) ? data.failures : [];
    const auditMismatches = Array.isArray(data?.auditMismatches) ? data.auditMismatches : [];
    const auditEnabled = verifyAuditTrail === true;

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
      const serverAuditRequired = opData?.auditRequired === true;
      const serverAuditPassedProvided = typeof opData?.auditPassed === 'boolean';
      const serverAuditPassed = serverAuditPassedProvided ? opData.auditPassed === true : false;
      const auditRan = auditEnabled && !skipped && (serverAuditRequired || !!av || hasAuditFailure);
      const auditPassed = auditRan
        && (serverAuditPassedProvided ? serverAuditPassed : isAuditVerificationPassed(av))
        && !hasAuditFailure;
      const auditMissing = auditEnabled
        && !skipped
        && !hasAuditFailure
        && !hasCrudFailure
        && !serverAuditPassedProvided
        && !av;
      const auditFailed = auditEnabled && !skipped && (hasAuditFailure || !auditPassed || auditMissing);

      return {
        operation: op,
        status: hasCrudFailure || auditFailed ? 'fail' : skipped ? 'skip' : 'pass',
        auditFailed,
        auditRan,
        auditPassed,
        skipped,
        message: auditMissing ? 'Audit verification result missing from CRUD response' : '',
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
          verifyAuditTrail: config.verifyAuditTrail,
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

      const normalizedList = normalizeMasters(list);
      setMasters(normalizedList);
      await loadDependencyConfigTable();

      const targetMaster = selectedMaster || (normalizedList.length ? normalizedList[0].name : '');
      setSelectedMaster(targetMaster);

      const validMasterSet = new Set(normalizedList.map((m) => m.name));
      setSelectedMasters((prev) => {
        const kept = (Array.isArray(prev) ? prev : []).filter((name) => validMasterSet.has(name));
        if (kept.length > 0) return kept;
        return targetMaster ? [targetMaster] : [];
      });

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
    const mastersToRun = selectedMasters.length > 0
      ? selectedMasters
      : (selectedMaster ? [selectedMaster] : []);
    if (!mastersToRun.length) return;

    setRunning(true);
    setError('');
    const failures = [];

    for (let index = 0; index < mastersToRun.length; index += 1) {
      const masterName = mastersToRun[index];
      const runningEntry = {
        id: Date.now() + index,
        status: 'running',
        master: masterName,
        operation,
        verifyAuditTrail: config.verifyAuditTrail,
        startedAt: new Date().toLocaleTimeString(),
      };

      setResults((prev) => [runningEntry, ...prev]);

      try {
        const data = await runCrudOperation(masterName, {
          operation,
          loginUrl: config.loginUrl,
          username: config.username,
          password: config.password,
          showBrowser: config.showBrowser,
          verifyAuditTrail: config.verifyAuditTrail,
          targetRecordName: ['update', 'delete'].includes(operation) ? targetRecordName : undefined,
        });

        const crudOperationStatuses = buildOperationStatuses(data, operation, config.verifyAuditTrail);
        const postCheckStatuses = await runPostCrudChecks(masterName, data);
        const operationStatuses = [...crudOperationStatuses, ...postCheckStatuses];

        const hasAnyFailure = operationStatuses.some((op) => op.status === 'fail') || data?.failed;
        const allCrudSkipped = crudOperationStatuses.length > 0 && crudOperationStatuses.every((op) => op.skipped);
        const overallStatus = hasAnyFailure
          ? 'fail'
          : allCrudSkipped && postCheckStatuses.length === 0
            ? 'skip'
            : 'pass';

        if (overallStatus === 'fail') {
          failures.push(`${masterName}: operation reported failure`);
        }

        const finishedEntry = {
          ...runningEntry,
          status: overallStatus,
          overallStatus,
          operationStatuses,
          rawOperations: Array.isArray(data?.operations) ? data.operations : [],
          auditMismatches: Array.isArray(data?.auditMismatches) ? data.auditMismatches : [],
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

        failures.push(`${masterName}: ${err.message || 'CRUD operation failed'}`);

        setResults((prev) => {
          const updated = prev.map((entry) =>
            entry.id === runningEntry.id ? failedEntry : entry
          );
          persistResults(updated);
          return updated;
        });
      }
    }

    if (failures.length > 0) {
      setError(`Completed with failures for ${failures.length}/${mastersToRun.length} master(s): ${failures.join(' | ')}`);
    } else {
      setError('');
    }

    setRunning(false);
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
                Master (Dependency Setup)
                <div className="input-group">
                  <select
                    value={selectedMaster}
                    onChange={(e) => {
                      const nextMaster = e.target.value;
                      setSelectedMaster(nextMaster);
                      setSelectedMasters((prev) => {
                        if (Array.isArray(prev) && prev.length > 0) return prev;
                        return nextMaster ? [nextMaster] : [];
                      });
                      loadDependencyEditorData(nextMaster);
                    }}
                    disabled={!masters.length}
                  >
                    {!masters.length ? (
                      <option value="">Load masters first</option>
                    ) : (
                      masters.map((master) => (
                        <option key={master.name} value={master.name}>
                          {master.displayName || master.name} ({master.name})
                        </option>
                      ))
                    )}
                  </select>
                  <button type="button" onClick={loadMasters} disabled={loadingMasters} className="btn-sm">
                    {loadingMasters ? '...' : 'Load'}
                  </button>
                </div>
              </label>

              <div className="crud-master-multi">
                <span>Masters (CRUD Run)</span>
                <MultiSelect
                  options={masters.map((master) => ({ value: master.name, label: `${master.displayName || master.name} (${master.name})` }))}
                  value={selectedMasters}
                  onChange={setSelectedMasters}
                  placeholder="Select one or more masters"
                  ariaLabel="Select masters for CRUD run"
                  rootClassName="multi-select-compliance"
                  wrapTags
                />
              </div>

              <label>
                Operation
                <select value={operation} onChange={(e) => setOperation(e.target.value)}>
                  <option value="create">Create</option>
                  <option value="update">Update</option>
                  <option value="delete">Delete</option>
                  <option value="all">All (Create to Update to Delete)</option>
                </select>
              </label>

              {['update', 'delete'].includes(operation) && (
                <label>
                  Target Record Name (optional)
                  <input
                    type="text"
                    value={targetRecordName}
                    onChange={(e) => setTargetRecordName(e.target.value)}
                    placeholder="Leave blank to use first record"
                    disabled={running}
                  />
                </label>
              )}
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
                disabled={running || (!(selectedMasters.length > 0) && !selectedMaster)}
              >
                {running ? `Running ${operation}...` : `Run ${operation.charAt(0).toUpperCase() + operation.slice(1)} for ${selectedMasters.length > 0 ? selectedMasters.length : (selectedMaster ? 1 : 0)} master(s)`}
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
                    <th style={thStyle}>Comparison</th>
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

                    const auditFieldDetails = getAuditComparisonDetails(entry);
                    const auditStatusMessage = getAuditStatusMessage(entry, auditEnabled);

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
                        <td style={{ ...tdStyle, minWidth: '280px', maxWidth: '520px', verticalAlign: 'top' }}>
                          {auditFieldDetails.length === 0 ? (
                            <span style={{ color: '#aaa', fontSize: '0.78rem' }}>
                              {auditStatusMessage}
                            </span>
                          ) : auditFieldDetails.map((opDetail, idx) => {
                            const passed = opDetail.summary
                              ? opDetail.summary.passed
                              : opDetail.fields.filter((f) => String(f.status || '').toUpperCase() === 'PASS').length;
                            const total = opDetail.summary?.total ?? opDetail.fields.length;
                            const allPassed = passed === total;
                            return (
                              <div key={idx} style={{ marginBottom: idx < auditFieldDetails.length - 1 ? '10px' : 0 }}>
                                <div style={{
                                  display: 'flex', alignItems: 'center', gap: '6px',
                                  fontWeight: 700, fontSize: '0.73rem', marginBottom: '4px',
                                  color: allPassed ? '#155724' : '#721c24',
                                }}>
                                  <span style={{
                                    background: allPassed ? '#d4edda' : '#f8d7da',
                                    color: allPassed ? '#155724' : '#721c24',
                                    borderRadius: '8px', padding: '1px 7px', fontSize: '0.7rem',
                                    border: `1px solid ${allPassed ? '#c3e6cb' : '#f5c6cb'}`,
                                  }}>
                                    {String(opDetail.operation || '').toUpperCase()}
                                  </span>
                                  {passed}/{total} fields matched
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
                                  <thead>
                                    <tr style={{ background: '#f0f2f5' }}>
                                      <th style={{ padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid #dee2e6', whiteSpace: 'nowrap', fontWeight: 600 }}>Field</th>
                                      <th style={{ padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid #dee2e6', fontWeight: 600 }}>Actual Saved Data</th>
                                      <th style={{ padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid #dee2e6', fontWeight: 600 }}>Audit Trail Data</th>
                                      <th style={{ padding: '3px 6px', textAlign: 'center', borderBottom: '1px solid #dee2e6', fontWeight: 600 }}>Match</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {opDetail.fields.map((field, fi) => {
                                      const fieldPassed = String(field.status || '').toUpperCase() === 'PASS';
                                      const fieldName = displayAuditValue(field.fieldName);
                                      const savedValue = displayAuditValue(field.expected);
                                      const auditValue = displayAuditValue(field.actual);
                                      return (
                                        <tr key={fi} style={{ background: fieldPassed ? '#f6fff8' : '#fff5f5' }}>
                                          <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f2f5', whiteSpace: 'nowrap', fontWeight: 500 }}>{fieldName}</td>
                                          <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f2f5', color: '#333', wordBreak: 'break-word', maxWidth: '150px' }}>{savedValue}</td>
                                          <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f2f5', color: '#333', wordBreak: 'break-word', maxWidth: '150px' }}>{auditValue}</td>
                                          <td style={{ padding: '3px 6px', borderBottom: '1px solid #f0f2f5', textAlign: 'center', fontWeight: 700, fontSize: '0.85rem', color: fieldPassed ? '#28a745' : '#dc3545' }}>
                                            <span title={`${fieldName} - ${savedValue} - ${auditValue}`}>
                                              {fieldPassed ? '✓' : '✗'}
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })}
                        </td>
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
