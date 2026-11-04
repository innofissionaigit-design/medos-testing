// Applies committed migrations to the dedicated TEST database only.
// Refuses to run unless the target database name ends with "_test".
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TEST_DATABASE_URL ?? "postgresql://medos@127.0.0.1:54329/medos_test";
const dbName = new URL(url).pathname.replace("/", "");
if (!dbName.endsWith("_test")) {
  console.error(`Refusing to run tests against database "${dbName}" (must end with _test)`);
  process.exit(1);
}
const dbPkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/database");
const r = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  cwd: dbPkg,
  env: { ...process.env, DATABASE_URL: url},
  shell: true,
  stdio: "inherit",
});
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

// Row-level security tests connect as the restricted application role (docs/rls.md), so that role needs a login on this database
// cluster. Only on a local or CI database, and the secret stays out of git: a generated password in .local/app-db.env
// (or APP_DB_PASSWORD). On any other server, enable the login yourself and give the tests TEST_APP_DATABASE_URL.
const host = new URL(url).hostname;
const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || process.env.CI === "true";
if (!isLocal) {
  console.log(`Not enabling the medos_app login on "${host}" (not a local or CI database). See docs/rls.md.`);
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = resolve(root, ".local/app-db.env");
let pw = process.env.APP_DB_PASSWORD ?? (existsSync(envFile) ? /^APP_DB_PASSWORD=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim() : undefined);
if (!pw) {
  pw = randomBytes(24).toString("base64url");
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, `APP_DB_PASSWORD=${pw}
`);
}
if (!/^[A-Za-z0-9_-]{16,}$/.test(pw)) {
  console.error("APP_DB_PASSWORD must be at least 16 characters of letters, digits, - and _");
  process.exit(1);
}
const e = spawnSync("pnpm", ["exec", "prisma", "db", "execute", "--url", url, "--stdin"], {
  cwd: dbPkg,
  input: `ALTER ROLE medos_app LOGIN PASSWORD '${pw}';`,
  shell: true,
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(e.status ?? 1);
