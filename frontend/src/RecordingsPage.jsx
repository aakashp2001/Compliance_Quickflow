import { useEffect, useState } from 'react';
import { getRecordings } from './api/client';

function formatSize(sizeBytes) {
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function RecordingsPage({ masters = [], isVisible }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recordings, setRecordings] = useState([]);

  async function loadRecordings() {
    setLoading(true);
    setError('');
    try {
      const data = await getRecordings();
      const list = Array.isArray(data) ? data : data?.recordings || [];
      setRecordings(list);
    } catch (err) {
      setError(err?.message || 'Failed to load recordings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isVisible) {
      loadRecordings();
    }
  }, [isVisible]);

  return (
    <section className="grid">
      <article className="card card-wide recordings-page">
        <div className="row" style={{ marginBottom: '0.8rem' }}>
          <h2 style={{ margin: 0 }}>Recordings</h2>
          <button type="button" className="btn-sm" onClick={loadRecordings} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <p className="muted">Whenever you run tests, Playwright videos are listed here automatically.</p>

        {error && <p className="status-error">{error}</p>}

        {!loading && recordings.length === 0 && !error && (
          <p className="muted">No recordings found yet. Run any test once and refresh.</p>
        )}

        {recordings.length > 0 && (
          <div className="recordings-grid">
            {recordings.map((item, idx) => (
              <article key={`${item.name}-${idx}`} className="recording-card">
                <div className="recording-meta">
                  <strong>{item.title || item.name}</strong>
                  <span className="recording-description">{item.description || '-'}</span>
                  {item.kind && item.kind !== 'unknown' && <span>Type: {item.kind}</span>}
                  {item.masterName && <span>Master: {item.masterName}</span>}
                  {item.operation && <span>Operation: {item.operation}</span>}
                  {item.kind === 'crud' && (
                    <span style={{
                      display: 'inline-block',
                      padding: '1px 7px',
                      borderRadius: '10px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      background: item.verifyAuditTrail ? '#d4edda' : '#e9ecef',
                      color: item.verifyAuditTrail ? '#155724' : '#495057',
                      border: item.verifyAuditTrail ? '1px solid #c3e6cb' : '1px solid #ced4da',
                    }}>
                      {item.verifyAuditTrail ? '✅ Audit Trail Checked' : '⬜ Audit Trail Not Checked'}
                    </span>
                  )}
                  {item.sourceMaster && item.targetMaster && <span>Compare: {item.sourceMaster} &gt; {item.targetMaster}</span>}
                  {item.fieldName && <span>Field: {item.fieldName}</span>}
                  {item.templateName && <span>Template: {item.templateName}</span>}
                  <span>{item.createdAt ? new Date(item.createdAt).toLocaleString() : '-'}</span>
                  <span>{formatSize(item.sizeBytes)}</span>
                  <span className="recording-filename">File: {item.name}</span>
                </div>

                <video
                  className="recording-video"
                  controls
                  preload="metadata"
                  src={item.url}
                />

                <a className="test-report-link" href={item.url} target="_blank" rel="noreferrer">
                  Open video in new tab
                </a>
              </article>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

export default RecordingsPage;
