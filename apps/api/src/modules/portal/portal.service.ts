import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../../common/prisma.service";
import type { AuthedRequest, RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { feePaid, feeState } from "../appointments/booking-fee";
import { balanceDue, fmt } from "../billing/billing.domain";
import { SettingsService } from "../settings/settings.service";
import { joinWindow, LIVE_APPOINTMENT } from "../telemedicine/telemedicine.domain";
import { indianMobile, MESSAGE_PROVIDER, type MessageProvider } from "../prescriptions/message.provider";
import { assertUnlocked, makeProof, type PortalSession, readProofs } from "./portal.access";

export const OTP_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MINUTES = 15;
export const SESSION_HOURS = 12;
const TOKEN_PREFIX = "mdp_";
const MAX_PENDING_REQUESTS = 3;

export const UNLOCK_MAX_FAILURES = 5;
export const UNLOCK_FAILURE_WINDOW_MINUTES = 60;
export type { PortalSession };
export interface PortalRequest extends AuthedRequest { portal?: PortalSession }

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");

export const otpRequestSchema = z.object({ hospitalCode: z.string().trim().toLowerCase().min(2).max(32), mobile: z.string().trim().min(10).max(15) }).strict();
export const otpVerifySchema = otpRequestSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict();
export const requestSchema = z.object({
  patientId: uuid, practitionerId: uuid.optional(), preferredDate: day, timeOfDay: z.enum(["MORNING", "AFTERNOON", "EVENING", "ANY"]).default("ANY"), reason: z.string().trim().min(3).max(300),
}).strict();
export const patientQuerySchema = z.object({ patientId: uuid }).strict();
export const unlockSchema = z.object({ patientId: uuid, dateOfBirth: day }).strict();
export const handleRequestSchema = z.object({ decision: z.enum(["BOOKED", "DECLINED"]), note: z.string().trim().max(300).optional(), appointmentId: uuid.optional() }).strict();
export const listRequestsSchema = z.object({ status: z.enum(["PENDING", "BOOKED", "DECLINED", "CANCELLED"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const ageOf = (p: { dateOfBirth: Date | null; estimatedAgeYears: number | null }) => {
  if (p.dateOfBirth) { const now = new Date(); let a = now.getUTCFullYear() - p.dateOfBirth.getUTCFullYear(); const m = now.getUTCMonth() - p.dateOfBirth.getUTCMonth(); if (m < 0 || (m === 0 && now.getUTCDate() < p.dateOfBirth.getUTCDate())) a -= 1; return a; }
  return p.estimatedAgeYears;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The patient app's guard: a patient's own session token (never a staff token), checked against the database on every request. */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, @Inject(CONFIG) private readonly config: AppConfig) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<PortalRequest>();
    const header = req.headers["authorization"];
    const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const m = /^mdp_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32,64}$/.exec(raw);
    const fail = () => new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    if (!m) throw fail();
    const tenantId = m[1]!.toLowerCase();
    tenantScope.bind(tenantId);
    const now = new Date();
    const s = await this.prisma.patientSession.findFirst({ where: { tenantId, tokenHash: sha256(raw), revokedAt: null, expiresAt: { gt: now } }, select: { id: true, mobile: true, lastUsedAt: true } });
    if (!s) throw fail();
    const facility = await this.prisma.facility.findFirst({ where: { tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!facility) throw fail();
    if (!(await this.settings.get(this.prisma, tenantId, facility.id, "PATIENT_PORTAL_ENABLED"))) throw fail();
    if (!s.lastUsedAt || now.getTime() - s.lastUsedAt.getTime() > 60_000) await this.prisma.patientSession.updateMany({ where: { id: s.id, tenantId }, data: { lastUsedAt: now } });
    req.portal = { tenantId, facilityId: facility.id, mobile: s.mobile, sessionId: s.id, unlocked: readProofs(this.config.JWT_ACCESS_SECRET, tenantId, s.id, req.headers["x-patient-proofs"], now.getTime()) };
    return true;
  }
}

/**
 * Signing in to the patient app (docs/patient-app.md): a six-digit code goes to the mobile number the hospital has on record; typing it opens a session for that number.
 * The answer to "send me a code" is always the same, so nobody can use it to find out who is a patient. Codes expire in minutes, allow a few wrong tries, and are
 * stored only as keyed hashes. Nothing is ever logged: not the code, not the full number.
 */
@Injectable()
export class PortalAuthService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
  ) {}

  private async tenantOf(code: string): Promise<{ id: string } | null> {
    const rows = await tenantScope.system("patient app: resolve hospital code", () => this.prisma.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status FROM medos_resolve_tenant(${code})`);
    const t = rows[0];
    return t && t.status === "ACTIVE" ? { id: t.id } : null;
  }

  private hash(tenantId: string, mobile: string, code: string): string {
    return createHmac("sha256", this.config.JWT_ACCESS_SECRET).update(`portal-otp|${tenantId}|${mobile}|${code}`).digest("hex");
  }

  /** Always answers the same. Sends a code only when the hospital has the patient app on, the number belongs to a patient, and the number has not asked too often. */
  async requestCode(input: z.infer<typeof otpRequestSchema>): Promise<{ sent: true }> {
    const answer = { sent: true as const };
    const mobile = indianMobile(input.mobile);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!mobile || !tenant) return answer;
    return tenantScope.run(tenant.id, async () => {
      const facility = await this.prisma.facility.findFirst({ where: { tenantId: tenant.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true, tenant: { select: { name: true } } } });
      if (!facility || !(await this.settings.get(this.prisma, tenant.id, facility.id, "PATIENT_PORTAL_ENABLED"))) return answer;
      if (await this.prisma.patient.count({ where: { tenantId: tenant.id, mobile, status: "ACTIVE", mergedIntoId: null } }) === 0) return answer;
      const since = new Date(Date.now() - OTP_SEND_WINDOW_MINUTES * 60_000);
      if (await this.prisma.patientOtp.count({ where: { tenantId: tenant.id, mobile, createdAt: { gt: since } } }) >= OTP_MAX_SENDS) { logJson("warn", "patient_otp_throttled", { tenantId: tenant.id }); return answer; }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const row = await this.prisma.patientOtp.create({ data: { tenantId: tenant.id, mobile, codeHash: this.hash(tenant.id, mobile, code), expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000) }, select: { id: true } });
      try {
        await this.provider.send({ channel: "SMS", to: mobile, text: `${code} is your ${facility.tenant.name} patient app code. It works for ${OTP_MINUTES} minutes. Do not share it with anyone.`, reference: row.id });
      } catch (e) {
        logJson("warn", "patient_otp_send_failed", { tenantId: tenant.id, reason: e instanceof Error ? e.constructor.name : "unknown" });
      }
      return answer;
    });
  }

  /** Checks the code and opens a session. Every failure gives the same answer. */
  async verifyCode(input: z.infer<typeof otpVerifySchema>) {
    const fail = () => new DomainError("UNAUTHENTICATED", "The code is not correct or has expired. Ask for a new one", 401);
    const mobile = indianMobile(input.mobile);
    const tenant = await this.tenantOf(input.hospitalCode);
    if (!mobile || !tenant) throw fail();
    return tenantScope.run(tenant.id, async () => {
      const now = new Date();
      const otp = await this.prisma.patientOtp.findFirst({ where: { tenantId: tenant.id, mobile, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw fail();
      // Count the try first, so two parallel guesses cannot both get the full allowance.
      const counted = await this.prisma.patientOtp.updateMany({ where: { id: otp.id, tenantId: tenant.id, attempts: otp.attempts, consumedAt: null }, data: { attempts: otp.attempts + 1 } });
      if (counted.count !== 1) throw fail();
      const a = Buffer.from(this.hash(tenant.id, mobile, input.code)), b = Buffer.from(otp.codeHash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail();
      const used = await this.prisma.patientOtp.updateMany({ where: { id: otp.id, tenantId: tenant.id, consumedAt: null }, data: { consumedAt: now } });
      if (used.count !== 1) throw fail();
      const token = `${TOKEN_PREFIX}${tenant.id}.${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
      const s = await this.prisma.patientSession.create({ data: { tenantId: tenant.id, mobile, tokenHash: sha256(token), expiresAt }, select: { id: true } });
      await this.audit.recordStandalone({ tenantId: tenant.id }, { action: "PATIENT_APP_SIGNED_IN", entityType: "PatientSession", entityId: s.id, metadata: { actor: "PATIENT", mobileEnding: mobile.slice(-4) } });
      return { token, expiresAt };
    });
  }

  /**
   * Opens one patient's records for this session after the date of birth is confirmed. The code proves the phone, not the person: on a shared number each
   * patient is confirmed separately. A patient with no date of birth on file cannot be opened this way (the hospital must add it). Wrong tries are counted per
   * patient, across sessions, so a new sign-in does not reset them; every try is audited.
   */
  async unlock(p: PortalSession, input: z.infer<typeof unlockSchema>) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true, dateOfBirth: true } });
      if (!patient) return { kind: "NOT_FOUND" as const };
      if (!patient.dateOfBirth) return { kind: "NO_DOB" as const };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-unlock:${p.tenantId}:${patient.id}`}, 0))`;
      const since = new Date(Date.now() - UNLOCK_FAILURE_WINDOW_MINUTES * 60_000);
      const failures = await tx.auditEvent.count({ where: { tenantId: p.tenantId, action: "PATIENT_APP_UNLOCK_FAILED", entityType: "Patient", entityId: patient.id, createdAt: { gt: since } } });
      if (failures >= UNLOCK_MAX_FAILURES) return { kind: "LOCKED_OUT" as const };
      const ok = iso(patient.dateOfBirth) === input.dateOfBirth;
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: ok ? "PATIENT_APP_PROFILE_UNLOCKED" : "PATIENT_APP_UNLOCK_FAILED", entityType: "Patient", entityId: patient.id, metadata: { actor: "PATIENT", sessionId: p.sessionId } });
      return { kind: ok ? ("OK" as const) : ("WRONG" as const) };
    });
    // The failed try is saved above; the error is raised only after the transaction has committed.
    if (outcome.kind === "NOT_FOUND") throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (outcome.kind === "NO_DOB") throw new DomainError("PROFILE_NOT_VERIFIABLE", "The hospital has no date of birth on file for this patient. Please ask the front desk to add it", 409);
    if (outcome.kind === "LOCKED_OUT") throw new DomainError("RATE_LIMITED", "Too many wrong tries. Please try again later or ask the front desk", 429);
    if (outcome.kind === "WRONG") throw new DomainError("PROFILE_VERIFICATION_FAILED", "That date of birth does not match our records", 403);
    return { patientId: input.patientId, ...makeProof(this.config.JWT_ACCESS_SECRET, p.tenantId, p.sessionId, input.patientId) };
  }

  async logout(p: PortalSession): Promise<{ signedOut: true }> {
    await this.prisma.patientSession.updateMany({ where: { id: p.sessionId, tenantId: p.tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.recordStandalone({ tenantId: p.tenantId }, { action: "PATIENT_APP_SIGNED_OUT", entityType: "PatientSession", entityId: p.sessionId, metadata: { actor: "PATIENT" } });
    return { signedOut: true };
  }
}

/**
 * What a signed-in patient may see (docs/patient-app.md): only the records of patients registered with their mobile number, and, when several people share the
 * number, only those whose date of birth this session has confirmed (portal.access.ts). Only signed or verified clinical content, never drafts, and a critical report only after the doctor has seen it. Every query names the hospital and the patient.
 */
@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly settings: SettingsService) {}

  private async patient(p: PortalSession, patientId: string) {
    const x = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true } });
    if (!x) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await assertUnlocked(this.prisma, p, patientId);
    return x;
  }

  /**
   * The people on this number. A person who has not been confirmed in this session shows only a first name (so a family can pick who they are), with no
   * record number, age or gender, and the app asks for the date of birth before it shows anything else.
   */
  async profiles(p: PortalSession) {
    const rows = await this.prisma.patient.findMany({ where: { tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } });
    const hospital = await this.prisma.tenant.findFirst({ where: { id: p.tenantId }, select: { name: true } });
    return {
      hospital: hospital?.name ?? null,
      patients: rows.map((r) => {
        const open = rows.length === 1 || p.unlocked.has(r.id);
        return open
          ? { id: r.id, name: nameOf(r), mrn: r.identifiers[0]?.value ?? null, gender: r.gender, age: ageOf(r), locked: false, canUnlock: true }
          : { id: r.id, name: r.firstName, mrn: null, gender: null, age: null, locked: true, canUnlock: r.dateOfBirth !== null };
      }),
    };
  }

  async doctors(p: PortalSession) {
    const rows = await this.prisma.practitioner.findMany({ where: { tenantId: p.tenantId, facilityId: p.facilityId, status: "ACTIVE" }, orderBy: { displayName: "asc" }, take: 100, select: { id: true, displayName: true, specialty: true, department: { select: { name: true } } } });
    return rows.map((d) => ({ id: d.id, name: d.displayName, specialty: d.specialty, department: d.department?.name ?? null }));
  }

  async appointments(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const now = new Date();
    const select = { id: true, startAt: true, endAt: true, status: true, type: true, bookingFee: true, feeSkippedAt: true, advanceDeposits: { select: { amount: true, refunds: { select: { amount: true } } } }, practitioner: { select: { displayName: true, specialty: true } } } as const;
    const [upcoming, past] = await Promise.all([
      this.prisma.appointment.findMany({ where: { tenantId: p.tenantId, patientId, startAt: { gte: now }, status: { in: ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"] } }, orderBy: { startAt: "asc" }, take: 20, select }),
      this.prisma.appointment.findMany({ where: { tenantId: p.tenantId, patientId, OR: [{ startAt: { lt: now } }, { status: { in: ["COMPLETED", "CANCELLED", "NO_SHOW"] } }] }, orderBy: { startAt: "desc" }, take: 20, select }),
    ]);
    const teles = new Map((await this.prisma.teleconsult.findMany({ where: { tenantId: p.tenantId, patientId, status: { not: "CANCELLED" }, appointmentId: { in: [...upcoming, ...past].map((a) => a.id) } }, select: { id: true, appointmentId: true, status: true, scheduledAt: true, consentAt: true, patientWaitingAt: true, doctorJoinedAt: true } })).map((t) => [t.appointmentId, t]));
    const payFirst = await this.settings.get(this.prisma, p.tenantId, p.facilityId, "TELECONSULT_PAY_BEFORE_JOIN");
    const video = (a: (typeof upcoming)[number]) => {
      const t = teles.get(a.id);
      if (!t) return null;
      const w = joinWindow(t.scheduledAt, now);
      const fee = feeState(a, feePaid(a.advanceDeposits));
      return { id: t.id, status: t.status, consented: !!t.consentAt, waiting: !!t.patientWaitingAt, doctorStarted: !!t.doctorJoinedAt, feeDue: payFirst && fee.status === "PENDING" ? fee.due : null, opensAt: w.opensAt, canJoin: w.open && (t.status === "SCHEDULED" || t.status === "IN_PROGRESS") && (LIVE_APPOINTMENT as readonly string[]).includes(a.status) };
    };
    const view = (a: (typeof upcoming)[number]) => ({ id: a.id, startAt: a.startAt, endAt: a.endAt, status: a.status, type: a.type, doctor: a.practitioner.displayName, specialty: a.practitioner.specialty, video: video(a) });
    return { upcoming: upcoming.map(view), past: past.map(view) };
  }

  /** Visits with the doctor's signed note (diagnosis and advice) and the signed prescription. Drafts are never shown. */
  async visits(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.encounter.findMany({
      where: { tenantId: p.tenantId, patientId, type: "OPD", status: { not: "CANCELLED" } }, orderBy: { startedAt: "desc" }, take: 20,
      select: {
        id: true, encounterNumber: true, startedAt: true, practitioner: { select: { displayName: true, specialty: true } },
        diagnoses: { where: { status: "ACTIVE", supersededAtVersion: null }, orderBy: { recordedAt: "asc" }, select: { text: true, type: true } },
        documents: { where: { kind: "CONSULTATION", status: { in: ["SIGNED", "AMENDED"] } }, select: { signedAt: true, versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } } } },
        medicationOrders: { where: { status: "SIGNED" }, orderBy: { signedAt: "asc" }, take: 20, select: { orderNumber: true, signedAt: true, items: { where: { status: "ACTIVE" }, orderBy: { lineNo: "asc" }, select: { genericName: true, brandName: true, strength: true, dosage: true, frequency: true, frequencyText: true, durationDays: true, foodRelation: true, instructions: true } } } },
      },
    });
    return rows.filter((e) => e.documents.length > 0).map((e) => {
      const content = (e.documents[0]?.versions[0]?.content ?? {}) as Record<string, unknown>;
      const advice = typeof content["advice"] === "string" ? (content["advice"] as string) : null;
      const rx = e.medicationOrders[0];
      return {
        id: e.id, visitNumber: e.encounterNumber, date: e.startedAt, doctor: e.practitioner?.displayName ?? null, specialty: e.practitioner?.specialty ?? null,
        diagnoses: e.diagnoses.map((d) => d.text), advice,
        prescription: rx ? { number: rx.orderNumber, signedAt: rx.signedAt, medicines: e.medicationOrders.flatMap((o) => o.items).map((i) => ({ name: [i.brandName ?? i.genericName, i.strength].filter(Boolean).join(" "), dose: i.dosage, frequency: i.frequencyText ?? i.frequency, days: i.durationDays, food: i.foodRelation, note: i.instructions })) } : null,
      };
    });
  }

  /** Verified lab reports and signed radiology reports. A report with a critical value is held back until the doctor has acknowledged it. */
  async reports(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const released = { OR: [{ hasCritical: false }, { criticalAckAt: { not: null } }] };
    const [labs, rads, heldLab, heldRad] = await Promise.all([
      this.prisma.labResult.findMany({ where: { tenantId: p.tenantId, patientId, status: "VERIFIED", ...released }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, name: true, specimen: true, versions: { orderBy: { version: "desc" }, take: 1, select: { values: true, comment: true, verifiedAt: true } } } }),
      this.prisma.radStudy.findMany({ where: { tenantId: p.tenantId, patientId, status: "REPORTED", ...released }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, modality: true, bodyPart: true, testOrder: { select: { name: true } }, reports: { orderBy: { version: "desc" }, take: 1, select: { findings: true, impression: true, signedAt: true } } } }),
      this.prisma.labResult.count({ where: { tenantId: p.tenantId, patientId, status: "VERIFIED", hasCritical: true, criticalAckAt: null } }),
      this.prisma.radStudy.count({ where: { tenantId: p.tenantId, patientId, status: "REPORTED", hasCritical: true, criticalAckAt: null } }),
    ]);
    return {
      withheld: heldLab + heldRad,
      lab: labs.filter((l) => l.versions[0]).map((l) => ({ id: l.id, test: l.name, specimen: l.specimen, reportedAt: l.versions[0]!.verifiedAt, comment: l.versions[0]!.comment, values: ((l.versions[0]!.values ?? []) as unknown as { name: string; unit: string | null; value: string; flag: string; rangeText: string }[]).map((v) => ({ name: v.name, unit: v.unit, value: v.value, flag: v.flag, range: v.rangeText })) })),
      radiology: rads.filter((r) => r.reports[0]).map((r) => ({ id: r.id, test: r.testOrder.name, bodyPart: r.bodyPart, reportedAt: r.reports[0]!.signedAt, findings: r.reports[0]!.findings, impression: r.reports[0]!.impression })),
    };
  }

  /** Issued invoices with what was paid and what is still due, and the receipts. Drafts and cancelled invoices are not shown. */
  async bills(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.invoice.findMany({
      where: { tenantId: p.tenantId, patientId, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID", "REFUNDED"] } }, orderBy: { issuedAt: "desc" }, take: 30,
      select: { id: true, invoiceNumber: true, kind: true, status: true, issuedAt: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, receipts: { orderBy: { receivedAt: "asc" }, select: { receiptNumber: true, total: true, receivedAt: true } } },
    });
    return rows.map((i) => ({ id: i.id, number: i.invoiceNumber, kind: i.kind, status: i.status, issuedAt: i.issuedAt, total: fmt(i.total), paid: fmt(i.paidTotal), due: fmt(balanceDue(i)), receipts: i.receipts.map((r) => ({ number: r.receiptNumber, amount: fmt(r.total), at: r.receivedAt })) }));
  }

  // ───── appointment requests ─────

  async requests(p: PortalSession, patientId: string) {
    await this.patient(p, patientId);
    const rows = await this.prisma.appointmentRequest.findMany({ where: { tenantId: p.tenantId, patientId }, orderBy: { createdAt: "desc" }, take: 20 });
    const docs = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: p.tenantId, id: { in: rows.flatMap((r) => (r.practitionerId ? [r.practitionerId] : [])) } }, select: { id: true, displayName: true } })).map((d) => [d.id, d.displayName]));
    return rows.map((r) => ({ id: r.id, preferredDate: iso(r.preferredDate), timeOfDay: r.timeOfDay, reason: r.reason, status: r.status, doctor: r.practitionerId ? docs.get(r.practitionerId) ?? null : null, answer: r.status === "DECLINED" || r.status === "BOOKED" ? r.handleNote : null, createdAt: r.createdAt }));
  }

  async createRequest(p: PortalSession, input: z.infer<typeof requestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const pat = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: p.tenantId, mobile: p.mobile, status: "ACTIVE", mergedIntoId: null }, select: { id: true } });
      if (!pat) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await assertUnlocked(tx, p, input.patientId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-req:${p.tenantId}:${input.patientId}`}, 0))`;
      const today = new Date(iso(new Date()));
      const date = new Date(input.preferredDate);
      if (date < today || date.getTime() > today.getTime() + 60 * 86_400_000) throw new DomainError("VALIDATION_FAILED", "Choose a date within the next 60 days", 400, [{ path: "preferredDate", message: "Out of range" }]);
      if (input.practitionerId) {
        const d = await tx.practitioner.findFirst({ where: { id: input.practitionerId, tenantId: p.tenantId, facilityId: p.facilityId, status: "ACTIVE" }, select: { id: true } });
        if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      if (await tx.appointmentRequest.count({ where: { tenantId: p.tenantId, patientId: input.patientId, status: "PENDING" } }) >= MAX_PENDING_REQUESTS) throw new DomainError("CONFLICT", "You already have requests waiting. Please wait for the hospital to answer them", 409);
      const r = await tx.appointmentRequest.create({ data: { tenantId: p.tenantId, facilityId: p.facilityId, patientId: input.patientId, practitionerId: input.practitionerId ?? null, preferredDate: date, timeOfDay: input.timeOfDay, reason: input.reason }, select: { id: true } });
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "APPOINTMENT_REQUESTED", entityType: "AppointmentRequest", entityId: r.id, metadata: { actor: "PATIENT", patientId: input.patientId } });
      await this.notifications.notifyPermission(tx, ["APPOINTMENT_CREATE"], { tenantId: p.tenantId, facilityId: p.facilityId, type: "BOOKING_FROM_OUTSIDE", entityType: "AppointmentRequest", entityId: r.id, dedupeKey: `BOOKING_FROM_OUTSIDE:${r.id}` });
      return { id: r.id, status: "PENDING" as const };
    });
  }

  async cancelRequest(p: PortalSession, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.appointmentRequest.findFirst({ where: { id, tenantId: p.tenantId, patient: { mobile: p.mobile, mergedIntoId: null } }, select: { id: true, patientId: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await assertUnlocked(tx, p, r.patientId);
      const res = await tx.appointmentRequest.updateMany({ where: { id, tenantId: p.tenantId, status: "PENDING" }, data: { status: "CANCELLED", handledAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This request has already been answered", 409);
      await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "APPOINTMENT_REQUEST_CANCELLED", entityType: "AppointmentRequest", entityId: id, metadata: { actor: "PATIENT", patientId: r.patientId } });
      return { id, status: "CANCELLED" as const };
    });
  }

  // ───── the front desk's side ─────

  async listForStaff(ctx: RequestContext, q: z.infer<typeof listRequestsSchema>) {
    const where: Prisma.AppointmentRequestWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.appointmentRequest.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { patient: { select: { id: true, firstName: true, lastName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } } }),
      this.prisma.appointmentRequest.count({ where }),
    ]);
    const docs = new Map((await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, id: { in: rows.flatMap((r) => (r.practitionerId ? [r.practitionerId] : [])) } }, select: { id: true, displayName: true } })).map((d) => [d.id, d.displayName]));
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => ({ id: r.id, patientId: r.patientId, patient: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, mobile: r.patient.mobile, doctor: r.practitionerId ? docs.get(r.practitionerId) ?? null : null, practitionerId: r.practitionerId, preferredDate: iso(r.preferredDate), timeOfDay: r.timeOfDay, reason: r.reason, status: r.status, handleNote: r.handleNote, appointmentId: r.appointmentId, createdAt: r.createdAt })) };
  }

  /** The front desk answers: booked (optionally naming the appointment they made) or declined with a note the patient can read. */
  async handle(ctx: RequestContext, id: string, input: z.infer<typeof handleRequestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.appointmentRequest.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.decision === "DECLINED" && (input.note?.length ?? 0) < 3) throw new DomainError("VALIDATION_FAILED", "Tell the patient why", 400, [{ path: "note", message: "Required" }]);
      if (input.appointmentId) {
        const a = await tx.appointment.findFirst({ where: { id: input.appointmentId, tenantId: ctx.tenantId, patientId: r.patientId }, select: { id: true } });
        if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const res = await tx.appointmentRequest.updateMany({ where: { id, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: input.decision, handledById: ctx.userId, handledAt: new Date(), handleNote: input.note ?? null, appointmentId: input.appointmentId ?? null } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This request has already been answered or cancelled", 409);
      await this.audit.record(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, requestId: ctx.requestId }, { action: "APPOINTMENT_REQUEST_ANSWERED", entityType: "AppointmentRequest", entityId: id, metadata: { decision: input.decision } });
      return { id, status: input.decision };
    });
  }
}
