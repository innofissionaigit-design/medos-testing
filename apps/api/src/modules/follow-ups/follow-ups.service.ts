import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { AppointmentsService, toAppointmentView, VIEW } from "../appointments/appointments.service";

export const scheduleFollowUpSchema = z.object({
  startAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  /** Defaults to the doctor who saw the patient; another doctor at the facility may be chosen (e.g. a specialist). */
  practitionerId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

/**
 * Follow-ups are ordinary FOLLOW_UP appointments linked to the consultation that ordered them, so booking, conflict
 * detection, schedules, rescheduling, cancellation, statuses and reminders all go through AppointmentsService.
 */
@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService, private readonly appointments: AppointmentsService) {}

  /** Only the doctor who saw the patient in this consultation may order its follow-up; the patient comes from the consultation. */
  async schedule(ctx: RequestContext, encounterId: string, input: z.infer<typeof scheduleFollowUpSchema>) {
    const enc = await this.prisma.encounter.findFirst({
      where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      select: { id: true, patientId: true, practitionerId: true, type: true, status: true, practitioner: { select: { userId: true } } },
    });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (enc.type !== "OPD") throw new DomainError("VALIDATION_FAILED", "Follow-ups are scheduled from OPD consultations", 400);
    if (enc.status === "CANCELLED") throw new DomainError("APPOINTMENT_INVALID_STATE", "This visit was cancelled", 409);
    if (!enc.practitionerId || !enc.practitioner || enc.practitioner.userId !== ctx.userId) {
      throw new DomainError("FORBIDDEN", "Only the doctor who saw the patient in this consultation can schedule its follow-up", 403);
    }
    return this.appointments.create(ctx, {
      patientId: enc.patientId, practitionerId: input.practitionerId ?? enc.practitionerId, startAt: input.startAt,
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}), type: "FOLLOW_UP", ...(input.notes ? { notes: input.notes } : {}),
    }, { followUpOfEncounterId: enc.id });
  }

  async listForEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.appointment.findMany({ where: { tenantId: ctx.tenantId, followUpOfEncounterId: enc.id }, select: VIEW, orderBy: [{ startAt: "asc" }, { id: "asc" }] });
    return rows.map(toAppointmentView);
  }
}
