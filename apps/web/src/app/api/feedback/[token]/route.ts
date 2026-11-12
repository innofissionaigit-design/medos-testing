import type { NextRequest } from "next/server";
import { API_URL } from "@/lib/server";

/**
 * The patient's side of the feedback form (docs/aftercare.md): opens with the secret link alone, no sign-in. This only relays to the API's public endpoint, which does all the
 * checking; no cookies or tokens are sent either way, and a wrong, expired or used link all answer the same.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const bad = () => json(404, { error: { code: "NOT_FOUND", message: "This link is not valid or has expired" } });

async function relay(req: NextRequest, token: string, method: "GET" | "POST"): Promise<Response> {
  if (!TOKEN.test(token)) return bad();
  const forwardedFor = req.headers.get("x-forwarded-for")?.slice(0, 512);
  const body = method === "POST" ? await req.text() : undefined;
  if (body !== undefined && body.length > 8000) return json(400, { error: { code: "VALIDATION_FAILED", message: "Too much text" } });
  const res = await fetch(`${API_URL}/public/feedback/${token}`, {
    method, cache: "no-store", ...(body !== undefined ? { body } : {}),
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
  }).catch(() => null);
  if (!res) return json(502, { error: { code: "UNAVAILABLE", message: "Please try again later" } });
  if (res.status === 404) return bad();
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<Response> { return relay(req, (await ctx.params).token, "GET"); }
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<Response> { return relay(req, (await ctx.params).token, "POST"); }
