import { z } from "zod";
import { csrfOk, forbidden, PORTAL } from "@/lib/patient-server";

const schema = z.object({ hospitalCode: z.string().min(2).max(40), mobile: z.string().min(10).max(15) }).strict();

/** Asks the API to send a sign-in code to the patient's mobile. The answer is always the same, whoever asks. */
export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return forbidden();
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Enter the hospital code and your mobile number" } }, { status: 400 });
  const forwardedFor = req.headers.get("x-forwarded-for")?.slice(0, 512);
  const res = await fetch(`${PORTAL}/auth/code`, { method: "POST", headers: { "content-type": "application/json", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) }, body: JSON.stringify(input.data), cache: "no-store" }).catch(() => null);
  if (!res) return Response.json({ error: { code: "UNAVAILABLE", message: "Please try again in a moment" } }, { status: 502 });
  return Response.json(await res.json().catch(() => ({})), { status: res.status });
}
