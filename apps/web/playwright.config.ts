import { defineConfig } from "@playwright/test";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const API_PORT = 4100;
const WEB_PORT = 3100;
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgresql://medos@127.0.0.1:54329/medos_e2e";

/**
 * Browser end-to-end tests. They run against a real PostgreSQL database (medos_e2e, rebuilt and seeded by e2e/prepare.mjs), the real
 * API and the real production build of the web app. Nothing is mocked.
 *   pnpm --filter @medos/api build && pnpm --filter @medos/web build && pnpm --filter @medos/web e2e
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1360, height: 900 } },
  webServer: [
    {
      command: "node apps/api/dist/main.js", cwd: root, url: `http://127.0.0.1:${API_PORT}/api/v1/health`, reuseExistingServer: false, timeout: 60_000,
      env: { DATABASE_URL: DB_URL, JWT_ACCESS_SECRET: "e2e-only-secret-e2e-only-secret-0001", PORT: String(API_PORT), ARGON2_MEMORY_KIB: "1024", ARGON2_PASSES: "1", RATE_LIMIT_ENABLED: "false", CORS_ORIGINS: `http://localhost:${WEB_PORT}`, ...(process.platform === "win32" ? { PRISMA_ENGINES_CACHE_DIR: process.env.PRISMA_ENGINES_CACHE_DIR ?? "D:\\.cache\\prisma" } : {}) },
    },
    {
      command: `pnpm --filter @medos/web exec next start -p ${WEB_PORT}`, cwd: root, url: `http://localhost:${WEB_PORT}/login`, reuseExistingServer: false, timeout: 60_000,
      env: { API_URL: `http://127.0.0.1:${API_PORT}/api/v1`, NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
