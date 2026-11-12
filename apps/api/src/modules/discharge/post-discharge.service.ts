import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { SettingsService } from "../settings/settings.service";
import { Decimal } from "@medos/shared";
import { fmt } from "../billing/billing.domain";
import { postDischargeOf } from "./post-discharge.domain";

export const postDischargeListSchema = z.object({
  show: z.enum(["OPEN", "RECORDS", "CLAIMS", "RECEIVABLES", "ALL"]).default("OPEN"),
  days: z.coerce.number().int().min(1).max(365).default(90),
}).strict();

/**
 * The post-discharge list (docs/discharge-stages.md) for the Medical Records Department, the TPA desk and finance: discharged stays of the last
 * `days` days with their record, claim and receivables, worked out by the same rule as the discharge checklist. "Open" is anything not yet closed.
 */
@Injectable()
export class PostDischargeService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async list(ctx: RequestContext, q: z.infer<typeof postDischargeListSchema>) {
    const T = ctx.tenantId;
    const since = new Date(Date.now() - q.days * 86_400_000);
    const adms = await this.prisma.admission.findMany({
      where: { tenantId: T, facilityId: ctx.facilityId, status: "DISCHARGED", dischargedAt: { gte: since }, AND: [admissionScope(ctx)] },
      orderBy: [{ dischargedAt: "desc" }, { id: "asc" }], take: 500,
      select: {
        id: true, admissionNumber: true, encounterId: true, dischargedAt: true, dischargeType: true, finalInvoiceId: true, status: true,
        patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        departure: { select: { id: true } }, recordCompletion: { select: { completedAt: true, completedById: true, note: true } },
        recordFileMoves: { orderBy: [{ at: "desc" }, { id: "desc" }], take: 1, select: { action: true, location: true, issuedTo: true, at: true } },
      },
    });
    if (adms.length === 0) return { items: [], total: 0 };
    const enc = adms.map((a) => a.encounterId);
    const [summaries, drafts, claims, invoices, requireVerified] = await Promise.all([
      this.prisma.clinicalDocument.findMany({ where: { tenantId: T, encounterId: { in: enc }, kind: "DISCHARGE_SUMMARY" }, select: { id: true, encounterId: true, status: true, currentVersion: true } }),
      this.prisma.clinicalDocument.groupBy({ by: ["encounterId"], where: { tenantId: T, encounterId: { in: enc }, status: "DRAFT" }, _count: { _all: true } }),
      this.prisma.claim.findMany({ where: { tenantId: T, facilityId: ctx.facilityId, encounterId: { in: enc } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { encounterId: true, claimNumber: true, status: true, approvedAmount: true, preauthApproved: true, settledAmount: true, policy: { select: { insurer: { select: { name: true } } } } } }),
      this.prisma.invoice.findMany({ where: { tenantId: T, id: { in: adms.map((a) => a.finalInvoiceId).filter((x): x is string => !!x) } }, select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true } }),
      this.settings.get(this.prisma, T, ctx.facilityId, "DISCHARGE_REQUIRE_VERIFIED_SUMMARY"),
    ]);
    const verifications = summaries.length ? await this.prisma.dischargeSummaryVerification.findMany({ where: { tenantId: T, documentId: { in: summaries.map((s) => s.id) } }, select: { documentId: true, version: true } }) : [];
    const userIds = [...new Set(adms.map((a) => a.recordCompletion?.completedById).filter((x): x is string => !!x))];
    const names = new Map((userIds.length ? await this.prisma.user.findMany({ where: { tenantId: T, id: { in: userIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const now = new Date();
    const rows = adms.map((a) => {
      const s = summaries.find((x) => x.encounterId === a.encounterId) ?? null;
      const c = claims.find((x) => x.encounterId === a.encounterId) ?? null;
      const p = postDischargeOf({
        admissionStatus: a.status, dischargedAt: a.dischargedAt, summaryStatus: s?.status ?? null,
        summaryVerified: !!s && verifications.some((v) => v.documentId === s.id && v.version === s.currentVersion), verificationRequired: requireVerified as boolean,
        draftDocuments: drafts.find((d) => d.encounterId === a.encounterId)?._count._all ?? 0,
        exitStatus: a.departure ? "CONFIRMED" : a.dischargeType === "ABSCONDED" ? "NOT_APPLICABLE" : "PENDING",
        recordCompletion: a.recordCompletion ? { completedAt: a.recordCompletion.completedAt, byName: names.get(a.recordCompletion.completedById) ?? null, note: a.recordCompletion.note } : null,
        claim: c ? { claimNumber: c.claimNumber, status: c.status, insurer: c.policy.insurer.name, approvedAmount: c.approvedAmount, preauthApproved: c.preauthApproved, settledAmount: c.settledAmount } : null,
        fileMoves: a.recordFileMoves.map((m) => ({ ...m, byName: null })),
        invoice: invoices.find((x) => x.id === a.finalInvoiceId) ?? null, now,
      });
      return {
        admissionId: a.id, admissionNumber: a.admissionNumber, patient: [a.patient.firstName, a.patient.lastName].filter(Boolean).join(" "), mrn: a.patient.identifiers[0]?.value ?? null,
        dischargedAt: a.dischargedAt, daysSinceDischarge: p.daysSinceDischarge, status: p.status, hisStatus: p.hisStatus, recordReady: p.recordReady,
        recordComplete: !!a.recordCompletion, recordFile: p.file.current?.label ?? null, claim: p.claim, receivables: p.receivables,
      };
    });
    const keep = rows.filter((r) => q.show === "ALL" ? true : q.show === "OPEN" ? r.status !== "CLOSED"
      : q.show === "RECORDS" ? !r.recordComplete : q.show === "CLAIMS" ? !!r.claim?.open : r.receivables.patient !== "0.00" || r.receivables.insurer !== "0.00");
    // Ageing of what is still owed, by days since discharge (all stays in the window, whatever the filter).
    const buckets = [{ key: "0-30", max: 30 }, { key: "31-60", max: 60 }, { key: "61-90", max: 90 }, { key: "90+", max: Infinity }];
    const ageing = buckets.map((b, i) => {
      const lo = i === 0 ? -1 : buckets[i - 1]!.max;
      const inB = rows.filter((r) => (r.daysSinceDischarge ?? 0) > lo && (r.daysSinceDischarge ?? 0) <= b.max);
      const sum = (k: "patient" | "insurer") => inB.reduce((a, r) => a.plus(r.receivables[k]), new Decimal(0));
      return { bucket: b.key, patient: fmt(sum("patient")), insurer: fmt(sum("insurer")), stays: inB.filter((r) => r.receivables.patient !== "0.00" || r.receivables.insurer !== "0.00").length };
    });
    return { items: keep.slice(0, 200), total: keep.length, ageing };
  }
}
