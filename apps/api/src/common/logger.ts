type Level = "info" | "warn" | "error";

const REDACT = /password|token|secret|authorization|hash/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? "[REDACTED]" : v;
  return out;
}

/** Structured JSON logging. Callers pass identifiers and codes, never request bodies or clinical content. */
export function logJson(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env["NODE_ENV"] === "test" && process.env["LOG_IN_TEST"] !== "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}
