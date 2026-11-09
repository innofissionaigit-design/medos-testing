import { authedFetch } from "@/lib/server";

export async function GET(): Promise<Response> {
  const res = await authedFetch("/auth/me");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
