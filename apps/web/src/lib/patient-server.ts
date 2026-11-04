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
export async function clearPatientSession(): Promise<void> { (await cookies()).delete(PT); }
export async function patientToken(): Promise<string | null> { return (await cookies()).get(PT)?.value ?? null; }

export const csrfOk = (req: Request): boolean => req.headers.get("x-medos-csrf") === "1";
export const forbidden = () => Response.json({ error: { code: "FORBIDDEN", message: "Missing request header" } }, { status: 403 });
