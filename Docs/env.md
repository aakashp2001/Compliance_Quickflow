# Environment Variables

Common environment variables used across the project:

- `PORT` — backend listen port (default from `backend/server.js`).
- `MONGODB_URI` — MongoDB Atlas connection string used by backend persistence layer.
- `MONGODB_DB_NAME` — target database name for TestHive backend collections.
- `MONGODB_APP_NAME` — optional Mongo client app name for Atlas diagnostics.
- `MONGODB_MAX_POOL_SIZE` / `MONGODB_MIN_POOL_SIZE` — optional pool tuning.
- `MONGODB_MAX_IDLE_MS` / `MONGODB_CONNECT_TIMEOUT_MS` / `MONGODB_SERVER_SELECTION_TIMEOUT_MS` — optional timeout tuning.
- `VITE_API_BASE_URL` — frontend API base (set in `.env` for Vite).
- `QT_URL` — QuickFlow base URL used by Playwright scripts.
- `QT_USER` / `QT_PASS` — credentials for QuickFlow automation.
- `QT_HEADLESS` — `true|false` to control Playwright headless mode.
- `QT_TC_ID` — when set, compliance runner runs a single TC ID (e.g. `TC-DI-06-01`).
- `QT_RECORD_VIDEO` — `true|false` to enable video recording in Playwright runs.

Example backend `.env` (Mongo + backend runtime):

```
PORT=8000
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/<db>?retryWrites=true&w=majority&appName=TestHive
MONGODB_DB_NAME=testhive
MONGODB_APP_NAME=TestHive-Backend
MONGODB_MAX_POOL_SIZE=10
MONGODB_MIN_POOL_SIZE=0
MONGODB_MAX_IDLE_MS=30000
MONGODB_CONNECT_TIMEOUT_MS=10000
MONGODB_SERVER_SELECTION_TIMEOUT_MS=10000
QT_URL=https://ipdev.quickflow.in/login
QT_USER=
QT_PASS=
```

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
Rotate credentials immediately if a raw connection string or password is ever exposed.
