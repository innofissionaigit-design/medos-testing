/** Browser-side API client. All calls go through the same-origin gateway (/api/proxy); tokens are never visible to this code. */

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;
export interface Page<T> { data: T[]; meta: { page: number; pageSize: number; total: number } }

const qs = (q?: Query): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

interface Opts { query?: Query; body?: unknown; key?: string }

async function request<T>(method: string, path: string, o: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-medos-csrf"] = "1";
  if (o.key) headers["idempotency-key"] = o.key;
  const res = await fetch(`/api/proxy${path}${qs(o.query)}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), credentials: "same-origin" });
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") window.location.assign("/login");
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: unknown } } & T;
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "ERROR", json.error?.message ?? "Something went wrong", json.error?.details);
  return json;
}

/** A new key per user action: a double-click or retry of the same action replays instead of repeating. */
export const newKey = (): string => crypto.randomUUID();

export const api = {
  get: async <T>(path: string, query?: Query): Promise<T> => (await request<{ data: T }>("GET", path, { query }))?.data as T,
  page: <T>(path: string, query?: Query): Promise<Page<T>> => request<Page<T>>("GET", path, { query }),
  post: async <T>(path: string, body?: unknown, key?: string): Promise<T> => (await request<{ data: T }>("POST", path, { body: body ?? {}, key }))?.data as T,
  put: async <T>(path: string, body?: unknown): Promise<T> => (await request<{ data: T }>("PUT", path, { body: body ?? {} }))?.data as T,
  del: async <T>(path: string): Promise<T> => (await request<{ data: T }>("DELETE", path, {}))?.data as T,
  patch: async <T>(path: string, body?: unknown): Promise<T> => (await request<{ data: T }>("PATCH", path, { body: body ?? {} }))?.data as T,
};

/** Opens a printable server-rendered document in a new tab. */
export const printUrl = (path: string): string => `/api/proxy/print/${path}`;

/** Collapses an API error into a short sentence for the user. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "VALIDATION_FAILED" && Array.isArray(e.details) && e.details.length) {
      return (e.details as { path?: string; message?: string }[]).slice(0, 3).map((d) => `${d.path ? `${d.path}: ` : ""}${d.message ?? ""}`).join("; ");
    }
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}
