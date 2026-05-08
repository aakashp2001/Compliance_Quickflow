# TestHive — QuickFlow Automation Suite

One-line: End-to-end automation dashboard and orchestration for QuickFlow using Playwright, an Express orchestrator, and a React dashboard.

## Table of Contents
- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Folder Structure](#folder-structure)
- [Backend Documentation](#backend-documentation)
- [Frontend Documentation](#frontend-documentation)
- [Testing](#testing)
- [Compliance & Security](#compliance--security)
- [Helpers & Utilities](#helpers--utilities)
- [Environment Variables & Configuration](#environment-variables--configuration)
- [Development Setup](#development-setup)
- [Deployment & CI/CD](#deployment--cicd)
- [Contribution Guidelines](#contribution-guidelines)
- [Changelog / Recent Changes](#changelog--recent-changes)
- [Known TODOs & Issues](#known-todos--issues)

---

## Architecture Overview

High-level architecture (frontend ↔ backend ↔ Playwright workers ↔ file storage):

```mermaid
graph TD
  FE[Frontend (React + Vite)]
  BE[Backend (Express orchestrator)]
  PW[Playwright test scripts]
  FS[File storage: backend/data + test-report-artifacts]

  FE -->|API calls| BE
  BE -->|spawn scripts (execFile)| PW
  PW -->|write artifacts| FS
  BE -->|read/write JSON| FS
  FE -->|download artifacts via backend| FS
```

For a detailed diagram and reasoning see [Docs/ARCHITECTURE.md](Docs/ARCHITECTURE.md).

---

## Tech Stack

- Frontend: React 18 (react ^18.3.1), Vite (vite ^5.4.8)
- Backend: Node.js + Express (express ^4.21.1), CORS (cors ^2.8.5)
- Automation: Playwright (@playwright/test ^1.44.0) — single-project Chromium configuration
- Storage: Local JSON files under `backend/data/` and artifact files in `playwright-tests/test-reports`

Where package versions are listed in `frontend/package.json`, `backend/package.json`, and `playwright-tests/package.json`.

---

## Folder Structure

Top-level folders and purpose:

- `backend/` — Express orchestrator, JSON-based persistence, artifact management, subprocess orchestration.
- `frontend/` — React dashboard (Vite) used to trigger scripts and inspect results.
- `playwright-tests/` — Playwright entry scripts, helpers, and per-test modules (the actual browser automation).
- `Docs/` — human-written documentation (this repo contains both authored docs and the generated docs).

Example tree (abridged):

```
backend/
  server.js                 # Express orchestrator
  data/                     # JSON persistence (test-reports.json, recordings.json, masters.json, master-fields.json, ...)
frontend/
  src/                      # React components and pages (TestReportPage.jsx, App.jsx, etc.)
playwright-tests/
  helpers/                  # formFiller, uiActions, auditTrail, discoverMasters, etc.
  compliance/               # compliance runner scripts
  *.js                      # entry scripts (crud-master.js, compare-field-master.js, fetch-masters.js...)
Docs/
  backend.md
  frontend.md
  playwright-tests.md
  ARCHITECTURE.md
  WHATS_NEW.md
```

---

## Backend Documentation

The backend is implemented in `backend/server.js`. It orchestrates Playwright scripts, persists results to disk, and serves artifacts.

### Main public endpoints

| Method | Path | Purpose | Notes |
|---|---:|---|---|
| GET | `/health` | Health check | Returns `{ status: 'ok' }` |
| GET | `/api/masters` | Get cached masters + masterFieldsCache | Returns `{ count, fetchedAt, masters, masterFieldsCache }` |
| POST | `/api/masters/fetch` | Runs `playwright-tests/fetch-masters.js` to discover masters | Accepts payload or uses env `QT_URL`, `QT_USER`, `QT_PASS` |
| GET | `/api/masters/:masterName/fields` | Get fields for a master (cache or live) | Query `?refresh=true` to force Playwright lookup |
| POST | `/api/masters/:masterName/crud` | Run CRUD operations (create/update/delete/all/duplicate-check) | Body: `{ operation, loginUrl, username, password, verifyAuditTrail, prefilledValues }` |
| POST | `/api/masters/:masterName/validate-mandatory` | Run mandatory-field validation script | Returns structured validation result and captures evidence |
| POST | `/api/masters/compare-field` | Compare a dropdown field vs a target master table | Body: { sourceMaster, targetMaster, fieldId/fieldName } |
| GET | `/api/test-reports` | Return persisted test report entries from `backend/data/test-reports.json` |
| GET | `/api/recordings` | Return recordings index + snapshot of artifact files |
| GET | `/api/dependency-config` | Get dependency config (`playwright-tests/helpers/dependent-dropdowns.json`) |
| PUT | `/api/dependency-config/:masterName` | Save parent/dependent mapping for a master |
| POST | `/api/save-results` | Save CRUD results snapshot as `backend/data/crud-results.json` |

Notes:
- Authentication: none enforced; credentials for QuickFlow are passed via request payloads or environment variables. Be mindful when running in shared environments.
- Rate limits: none implemented — the backend uses `execFile` and spawns Playwright scripts. You should avoid concurrent heavy runs unless you add queueing.

### Persistence / Data files (location: `backend/data/`)
- `test-reports.json` — array of saved test-report objects (id, masterName, operation, status, reason, logs, screenshotUrl, createdAt, etc.).
- `recordings.json` — index of saved recordings metadata (id, name, url, title, kind, masterName, operation, createdAt, sizeBytes).
- `masters.json` — cached masters list and embedded fields.
- `master-fields.json` — map of masterName => { fetchedAt, fields: [...] } used for form discovery and smart-filling.
- `crud-results.json` — frontend-saved run snapshots.

### Error handling & logging

- Playwright scripts are run as child processes. `stdout` is parsed as JSON; `stderr` is treated as human-readable debug logs. Backend expects well-formed JSON on stdout from scripts.
- Backend logs errors to console/stderr and returns 4xx/5xx responses with a `message` field when appropriate.

### Background jobs

- There are no background queueing systems. Long-running Playwright operations are invoked synchronously via `execFile`. Consider adding a queue (Redis/Bull) for production.

For deeper backend internals see [Docs/backend.md](Docs/backend.md).

---

## Frontend Documentation

The UI is a Vite + React app under `frontend/`.

- Entry: `frontend/src/main.jsx` → `App.jsx`.
- Key pages (components in `frontend/src/`):
  - `App.jsx` — app shell and page switching
  - `Sidebar.jsx` — navigation
  - `TestReportPage.jsx` — shows persisted test reports and recordings (now supports pagination and a `Compliance` filter)
  - `CrudPage.jsx` — create/update/delete operations UI
  - `TemplateWorkflowPage.jsx` — run template workflow flows
  - `RecordingsPage.jsx` — view and play test recordings

State management: local component state with `useState` and `useEffect`. No global store (Redux) is used.

Styling: plain CSS in `frontend/src/styles.css` and component-scoped class names.

API client: `frontend/src/api/client.js` — thin fetch-wrapper exposing functions: `getMasters()`, `fetchMasters()`, `getMasterFields()`, `runCrudOperation()`, `getTestReports()`, `getRecordings()`, `compareFieldMaster()`, etc.

Recent UI changes: The Test Report page includes a new `Compliance` filter (operations containing the text `compliance`) and pagination for reports and recordings (pages, First/Prev/Next/Last controls).

For a component-level reference see [Docs/frontend.md](Docs/frontend.md).

---

## Testing

### Playwright E2E

- Location: `playwright-tests/`
- Runner: `@playwright/test` configured in `playwright.config.js`.
- Key scripts in `playwright-tests/`: `crud-master.js`, `fetch-masters.js`, `fetch-master-fields.js`, `compare-field-master.js`, `validate-mandatory-fields.js`, and compliance suites under `playwright-tests/compliance/`.

Run the full test suite (requires `@playwright/test`):

```bash
cd playwright-tests
npm install
npm run test
```

For interactive/debugging runs use:

```bash
npm run test:headed
npm run test:interactive
```

Playwright configuration uses `video: 'retain-on-failure'` and `screenshot: 'only-on-failure'` to capture evidence.

Unit & integration tests: there are no dedicated unit test suites in `frontend/` or `backend/` in this repo — Playwright is the primary test harness.

---

## Compliance & Security

- Compliance tests live in `playwright-tests/compliance/` and are executed via `compliance-runner.js`. They focus on Data Integrity test-cases (attributability, legibility, mandatory enforcement, concurrent edits, etc.).
- Data privacy: test runs generate screenshots, video recordings, and JSON logs. Treat stored artifacts as sensitive if they contain PII. The repo does not encrypt or expunge artifacts automatically.
- Security: there is no authentication/authorization enforced on the UI/backend. If exposing externally, add an auth layer and secure storage.

---

## Helpers & Utilities

Key helper modules (Playwright helpers under `playwright-tests/helpers`):

- `uiActions.js` — navigation, login, common selectors
- `discoverMasters.js` — heuristics to find master pages
- `formDiscovery.js` — extract form field metadata from DOM and data objects
- `formFiller.js` — smart filler with heuristics and field type handling
- `smartFiller.js` — higher-level heuristics combining `formDiscovery` + `formFiller`
- `auditTrail.js` — audit verification helpers used by CRUD scripts and compliance runners

These helpers provide the reusable building blocks for Playwright entry scripts.

---

## Environment Variables & Configuration

Common env variables used by backend and Playwright scripts:

- `PORT` — backend port (default 8000)
- `QT_URL` — QuickFlow base URL (e.g. `https://ipdev.quickflow.in/login`)
- `QT_USER` / `QT_PASS` — credentials used by Playwright scripts when not provided in request payloads
- `QT_HEADLESS` — `true|false` (Playwright run headless)
- `QT_RECORD_VIDEO` — `true|false` (enable video recording)
- `VITE_API_BASE_URL` — frontend build-time API base url

Frontend env configuration: set `VITE_API_BASE_URL` in `.env` or use `import.meta.env` during dev.

---

## Development Setup

1. Backend

```bash
cd backend
npm install
npm run dev   # node --watch server.js
```

2. Frontend

```bash
cd frontend
npm install
npm run dev   # starts vite dev server
```

3. Playwright tests

```bash
cd playwright-tests
npm install
npm run test
```

Notes:
- Before running Playwright scripts, ensure `QT_URL`, `QT_USER`, `QT_PASS` are set either as environment variables or passed in the request payloads from frontend.

---

## Deployment & CI/CD

- This repo has no production Dockerfile or CI pipeline configured by default. The recommended production changes are:
  - Add a process queue (Redis + Bull) for long-running Playwright tasks
  - Add authentication in front of the Express server
  - Use object storage (S3) for artifacts instead of local disk
  - Run Playwright in a self-hosted runner with required browser binaries

See [Docs/ARCHITECTURE.md](Docs/ARCHITECTURE.md) for decision notes.

---

## Contribution Guidelines

- Create a branch per feature/bugfix
- Keep Playwright entry scripts deterministic and emit machine-parsable JSON on `stdout` and logs on `stderr`.
- If adding new artifact types, update the artifact snapshot helpers in `backend/server.js`.

---

## Changelog / Recent Changes

See [Docs/WHATS_NEW.md](Docs/WHATS_NEW.md) for recent additions and notable changes.

---

## Known TODOs & Issues

- Add a Dockerfile and Kubernetes/compose-based local recipe for reproducible runs.
- Add CI to run a subset of Playwright tests (smoke tests) on PRs.
- Consider adding authentication and encrypted artifact storage for PII safety.

---

If you want, I can now:
- generate more granular docs (API spec / OpenAPI),
- add a Dockerfile and a simple CI example, or
- run the frontend/backend locally and smoke-test the UI pages.
