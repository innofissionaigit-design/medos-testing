import type { NextRequest } from "next/server";
import { clearPatientSession, csrfOk, forbidden, patientProofs, patientToken, PORTAL } from "@/lib/patient-server";

/** Same-origin gateway for the patient app: attaches the patient's session token from the cookie. Sign-in routes are not reachable through it. */
const SEGMENT = /^[A-Za-z0-9_.~-]{1,100}$/;
const ALLOWED = new Set(["me", "doctors", "appointments", "visits", "reports", "bills", "appointment-requests", "teleconsults"]);

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (path.length === 0 || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..") || !ALLOWED.has(path[0]!)) return Response.json({ error: { code: "NOT_FOUND", message: "Resource not found" } }, { status: 404 });
  const safe = req.method === "GET";
  if (!safe && !csrfOk(req)) return forbidden();
  const token = await patientToken();
  if (!token) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in" } }, { status: 401 });
  const proofs = (await patientProofs()).join(",");
  const res = await fetch(`${PORTAL}/${path.join("/")}${req.nextUrl.search}`, { method: req.method, headers: { authorization: `Bearer ${token}`, ...(proofs ? { "x-patient-proofs": proofs } : {}), ...(safe ? {} : { "content-type": "application/json" }) }, body: safe ? null : await req.arrayBuffer(), cache: "no-store" }).catch(() => null);
  if (!res) return Response.json({ error: { code: "UNAVAILABLE", message: "Please try again in a moment" } }, { status: 502 });
  if (res.status === 401) await clearPatientSession();
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}

export { handle as GET, handle as POST };
