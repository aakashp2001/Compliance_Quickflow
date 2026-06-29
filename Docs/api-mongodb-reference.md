# API And MongoDB Reference

This guide explains:

- how API calls are handled in the backend,
- which Playwright script (if any) is invoked,
- which MongoDB collection is read/written,
- and what consistency behavior to expect.

Primary implementation references:

- [backend/server.js](backend/server.js)
- [backend/db/storage.js](backend/db/storage.js)
- [backend/db/mongoClient.js](backend/db/mongoClient.js)

## 1. End-to-end request lifecycle

For most execution endpoints (CRUD, compare, mandatory, workflow, compliance), the flow is:

1. Frontend calls backend endpoint.
2. Backend validates payload and composes environment variables.
3. Backend starts recording snapshot for artifact diffing.
4. Backend spawns a Playwright entry script as a child process.
5. Script writes diagnostics to stderr and final JSON to stdout.
6. Backend parses JSON, writes report/recording metadata to MongoDB.
7. Backend returns response with status + artifact URLs.

For cache/config endpoints (masters cache, dependency config, saved results), backend reads/writes MongoDB through the storage layer directly.

## 2. MongoDB initialization model

Startup behavior in [backend/server.js](backend/server.js):

1. `storage.initStorage()` is called before the server starts listening.
2. `initStorage()` in [backend/db/storage.js](backend/db/storage.js) creates indexes and loads documents into in-memory state.
3. Runtime routes mostly read from this in-memory state and asynchronously persist updates back to MongoDB.

Implication:

- Reads are fast and memory-backed.
- Writes are persisted asynchronously for many paths.
- On restart, memory is hydrated from MongoDB again.

## 3. Collections and ownership

Collection names are declared in [backend/db/storage.js](backend/db/storage.js):

- `masters_cache`
- `master_fields_cache`
- `test_reports`
- `recordings`
- `compliance_runs`
- `crud_results`
- `dependency_configs`
- `template_workflow_states`

Retention limits in storage:

- `test_reports`: 500
- `recordings`: 500

Additional server-side retention:

- realtime compliance run snapshots are pruned to 100 runs before persistence.

## 4. Endpoint catalog with MongoDB effects

### 4.1 System and utility endpoints

| Method | Endpoint | Purpose | MongoDB read/write |
|---|---|---|---|
| GET | `/health` | Service health check | none |
| GET | `/api/items` | In-memory sample list | none |
| POST | `/api/items` | In-memory sample add | none |

### 4.2 Masters, fields, and config

| Method | Endpoint | Purpose | MongoDB read/write |
|---|---|---|---|
| GET | `/api/masters` | Return cached masters and field cache snapshot | reads memory hydrated from `masters_cache` and `master_fields_cache` |
| POST | `/api/masters/fetch` | Run `fetch-masters.js` and optionally bulk field discovery | writes `masters_cache`, `master_fields_cache`, may write `dependency_configs`, may write `recordings` |
| GET | `/api/masters/:masterName/fields` | Return cached or live field discovery | reads/writes `master_fields_cache`; may write `dependency_configs`; on failure writes `test_reports`; may write `recordings` |
| GET | `/api/dependency-config` | Read dependency config (all or one master) | reads `dependency_configs` |
| PUT | `/api/dependency-config/:masterName` | Save parent/dependent dropdown mapping | writes `dependency_configs` |

### 4.3 Execution and reporting endpoints

| Method | Endpoint | Purpose | MongoDB read/write |
|---|---|---|---|
| POST | `/api/masters/:masterName/crud` | Run CRUD script (`crud-master.js`) | writes many `test_reports`; writes `recordings` |
| POST | `/api/masters/:masterName/validate-mandatory` | Run mandatory validation script | writes `test_reports`; writes `recordings` |
| POST | `/api/masters/compare-field` | Compare dropdown options with master data | writes `test_reports`; writes `recordings` |
| GET | `/api/test-reports` | List report entries | reads `test_reports` memory snapshot |
| GET | `/api/recordings` | List recordings + generated artifact URLs | reads `recordings` metadata and local artifact folder snapshot |
| POST | `/api/save-results` | Persist frontend CRUD table state | writes `crud_results` |
| GET | `/api/saved-results` | Read persisted CRUD state | reads `crud_results` |

### 4.4 Template workflow and design

| Method | Endpoint | Purpose | MongoDB read/write |
|---|---|---|---|
| POST | `/api/templates/create-entry` | Run create-template entry script | writes `test_reports`; writes `recordings` |
| POST | `/api/template-workflow/run` | Run full template workflow | writes `test_reports`; writes `recordings`; writes `template_workflow_states` (`lastRun`, optionally `lastPassed`) |
| GET | `/api/template-workflow/last-run` | Read last workflow state | reads `template_workflow_states` |
| GET | `/api/template-workflow/last-passed` | Read last successful workflow state | reads `template_workflow_states` |
| POST | `/api/template-design/run` | Run template design automation | writes `test_reports`; writes `recordings` |

### 4.5 Compliance endpoints

| Method | Endpoint | Purpose | MongoDB read/write |
|---|---|---|---|
| POST | `/api/compliance/run` | One-shot compliance run (sync request) | writes `test_reports`; writes `recordings` |
| POST | `/api/compliance/runs` | Start realtime compliance run (async) | writes `compliance_runs` snapshot store |
| GET | `/api/compliance/runs/:runId` | Poll one realtime run snapshot | reads `compliance_runs` memory snapshot |
| POST | `/api/compliance/runs/:runId/stop` | Request stop on active run | updates `compliance_runs` snapshot |
| GET | `/api/compliance/runs/:runId/stream` | SSE stream updates for one run | reads in-memory run snapshot; no direct Mongo write |

## 5. Detailed endpoint behavior

### 5.1 `POST /api/masters/fetch`

Main logic:

1. Resolve login credentials from request body or env.
2. Run `fetch-masters.js`.
3. Save masters into in-memory `mastersCache` and persist to `masters_cache`.
4. Sync embedded fields into `master_fields_cache`.
5. Optionally run `fetch-all-master-fields.js` and update `master_fields_cache`.
6. Finalize recording capture and persist recording metadata to `recordings`.

MongoDB impact:

- `masters_cache`: updated singleton document.
- `master_fields_cache`: bulk upsert + stale delete.
- `dependency_configs`: may be auto-saved for detected dropdown dependencies.
- `recordings`: replaced index with newest-first ordering.

### 5.2 `GET /api/masters/:masterName/fields`

Behavior:

- If cache exists and `refresh` is not true, returns cached fields.
- Otherwise runs `fetch-master-fields.js`, writes back to cache and Mongo.
- On failures, creates a failed report entry in `test_reports` with screenshot details when available.

MongoDB impact:

- success: writes `master_fields_cache` and possibly `dependency_configs`.
- failure: appends one entry to `test_reports`.

### 5.3 `POST /api/masters/:masterName/crud`

Behavior:

1. Validate operation (`create`, `update`, `delete`, `all`, `duplicate-check`).
2. Run `crud-master.js`.
3. Enforce strict audit verification logic when `verifyAuditTrail=true`.
4. Append per-operation report records (passed, failed, audit mismatch, audit verified).
5. Save recordings metadata.

MongoDB impact:

- multiple `test_reports` inserts per request.
- `recordings` index update.

### 5.4 `POST /api/masters/compare-field`

Behavior:

- Runs `compare-field-master.js`.
- Builds comparison summary and appends one pass/fail report entry.
- On exception, appends failed report with error and possible screenshot.

MongoDB impact:

- append into `test_reports`.
- update `recordings`.

### 5.5 `POST /api/masters/:masterName/validate-mandatory`

Behavior:

- Runs `validate-mandatory-fields.js`.
- Appends pass/fail report with mandatory-field summary.
- Persists recording metadata for playback.

MongoDB impact:

- append into `test_reports`.
- update `recordings`.

### 5.6 `POST /api/compliance/run`

Behavior:

- Runs one compliance suite execution (`DI`, `MD`, `AT`) using suite-specific runner.
- Supports running one case or all cases.
- Writes report entries per result and finalizes recordings.

MongoDB impact:

- append one or many records to `test_reports`.
- update `recordings`.

### 5.7 Realtime compliance APIs

Endpoints:

- `POST /api/compliance/runs`
- `GET /api/compliance/runs/:runId`
- `POST /api/compliance/runs/:runId/stop`
- `GET /api/compliance/runs/:runId/stream`

Behavior summary:

- Start endpoint creates `runId` and `clientToken`, initializes in-memory snapshot, and persists to `compliance_runs`.
- Background processor updates progress/results and saves each snapshot update.
- Stop endpoint marks stop requested, kills child process if possible, and persists updated status.
- SSE endpoint streams snapshots/events to authorized clients using `runId + clientToken`.

MongoDB impact:

- `compliance_runs` is upserted frequently while runs progress.
- Terminal run snapshots remain persisted for later polling.

### 5.8 Template workflow state endpoints

Endpoints:

- `POST /api/template-workflow/run`
- `GET /api/template-workflow/last-run`
- `GET /api/template-workflow/last-passed`

MongoDB impact:

- workflow run writes report + recording metadata.
- run state is persisted in `template_workflow_states` with `stateType=lastRun`.
- if run passes, `stateType=lastPassed` is also updated.

## 6. Storage-layer write strategy

Implementation in [backend/db/storage.js](backend/db/storage.js):

- `setMastersCache`: upsert singleton document.
- `setMasterFieldsMap`: bulk upsert by `masterName`, delete stale keys.
- `appendTestReport`: insert one report, then trim old docs beyond limit.
- `setRecordingsIndex`: full replace pattern (`deleteMany` then `insertMany`).
- `setComplianceRunsStore`: bulk upsert by `runId`, delete stale runs.
- `setDependencyConfig`: bulk upsert by `masterName`, delete stale configs.
- `setCrudResults`: upsert singleton `_id=latest`.
- `setTemplateWorkflowState`: upsert by `stateType`.

## 7. Indexes and why they matter

Indexes are created at startup (`ensureIndexes`):

- unique: `master_fields_cache.masterName`
- unique: `compliance_runs.runId`
- unique: `dependency_configs.masterName`
- unique: `template_workflow_states.stateType`
- sorting/query support: `test_reports.createdAt`, `recordings.createdAt`

These indexes support deterministic upserts, fast reads, and retention trimming patterns.

## 8. Error handling and consistency notes

- If a child script fails or outputs invalid JSON, the backend returns 500 and usually appends a failed `test_reports` record.
- Recording finalization is wrapped in safe error handling (`finalizeRecordingCaptureSafe`) so API responses can still complete even when artifact operations partially fail.
- Because many persistence calls are async, an immediate read-after-write can briefly return pre-update data in edge cases.
- On restart, `initStorage()` rehydrates state from MongoDB and marks previously running compliance runs as failed/interrupted.

## 9. Migration from legacy JSON files

Use [backend/scripts/migrate-json-to-mongo.js](backend/scripts/migrate-json-to-mongo.js):

```powershell
cd backend
npm run migrate:json-to-mongo:dry
npm run migrate:json-to-mongo
```

This script imports legacy data into the collections listed above and keeps artifact binaries on disk in `playwright-tests/test-reports`.
