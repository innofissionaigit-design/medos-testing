import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Conn { host: string; port: string; user: string; password: string | undefined; database: string; sslmode: string | undefined }

/** Splits a DATABASE_URL so credentials travel in the environment (PG*), never on a command line. */
export function parseDatabaseUrl(url: string): Conn {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DATABASE_URL must be a postgresql:// URL");
  return {
    host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username), password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")), sslmode: u.searchParams.get("sslmode") ?? undefined,
  };
}

export function pgEnv(c: Conn, database = c.database, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: c.host, PGPORT: c.port, PGUSER: c.user, PGDATABASE: database, ...extra };
  if (c.password !== undefined) env["PGPASSWORD"] = c.password;
  if (c.sslmode) env["PGSSLMODE"] = c.sslmode;
  return env;
}

/** PG_BIN (a directory) wins; otherwise the program is looked up on PATH. */
export function pgBinary(name: "pg_dump" | "pg_restore" | "psql", bin = process.env["PG_BIN"]): string {
  if (!bin) return name;
  const exe = resolve(bin, process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(exe)) throw new Error(`${name} not found in PG_BIN (${bin})`);
  return exe;
}

export interface RunResult { code: number; stdout: string; stderr: string }

/** `detached` is for pg_ctl start: the server it leaves running inherits the output pipes, so waiting for them to close would never end. */
export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, opts: { shell?: boolean; detached?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { env, windowsHide: true, shell: opts.shell ?? false });
    let stdout = ""; let stderr = "";
    p.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    p.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    p.on("error", (e) => reject(new Error(`Could not run ${cmd}: ${e.message}`)));
    p.on(opts.detached ? "exit" : "close", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

/** A database name must be plain: it is placed in SQL and in a file name. */
export function assertPlainName(name: string): string {
  if (!/^[A-Za-z0-9_]{1,50}$/.test(name)) throw new Error(`Database name "${name}" must be 1-50 letters, digits or underscores`);
  return name;
}

export async function psql(conn: Conn, bin: string | undefined, database: string, args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return run(pgBinary("psql", bin), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", database, ...args], pgEnv(conn, database, extraEnv));
}
