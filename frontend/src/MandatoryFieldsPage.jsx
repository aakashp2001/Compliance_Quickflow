import { useState } from 'react';
import { validateMandatoryFields } from './api/client';

function MandatoryFieldsPage({ config, masters = [] }) {
  const [selectedMaster, setSelectedMaster] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function handleCheck() {
    if (!selectedMaster) return;
    setError('');
    setResult(null);
    setRunning(true);
    try {
      const data = await validateMandatoryFields(selectedMaster, {
        loginUrl:   config?.loginUrl,
        username:   config?.username,
        password:   config?.password,
        showBrowser: config?.showBrowser !== false,
      });
      setResult(data);
    } catch (err) {
      setError(err?.message || 'Check failed');
    } finally {
      setRunning(false);
    }
  }

  const mandatory = result?.mandatoryFields || [];
  const optional  = result?.optionalFields  || [];
  const globalErrors = result?.globalErrors || [];

  return (
    <div className="mandatory-page">
      <h2 className="section-title">Mandatory Field Validation</h2>
      <p className="section-subtitle">
        Select a master, click <strong>Check</strong> — the automation will open its Create form,
        attempt to save without filling anything, and report all required-field errors.
      </p>

      {/* Controls */}
      <div className="mandatory-controls">
        <div className="field-row">
          <label htmlFor="mand-master-select" className="field-label">Master</label>
          <select
            id="mand-master-select"
            className="field-input"
            value={selectedMaster}
            onChange={(e) => { setSelectedMaster(e.target.value); setResult(null); setError(''); }}
            disabled={running}
          >
            <option value="">— Select master —</option>
            {masters.map((m) => (
              <option key={m.name || m} value={m.name || m}>
                {m.displayName || m.name || m}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn-primary"
          onClick={handleCheck}
          disabled={!selectedMaster || running}
        >
          {running ? (
            <><span className="spinner" /> Checking…</>
          ) : (
            'Check Mandatory Fields'
          )}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: '1rem' }}>
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mandatory-results">
          {/* Summary bar */}
          <div className="mandatory-summary">
            <span className="summary-badge total">{result.totalFields} fields found</span>
            <span className="summary-badge mandatory">{mandatory.length} mandatory</span>
            <span className="summary-badge optional">{optional.length} optional</span>
            <span className={`summary-badge validation ${result.validationWorking ? 'pass' : 'warn'}`}>
              Validation {result.validationWorking ? '✓ working' : '⚠ no errors triggered'}
            </span>
          </div>

          {globalErrors.length > 0 && (
            <div className="alert alert-warn" style={{ margin: '0.75rem 0' }}>
              <strong>Global errors captured:</strong>
              <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                {globalErrors.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
          )}

          {mandatory.length > 0 && (
            <div className="mandatory-section">
              <h3 className="subsection-title mandatory-title">
                Mandatory Fields ({mandatory.length})
              </h3>
              <table className="mandatory-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Display Name</th>
                    <th>Field Type</th>
                    <th>Validation Message</th>
                  </tr>
                </thead>
                <tbody>
                  {mandatory.map((f, i) => (
                    <tr key={i} className="row-mandatory">
                      <td>{i + 1}</td>
                      <td>
                        <span className="field-name">{f.displayName}</span>
                        {f.fieldName && f.fieldName !== f.displayName && (
                          <span className="field-id"> ({f.fieldName})</span>
                        )}
                      </td>
                      <td><span className="field-type-badge">{f.fieldType}</span></td>
                      <td className="error-msg">{f.errorMessage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {optional.length > 0 && (
            <details className="optional-section">
              <summary className="subsection-title optional-title">
                Optional Fields ({optional.length})
              </summary>
              <table className="mandatory-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Display Name</th>
                    <th>Field Type</th>
                  </tr>
                </thead>
                <tbody>
                  {optional.map((f, i) => (
                    <tr key={i} className="row-optional">
                      <td>{i + 1}</td>
                      <td>
                        <span className="field-name">{f.displayName}</span>
                        {f.fieldName && f.fieldName !== f.displayName && (
                          <span className="field-id"> ({f.fieldName})</span>
                        )}
                      </td>
                      <td><span className="field-type-badge">{f.fieldType}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {mandatory.length === 0 && optional.length === 0 && (
            <p className="empty-state">
              No fields were detected. The form may not have opened correctly.
            </p>
          )}

          <p className="tested-at">Tested at {new Date(result.testedAt).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

export default MandatoryFieldsPage;
