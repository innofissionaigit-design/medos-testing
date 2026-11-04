import type { NextRequest } from "next/server";
import { API_URL } from "@/lib/server";

/**
 * The patient's side of a shared prescription (docs/prescriptions.md): opens with the secret link alone, no sign-in. This only relays the request to the API's
 * public endpoint (which does all the checking) and passes the document back with its locked-down headers. No cookies or tokens are sent either way.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const bad = () => new Response("This link is not valid or has expired.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (!TOKEN.test(token)) return bad();
  const forwardedFor = req.headers.get("x-forwarded-for")?.slice(0, 512);
  const format = req.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "html";
  const download = req.nextUrl.searchParams.get("download") === "1" ? "1" : "0";
  const res = await fetch(`${API_URL}/public/prescriptions/${token}?format=${format}&download=${download}`, { cache: "no-store", headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} }).catch(() => null);
  if (!res || res.status === 404) return bad();
  if (!res.ok) return new Response("The prescription cannot be shown right now. Please try again later.", { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const out = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  for (const h of ["content-type", "content-disposition", "content-security-policy"]) { const v = res.headers.get(h); if (v) out.set(h, v); }
  return new Response(res.body, { status: 200, headers: out });
}
