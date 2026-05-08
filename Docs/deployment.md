# Deployment

This project is organized for local development. Below are notes and recommendations for production deployments.

1) Containerization
-------------------

- Backend: build a Node image and run `node server.js`. Expose `PORT` and mount artifact storage (S3 or persistent volume).
- Frontend: build static assets with `npm run build` and serve using Nginx or a static hosting service.
- Playwright: run tests in a dedicated runner with browsers installed (Playwright's Docker images are recommended). Running Playwright in the same container as the Express server is not recommended for production.

2) Recommended architecture
---------------------------

- Frontend (static) behind CDN
- Backend API behind an authenticated gateway (OAuth/JWT)
- Queue (Redis + Bull) for long-running Playwright tasks
- Worker pool of Playwright runners that consumes the queue and uploads artifacts to object storage (S3)

3) Example (conceptual) Docker Compose services

```
web:  # frontend
  image: nginx:alpine
  volumes: [ ./frontend/dist:/usr/share/nginx/html ]

api:  # backend
  build: ./backend
  ports: [ 8000:8000 ]
  env_file: .env

worker:  # playwright runner
  image: mcr.microsoft.com/playwright:focal
  volumes: [ ./playwright-tests:/work/playwright-tests ]
  command: node run-worker.js
```

4) Secrets & artifacts
----------------------

- Use environment secrets in CI for `QT_USER`, `QT_PASS`, and deployment keys.
- Move artifacts to S3 or equivalent and store only metadata in the service to save disk space.
