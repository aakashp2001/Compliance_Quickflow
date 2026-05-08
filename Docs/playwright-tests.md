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

- `helpers/` contains reusable code: `formFiller.js`, `formDiscovery.js`, `smartFiller.js`, `discoverMasters.js`, `uiActions.js`, and `auditTrail.js`.
- Playwright configuration is defined in `playwright.config.js` — check `workers` and `timeout` settings before running heavy suites.

Output and artifacts
--------------------

Playwright scripts record screenshots and videos according to configuration (typically `retain-on-failure`). Scripts often write artifacts to a repo-local artifacts folder which the backend indexes and serves.

Best practices
--------------

- Export credentials via environment variables or pass them in the request body when invoked from the backend.
- Keep entry scripts idempotent and ensure they return JSON on stdout for reliable backend parsing.
# Playwright Tests Context & Architecture: TestHive

## 1. System Role & Overview
The `playwright-tests` directory contains the automation engine. Unlike typical Playwright setups where tests are run via `npx playwright test` in a CI/CD pipeline, these scripts are designed to be executed dynamically as **standalone Node.js child processes** by the Express backend.

**Core Data Flow:**
1. Express Backend spawns `node fetch-masters.js` (passing environment variables).
2. The script launches Chromium, automates the UI, and gathers data.
3. The script writes `console.log` messages to `stderr` (for terminal debugging).
4. Upon completion, the script writes exactly one JSON payload to `stdout`.
5. The backend parses `stdout` and forwards it to the React UI.

---

## 2. Environment Variables Integration
These scripts rely on Node's `process.env` to receive context from the backend:
- `QT_URL`: Target application login URL.
- `QT_USER` / `QT_PASS`: Authentication credentials.
- `QT_MASTER`: The specific module/form to test (e.g., "users", "departments").
- `QT_HEADLESS`: If `"true"`, browser runs invisibly.
- `QT_OP`: For CRUD, dictates the stage (`create`, `update`, `delete`, `all`).
- `QT_VERIFY_AUDIT`: Boolean to trigger audit trail validation.

---

## 3. Detailed Runner Scripts

### 3.1. `crud-master.js`
The flagship script. It performs end-to-end lifecycle testing.
- **Execution Flow**:
  1. `login()`: Authenticates and waits for the dashboard.
  2. `switchSiteAndOpenAnyApp()`: Uses heuristics to navigate through complex app-switcher menus if necessary.
  3. `navigateTo()`: Hits the specific Master table URL.
  4. `openCreateForm()`: Opens the offcanvas side-panel.
  5. `collectStableFormFields()`: Introspects the form to find all inputs.
  6. `smartFillOffcanvasForm()`: Injects synthetic data into the form based on input types.
  7. `getActionableSaveButton()` -> `click()`: Submits the form.
  8. **Audit Verification**: If `QT_VERIFY_AUDIT` is true, the script pauses, extracts the generated data, navigates to the Audit Trail module, and strictly verifies that the row creation was logged in the database audit log.
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
- Uses `dependent-dropdowns.json` (managed by the backend) to ensure that if a form has a "Country" and "State" dropdown, it fills them in the correct hierarchical order so the State dropdown enables properly.
- Generates data based on heuristics: if a label contains "Phone", it generates 10 random digits. If it contains "Email", it generates a random `@example.com` string.

---

## 5. LLM Contextual Gotchas
- **Output Constraint**: All runner scripts MUST use `process.stdout.write(JSON.stringify(payload))` at the very end. Standard `console.log` is overridden in these scripts to pipe to `process.stderr.write` so it doesn't corrupt the JSON pipeline back to the Node.js backend.
- **Heuristic Selectors**: Because the target application (QuickFlow) dynamically generates forms, the scripts rarely use hardcoded IDs (`#firstName`). Instead, they rely heavily on XPath, adjacent label traversal, and visual cues (e.g., finding the closest `input` to a label containing the word "Name"). When editing Playwright locators, maintain this dynamic heuristic approach.
