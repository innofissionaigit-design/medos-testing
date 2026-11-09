import { cookies } from "next/headers";
import { z } from "zod";
import { authedFetch, RT, setSession, type Tokens } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("x-medos-csrf") !== "1") return Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
  const input = z.object({ facilityId: z.string().uuid() }).strict().safeParse(await req.json().catch(() => null));
  const rt = (await cookies()).get(RT)?.value;
  if (!input.success || !rt) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Choose a facility" } }, { status: 400 });
  const res = await authedFetch("/auth/switch-facility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt, facilityId: input.data.facilityId }) });
  const json = (await res.json().catch(() => ({}))) as { data?: { tokens?: Tokens } & Partial<Tokens>; error?: unknown };
  if (!res.ok) return Response.json(json, { status: res.status });
  await setSession((json.data?.tokens ?? json.data) as Tokens);
  return Response.json({ data: { ok: true } });
}
