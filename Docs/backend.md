# Backend

Overview
--------

The backend is a Node.js + Express orchestration service in [backend/server.js](backend/server.js). It receives requests from the frontend, executes Playwright automations, finalizes artifacts, and stores metadata in MongoDB through [backend/db/storage.js](backend/db/storage.js).

What the backend does
---------------------

- Exposes REST endpoints used by the frontend.
- Spawns Playwright entry scripts from [playwright-tests/](playwright-tests/) using child processes.
- Parses script JSON output from stdout and keeps debug logs from stderr.
- Tracks new recordings/screenshots and exposes artifact URLs via `/test-report-artifacts`.
- Persists cached masters/fields, reports, recordings, compliance runs, and workflow states in MongoDB.

Source files to read first
--------------------------

- [backend/server.js](backend/server.js) - routing, orchestration, artifact lifecycle.
- [backend/db/storage.js](backend/db/storage.js) - MongoDB collection mapping and persistence operations.
- [backend/db/mongoClient.js](backend/db/mongoClient.js) - Mongo client and required env settings.
- [backend/scripts/migrate-json-to-mongo.js](backend/scripts/migrate-json-to-mongo.js) - migration from legacy JSON files.

Endpoint documentation
----------------------

For a full endpoint-by-endpoint breakdown (request/response behavior + exact MongoDB reads/writes), see:

- [Docs/api-mongodb-reference.md](Docs/api-mongodb-reference.md)

Run locally
-----------

```powershell
cd backend
npm install
npm run dev
```

Required and important env vars
-------------------------------

- `MONGODB_URI` (required)
- `MONGODB_DB_NAME` (optional, default: `testhive`)
- `MONGODB_APP_NAME` (optional)
- `PORT` (optional, default: `8000`)
- `QT_URL`, `QT_USER`, `QT_PASS` (used as defaults for automation calls)

Migration note
--------------

If your environment still has old JSON data from earlier versions, run:

```powershell
cd backend
npm run migrate:json-to-mongo:dry
npm run migrate:json-to-mongo
```
