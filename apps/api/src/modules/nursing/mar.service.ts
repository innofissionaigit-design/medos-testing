import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { localDateStr, zonedToUtc } from "../../common/time";

/** Default administration times (minutes after local midnight) for scheduled frequencies. SOS/OTHER are given as needed. */
export const FREQUENCY_TIMES: Record<string, number[]> = {
  OD: [9 * 60],
  BD: [9 * 60, 21 * 60],
  TDS: [8 * 60, 14 * 60, 20 * 60],
  QID: [6 * 60, 12 * 60, 18 * 60, 24 * 60],
  HS: [21 * 60],
};

export const generateSchema = z.object({ hours: z.number().int().min(1).max(72).default(24) }).strict();
export const administerSchema = z.object({
  status: z.enum(["GIVEN", "MISSED", "HELD", "REFUSED"]),
  remarks: z.string().trim().min(3).max(300).optional(),
  administeredAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
}).strict();
export const unscheduledSchema = z.object({
  medicationOrderItemId: z.string().uuid(),
  remarks: z.string().trim().min(3).max(300).optional(),
  administeredAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
}).strict();
export const marListSchema = z.object({
  from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
}).strict();
export const dueQuerySchema = z.object({
  withinMinutes: z.coerce.number().int().min(0).max(720).default(60),
  wardId: z.string().uuid().optional(),
}).strict();

const OVERDUE_AFTER_MIN = 30;

const VIEW = {
  id: true, scheduledAt: true, status: true, unscheduled: true, administeredAt: true, administeredById: true, remarks: true, admissionId: true, medicationOrderItemId: true,
  item: { select: { genericName: true, brandName: true, strength: true, dosage: true, route: true, frequency: true, frequencyText: true, foodRelation: true, instructions: true, status: true, order: { select: { orderNumber: true } } } },
} satisfies Prisma.MedicationAdministrationSelect;
type Row = Prisma.MedicationAdministrationGetPayload<{ select: typeof VIEW }>;

export function toMarView(r: Row, now = Date.now(), names?: Map<string, string>) {
  const { item, ...rest } = r;
  return {
    ...rest,
    drug: item.brandName ? `${item.brandName} (${item.genericName})` : item.genericName, strength: item.strength, dosage: item.dosage, route: item.route,
    frequency: item.frequency, frequencyText: item.frequencyText, instructions: item.instructions, orderNumber: item.order.orderNumber, orderItemStatus: item.status,
    overdue: r.status === "DUE" && r.scheduledAt.getTime() < now - OVERDUE_AFTER_MIN * 60_000,
    administeredByName: r.administeredById ? names?.get(r.administeredById) ?? null : null,
  };
}

@Injectable()
export class MarService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * Creates the DUE administration slots for the next `hours` from every active, signed order of the admission.
   * Idempotent: slots are unique per (order item, time), so repeated or concurrent calls never duplicate a dose.
   */
  async generate(ctx: RequestContext, admissionId: string, input: z.infer<typeof generateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      const items = await tx.medicationOrderItem.findMany({
        where: { tenantId: ctx.tenantId, status: "ACTIVE", order: { encounterId: adm.encounterId, status: "SIGNED" } },
        include: { order: { select: { signedAt: true } } },
      });
      const now = Date.now();
      const windowEnd = now + input.hours * 3_600_000;
      const rows: Prisma.MedicationAdministrationCreateManyInput[] = [];
      for (const it of items) {
        const signedAt = it.order.signedAt?.getTime() ?? now;
        const start = Math.max(signedAt, now - 12 * 3_600_000);
        const end = Math.min(windowEnd, it.durationDays ? signedAt + it.durationDays * 86_400_000 : windowEnd);
        const times: Date[] = [];
        if (it.frequency === "STAT") {
          times.push(new Date(signedAt));
        } else if (FREQUENCY_TIMES[it.frequency]) {
          for (let d = new Date(start - 86_400_000); d.getTime() <= end + 86_400_000; d = new Date(d.getTime() + 86_400_000)) {
            const day = localDateStr(d, tz);
            for (const m of FREQUENCY_TIMES[it.frequency] as number[]) {
              const at = zonedToUtc(day, m, tz);
              if (at.getTime() >= start && at.getTime() <= end) times.push(at);
            }
          }
        }
        for (const at of times) {
          rows.push({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, encounterId: adm.encounterId, medicationOrderItemId: it.id, scheduledAt: at });
        }
      }
      const created = rows.length ? await tx.medicationAdministration.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      if (created.count > 0) await this.audit.record(tx, actorOf(ctx), { action: "MAR_SCHEDULE_GENERATED", entityType: "Admission", entityId: admissionId, metadata: { slots: created.count, hours: input.hours } });
      return { created: created.count };
    });
  }

  /** Records what the nurse did. A DUE slot can be resolved exactly once; the order is never altered. */
  async administer(ctx: RequestContext, id: string, input: z.infer<typeof administerSchema>) {
    if (input.status !== "GIVEN" && !input.remarks) throw new DomainError("VALIDATION_FAILED", "Explain why the dose was not given", 400, [{ path: "remarks", message: "Required for missed, held or refused doses" }]);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.medicationAdministration.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { item: { include: { order: { select: { status: true } } } }, admission: { select: { status: true } } } });
      if (!row) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (row.admission.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The patient is no longer admitted", 409);
      if (row.status !== "DUE") throw new DomainError("INVALID_STATE", `This dose was already recorded as ${row.status.toLowerCase()}`, 409);
      const now = new Date();
      if (input.status === "GIVEN") {
        if (row.item.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${row.item.genericName} was stopped by the doctor and cannot be given`, 409);
        if (row.item.order.status !== "SIGNED") throw new DomainError("INVALID_STATE", "This prescription is no longer active", 409);
      }
      if (input.status === "MISSED" && row.scheduledAt.getTime() > now.getTime()) throw new DomainError("INVALID_STATE", "A dose that is not yet due cannot be marked as missed", 409);
      const at = input.administeredAt ?? now;
      if (input.status === "GIVEN") {
        if (at.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The administration time cannot be in the future", 400);
        if (at.getTime() < row.scheduledAt.getTime() - 2 * 3_600_000) throw new DomainError("VALIDATION_FAILED", "The dose cannot be given more than 2 hours before it is due", 400);
      }
      const res = await tx.medicationAdministration.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "DUE" },
        data: { status: input.status, administeredById: ctx.userId, administeredAt: input.status === "GIVEN" ? at : null, remarks: input.remarks ?? null },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This dose was just recorded by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), {
        action: `MEDICATION_${input.status}`, entityType: "MedicationAdministration", entityId: id,
        metadata: { admissionId: row.admissionId, medicationOrderItemId: row.medicationOrderItemId, scheduledAt: row.scheduledAt.toISOString(), ...(input.remarks ? { remarks: input.remarks } : {}) },
      });
      return this.one(tx, ctx, id);
    });
  }

  /** PRN (SOS) or other as-needed doses given outside the generated schedule. */
  async giveUnscheduled(ctx: RequestContext, admissionId: string, input: z.infer<typeof unscheduledSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      const item = await tx.medicationOrderItem.findFirst({ where: { id: input.medicationOrderItemId, tenantId: ctx.tenantId, order: { encounterId: adm.encounterId, status: "SIGNED" } } });
      if (!item) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (item.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${item.genericName} was stopped by the doctor`, 409);
      if (!["SOS", "OTHER"].includes(item.frequency)) throw new DomainError("INVALID_STATE", "Only as-needed (SOS) or custom-frequency medicines can be given outside the schedule", 409);
      const now = new Date();
      const at = input.administeredAt ?? now;
      if (at.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The administration time cannot be in the future", 400);
      const row = await tx.medicationAdministration.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, encounterId: adm.encounterId, medicationOrderItemId: item.id, scheduledAt: at, unscheduled: true, status: "GIVEN", administeredAt: at, administeredById: ctx.userId, remarks: input.remarks ?? null },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "MEDICATION_GIVEN", entityType: "MedicationAdministration", entityId: row.id, metadata: { admissionId, medicationOrderItemId: item.id, unscheduled: true } });
      return this.one(tx, ctx, row.id);
    });
  }

  async list(ctx: RequestContext, admissionId: string, q: z.infer<typeof marListSchema>) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const now = Date.now();
    const rows = await this.prisma.medicationAdministration.findMany({
      where: { tenantId: ctx.tenantId, admissionId, scheduledAt: { gte: q.from ?? new Date(now - 24 * 3_600_000), lte: q.to ?? new Date(now + 48 * 3_600_000) } },
      select: VIEW, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], take: 500,
    });
    const names = await this.names(this.prisma, ctx, rows.flatMap((r) => (r.administeredById ? [r.administeredById] : [])));
    return rows.map((r) => toMarView(r, now, names));
  }

  /** Ward-level due list for the nurse worklist: everything due soon or overdue, oldest first. */
  async due(ctx: RequestContext, q: z.infer<typeof dueQuerySchema>) {
    const now = Date.now();
    const rows = await this.prisma.medicationAdministration.findMany({
      where: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "DUE", scheduledAt: { lte: new Date(now + q.withinMinutes * 60_000) },
        admission: { status: "ADMITTED", ...(q.wardId ? { assignments: { some: { releasedAt: null, bed: { wardId: q.wardId } } } } : {}) },
        item: { status: "ACTIVE" },
      },
      select: { ...VIEW, patientId: true, admission: { select: { admissionNumber: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, assignments: { where: { releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { name: true } } } } } } } } },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], take: 300,
    });
    return rows.map((r) => ({
      ...toMarView(r, now),
      admissionNumber: r.admission.admissionNumber, patientName: [r.admission.patient.firstName, r.admission.patient.lastName].filter(Boolean).join(" "), mrn: r.admission.patient.identifiers[0]?.value ?? null,
      bed: r.admission.assignments[0]?.bed.code ?? null, ward: r.admission.assignments[0]?.bed.ward.name ?? null,
    }));
  }

  // ───── internals ─────

  private async admission(db: Db, ctx: RequestContext, id: string) {
    const a = await db.admission.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (a.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The patient is no longer admitted", 409);
    return a;
  }

  private async one(db: Db, ctx: RequestContext, id: string) {
    const r = await db.medicationAdministration.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW });
    return toMarView(r, Date.now(), await this.names(db, ctx, r.administeredById ? [r.administeredById] : []));
  }

  private async names(db: Db, ctx: RequestContext, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }
}
