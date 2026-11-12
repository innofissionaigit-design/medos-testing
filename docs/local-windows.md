# Running MedOS locally on Windows (this demo PC)

The demo runs entirely on this computer: PostgreSQL, the API and the web app.

| Piece | Where | Port |
|---|---|---|
| PostgreSQL 17 (portable) | programs in `C:\medos-pg\pgsql`, data in `C:\medos-pg-test` (databases `medos_dev` for the demo, `medos_test` for tests) | 54330 |
| Watchdog | `C:\medos-pg-ctl\watchdog.ps1`: restarts PostgreSQL if its main process disappears | - |
| API | `apps/api/dist/main.js`, started by `.local\start-api.cmd` | 4000 |
| Web app | Next.js dev server, started by `.local\start-web.cmd` | 3000 |

**Start everything:** `powershell -ExecutionPolicy Bypass -File .local\start-medos.ps1` (safe to run again; anything running is left alone).
**Stop everything:** `powershell -ExecutionPolicy Bypass -File .local\stop-medos.ps1` (a clean PostgreSQL shutdown).
Sign in at http://localhost:3000 with hospital code `demo-hospital`; every demo user has the password in `.local\seed-password.txt`.

**Why the old database was moved.** The first cluster (`.local\pgdata`, port 54329) was repeatedly stopped from outside (a console Ctrl+C reaching its process group, and processes ended whenever the Claude session that started them restarted). Some of those stops corrupted data files (an index that could not be read, rows and a table missing). The demo and test databases were rebuilt on a fresh cluster outside the project folder; the old cluster is left untouched on disk. Starting the servers through Windows' own process service in a new process group (what the scripts do) and the watchdog keep them running; a clean stop goes through `stop-medos.ps1`.

**Browser end-to-end tests** (Playwright) need the production builds and their own database:
```
pnpm --filter @medos/api build
pnpm --filter @medos/web build
set E2E_PG_PORT=54330
set E2E_SKIP_DB_UP=1
set PG_BIN=C:\medos-pg\pgsql\bin
set E2E_DATABASE_URL=postgresql://medos@127.0.0.1:54330/medos_e2e
pnpm --filter @medos/web e2e
```
Stop the web dev server first (both use `apps\web\.next`), and delete `apps\web\.next` before starting the dev server again.
