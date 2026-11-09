import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

export const mergePatientSchema = z.object({
  /** The real patient: the one that stays active and keeps being used. */
  intoPatientId: z.string().uuid(),
  /** The version of the duplicate the person was looking at, so a record changed meanwhile is not merged blind. */
  version: z.number().int().min(1),
  reason: z.string().trim().min(5, "Say why these are the same person").max(240),
}).strict();

/**
 * Links a duplicate patient to the real one (docs/patient-merge.md). Nothing is moved, copied or deleted; the duplicate becomes inactive,
 * keeps its MRN and all its records, and the real patient's chart reads both. There is no undo.
 */
@Injectable()
export class MergeService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async merge(ctx: RequestContext, sourceId: string, input: z.infer<typeof mergePatientSchema>) {
    if (sourceId === input.intoPatientId) throw new DomainError("VALIDATION_FAILED", "A patient cannot be merged into themselves", 400);
    return this.prisma.$transaction(async (tx) => {
      // Both rows locked in one order: two merges that touch the same patient wait for each other and never deadlock.
      const ids = [sourceId, input.intoPatientId].sort();
      await tx.$queryRaw`SELECT id FROM "Patient" WHERE "tenantId" = ${ctx.tenantId}::uuid AND id IN (${ids[0]}::uuid, ${ids[1]}::uuid) ORDER BY id FOR UPDATE`;
      const rows = await tx.patient.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, include: { identifiers: { where: { type: "MRN" }, select: { value: true } } } });
      const source = rows.find((r) => r.id === sourceId);
      const target = rows.find((r) => r.id === input.intoPatientId);
      if (!source || !target) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (source.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record has already been merged", 409);
      if (target.mergedIntoId) throw new DomainError("PATIENT_MERGED", "The patient you are merging into has itself been merged. Use the real patient.", 409);
      if (source.status !== "ACTIVE" || target.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "Both patients must be active", 409);
      if (source.version !== input.version) throw new DomainError("STALE_VERSION", "This patient record was changed by someone else. Reload and try again.", 409, { currentVersion: source.version });

      // Work in progress stays with the record it started on: the duplicate must be finished first.
      const [admitted, visits, appointments, queued] = await Promise.all([
        tx.admission.count({ where: { tenantId: ctx.tenantId, patientId: sourceId, status: "ADMITTED" } }),
        tx.encounter.count({ where: { tenantId: ctx.tenantId, patientId: sourceId, status: "ACTIVE" } }),
        tx.appointment.count({ where: { tenantId: ctx.tenantId, patientId: sourceId, status: { in: ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"] } } }),
        tx.queueEntry.count({ where: { tenantId: ctx.tenantId, patientId: sourceId, status: { in: ["WAITING", "CALLED", "IN_CONSULTATION"] } } }),
      ]);
      const open = { admitted, openVisits: visits, upcomingAppointments: appointments, inQueue: queued };
      if (admitted + visits + appointments + queued > 0) {
        throw new DomainError("PATIENT_MERGE_BLOCKED", "The duplicate still has an admission, an open visit, an upcoming appointment or a queue entry. Finish or cancel those first.", 409, open);
      }

      // Patients already linked to the duplicate are re-pointed at the real patient, so a link is never more than one step.
      const repointed = (await tx.patient.updateMany({ where: { tenantId: ctx.tenantId, mergedIntoId: sourceId }, data: { mergedIntoId: target.id } })).count;
      await tx.patient.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: sourceId } },
        data: { status: "INACTIVE", mergedIntoId: target.id, mergedAt: new Date(), mergedById: ctx.userId, mergeReason: input.reason, version: { increment: 1 } },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "PATIENT_MERGED", entityType: "Patient", entityId: sourceId,
        metadata: { intoPatientId: target.id, duplicateMrn: source.identifiers[0]?.value ?? null, intoMrn: target.identifiers[0]?.value ?? null, reason: input.reason, repointed },
      });
      return { duplicateId: sourceId, intoPatientId: target.id, intoMrn: target.identifiers[0]?.value ?? null };
    });
  }
}
