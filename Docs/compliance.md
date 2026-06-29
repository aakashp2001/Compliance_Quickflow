# Compliance Tests

Location
--------

Compliance tests are implemented under `playwright-tests/compliance/`. The primary orchestrator is `compliance-runner.js`, which exposes multiple TC (test-case) functions and a `main()` dispatcher.
Master Data compliance is implemented in `master-data-runner.js` as a separate suite.
Audit Trail compliance is implemented in `audit-trail-runner.js`.
Error Handling compliance is implemented in `error-handling-runner.js`.
Access Control compliance is implemented in `access-control-runner.js` with BDD helpers in `ac-bdd-steps.js`.
Performance and Reliability compliance is implemented in `performance-reliability-runner.js` with helper modules `pr-bdd-steps.js` and `pr-metrics.js`.

How tests run
-------------

- `compliance-runner.js` launches a Playwright browser context (Chromium) and executes Data Integrity TCs.
- `master-data-runner.js` launches a Playwright browser context (Chromium) and executes Master Data TCs (`TC-MD-*`) with readiness-aware `blocked` outcomes when feature hooks are unavailable.
- `audit-trail-runner.js` launches a Playwright browser context (Chromium) and executes Audit Trail TCs (`TC-AT-*`).
- `error-handling-runner.js` launches a Playwright browser context (Chromium) and executes Error Handling TCs (`TC-EH-*`).
- `access-control-runner.js` launches a Playwright browser context (Chromium) and executes Access Control TCs (`TC-*-AC*`, `TC-AC*`, `TC-VMS-AC10-*`) with readiness-aware `blocked` outcomes where external hooks are required.
- `performance-reliability-runner.js` executes Performance and Reliability TCs (`TC-PR-*`) using a Playwright-first hybrid model. It supports strict-load mode with k6 for high-concurrency scenarios and returns readiness-aware `blocked` outcomes when k6/configuration is unavailable.
- When no `QT_TC_ID` is supplied, the runner executes a default set of TCs and emits a consolidated JSON `result` to `stdout`.

Running a single TC
-------------------

```powershell
cd playwright-tests
npx playwright install
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-DI-06-01 node compliance/compliance-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-MD-02-01 node compliance/master-data-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-EH-01-01 node compliance/error-handling-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa_admin QT_PASS=secret QT_USER2=qa_viewer QT_PASS2=secret2 QT_TC_ID=TC-AC-01 node compliance/access-control-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-PR-01-01 QT_PR_MODE=HYBRID QT_PR_ENTRY_ENDPOINTS="/api/landing-page/dashboard,/api/form-issuance/list" node compliance/performance-reliability-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-PR-04-01 QT_PR_MODE=PLAYWRIGHT QT_PR_IMPORT_ENDPOINT="/api/masters/import" QT_PR_IMPORT_BODY_JSON='{"masterName":"Country"}' node compliance/performance-reliability-runner.js
```

Interpreting results
--------------------

- The runner writes a machine-readable JSON object to `stdout` with fields such as `suite`, `mode`, `tcId`, `startedAt`, `completedAt`, `status`, and `results`. Master Data suite supports `status: blocked` in addition to `passed` and `failed`.
- Any non-fatal debug output is written to `stderr` for easier human troubleshooting.

Backend API
-----------

- `POST /api/compliance/run` — One-shot (synchronous) compliance run. Request body supports `suite` (`DI` default, `MD`, `AT`, `EH`, `AC`, `PR`), `loginUrl`, `username`, `password`, `masterName`, `tcId`, and `showBrowser`. Returns a JSON payload with the run `status`, `results`, and optional `recordings`.

- `POST /api/compliance/runs` — Start a realtime/async compliance run (recommended for multi-master / multi-TC batches). The endpoint returns `202` with `{ runId, clientToken, status }` and processes the run in the background. Request body supports:
  - `suite`: `DI|MD|AT|EH|AC|PR`
  - `masterName` or `masterNames`: single name or array of master names to run
  - `tcId` or `tcIds`: single TC id or array of TC ids to execute
  - `loginUrl`, `username`, `password`, `showBrowser`

- `GET /api/compliance/runs/:runId` — Poll the current snapshot for a realtime run. Requires `clientToken` as query parameter for authorized access (`?clientToken=...`). Returns the run snapshot (progress, results, summary).

- `POST /api/compliance/runs/:runId/stop` — Request a graceful stop for an active realtime run. Provide `{ clientToken }` in the request body (or `clientToken` as query). The API attempts to stop the child process and finalizes results.

- `GET /api/compliance/runs/:runId/stream` — Server-Sent Events (SSE) stream for run updates. Connect with an `EventSource` using `?clientToken=...` and listen for events such as `snapshot`, `progress`, `tc_result`, `run_complete`, and `run_failed`. Example:

```javascript
const es = new EventSource(`http://localhost:8000/api/compliance/runs/${runId}/stream?clientToken=${clientToken}`);
es.addEventListener('snapshot', (e) => console.log('snapshot', JSON.parse(e.data)));
es.addEventListener('progress', (e) => console.log('progress', JSON.parse(e.data)));
```

Example: start an async run (curl):

```bash
curl -X POST http://localhost:8000/api/compliance/runs \
  -H "Content-Type: application/json" \
  -d '{"suite":"DI","masterNames":["Country","App"],"tcIds":["TC-DI-01","TC-DI-06-01"],"username":"qa","password":"secret"}'
```

Response (202):

```json
{ "runId": "cr-...", "clientToken": "...", "status": "running" }
```

Notes:

- Realtime run snapshots are persisted to the `compliance_runs` collection and pruned to a retention limit. Use the `runId` + `clientToken` pair to poll or stream the live progress and to request stop.

PR Suite Notes:

- `QT_PR_MODE=HYBRID` (default): Uses k6 for strict-load TCs (`TC-PR-01-01`, `TC-PR-01-02`, `TC-PR-02-01`, `TC-PR-03-01`) and Playwright for reliability/evidence TCs.
- `QT_PR_MODE=PLAYWRIGHT`: Runs all PR TCs with Playwright-only flow where possible; strict-load TCs can be marked `blocked` if external load fidelity is required.
- k6 profiles are stored in `playwright-tests/performance/k6/`:
  - `pr-01-load.js`
  - `pr-02-approval.js`
  - `pr-03-stress.js`

Test coverage areas
-------------------

- Attributability / Audit trail verification
- Legibility (unicode and long strings)
- Mandatory field enforcement
- Session interruption and durability
- Soft delete / data preservation
- Concurrent edit/conflict detection
