import { clearPatientSession, csrfOk, forbidden, patientToken, PORTAL } from "@/lib/patient-server";

export async function POST(req: Request): Promise<Response> {
  if (!csrfOk(req)) return forbidden();
  const token = await patientToken();
  if (token) await fetch(`${PORTAL}/logout`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", cache: "no-store" }).catch(() => null);
  await clearPatientSession();
  return Response.json({ data: { signedOut: true } });
}
