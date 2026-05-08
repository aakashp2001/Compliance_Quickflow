# Environment Variables

Common environment variables used across the project:

- `PORT` — backend listen port (default from `backend/server.js`).
- `VITE_API_BASE_URL` — frontend API base (set in `.env` for Vite).
- `QT_URL` — QuickFlow base URL used by Playwright scripts.
- `QT_USER` / `QT_PASS` — credentials for QuickFlow automation.
- `QT_HEADLESS` — `true|false` to control Playwright headless mode.
- `QT_TC_ID` — when set, compliance runner runs a single TC ID (e.g. `TC-DI-06-01`).
- `QT_RECORD_VIDEO` — `true|false` to enable video recording in Playwright runs.

Example `.env` for local development (frontend):

```
VITE_API_BASE_URL=http://localhost:8000
```

Example env for running a Playwright entry script (PowerShell):

```powershell
$env:QT_URL = "https://my-quickflow.example"
$env:QT_USER = "qauser"
$env:QT_PASS = "secret"
$env:QT_HEADLESS = "false"
node compliance/compliance-runner.js
```

Security note
-------------

Do not commit environment files containing credentials. Use a secrets manager or CI secret variables for automated runs.
