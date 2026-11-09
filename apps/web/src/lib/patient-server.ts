import { cookies } from "next/headers";
import { API_URL } from "./server";

/** Server-side only. The patient app's session token lives in an httpOnly cookie of its own, so page JavaScript never sees it and a staff session is never mixed with it. */
export const PT = "medos_pt";
const opts = (maxAge: number) => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge });
export const PORTAL = `${API_URL}/patient-portal`;

export async function setPatientSession(token: string, expiresAt: string): Promise<void> {
  const maxAge = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  (await cookies()).set(PT, token, opts(maxAge));
}
export async function clearPatientSession(): Promise<void> { const jar = await cookies(); jar.delete(PT); jar.delete(PP); }
export async function patientToken(): Promise<string | null> { return (await cookies()).get(PT)?.value ?? null; }

/**
 * Proofs that this browser confirmed a patient's date of birth (docs/patient-app.md). Each is signed by the API for one session and one patient and expires on
 * its own, so this cookie cannot be used to open anyone else's records; it is httpOnly and forwarded to the API by the gateway.
 */
export const PP = "medos_pp";
const PROOF_PATIENT = /^[0-9a-f-]{36}\./;
export async function patientProofs(): Promise<string[]> { return ((await cookies()).get(PP)?.value ?? "").split(",").filter((v) => PROOF_PATIENT.test(v)).slice(0, 20); }
export async function addPatientProof(proof: string, expiresAt: string): Promise<void> {
  const kept = (await patientProofs()).filter((v) => v.slice(0, 36) !== proof.slice(0, 36));
  const maxAge = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  (await cookies()).set(PP, [...kept, proof].join(","), opts(maxAge));
}

export const csrfOk = (req: Request): boolean => req.headers.get("x-medos-csrf") === "1";
export const forbidden = () => Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
