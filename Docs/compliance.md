# Compliance Tests

Location
--------

Compliance tests are implemented under `playwright-tests/compliance/`. The primary orchestrator is `compliance-runner.js`, which exposes multiple TC (test-case) functions and a `main()` dispatcher.

How tests run
-------------

- `compliance-runner.js` launches a Playwright browser context (Chromium) and executes individual TC functions such as `runTC_DI_01`, `runTC_DI_02`, `runTC_DI_06`, `runTC_DI_07`, `runTC_DI_08`, and `runTC_DI_09`.
- When no `QT_TC_ID` is supplied, the runner executes a default set of TCs and emits a consolidated JSON `result` to `stdout`.

Running a single TC
-------------------

```powershell
cd playwright-tests
npx playwright install
QT_URL="https://..." QT_USER=qa QT_PASS=secret QT_TC_ID=TC-DI-06-01 node compliance/compliance-runner.js
```

Interpreting results
--------------------

- The runner writes a machine-readable JSON object to `stdout` with fields such as `mode`, `tcId`, `startedAt`, `completedAt`, `status`, and `results`. The backend expects this JSON for persistence.
- Any non-fatal debug output is written to `stderr` for easier human troubleshooting.

Test coverage areas
-------------------

- Attributability / Audit trail verification
- Legibility (unicode and long strings)
- Mandatory field enforcement
- Session interruption and durability
- Soft delete / data preservation
- Concurrent edit/conflict detection
