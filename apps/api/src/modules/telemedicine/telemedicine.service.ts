import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import type { PortalSession } from "../portal/portal.service";
import { SettingsService } from "../settings/settings.service";
import { joinWindow, LIVE_APPOINTMENT, roomUrl } from "./telemedicine.domain";

const uuid = z.string().uuid();
export const createTeleSchema = z.object({ appointmentId: uuid }).strict();
export const cancelTeleSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const patientJoinSchema = z.object({ consent: z.boolean().optional() }).strict();
export const listTeleSchema = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const isLive = (status: string) => (LIVE_APPOINTMENT as readonly string[]).includes(status);

/**
 * Video consultations (docs/telemedicine.md). A booked appointment is made a video consultation; the doctor and the patient each get a link to the same room
 * only when they are allowed to join: the right person, inside the time window, and (for the patient) after agreeing to a video consultation. The consultation,
 * prescription and bill are the appointment's normal visit. MedOS does not carry the video: the hospital's video service does.
 */
@Injectable()
export class TelemedicineService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  private ownDoctor(ctx: RequestContext, practitionerId: string): boolean {
    return ctx.dataScope.kind === "DOCTOR" && ctx.dataScope.practitionerIds.includes(practitionerId);
  }

  private async videoUrl(db: PrismaService | Prisma.TransactionClient, tenantId: string, facilityId: string): Promise<string> {
    const url = (await this.settings.get(db as PrismaService, tenantId, facilityId, "TELECONSULT_VIDEO_URL")) as string;
    if (!url) throw new DomainError("INVALID_STATE", "The hospital has not set up its video service yet (Administration, Settings)", 409);
    return url;
  }

  async create(ctx: RequestContext, input: z.infer<typeof createTeleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.videoUrl(tx, ctx.tenantId, ctx.facilityId);
      const a = await tx.appointment.findFirst({ where: { id: input.appointmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, practitionerId: true, startAt: true, status: true } });
      if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!isLive(a.status)) throw new DomainError("INVALID_STATE", "This appointment is cancelled or finished", 409);
      if (a.startAt.getTime() < Date.now() - 60 * 60_000) throw new DomainError("INVALID_STATE", "This appointment time has passed", 409);
      try {
        const t = await tx.teleconsult.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: a.patientId, appointmentId: a.id, practitionerId: a.practitionerId, scheduledAt: a.startAt, roomToken: randomBytes(24).toString("base64url"), createdById: ctx.userId }, select: { id: true } });
        await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_CREATED", entityType: "Teleconsult", entityId: t.id, metadata: { appointmentId: a.id } });
        return { id: t.id, status: "SCHEDULED" as const };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This appointment is already a video consultation", 409);
        throw e;
      }
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof listTeleSchema>) {
    const where: Prisma.TeleconsultWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}),
      ...(ctx.dataScope.kind === "DOCTOR" ? { practitionerId: { in: [...ctx.dataScope.practitionerIds] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.teleconsult.findMany({
        where, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, appointment: { select: { status: true, practitioner: { select: { displayName: true } } } } },
      }),
      this.prisma.teleconsult.count({ where }),
    ]);
    const now = new Date();
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => {
        const w = joinWindow(r.scheduledAt, now);
        return {
          id: r.id, appointmentId: r.appointmentId, patient: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, doctor: r.appointment.practitioner.displayName, scheduledAt: r.scheduledAt, status: r.status,
          consented: !!r.consentAt, doctorJoined: !!r.doctorJoinedAt, patientJoined: !!r.patientJoinedAt, windowOpensAt: w.opensAt,
          canJoin: ctx.permissions.has("TELE_CONDUCT") && this.ownDoctor(ctx, r.practitionerId) && w.open && isLive(r.appointment.status) && (r.status === "SCHEDULED" || r.status === "IN_PROGRESS"),
        };
      }),
    };
  }

  private async mine(tx: Prisma.TransactionClient, ctx: RequestContext, id: string) {
    const t = await tx.teleconsult.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { appointment: { select: { status: true } } } });
    if (!t || !this.ownDoctor(ctx, t.practitionerId)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return t;
  }

  /** The doctor opens the call. Only the appointment's own doctor, only in the time window; the first time starts the consultation. */
  async join(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.mine(tx, ctx, id);
      if (t.status !== "SCHEDULED" && t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "This video consultation is over", 409);
      if (!isLive(t.appointment.status)) throw new DomainError("INVALID_STATE", "The appointment is cancelled or finished", 409);
      const w = joinWindow(t.scheduledAt, new Date());
      if (!w.open) throw new DomainError("INVALID_STATE", "The call can be opened from 15 minutes before the appointment", 409, { opensAt: w.opensAt.toISOString() });
      const url = await this.videoUrl(tx, ctx.tenantId, ctx.facilityId);
      if (!t.doctorJoinedAt) {
        await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "IN_PROGRESS", doctorJoinedAt: new Date() } });
        await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_DOCTOR_JOINED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId } });
      }
      return { url: roomUrl(url, t.roomToken), patientJoined: !!t.patientJoinedAt };
    });
  }

  async end(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await this.mine(tx, ctx, id);
      if (t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "Only a call in progress can be ended", 409);
      await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "COMPLETED", endedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_ENDED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId } });
      return { id, status: "COMPLETED" as const };
    });
  }

  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelTeleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.teleconsult.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, status: true, appointmentId: true } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (t.status !== "SCHEDULED") throw new DomainError("INVALID_STATE", "Only a video consultation that has not started can be cancelled", 409);
      await tx.teleconsult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", cancelReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "TELECONSULT_CANCELLED", entityType: "Teleconsult", entityId: id, metadata: { appointmentId: t.appointmentId, reason: input.reason } });
      return { id, status: "CANCELLED" as const };
    });
  }

  // ───── the patient's side (patient app) ─────

  /** The patient joins from the app. Needs their own session, the right appointment, the time window, and agreement to a video consultation the first time. */
  async patientJoin(p: PortalSession, id: string, input: z.infer<typeof patientJoinSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.teleconsult.findFirst({ where: { id, tenantId: p.tenantId, facilityId: p.facilityId, patient: { mobile: p.mobile, status: "ACTIVE", mergedIntoId: null } }, include: { appointment: { select: { status: true } } } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (t.status !== "SCHEDULED" && t.status !== "IN_PROGRESS") throw new DomainError("INVALID_STATE", "This video consultation is over", 409);
      if (!isLive(t.appointment.status)) throw new DomainError("INVALID_STATE", "The appointment is cancelled or finished", 409);
      const w = joinWindow(t.scheduledAt, new Date());
      if (!w.open) throw new DomainError("INVALID_STATE", "You can join from 15 minutes before the appointment", 409, { opensAt: w.opensAt.toISOString() });
      if (!t.consentAt && input.consent !== true) throw new DomainError("VALIDATION_FAILED", "Please agree to a video consultation to continue", 409);
      const url = await this.videoUrl(tx, p.tenantId, p.facilityId);
      if (!t.consentAt || !t.patientJoinedAt) {
        const now = new Date();
        await tx.teleconsult.update({ where: { tenantId_id: { tenantId: p.tenantId, id } }, data: { consentAt: t.consentAt ?? now, patientJoinedAt: t.patientJoinedAt ?? now } });
        await this.audit.record(tx, { tenantId: p.tenantId, facilityId: p.facilityId }, { action: "TELECONSULT_PATIENT_JOINED", entityType: "Teleconsult", entityId: id, metadata: { actor: "PATIENT", patientId: t.patientId, consentGiven: !t.consentAt } });
      }
      return { url: roomUrl(url, t.roomToken) };
    });
  }
}
