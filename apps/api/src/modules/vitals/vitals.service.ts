import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { assertPatientVisible, visitScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { EncountersService } from "../encounters/encounters.service";
import { bmi, fahrenheitToCelsius, inRange, OBS_META, WRITABLE_TYPES, type ObsType } from "./vitals.domain";

const reading = z.object({
  type: z.enum(WRITABLE_TYPES),
  value: z.number().finite(),
  unit: z.enum(["C", "F"]).optional(),
  recordedAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
}).strict();

export const recordVitalsSchema = z.object({ observations: z.array(reading).min(1).max(12) }).strict().superRefine((v, c) => {
  const seen = new Set<string>();
  v.observations.forEach((o, i) => {
    if (seen.has(o.type)) c.addIssue({ code: "custom", path: ["observations", i, "type"], message: "Each measurement may appear once per entry" });
    seen.add(o.type);
    if (o.unit && o.type !== "TEMPERATURE") c.addIssue({ code: "custom", path: ["observations", i, "unit"], message: `${OBS_META[o.type].label} is recorded in ${OBS_META[o.type].unit}` });
  });
});

export const errorSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const listVitalsSchema = z.object({
  includeErrors: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  type: z.enum(["SYSTOLIC_BP", "DIASTOLIC_BP", "PULSE", "RESPIRATORY_RATE", "TEMPERATURE", "SPO2", "WEIGHT", "HEIGHT", "BMI", "BLOOD_GLUCOSE"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const VIEW = {
  id: true, type: true, value: true, unit: true, status: true, derived: true, recordedAt: true, recordedById: true,
  encounterId: true, errorReason: true, errorMarkedAt: true,
} satisfies Prisma.ObservationSelect;
type Row = Prisma.ObservationGetPayload<{ select: typeof VIEW }>;

export const toObservationView = (o: Row, names?: Map<string, string>) => ({
  ...o, value: o.value.toString(), recordedByName: names?.get(o.recordedById) ?? null,
});

@Injectable()
export class VitalsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly encounters: EncountersService) {}

  async record(ctx: RequestContext, encounterId: string, input: z.infer<typeof recordVitalsSchema>) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      const full = await tx.encounter.findFirstOrThrow({ where: { id: encounterId, tenantId: ctx.tenantId }, select: { startedAt: true } });

      const values = new Map<ObsType, Decimal>();
      for (const o of input.observations) {
        const v = o.type === "TEMPERATURE" && o.unit === "F" ? fahrenheitToCelsius(o.value) : new Decimal(o.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (!inRange(o.type, v)) {
          throw new DomainError("VALIDATION_FAILED", `${OBS_META[o.type].label} of ${o.value}${o.type === "TEMPERATURE" ? " " + (o.unit ?? "C") : " " + OBS_META[o.type].unit} is outside the possible range`, 400, [{ path: `observations.${o.type}`, message: "Value outside possible range" }]);
        }
        const when = o.recordedAt ?? now;
        if (when.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "A reading cannot be recorded in the future", 400);
        if (when.getTime() < full.startedAt.getTime()) throw new DomainError("VALIDATION_FAILED", "A reading cannot be dated before the visit started", 400);
        values.set(o.type, v);
      }
      const sbp = values.get("SYSTOLIC_BP");
      const dbp = values.get("DIASTOLIC_BP");
      if (sbp && dbp && dbp.gte(sbp)) throw new DomainError("VALIDATION_FAILED", "Diastolic pressure must be lower than systolic pressure", 400);

      const rows: Prisma.ObservationCreateManyInput[] = input.observations.map((o) => ({
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId,
        type: o.type, value: values.get(o.type) as Decimal, unit: OBS_META[o.type].unit,
        recordedAt: o.recordedAt ?? now, recordedById: ctx.userId,
      }));

      if (values.has("WEIGHT") || values.has("HEIGHT")) {
        const weight = values.get("WEIGHT") ?? (await this.latestValue(tx, ctx, enc.patientId, "WEIGHT"));
        const height = values.get("HEIGHT") ?? (await this.latestValue(tx, ctx, enc.patientId, "HEIGHT"));
        const b = weight && height ? bmi(weight, height) : null;
        if (b) rows.push({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, type: "BMI", value: b, unit: OBS_META.BMI.unit, derived: true, recordedAt: now, recordedById: ctx.userId });
      }

      await tx.observation.createMany({ data: rows });
      await this.audit.record(tx, actorOf(ctx), { action: "VITALS_RECORDED", entityType: "Encounter", entityId: encounterId, metadata: { types: rows.map((r) => r.type as string), count: rows.length } });
      return this.listInTx(tx, ctx, encounterId, false);
    });
  }

  async enterInError(ctx: RequestContext, observationId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.observation.findFirst({ where: { id: observationId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (o.derived) throw new DomainError("INVALID_STATE", "Derived values follow their source readings; mark the source reading instead", 409);
      if (o.status !== "FINAL") throw new DomainError("INVALID_STATE", "This reading is already marked as an error", 409);
      const now = new Date();
      const flag = { status: "ENTERED_IN_ERROR" as const, errorReason: reason, errorMarkedById: ctx.userId, errorMarkedAt: now };
      const res = await tx.observation.updateMany({ where: { id: observationId, tenantId: ctx.tenantId, status: "FINAL" }, data: flag });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This reading was changed by someone else", 409);
      if (o.type === "WEIGHT" || o.type === "HEIGHT") {
        await tx.observation.updateMany({
          where: { tenantId: ctx.tenantId, encounterId: o.encounterId, type: "BMI", derived: true, recordedAt: o.recordedAt, status: "FINAL" },
          data: { ...flag, errorReason: `Source ${OBS_META[o.type].label.toLowerCase()} entered in error` },
        });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "VITALS_ENTERED_IN_ERROR", entityType: "Observation", entityId: observationId, metadata: { type: o.type, encounterId: o.encounterId, reason } });
      return toObservationView(await tx.observation.findFirstOrThrow({ where: { id: observationId, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  async listForEncounter(ctx: RequestContext, encounterId: string, includeErrors: boolean) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.listInTx(this.prisma, ctx, encounterId, includeErrors);
  }

  async listForPatient(ctx: RequestContext, patientId: string, q: z.infer<typeof listVitalsSchema>) {
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    await assertPatientVisible(this.prisma, ctx, patientId);
    const where: Prisma.ObservationWhereInput = { tenantId: ctx.tenantId, patientId: { in: ids }, ...(q.includeErrors ? {} : { status: "FINAL" }), ...(q.type ? { type: q.type } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.observation.findMany({ where, select: VIEW, orderBy: { recordedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.observation.count({ where }),
    ]);
    return { items: rows.map((r) => toObservationView(r)), total };
  }

  private async latestValue(tx: Db, ctx: RequestContext, patientId: string, type: ObsType): Promise<Decimal | null> {
    const o = await tx.observation.findFirst({ where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(tx, ctx.tenantId, patientId)) ?? [patientId] }, type, status: "FINAL" }, orderBy: { recordedAt: "desc" }, select: { value: true } });
    return o ? new Decimal(o.value.toString()) : null;
  }

  private async listInTx(db: Db, ctx: RequestContext, encounterId: string, includeErrors: boolean) {
    const rows = await db.observation.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, ...(includeErrors ? {} : { status: "FINAL" }) },
      select: VIEW, orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
    });
    const users = await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.recordedById))] } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    const items = rows.map((r) => toObservationView(r, names));
    const latest: Record<string, ReturnType<typeof toObservationView>> = {};
    for (const o of items) if (o.status === "FINAL" && !latest[o.type]) latest[o.type] = o;
    return { items, latest };
  }
}
