# Helpers

Purpose
-------

Helper modules under `playwright-tests/helpers/` provide reusable primitives for automation scripts. They centralize DOM heuristics, field filling, audit verification, and UI navigation.

Key helper modules
------------------

- `formFiller.js` — low-level functions to detect and fill text/select/checkbox fields; contains heuristics for default values.
- `formDiscovery.js` — scans offcanvas forms and produces a structured `fields` array describing `id`, `displayName`, `elementType`, and `maxLength`.
- `smartFiller.js` — higher-level filling strategies that use `formDiscovery` + `formFiller` to produce realistic test data.
- `discoverMasters.js` — heuristics to find master pages, page titles, and edit/create flows across QuickFlow.
- `uiActions.js` — navigation helpers, login flows, and common selectors used across entry scripts.
- `auditTrail.js` — helpers to query and verify audit trail entries for verification steps used in compliance tests.
- `artifactOverlay.js` — utilities to render overlay metadata for captured screenshots.

Usage pattern
-------------

Helpers are imported into entry scripts and used to keep the top-level test code short and declarative. When adding new helper behavior, keep the API async-friendly and tolerant of flaky UI waits.
