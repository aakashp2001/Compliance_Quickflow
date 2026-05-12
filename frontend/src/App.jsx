import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { fetchMasters, getHealth, getMasterFields, getMasters, compareFieldMaster } from './api/client';
import Sidebar from './Sidebar';
import CrudPage from './CrudPage';
import TestReportPage from './TestReportPage';
import MandatoryFieldsPage from './MandatoryFieldsPage';
import RecordingsPage from './RecordingsPage';
import DuplicateCheckPage from './DuplicateCheckPage';
import TemplateWorkflowPage from './TemplateWorkflowPage';
import CompliancePage from './CompliancePage';

const SELECT_LIKE_TYPES = ['select', 'multiselect', 'customselect'];
const MASTER_FIELDS_CACHE_STORAGE_KEY = 'masterFieldsCacheV1';

function normalizeName(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactName(value) {
  return normalizeName(value).replace(/\s+/g, '');
}

function stripCommonSuffixes(value) {
  return normalizeName(value)
    .replace(/\b(name|id|code|value|list|master|mst|table)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addAlias(set, value) {
  const normalized = normalizeName(value);
  if (!normalized) return;
  set.add(normalized);
  set.add(compactName(normalized));

  const stripped = stripCommonSuffixes(normalized);
  if (stripped) {
    set.add(stripped);
    set.add(compactName(stripped));
  }
}

function buildFieldAliases(field) {
  const aliases = new Set();
  addAlias(aliases, field?.displayName);
  addAlias(aliases, field?.columnToShow);
  addAlias(aliases, field?.columnName);
  addAlias(aliases, field?.id);
  return Array.from(aliases).filter(Boolean);
}

function buildMasterAliases(master) {
  const aliases = new Set();
  const displayName = master?.displayName || '';
  const name = master?.name || '';
  const href = master?.href || '';

  addAlias(aliases, displayName);
  addAlias(aliases, name);
  addAlias(aliases, href);

  // Add create-* stripped aliases so fields like "App" can match masters like "Create-App".
  const strippedCreate = normalizeName(name)
    .replace(/^create\s+/, '')
    .trim();
  if (strippedCreate) {
    addAlias(aliases, strippedCreate);
  }

  const hrefSlug = normalizeName(href.replace(/^\/+/, ''));
  const strippedHrefCreate = hrefSlug.replace(/^create\s+/, '').trim();
  if (strippedHrefCreate) {
    addAlias(aliases, strippedHrefCreate);
  }

  return Array.from(aliases).filter(Boolean);
}

function scoreAliasMatch(fieldAliases, masterAliases) {
  let best = 0;
  for (const fieldAlias of fieldAliases) {
    for (const masterAlias of masterAliases) {
      if (!fieldAlias || !masterAlias) continue;
      if (fieldAlias === masterAlias) {
        best = Math.max(best, 100);
        continue;
      }

      if (fieldAlias.includes(masterAlias)) {
        // Prefer cases like "timezonename" -> "timezone" over tiny accidental substrings.
        const bonus = masterAlias.length >= 4 ? 80 : 0;
        best = Math.max(best, bonus);
      }

      if (masterAlias.includes(fieldAlias)) {
        const bonus = fieldAlias.length >= 4 ? 70 : 0;
        best = Math.max(best, bonus);
      }
    }
  }
  return best;
}

function isMasterWorkflowMaster(master) {
  const name = compactName(master?.name || '');
  const displayName = compactName(master?.displayName || '');
  const href = compactName(String(master?.href || '').replace(/^\/+/, ''));

  return [name, displayName, href].some((value) => value.includes('masterworkflow'));
}

function removeMasterWorkflow(list) {
  return (Array.isArray(list) ? list : []).filter((master) => !isMasterWorkflowMaster(master));
}

function DiscoveryPage({
  masters,
  onMastersChange,
  masterFieldsCache,
  setMasterFieldsCache,
}) {
  const getFieldValue = (field, index) => field?.id || `${field?.displayName || 'field'}__${index}`;

  const [fetchConfig, setFetchConfig] = useState({
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'dhruvi',
    password: '',
    showBrowser: true,
  });
  const [health, setHealth] = useState('Checking connection...');
  const [healthError, setHealthError] = useState('');
  const [selectedMaster, setSelectedMaster] = useState('');
  const [fields, setFields] = useState([]);
  const [selectedField, setSelectedField] = useState('');
  const [loadingFields, setLoadingFields] = useState(false);
  const [fieldsError, setFieldsError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [loadingMasters, setLoadingMasters] = useState(false);
  const [mastersError, setMastersError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareError, setCompareError] = useState('');
  const [manualTargetMaster, setManualTargetMaster] = useState('');

  const selectedMasterObj = useMemo(
    () => masters.find((m) => m.name === selectedMaster) || null,
    [masters, selectedMaster]
  );

  const selectedFieldObj = useMemo(
    () => fields.find((f, idx) => getFieldValue(f, idx) === selectedField) || null,
    [fields, selectedField]
  );

  // Auto-detect a matching master for a select-type field
  const matchedTargetMaster = useMemo(() => {
    if (!selectedFieldObj || !SELECT_LIKE_TYPES.includes(selectedFieldObj.elementType)) return null;

    const fieldAliases = buildFieldAliases(selectedFieldObj);
    if (!fieldAliases.length) return null;

    const currentMasterAliases = selectedMasterObj ? buildMasterAliases(selectedMasterObj) : [];

    const ranked = masters
      .map((master) => {
        const aliases = buildMasterAliases(master);
        const score = scoreAliasMatch(fieldAliases, aliases);
        const selfPenalty = score > 0 && currentMasterAliases.length
          ? scoreAliasMatch(currentMasterAliases, aliases) >= 90 ? 10 : 0
          : 0;

        return { master, score: Math.max(0, score - selfPenalty) };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.master || null;
  }, [selectedFieldObj, masters, selectedMasterObj]);

  // Reset comparison when field changes
  useEffect(() => {
    setCompareResult(null);
    setCompareError('');
    setManualTargetMaster('');
  }, [selectedField, selectedMaster]);

  // Effective target master: manual override wins over auto-match
  const effectiveTargetMaster = useMemo(() => {
    if (manualTargetMaster) return masters.find((m) => m.name === manualTargetMaster) || null;
    return matchedTargetMaster;
  }, [manualTargetMaster, matchedTargetMaster, masters]);

  async function handleCompare() {
    if (!selectedFieldObj || !effectiveTargetMaster) return;
    setComparing(true);
    setCompareError('');
    setCompareResult(null);
    try {
      const data = await compareFieldMaster({
        sourceMaster: selectedMaster,
        targetMaster: effectiveTargetMaster.name,
        fieldId: selectedFieldObj.id || '',
        fieldIndex: selectedFieldObj.idx ?? 0,
        fieldName: selectedFieldObj.displayName || '',
        loginUrl: fetchConfig.loginUrl,
        username: fetchConfig.username,
        password: fetchConfig.password,
        showBrowser: fetchConfig.showBrowser,
      });
      setCompareResult(data);
    } catch (err) {
      setCompareError(err.message || 'Comparison failed');
    } finally {
      setComparing(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    getHealth()
      .then((data) => {
        if (!mounted) return;
        const status = typeof data === 'string' ? data : JSON.stringify(data);
        setHealth(`Connected: ${status}`);
      })
      .catch((err) => {
        if (!mounted) return;
        setHealth('Unable to connect');
        setHealthError(err.message || 'Health endpoint failed');
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function loadMasters() {
    setLoadingMasters(true);
    setMastersError('');
    try {
      const data = await getMasters();
      const list = Array.isArray(data) ? data : data?.masters || [];
      const fetchedAtValue = data?.fetchedAt || '';
      const backendFieldCache = data?.masterFieldsCache || {};
      const backendFieldArrays = Object.fromEntries(
        Object.entries(backendFieldCache).map(([masterName, value]) => [
          masterName,
          Array.isArray(value?.fields) ? value.fields : [],
        ])
      );

      const filteredList = removeMasterWorkflow(list);
      onMastersChange(filteredList);
      setFetchedAt(fetchedAtValue);
      if (Object.keys(backendFieldArrays).length) {
        setMasterFieldsCache((prev) => ({ ...prev, ...backendFieldArrays }));
      }
      if (filteredList.length) {
        const firstMaster = filteredList[0].name;
        setSelectedMaster((prev) => prev || firstMaster);
        const initialFields = masterFieldsCache[firstMaster] || backendFieldArrays[firstMaster] || [];
        setFields(initialFields);
        setSelectedField(initialFields.length ? getFieldValue(initialFields[0], 0) : '');
      } else {
        setFields([]);
        setSelectedField('');
      }
    } catch (err) {
      setMastersError(err.message || 'Failed to load masters from cache');
    } finally {
      setLoadingMasters(false);
    }
  }

  useEffect(() => {
    loadMasters();
  }, []);

  async function loadFieldsForMaster(masterName) {
    if (!masterName) {
      setFields([]);
      setSelectedField('');
      setFieldsError('');
      return;
    }

    // Use client-side cache if fields for this master are already loaded
    if (Object.prototype.hasOwnProperty.call(masterFieldsCache, masterName)) {
      const cachedFields = masterFieldsCache[masterName];
      setFields(cachedFields);
      setSelectedField((prev) => {
        if (prev && cachedFields.some((f, idx) => getFieldValue(f, idx) === prev)) return prev;
        return cachedFields.length ? getFieldValue(cachedFields[0], 0) : '';
      });
      return; // Skip API call
    }

    // Do not auto-fetch on master dropdown change.
    // Network fetch should happen only via explicit actions (Fetch Masters / Refresh Fields).
    setFields([]);
    setSelectedField('');
    setFieldsError('');
  }

  async function handleFetchMasters() {
    setFetching(true);
    setMastersError('');
    setInfoMessage('Fetching masters from IPDEV. This can take a little while...');
    try {
      const data = await fetchMasters({
        ...fetchConfig,
        fetchFieldsOnMasterFetch: true,
      });
      const list = removeMasterWorkflow(data?.masters || []);
      const backendFieldCache = data?.masterFieldsCache || {};
      const backendFieldArrays = Object.fromEntries(
        Object.entries(backendFieldCache).map(([masterName, value]) => [
          masterName,
          Array.isArray(value?.fields) ? value.fields : [],
        ])
      );

      // Update masters list
      onMastersChange(list);
      setFetchedAt(data.fetchedAt || '');
      if (Object.keys(backendFieldArrays).length) {
        setMasterFieldsCache((prev) => ({ ...prev, ...backendFieldArrays }));
      }
      if (list.length) {
        const firstMaster = list[0].name;
        setSelectedMaster(firstMaster);
        const initialFields = masterFieldsCache[firstMaster] || backendFieldArrays[firstMaster] || [];
        setFields(initialFields);
        setSelectedField(initialFields.length ? getFieldValue(initialFields[0], 0) : '');
      } else {
        setSelectedMaster('');
        setFields([]);
        setSelectedField('');
      }

      const bulkSummary = data?.bulkFieldFetch;
      const bulkSuffix = bulkSummary?.attempted
        ? ` Fields cached for ${bulkSummary.count - bulkSummary.failedCount}/${bulkSummary.count} masters.`
        : '';

      if (list.length === 0 && data?._debug) {
        setInfoMessage(`Fetched 0 masters. Debug log:\n${data._debug}`);
      } else {
        setInfoMessage(`Fetched ${list.length} masters successfully.${bulkSuffix}`);
      }
    } catch (err) {
      setMastersError(err.message || 'Failed to fetch masters from backend');
      setInfoMessage('');
    } finally {
      setFetching(false);
    }
  }

  useEffect(() => {
    loadFieldsForMaster(selectedMaster);
  }, [selectedMaster, masterFieldsCache]);

  return (
    <>
      <section className="grid">
        <article className="card status-card">
          <h2>Backend Status</h2>
          <p className="status-ok">{health}</p>
          {healthError && <p className="status-error">{healthError}</p>}
        </article>

        <article className="card discovery-card">
          <h2>Master Discovery</h2>
          <div className="form">
            <label>
              IPDEV Login URL
              <input
                value={fetchConfig.loginUrl}
                onChange={(e) => setFetchConfig((prev) => ({ ...prev, loginUrl: e.target.value }))}
                placeholder="https://ipdev.quickflow.in/login"
              />
            </label>

            <label>
              Username
              <input
                value={fetchConfig.username}
                onChange={(e) => setFetchConfig((prev) => ({ ...prev, username: e.target.value }))}
                placeholder="Enter username"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={fetchConfig.password}
                onChange={(e) => setFetchConfig((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Enter password"
              />
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fetchConfig.showBrowser}
                onChange={(e) => setFetchConfig((prev) => ({ ...prev, showBrowser: e.target.checked }))}
              />
              <span>Show Playwright browser while fetching</span>
            </label>

            <button type="button" onClick={handleFetchMasters} disabled={fetching}>
              {fetching ? 'Fetching from IPDEV...' : 'Fetch Masters from IPDEV'}
            </button>

            <button type="button" onClick={loadMasters} disabled={loadingMasters}>
              {loadingMasters ? 'Loading saved list...' : 'Load Last Fetched List'}
            </button>

            {infoMessage && <p className="note">{infoMessage}</p>}
            {mastersError && <p className="status-error">{mastersError}</p>}

            <label>
              Master Name
              <select
                value={selectedMaster}
                onChange={(e) => setSelectedMaster(e.target.value)}
                disabled={!masters.length}
              >
                {!masters.length ? (
                  <option value="">No masters available yet</option>
                ) : (
                  masters.map((master) => (
                    <option key={master.name} value={master.name}>
                      {master.displayName} ({master.name})
                    </option>
                  ))
                )}
              </select>
            </label>

            <label>
              Field Name
              <select
                value={selectedField}
                onChange={(e) => setSelectedField(e.target.value)}
                disabled={!selectedMaster || loadingFields || !fields.length}
              >
                {!selectedMaster ? (
                  <option value="">Select a master first</option>
                ) : loadingFields ? (
                  <option value="">Loading fields...</option>
                ) : !fields.length ? (
                  <option value="">No fields found for this master</option>
                ) : (
                  fields.map((field, idx) => (
                    <option key={getFieldValue(field, idx)} value={getFieldValue(field, idx)}>
                      {field.displayName} ({field.elementType}{['text', 'textarea', 'email', 'tel', 'password', 'encryptedtext', 'number', 'decimal'].includes(field.elementType) && field.maxLength ? `, max: ${field.maxLength}` : ''})
                    </option>
                  ))
                )}
              </select>
            </label>
            <button
              type="button"
              onClick={async () => {
                if (!selectedMaster) return;
                setLoadingFields(true);
                setFieldsError('');
                try {
                  const data = await getMasterFields(selectedMaster, {
                    loginUrl: fetchConfig.loginUrl,
                    username: fetchConfig.username,
                    password: fetchConfig.password,
                    showBrowser: fetchConfig.showBrowser,
                    refresh: true,
                  });
                  const nextFields = Array.isArray(data?.fields) ? data.fields : [];
                  setMasterFieldsCache((prev) => ({ ...prev, [selectedMaster]: nextFields }));
                  setFields(nextFields);
                  setSelectedField((prev) => {
                    const getFieldValue = (field, idx) => field?.id || `${field?.displayName || 'field'}__${idx}`;
                    if (prev && nextFields.some((f, idx) => getFieldValue(f, idx) === prev)) return prev;
                    return nextFields.length ? getFieldValue(nextFields[0], 0) : '';
                  });
                } catch (err) {
                  setFieldsError(err.message || 'Failed to refresh fields');
                } finally {
                  setLoadingFields(false);
                }
              }}
              disabled={!selectedMaster || loadingFields}
            >
              {loadingFields ? 'Refreshing...' : 'Refresh Fields'}
            </button>

            {fieldsError && <p className="status-error">{fieldsError}</p>}

            <p className="muted">Total masters in dropdown: {masters.length}</p>
            <p className="muted">Total fields in dropdown: {fields.length}</p>
            {fetchedAt && <p className="muted">Last fetched at: {new Date(fetchedAt).toLocaleString()}</p>}
          </div>
        </article>

        <article className="card card-wide">
          <h2>Selected Master</h2>
          {!selectedMasterObj ? (
            <p className="muted">Pick a master from dropdown after fetching.</p>
          ) : (
            <div className="list">
              <div>
                <strong>Display Name:</strong> {selectedMasterObj.displayName}
              </div>
              <div>
                <strong>Slug:</strong> {selectedMasterObj.name}
              </div>
              <div>
                <strong>Route:</strong> {selectedMasterObj.href}
              </div>
              <div>
                <strong>Has Review:</strong> {selectedMasterObj.hasReview ? 'Yes' : 'No'}
              </div>
              <div>
                <strong>Selected Field:</strong> {selectedFieldObj ? selectedFieldObj.displayName : 'None'}
              </div>
              <div>
                <strong>Field Type:</strong> {selectedFieldObj ? selectedFieldObj.elementType : '-'}
              </div>
              {selectedFieldObj && ['text', 'textarea', 'email', 'tel', 'password', 'encryptedtext', 'number', 'decimal'].includes(selectedFieldObj.elementType) && (
                <div>
                  <strong>Max Length:</strong> {selectedFieldObj.maxLength ? selectedFieldObj.maxLength : 'Not set'}
                </div>
              )}
            </div>
          )}
        </article>

        {/* ── Compare Select vs Master ── */}
        {selectedFieldObj && SELECT_LIKE_TYPES.includes(selectedFieldObj.elementType) && (
          <article className="card card-wide compare-card">
            <h2>Compare Dropdown vs Master Data</h2>
            <p className="muted">
              Field <strong>{selectedFieldObj.displayName}</strong> is a <em>{selectedFieldObj.elementType}</em>.{' '}
              {matchedTargetMaster
                ? <>Auto-matched: <strong>{matchedTargetMaster.displayName}</strong> ({matchedTargetMaster.name})</>
                : <span className="text-warn">No auto-match found. Select a target master manually below.</span>}
            </p>

            <label className="label-block">
              Target Master{matchedTargetMaster ? ' (override auto-match)' : ' (required)'}
              <select
                value={manualTargetMaster || (matchedTargetMaster?.name ?? '')}
                onChange={(e) => setManualTargetMaster(e.target.value === (matchedTargetMaster?.name ?? '') ? '' : e.target.value)}
                disabled={comparing || !masters.length}
                className="input-full"
              >
                {matchedTargetMaster && (
                  <option value={matchedTargetMaster.name}>
                    ★ {matchedTargetMaster.displayName} (auto-matched)
                  </option>
                )}
                {masters
                  .filter((m) => m.name !== selectedMaster && m.name !== matchedTargetMaster?.name)
                  .map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.displayName} ({m.name})
                    </option>
                  ))}
              </select>
            </label>

            <button
              type="button"
              className="btn-mt"
              onClick={handleCompare}
              disabled={comparing || !effectiveTargetMaster}
            >
              {comparing
                ? 'Comparing...'
                : effectiveTargetMaster
                  ? `Compare with "${effectiveTargetMaster.displayName}" Master`
                  : 'Select a target master to compare'}
            </button>

            {compareError && <p className="status-error">{compareError}</p>}

            {compareResult?.comparison && (
              <div className="compare-results">
                <div className={`compare-badge ${compareResult.comparison.isFullMatch ? 'match' : 'mismatch'}`}>
                  {compareResult.comparison.isFullMatch ? '✓ Full Match' : '✗ Mismatch'}
                </div>

                <div className="compare-stats">
                  <span>Dropdown options: <strong>{compareResult.comparison.totalOptions}</strong></span>
                  <span>Master records: <strong>{compareResult.comparison.totalRecords}</strong></span>
                  <span>Matched: <strong>{compareResult.comparison.matchedCount}</strong></span>
                </div>

                {compareResult.comparison.totalOptions === 0 && (
                  <p className="compare-warn">⚠ No options were extracted from the dropdown. The field may use a custom (non-native) select component. Try running with Show Browser enabled to inspect the form.</p>
                )}

                {compareResult.comparison.missingInDropdown.length > 0 && (
                  <div className="compare-section">
                    <h4>Missing in Dropdown <small>({compareResult.comparison.missingInDropdown.length}) — exist in master but not in select:</small></h4>
                    <ul>
                      {compareResult.comparison.missingInDropdown.filter(s => s && s.trim()).map((item, i) => (
                        <li key={i} className="compare-missing">{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {compareResult.comparison.extraInDropdown.length > 0 && (
                  <div className="compare-section">
                    <h4>Extra in Dropdown <small>({compareResult.comparison.extraInDropdown.length}) — in select but not in master:</small></h4>
                    <ul>
                      {compareResult.comparison.extraInDropdown.filter(s => s && s.trim()).map((item, i) => (
                        <li key={i} className="compare-extra">{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {compareResult.comparison.isFullMatch && compareResult.comparison.totalOptions > 0 && (
                  <p className="compare-ok">✓ All dropdown options match the master records.</p>
                )}
              </div>
            )}
          </article>
        )}
      </section>
    </>
  );
}

function App() {
  const [sharedMasters, setSharedMasters] = useState([]);
  const visibleMasters = useMemo(() => removeMasterWorkflow(sharedMasters), [sharedMasters]);
  const [sharedConfig] = useState({
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'dhruvi',
    password: '',
    showBrowser: true,
  });
  const [masterFieldsCache, setMasterFieldsCache] = useState(() => {
    try {
      const raw = localStorage.getItem(MASTER_FIELDS_CACHE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem(MASTER_FIELDS_CACHE_STORAGE_KEY, JSON.stringify(masterFieldsCache));
  }, [masterFieldsCache]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="main-inner">
          <Routes>
            <Route path="/" element={<Navigate to="/master-discovery" replace />} />
            <Route path="/master-discovery" element={<DiscoveryPage masters={visibleMasters} onMastersChange={setSharedMasters}
              masterFieldsCache={masterFieldsCache}
              setMasterFieldsCache={setMasterFieldsCache} />} />


            <Route path="/crud-operations" element={<CrudPage masters={visibleMasters} />} />
            <Route path="/test-report" element={<TestReportPage masters={visibleMasters} />} />
            <Route path="/mandatory-fields" element={<MandatoryFieldsPage config={sharedConfig} masters={visibleMasters} />} />
            <Route path="/template-workflow" element={<TemplateWorkflowPage />} />
            <Route path="/duplicate-check" element={<DuplicateCheckPage masters={visibleMasters} />} />
            <Route path="/recordings" element={<RecordingsPage masters={visibleMasters} />} />
            <Route path="/compliance" element={<CompliancePage masters={visibleMasters}/>} />
            <Route path="*" element={<Navigate to="/master-discovery" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default App;
