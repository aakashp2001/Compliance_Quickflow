# Data Integrity Compliance Automation Plan

This document outlines the strategy to automate the 10 Data Integrity (DI) compliance points provided. The goal is to create a robust, isolated module that reuses existing intelligence without risking regression to the current TestHive ecosystem.

## User Review Required

> [!IMPORTANT]
> **Integration Method:** Currently, scripts like `crud-master.js` are executed by the Express backend and shown in the React UI.
> **Question:** Do you want these Compliance Tests to also be triggerable from the TestHive React UI (which would require a new backend endpoint and UI page), OR do you plan to run them purely from the command line (e.g., `npx playwright test playwright-tests/compliance/`) for CI/CD pipelines?

## Proposed Architecture

To isolate the compliance logic while reusing existing code, we will create a new directory: **`playwright-tests/compliance/`**.

Instead of a single monolithic script like `crud-master.js`, we will structure these as native Playwright test specifications (`*.spec.js`). Native Playwright provides crucial features needed for these specific tests (like parallel contexts for concurrent editing and network offline simulation).

### Directory Structure
```
playwright-tests/
├── helpers/                 <-- (Reused as-is)
├── compliance/
│   ├── data-integrity.spec.js   <-- (The automated test suite)
│   ├── compliance-runner.js     <-- (Optional standalone script if UI integration is needed)
```

## Implementation Strategy per Test Case

We will heavily reuse `helpers/formDiscovery.js`, `helpers/smartFiller.js`, and `helpers/auditTrail.js`.

### 1. Attributability & Timestamps (TC-DI-01-01, 01-02, 04-01)
- **Approach**: Automate a standard Create and Update flow.
- **Verification**: Enhance our usage of `auditTrail.js` to strictly assert that:
  - The `Performed By` column exactly matches the authenticated username.
  - The timestamp format is strictly verified (ISO 8601 or UTC).
  - Both `Old Value` and `New Value` exist and match our modifications.

### 2. Legibility (Unicode & Long Strings) (TC-DI-02-01, 02-02)
- **Approach**: Instead of random data, we will pass explicit overrides to the form filler.
- **Data**: Inject `"Ärzte & Société"` and a 255-character alphanumeric string.
- **Verification**: After saving, we will navigate back to the Edit view and extract the input values to ensure they are byte-for-byte identical to the input (no truncation or garbling).

### 3. Contemporaneous Timestamp (TC-DI-03-01)
- **Approach**: Open a Create form. Fill the fields.
- **Action**: Use `page.waitForTimeout(300000)` (5 minutes) before clicking Save.
- **Verification**: Check the Audit Trail to ensure the recorded time matches the exact *Save* click moment, not the form open moment.

### 4. Session Interruption (TC-DI-07-01)
- **Approach**: Start filling a form.
- **Action**: Use Playwright's `context.setOffline(true)` or abruptly close the page/context mid-fill.
- **Verification**: Re-login and check the master datatable to ensure no corrupted or partial record was created.

### 5. Concurrent Edit Conflict (TC-DI-09-01)
- **Approach**: This requires **two** active browser contexts running simultaneously.
- **Action**: 
  - Context A logs in and opens Record #1.
  - Context B logs in and opens Record #1.
  - Context A modifies and saves.
  - Context B modifies and attempts to save.
- **Verification**: Assert that Context B receives a specific conflict/lock warning popup (e.g., "modified by another user") and the data is not silently overwritten.

### 6. Mandatory Field Enforcement (TC-DI-06-01)
- **Approach**: Similar to the existing `validate-mandatory-fields.js` logic.
- **Verification**: Ensure that leaving a mandatory field blank explicitly prevents submission and triggers `.text-danger` validation messages.

### 7. Calculated Fields Accuracy (TC-DI-05-01)
- **Approach**: Open a template known to have calculations (Price * Qty).
- **Verification**: Fill source fields and extract the resulting value from the read-only calculated field. Assert that `Price(50) * Qty(4) === Total(200)`.

## Verification Plan
1. Ensure all `TC-DI-*` test stepspass individually.
2. Verify that existing `crud-master.js` and TestHive React flows remain 100% unaffected.
3. Test edge-case scenarios (like the 5-minute wait and concurrent lock) to ensure they reliably fail if the system misbehaves.
