# Deployment

This repository is designed for local development but includes recommendations for production deployments. Key decisions: persist metadata to MongoDB, store binaries (screenshots/videos) in object storage or a persistent volume, and run Playwright automation in dedicated workers.

Core production considerations
-----------------------------

- Metadata store: use a managed MongoDB (Atlas) reachable by the backend. Provide `MONGODB_URI`, `MONGODB_DB_NAME`, and `MONGODB_APP_NAME` to the backend container.
- Playwright workers: run Playwright tests in separate worker containers (use Playwright's official Docker images) or a managed runner that has browsers installed.
- Artifacts: upload screenshots/videos to object storage (S3) from workers and save only metadata in MongoDB. Alternatively mount a shared persistent volume accessible to backend and worker nodes.
- Queue: long-running runs should be offloaded to a job queue (Redis + Bull) so the API returns quickly and workers process tasks asynchronously.

Example Docker Compose (conceptual)
----------------------------------

```yaml
version: '3.8'
services:
  mongo:
    image: mongo:6
    volumes:
      - mongo-data:/data/db

  api:
    build: ./backend
    ports:
      - "8000:8000"
    env_file: ./backend/.env
    depends_on:
      - mongo

  web:
    image: nginx:alpine
    volumes:
      - ./frontend/dist:/usr/share/nginx/html:ro
    depends_on:
      - api

  worker:
    image: mcr.microsoft.com/playwright:focal
    working_dir: /work/playwright-tests
    volumes:
      - ./playwright-tests:/work/playwright-tests:rw
    command: ["node", "worker-runner.js"] # implement a small worker that consumes a queue
    depends_on:
      - api

volumes:
  mongo-data:
```

Notes:

- Replace `worker-runner.js` with your worker entrypoint. Prefer using a queue (e.g., Redis) to dispatch jobs to multiple workers.
- If you use S3 for artifacts, workers should upload artifacts and the backend should only save metadata in MongoDB.

Migration and startup
---------------------

- If migrating from legacy JSON files, use the provided migration tool in [backend/scripts/migrate-json-to-mongo.js](backend/scripts/migrate-json-to-mongo.js):

```powershell
cd backend
npm install
npm run migrate:json-to-mongo:dry
npm run migrate:json-to-mongo
```

- Ensure `MONGODB_URI` is set before starting the backend. The backend will fail to start if `MONGODB_URI` is not provided (see [backend/db/mongoClient.js](backend/db/mongoClient.js)).

Secrets & CI
------------

- Keep secrets out of the repo. Use CI/CD secret stores for `QT_USER`, `QT_PASS`, `MONGODB_URI`, and any cloud credentials.
- For CI Playwright runs, prefer Playwright Docker images and `npx playwright install --with-deps` in the CI job.

Further suggestions
-------------------

1. Add an API gateway (JWT/OAuth) in front of the backend for production.
2. Use server-side pagination for `GET /api/test-reports` if you expect a large amount of historical data.
3. Instrument uploads and retention policies for artifact storage (S3 lifecycle rules or scheduled cleanup job).

If you want, I can draft a concrete `docker-compose.yml` and a small `worker-runner.js` that consumes a Redis queue and invokes `node playwright-tests/crud-master.js` with environment variables. Would you like that?
