# Error Handling (EH) Compliance BDD Implementation Plan

## 1. Objective And Traceability

This document defines the implementation plan for the Error Handling compliance suite in TestHive using the existing Playwright + backend runner architecture.

Source of requirements:
- Source Doc: `SECTION 08 | Error Handling`
- Source Provider: User-provided test matrix
- Source Capture Date: `2026-05-26`
- Applicable IDs in source: `TC-EH-*` (UR/CR/FRD/SDS are `NA`)

Traceability policy:
- Every automated test result must include the original `TC-EH-*` ID in output and report operation name.
- Main implementation plan stays concise; full test data and expected behavior are mapped in the matrix below.

## 2. TC Coverage Matrix (Decision Complete)

| TC ID | Short Name | Source Ref | Automation Outcome | Notes |
|---|---|---|---|---|
| `TC-EH-01-01` | Validation message security | Section 08 row `TC-EH-01-01` | `Automate` | Validate informative errors, no stack/internal leak in UI/console/network body. |
| `TC-EH-01-02` | 404 does not leak internals | Section 08 row `TC-EH-01-02` | `Automate` | Validate friendly 404 and no framework/path/version leakage in headers/body/UI. |
| `TC-EH-02-01` | Network timeout + data preservation | Section 08 row `TC-EH-02-01` | `Automate` | Offline before submit, assert clear message + no data loss + successful retry. |
| `TC-EH-03-01` | XSS sanitization | Section 08 row `TC-EH-03-01` | `Automate` | Inject script payload, assert no execution and escaped/rejected storage. |
| `TC-EH-03-02` | SQL injection sanitization | Section 08 row `TC-EH-03-02` | `Automate` | Inject SQL pattern via UI and API probe, assert literal treatment/no SQL error leak. |
| `TC-EH-03-03` | Oversized input handling | Section 08 row `TC-EH-03-03` | `Automate` | 10k chars; assert validation/truncation behavior and no crash. |
| `TC-EH-04-01` | Server-side error logging completeness | Section 08 row `TC-EH-04-01` | `Automate or Blocked` | Blocked if logs UI/API is unavailable in target env. |
| `TC-EH-05-01` | Reject executable upload | Section 08 row `TC-EH-05-01` | `Automate` | `.exe/.bat/.sh` rejection and non-persistence checks. |
| `TC-EH-05-02` | Reject oversized upload | Section 08 row `TC-EH-05-02` | `Automate` | Over limit file rejection + clear size message. |
| `TC-EH-05-03` | Reject macro-enabled upload | Section 08 row `TC-EH-05-03` | `Automate or Blocked` | Blocked if macro scanner behavior is not enabled/exposed in env. |
| `TC-EH-06-01` | Deactivated approver routing halt | Section 08 row `TC-EH-06-01` | `Automate or Blocked` | Blocked if workflow/role/deactivation hooks are unavailable. |

`blocked` status is valid and intentional where preconditions/hooks are absent, consistent with existing MD/AT strategy.

## 3. Implementation Architecture

### 3.1 New files

1. `playwright-tests/compliance/error-handling-runner.js`
- Standalone suite runner (`suite: "EH"`), same output contract as DI/MD/AT.
- Supports single TC mode (`QT_TC_ID`) and full suite mode (`all`).
- Returns `passed | failed | blocked` per TC, plus `_debug` logs in stderr.

2. `playwright-tests/compliance/eh-bdd-steps.js`
- Playwright-native BDD step library (no Cucumber dependency).
- Exposes reusable `Given_*`, `When_*`, `Then_*` style async functions.

3. `playwright-tests/helpers/errorLeakChecks.js`
- Shared sensitive-leak detectors for:
  - UI text
  - response headers
  - response payload text
  - browser console events
- Includes deny-pattern catalog (stack traces, SQL engine errors, file paths, framework banners).

4. `playwright-tests/helpers/ehFixtures.js`
- Generates test payloads (XSS, SQLi, oversized strings).
- Creates upload artifacts (`.exe`, oversized file, macro placeholder fixture routing).

### 3.2 Existing files to modify

1. `backend/server.js`
- Extend suite normalization and runner mapping to include `EH`.
- Add `REALTIME_COMPLIANCE_EH_DEFAULT_TC_IDS`.
- Keep existing DI/MD/AT logic unchanged.

2. `frontend/src/CompliancePage.jsx`
- Add EH to suite options and TC catalog.
- Keep same run/stream/result rendering.

3. `Docs/compliance.md`
- Add EH suite run examples and supported statuses.

4. `frontend/src/api/client.js`
- No API shape change required; existing compliance APIs are reused.

## 4. Runner Design And Contracts

### 4.1 Environment variables

Primary EH config:
- `QT_EH_ENTRY_USER`, `QT_EH_ENTRY_PASS`
- `QT_EH_ADMIN_USER`, `QT_EH_ADMIN_PASS`
- `QT_EH_SUPERVISOR_USER`, `QT_EH_SUPERVISOR_PASS`
- `QT_EH_FORM_ISSUANCE_PATH`
- `QT_EH_COUNTRY_PATH`
- `QT_EH_LOGS_PATH` (optional)
- `QT_EH_UPLOAD_PATH` (optional)

Fallback behavior:
- Missing EH-specific creds fall back to `QT_USER/QT_PASS`.
- If role isolation is required and fallback cannot satisfy the case, return `blocked` with explicit reason.

### 4.2 Output contract (unchanged schema)

Runner output to `stdout`:
- `suite`, `mode`, `tcId`, `status`, `title`, `details[]`, `startedAt`, `completedAt`
- `summary` and `results[]` for `mode: all`

Diagnostics:
- Human-readable logs only on `stderr`.

### 4.3 TC dispatcher

- `TC_MAP` will include all `TC-EH-*` IDs from Section 08.
- `DEFAULT_ALL_ORDER` preserves test order defined in matrix.
- Each TC uses:
  - precondition probe
  - execution
  - assertion
  - normalized result mapping

## 5. BDD Step Layer (Playwright-native)

### 5.1 Given steps

- `GivenUserLoggedIn(role)`
- `GivenNavigatedToModule(pathOrMaster)`
- `GivenFormCreateOpened()`
- `GivenWorkflowRecordPrepared()`
- `GivenUploadFieldAccessible()`

### 5.2 When steps

- `WhenSubmitWithMandatoryBlank()`
- `WhenNavigateToNonExistentUrl()`
- `WhenSubmitWhileOffline()`
- `WhenInjectXssPayload(field, payload)`
- `WhenInjectSqlPayload(field, payload)`
- `WhenEnterOversizedInput(field, length)`
- `WhenUploadFile(filePath)`
- `WhenTriggerMalformedApiRequest(endpoint, body)`
- `WhenDeactivateApproverDuringPendingTask()`

### 5.3 Then steps

- `ThenShowActionableErrorWithoutSensitiveLeak()`
- `ThenRenderFriendly404WithoutLeak()`
- `ThenPreserveFormDataAfterNetworkFailure()`
- `ThenPreventScriptExecutionAndSanitizeStoredValue()`
- `ThenTreatSqlPatternAsLiteralWithoutDataExposure()`
- `ThenRejectOversizedInputGracefully()`
- `ThenRejectDisallowedFileType()`
- `ThenRejectOversizedFileWithLimitMessage()`
- `ThenRejectMacroFileOrReturnBlocked()`
- `ThenLogServerErrorWithRequiredContextOrBlocked()`
- `ThenHaltWorkflowAndNotifyAdminOrBlocked()`

## 6. Non-Regression And Isolation Strategy

Guardrails to avoid impact on existing functionality:

1. Additive-only changes
- No edits to DI/MD/AT TC IDs or default orders.
- No change to existing result schema.

2. Shared helper compatibility
- New helper modules are introduced without altering current helper signatures.
- Existing `uiActions.js` selectors remain source of truth for navigation/login primitives.

3. Backend compatibility
- EH plugged into existing suite switch only.
- Existing suite dispatch paths remain unchanged.

4. Reporting compatibility
- Report operation naming convention: `compliance-eh-<tc-id-lower>`.
- Realtime summary counters include `blocked` and `not-performed` behavior unchanged.

## 7. Validation And Acceptance

### 7.1 Regression smoke

- Before/after EH changes:
  - one DI case
  - one MD case
  - one AT case
- Must produce identical schema and normal pass/fail behavior.

### 7.2 EH functional acceptance

- Execute all EH TCs singly via CLI.
- Execute complete EH batch via `/api/compliance/runs` and UI Compliance Suite page.
- Validate expected `blocked` outcomes by removing required preconditions intentionally.

### 7.3 Security-focused checks

- Verify deny-pattern detector catches known leakage strings.
- Verify no false positive on normal validation messages.

## 8. Delivery Phasing

Phase 1:
- Add EH runner + step layer + helpers + backend dispatch + frontend EH suite option.

Phase 2:
- Implement all automatable EH cases and return `blocked` for missing hooks.

Phase 3:
- Add docs updates and run regression + EH execution matrix.

## 9. Explicit Assumptions

- BDD remains Playwright-native; Cucumber/Gherkin is out of scope.
- Section 08 matrix is the single source for EH TC scope.
- Environment-specific features (macro scanning, server logs visibility, workflow deactivation path) may vary; these cases can legitimately be `blocked`.
