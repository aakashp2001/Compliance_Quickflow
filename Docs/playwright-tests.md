# Playwright Tests

Overview
--------

All Playwright automation code lives under `playwright-tests/`. The folder contains entry scripts, multiple test suites (including `compliance/`), and helper utilities used to discover forms, fill fields, and validate audit trails.

Quick run steps
---------------

```powershell
cd playwright-tests
npm install
npx playwright install    # install browser binaries
# Run an entry script directly:
QT_URL="https://..." QT_USER=qa QT_PASS=secret node fetch-masters.js

# Or run test runner scripts if present:
npx playwright test
```

Entry scripts
-------------

Entry scripts are simple Node programs that use Playwright APIs and typically emit machine-readable JSON on `stdout` (which the backend parses). Example scripts include `crud-master.js`, `fetch-masters.js`, `compare-field-master.js`, and `validate-mandatory-fields.js`.

Helpers & structure
-------------------

-- `helpers/` contains reusable code: `formFiller.js`, `formDiscovery.js`, `smartFiller.js`, `discoverMasters.js`, `uiActions.js`, and `auditTrail.js`.
- Playwright configuration is defined in `playwright.config.js` — check `workers` and `timeout` settings before running heavy suites.

Output and artifacts
--------------------

Playwright scripts record screenshots and videos according to configuration (typically `retain-on-failure`). Scripts often write artifacts to a repo-local artifacts folder which the backend indexes and serves.


# Playwright Tests

Overview
--------

All automation logic lives under `playwright-tests/`. There are two complementary ways the project uses Playwright:

1. Short-lived standalone Node entry scripts (e.g. `crud-master.js`, `fetch-masters.js`) that are spawned by the backend via `execFile(process.execPath, [scriptPath])`. These are intended for on-demand runs and must emit exactly one machine-readable JSON payload to `stdout` at the end of execution.
2. A developer-focused Playwright test-runner setup (config in [playwright-tests/playwright.config.js](playwright-tests/playwright.config.js)) for running test suites locally with `npx playwright test`.

Quick start
-----------

```powershell
cd playwright-tests
npm install
npx playwright install

# Run a backend-style entry script directly (example):
QT_URL="https://..." QT_USER=qa QT_PASS=secret node fetch-masters.js

# Or use the Playwright test runner for spec-driven tests:
npx playwright test
```

Entry scripts vs test runner
----------------------------

- Entry scripts (examples: `crud-master.js`, `fetch-masters.js`, `compare-field-master.js`, `validate-mandatory-fields.js`) are executed as Node programs and are designed to be run by the backend. The backend expects:
  - Playwright diagnostic or step logs to be written to `stderr` (so they don't corrupt the JSON pipeline).
  - A single final JSON object written to `stdout` (this is parsed by the backend with `JSON.parse`).
- The Playwright test-runner configuration is primarily for developer convenience (parallelization, reporters, HTML report). The repo includes a Playwright config at [playwright-tests/playwright.config.js](playwright-tests/playwright.config.js).

Helpers & structure
-------------------

-- `playwright-tests/helpers/` contains shared utilities: `formFiller.js`, `formDiscovery.js`, `smartFiller.js`, `discoverMasters.js`, `uiActions.js`, and `auditTrail.js`.
- Entry scripts and helpers should avoid printing non-diagnostic JSON to `stdout` — use `process.stderr.write()` for logs and `process.stdout.write(JSON.stringify(result))` for the final payload.

Environment variables used by scripts
------------------------------------

- `QT_URL`, `QT_USER`, `QT_PASS` — target application login credentials.
- `QT_MASTER` — target master/module (e.g., `Country`, `App`).
- `QT_OP` — CRUD operation (`create`, `update`, `delete`, `all`, `duplicate-check`).
- `QT_HEADLESS` — `'true'`/`'false'` to control headless mode.
- `QT_VERIFY_AUDIT`, `QT_RECORD_VIDEO`, `QT_PREFILLED_VALUES` — additional run-time flags used by several entry scripts.

Artifacts & integration
-----------------------

- Playwright artifacts (videos and screenshots) are written under `playwright-tests/test-reports`. The backend finalizes and renames videos and indexes metadata via the storage layer; artifacts are served at `/test-report-artifacts`.
- For reliable backend parsing, scripts must ensure the final JSON is the last thing written to `stdout` and avoid writing HTML/large logs to `stdout`.

Playwright config
-----------------

- The test-runner config controls workers, timeouts, and reporters. The current config runs tests serially (`workers: 1`) by default because many flows depend on a shared login state. See [playwright-tests/playwright.config.js](playwright-tests/playwright.config.js).

Best practices
--------------

- Keep entry scripts idempotent and limited to a single unit of work so they can be spawned safely from the API.
- Use environment variables for credentials (do not hardcode secrets into scripts).
- Ensure the final payload is JSON and use `stderr` for human-readable debug logs.

If you want, I can add a short checklist into this doc that the backend expects from each entry script (stdout protocol, stderr usage, artifact naming conventions). Would you like that added?
  9. **Update/Delete**: Finds the newly created row in the datatable, clicks edit, modifies data, saves, and subsequently deletes the row.
- **Resilience**: It features custom logic like `dismissBlockingOverlays()` to automatically close intrusive SweetAlert popups (`.swal2-confirm`) that block interactions.

### 3.2. `fetch-masters.js`
Discovery script. Logs in and parses the application's DOM to extract the navigation hierarchy, returning a JSON array of `{ name, displayName, href }` objects representing all available modules the system can test.

### 3.3. `fetch-master-fields.js`
Form Introspection. Navigates to a specific master, clicks "Create", and uses `formDiscovery.js` to extract the metadata of every input field on the form (type, max length, mandatory status). This is returned to the UI to populate dropdowns.

### 3.4. `compare-field-master.js`
Data Consistency. Navigates to a form, finds a specific `<select>` dropdown, extracts all its `<option>` values. Then it navigates to the actual Master Table for that data type, scrapes the rows, and compares the lists. Output indicates missing, extra, or perfectly matched options.

### 3.5. `validate-mandatory-fields.js`
Negative Testing. Navigates to a master, clicks Create, and immediately clicks Save *without* filling the form. It then parses the DOM for validation error messages (`.text-danger`, `.invalid-feedback`) to verify that the UI enforces required fields.

---

## 4. Deep Dive: `helpers/` Directory
The true intelligence of the framework lies in the helpers, which abstract brittle DOM logic away from the runners.

### 4.1. `auditTrail.js`
Highly complex script handling application audit logs.
- `inferPrimaryRecordIdentifier(auditTrail)`: Tries to guess the primary key (Name, Code, ID) from a filled form payload.
- `verifyAuditTrailEntry(page, options)`: Navigates to the audit page, uses filters to narrow down the timeframe, and verifies that the exact values injected by `smartFiller.js` appear in the audit trail table.
- `captureAuditScreenshot()`: Captures evidence of audit failures.

### 4.2. `formDiscovery.js`
- `collectStableFormFields(page)`: Scans a form. It identifies elements not just by `<input type="...">` but by checking class names and adjacent labels to deduce semantic meaning (e.g., distinguishing a standard text input from a custom date picker or select2 component).
- `normalizeControlType()`: Normalizes bespoke application components into standard types (e.g., `text`, `select`, `multiselect`, `date`).

### 4.3. `smartFiller.js` & `formFiller.js`
The synthetic data generation engine.
- `smartFillOffcanvasForm()`: Loops over discovered fields.
-- Uses dependency configuration (persisted in the `dependency_configs` MongoDB collection) to ensure that if a form has a "Country" and "State" dropdown, it fills them in the correct hierarchical order so the State dropdown enables properly. Legacy `playwright-tests/helpers/dependent-dropdowns.json` data can be migrated using `backend/scripts/migrate-json-to-mongo.js`.
- Generates data based on heuristics: if a label contains "Phone", it generates 10 random digits. If it contains "Email", it generates a random `@example.com` string.

---

## 5. LLM Contextual Gotchas
- **Output Constraint**: All runner scripts MUST use `process.stdout.write(JSON.stringify(payload))` at the very end. Standard `console.log` is overridden in these scripts to pipe to `process.stderr.write` so it doesn't corrupt the JSON pipeline back to the Node.js backend.
- **Heuristic Selectors**: Because the target application (QuickFlow) dynamically generates forms, the scripts rarely use hardcoded IDs (`#firstName`). Instead, they rely heavily on XPath, adjacent label traversal, and visual cues (e.g., finding the closest `input` to a label containing the word "Name"). When editing Playwright locators, maintain this dynamic heuristic approach.
