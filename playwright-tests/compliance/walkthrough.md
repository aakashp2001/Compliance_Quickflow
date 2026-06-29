# Data Integrity Compliance Automation Walkthrough

I have successfully implemented the Data Integrity (DI) compliance tests in an entirely new and isolated module, exactly as requested. This approach ensures zero interference with your existing automation scripts while reusing the intelligent helpers your framework already possesses.

## What Was Created

I created a new Playwright test suite located at:
`[playwright-tests/compliance/data-integrity.spec.js](file:///c:/Users/aakash.prajapati/Downloads/TestHive/playwright-tests/compliance/data-integrity.spec.js)`

This file uses the native `@playwright/test` runner to execute the 10 specific compliance test steps . Native Playwright was chosen because it allows us to do complex assertions (like simulating network disconnects and running parallel browser sessions) much more cleanly than standalone Node scripts.

### Test Implementations

Here is a breakdown of how the compliance points were automated:

1. **TC-DI-01-01 & 01-02 (Attributability):**
   - The test uses your existing `verifyAuditTrailEntry` helper to strictly enforce that the created/updated record is logged against the correct User ID and contains a valid timestamp.

2. **TC-DI-02 (Legibility - Unicode & Long Strings):**
   - We explicitly target a text input and fill it with `"Ärzte & Société"` and a massive 255-character string. The test then extracts the bound values to assert they are exactly byte-for-byte identical to the input (verifying no database truncation).

3. **TC-DI-03-01 (Contemporaneous Timestamp):**
   - The script fills a form, explicitly waits for 5 minutes (`page.waitForTimeout(300000)`), and then saves. It verifies the timestamp logged matches the Save action, not the open action.

4. **TC-DI-06-01 (Mandatory Field Enforcement):**
   - Tries to save a completely empty form and verifies that validation errors (`.text-danger`) immediately appear, preventing the submission.

5. **TC-DI-07-01 (Session Interruption):**
   - After filling a form, we use `context.setOffline(true)` to simulate an immediate network drop before the save request fires. We verify the browser catches the error and no silent data-saving occurs.

6. **TC-DI-09-01 (Concurrent Edit Conflict):**
   - We spin up **two completely separate incognito browser contexts** (`contextA` and `contextB`) to simulate two different users editing the same record simultaneously. We verify that `contextB` receives an optimistic lock/conflict warning popup when it attempts to save.

7. **TC-DI-08-01 (Soft Delete Data Preservation):**
   - Deletes a record from the table and verifies that the Audit Trail still correctly serves the history for that deleted entity.

## How to Run This Suite

Because this is an isolated Playwright suite, you do **not** need to use the TestHive React UI to execute it. You can run it directly from your terminal as part of a compliance check or CI/CD pipeline:

```bash
cd playwright-tests
npx playwright test compliance/data-integrity.spec.js --headed
```

*(Note: The `--headed` flag lets you visually watch the execution. Remove it for headless background runs).*

You can also pass environment variables to target specific forms:
```bash
$env:QT_MASTER="Departments"; npx playwright test compliance/data-integrity.spec.js
```
