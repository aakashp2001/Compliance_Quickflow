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

function RecordingsPage({ masters = [] }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recordings, setRecordings] = useState([]);
  // Pagination state
  const RECORDINGS_PER_PAGE = 8;
  const [recordingsPage, setRecordingsPage] = useState(1);

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
    loadRecordings();
  }, []);

  // Pagination calculations
  const totalRecordingsPages = Math.max(1, Math.ceil(recordings.length / RECORDINGS_PER_PAGE));
  const currentRecordingsPage = Math.min(Math.max(1, recordingsPage), totalRecordingsPages);
  const paginatedRecordings = recordings.slice((currentRecordingsPage - 1) * RECORDINGS_PER_PAGE, currentRecordingsPage * RECORDINGS_PER_PAGE);

  // Reset to first page when recordings list changes
  useEffect(() => {
    setRecordingsPage(1);
  }, [recordings]);

  // Keep page bounds valid
  useEffect(() => {
    if (recordingsPage > totalRecordingsPages) setRecordingsPage(totalRecordingsPages);
    if (recordingsPage < 1 && totalRecordingsPages > 0) setRecordingsPage(1);
  }, [recordingsPage, totalRecordingsPages]);

  return (
    <section className="grid">
      <article className="card card-wide recordings-page">
        <div className="row card-toolbar">
          <h2 className="card-heading-inline">Recordings</h2>
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
          <>
            <div className="recordings-grid">
              {paginatedRecordings.map((item, idx) => (
                <article key={`${item.name}-${idx}`} className="recording-card">
                  <div className="recording-meta">
                    <strong>{item.title || item.name}</strong>
                    <span className="recording-description">{item.description || '-'}</span>
                    {item.kind && item.kind !== 'unknown' && <span>Type: {item.kind}</span>}
                    {item.masterName && <span>Master: {item.masterName}</span>}
                    {item.operation && <span>Operation: {item.operation}</span>}
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

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div className="muted">
                Showing {Math.min((currentRecordingsPage - 1) * RECORDINGS_PER_PAGE + 1, recordings.length)} - {Math.min(currentRecordingsPage * RECORDINGS_PER_PAGE, recordings.length)} of {recordings.length}
              </div>
              <div>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(1)} disabled={currentRecordingsPage === 1}>First</button>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(currentRecordingsPage - 1)} disabled={currentRecordingsPage === 1}>Prev</button>
                <span className="muted" style={{ margin: '0 8px' }}>Page {currentRecordingsPage} / {totalRecordingsPages}</span>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(currentRecordingsPage + 1)} disabled={currentRecordingsPage === totalRecordingsPages}>Next</button>
                <button type="button" className="btn-sm" onClick={() => setRecordingsPage(totalRecordingsPages)} disabled={currentRecordingsPage === totalRecordingsPages}>Last</button>
              </div>
            </div>
          </>
        )}
      </article>
    </section>
  );
}

export default RecordingsPage;
