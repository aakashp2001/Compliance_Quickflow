# QuickFlow Automation Project Guide

## 1. Why this project exists

This repository is a combined UI + automation project used to test a QuickFlow-based website.

It has three big parts:

1. A frontend dashboard where a user can trigger actions and view results.
2. A backend API server that receives those requests and coordinates the work.
3. A Playwright automation layer that opens the real website in a browser and performs the actual testing.

The most important part of this project is the Playwright layer, because that is where the real browser automation happens.


## 2. Technology used in this repo

### Frontend

- React 18
- Vite
- Plain JavaScript
- CSS

### Backend

- Node.js
- Express
- CORS
- child_process.execFile to run Playwright scripts as subprocesses

### Automation

- Playwright using `@playwright/test`
- Chromium browser automation

### Storage style

- In-memory cache for some runtime data in backend
- JSON file storage for test reports and dependency configuration
- Screenshot files saved to disk


## 3. High-level architecture

The easiest way to understand the project is:

- Frontend = control panel
- Backend = orchestrator
- Playwright scripts = workers
- JSON files + screenshots = saved evidence

The normal flow is:

1. User clicks something in the frontend.
2. Frontend sends an API request to backend.
3. Backend decides which Playwright script to run.
4. Backend passes input values through environment variables.
5. Playwright script launches Chromium and performs the real website actions.
6. Script returns structured JSON to stdout.
7. Script writes detailed logs to stderr.
8. Backend reads both, saves report data if needed, and returns result to frontend.
9. Frontend shows the result or the saved report.


## 4. Root-level folder purpose

### `frontend/`

Contains the operator dashboard UI.

### `backend/`

Contains the Express server and report persistence logic.

### `playwright-tests/`

Contains all automation logic, helper modules, direct Playwright tests, and evidence files.

### `Docs/`

Contains project documentation. This guide is stored here.

### `.venv/`

Python virtual environment. It is not part of the main frontend/backend/Playwright flow.

### `template-automation/`

A separate folder present in the repo root. It is not part of the core frontend/backend/Playwright flow described in this guide.


## 5. Frontend: how it works

The frontend is a React single-page application.

It does not itself perform browser automation. It only:

- collects user input
- sends API requests
- shows returned data
- displays saved reports and screenshots

### Frontend startup flow

1. Vite serves the React app.
2. `index.html` loads `src/main.jsx`.
3. `main.jsx` renders `App` into the root DOM node.
4. `App` shows one of three pages based on sidebar selection.


## 6. Backend: how it works

The backend is an Express server.

Its job is not to test the site directly. Its job is to coordinate and manage testing.

This is why the backend is called the orchestrator.

The backend:

- exposes API routes for the UI
- launches the correct Playwright script
- passes the runtime inputs through env vars
- reads structured JSON output from stdout
- reads human-readable debug logs from stderr
- saves reports and screenshots
- serves stored report artifacts to the frontend


## 7. Playwright: how it is used here

Playwright is the real test execution engine in this repo.

It is used to:

- launch Chromium
- open the QuickFlow site
- log in with credentials
- navigate to pages
- inspect forms and tables
- create, update, and delete records
- verify audit trail reports
- compare dropdown options with master table data
- capture screenshots on failure

### Important design choice in this repo

Each major operation is placed in a separate Node script inside `playwright-tests/`.

The backend runs those scripts using `execFile`.

These scripts follow a common pattern:

1. read input from environment variables
2. launch Playwright browser
3. perform the flow
4. write a JSON result to stdout
5. write logs and diagnostics to stderr

This pattern is important because it lets the backend separate machine-readable output from human-readable logs.


## 8. Main user flows

### Flow A: Fetch masters from the website

Purpose: discover all master pages dynamically from the app navigation.

Steps:

1. User clicks "Fetch Masters from IPDEV" in the frontend.
2. Frontend calls backend `/api/masters/fetch`.
3. Backend runs `playwright-tests/fetch-masters.js`.
4. Script logs in using Playwright.
5. Script calls `discoverMasters()` from `helpers/discoverMasters.js`.
6. That helper reads nav links, filters out system routes, visits candidate routes, and checks whether a page behaves like a master page.
7. Script returns the discovered masters as JSON.
8. Backend caches them in memory.
9. Frontend displays them in the dropdown.

### Flow B: Load fields for one master

Purpose: understand what form fields exist on a selected master.

Steps:

1. Frontend asks backend for `/api/masters/:masterName/fields`.
2. Backend runs `playwright-tests/fetch-master-fields.js` if cache is empty or refresh is requested.
3. Script logs in and opens the selected master page.
4. Script opens the Create form.
5. Script inspects `window.data` plus the DOM.
6. `helpers/formDiscovery.js` converts that information into a stable field model.
7. Backend returns the field list.
8. Frontend shows the field dropdown.

### Flow C: Save dependency mapping

Purpose: tell the smart filler which dropdowns are parent fields and which are dependent child fields.

Steps:

1. User selects parent and dependent fields in CRUD page.
2. Frontend calls backend `PUT /api/dependency-config/:masterName`.
3. Backend writes the values into `playwright-tests/helpers/dependent-dropdowns.json`.
4. Later, the smart filler reads this file to know how to handle dependent dropdowns.

### Flow D: Compare a dropdown against another master

Purpose: verify that a select field contains the same values as a target master table.

Steps:

1. Frontend detects that a chosen field is select-like.
2. It guesses the target master using name similarity.
3. It calls backend `/api/masters/compare-field`.
4. Backend runs `playwright-tests/compare-field-master.js`.
5. Script opens the source master form and reads dropdown options.
6. Script navigates to the target master and scrapes table values.
7. Script compares both sets and returns a comparison report.
8. Frontend renders match/mismatch results.

### Flow E: Run CRUD for one master

Purpose: create, update, delete, or run all three in sequence.

Steps:

1. User chooses a master and operation in the CRUD page.
2. Frontend calls backend `/api/masters/:masterName/crud`.
3. Backend runs `playwright-tests/crud-master.js`.
4. Script logs in and opens the chosen master page.
5. Depending on operation:
   - create: open form, discover fields, smart-fill, save
   - update: open first record, fill changed values, save with reason
   - delete: delete first record, handle confirmation and reason modal
   - all: run create, then update, then delete
6. If audit verification is enabled, the script also verifies audit report entries.
7. The script returns JSON result and detailed logs.
8. Backend saves failure or mismatch entries into test report storage.
9. Frontend shows the immediate run result, and Test Report page shows the persisted evidence.

### Flow F: Audit trail verification

Purpose: verify that CRUD actions appear correctly in the audit trail system.

Steps:

1. `crud-master.js` calls `verifyAuditTrailEntry()` from `helpers/auditTrail.js`.
2. Playwright opens the Audit Trails module.
3. It searches across all configured left-panel audit categories.
4. It filters the report list for the selected master audit report.
5. It opens the matching report, even if it appears in popup or iframe.
6. It fills the "Performed on" range.
7. It clicks Execute.
8. It searches the table by record identifier, operation, and optional reason.
9. It opens the audit detail view if available.
10. It compares expected values against the audit content.
11. It returns verified or mismatch details.
12. If comparison fails, a screenshot is captured and included in the report.

### Flow G: Test report viewing

Purpose: show saved failures and audit mismatches.

Steps:

1. Frontend Test Report page calls `/api/test-reports`.
2. Backend reads `backend/data/test-reports.json`.
3. Backend returns the saved entries.
4. Frontend formats operation, reason, logs, screenshot link, and thumbnail.


## 9. Detailed Playwright design

This section focuses on how Playwright scripts are structured.

### 9.1 Why separate scripts are used

Instead of one huge script that does everything, the repo uses different entry scripts for different actions.

That gives these benefits:

- easier backend routing
- easier debugging
- easier direct command-line execution
- clearer responsibility per script

### 9.2 Standard Playwright lifecycle in this repo

Most entry scripts do this:

1. Read environment variables.
2. Launch Chromium with `chromium.launch()`.
3. Create a browser context.
4. Create a page.
5. Log in to QuickFlow.
6. Perform the target task.
7. Write JSON to stdout.
8. Close context and browser.

### 9.3 Why stdout and stderr are separated

This is a very important pattern in this project.

- stdout = structured JSON result for backend to parse
- stderr = console logs and diagnostics for human debugging

That allows the backend to both:

- consume reliable machine output
- preserve readable logs for report and troubleshooting

### 9.4 What is generic vs hardcoded

The Playwright automation is not hardcoded for every master individually.

Generic parts:

- auto-discovering masters
- discovering form fields from metadata and DOM
- smart-filling fields using label/type heuristics
- generic create/update/delete runner
- generic audit verification pipeline

Hardcoded parts:

- QuickFlow-specific selectors like login fields and save button ids
- QuickFlow-specific routes like `/Audit-Trails`
- text patterns like Create, Save, Execute, Submit
- audit category names
- field value heuristics such as department, country, equipment pools

So the framework is generic for QuickFlow masters, but it is still strongly coupled to QuickFlow UI structure.


## 10. File-by-file reference

This section explains the role of each important file and module in basic language.

### 10.1 Frontend files

#### `frontend/index.html`

HTML shell used by Vite. It only provides the root div where React mounts.

#### `frontend/package.json`

Frontend package metadata and scripts:

- `dev` runs Vite dev server
- `build` creates production bundle
- `preview` previews production build

#### `frontend/vite.config.js`

Vite configuration.

Important behavior:

- enables React plugin
- opens dev server on port 5173
- proxies `/api` and `/health` to backend
- logs proxy traffic in terminal

#### `frontend/.env.example`

Example env file for frontend.

Important values:

- `VITE_API_BASE_URL`
- `VITE_PROXY_TARGET`

#### `frontend/src/main.jsx`

Frontend entry point. Imports global CSS and renders `App`.

#### `frontend/src/App.jsx`

Main application component.

Contains:

- page switching logic
- Discovery page implementation
- selected master and selected field logic
- auto-matching of select fields to likely master names
- compare result rendering

#### `frontend/src/Sidebar.jsx`

Left navigation component.

Lets user switch between:

- Master Discovery
- CRUD Operations
- Test Report

#### `frontend/src/CrudPage.jsx`

CRUD control UI.

Responsibilities:

- load masters from backend
- choose operation
- toggle browser visibility and audit verification
- edit dependency mapping
- trigger CRUD runner
- display run results

#### `frontend/src/TestReportPage.jsx`

Report viewer UI.

Responsibilities:

- load persisted test report rows
- normalize reason text
- format operation labels
- show logs as bullet points
- show screenshot links and thumbnails

#### `frontend/src/api/client.js`

Shared frontend API layer.

Responsibilities:

- wraps `fetch`
- normalizes JSON/text response handling
- throws readable errors
- provides named methods for all backend endpoints

#### `frontend/src/styles.css`

Global stylesheet for all frontend pages.

Contains layout, grid, sidebar, compare card, CRUD form, report table, logs view, and responsive styling.


### 10.2 Backend files

#### `backend/package.json`

Backend package metadata and scripts.

- `start` runs `server.js`
- `dev` runs `server.js` in watch mode

#### `backend/server.js`

Main backend orchestrator.

Main responsibilities:

- health endpoint
- masters cache
- master fields cache
- dependency config read/write
- test report read/write
- static screenshot serving
- launching all Playwright scripts
- normalizing errors and logs
- appending test report entries with reason and logs

This is the central coordination file in the entire repo.

#### `backend/data/test-reports.json`

Persistent JSON storage of saved report rows.

Each row can contain:

- id
- masterName
- operation
- status
- reason
- logs
- screenshotUrl
- screenshotFile
- error
- timestamps
- mismatch detail arrays


### 10.3 Playwright entry scripts

#### `playwright-tests/package.json`

Package metadata for Playwright layer.

Scripts:

- `test`
- `test:headed`
- `test:report`
- `test:interactive`

#### `playwright-tests/playwright.config.js`

Configuration for direct Playwright test runs.

Important settings:

- serial execution (`workers: 1`)
- HTML reporter
- screenshots/videos on failure
- baseURL set to QuickFlow host

#### `playwright-tests/fetch-masters.js`

Logs in and discovers master pages dynamically using `discoverMasters()`.

Used by backend master discovery endpoint.

#### `playwright-tests/fetch-master-fields.js`

Logs in, opens one master form, and extracts field definitions.

Used by backend field-loading endpoint.

#### `playwright-tests/compare-field-master.js`

Compares dropdown options from one master form against records from another master.

Used by backend compare endpoint.

#### `playwright-tests/create-template-entry.js`

Automation entry for Create Template page.

Logs in, finds template creation route, fills fields, saves entry, and returns result.

#### `playwright-tests/crud-master.js`

Main CRUD automation runner used by the frontend through backend.

Responsibilities:

- login
- navigate to selected master
- create/update/delete/all flows
- manage modal handling and save verification
- capture failure screenshots
- call audit verification helper
- return structured summary

This is the most important Playwright file for day-to-day use.

#### `playwright-tests/test_equipment_audit.js`

Very small convenience wrapper that sets environment variables and then runs `crud-master.js` for a specific master and mode.

Useful as a one-off manual runner.

#### `playwright-tests/interactive-master-test.js`

Interactive command-line helper script.

Lets a developer:

- log in interactively
- discover masters
- choose one
- inspect fields
- validate dropdown options against likely master tables

This is more of a manual inspection tool than a backend-driven worker.

#### `playwright-tests/masters.config.js`

Static config list used by `all-masters.spec.js`.

Contains:

- list of masters to test
- default user
- update/delete counts
- review workflow options

#### `playwright-tests/all-masters.spec.js`

Direct Playwright test suite that runs a full lifecycle on each master listed in `masters.config.js`.

This is separate from the backend-driven CRUD API flow.

#### `playwright-tests/auto-masters.spec.js`

Direct Playwright test suite that auto-discovers masters instead of relying on a manual list.

Also separate from the backend-driven UI flow.


### 10.4 Playwright helper modules

#### `playwright-tests/helpers/discoverMasters.js`

Reads the navigation structure, filters non-master routes, and decides whether candidate pages are master pages.

This is the dynamic discovery brain of the project.

#### `playwright-tests/helpers/formDiscovery.js`

Builds a normalized model of form fields by combining metadata from `window.data` with actual DOM inspection.

It identifies:

- field name
- field id
- element type
- required flag
- max length
- options
- dependency hints

#### `playwright-tests/helpers/formFiller.js`

Low-level field interaction library.

Responsibilities:

- scroll field into view
- fill text inputs
- select dropdown values
- read values back
- wait for dependent fields to populate

This is the mechanical input engine.

#### `playwright-tests/helpers/smartFiller.js`

Higher-level field filling logic on top of `formFiller.js`.

Responsibilities:

- choose good sample values based on field labels and types
- avoid duplicates using a run stamp
- read dependency config
- fill parent dropdowns before dependent ones
- repair required fields in retries

This is the intelligent data-generation layer.

#### `playwright-tests/helpers/auditTrail.js`

Audit report navigation and verification engine.

Responsibilities:

- open audit module
- search categories and reports
- handle popup or iframe report rendering
- fill performed-on date range
- click Execute
- locate target audit row
- open detail view
- compare expected vs actual values
- capture mismatch screenshots

This is the most important helper after `crud-master.js`.

#### `playwright-tests/helpers/dependent-dropdowns.json`

Configuration file storing known parent and dependent dropdown relationships per master.

Used by `smartFiller.js`.


### 10.5 Generated and runtime files

These files are not logic modules, but they are part of how the project runs.

#### `playwright-tests/test-reports/`

Stores screenshots captured on failure or audit mismatch.

#### `playwright-tests/playwright-report/`

Stores Playwright HTML reports for direct test-suite runs.

#### `playwright-tests/test-results/`

Stores raw Playwright test result artifacts for direct spec runs.

#### `package-lock.json` files

Auto-generated dependency lock files. They are not handwritten logic.

#### `node_modules/`

Installed third-party packages.


## 11. How the CRUD runner really works internally

This section explains the most important runtime path in simple steps.

### Create

1. Open master page.
2. Open Create offcanvas.
3. Discover stable form fields.
4. Smart-fill all usable fields.
5. Save the form.
6. Detect success by API response and UI signals.
7. Infer record identifier.
8. If audit is enabled, verify audit entry.

### Update

1. Open first record for edit.
2. Discover fields again.
3. Smart-fill changed values.
4. Save with update reason if required.
5. Verify API and UI success.
6. If audit is enabled, verify audit entry including reason.

### Delete

1. Read first record name.
2. Click row-scoped delete action if possible.
3. Handle reason modal and confirmation modal.
4. Confirm success from API and table change.
5. If audit is enabled, verify delete audit entry.

### All

Runs create, update, delete in sequence.

If one step fails:

- failure is recorded
- screenshot is captured
- later steps may continue when operation mode is `all`


## 12. How audit verification really works internally

Audit verification is not just a string search.

It does multiple checks.

### Step 1: Build expected evidence

From CRUD action, the code builds:

- operation type
- master name and display form
- record identifiers
- reason text
- preferred changed field values

### Step 2: Find the correct report

The helper:

- opens audit module
- checks multiple audit categories
- filters report list by selected master
- opens the matching report page

### Step 3: Resolve actual interaction context

Some audit pages load inside:

- popup windows
- iframes
- inner report frames

The helper scores contexts and chooses the one that contains the real filter UI.

### Step 4: Apply date range and execute

It fills the performed-on date filters and clicks Execute.

### Step 5: Find target row

It searches using:

- record identifier
- reason
- operation keyword

### Step 6: Open details and compare

If detail popup exists, it extracts field rows and compares:

- expected values from form input
- actual values from audit detail

### Step 7: Return structured result

It returns:

- verified true or false
- missing evidence
- comparison details
- mismatch lists
- screenshot path if relevant


## 13. Why this project is useful

This project is valuable because it combines:

- a user-friendly control UI
- reusable backend orchestration
- dynamic Playwright discovery
- detailed audit validation
- persistent evidence and logs

It is not just a simple test script collection.
It is a small testing platform built around Playwright.


## 14. Key limitations and assumptions

Like any automation framework, this repo has assumptions.

Main assumptions include:

- QuickFlow UI selectors remain stable
- login flow remains similar
- save/update/delete button patterns remain similar
- audit report UI keeps the same general structure
- the app exposes enough metadata through DOM and `window.data`

If those assumptions change, the helper modules are the first place that usually needs updates.


## 15. Best files to read first if someone is new

If someone wants to understand this repo quickly, the best order is:

1. `backend/server.js`
2. `playwright-tests/crud-master.js`
3. `playwright-tests/helpers/auditTrail.js`
4. `playwright-tests/helpers/formDiscovery.js`
5. `playwright-tests/helpers/smartFiller.js`
6. `frontend/src/CrudPage.jsx`
7. `frontend/src/TestReportPage.jsx`

That order gives the clearest picture of the real flow.


## 16. Final summary

This repository is a QuickFlow automation platform made of:

- a React dashboard for triggering and viewing test activity
- an Express backend that orchestrates script execution and stores evidence
- a Playwright automation layer that performs actual browser-based testing

The Playwright layer is the heart of the system.

It is used to:

- discover masters
- discover fields
- fill forms intelligently
- run CRUD operations
- verify audit trail entries
- compare dropdown values with master data
- capture screenshots and detailed logs

The frontend and backend are there to make that automation easier to run, easier to inspect, and easier to maintain.