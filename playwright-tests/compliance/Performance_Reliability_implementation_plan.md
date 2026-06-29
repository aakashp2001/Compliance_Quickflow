# Performance and Reliability (PR) Compliance BDD Implementation Plan

## 1. Objective And Traceability

This document defines how to implement SECTION 09 Performance and Reliability in the current TestHive compliance architecture, keeping the same backend and frontend run flow used by DI, MD, AT, EH, and AC suites.

Source of requirements:
- Source Doc: SECTION 09 | Performance and Reliability
- Source Provider: User-provided BDD matrix
- Source Capture Date: 2026-06-01
- Applicable IDs in source: TC-PR-*

Traceability policy:
- Every execution artifact must include original TC-PR-* ID.
- Every result must include threshold, measured value, and pass/fail.
- Post-load reliability checks (audit and data integrity) are mandatory where applicable.

## 2. Feasibility With Current Codebase

Yes, implementation is feasible with your current codebase.

What your code already supports:
- One-runner-per-suite architecture executed via backend child process.
- Realtime async run lifecycle via `/api/compliance/runs` and streaming updates.
- Shared JSON result contract with `passed | failed | blocked`.
- Playwright browser and API request patterns already used in compliance modules.

Practical constraint:
- Pure Playwright can run reliability and moderate concurrency checks well.
- For strict high-concurrency SLA scenarios (50-100 concurrent sustained users), a load engine such as k6 is more reliable and efficient.

Decision:
- Use a hybrid model: Playwright suite as orchestrator and validator, plus optional k6 for heavy load profiles.

## 3. Recommended Architecture (Playwright-Native Hybrid)

### 3.1 New PR suite under existing compliance framework

Add a new compliance runner:
- `playwright-tests/compliance/performance-reliability-runner.js`

Add PR BDD step helpers:
- `playwright-tests/compliance/pr-bdd-steps.js`

Add PR metrics and threshold evaluator:
- `playwright-tests/compliance/pr-metrics.js`

Add optional load engine scripts:
- `playwright-tests/performance/k6/pr-01-load.js`
- `playwright-tests/performance/k6/pr-02-approval.js`
- `playwright-tests/performance/k6/pr-03-stress.js`

### 3.2 Backend and frontend integration to keep one application

Backend changes:
- Extend suite normalization to include `PR`.
- Add PR runner mapping in one-shot and realtime execution paths.
- Add default PR TC list constant for realtime expansion.

Frontend changes:
- Add `PR` in suite selector and metadata.
- Add TC options for `TC-PR-*`.
- Reuse same run, stream, and summary components with no schema change.

Documentation changes:
- Add PR run commands and suite notes in compliance docs.

## 4. Execution Model Per Test Case

| TC ID | Playwright Only | Hybrid (Playwright + k6) | Recommendation |
|---|---|---|---|
| TC-PR-01-01 | Possible for baseline trend check | Best for strict 50-user SLA validation | Hybrid |
| TC-PR-01-02 | Possible for baseline trend check | Best for strict 50-user SLA validation | Hybrid |
| TC-PR-02-01 | Possible via Playwright API concurrency + audit checks | Better for precise latency distribution at 50 concurrent approvals | Hybrid |
| TC-PR-03-01 | Possible but expensive and less stable for 30-min/100-user stress | Best for sustained stress and percentile fidelity | Hybrid |
| TC-PR-04-01 | Strong fit in Playwright/API flow | Optional k6 only if import is API-only and parallelized | Playwright first |
| TC-PR-05-01 | Not a load test, use scriptable evidence validation | No k6 need | Playwright/Node evidence task |
| TC-PR-06-01 | Strong fit in Playwright/browser+API export validation | Optional k6 if export endpoint is pure API | Playwright first |

## 5. Detailed Design By Layer

### 5.1 Playwright layer responsibilities

- Authenticate users and acquire tokens/session.
- Seed prerequisites (for example, 50 records under review).
- Trigger reliability checks before and after load runs.
- Validate business integrity:
	- no duplicate approvals
	- audit entry completeness
	- record integrity sampling
- Execute pure PR cases that are not true high-concurrency load (PR-04, PR-05, PR-06).

### 5.2 Load engine layer responsibilities (k6 preferred)

- Drive high-concurrency traffic profiles for PR-01, PR-02, PR-03.
- Produce p95/p99, error rate, timeout, and throughput metrics.
- Return machine-readable summaries for PR runner ingestion.

### 5.3 PR runner orchestration

- Each TC can run in one of these modes:
	- `playwright`
	- `hybrid`
	- `evidence`
- Runner emits same compliance schema used by existing suites.
- If k6 is unavailable, runner returns `blocked` only for TCs that require strict heavy-load assertions and includes exact reason.

## 6. Non-Functional Gates (Unchanged Targets)

- TC-PR-01-01: p95 <= 3000 ms, error rate = 0%, timeout count = 0
- TC-PR-01-02: p95 <= 3000 ms, error rate = 0%, timeout count = 0
- TC-PR-02-01: p95 <= 5000 ms, error rate = 0%, duplicate approvals = 0
- TC-PR-03-01: error rate < 1%, no data corruption in sampled verification
- TC-PR-04-01: import duration <= 10 minutes, data accuracy on sampled records
- TC-PR-05-01: monthly uptime >= 99.5% per reviewed month
- TC-PR-06-01: export within SLA, no timeout, no truncation, audit fields complete

## 7. Concrete Implementation Sequence For Current Structure

1. Create PR suite runner and TC catalog
- Add `performance-reliability-runner.js` with `TC_CATALOG`, `DEFAULT_ALL_ORDER`, and `baseCase/blockedCase` patterns matching other suites.

2. Add PR step helper library
- Implement `pr-bdd-steps.js` for token auth, endpoint timing probes, import/export tracking, and audit/data integrity assertions.

3. Add optional k6 profile scripts
- Keep k6 scripts in `playwright-tests/performance/k6/` and call them from PR runner using child process.

4. Wire backend suite dispatch
- Extend suite normalizer and runner file mapping with `PR` in one-shot and realtime paths.

5. Wire frontend suite options
- Add `PR` in suite dropdown and add `TC-PR-*` options without changing page architecture.

6. Add docs and runbook
- Add PR execution examples for single TC and run-all via existing endpoints.

## 8. How This Stays Under One Application

The unified model remains identical to current modules:
- User triggers PR suite from Compliance page.
- Frontend calls existing compliance API.
- Backend dispatches PR runner like other suites.
- Runner outputs same schema and is persisted/reported the same way.

No separate application is required. PR becomes one more suite in the same compliance application.

## 9. Fallback Strategy If You Want Zero External Tooling Initially

Initial phase can be Playwright-only with these limits:
- Use Playwright API requests for small and moderate concurrency trend checks.
- Mark strict heavy-load SLA checks as `blocked` with reason `requires-load-engine`.
- Still run PR-04, PR-05, PR-06 fully and reliably.

This gives immediate integration with minimal disruption, then you can add k6 later without changing frontend/backend contracts.

## 10. Recommended Phasing (Updated)

Phase 1: Playwright suite integration
- Build PR runner, backend/frontend wiring, TC contract, and Playwright-only checks for PR-04, PR-05, PR-06.

Phase 2: Hybrid load enablement
- Add k6 profiles for PR-01, PR-02, PR-03 and connect outputs to PR runner thresholds.

Phase 3: Reliability hardening
- Add post-load data integrity and audit validation automation for PR-02 and PR-03.

Phase 4: CI and observability
- Schedule daily PR smoke, nightly stress, and monthly uptime review using existing compliance run APIs.

## 11. Detailed Execution Steps Per TC

### 11.1 TC-PR-01-01 (Entry And Form Issuance Load SLA)
1. Identify exact backend endpoints used by Entry Dashboard and Form Issuance list.
2. Build k6 script with token-based auth and realistic think time (200-500 ms).
3. Ramp to 50 VUs over 1 minute, sustain for 5 minutes.
4. Capture p95 per endpoint and total error/timeout counts.
5. Capture app and DB CPU/memory during run.
6. Mark pass only when all thresholds are met.

### 11.2 TC-PR-01-02 (Admin List Page Load SLA)
1. Authenticate as Central Admin and prepare endpoint list: Country, Site, User, Role.
2. Execute 50 concurrent virtual users per endpoint profile.
3. Collect p95 metrics and response code distribution.
4. Run post-load admin smoke to confirm module functionality.

### 11.3 TC-PR-02-01 (Workflow Approval SLA)
1. Seed 50 forms in `Under Review` with unique IDs.
2. Fire 50 concurrent approval calls against Approve API.
3. Measure end-to-end API response time and calculate p95.
4. Verify no duplicate approvals (idempotency check on form IDs).
5. Verify exactly 50 approval audit entries with actor and timestamp.

### 11.4 TC-PR-03-01 (Peak Stress Stability)
1. Configure mixed workload split (example): 35% list/view, 25% create/submit, 25% approve, 15% audit query.
2. Ramp to 100 users over 2 minutes and sustain for 30 minutes.
3. Track rolling latency, error budget burn, and resource saturation.
4. Execute post-run data integrity sampling for records created/updated during run.
5. Validate audit trail consistency for sampled operations.

### 11.5 TC-PR-04-01 (Bulk Import SLA)
1. Upload validated 1,000-row import file through API or import endpoint.
2. Record precise start and completion timestamps.
3. Validate full completion and any row-level rejections.
4. Verify random sample of 50 rows against source file.
5. Confirm import audit event exists and is complete.

### 11.6 TC-PR-05-01 (Availability SLA Review)
1. Collect monthly uptime logs for last 3 calendar months.
2. Calculate uptime: `(Total minutes - Downtime minutes) / Total minutes * 100`.
3. Validate all maintenance windows had prior communication artifacts.
4. Verify unplanned downtime incidents include RCA and duration.

### 11.7 TC-PR-06-01 (Audit Export SLA)
1. Select date range producing 10,000+ audit entries.
2. Trigger export and capture start/end timestamps.
3. Ensure no session timeout during export lifecycle.
4. Validate output row count and field completeness.
5. Fail run if any truncation, missing fields, or timeout occurs.