import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaService } from "../../common/prisma.service";

export const PROOF_MINUTES = 120;
const MAX_PROOFS = 20;
const MAX_HEADER = 4096;

/** `unlocked` is the set of patients this session has proven it may open (see {@link assertUnlocked}); it is built from signed proofs, never from the request body. */
export interface PortalSession { tenantId: string; facilityId: string; mobile: string; sessionId: string; unlocked: ReadonlySet<string> }

const sign = (secret: string, tenantId: string, sessionId: string, patientId: string, exp: number): string =>
  createHmac("sha256", secret).update(`portal-proof|${tenantId}|${sessionId}|${patientId}|${exp}`).digest("base64url");

/** A proof that this session confirmed one patient's date of birth. It is tied to the session, so signing out (or a new sign-in) makes it useless. */
export function makeProof(secret: string, tenantId: string, sessionId: string, patientId: string, now = Date.now()): { proof: string; expiresAt: Date } {
  const exp = now + PROOF_MINUTES * 60_000;
  return { proof: `${patientId}.${exp}.${sign(secret, tenantId, sessionId, patientId, exp)}`, expiresAt: new Date(exp) };
}

/** Reads the proofs the web gateway forwards. Anything malformed, expired, forged or issued to another session is ignored. */
export function readProofs(secret: string, tenantId: string, sessionId: string, header: unknown, now = Date.now()): Set<string> {
  const out = new Set<string>();
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER) return out;
  for (const part of header.split(",").slice(0, MAX_PROOFS)) {
    const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{10,15})\.([A-Za-z0-9_-]{43})$/.exec(part.trim());
    if (!m) continue;
    const patientId = m[1]!.toLowerCase();
    const exp = Number(m[2]);
    if (exp <= now) continue;
    const want = Buffer.from(sign(secret, tenantId, sessionId, patientId, exp)), got = Buffer.from(m[3]!);
    if (want.length === got.length && timingSafeEqual(want, got)) out.add(patientId);
  }
  return out;
}

/**
 * A number can belong to several people (a family sharing a phone), and the code only proves the person holds the phone. So a patient's records open only when
 * this session has confirmed that patient's date of birth, or when the number belongs to exactly one patient. Used by every patient-app route that names a patient.
 */
export async function assertUnlocked(db: PrismaService | Prisma.TransactionClient, p: PortalSession, patientId: string): Promise<void> {
  if (p.unlocked.has(patientId)) return;
  const n = await (db as PrismaService).patient.count({ where: { tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null } });
  if (n === 1) return;
  throw new DomainError("PROFILE_LOCKED", "Confirm this patient's date of birth to see these records", 403);
}
