### Master Data Compliance Module (SECTION 06) — Plan + TC Catalog

### Summary
- Build a **separate Master Data compliance module** parallel to DI, with its own runner and spec, while reusing shared helpers (`uiActions`, `auditTrail`, form filler, overlay/report JSON pattern).
- Deliver all 8 `TC-MD-*` cases now as an executable catalog, with **readiness tags** (`Automatable`, `Needs Seed Data`, `Needs Feature Hook`) so execution is explicit and non-ambiguous.
- Use **seed-per-run fixtures** by default, with deterministic naming prefixes (`MD_<TCID>_<timestamp>`) to avoid collisions and make audit lookup reliable.

### Public Interfaces / Contract Changes
- Backend `/api/compliance/run` request payload:
  - Add optional `suite` with values `DI | MD`; default `DI` for backward compatibility.
  - Keep `tcId`, but allow `TC-MD-*` values when `suite=MD`.
- Backend response schema:
  - Add root `suite` field.
  - Preserve existing per-test shape (`tcId`, `title`, `status`, `details`), and allow `status: blocked` for unmet prerequisites/hooks.
- Frontend compliance page:
  - Add suite selector (`Data Integrity`, `Master Data`).
  - Switch TC dropdown options based on selected suite.
  - Summary should count `blocked` separately from `failed`.

### Implementation Changes
- Add new runner: `playwright-tests/compliance/master-data-runner.js`.
- Add optional playwright spec for local direct execution: `playwright-tests/compliance/master-data.spec.js`.
- Keep DI runner untouched; backend dispatches to DI runner or MD runner by `suite`.
- In MD runner, each TC must start with a **precondition probe** and return `blocked` with exact reason if workflow is unavailable (review action missing, import UI missing, mass update action missing, etc.).
- Reuse `verifyAuditTrailEntry` for all audit assertions; add MD-specific helper wrappers for:
  - stage-transition probes (`Draft/In Review/Approved`),
  - duplicate-create assertion,
  - reviewer-self-approval check,
  - version co-existence check,
  - retired-reference warning check,
  - import row-error parser,
  - mass-update per-record audit counting,
  - hierarchy consistency across list/form/export.

### TC-MD Authored Catalog (Execution-Ready)
| TC ID | Readiness | Seed / Preconditions | Core Steps | Assertions |
|---|---|---|---|---|
| `TC-MD-01-01` Stage Skip Prevention | Automatable | Create review-enabled master (`Review=Yes`) + draft record | Attempt Draft→Approved directly via UI/API action | Transition blocked; explicit error; status remains Draft; audit contains rejected attempt metadata |
| `TC-MD-01-02` Positive Lifecycle | Automatable | Entry user + reviewer user + review-enabled master | Draft by Entry → Submit for Review → Approve by Reviewer | Exact sequence Draft→In Review→Approved; audit rows include performer/timestamp/old-new status |
| `TC-MD-02-01` Uniqueness Constraint | Automatable | Master with unique key field | Create key `MASTER-001`; create second same key | Second create rejected; duplicate message includes conflict reference; only one persisted; duplicate attempt audited |
| `TC-MD-03-01` Self-Approval Prevention | Automatable | User with both entry+review roles | Same user submits and then attempts approve | Approval blocked; “cannot approve own submission” style error; no approval audit entry created |
| `TC-MD-04-01` Approved Edit Creates Draft Version | Needs Feature Hook | Approved record + form/template referencing that master | Edit approved record and save as new draft; open issuance form | Active form still resolves approved version; draft exists in parallel; history shows both versions with correct attribution |
| `TC-MD-05-01` Retired Master Warning/Block | Needs Feature Hook | Approved master referenced by active template | Retire/supersede master; open template list/detail; attempt new issuance | Warning visible in list+detail; new issuance blocked until remap; existing submitted forms unaffected |
| `TC-MD-06-01` Import Validation Before Commit | Needs Feature Hook | Import feature + CSV fixture rows (valid/type-error/missing-required/duplicate) | Upload and run import | Row-level error report returned; invalid rows rejected with specific reasons; no invalid commit; import attempt audited |
| `TC-MD-07-01` Mass Update Authorization + Granular Audit | Needs Feature Hook | 20 seed records + mass update action + separate approver flow | Execute mass update and complete authorization | Separate sign-off enforced; audit has 20 individual entries (not one bulk); each row shows old/new/performedBy/time |
| `TC-MD-08-01` Parent-Child Hierarchy Integrity | Needs Seed Data | Parent and child masters with parent reference + export/report access | Validate list view, form dropdown behavior, and export columns | No orphan child records; no non-existent parent link; hierarchy consistent across list/form/export |

### Test Plan (Validation of This Module)
- Single-TC runs: verify each `TC-MD-*` can run independently through `/api/compliance/run` with `suite=MD`.
- Full-suite run: `suite=MD` with empty `tcId` executes all 8 and returns summary `{ total, passed, failed, blocked }`.
- Regression checks: existing DI (`suite=DI`) output and UI behavior remain unchanged.
- Report persistence: backend test report entries must include `operation: compliance-md-<tcid>` and full `details` payload.

### Assumptions and Defaults
- Default execution model is backend-triggered runner (same as DI), not direct CLI-only.
- Fixture strategy is **seed per run**; no reliance on long-lived static records.
- Where product workflows are unavailable in the target env, tests return `blocked` (not silent pass/fail).
- Master audit verification remains the source of truth for lifecycle, dedup, approval, and mass-update evidence.
