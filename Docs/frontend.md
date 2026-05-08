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

Environment and build
---------------------

- `VITE_API_BASE_URL` controls the API base URL used by the frontend. For example, create a `.env` file containing `VITE_API_BASE_URL=http://localhost:8000`.
- To build a production bundle:

```powershell
npm run build
# Serve `dist/` with a static server (nginx, serve, etc.)
```

Notes on Test Report page
-------------------------

- The `TestReportPage` now supports:
  - A `Compliance` filter which selects reports whose `operation` contains `compliance` (case-insensitive).
  - Client-side pagination for reports and recordings with First/Prev/Next/Last controls.

- If your dataset grows large, consider switching to server-side pagination in the backend endpoints.
# Frontend Context & Architecture: TestHive

## 1. System Role & Overview
The `frontend` is a Single Page Application (SPA) built with React and Vite. It serves as the command center for the TestHive framework. It allows Quality Assurance (QA) engineers to configure targets, execute tests, and analyze the results of Playwright automation runs.

**Core Characteristics:**
- **No Global State Manager**: It uses local React state (`useState`, `useEffect`) and prop drilling.
- **No Complex Router**: It uses a simple state variable (`currentPage`) in `App.jsx` to conditionally hide/show `<div>` containers instead of using `react-router-dom`.
- **API Communication**: All backend communication is abstracted into a single HTTP client file (`src/api/client.js`).

---

## 2. Directory Structure & Key Files

### 2.1. Build & Configuration
- `vite.config.js`: Vite bundler configuration.
- `package.json`: Contains standard React scripts (`npm run dev`, `npm run build`).

### 2.2. Core Application (`src/`)
- `main.jsx`: Bootstraps the application, mounts `<App />` to `#root`.
- `styles.css`: A comprehensive, vanilla CSS file containing all styling rules (CSS variables, `.card`, `.btn`, `.status-ok`). **No CSS frameworks (like Tailwind or Bootstrap) are used.**
- `App.jsx`: The layout orchestrator.
  - Maintains `currentPage` state.
  - Maintains `sharedMasters` (the list of target applications/forms) and `sharedConfig` (login credentials).
  - Renders `<Sidebar />` and conditionally displays specific pages based on `currentPage`.
  - Also contains the `DiscoveryPage` component inline, which acts as the "Home" page where users fetch target masters and manage form field comparisons.

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
- **Purpose**: Displays the global, historical log of all test executions from the backend's `test-reports.json` database.
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
- **Features**: Triggers the `POST /api/templates/full-workflow` endpoint and provides a dedicated status table for tracing each step in the complex sequence.

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
