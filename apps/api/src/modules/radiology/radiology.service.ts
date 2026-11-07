import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";

const MODALITIES = ["XRAY", "ULTRASOUND", "CT", "MRI", "MAMMOGRAPHY", "OTHER"] as const;

export const performSchema = z.object({
  modality: z.enum(MODALITIES),
  bodyPart: z.string().trim().min(2).max(80),
  clinicalNotes: z.string().trim().max(500).optional(),
}).strict();
export const reportSchema = z.object({
  findings: z.string().trim().min(3).max(8000),
  impression: z.string().trim().min(3).max(2000),
  critical: z.boolean().default(false),
}).strict();
export const amendSchema = reportSchema.extend({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(5).max(300) }).strict();
export const worklistSchema = z.object({
  state: z.enum(["WAITING_STUDY", "PERFORMED", "REPORTED", "CRITICAL"]).optional(),
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export type RadState = "WAITING_STUDY" | "PERFORMED" | "REPORTED";
const stateOf = (study: { status: string } | null | undefined): RadState => (!study ? "WAITING_STUDY" : study.status === "REPORTED" ? "REPORTED" : "PERFORMED");
const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/**
 * Radiology (docs/radiology.md): from a billed radiology test to a signed report. The radiographer performs the study (it gets an accession number), the radiologist
 * writes the findings and impression and signs, and a correction later is an amendment with its reason. Signed reports are never edited; every version is kept.
 * A critical finding stays flagged until the doctor of the visit acknowledges it.
 */
@Injectable()
export class RadiologyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly notifications: NotificationsService, private readonly email: EmailService) {}

  async worklist(ctx: RequestContext, q: z.infer<typeof worklistSchema>) {
    const search: Prisma.TestOrderWhereInput[] = q.q ? [
      { patient: { searchName: { contains: q.q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim() } } },
      { patient: { identifiers: { some: { type: "MRN", value: { contains: q.q, mode: "insensitive" } } } } },
      { radStudy: { is: { accessionNumber: { contains: q.q, mode: "insensitive" } } } },
    ] : [];
    const stateWhere: Prisma.TestOrderWhereInput =
      q.state === "WAITING_STUDY" ? { radStudy: { is: null } }
      : q.state === "PERFORMED" ? { radStudy: { is: { status: "PERFORMED" } } }
      : q.state === "REPORTED" ? { radStudy: { is: { status: "REPORTED" } } }
      : q.state === "CRITICAL" ? { radStudy: { is: { hasCritical: true, criticalAckAt: null } } } : {};
    const where: Prisma.TestOrderWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "RADIOLOGY", status: "BILLED", ...(search.length ? { OR: search } : {}), ...stateWhere };
    const [rows, total] = await Promise.all([
      this.prisma.testOrder.findMany({
        where, orderBy: [{ billedAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: {
          id: true, name: true, billedAt: true,
          patient: { select: { id: true, firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
          encounter: { select: { id: true, encounterNumber: true } },
          radStudy: { select: { id: true, accessionNumber: true, modality: true, bodyPart: true, status: true, currentVersion: true, hasCritical: true, criticalAckAt: true } },
        },
      }),
      this.prisma.testOrder.count({ where }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((r) => ({
        testOrderId: r.id, test: r.name, billedAt: r.billedAt, patientId: r.patient.id, patient: nameOf(r.patient), gender: r.patient.gender, mrn: r.patient.identifiers[0]?.value ?? null,
        encounterId: r.encounter.id, visitNumber: r.encounter.encounterNumber, state: stateOf(r.radStudy), studyId: r.radStudy?.id ?? null, accessionNumber: r.radStudy?.accessionNumber ?? null,
        modality: r.radStudy?.modality ?? null, bodyPart: r.radStudy?.bodyPart ?? null,
        critical: r.radStudy?.hasCritical === true && !r.radStudy.criticalAckAt, criticalAcknowledged: r.radStudy?.hasCritical === true && !!r.radStudy.criticalAckAt,
      })),
    };
  }

  /** The study is performed for a billed radiology test: it gets its accession number and goes to the radiologist. */
  async perform(ctx: RequestContext, testOrderId: string, input: z.infer<typeof performSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rad:${testOrderId}`}, 0))`;
      const o = await tx.testOrder.findFirst({ where: { id: testOrderId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "RADIOLOGY", status: "BILLED" }, select: { id: true, name: true, patientId: true, encounterId: true } });
      if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (await tx.radStudy.count({ where: { tenantId: ctx.tenantId, testOrderId } }) > 0) throw new DomainError("CONFLICT", "This study has already been performed", 409);
      const accessionNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "RAD_ACCESSION");
      const s = await tx.radStudy.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: o.patientId, encounterId: o.encounterId, testOrderId, accessionNumber, modality: input.modality, bodyPart: input.bodyPart, clinicalNotes: input.clinicalNotes ?? null, performedById: ctx.userId },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_STUDY_PERFORMED", entityType: "RadStudy", entityId: s.id, metadata: { accessionNumber, testOrderId, modality: input.modality } });
      return { id: s.id, accessionNumber, testOrderId };
    });
  }

  /** One billed radiology test: the study (if performed) and every report version, newest first. */
  async study(ctx: RequestContext, testOrderId: string, opts: { scoped?: boolean } = {}) {
    const o = await this.prisma.testOrder.findFirst({
      where: { id: testOrderId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, category: "RADIOLOGY", status: "BILLED", ...(opts.scoped ? { encounter: { AND: [visitScope(ctx)] } } : {}) },
      select: { id: true, name: true, patient: { select: { id: true, firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, encounter: { select: { id: true, encounterNumber: true } } },
    });
    if (!o) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const s = await this.prisma.radStudy.findFirst({ where: { tenantId: ctx.tenantId, testOrderId }, include: { reports: { orderBy: { version: "desc" } } } });
    const ids = [...new Set([...(s?.reports.map((r) => r.signedById) ?? []), ...(s ? [s.performedById] : [])])];
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return {
      testOrderId: o.id, test: o.name, patient: { id: o.patient.id, name: nameOf(o.patient), gender: o.patient.gender, mrn: o.patient.identifiers[0]?.value ?? null }, encounterId: o.encounter.id, visitNumber: o.encounter.encounterNumber,
      state: stateOf(s),
      study: s ? { id: s.id, accessionNumber: s.accessionNumber, modality: s.modality, bodyPart: s.bodyPart, clinicalNotes: s.clinicalNotes, performedAt: s.performedAt, performedBy: users.get(s.performedById) ?? null, currentVersion: s.currentVersion, hasCritical: s.hasCritical, criticalAcknowledged: !!s.criticalAckAt } : null,
      reports: (s?.reports ?? []).map((r) => ({ version: r.version, kind: r.kind, findings: r.findings, impression: r.impression, hasCritical: r.hasCritical, reason: r.reason, signedAt: r.signedAt, signedBy: users.get(r.signedById) ?? null })),
    };
  }

  private async lockStudy(tx: Prisma.TransactionClient, ctx: RequestContext, studyId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "RadStudy" WHERE id = ${studyId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.radStudy.findFirstOrThrow({ where: { id: studyId, tenantId: ctx.tenantId } });
  }

  /** The radiologist signs the first report. */
  async report(ctx: RequestContext, studyId: string, input: z.infer<typeof reportSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.lockStudy(tx, ctx, studyId);
      if (s.status !== "PERFORMED") throw new DomainError("INVALID_STATE", "This study has already been reported", 409);
      await tx.radReportVersion.create({ data: { tenantId: ctx.tenantId, studyId: s.id, version: 1, kind: "SIGNED", findings: input.findings, impression: input.impression, hasCritical: input.critical, signedById: ctx.userId } });
      await tx.radStudy.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: s.id } }, data: { status: "REPORTED", currentVersion: 1, hasCritical: input.critical } });
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_REPORT_SIGNED", entityType: "RadStudy", entityId: s.id, metadata: { testOrderId: s.testOrderId, version: 1, critical: input.critical } });
      if (input.critical) await this.audit.record(tx, actorOf(ctx), { action: "RAD_CRITICAL_FINDING", entityType: "RadStudy", entityId: s.id, metadata: { testOrderId: s.testOrderId, version: 1 } });
      if (input.critical) await this.notifications.criticalResult(tx, ctx, "RAD", s.testOrderId, s.id, 1);
      await this.email.reportReadyEmail(tx, ctx, s.testOrderId, s.id, "RadStudy");
      return { id: s.id, status: "REPORTED" as const, currentVersion: 1, hasCritical: input.critical };
    });
  }

  /** A correction to a signed report: a new version with its reason; the earlier versions stay. A critical finding needs the doctor's attention again. */
  async amend(ctx: RequestContext, studyId: string, input: z.infer<typeof amendSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const s = await this.lockStudy(tx, ctx, studyId);
      if (s.status !== "REPORTED") throw new DomainError("INVALID_STATE", "Only a signed report is amended; sign the first report instead", 409);
      if (s.currentVersion !== input.expectedVersion) throw new DomainError("STALE_VERSION", "This report was amended by someone else. Review the latest version first", 409, { currentVersion: s.currentVersion });
      const next = s.currentVersion + 1;
      await tx.radReportVersion.create({ data: { tenantId: ctx.tenantId, studyId: s.id, version: next, kind: "AMENDED", findings: input.findings, impression: input.impression, hasCritical: input.critical, reason: input.reason, signedById: ctx.userId } });
      await tx.radStudy.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: s.id } }, data: { currentVersion: next, hasCritical: input.critical, ...(input.critical ? { criticalAckById: null, criticalAckAt: null } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_REPORT_AMENDED", entityType: "RadStudy", entityId: s.id, metadata: { testOrderId: s.testOrderId, version: next, reason: input.reason } });
      if (input.critical) await this.audit.record(tx, actorOf(ctx), { action: "RAD_CRITICAL_FINDING", entityType: "RadStudy", entityId: s.id, metadata: { testOrderId: s.testOrderId, version: next } });
      if (input.critical) await this.notifications.criticalResult(tx, ctx, "RAD", s.testOrderId, s.id, next);
      return { id: s.id, status: "REPORTED" as const, currentVersion: next, hasCritical: input.critical };
    });
  }

  /** The doctor of the visit confirms they have seen a critical finding. */
  async acknowledgeCritical(ctx: RequestContext, studyId: string) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.radStudy.findFirst({ where: { id: studyId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounter: { AND: [visitScope(ctx)] } }, select: { id: true, testOrderId: true, hasCritical: true, criticalAckAt: true } });
      if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!s.hasCritical) throw new DomainError("INVALID_STATE", "This report has no critical finding", 409);
      if (s.criticalAckAt) throw new DomainError("INVALID_STATE", "This critical finding was already acknowledged", 409);
      const res = await tx.radStudy.updateMany({ where: { id: s.id, tenantId: ctx.tenantId, criticalAckAt: null }, data: { criticalAckById: ctx.userId, criticalAckAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This critical finding was already acknowledged", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_CRITICAL_ACKNOWLEDGED", entityType: "RadStudy", entityId: s.id, metadata: { testOrderId: s.testOrderId } });
      return { id: s.id, acknowledged: true };
    });
  }

  async critical(ctx: RequestContext) {
    const rows = await this.prisma.radStudy.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, hasCritical: true, criticalAckAt: null }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 100,
      select: { id: true, testOrderId: true, modality: true, bodyPart: true, updatedAt: true, testOrder: { select: { name: true } }, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, encounter: { select: { id: true, encounterNumber: true, practitioner: { select: { displayName: true } } } } },
    });
    return rows.map((r) => ({ studyId: r.id, testOrderId: r.testOrderId, test: r.testOrder.name, bodyPart: r.bodyPart, since: r.updatedAt, patient: nameOf(r.patient), mrn: r.patient.identifiers[0]?.value ?? null, encounterId: r.encounter.id, visitNumber: r.encounter.encounterNumber, doctor: r.encounter.practitioner?.displayName ?? null }));
  }

  /** One visit's radiology tests and where they stand, with the latest report once signed. */
  async forEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const orders = await this.prisma.testOrder.findMany({
      where: { tenantId: ctx.tenantId, encounterId, category: "RADIOLOGY", status: "BILLED" }, orderBy: { createdAt: "asc" },
      select: { id: true, name: true, radStudy: { select: { id: true, accessionNumber: true, status: true, currentVersion: true, hasCritical: true, criticalAckAt: true, reports: { orderBy: { version: "desc" }, take: 1, select: { version: true, kind: true, findings: true, impression: true, signedAt: true } } } } },
    });
    return orders.map((o) => ({
      testOrderId: o.id, test: o.name, state: stateOf(o.radStudy), accessionNumber: o.radStudy?.accessionNumber ?? null, studyId: o.radStudy?.id ?? null,
      critical: o.radStudy?.hasCritical === true && !o.radStudy.criticalAckAt, amended: (o.radStudy?.currentVersion ?? 0) > 1, report: o.radStudy?.reports[0] ?? null,
    }));
  }
}
