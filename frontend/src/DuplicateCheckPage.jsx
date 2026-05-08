import { useState } from 'react';
import { runCrudOperation } from './api/client';

function DuplicateCheckPage({ masters = [] }) {
  const [config, setConfig] = useState({
    loginUrl: 'https://ipdev.quickflow.in/login',
    username: 'dhruvi',
    password: '',
    showBrowser: true,
  });

  const [selectedMaster, setSelectedMaster] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');

  async function handleCheckDuplicate() {
    if (!selectedMaster) return;

    setRunning(true);
    setError('');

    const runningEntry = {
      id: Date.now(),
      status: 'running',
      master: selectedMaster,
      startedAt: new Date().toLocaleTimeString(),
    };
    setResults((prev) => [runningEntry, ...prev]);

    try {
      const data = await runCrudOperation(selectedMaster, {
        operation: 'duplicate-check',
        loginUrl: config.loginUrl,
        username: config.username,
        password: config.password,
        showBrowser: config.showBrowser,
      });

      const hasFailure = data?.failed || data?.failures?.length > 0;
      const duplicateBlocked = data?.operations?.some((op) => op.operation === 'duplicate-check' && op.duplicateBlocked === true);

      const finishedEntry = {
        ...runningEntry,
        status: duplicateBlocked ? 'pass' : hasFailure ? 'fail' : 'pass',
        duplicateBlocked,
        baselineFieldCount: data?.operations?.[0]?.baselineFieldCount || 0,
        replayFieldCount: data?.operations?.[0]?.replayFieldCount || 0,
        alertMessage: data?.operations?.[0]?.alertMessage || 'Check complete',
        error: data?.failures?.[0]?.error || '',
        finishedAt: new Date().toLocaleTimeString(),
      };

      setResults((prev) => prev.map((entry) => (entry.id === runningEntry.id ? finishedEntry : entry)));
    } catch (err) {
      const failedEntry = {
        ...runningEntry,
        status: 'fail',
        error: err.message,
        finishedAt: new Date().toLocaleTimeString(),
      };

      setResults((prev) => prev.map((entry) => (entry.id === runningEntry.id ? failedEntry : entry)));
      setError(err.message || 'Duplicate check failed');
    } finally {
      setRunning(false);
    }
  }



  return (
    <div className="duplicate-check-page">
      <h1>Duplicate Entry Verification</h1>

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
                Select Master
                <div className="input-group">
                  <select
                    value={selectedMaster}
                    onChange={(e) => setSelectedMaster(e.target.value)}
                    disabled={!masters.length}
                  >
                    {!masters.length ? (
                      <option value="">Fetch masters in Master Discovery first</option>
                    ) : (
                      masters.map((master) => (
                        <option key={master.name} value={master.name}>
                          {master.displayName} ({master.name})
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.showBrowser}
                  onChange={(e) => setConfig((prev) => ({ ...prev, showBrowser: e.target.checked }))}
                />
                Show browser
              </label>

              <button
                type="button"
                className="btn-run"
                onClick={handleCheckDuplicate}
                disabled={running || !selectedMaster}
              >
                {running ? 'Checking...' : 'Check Duplicate Protection'}
              </button>
            </div>

            {error && <p className="status-error">{error}</p>}
          </div>
        </article>

        <article className="card card-wide">
          <h2>How It Works</h2>
          <div className="info-box">
            <p>
              This feature verifies that your selected master correctly blocks duplicate entries:
            </p>
            <ol>
              <li>Creates a <strong>baseline record</strong> with auto-generated unique values</li>
              <li>Attempts to create an <strong>identical second record</strong> with the same values</li>
              <li>Verifies the <strong>duplicate was blocked</strong> by system validation</li>
              <li>Reports whether duplicate protection is <strong>working correctly</strong></li>
            </ol>
            <p>
              <strong>Expected Result:</strong> The second create attempt should fail with a duplicate error message.
            </p>
          </div>
        </article>

        <article className="card card-wide">
          <h2>
            Results
            {results.length > 0 && (
              <button
                type="button"
                className="btn-sm"
                onClick={() => setResults([])}
                style={{ marginLeft: '1rem' }}
              >
                Clear
              </button>
            )}
          </h2>
          {!results.length ? (
            <p className="muted">No checks run yet. Select a master and click "Check Duplicate Protection".</p>
          ) : (
            <div className="results-list">
              {results.map((entry) => (
                <div key={entry.id} className={`result-item result-${entry.status}`}>
                  <div className="result-header">
                    <span className="result-badge">{String(entry.status || '').toUpperCase()}</span>
                    <strong>{entry.master}</strong>
                    <span className="muted result-time">
                      {entry.startedAt}
                      {entry.finishedAt ? ` → ${entry.finishedAt}` : ''}
                    </span>
                  </div>

                  <div className="result-details">
                    {entry.duplicateBlocked !== undefined && (
                      <div className="op-summary">
                        <span className="op-label">Duplicate Blocked</span>
                        <span className={entry.duplicateBlocked ? 'status-ok' : 'status-error'}>
                          {entry.duplicateBlocked ? '✓ Yes' : '✗ No'}
                        </span>
                      </div>
                    )}

                    {entry.baselineFieldCount > 0 && (
                      <div className="op-summary">
                        <span className="op-label">Fields Created</span>
                        <span className="muted">{entry.baselineFieldCount}</span>
                      </div>
                    )}

                    {entry.alertMessage && (
                      <div className="op-summary">
                        <span className="op-label">Message</span>
                        <span className="muted">{entry.alertMessage}</span>
                      </div>
                    )}

                    {entry.error && (
                      <div className="op-summary error">
                        <span className="op-label">Error</span>
                        <span className="status-error">{entry.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default DuplicateCheckPage;
