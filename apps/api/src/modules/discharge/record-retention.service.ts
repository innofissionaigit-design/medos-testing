import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SettingsService } from "../settings/settings.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2031-04-01");

export const retentionListSchema = z.object({
  show: z.enum(["DUE", "HELD", "CLEARED", "ALL"]).default("DUE"),
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const retentionReviewSchema = z.object({
  decision: z.enum(["HOLD", "CLEAR_FOR_ARCHIVE"]), retainUntil: day.optional(), note: z.string().trim().min(5).max(300),
}).strict().refine((v) => v.decision === "HOLD" || v.retainUntil === undefined, { path: ["retainUntil"], message: "A date applies only to a hold" });

export type RetentionState = "WITHIN" | "DUE" | "HELD" | "CLEARED";
interface Row {
  id: string; encounterNumber: string; type: "OPD" | "IPD"; endedAt: Date; patientId: string; firstName: string; lastName: string | null; mrn: string | null;
  retentionEnds: Date; state: RetentionState; reviewDecision: string | null; reviewRetainUntil: Date | null; reviewNote: string | null; reviewAt: Date | null; reviewBy: string | null;
}

/**
 * Medical-record retention (docs/record-retention.md). The hospital sets how many years a finished OPD visit and an IPD stay are kept (settings), counted from the end
 * of the visit; a child's record is kept until they are an adult plus the same period. When the period is over the Medical Records Department decides:
 * hold it longer (a legal hold or ongoing case, to a date or without an end) or clear it for archiving under the hospital's policy. MedOS never deletes a record:
 * these are decisions on the record, each kept with who and when.
 */
@Injectable()
export class RecordRetentionService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  private async policy(ctx: RequestContext) {
    const [opd, ipd, minors] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "MR_RETENTION_YEARS_OPD"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "MR_RETENTION_YEARS_IPD"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "MR_RETENTION_MINORS_UNTIL_ADULT"),
    ]);
    return { opd: opd as number, ipd: ipd as number, minors: minors as boolean };
  }

  /** The finished visits with the date their retention period ends and where they stand, optionally one visit or a search. Tenant and facility scoped. */
  private async rows(ctx: RequestContext, p: { opd: number; ipd: number; minors: boolean }, extra: Prisma.Sql, state: RetentionState[] | null, limit: number, offset: number): Promise<Row[]> {
    const stateFilter = state ? Prisma.sql`WHERE x.state = ANY(${state}::text[])` : Prisma.empty;
    return this.prisma.$queryRaw<Row[]>`
      WITH base AS (
        SELECT e.id, e."encounterNumber", e.type::text AS type, e."endedAt", e."patientId", pa."firstName", pa."lastName",
          (SELECT i.value FROM "PatientIdentifier" i WHERE i."patientId" = pa.id AND i."tenantId" = pa."tenantId" AND i.type = 'MRN' LIMIT 1) AS mrn,
          GREATEST(
            e."endedAt" + make_interval(years => CASE WHEN e.type = 'IPD' THEN ${p.ipd}::int ELSE ${p.opd}::int END),
            CASE WHEN ${p.minors}::boolean AND pa."dateOfBirth" IS NOT NULL AND (pa."dateOfBirth" + interval '18 years') > e."endedAt"::date
                 THEN (pa."dateOfBirth" + interval '18 years' + make_interval(years => CASE WHEN e.type = 'IPD' THEN ${p.ipd}::int ELSE ${p.opd}::int END))::timestamptz END
          ) AS "retentionEnds",
          r.decision::text AS "reviewDecision", r."retainUntil" AS "reviewRetainUntil", r.note AS "reviewNote", r."decidedAt" AS "reviewAt", u."fullName" AS "reviewBy"
        FROM "Encounter" e JOIN "Patient" pa ON pa.id = e."patientId" AND pa."tenantId" = e."tenantId"
        LEFT JOIN LATERAL (SELECT * FROM "RecordRetentionReview" rr WHERE rr."tenantId" = e."tenantId" AND rr."encounterId" = e.id ORDER BY rr."decidedAt" DESC, rr.id DESC LIMIT 1) r ON true
        LEFT JOIN "User" u ON u.id = r."decidedById" AND u."tenantId" = e."tenantId"
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.status = 'COMPLETED' AND e."endedAt" IS NOT NULL ${extra}
      ), x AS (
        SELECT base.*, CASE
          WHEN "reviewDecision" = 'CLEAR_FOR_ARCHIVE' THEN 'CLEARED'
          WHEN "reviewDecision" = 'HOLD' AND ("reviewRetainUntil" IS NULL OR "reviewRetainUntil" >= CURRENT_DATE) THEN 'HELD'
          WHEN "retentionEnds" <= now() THEN 'DUE'
          ELSE 'WITHIN' END AS state FROM base)
      SELECT x.* FROM x ${stateFilter} ORDER BY x."retentionEnds" ASC, x.id ASC LIMIT ${limit} OFFSET ${offset}`;
  }

  private view(r: Row) {
    return {
      encounterId: r.id, encounterNumber: r.encounterNumber, type: r.type, patient: [r.firstName, r.lastName].filter(Boolean).join(" "), mrn: r.mrn,
      endedAt: r.endedAt, retentionEnds: r.retentionEnds.toISOString().slice(0, 10), state: r.state,
      review: r.reviewDecision ? { decision: r.reviewDecision, retainUntil: r.reviewRetainUntil ? r.reviewRetainUntil.toISOString().slice(0, 10) : null, note: r.reviewNote, at: r.reviewAt, by: r.reviewBy } : null,
    };
  }

  async policyView(ctx: RequestContext) {
    const p = await this.policy(ctx);
    return { opdYears: p.opd, ipdYears: p.ipd, minorsUntilAdult: p.minors };
  }

  async list(ctx: RequestContext, q: z.infer<typeof retentionListSchema>) {
    const p = await this.policy(ctx);
    const search = q.q ? Prisma.sql`AND (e."encounterNumber" ILIKE ${`%${q.q}%`} OR pa."searchName" LIKE ${`%${q.q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim()}%`} OR EXISTS (SELECT 1 FROM "PatientIdentifier" i WHERE i."patientId" = pa.id AND i."tenantId" = pa."tenantId" AND i.type = 'MRN' AND i.value ILIKE ${`%${q.q}%`}))` : Prisma.empty;
    const states: RetentionState[] = q.show === "ALL" ? ["DUE", "HELD", "CLEARED"] : [q.show];
    const rows = await this.rows(ctx, p, search, states, q.pageSize + 1, (q.page - 1) * q.pageSize);
    const counts = await this.counts(ctx, p);
    return { policy: { opdYears: p.opd, ipdYears: p.ipd, minorsUntilAdult: p.minors }, counts, page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize, items: rows.slice(0, q.pageSize).map((r) => this.view(r)) };
  }

  private async counts(ctx: RequestContext, p: { opd: number; ipd: number; minors: boolean }) {
    const c = await this.prisma.$queryRaw<{ state: string; n: number }[]>`
      WITH base AS (
        SELECT GREATEST(
            e."endedAt" + make_interval(years => CASE WHEN e.type = 'IPD' THEN ${p.ipd}::int ELSE ${p.opd}::int END),
            CASE WHEN ${p.minors}::boolean AND pa."dateOfBirth" IS NOT NULL AND (pa."dateOfBirth" + interval '18 years') > e."endedAt"::date
                 THEN (pa."dateOfBirth" + interval '18 years' + make_interval(years => CASE WHEN e.type = 'IPD' THEN ${p.ipd}::int ELSE ${p.opd}::int END))::timestamptz END) AS ends,
          r.decision::text AS decision, r."retainUntil" AS until
        FROM "Encounter" e JOIN "Patient" pa ON pa.id = e."patientId" AND pa."tenantId" = e."tenantId"
        LEFT JOIN LATERAL (SELECT decision, "retainUntil" FROM "RecordRetentionReview" rr WHERE rr."tenantId" = e."tenantId" AND rr."encounterId" = e.id ORDER BY rr."decidedAt" DESC, rr.id DESC LIMIT 1) r ON true
        WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.status = 'COMPLETED' AND e."endedAt" IS NOT NULL)
      SELECT CASE WHEN decision = 'CLEAR_FOR_ARCHIVE' THEN 'CLEARED' WHEN decision = 'HOLD' AND (until IS NULL OR until >= CURRENT_DATE) THEN 'HELD' WHEN ends <= now() THEN 'DUE' ELSE 'WITHIN' END AS state, COUNT(*)::int AS n
      FROM base GROUP BY 1`;
    const get = (s: string) => c.find((x) => x.state === s)?.n ?? 0;
    return { due: get("DUE"), held: get("HELD"), cleared: get("CLEARED") };
  }

  /** Records the decision. A record can be cleared for archive only once its retention period is over; a hold can be placed at any time. Each decision is kept and audited. */
  async review(ctx: RequestContext, encounterId: string, input: z.infer<typeof retentionReviewSchema>) {
    const p = await this.policy(ctx);
    const [row] = await this.rows(ctx, p, Prisma.sql`AND e.id = ${encounterId}::uuid`, null, 1, 0);
    if (!row) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (input.decision === "CLEAR_FOR_ARCHIVE" && row.retentionEnds.getTime() > Date.now()) throw new DomainError("INVALID_STATE", `This record must be kept until ${row.retentionEnds.toISOString().slice(0, 10)}`, 409);
    if (input.decision === "CLEAR_FOR_ARCHIVE" && row.state === "CLEARED") throw new DomainError("INVALID_STATE", "This record is already cleared for archive", 409);
    if (input.retainUntil && input.retainUntil < new Date().toISOString().slice(0, 10)) throw new DomainError("VALIDATION_FAILED", "A hold must end today or later", 400, [{ path: "retainUntil", message: "In the past" }]);
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.recordRetentionReview.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, decision: input.decision, retainUntil: input.retainUntil ? new Date(input.retainUntil) : null, note: input.note, decidedById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), {
        action: input.decision === "HOLD" ? "RECORD_RETENTION_HOLD" : "RECORD_RETENTION_CLEARED", entityType: "Encounter", entityId: encounterId,
        metadata: { reviewId: r.id, encounterNumber: row.encounterNumber, ...(input.retainUntil ? { retainUntil: input.retainUntil } : {}), from: row.state },
      });
      return { id: r.id, decision: input.decision };
    });
  }
}
