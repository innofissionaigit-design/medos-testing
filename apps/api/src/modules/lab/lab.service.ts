import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";
import { flagNumber, isCritical, parseNumber, rangeFor, rangeText, type LabFlag, type ParamFacts } from "./lab.domain";

const uuid = z.string().uuid();
const dec = z.number().min(-999_999).max(999_999).multipleOf(0.001);
/** The one parameter of a test that has no definition yet: a single typed result. */
const FREE = "FREE";

const parameterSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().max(20).optional(),
  type: z.enum(["NUMERIC", "TEXT", "CHOICE"]).default("NUMERIC"),
  choices: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  decimals: z.number().int().min(0).max(6).default(1),
  low: dec.nullish(), high: dec.nullish(), lowMale: dec.nullish(), highMale: dec.nullish(), lowFemale: dec.nullish(), highFemale: dec.nullish(), criticalLow: dec.nullish(), criticalHigh: dec.nullish(),
}).strict().superRefine((p, c) => {
  if (p.type === "CHOICE" && p.choices.length < 2) c.addIssue({ code: "custom", path: ["choices"], message: "A choice needs at least two answers" });
  if (p.type !== "CHOICE" && p.choices.length > 0) c.addIssue({ code: "custom", path: ["choices"], message: "Answers are only for a choice" });
  const pairs: [string, number | null | undefined, number | null | undefined][] = [["low", p.low, p.high], ["lowMale", p.lowMale, p.highMale], ["lowFemale", p.lowFemale, p.highFemale], ["criticalLow", p.criticalLow, p.criticalHigh]];
  for (const [path, lo, hi] of pairs) if (lo !== null && lo !== undefined && hi !== null && hi !== undefined && lo > hi) c.addIssue({ code: "custom", path: [path], message: "The lower limit is above the upper limit" });
  if (p.type !== "NUMERIC" && [p.low, p.high, p.lowMale, p.highMale, p.lowFemale, p.highFemale, p.criticalLow, p.criticalHigh].some((x) => x !== null && x !== undefined)) c.addIssue({ code: "custom", path: ["low"], message: "Ranges are only for a number" });
});
export const saveTestSchema = z.object({
  specimen: z.string().trim().min(2).max(80),
  method: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(400).optional(),
  turnaroundHours: z.number().int().min(1).max(720).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  parameters: z.array(parameterSchema).min(1).max(40),
}).strict();

const valueSchema = z.object({ parameterId: z.string().min(1).max(64), value: z.string().trim().max(500) }).strict();
export const draftSchema = z.object({ version: z.number().int().min(1), values: z.array(valueSchema).min(1).max(60), comment: z.string().trim().max(1000).optional() }).strict();
export const verifySchema = z.object({ version: z.number().int().min(1), comment: z.string().trim().max(1000).optional() }).strict();
export const amendSchema = z.object({ expectedVersion: z.number().int().min(1), values: z.array(valueSchema).min(1).max(60), reason: z.string().trim().min(5).max(300), comment: z.string().trim().max(1000).optional() }).strict();
export const collectSchema = z.object({ notes: z.string().trim().max(300).optional() }).strict();
export const rejectSampleSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const worklistSchema = z.object({
  state: z.enum(["WAITING_SAMPLE", "SAMPLE_TAKEN", "REPORTED", "CRITICAL"]).optional(),
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export type WorkState = "WAITING_SAMPLE" | "SAMPLE_TAKEN" | "REPORTED";
interface DraftValue { parameterId: string; value: string }
interface Draft { values?: DraftValue[]; comment?: string; enteredById?: string }
export interface SnapshotValue { parameterId: string; name: string; unit: string | null; type: string; value: string; flag: LabFlag; low: string | null; high: string | null; rangeText: string; criticalLow: string | null; criticalHigh: string | null }

type ParamRow = ParamFacts & { id: string; name: string; unit: string | null; lineNo: number };

/**
 * The laboratory (docs/lims.md): from a billed laboratory test to a verified report. A sample is taken (with its accession number), results are typed in against the
 * test's parameters and checked against the reference ranges for the patient, a person with authority verifies them (which releases the report and flags critical
 * values), and a correction later is an amendment with its reason. Verified reports are never edited; every version is kept.
 */
@Injectable()
export class LabService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly notifications: NotificationsService, private readonly email: EmailService) {}

  // ───── test definitions ─────

  /** Every laboratory test on the price list, with how the lab has set it up (or null when it has not). */
  async tests(ctx: RequestContext) {
    const services = await this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "INVESTIGATION", status: "ACTIVE" }, orderBy: { name: "asc" }, take: 500, select: { id: true, code: true, name: true } });
    const defs = await this.prisma.labTestDefinition.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { parameters: { orderBy: { lineNo: "asc" } } } });
    const by = new Map(defs.map((d) => [d.serviceId, d]));
    return services.map((s) => {
      const d = by.get(s.id);
      return {
        serviceId: s.id, code: s.code, name: s.name,
        definition: d ? { id: d.id, specimen: d.specimen, method: d.method, instructions: d.instructions, turnaroundHours: d.turnaroundHours, status: d.status, parameters: d.parameters.filter((p) => p.status === "ACTIVE").map((p) => this.paramView(p)) } : null,
      };
    });
  }

  private paramView(p: Prisma.LabParameterGetPayload<object>) {
    const n = (v: { toString(): string } | null) => (v === null ? null : new Decimal(v.toString()).toFixed(p.decimals));
    return { id: p.id, lineNo: p.lineNo, name: p.name, unit: p.unit, type: p.type, choices: p.choices, decimals: p.decimals, low: n(p.low), high: n(p.high), lowMale: n(p.lowMale), highMale: n(p.highMale), lowFemale: n(p.lowFemale), highFemale: n(p.highFemale), criticalLow: n(p.criticalLow), criticalHigh: n(p.criticalHigh) };
  }

  /** Sets a test up, or changes it. Parameters that are no longer listed become inactive (never deleted), so earlier reports keep their own copy of what they showed. */
  async saveTest(ctx: RequestContext, serviceId: string, input: z.infer<typeof saveTestSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const svc = await tx.service.findFirst({ where: { id: serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "INVESTIGATION" }, select: { id: true, name: true } });
      if (!svc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const existing = await tx.labTestDefinition.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId }, include: { parameters: true } });
      const base = { specimen: input.specimen, method: input.method ?? null, instructions: input.instructions ?? null, turnaroundHours: input.turnaroundHours ?? null, status: input.status };
      const def = existing
        ? await tx.labTestDefinition.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.id } }, data: base, select: { id: true } })
        : await tx.labTestDefinition.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId, createdById: ctx.userId, ...base }, select: { id: true } });
      const keep = new Set<string>();
      let lineNo = (existing?.parameters.reduce((m, p) => Math.max(m, p.lineNo), 0) ?? 0);
      // Lines already used keep their number; a new parameter takes the next. Inactive ones are never reused.
      for (const p of input.parameters) {
        const data = {
          name: p.name, unit: p.unit ?? null, type: p.type, choices: p.choices, decimals: p.decimals, status: "ACTIVE" as const,
          low: p.low ?? null, high: p.high ?? null, lowMale: p.lowMale ?? null, highMale: p.highMale ?? null, lowFemale: p.lowFemale ?? null, highFemale: p.highFemale ?? null, criticalLow: p.criticalLow ?? null, criticalHigh: p.criticalHigh ?? null,
        };
        const own = p.id ? existing?.parameters.find((x) => x.id === p.id) : undefined;
        if (p.id && !own) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (own) { await tx.labParameter.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: own.id } }, data }); keep.add(own.id); }
        else { const made = await tx.labParameter.create({ data: { tenantId: ctx.tenantId, definitionId: def.id, lineNo: ++lineNo, ...data }, select: { id: true } }); keep.add(made.id); }
      }
      const dropped = (existing?.parameters ?? []).filter((p) => p.status === "ACTIVE" && !keep.has(p.id)).map((p) => p.id);
      if (dropped.length) await tx.labParameter.updateMany({ where: { tenantId: ctx.tenantId, definitionId: def.id, id: { in: dropped } }, data: { status: "INACTIVE" } });
      await this.audit.record(tx, actorOf(ctx), { action: existing ? "LAB_TEST_UPDATED" : "LAB_TEST_CREATED", entityType: "LabTestDefinition", entityId: def.id, metadata: { service: svc.name, parameters: input.parameters.length, specimen: input.specimen, status: input.status } });
    });
    return (await this.tests(ctx)).find((t) => t.serviceId === serviceId);
  }

  // ───── the work list ─────

  private stateOf(sampleLive: boolean, verified: boolean): WorkState { return verified ? "REPORTED" : sampleLive ? "SAMPLE_TAKEN" : "WAITING_SAMPLE"; }

  /** Billed laboratory tests and where each one stands, oldest first within a state. */
  async worklist(ctx: RequestContext, q: z.infer<typeof worklistSchema>) {
    const search: Prisma.TestOrderWhereInput[] = q.q ? [
      { patient: { searchName: { contains: q.q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim() } } },
      { patient: { identifiers: { some: { type: "MRN", value: { contains: q.q, mode: "insensitive" } } } } },
      { labSamples: { some: { accessionNumber: { contains: q.q, mode: "insensitive" } } } },
    ] : [];
    const stateWhere: Prisma.TestOrderWhereInput =
      q.state === "WAITING_SAMPLE" ? { labSamples: { none: { status: "COLLECTED" } }, NOT: { labResult: { is: { status: "VERIFIED" } } } }
      : q.state === "SAMPLE_TAKEN" ? { labSamples: { some: { status: "COLLECTED" } }, NOT: { labResult: { is: { status: "VERIFIED" } } } }
      : q.state === "REPORTED" ? { labResult: { is: { status: "VERIFIED" } } }
      : q.state === "CRITICAL" ? { labResult: { is: { hasCritical: true, criticalAckAt: null } } } : {};
    const where: Prisma.TestOrderWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "LABORATORY", status: "BILLED", ...(search.length ? { OR: search } : {}), ...stateWhere };
    const [rows, total] = await Promise.all([
      this.prisma.testOrder.findMany({
        where, orderBy: [{ billedAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: {
          id: true, name: true, billedAt: true, serviceId: true,
          patient: { select: { id: true, firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
          encounter: { select: { id: true, encounterNumber: true } },
          labSamples: { orderBy: { collectedAt: "desc" }, take: 1, select: { id: true, accessionNumber: true, status: true } },
          labResult: { select: { id: true, status: true, currentVersion: true, hasCritical: true, criticalAckAt: true } },
        },
      }),
      this.prisma.testOrder.count({ where }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => {
        const s = r.labSamples[0];
        const live = s?.status === "COLLECTED";
        return {
          testOrderId: r.id, test: r.name, billedAt: r.billedAt, patientId: r.patient.id, patient: [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" "), gender: r.patient.gender, mrn: r.patient.identifiers[0]?.value ?? null,
          encounterId: r.encounter.id, visitNumber: r.encounter.encounterNumber, state: this.stateOf(live, r.labResult?.status === "VERIFIED"), accessionNumber: live ? s.accessionNumber : null, sampleId: live ? s.id : null,
          resultId: r.labResult?.id ?? null, version: r.labResult?.currentVersion ?? 0, critical: r.labResult?.hasCritical === true && !r.labResult.criticalAckAt, criticalAcknowledged: r.labResult?.hasCritical === true && !!r.labResult.criticalAckAt,
        };
      }),
    };
  }

  // ───── samples ─────

  private async billedOrder(db: Db | PrismaService, ctx: RequestContext, testOrderId: string) {
    const o = await db.testOrder.findFirst({ where: { id: testOrderId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "LABORATORY", status: "BILLED" }, select: { id: true, name: true, serviceId: true, patientId: true, encounterId: true } });
    if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return o;
  }

  /** A sample is taken for a billed laboratory test: it gets an accession number (the number on the label) and the result form opens. */
  async collect(ctx: RequestContext, testOrderId: string, input: z.infer<typeof collectSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lab:${testOrderId}`}, 0))`;
      const o = await this.billedOrder(tx, ctx, testOrderId);
      const verified = await tx.labResult.findFirst({ where: { tenantId: ctx.tenantId, testOrderId, status: "VERIFIED" }, select: { id: true } });
      if (verified) throw new DomainError("INVALID_STATE", "This test has already been reported", 409);
      if (await tx.labSample.count({ where: { tenantId: ctx.tenantId, testOrderId, status: "COLLECTED" } }) > 0) throw new DomainError("CONFLICT", "A sample has already been collected for this test", 409);
      const def = o.serviceId ? await tx.labTestDefinition.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, serviceId: o.serviceId, status: "ACTIVE" }, select: { id: true, specimen: true } }) : null;
      const specimen = def?.specimen ?? "Sample";
      const accessionNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "LAB_ACCESSION");
      const sample = await tx.labSample.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: o.patientId, encounterId: o.encounterId, testOrderId, accessionNumber, specimen, notes: input.notes ?? null, collectedById: ctx.userId },
        select: { id: true },
      });
      const have = await tx.labResult.findFirst({ where: { tenantId: ctx.tenantId, testOrderId }, select: { id: true } });
      if (have) await tx.labResult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: have.id } }, data: { sampleId: sample.id, specimen } });
      else await tx.labResult.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: o.patientId, encounterId: o.encounterId, testOrderId, sampleId: sample.id, definitionId: def?.id ?? null, name: o.name, specimen } });
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_SAMPLE_COLLECTED", entityType: "LabSample", entityId: sample.id, metadata: { accessionNumber, testOrderId, specimen } });
      return { id: sample.id, accessionNumber, specimen, testOrderId };
    });
  }

  /** A sample that cannot be used is rejected with a reason; another can be taken. */
  async rejectSample(ctx: RequestContext, sampleId: string, input: z.infer<typeof rejectSampleSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.labSample.findFirst({ where: { id: sampleId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (s.status !== "COLLECTED") throw new DomainError("INVALID_STATE", "This sample was already rejected", 409);
      const done = await tx.labResult.findFirst({ where: { tenantId: ctx.tenantId, testOrderId: s.testOrderId, status: "VERIFIED" }, select: { id: true } });
      if (done) throw new DomainError("INVALID_STATE", "The test has already been reported from this sample", 409);
      await tx.labSample.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: s.id } }, data: { status: "REJECTED", rejectReason: input.reason, rejectedAt: new Date(), rejectedById: ctx.userId } });
      await tx.labResult.updateMany({ where: { tenantId: ctx.tenantId, testOrderId: s.testOrderId, sampleId: s.id }, data: { sampleId: null } });
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_SAMPLE_REJECTED", entityType: "LabSample", entityId: s.id, metadata: { accessionNumber: s.accessionNumber, reason: input.reason } });
      return { id: s.id, accessionNumber: s.accessionNumber, status: "REJECTED" as const };
    });
  }

  // ───── results ─────

  private async paramsFor(db: Db | PrismaService, tenantId: string, definitionId: string | null, name: string): Promise<ParamRow[]> {
    if (!definitionId) return [{ id: FREE, name, unit: null, lineNo: 1, type: "TEXT", choices: [], decimals: 0, low: null, high: null, lowMale: null, highMale: null, lowFemale: null, highFemale: null, criticalLow: null, criticalHigh: null }];
    const rows = await db.labParameter.findMany({ where: { tenantId, definitionId, status: "ACTIVE" }, orderBy: { lineNo: "asc" } });
    return rows.map((p) => ({ id: p.id, name: p.name, unit: p.unit, lineNo: p.lineNo, type: p.type, choices: p.choices, decimals: p.decimals, low: p.low, high: p.high, lowMale: p.lowMale, highMale: p.highMale, lowFemale: p.lowFemale, highFemale: p.highFemale, criticalLow: p.criticalLow, criticalHigh: p.criticalHigh }));
  }

  /** Turns what was typed into the values of a report, checking each against its parameter. Every active parameter needs a value. */
  private build(params: ParamRow[], gender: string | null, given: DraftValue[]): { values: SnapshotValue[]; hasCritical: boolean } {
    const byId = new Map(given.map((g) => [g.parameterId, g.value.trim()]));
    for (const g of given) if (!params.some((p) => p.id === g.parameterId)) throw new DomainError("VALIDATION_FAILED", "A value was given for something this test does not measure", 400, [{ path: "values", message: "Unknown parameter" }]);
    const values: SnapshotValue[] = [];
    for (const p of params) {
      const raw = byId.get(p.id) ?? "";
      if (!raw) throw new DomainError("VALIDATION_FAILED", `Enter a value for ${p.name}`, 400, [{ path: `values.${p.id}`, message: "Required" }]);
      let value = raw, flag: LabFlag = "NORMAL";
      if (p.type === "NUMERIC") {
        const n = parseNumber(raw);
        if (!n) throw new DomainError("VALIDATION_FAILED", `${p.name} must be a number`, 400, [{ path: `values.${p.id}`, message: "Not a number" }]);
        value = n.toFixed(p.decimals);
        flag = flagNumber(p, gender, n);
      } else if (p.type === "CHOICE" && !p.choices.includes(raw)) {
        throw new DomainError("VALIDATION_FAILED", `${p.name} must be one of: ${p.choices.join(", ")}`, 400, [{ path: `values.${p.id}`, message: "Not one of the answers" }]);
      }
      const { low, high } = rangeFor(p, gender);
      const n3 = (v: { toString(): string } | null | undefined) => (v == null ? null : new Decimal(v.toString()).toFixed(p.decimals));
      values.push({ parameterId: p.id, name: p.name, unit: p.unit, type: p.type, value, flag, low: low ? low.toFixed(p.decimals) : null, high: high ? high.toFixed(p.decimals) : null, rangeText: rangeText(low, high, p.decimals), criticalLow: n3(p.criticalLow), criticalHigh: n3(p.criticalHigh) });
    }
    return { values, hasCritical: values.some((v) => isCritical(v.flag)) };
  }

  /** The result of one billed laboratory test: what to fill in (with the ranges for this patient), what has been typed, and the reports so far. */
  async result(ctx: RequestContext, testOrderId: string, opts: { scoped?: boolean } = {}) {
    const o = await this.prisma.testOrder.findFirst({
      where: { id: testOrderId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "LABORATORY", status: "BILLED", ...(opts.scoped ? { encounter: { AND: [visitScope(ctx)] } } : {}) },
      select: { id: true, name: true, patient: { select: { id: true, firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, encounter: { select: { id: true, encounterNumber: true } } },
    });
    if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const r = await this.prisma.labResult.findFirst({ where: { tenantId: ctx.tenantId, testOrderId }, include: { versions: { orderBy: { version: "desc" } } } });
    const sample = await this.prisma.labSample.findFirst({ where: { tenantId: ctx.tenantId, testOrderId }, orderBy: { collectedAt: "desc" } });
    const params = await this.paramsFor(this.prisma, ctx.tenantId, r?.definitionId ?? null, o.name);
    const draft = (r?.draft ?? {}) as Draft;
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...(r?.versions.map((v) => v.verifiedById) ?? []), ...(sample ? [sample.collectedById] : [])])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const gender = o.patient.gender;
    return {
      testOrderId: o.id, test: o.name, patient: { id: o.patient.id, name: [o.patient.firstName, o.patient.lastName].filter(Boolean).join(" "), gender, mrn: o.patient.identifiers[0]?.value ?? null }, encounterId: o.encounter.id, visitNumber: o.encounter.encounterNumber,
      sample: sample ? { id: sample.id, accessionNumber: sample.accessionNumber, specimen: sample.specimen, status: sample.status, collectedAt: sample.collectedAt, collectedBy: users.get(sample.collectedById) ?? null, rejectReason: sample.rejectReason } : null,
      resultId: r?.id ?? null, status: r?.status ?? null, version: r?.version ?? null, currentVersion: r?.currentVersion ?? 0, hasCritical: r?.hasCritical ?? false, criticalAcknowledged: !!r?.criticalAckAt,
      parameters: params.map((p) => {
        const { low, high } = rangeFor(p, gender);
        return { id: p.id, name: p.name, unit: p.unit, type: p.type, choices: p.choices, decimals: p.decimals, rangeText: rangeText(low, high, p.decimals), criticalLow: p.criticalLow == null ? null : new Decimal(p.criticalLow.toString()).toFixed(p.decimals), criticalHigh: p.criticalHigh == null ? null : new Decimal(p.criticalHigh.toString()).toFixed(p.decimals) };
      }),
      draft: { values: draft.values ?? [], comment: draft.comment ?? "" },
      reports: (r?.versions ?? []).map((v) => ({ version: v.version, kind: v.kind, values: v.values as unknown as SnapshotValue[], comment: v.comment, reason: v.reason, hasCritical: v.hasCritical, verifiedAt: v.verifiedAt, verifiedBy: users.get(v.verifiedById) ?? null })),
    };
  }

  private async lockResult(tx: Db, ctx: RequestContext, resultId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LabResult" WHERE id = ${resultId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.labResult.findFirstOrThrow({ where: { id: resultId, tenantId: ctx.tenantId }, include: { patient: { select: { gender: true } } } });
  }

  /** Saves what has been typed so far. Someone else saving at the same moment is noticed (the version token) instead of being overwritten. */
  async saveDraft(ctx: RequestContext, resultId: string, input: z.infer<typeof draftSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockResult(tx, ctx, resultId);
      if (r.status !== "DRAFT") throw new DomainError("INVALID_STATE", "This result has been verified. A correction is made as an amendment", 409);
      if (!r.sampleId) throw new DomainError("INVALID_STATE", "Collect a sample first: there is no live sample for this test", 409);
      if (r.version !== input.version) throw new DomainError("STALE_VERSION", "Someone else changed this result. Reload it first", 409, { currentVersion: r.version });
      const params = await this.paramsFor(tx, ctx.tenantId, r.definitionId, r.name);
      for (const v of input.values) if (!params.some((p) => p.id === v.parameterId)) throw new DomainError("VALIDATION_FAILED", "A value was given for something this test does not measure", 400, [{ path: "values", message: "Unknown parameter" }]);
      const draft: Draft = { values: input.values, comment: input.comment ?? "", enteredById: ctx.userId };
      await tx.labResult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: r.id } }, data: { draft: draft as unknown as Prisma.InputJsonObject, version: r.version + 1 } });
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_RESULT_SAVED", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId, values: input.values.length } });
      return { id: r.id, version: r.version + 1 };
    });
  }

  /** Verifying releases the report: every value is checked and flagged against the ranges for the patient, and the report is written as version 1. */
  async verify(ctx: RequestContext, resultId: string, input: z.infer<typeof verifySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockResult(tx, ctx, resultId);
      if (r.status !== "DRAFT") throw new DomainError("INVALID_STATE", "This result has already been verified", 409);
      if (!r.sampleId) throw new DomainError("INVALID_STATE", "Collect a sample first: there is no live sample for this test", 409);
      if (r.version !== input.version) throw new DomainError("STALE_VERSION", "Someone else changed this result. Reload it first", 409, { currentVersion: r.version });
      const draft = (r.draft ?? {}) as Draft;
      const params = await this.paramsFor(tx, ctx.tenantId, r.definitionId, r.name);
      const { values, hasCritical } = this.build(params, r.patient.gender, draft.values ?? []);
      await tx.labResultVersion.create({ data: { tenantId: ctx.tenantId, resultId: r.id, version: 1, kind: "VERIFIED", values: values as unknown as Prisma.InputJsonArray, comment: input.comment ?? draft.comment ?? null, hasCritical, enteredById: draft.enteredById ?? null, verifiedById: ctx.userId } });
      await tx.labResult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: r.id } }, data: { status: "VERIFIED", currentVersion: 1, hasCritical } });
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_RESULT_VERIFIED", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId, version: 1, abnormal: values.filter((v) => v.flag !== "NORMAL").length } });
      if (hasCritical) await this.audit.record(tx, actorOf(ctx), { action: "LAB_CRITICAL_RESULT", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId, parameters: values.filter((v) => isCritical(v.flag)).map((v) => v.name) } });
      if (hasCritical) await this.notifications.criticalResult(tx, ctx, "LAB", r.testOrderId, r.id, 1);
      // The patient is told a report is ready, never what it says (docs/email.md).
      await this.email.reportReadyEmail(tx, ctx, r.testOrderId, r.id, "LabResult");
      return { id: r.id, status: "VERIFIED" as const, currentVersion: 1, hasCritical };
    });
  }

  /** A correction to a verified report: a new version with its reason; the earlier versions stay. A critical value needs the doctor's attention again. */
  async amend(ctx: RequestContext, resultId: string, input: z.infer<typeof amendSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockResult(tx, ctx, resultId);
      if (r.status !== "VERIFIED") throw new DomainError("INVALID_STATE", "Only a verified result is amended; a draft is edited directly", 409);
      if (r.currentVersion !== input.expectedVersion) throw new DomainError("STALE_VERSION", "This report was amended by someone else. Review the latest version first", 409, { currentVersion: r.currentVersion });
      const params = await this.paramsFor(tx, ctx.tenantId, r.definitionId, r.name);
      const { values, hasCritical } = this.build(params, r.patient.gender, input.values);
      const next = r.currentVersion + 1;
      await tx.labResultVersion.create({ data: { tenantId: ctx.tenantId, resultId: r.id, version: next, kind: "AMENDED", values: values as unknown as Prisma.InputJsonArray, comment: input.comment ?? null, reason: input.reason, hasCritical, enteredById: ctx.userId, verifiedById: ctx.userId } });
      await tx.labResult.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: r.id } }, data: { currentVersion: next, hasCritical, ...(hasCritical ? { criticalAckById: null, criticalAckAt: null } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_RESULT_AMENDED", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId, version: next, reason: input.reason } });
      if (hasCritical) await this.audit.record(tx, actorOf(ctx), { action: "LAB_CRITICAL_RESULT", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId, version: next } });
      if (hasCritical) await this.notifications.criticalResult(tx, ctx, "LAB", r.testOrderId, r.id, next);
      return { id: r.id, status: "VERIFIED" as const, currentVersion: next, hasCritical };
    });
  }

  /** The doctor of the visit confirms they have seen a critical result. */
  async acknowledgeCritical(ctx: RequestContext, resultId: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.labResult.findFirst({ where: { id: resultId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounter: { AND: [visitScope(ctx)] } }, select: { id: true, testOrderId: true, hasCritical: true, criticalAckAt: true } });
      if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!r.hasCritical) throw new DomainError("INVALID_STATE", "This result has no critical value", 409);
      if (r.criticalAckAt) throw new DomainError("INVALID_STATE", "This critical result was already acknowledged", 409);
      const res = await tx.labResult.updateMany({ where: { id: r.id, tenantId: ctx.tenantId, criticalAckAt: null }, data: { criticalAckById: ctx.userId, criticalAckAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This critical result was already acknowledged", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "LAB_CRITICAL_ACKNOWLEDGED", entityType: "LabResult", entityId: r.id, metadata: { testOrderId: r.testOrderId } });
      return { id: r.id, acknowledged: true };
    });
  }

  /** Critical results nobody has acknowledged yet, oldest first. */
  async critical(ctx: RequestContext) {
    const rows = await this.prisma.labResult.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, hasCritical: true, criticalAckAt: null }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 100,
      select: { id: true, testOrderId: true, name: true, updatedAt: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, encounter: { select: { id: true, encounterNumber: true, practitioner: { select: { displayName: true } } } } },
    });
    return rows.map((r) => ({ resultId: r.id, testOrderId: r.testOrderId, test: r.name, since: r.updatedAt, patient: [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" "), mrn: r.patient.identifiers[0]?.value ?? null, encounterId: r.encounter.id, visitNumber: r.encounter.encounterNumber, doctor: r.encounter.practitioner?.displayName ?? null }));
  }

  /** One visit's laboratory tests and where they stand, with the values of those that are reported. For the doctor of the visit and for the lab. */
  async forEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const orders = await this.prisma.testOrder.findMany({
      where: { tenantId: ctx.tenantId, encounterId, category: "LABORATORY", status: "BILLED" }, orderBy: { createdAt: "asc" },
      select: { id: true, name: true, labSamples: { where: { status: "COLLECTED" }, select: { accessionNumber: true } }, labResult: { select: { id: true, status: true, currentVersion: true, hasCritical: true, criticalAckAt: true, versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, kind: true, values: true, comment: true, verifiedAt: true } } } } },
    });
    return orders.map((o) => {
      const v = o.labResult?.versions[0];
      return {
        testOrderId: o.id, test: o.name, state: this.stateOf(o.labSamples.length > 0, o.labResult?.status === "VERIFIED"), accessionNumber: o.labSamples[0]?.accessionNumber ?? null,
        resultId: o.labResult?.id ?? null, critical: o.labResult?.hasCritical === true && !o.labResult.criticalAckAt, amended: (o.labResult?.currentVersion ?? 0) > 1,
        report: v ? { version: v.version, kind: v.kind, values: v.values as unknown as SnapshotValue[], comment: v.comment, verifiedAt: v.verifiedAt } : null,
      };
    });
  }
}
