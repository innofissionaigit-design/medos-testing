import { z } from "zod";
import { API_URL, setSession, type Tokens } from "@/lib/server";

const schema = z.object({ tenantCode: z.string().min(2).max(40), identifier: z.string().min(1).max(120), password: z.string().min(1).max(200), facilityId: z.string().uuid().optional() }).strict();

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("x-medos-csrf") !== "1") return Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Enter your hospital code, username and password" } }, { status: 400 });
  // Relay the browser's address chain so the API rate-limits logins per client rather than per web server.
  const forwardedFor = req.headers.get("x-forwarded-for")?.slice(0, 512);
  const res = await fetch(`${API_URL}/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) }, body: JSON.stringify(input.data), cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as { data?: { status: string; tokens?: Tokens; facilities?: unknown[] }; error?: unknown };
  if (!res.ok || !json.data) return Response.json(json, { status: res.status });
  if (json.data.status === "AUTHENTICATED" && json.data.tokens) {
    await setSession(json.data.tokens);
    return Response.json({ data: { status: "AUTHENTICATED" } });
  }
  return Response.json({ data: { status: json.data.status, facilities: json.data.facilities } });
}
