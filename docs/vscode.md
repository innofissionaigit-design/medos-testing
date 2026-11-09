# Reviewing and checking the code in VS Code

1. **Open the folder** `D:\Claude\medos` (File → Open Folder). Accept "Install recommended extensions" (ESLint, Prettier, Tailwind, Prisma, Playwright, Error Lens, GitLens). When asked, choose "Use workspace TypeScript version".
2. **Run everything in one go:** `Ctrl+Shift+P` → *Tasks: Run Test Task* → "Check: everything" (lint → typecheck → API tests → web tests → build → licences). Or run the individual `Check:` tasks from *Tasks: Run Task*.
3. **See problems as you read:** the Problems panel (`Ctrl+Shift+M`) shows ESLint and TypeScript errors; Error Lens shows them inline. It should be empty.
4. **Navigate the code:** `Ctrl+P` opens any file by name; `Ctrl+T` any symbol; `F12` go to definition; `Shift+F12` all references; `Ctrl+Shift+F` search across the repo.
5. **Run the app:** tasks *Run: database*, *Run: API :4000*, *Run: web :3000*, then open http://localhost:3000.
6. **Debug:** *Run and Debug* (`Ctrl+Shift+D`) has "Debug API", "Debug one API test file" and "Debug web (Chrome)".
7. **Browser tests:** the Playwright extension lists `apps/web/e2e/*.spec.ts` in the Testing sidebar.

## Where things live
| Path | What |
|---|---|
| `apps/api/src/modules/<module>` | one folder per business module: `*.controller.ts` (HTTP), `*.service.ts` (rules), `*.spec.ts` (tests) |
| `apps/api/src/common` | auth guard, audit, idempotency, errors, config |
| `apps/api/src/e2e` | OPD and IPD certification tests |
| `packages/database/prisma/schema/*.prisma` | data model; `schema/migrations` holds SQL (triggers, constraints) |
| `packages/shared/src` | permissions, error codes, money |
| `apps/web/src/app/(app)/*` | screens; `components/` shared UI; `lib/` API client, nav, session |
| `apps/web/e2e` | browser tests |
| `docs/` | spec, ADRs, `modules.md`, `api-routes.md`, `certification.md`; `REMINDER.md` at the root lists deferred work |
