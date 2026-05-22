# Compliance Tests

Location
--------

Compliance tests are implemented under `playwright-tests/compliance/`. The primary orchestrator is `compliance-runner.js`, which exposes multiple TC (test-case) functions and a `main()` dispatcher.
Master Data compliance is implemented in `master-data-runner.js` as a separate suite.

How tests run
-------------

- `compliance-runner.js` launches a Playwright browser context (Chromium) and executes Data Integrity TCs.
- `master-data-runner.js` launches a Playwright browser context (Chromium) and executes Master Data TCs (`TC-MD-*`) with readiness-aware `blocked` outcomes when feature hooks are unavailable.
- When no `QT_TC_ID` is supplied, the runner executes a default set of TCs and emits a consolidated JSON `result` to `stdout`.

Running a single TC
-------------------

```powershell
cd playwright-tests
npx playwright install
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-DI-06-01 node compliance/compliance-runner.js
```

```powershell
cd playwright-tests
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-MD-02-01 node compliance/master-data-runner.js
```

Interpreting results
--------------------

- The runner writes a machine-readable JSON object to `stdout` with fields such as `suite`, `mode`, `tcId`, `startedAt`, `completedAt`, `status`, and `results`. Master Data suite supports `status: blocked` in addition to `passed` and `failed`.
- Any non-fatal debug output is written to `stderr` for easier human troubleshooting.

Backend API
-----------

- `POST /api/compliance/run` supports `suite` in payload:
  - `suite: "DI"` (default)
  - `suite: "MD"`

Test coverage areas
-------------------

- Attributability / Audit trail verification
- Legibility (unicode and long strings)
- Mandatory field enforcement
- Session interruption and durability
- Soft delete / data preservation
- Concurrent edit/conflict detection
