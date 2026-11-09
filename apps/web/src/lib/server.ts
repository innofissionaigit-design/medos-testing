import { cookies } from "next/headers";

/** Server-side only (imports next/headers): the API origin is never exposed to the browser bundle. */
export const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:4000/api/v1";
export const AT = "medos_at";
export const RT = "medos_rt";
const REFRESH_TTL_SECONDS = 7 * 24 * 3600;

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }

const opts = (maxAge: number) => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge });

export async function setSession(t: Tokens): Promise<void> {
  const jar = await cookies();
  jar.set(AT, t.accessToken, opts(Math.max(30, t.expiresIn - 15)));
  jar.set(RT, t.refreshToken, opts(REFRESH_TTL_SECONDS));
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(AT);
  jar.delete(RT);
}

/**
 * Refresh tokens rotate and reuse revokes the whole family (API rule). Several parallel requests can arrive carrying the same
 * expired session, so refreshes are single-flight per refresh token, and the result is kept briefly for late arrivals that
 * still hold the old cookie. (Per instance; behind several web instances use sticky sessions or a shared cache.)
 */
const inflight = new Map<string, Promise<Tokens | null>>();

async function doRefresh(rt: string): Promise<Tokens | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }), cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { tokens?: Tokens } & Partial<Tokens> };
  return (json.data?.tokens ?? (json.data?.accessToken ? (json.data as Tokens) : null)) ?? null;
}

export async function refreshSession(): Promise<string | null> {
  const jar = await cookies();
  const rt = jar.get(RT)?.value;
  if (!rt) return null;
  let p = inflight.get(rt);
  if (!p) {
    p = doRefresh(rt).finally(() => { setTimeout(() => inflight.delete(rt), 15_000); });
    inflight.set(rt, p);
  }
  const tokens = await p;
  if (!tokens) { await clearSession(); return null; }
  await setSession(tokens);
  return tokens.accessToken;
}

export interface ForwardInit { method?: string; body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal }

/** Calls the API as the logged-in user; refreshes the session once if the access token is missing or rejected. */
export async function authedFetch(path: string, init: ForwardInit = {}): Promise<Response> {
  const jar = await cookies();
  let at: string | null = jar.get(AT)?.value ?? (await refreshSession());
  if (!at) return new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Please sign in" } }), { status: 401, headers: { "content-type": "application/json" } });
  const call = (token: string) => fetch(`${API_URL}${path}`, { method: init.method ?? "GET", body: init.body ?? null, headers: { ...init.headers, authorization: `Bearer ${token}` }, cache: "no-store", ...(init.signal ? { signal: init.signal } : {}) });
  let res = await call(at);
  if (res.status === 401) {
    at = await refreshSession();
    if (at) res = await call(at);
  }
  return res;
}
