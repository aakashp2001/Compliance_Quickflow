## Plan: Access Control Compliance BDD Suite

Full-scope implementation for AC01 through AC10 plus VMS-AC10 can be done by adding a dedicated Access Control suite in the existing compliance runner architecture, then implementing scenarios in phased blocks with deterministic setup/cleanup and explicit blocked readiness for unavailable hooks (especially MFA provider dependency).

**Steps**
1. Build a canonical AC test catalog from your matrix (all TC IDs, titles, preconditions, expected outcomes), and map each TC ID to one runner function.  
2. Define one unified TC result contract (suite, tcId, title, readiness, status, details, debug/error) matching existing DI/MD/AT/EH payload shape. Depends on step 1.  
3. Define preflight gates per TC (credential availability, route presence, feature/hook availability) and standardized blocked reasons. Depends on step 1.  
4. Create AC suite foundation in compliance module: runner dispatcher, TC_CATALOG, DEFAULT_ALL_ORDER, baseCase/blockedCase pattern, single-TC and run-all execution modes. Depends on steps 1-3.  
5. Add AC BDD step layer (Given/When/Then helpers) for login, navigation, direct access attempts, policy actions, and assertions. Parallel with step 4.  
6. Add helper modules for direct URL/API denial probes, role/user/password-policy setup, password validation checks, session-timeout fast-forward adapter, MFA adapter, and lockout orchestration. Depends on step 4; parallel with step 5.  
7. Implement AC01, AC08 first as the security core: role/user baseline, deny checks for Admin/Edit/Approve/module endpoints, unauthenticated and expired-token API checks, endpoint guessability checks. Depends on steps 5-6.  
8. Implement AC02 password-policy setup and enforcement (create-user negatives, reset-password negatives, positive boundary case). Depends on steps 5-6; parallel with step 7 if isolated test users are used.  
9. Implement AC03 session-timeout setup and behavior (auto-logout, post-expiry action rejection, unsaved-data handling, re-auth, active-session continuity, timeout-change enforcement with rollback). Depends on steps 5-6 and fast-forward hook availability.  
10. Implement AC04 MFA setup/enforcement/positive flows with two-path execution: automatable when OTP source exists, blocked readiness when unavailable. Depends on steps 5-6.  
11. Implement AC05 lockout setup and enforcement (threshold, post-lock denial, invalid-login audit verification, unlock/recovery, reset-on-locked, eSign failed attempts). Depends on steps 5-6.  
12. Implement AC06 audit-trail checks for role assignment/revocation/permission change/rename propagation/completeness. Depends on steps 7 and 11.  
13. Implement AC09 user deactivation/reactivation and username uniqueness/reuse scenarios. Depends on steps 5-6; parallel with steps 10-12 if isolated users are used.  
14. Implement AC10 builder access and environment restrictions, then VMS lifecycle validations across Dev→QA→Prod flow. Depends on steps 5-6 and environment route availability.  
15. Wire AC suite into backend and UI: suite normalization, runner dispatch, realtime default TC list, suite selector and TC options. Depends on steps 1-4 (and finalized catalog).  
16. Execute hardening and regression: AC smoke + full, realtime stream checks, then DI/MD/AT/EH non-regression verification. Depends on steps 7-15.

**Relevant files**
- [playwright-tests/compliance](playwright-tests/compliance) — add new AC suite files (runner and BDD step layer) following current compliance conventions.
- [playwright-tests/helpers](playwright-tests/helpers) — add AC-focused helper modules for direct access probes, policy setup, MFA/session adapters, and data lifecycle.
- [playwright-tests/compliance/error-handling-runner.js](playwright-tests/compliance/error-handling-runner.js) — reuse TC catalog, preflight, blocked readiness, and runner structure.
- [playwright-tests/compliance/audit-trail-runner.js](playwright-tests/compliance/audit-trail-runner.js) — reuse direct request probing and delegated execution patterns.
- [playwright-tests/compliance/eh-bdd-steps.js](playwright-tests/compliance/eh-bdd-steps.js) — reuse Playwright-native BDD step style.
- [playwright-tests/helpers/uiActions.js](playwright-tests/helpers/uiActions.js) — reuse login/navigation/create/save/confirmation/error primitives.
- [playwright-tests/helpers/auditTrail.js](playwright-tests/helpers/auditTrail.js) — reuse audit filtering/assertion mechanisms for AC05 and AC06 validations.
- [backend/server.js](backend/server.js) — add AC suite support in normalization, runner selection, and realtime default TC routing.
- [frontend/src/CompliancePage.jsx](frontend/src/CompliancePage.jsx) — add AC suite option, TC list, and suite metadata.
- [Docs/compliance.md](Docs/compliance.md) — add AC run guidance and prerequisite documentation.

**Verification**
1. Run single-TC smoke from each AC area and verify output schema matches existing compliance suites.  
2. Run AC run-all and verify summary rollups for passed, failed, blocked, and not-performed.  
3. Validate realtime lifecycle for AC (start, stream, poll, stop) through backend endpoints and UI.  
4. Validate security assertions: 401/403 correctness and no protected data/UI exposure for unauthorized attempts.  
5. Validate policy assertions: password rules, lockout behavior, timeout behavior, and MFA enforcement paths.  
6. Validate audit assertions: actor, timestamp, action type, target user/role, old/new values where applicable.  
7. Run DI, MD, AT, EH regression smoke after AC wiring.

**Decisions**
- Scope: full end-to-end AC01 through AC10 plus VMS-AC10 lifecycle.  
- Timeout strategy: use server/test fast-forward hook for CI determinism, with real-wait fallback only when required.  
- Data strategy: create and clean dedicated test users/roles/policies inside suite runs.  
- MFA strategy: OTP source currently unknown, so include capability probe and dual path (automatable or blocked with explicit reason).  
- Framework strategy: keep Playwright-native BDD style, aligned with current compliance module patterns.

**Further Considerations**
1. Recommend execution profiles (smoke, policy, long-running, environment-specific) so CI stays fast while nightly runs keep full coverage.  
2. Recommend environment parameterization for Dev/QA/Prod URLs to make AC10 and VMS checks deterministic.  
3. Recommend strict runTag naming + rollback teardown to avoid cross-run data collisions in shared environments.

Plan has been saved in session memory and is ready for refinement if you want changes to phase ordering, priority, or test grouping.
