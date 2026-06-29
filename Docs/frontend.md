# Frontend

Overview
--------

The frontend is a Vite + React application located in `frontend/`. It provides the dashboard for running automation, viewing test reports, and playing artifact recordings.

Key files & components
----------------------

- `frontend/src/main.jsx` — app entry.
- `frontend/src/App.jsx` — top-level app layout and routing.
- `frontend/src/Sidebar.jsx` — navigation menu.
- `frontend/src/TestReportPage.jsx` — lists saved test reports and recordings; recently updated with a `Compliance` filter and client-side pagination.
- `frontend/src/api/client.js` — thin API client used across pages to call backend endpoints.
- `frontend/src/styles.css` — base styles.

Running in development
----------------------

```powershell
cd frontend
npm install
npm run dev
```


# Frontend

Overview
--------

The frontend is a Vite + React single-page application located in `frontend/`. It uses `react-router-dom` for navigation (see [frontend/src/main.jsx](frontend/src/main.jsx)) and provides a UI for master discovery, running automation, and viewing test reports and recordings.

Key files & components
----------------------

- App bootstrap: [frontend/src/main.jsx](frontend/src/main.jsx) — mounts the App inside `BrowserRouter`.
- Top-level: [frontend/src/App.jsx](frontend/src/App.jsx) — declares routes and wires pages.
- API client: [frontend/src/api/client.js](frontend/src/api/client.js) — thin wrapper around fetch used by all pages.
- Pages: `CrudPage.jsx`, `TestReportPage.jsx`, `MandatoryFieldsPage.jsx`, `RecordingsPage.jsx`, `DuplicateCheckPage.jsx`, `TemplateWorkflowPage.jsx`, `CompliancePage.jsx` (all under `frontend/src/`).
- UI: `Sidebar.jsx` and a handful of small components under `frontend/src/components/`.

Run & build
-----------

Development and build commands:

```powershell
cd frontend
npm install
npm run dev

# Build for production
npm run build
# Serve dist/ with nginx or any static server
```

Environment
-----------

- `VITE_API_BASE_URL` — the HTTP base URL used by the SPA to contact the backend (e.g. `http://localhost:8000`). Set this in a `.env` file during development or in your hosting environment for production.

Routing & state
----------------

- The app uses `react-router-dom` to manage the main pages; routes are defined in [frontend/src/App.jsx](frontend/src/App.jsx).
- The code uses local React state (`useState`, `useEffect`) and small amounts of localStorage (key: `masterFieldsCacheV1`) to cache discovered master field metadata on the client.

Primary user flows
------------------

- Master Discovery: the Discovery page lets you fetch masters from a QuickFlow instance (`POST /api/masters/fetch`) and optionally fetch form fields inline. The page also attempts to auto-match select-type fields to likely target masters using alias scoring (see `buildFieldAliases` / `scoreAliasMatch` in [frontend/src/App.jsx](frontend/src/App.jsx)).
- CRUD Runs: `CrudPage` triggers `POST /api/masters/:masterName/crud` to perform create/update/delete/duplicate-check flows and shows per-run results. Results are cached client-side and also posted to the backend via `POST /api/save-results` to persist across reloads.
- Test Reports: `TestReportPage` fetches `GET /api/test-reports` and provides filtering and pagination client-side. For large datasets consider server-side pagination in the backend.
- Recordings: `RecordingsPage` lists videos from `GET /api/recordings` and plays `.webm` artifacts served by the backend (`/test-report-artifacts`).

Developer notes & gotchas
-------------------------

- Auto-matching logic: the Discovery page contains heuristic alias matching to suggest target masters for select-type fields. If you modify naming conventions or data shapes, update `buildFieldAliases` and `scoreAliasMatch` in [frontend/src/App.jsx](frontend/src/App.jsx).
- Error handling: the API client functions in [frontend/src/api/client.js](frontend/src/api/client.js) throw `Error` with message text extracted from the backend response. Wrap calls with `try/catch` in pages.
- No global state manager: the project intentionally avoids Redux/MobX — state is passed via props and localStorage caching.

If you want, I can add a small diagram and a short quickstart for contributors (how to run frontend + backend + Playwright locally). Want that added?
### 2.3. Pages (Views)
Each page represents a specific testing capability.

#### `CrudPage.jsx`
- **Purpose**: Triggers end-to-end CRUD (Create, Read, Update, Delete) flows.
- **Key States**:
  - `config`: Form state for login credentials and test toggles (`verifyAuditTrail`, `runMandatoryAfterCrud`).
  - `dependencyDraft`: State mapping parent dropdowns to dependent dropdowns (e.g., Country -> State).
  - `results`: An array of execution histories for the current session.
- **Workflow**:
  1. User selects a master -> `loadDependencyEditorData()` fetches the form fields and existing dependency config from the backend.
  2. User clicks Run -> `handleRun()` sets a "running" placeholder in the table.
  3. `handleRun()` calls `runCrudOperation()` API.
  4. Once CRUD finishes, if user toggled post-checks, `runPostCrudChecks()` invokes mandatory/duplicate checks sequentially.
  5. The `results` array is updated and persisted via `localStorage` and `POST /api/save-results` to survive page reloads.

#### `TestReportPage.jsx`
- **Purpose**: Displays the global, historical log of all test executions served by the backend from the `test_reports` MongoDB collection via the `/api/test-reports` endpoint.
- **Features**: Filtering by pass/fail status. Displays Playwright failure screenshot links if a run failed.

#### `MandatoryFieldsPage.jsx`
- **Purpose**: Triggers `POST /api/masters/:masterName/validate-mandatory`. Verifies if forms correctly implement required field validation.

#### `DuplicateCheckPage.jsx`
- **Purpose**: Specialized UI to trigger `POST /api/masters/:masterName/crud` with `{ operation: 'duplicate-check' }`.

#### `RecordingsPage.jsx`
- **Purpose**: Fetches the video registry from `GET /api/recordings`.
- **Features**: Displays an HTML `<video>` player for the generated `.webm` Playwright artifacts hosted dynamically by the backend (`/test-report-artifacts/*`).

#### `TemplateWorkflowPage.jsx`
- **Purpose**: Specialized UI for orchestrating the creation and linkage of complex multi-step template structures (App -> Site -> Template -> Sub-Template -> Workflow).
- **Features**: Starts the full template workflow via `POST /api/template-workflow/run`. The page also reads `GET /api/template-workflow/last-run` and `GET /api/template-workflow/last-passed` to show resume state and the most recent successful run. The backend persists `lastRun` / `lastPassed` to the `template_workflow_states` collection so the UI can offer a "resume" or inspection view.

### 2.4. HTTP Client (`src/api/client.js`)
This is a pure JavaScript module exporting `async` functions. It uses standard `fetch()`.
- **Error Handling**: Every function checks `!response.ok` and throws an `Error` containing the backend's error message, ensuring consistent `try/catch` blocks in the React components.
- **Key Functions**:
  - `fetchMasters(payload)`: Triggers a live IPDEV master fetch.
  - `getMasters()`: Fetches cached masters.
  - `getMasterFields(masterName, options)`: Fetches fields for a specific master.
  - `runCrudOperation(masterName, payload)`: The primary test execution hook.
  - `runTemplateFullWorkflow(payload)`: The orchestrator hook for complex multi-step template creation.
  - `compareFieldMaster(payload)`: The data consistency test hook.
  - `saveDependencyConfig(masterName, payload)`: Saves dropdown mappings.

---

## 3. LLM Contextual Gotchas
- **State Persistence**: The application tries to preserve transient state (like CRUD results) using both `localStorage` and the backend `POST /api/save-results` endpoint. This happens in `persistResults()` inside `CrudPage.jsx`.
- **Alias Matching**: In `App.jsx`, there is a complex `matchedTargetMaster` `useMemo` block that uses fuzzy string matching (via `scoreAliasMatch`) to auto-guess which master data table corresponds to a specific dropdown field (e.g., guessing that a field named "Timezone" links to the "Timezone Master"). When editing logic here, preserve the alias matching logic.
- **Routing**: Do not attempt to use or import `react-router`. Navigation is purely handled by `display: block/none` applied to `<div>` elements wrapped around components in `App.jsx`.
