import { Injectable } from "@nestjs/common";
import { Decimal } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { fmt } from "../billing/billing.domain";
import { doctorShare, pickRule } from "./earnings.domain";

/** The bills whose money counts towards a doctor's share: the consultation (OPD) and the in-patient final bill (IPD). Pharmacy, tests and fees are not the doctor's. */
const COUNTED_KINDS = ["OPD", "IPD"] as const;

/**
 * The doctor-share ledger (docs/earnings-and-reports.md). Called by the billing ledger every time money is received or given back on an invoice, inside the
 * same transaction. It works out what the doctor of the visit should have earned from everything now collected on the visit's OPD and IPD bills (payments from a
 * patient's advance count when the advance is used, refunds count when they are given back), and appends one line for the difference. Nothing is posted when
 * the visit has no doctor or no earnings rule applies, so a hospital that does not use the split is untouched.
 */
@Injectable()
export class ShareLedgerService {
  constructor(private readonly audit: AuditService) {}

  async sync(tx: Db, ctx: RequestContext, invoiceId: string, trigger: "PAYMENT" | "REFUND"): Promise<void> {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, encounterId: true, kind: true, patientId: true } });
    if (!inv?.encounterId || !(COUNTED_KINDS as readonly string[]).includes(inv.kind)) return;
    const enc = await tx.encounter.findFirst({ where: { id: inv.encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, practitionerId: true, startedAt: true, patientId: true } });
    if (!enc?.practitionerId) return;
    const rules = await tx.doctorShareRule.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, practitionerId: true, mode: true, percent: true, fixedAmount: true, effectiveFrom: true, createdAt: true } });
    if (rules.length === 0) return;

    // One visit's share is worked out by one transaction at a time, so two payments on two bills of the same visit cannot both post the same difference.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`share:${enc.id}`}, 0))`;

    const [bills, posted] = await Promise.all([
      tx.invoice.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id, kind: { in: [...COUNTED_KINDS] }, status: { notIn: ["DRAFT"] } }, select: { paidTotal: true, refundedTotal: true } }),
      tx.doctorShareEntry.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id }, select: { collectedDelta: true, doctorDelta: true, ruleId: true }, orderBy: { createdAt: "asc" } }),
    ]);
    const collected = Decimal.max(0, bills.reduce<Decimal>((a, b) => a.plus(b.paidTotal.toString()).minus(b.refundedTotal.toString()), new Decimal(0)));
    const sum = (xs: { toString(): string }[]) => xs.reduce<Decimal>((a, x) => a.plus(x.toString()), new Decimal(0));
    const postedCollected = sum(posted.map((p) => p.collectedDelta));
    const postedDoctor = sum(posted.map((p) => p.doctorDelta));

    // A visit keeps the rule its first line used, so a rule added later never changes what the visit earned; a visit with no lines yet takes the rule in force on its day.
    const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const frozenId = posted[0]?.ruleId;
    const rule = frozenId ? rules.find((r) => r.id === frozenId) ?? null : pickRule(rules, enc.practitionerId, localDateStr(enc.startedAt, tz));
    if (!rule) return;

    const target = doctorShare(rule, collected, "CONSULTED");
    const collectedDelta = collected.minus(postedCollected);
    const doctorDelta = target.minus(postedDoctor);
    if (collectedDelta.isZero() && doctorDelta.isZero()) return;

    const row = await tx.doctorShareEntry.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id, patientId: enc.patientId, practitionerId: enc.practitionerId, invoiceId: inv.id, trigger,
        ruleId: rule.id, ruleMode: rule.mode, collectedDelta: collectedDelta.toFixed(2), doctorDelta: doctorDelta.toFixed(2), hospitalDelta: collectedDelta.minus(doctorDelta).toFixed(2), createdById: ctx.userId,
      },
      select: { id: true },
    });
    await this.audit.record(tx, actorOf(ctx), {
      action: "DOCTOR_SHARE_POSTED", entityType: "DoctorShareEntry", entityId: row.id,
      metadata: { encounterId: enc.id, invoiceId: inv.id, trigger, ruleMode: rule.mode, collected: fmt(collectedDelta), doctorShare: fmt(doctorDelta) },
    });
  }
}
