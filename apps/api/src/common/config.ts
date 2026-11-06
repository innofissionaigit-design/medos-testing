import { readFileSync } from "node:fs";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Which environment this is (CLAUDE.md §50). "staging" and "production" switch on the deployment safety checks below,
  // so a hospital deployment cannot start with development secrets, a development database or localhost origins.
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_SECONDS: z.coerce.number().int().positive().default(900),
  /** Wrong passwords count towards a lock only if they are this close together; an occasional typo weeks apart never locks anyone. */
  LOGIN_FAILURE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // "database" shares the allowance across every API instance; "memory" counts per process (single instance only).
  RATE_LIMIT_STORE: z.enum(["database", "memory"]).default("database"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  TRUST_PROXY: z.string().trim().default("loopback").transform((v) => (v.toLowerCase() === "false" ? false : v)),
  STORAGE_DIR: z.string().default("./.local/storage"),
  // Row-level security (docs/rls.md). "on" sets the tenant on every query's connection and refuses queries that have no tenant;
  // "off" (default until phase 3) leaves the connection exactly as before. Must be "on" for a restricted-role DATABASE_URL.
  DB_TENANT_CONTEXT: z.enum(["on", "off"]).default("off"),
  // Development and tests only: act as this role inside every transaction (SET LOCAL ROLE) to prove the policies are respected
  // without a second database login. Never allowed in production, where the DATABASE_URL itself is the restricted role.
  DB_SESSION_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  // Virus scan of uploaded patient files through a ClamAV daemon. Unset = not scanned (development). Set = every upload is scanned,
  // and uploads are refused while the scanner is unreachable.
  CLAMAV_HOST: z.string().trim().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  // Where patient files are kept. "local" = STORAGE_DIR on this machine (one API instance only). "s3" = any S3-compatible store
  // (AWS S3, Cloudflare R2, Ceph, SeaweedFS…), shared by every instance (docs/storage.md). With S3_ACCESS_KEY_ID and
  // S3_SECRET_ACCESS_KEY unset, credentials come from the environment's default chain (for example an IAM role).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().trim().min(3).max(63).optional(),
  S3_REGION: z.string().trim().min(1).optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  S3_PREFIX: z.string().trim().max(200).regex(/^([A-Za-z0-9._-]+\/)*$/, "must be folders ending in a slash, e.g. medos/").default(""),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  S3_KMS_KEY_ID: z.string().trim().min(1).optional(),
  // Argon2id password hashing (docs/adr/011-argon2id.md). Defaults are the OWASP minimum for Argon2id (19 MiB, 2 passes, 1 lane);
  // production refuses anything weaker. Tests and local development may lower them for speed.
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).max(1_048_576).default(19_456),
  ARGON2_PASSES: z.coerce.number().int().min(1).max(10).default(2),
  // Follow-up reminders (docs/follow-ups.md). "log" records and logs reminders without sending anything.
  REMINDER_PROVIDER: z.enum(["log"]).default("log"),
  /** Requests per minute allowed for one API key (docs/integration-api.md). */
  API_CLIENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(120),
  /** How booking payment links are delivered. Only "log" exists (a placeholder: nothing is sent), see docs/booking-payment-link.md. */
  PAYMENT_LINK_PROVIDER: z.enum(["log"]).default("log"),
  // Handwritten prescription OCR (docs/prescriptions.md). "none" = no OCR service connected: scans are stored and the doctor types what they say.
  // "http" calls OCR_API_URL with the image; OCR_API_KEY (or OCR_API_KEY_FILE) is sent as a bearer token when set.
  OCR_PROVIDER: z.enum(["none", "http"]).default("none"),
  OCR_API_URL: z.string().url().optional(),
  OCR_API_KEY: z.string().min(1).optional(),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** Encrypts API keys that administrators save in the app (the OCR service key). Base64 of 32 random bytes; generate with `openssl rand -base64 32`. */
  SECRETS_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be base64 of exactly 32 bytes").optional(),
  // Messages to patients, such as the prescription link (docs/prescriptions.md). "log" records what would be sent and sends nothing; "http" posts each message to
  // MESSAGE_API_URL (MESSAGE_API_KEY, or MESSAGE_API_KEY_FILE, is sent as a bearer token when set): the hospital's approved WhatsApp or SMS service.
  MESSAGE_PROVIDER: z.enum(["log", "http"]).default("log"),
  MESSAGE_API_URL: z.string().url().optional(),
  MESSAGE_API_KEY: z.string().min(1).optional(),
  MESSAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  // Email (docs/email.md). "log" records what would be sent and sends nothing; "http" posts each email to EMAIL_API_URL (EMAIL_API_KEY, or EMAIL_API_KEY_FILE, is sent as a bearer token).
  // EMAIL_FROM_ADDRESS is the sender address the hospital has verified with its email service (SPF, DKIM and DMARC are set in DNS, not here).
  EMAIL_PROVIDER: z.enum(["log", "http"]).default("log"),
  EMAIL_API_URL: z.string().url().optional(),
  EMAIL_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  EMAIL_WORKER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  EMAIL_POLL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  /** The website's public address, used in links sent to patients. Defaults to the first CORS origin. */
  PUBLIC_WEB_URL: z.string().url().optional(),
  /** Base of the payment link text. The default is deliberately not a real address. */
  PAYMENT_LINK_BASE_URL: z.string().url().default("https://pay.example.invalid/booking"),
  REMINDER_WORKER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  REMINDER_POLL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
});

const checked = schema.superRefine((c, ctx) => {
  if (c.DB_SESSION_ROLE && c.DB_TENANT_CONTEXT !== "on") ctx.addIssue({ code: "custom", path: ["DB_SESSION_ROLE"], message: "requires DB_TENANT_CONTEXT=on" });
  if (c.DB_SESSION_ROLE && c.NODE_ENV === "production") ctx.addIssue({ code: "custom", path: ["DB_SESSION_ROLE"], message: "is not allowed in production" });
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "is required when STORAGE_DRIVER=s3" });
  if (c.STORAGE_DRIVER === "s3" && !c.S3_REGION) ctx.addIssue({ code: "custom", path: ["S3_REGION"], message: "is required when STORAGE_DRIVER=s3" });
  if (c.OCR_PROVIDER === "http" && !c.OCR_API_URL) ctx.addIssue({ code: "custom", path: ["OCR_API_URL"], message: "OCR_API_URL is required when OCR_PROVIDER=http" });
  if (c.MESSAGE_PROVIDER === "http" && !c.MESSAGE_API_URL) ctx.addIssue({ code: "custom", path: ["MESSAGE_API_URL"], message: "MESSAGE_API_URL is required when MESSAGE_PROVIDER=http" });
  if (c.EMAIL_PROVIDER === "http" && !c.EMAIL_API_URL) ctx.addIssue({ code: "custom", path: ["EMAIL_API_URL"], message: "EMAIL_API_URL is required when EMAIL_PROVIDER=http" });
  if (c.EMAIL_PROVIDER === "http" && !c.EMAIL_FROM_ADDRESS) ctx.addIssue({ code: "custom", path: ["EMAIL_FROM_ADDRESS"], message: "EMAIL_FROM_ADDRESS is required when EMAIL_PROVIDER=http" });
  if (!!c.S3_ACCESS_KEY_ID !== !!c.S3_SECRET_ACCESS_KEY) ctx.addIssue({ code: "custom", path: ["S3_SECRET_ACCESS_KEY"], message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together" });
  if (c.S3_KMS_KEY_ID && c.S3_SSE !== "aws:kms") ctx.addIssue({ code: "custom", path: ["S3_KMS_KEY_ID"], message: "needs S3_SSE=aws:kms" });
  if (c.NODE_ENV === "production" && c.ARGON2_MEMORY_KIB < 19_456) ctx.addIssue({ code: "custom", path: ["ARGON2_MEMORY_KIB"], message: "must be at least 19456 in production" });
  if (c.NODE_ENV === "production" && c.ARGON2_PASSES < 2) ctx.addIssue({ code: "custom", path: ["ARGON2_PASSES"], message: "must be at least 2 in production" });

  if (c.APP_ENV !== "local") {
    const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (c.NODE_ENV !== "production") bad("NODE_ENV", `must be production when APP_ENV=${c.APP_ENV}`);
    if (PLACEHOLDER_SECRET.test(c.JWT_ACCESS_SECRET)) bad("JWT_ACCESS_SECRET", "looks like a placeholder or development secret");
    if (!c.RATE_LIMIT_ENABLED) bad("RATE_LIMIT_ENABLED", "must stay on");
    try {
      const db = new URL(c.DATABASE_URL);
      if (/_(dev|test|e2e)$/.test(db.pathname.slice(1)) || db.port === "54329") bad("DATABASE_URL", "points at a development or test database");
    } catch { bad("DATABASE_URL", "is not a valid URL"); }
    const origins = c.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
    if (origins.length === 0 || origins.some((o) => !o.startsWith("https://") || /\/\/(localhost|127\.|\[::1\])/i.test(o))) bad("CORS_ORIGINS", "must be the https:// address of the real site, not localhost");
  }
});

/** Secrets that were copied from an example or used in development and tests. */
const PLACEHOLDER_SECRET = /change-?me|dev-only|ci-only|e2e-only|unit-test|test-access|example|password|x{8,}/i;

/** Settings that may instead be given as `<NAME>_FILE`, the path of a file holding the value (Docker and Kubernetes secrets). */
const FILE_SECRETS = ["DATABASE_URL", "JWT_ACCESS_SECRET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "OCR_API_KEY", "MESSAGE_API_KEY", "EMAIL_API_KEY", "SECRETS_ENCRYPTION_KEY"] as const;

/**
 * Empty values count as unset (Docker passes an empty string for a variable that is merely declared), and `<NAME>_FILE`
 * is read into `<NAME>`. Giving both, or a file that is missing or empty, is an error. Only setting names are reported, never values.
 */
function resolveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== "") out[k] = v;
  const bad: string[] = [];
  for (const name of FILE_SECRETS) {
    const path = out[`${name}_FILE`];
    if (path === undefined) continue;
    if (out[name] !== undefined) { bad.push(`${name}_FILE`); continue; }
    try {
      const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
      if (value === "") bad.push(`${name}_FILE`); else out[name] = value;
    } catch {
      bad.push(`${name}_FILE`);
    }
  }
  if (bad.length > 0) throw new Error(`Invalid configuration: ${bad.join(", ")}`);
  return out;
}

export type AppConfig = z.infer<typeof schema>;

export const CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = checked.safeParse(resolveEnv(env));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
