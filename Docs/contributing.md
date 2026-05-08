# Contributing

Guidelines
----------

- Branch per feature: `feature/<short-desc>` or `fix/<short-desc>`.
- Keep commits small and focused; write clear commit messages.
- Open a PR and include a short description of the change, how to test it, and any relevant screenshots or logs.

Code & tests
------------

- Keep Playwright entry scripts deterministic and ensure they emit JSON on `stdout` for backend parsing.
- When adding helper functions, include a short usage example in `playwright-tests/helpers/`.

Local verification
------------------

1. Start backend

```powershell
cd backend
npm install
npm run dev
```

2. Start frontend

```powershell
cd frontend
npm install
npm run dev
```

3. Run a Playwright entry script (optionally)

```powershell
cd playwright-tests
npx playwright install
QT_URL="https://..." QT_USER=qa QT_PASS=secret node fetch-masters.js
```
