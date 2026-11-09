import { cookies } from "next/headers";
import { API_URL, clearSession, RT } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("x-medos-csrf") !== "1") return Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
  const rt = (await cookies()).get(RT)?.value;
  if (rt) await fetch(`${API_URL}/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }), cache: "no-store" }).catch(() => undefined);
  await clearSession();
  return Response.json({ data: { ok: true } });
}
