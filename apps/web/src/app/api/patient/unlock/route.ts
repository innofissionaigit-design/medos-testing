import { z } from "zod";
import { addPatientProof, clearPatientSession, csrfOk, forbidden, patientProofs, patientToken, PORTAL } from "@/lib/patient-server";

const schema = z.object({ patientId: z.string().uuid(), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

/** Confirms a patient's date of birth with the API and keeps the signed proof in an httpOnly cookie; the page only learns whether it worked. */
export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return forbidden();
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Enter the date of birth" } }, { status: 400 });
  const token = await patientToken();
  if (!token) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in" } }, { status: 401 });
  const proofs = (await patientProofs()).join(",");
  const res = await fetch(`${PORTAL}/unlock`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(proofs ? { "x-patient-proofs": proofs } : {}) }, body: JSON.stringify(input.data), cache: "no-store" }).catch(() => null);
  if (!res) return Response.json({ error: { code: "UNAVAILABLE", message: "Please try again in a moment" } }, { status: 502 });
  const json = (await res.json().catch(() => ({}))) as { data?: { proof: string; expiresAt: string }; error?: unknown };
  if (res.status === 401) await clearPatientSession();
  if (!res.ok || !json.data) return Response.json(json, { status: res.status });
  await addPatientProof(json.data.proof, json.data.expiresAt);
  return Response.json({ data: { unlocked: true } });
}
