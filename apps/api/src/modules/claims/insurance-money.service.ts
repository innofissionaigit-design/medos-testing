import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { computeLine, fmt } from "../billing/billing.domain";
import { amount, percent } from "../billing/money.schema";
import { ClaimsService } from "./claims.service";
import {
  addLedgers, ageBucket, AGE_BUCKETS, daysBetween, estimate as estimateOf, ledgerOf, packageScope, planPayment, splitBill, type Ledger, type LineKind, type PolicyRule,
} from "./insurance-money.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const ref = z.string().trim().min(4).max(60);
const money = (v: { toString(): string } | null | undefined): string | null => (v === null || v === undefined ? null : fmt(new Decimal(v.toString())));
const D = (v: { toString(): string } | null | undefined): Decimal => new Decimal(v?.toString() ?? 0);
const ZERO = new Decimal(0);
const DEDUCTION = ["NOT_COVERED", "ROOM_RENT_LIMIT", "PATIENT_COPAY", "OVER_RATE", "DEDUCTIBLE", "OTHER"] as const;
const DEDUCTION_LABEL: Record<(typeof DEDUCTION)[number], string> = { NOT_COVERED: "Item not covered", ROOM_RENT_LIMIT: "Room rent too high", PATIENT_COPAY: "Patient co-pay", OVER_RATE: "Above the insurer's rate", DEDUCTIBLE: "Deductible", OTHER: "Other" };

export const cutSchema = z.object({ category: z.enum(DEDUCTION), amount: amount({ positive: true }), note: z.string().trim().max(300).optional() }).strict()
  .refine((v) => v.category !== "OTHER" || (v.note?.length ?? 0) >= 3, { path: ["note"], message: "Say what the other reason is" });
export const paymentSchema = z.object({
  insurerId: uuid, reference: ref, receivedOn: day, amount: amount({ positive: true }),
  lines: z.array(z.object({ claimId: uuid, amount: amount({ positive: true }), tdsAmount: amount().optional(), final: z.boolean().default(false) }).strict()).max(100).default([]),
}).strict();
export const refundSchema = z.object({ amount: amount({ positive: true }), reference: ref, refundedOn: day }).strict();
export const writeOffSchema = z.object({ amount: amount({ positive: true }), reason: z.string().trim().min(10).max(300) }).strict();
export const writeOffDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().min(5).max(300).optional() }).strict()
  .refine((v) => v.decision !== "REJECT" || !!v.note, { path: ["note"], message: "Say why it is refused" });
export const packageLinesQuerySchema = z.object({ invoiceId: uuid.optional() }).strict();
export const followUpDoneSchema = z.object({ note: z.string().trim().min(3).max(300) }).strict();
export const listSchema = z.object({ status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const rangeSchema = z.object({ from: day.optional(), to: day.optional(), slaDays: z.coerce.number().int().min(1).max(365).default(30) }).strict();
export const estimateSchema = z.object({
  patientId: uuid, packageId: uuid.optional(), days: z.number().int().min(0).max(120).default(0), roomRatePerDay: amount().optional(),
  lines: z.array(z.object({
    serviceId: uuid.optional(), description: z.string().trim().min(2).max(120).optional(), kind: z.enum(["SERVICE", "PROCEDURE", "MEDICINE", "BED", "DOCTOR_VISIT", "IMPLANT", "CONSUMABLE", "OTHER"]).default("SERVICE"),
    quantity: z.number().int().min(1).max(999).default(1), unitPrice: amount().optional(), taxPercent: percent.optional(), notCovered: z.boolean().default(false),
  }).strict().refine((l) => !!l.serviceId || (!!l.description && l.unitPrice !== undefined), { message: "Choose a service, or give a description and a price" })).max(60).default([]),
}).strict();

type ClaimRow = Prisma.ClaimGetPayload<object>;

/**
 * Insurance money (docs/insurance-money.md): what each insurer owes and has paid, matched payments, cuts and their reasons, write-offs a manager approves,
 * overpayments and their refunds, follow-ups for short payments, the three-way split of a bill, package inside/extra marking, the family's estimate, and the reports.
 * Money received is never edited; every record here is added to, not changed.
 */
@Injectable()
export class InsuranceMoneyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly claims: ClaimsService, private readonly idempotency: IdempotencyService) {}

  private async lockClaim(tx: Db, ctx: RequestContext, claimId: string): Promise<ClaimRow> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Claim" WHERE id = ${claimId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.claim.findFirstOrThrow({ where: { id: claimId, tenantId: ctx.tenantId } });
  }

  private async writtenOff(tx: Db | PrismaService, ctx: RequestContext, claimId: string): Promise<Decimal> {
    const r = await tx.claimWriteOff.aggregate({ where: { tenantId: ctx.tenantId, claimId, status: "APPROVED" }, _sum: { amount: true } });
    return D(r._sum.amount);
  }

  // ───── 10. what the insurer cut, and why ─────

  /** The insurance desk records one part of what the insurer cut from a claim (room-rent cuts are entered by hand). The parts cannot add up to more than the cut. */
  async recordCut(ctx: RequestContext, claimId: string, input: z.infer<typeof cutSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockClaim(tx, ctx, claimId);
      if (c.approvedAmount === null || c.claimedAmount === null) throw new DomainError("INVALID_STATE", "The insurer has not approved this claim yet, so there is no cut to explain", 409);
      const cut = Decimal.max(0, D(c.claimedAmount).minus(D(c.approvedAmount)));
      const so = await tx.claimDeduction.aggregate({ where: { tenantId: ctx.tenantId, claimId }, _sum: { amount: true } });
      const room = cut.minus(D(so._sum.amount));
      if (input.amount.gt(room)) throw new DomainError("VALIDATION_FAILED", `The insurer cut ${fmt(cut)} in all; only ${fmt(room)} is left to explain`, 400, [{ path: "amount", message: "More than the unexplained cut" }]);
      const r = await tx.claimDeduction.create({ data: { tenantId: ctx.tenantId, claimId, category: input.category, amount: input.amount.toFixed(2), note: input.note ?? null, recordedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_CUT_RECORDED", entityType: "Claim", entityId: claimId, metadata: { claimNumber: c.claimNumber, category: input.category, amount: fmt(input.amount) } });
      return { id: r.id, category: r.category, label: DEDUCTION_LABEL[r.category], amount: fmt(r.amount), unexplained: fmt(room.minus(input.amount)) };
    });
  }

  // ───── 11. the insurer's payments, matched to claims ─────

  /**
   * One payment from an insurer, matched to the claims it pays. Each line is posted like any receipt (on the invoice, in the same transaction); a line cannot
   * exceed what its claim is owed. Cash over a claim's balance, and cash matched to no claim, is recorded as an overpayment to be refunded. A line marked final
   * that leaves a claim short of its approved amount raises a follow-up. Nothing is ever edited afterwards.
   */
  async recordPayment(ctx: RequestContext, input: z.infer<typeof paymentSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for insurer payments", 400);
    if (new Set(input.lines.map((l) => l.claimId)).size !== input.lines.length) throw new DomainError("VALIDATION_FAILED", "A claim appears twice in this payment", 400, [{ path: "lines", message: "Repeated claim" }]);
    const matched = input.lines.reduce<Decimal>((a, l) => a.plus(l.amount), ZERO);
    if (matched.gt(input.amount)) throw new DomainError("VALIDATION_FAILED", "The lines add up to more than the payment", 400, [{ path: "lines", message: "More than the payment" }]);
    return this.idempotency.run(ctx.tenantId, "INSURER_PAYMENT", key, input, async (tx) => {
      const insurer = await tx.insurer.findFirst({ where: { id: input.insurerId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
      if (!insurer) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      // Lock the claims in a fixed order so two payments never wait on each other.
      const claims = new Map<string, ClaimRow>();
      for (const l of [...input.lines].sort((a, b) => a.claimId.localeCompare(b.claimId))) {
        const c = await this.lockClaim(tx, ctx, l.claimId);
        const pol = await tx.patientPolicy.findFirstOrThrow({ where: { id: c.policyId, tenantId: ctx.tenantId }, select: { insurerId: true } });
        if (pol.insurerId !== insurer.id) throw new DomainError("VALIDATION_FAILED", `Claim ${c.claimNumber} is not a claim on ${insurer.name}`, 400, [{ path: "lines", message: "Another insurer's claim" }]);
        if (c.status !== "APPROVED") throw new DomainError("INVALID_STATE", `Claim ${c.claimNumber} is not waiting for money (it is ${c.status.toLowerCase().replace(/_/g, " ")})`, 409);
        claims.set(c.id, c);
      }
      const owedOf = async (c: ClaimRow) => Decimal.max(0, D(c.approvedAmount).minus(D(c.settledAmount)).minus(await this.writtenOff(tx, ctx, c.id)));
      const planLines = [];
      for (const l of input.lines) {
        const c = claims.get(l.claimId)!;
        const owed = await owedOf(c);
        const tds = l.tdsAmount ?? ZERO;
        if (tds.gt(Decimal.max(0, owed.minus(Decimal.min(l.amount, owed))))) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `Claim ${c.claimNumber}: the cash and the tax deducted at source are more than the ${fmt(owed)} still owed`, 409, { owed: fmt(owed) });
        planLines.push({ claimId: l.claimId, amount: l.amount, tds, final: l.final, owed, approved: D(c.approvedAmount), received: D(c.settledAmount) });
      }
      const plan = planPayment(input.amount, planLines);
      let pay;
      try {
        pay = await tx.insurerPayment.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, insurerId: insurer.id, reference: input.reference, receivedOn: new Date(input.receivedOn), amount: input.amount.toFixed(2), createdById: ctx.userId } });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", `A payment with reference ${input.reference} from ${insurer.name} is already recorded`, 409);
        throw e;
      }
      const posted: { claimId: string; claimNumber: string; amount: string; tds: string; status: string; owedAfter: string }[] = [];
      for (const a of plan.applied) {
        const c = claims.get(a.claimId)!;
        const r = await this.claims.postSettlement(tx, ctx, c, { amount: a.amount, tdsAmount: a.tds, reference: input.reference, receivedOn: input.receivedOn }, pay.id);
        posted.push({ claimId: c.id, claimNumber: c.claimNumber, amount: fmt(a.amount), tds: fmt(a.tds), status: r.status, owedAfter: r.outstanding });
      }
      const followUps: { claimId: string; kind: string; amount: string }[] = [];
      for (const sf of plan.shortfalls) {
        const c = claims.get(sf.claimId)!;
        await tx.claimFollowUp.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, claimId: c.id, kind: "SHORT_PAYMENT", amount: sf.amount.toFixed(2), note: `${insurer.name} paid less than approved on payment ${input.reference}: ${fmt(sf.amount)} is still short. Ask for the balance, or write it off.` } });
        await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_FOLLOWUP_RAISED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, kind: "SHORT_PAYMENT", amount: fmt(sf.amount), paymentRef: input.reference } });
        followUps.push({ claimId: c.id, kind: "SHORT_PAYMENT", amount: fmt(sf.amount) });
      }
      let overpaymentId: string | null = null;
      if (plan.overpayment.gt(0)) {
        const only = plan.excess.length === 1 && plan.overpayment.eq(plan.excess[0]!.amount) ? plan.excess[0]!.claimId : null;
        const reason = plan.excess.length > 0 ? "Paid more than the claims were owed" : "Paid money that no claim of this insurer is owed";
        const o = await tx.insurerOverpayment.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, insurerId: insurer.id, paymentId: pay.id, claimId: only, amount: plan.overpayment.toFixed(2), reason, createdById: ctx.userId } });
        overpaymentId = o.id;
        await this.audit.record(tx, actorOf(ctx), { action: "INSURER_OVERPAYMENT_RECORDED", entityType: "InsurerOverpayment", entityId: o.id, metadata: { insurerId: insurer.id, amount: fmt(plan.overpayment), paymentRef: input.reference } });
        if (only) {
          await tx.claimFollowUp.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, claimId: only, kind: "OVERPAYMENT_REFUND", amount: plan.overpayment.toFixed(2), note: `${insurer.name} paid ${fmt(plan.overpayment)} more than this claim was owed (payment ${input.reference}). Refund it.` } });
          followUps.push({ claimId: only, kind: "OVERPAYMENT_REFUND", amount: fmt(plan.overpayment) });
        }
      }
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_PAYMENT_RECORDED", entityType: "InsurerPayment", entityId: pay.id, metadata: { insurerId: insurer.id, reference: input.reference, amount: fmt(input.amount), claims: posted.length, overpayment: fmt(plan.overpayment) } });
      return { id: pay.id, insurer: insurer.name, reference: input.reference, amount: fmt(input.amount), posted, overpayment: fmt(plan.overpayment), overpaymentId, followUps };
    });
  }

  async payments(ctx: RequestContext, q: z.infer<typeof listSchema> & { insurerId?: string }) {
    const where: Prisma.InsurerPaymentWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.insurerId ? { insurerId: q.insurerId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.insurerPayment.findMany({ where, orderBy: [{ receivedOn: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { insurer: { select: { name: true } }, lines: { select: { amount: true, tdsAmount: true, claim: { select: { claimNumber: true } } } }, overpayments: { select: { amount: true, refunds: { select: { amount: true } } } } } }),
      this.prisma.insurerPayment.count({ where }),
    ]);
    return { items: rows.map((p) => ({ id: p.id, insurer: p.insurer.name, reference: p.reference, receivedOn: p.receivedOn.toISOString().slice(0, 10), amount: fmt(p.amount), claims: p.lines.map((l) => ({ claimNumber: l.claim.claimNumber, amount: fmt(l.amount), tds: fmt(l.tdsAmount) })), overpaid: fmt(p.overpayments.reduce((a, o) => a.plus(o.amount.toString()), ZERO)) })), total };
  }

  // ───── overpayments and refunds ─────

  async overpayments(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const rows = await this.prisma.insurerOverpayment.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 200, include: { payment: { select: { reference: true, receivedOn: true } }, refunds: { orderBy: { createdAt: "asc" } } } });
    const names = new Map((await this.prisma.insurer.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.insurerId))] } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
    const items = rows.map((o) => {
      const refunded = o.refunds.reduce((a, r) => a.plus(r.amount.toString()), ZERO);
      return { id: o.id, insurer: names.get(o.insurerId) ?? "", paymentReference: o.payment.reference, receivedOn: o.payment.receivedOn.toISOString().slice(0, 10), amount: fmt(o.amount), refunded: fmt(refunded), refundDue: fmt(D(o.amount).minus(refunded)), status: refunded.gte(D(o.amount)) ? "REFUNDED" : refunded.gt(0) ? "PART_REFUNDED" : "OPEN", reason: o.reason, refunds: o.refunds.map((r) => ({ amount: fmt(r.amount), reference: r.reference, refundedOn: r.refundedOn.toISOString().slice(0, 10) })) };
    });
    const want = q.status?.toUpperCase();
    return { items: want ? items.filter((i) => i.status === want || (want === "OPEN" && i.status === "PART_REFUNDED")) : items };
  }

  /** Tracks the refund of an insurer's overpayment. Each refund is a new record; the overpayment itself is never edited. */
  async refund(ctx: RequestContext, overpaymentId: string, input: z.infer<typeof refundSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for refunds", 400);
    return this.idempotency.run(ctx.tenantId, `INSURER_REFUND:${overpaymentId}`, key, input, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "InsurerOverpayment" WHERE id = ${overpaymentId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const o = await tx.insurerOverpayment.findFirstOrThrow({ where: { id: overpaymentId, tenantId: ctx.tenantId }, include: { refunds: { select: { amount: true } } } });
      const due = D(o.amount).minus(o.refunds.reduce((a, r) => a.plus(r.amount.toString()), ZERO));
      if (input.amount.gt(due)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `Only ${fmt(due)} of this overpayment is still to be refunded`, 409, { refundDue: fmt(due) });
      const r = await tx.insurerRefund.create({ data: { tenantId: ctx.tenantId, overpaymentId, amount: input.amount.toFixed(2), reference: input.reference, refundedOn: new Date(input.refundedOn), createdById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_REFUND_RECORDED", entityType: "InsurerOverpayment", entityId: overpaymentId, metadata: { amount: fmt(input.amount), reference: input.reference, refundDue: fmt(due.minus(input.amount)) } });
      return { id: r.id, amount: fmt(r.amount), refundDue: fmt(due.minus(input.amount)), status: due.minus(input.amount).lte(0) ? "REFUNDED" : "PART_REFUNDED" };
    });
  }

  // ───── write-offs: a manager approves ─────

  async requestWriteOff(ctx: RequestContext, claimId: string, input: z.infer<typeof writeOffSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockClaim(tx, ctx, claimId);
      if (c.status !== "APPROVED") throw new DomainError("INVALID_STATE", "Only what an insurer still owes on an approved claim can be written off", 409);
      const owed = D(c.approvedAmount).minus(D(c.settledAmount)).minus(await this.writtenOff(tx, ctx, claimId));
      if (input.amount.gt(owed)) throw new DomainError("VALIDATION_FAILED", `The insurer owes ${fmt(owed)}; that is the most that can be written off`, 400, [{ path: "amount", message: "More than is owed" }]);
      try {
        const w = await tx.claimWriteOff.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, claimId, amount: input.amount.toFixed(2), reason: input.reason, requestedById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_WRITEOFF_REQUESTED", entityType: "Claim", entityId: claimId, metadata: { claimNumber: c.claimNumber, writeOffId: w.id, amount: fmt(input.amount), reason: input.reason } });
        return { id: w.id, status: w.status, amount: fmt(w.amount) };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "A write-off for this claim is already waiting for a manager", 409);
        throw e;
      }
    });
  }

  /** A manager (never the person who asked) approves or refuses a write-off. Approving it takes it off what is owed, and closes the claim when nothing is left. */
  async decideWriteOff(ctx: RequestContext, writeOffId: string, input: z.infer<typeof writeOffDecisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const w0 = await tx.claimWriteOff.findFirst({ where: { id: writeOffId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!w0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const c = await this.lockClaim(tx, ctx, w0.claimId);
      const w = await tx.claimWriteOff.findFirstOrThrow({ where: { id: writeOffId, tenantId: ctx.tenantId } });
      if (w.status !== "PENDING") throw new DomainError("INVALID_STATE", "This write-off has already been decided", 409);
      if (w.requestedById === ctx.userId) throw new DomainError("FORBIDDEN", "A write-off must be approved by someone other than the person who asked for it", 403);
      const now = new Date();
      if (input.decision === "REJECT") {
        await tx.claimWriteOff.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: w.id } }, data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: now, decisionNote: input.note ?? null } });
        await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_WRITEOFF_REFUSED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, writeOffId: w.id, amount: fmt(w.amount) } });
        return { id: w.id, status: "REJECTED" as const, claimStatus: c.status };
      }
      const owed = D(c.approvedAmount).minus(D(c.settledAmount)).minus(await this.writtenOff(tx, ctx, c.id));
      if (c.status !== "APPROVED" || D(w.amount).gt(owed)) throw new DomainError("INVALID_STATE", `The claim now owes only ${fmt(Decimal.max(0, owed))}, so this write-off can no longer be approved`, 409);
      await tx.claimWriteOff.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: w.id } }, data: { status: "APPROVED", decidedById: ctx.userId, decidedAt: now, decisionNote: input.note ?? null } });
      const left = owed.minus(D(w.amount));
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_WRITEOFF_APPROVED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, writeOffId: w.id, amount: fmt(w.amount), stillOwed: fmt(left), reason: w.reason } });
      let claimStatus: string = c.status;
      if (left.lte(0)) {
        await this.claims.closeWrittenOff(tx, ctx, c.id, `Balance of ${fmt(w.amount)} written off: ${w.reason}`);
        claimStatus = "CLOSED";
        // The shortfall the desk was chasing is settled by the write-off.
        await tx.$executeRaw`UPDATE "ClaimFollowUp" SET status = 'DONE'::"FollowUpStatus", "doneById" = ${ctx.userId}::uuid, "doneAt" = now(), "doneNote" = 'Written off with a manager''s approval' WHERE "claimId" = ${c.id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND status = 'OPEN' AND kind = 'SHORT_PAYMENT'`;
      }
      return { id: w.id, status: "APPROVED" as const, claimStatus, stillOwed: fmt(Decimal.max(0, left)) };
    });
  }

  async writeOffs(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const status = ["PENDING", "APPROVED", "REJECTED"].includes((q.status ?? "").toUpperCase()) ? (q.status!.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED") : undefined;
    const rows = await this.prisma.claimWriteOff.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(status ? { status } : {}) }, orderBy: [{ requestedAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { claim: { select: { claimNumber: true, policy: { select: { insurer: { select: { name: true } } } } } } } });
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is string => !!x)))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return { items: rows.map((w) => ({ id: w.id, claimId: w.claimId, claimNumber: w.claim.claimNumber, insurer: w.claim.policy.insurer.name, amount: fmt(w.amount), reason: w.reason, status: w.status, requestedBy: users.get(w.requestedById) ?? null, requestedAt: w.requestedAt, decidedBy: w.decidedById ? users.get(w.decidedById) ?? null : null, decidedAt: w.decidedAt, decisionNote: w.decisionNote })) };
  }

  // ───── follow-up tasks ─────

  async followUps(ctx: RequestContext, q: z.infer<typeof listSchema>) {
    const status = (q.status ?? "OPEN").toUpperCase() === "DONE" ? "DONE" : "OPEN";
    const rows = await this.prisma.claimFollowUp.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { claim: { select: { claimNumber: true, policy: { select: { insurer: { select: { name: true } } } } } } } });
    return { items: rows.map((f) => ({ id: f.id, claimId: f.claimId, claimNumber: f.claim.claimNumber, insurer: f.claim.policy.insurer.name, kind: f.kind, amount: fmt(f.amount), note: f.note, status: f.status, createdAt: f.createdAt, doneAt: f.doneAt, doneNote: f.doneNote })) };
  }

  async completeFollowUp(ctx: RequestContext, id: string, input: z.infer<typeof followUpDoneSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.claimFollowUp.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!f) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const done = await tx.claimFollowUp.updateMany({ where: { id, tenantId: ctx.tenantId, status: "OPEN" }, data: { status: "DONE", doneById: ctx.userId, doneAt: new Date(), doneNote: input.note } });
      if (done.count !== 1) throw new DomainError("INVALID_STATE", "This follow-up is already done", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_FOLLOWUP_DONE", entityType: "Claim", entityId: f.claimId, metadata: { followUpId: id, kind: f.kind } });
      return { id, status: "DONE" as const };
    });
  }

  // ───── the running ledger ─────

  private fmtLedger(l: Ledger) {
    return {
      claimed: fmt(l.claimed), approved: l.approved === null ? null : fmt(l.approved), cut: fmt(l.cut), cutExplained: fmt(l.cutExplained), cutUnexplained: fmt(l.cutUnexplained),
      received: fmt(l.received), receivedCash: fmt(l.receivedCash), tds: fmt(l.tds), writtenOff: fmt(l.writtenOff), owed: fmt(l.owed), awaitingDecision: fmt(l.awaitingDecision),
      overpaid: fmt(l.overpaid), refunded: fmt(l.refunded), refundDue: fmt(l.refundDue),
    };
  }

  private async ledgersFor(ctx: RequestContext, claimIds: string[]) {
    const where = { tenantId: ctx.tenantId, claimId: { in: claimIds } };
    const [cash, cuts, offs] = await Promise.all([
      this.prisma.claimSettlement.groupBy({ by: ["claimId"], where, _sum: { amount: true, tdsAmount: true } }),
      this.prisma.claimDeduction.groupBy({ by: ["claimId"], where, _sum: { amount: true } }),
      this.prisma.claimWriteOff.groupBy({ by: ["claimId"], where: { ...where, status: "APPROVED" }, _sum: { amount: true } }),
    ]);
    return { cash: new Map(cash.map((r) => [r.claimId, r._sum])), cuts: new Map(cuts.map((r) => [r.claimId, r._sum.amount])), offs: new Map(offs.map((r) => [r.claimId, r._sum.amount])) };
  }

  /** One claim's running record: claimed, approved, received, cut (with the reasons), written off and still owed, with every receipt, cut and write-off behind it. */
  async claimLedger(ctx: RequestContext, claimId: string) {
    const c = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { settlements: { orderBy: { createdAt: "asc" } }, deductions: { orderBy: { recordedAt: "asc" } }, writeOffs: { orderBy: { requestedAt: "asc" } }, followUps: { orderBy: { createdAt: "asc" } }, policy: { select: { insurer: { select: { id: true, name: true } } } } } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const overs = await this.prisma.insurerOverpayment.findMany({ where: { tenantId: ctx.tenantId, claimId }, include: { refunds: { select: { amount: true } } } });
    const l = ledgerOf({
      status: c.status, claimed: c.claimedAmount, approved: c.approvedAmount, cash: c.settlements.reduce((a, s) => a.plus(s.amount.toString()), ZERO), tds: c.settlements.reduce((a, s) => a.plus(s.tdsAmount.toString()), ZERO),
      explainedCuts: c.deductions.map((x) => x.amount), writtenOff: c.writeOffs.filter((w) => w.status === "APPROVED").map((w) => w.amount), overpaid: overs.map((o) => o.amount), refunded: overs.flatMap((o) => o.refunds.map((r) => r.amount)),
    });
    return {
      claimId: c.id, claimNumber: c.claimNumber, status: c.status, tier: c.tier, insurer: c.policy.insurer.name, ...this.fmtLedger(l),
      cuts: c.deductions.map((x) => ({ id: x.id, category: x.category, label: DEDUCTION_LABEL[x.category], amount: fmt(x.amount), note: x.note, at: x.recordedAt })),
      receipts: c.settlements.map((s) => ({ id: s.id, amount: fmt(s.amount), tds: fmt(s.tdsAmount), reference: s.reference, receivedOn: s.receivedOn.toISOString().slice(0, 10), paymentId: s.paymentId })),
      writeOffs: c.writeOffs.map((w) => ({ id: w.id, amount: fmt(w.amount), reason: w.reason, status: w.status, requestedAt: w.requestedAt, decidedAt: w.decidedAt, decisionNote: w.decisionNote })),
      followUps: c.followUps.map((f) => ({ id: f.id, kind: f.kind, amount: fmt(f.amount), status: f.status, note: f.note })),
    };
  }

  /** Every insurer's running record: what it has been asked for, approved, paid, cut, written off, and still owes. */
  async insurerLedgers(ctx: RequestContext, onlyInsurerId?: string) {
    const claims = await this.prisma.claim.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, claimedAmount: { not: null }, status: { notIn: ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED"] }, ...(onlyInsurerId ? { policy: { insurerId: onlyInsurerId } } : {}) },
      select: { id: true, status: true, claimedAmount: true, approvedAmount: true, policy: { select: { insurer: { select: { id: true, name: true } } } } }, orderBy: { id: "asc" }, take: 5000,
    });
    const led = claims.length ? await this.ledgersFor(ctx, claims.map((c) => c.id)) : { cash: new Map(), cuts: new Map(), offs: new Map() };
    const overs = await this.prisma.insurerOverpayment.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(onlyInsurerId ? { insurerId: onlyInsurerId } : {}) }, include: { refunds: { select: { amount: true } } } });
    const by = new Map<string, { insurerId: string; insurer: string; ledgers: Ledger[] }>();
    for (const c of claims) {
      const s = led.cash.get(c.id); const ins = c.policy.insurer;
      const l = ledgerOf({ status: c.status, claimed: c.claimedAmount, approved: c.approvedAmount, cash: s?.amount ?? 0, tds: s?.tdsAmount ?? 0, explainedCuts: [led.cuts.get(c.id) ?? 0], writtenOff: [led.offs.get(c.id) ?? 0] });
      const e = by.get(ins.id) ?? { insurerId: ins.id, insurer: ins.name, ledgers: [] };
      e.ledgers.push(l); by.set(ins.id, e);
    }
    for (const o of overs) if (!by.has(o.insurerId)) by.set(o.insurerId, { insurerId: o.insurerId, insurer: "", ledgers: [] });
    const names = new Map((await this.prisma.insurer.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...by.keys()] } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
    const rows = [...by.values()].map((e) => {
      const mine = overs.filter((o) => o.insurerId === e.insurerId);
      const over = ledgerOf({ status: "", claimed: 0, approved: null, cash: 0, tds: 0, explainedCuts: [], writtenOff: [], overpaid: mine.map((o) => o.amount), refunded: mine.flatMap((o) => o.refunds.map((r) => r.amount)) });
      const t = addLedgers([...e.ledgers, over]);
      return { insurerId: e.insurerId, insurer: names.get(e.insurerId) ?? e.insurer, claims: e.ledgers.length, ...this.fmtLedger(t) };
    }).sort((a, b) => a.insurer.localeCompare(b.insurer));
    return rows;
  }

  /** One insurer's running record. Another hospital's insurer, or one that does not exist, is "not found". */
  async insurerLedger(ctx: RequestContext, insurerId: string) {
    const ins = await this.prisma.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
    if (!ins) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.insurerLedgers(ctx, insurerId);
    return rows[0] ?? { insurerId: ins.id, insurer: ins.name, claims: 0, ...this.fmtLedger(addLedgers([])) };
  }

  // ───── 8. the bill split three ways ─────

  /** The bill split between the main insurer, the top-up insurer and the patient. The three add up to the bill. */
  async split(ctx: RequestContext, claimId: string) {
    const c = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, tier: true, primaryClaimId: true } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const mainId = c.tier === "TOPUP" ? c.primaryClaimId! : c.id;
    const sel = { id: true, claimNumber: true, status: true, claimedAmount: true, approvedAmount: true, settledAmount: true, invoiceId: true, policy: { select: { insurer: { select: { name: true } } } } } as const;
    const main = await this.prisma.claim.findFirstOrThrow({ where: { id: mainId, tenantId: ctx.tenantId }, select: sel });
    const top = await this.prisma.claim.findFirst({ where: { tenantId: ctx.tenantId, primaryClaimId: mainId, tier: "TOPUP", status: { notIn: ["REJECTED", "CLOSED"] } }, select: sel });
    if (!main.invoiceId) throw new DomainError("INVALID_STATE", "The claim has no invoice yet, so there is nothing to split", 409);
    const inv = await this.prisma.invoice.findFirstOrThrow({ where: { id: main.invoiceId, tenantId: ctx.tenantId }, select: { invoiceNumber: true, total: true, creditedTotal: true } });
    const total = D(inv.total).minus(D(inv.creditedTotal));
    const pays = (x: { approvedAmount: Prisma.Decimal | null; claimedAmount: Prisma.Decimal | null; status: string }) => (x.status === "REJECTED" || x.status === "CLOSED" ? ZERO : D(x.approvedAmount ?? x.claimedAmount));
    const s = splitBill(total, pays(main), top ? pays(top) : ZERO);
    const side = (x: typeof main) => ({ claimId: x.id, claimNumber: x.claimNumber, insurer: x.policy.insurer.name, status: x.status, basis: x.approvedAmount ? "APPROVED" : "CLAIMED", received: fmt(x.settledAmount) });
    return { invoiceNumber: inv.invoiceNumber, total: fmt(total), primary: { ...side(main), pays: fmt(s.primary) }, topup: top ? { ...side(top), pays: fmt(s.topup) } : null, patient: { pays: fmt(s.patient) }, addsUp: s.primary.plus(s.topup).plus(s.patient).eq(total) };
  }

  // ───── 5. inside the package, or extra ─────

  /** Each charge on the claim's invoices, marked inside the package price or extra. Implants and consumables are inside unless the package says otherwise. */
  async packageLines(ctx: RequestContext, claimId: string, previewInvoiceId?: string) {
    const c = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, packageId: true, packageName: true, packagePrice: true, invoiceId: true, extraInvoices: { select: { invoiceId: true } } } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (!c.packageId) throw new DomainError("INVALID_STATE", "This claim is not under a package", 409);
    // Before the claim is submitted it has no invoice yet: the officer can preview any issued invoice of the patient.
    const mainInvoiceId = c.invoiceId ?? previewInvoiceId;
    if (!mainInvoiceId) throw new DomainError("INVALID_STATE", "Choose the invoice to check: the claim has not been submitted yet", 409);
    const pkg = await this.prisma.insurerPackage.findFirstOrThrow({ where: { id: c.packageId, tenantId: ctx.tenantId } });
    const ids = c.invoiceId ? [c.invoiceId, ...c.extraInvoices.map((x) => x.invoiceId)] : [mainInvoiceId];
    const own = await this.prisma.invoice.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: ids }, patientId: (await this.prisma.claim.findFirstOrThrow({ where: { id: claimId, tenantId: ctx.tenantId }, select: { patientId: true } })).patientId } });
    if (own !== ids.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const lines = await this.prisma.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, invoiceId: { in: ids } }, orderBy: [{ invoiceId: "asc" }, { id: "asc" }], select: { id: true, description: true, quantity: true, lineTotal: true, sourceType: true, sourceId: true } });
    const chargeIds = lines.filter((l) => l.sourceType === "CHARGE" && l.sourceId).map((l) => l.sourceId!);
    const [charges, items] = chargeIds.length ? await Promise.all([
      this.prisma.charge.findMany({ where: { tenantId: ctx.tenantId, id: { in: chargeIds } }, select: { id: true, type: true } }),
      this.prisma.procedureItem.findMany({ where: { tenantId: ctx.tenantId, chargeId: { in: chargeIds } }, select: { chargeId: true, kind: true } }),
    ]) : [[], []];
    const typeOf = new Map(charges.map((x) => [x.id, x.type as string]));
    const itemKind = new Map(items.map((x) => [x.chargeId, x.kind as string]));
    const terms = { includesImplants: pkg.includesImplants, includesConsumables: pkg.includesConsumables, exclusions: pkg.exclusions, inclusions: pkg.inclusions };
    const marked = lines.map((l) => {
      const kind = (l.sourceId && itemKind.get(l.sourceId)) || (l.sourceId && typeOf.get(l.sourceId)) || "OTHER";
      const m = packageScope({ kind: kind as LineKind, description: l.description }, terms);
      return { id: l.id, description: l.description, kind, amount: fmt(l.lineTotal), scope: m.scope, why: m.why };
    });
    const extra = marked.filter((m) => m.scope === "EXTRA").reduce((a, m) => a.plus(m.amount), ZERO);
    return { package: { name: c.packageName, price: money(c.packagePrice), includesImplants: pkg.includesImplants, includesConsumables: pkg.includesConsumables, exclusionNote: pkg.exclusionNote }, lines: marked, extraTotal: fmt(extra) };
  }

  // ───── 7. the family's estimate ─────

  async estimate(ctx: RequestContext, input: z.infer<typeof estimateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId }, select: { id: true } });
      if (!patient) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const today = new Date(localDateStr(new Date(), (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone));
      const policies = await tx.patientPolicy.findMany({ where: { tenantId: ctx.tenantId, patientId: input.patientId, status: "ACTIVE", validFrom: { lte: today }, validTo: { gte: today } }, orderBy: [{ validTo: "desc" }, { id: "asc" }], include: { insurer: { select: { id: true, name: true } } } });
      const main = policies.find((p) => p.tier === "PRIMARY") ?? null;
      const top = main ? policies.find((p) => p.tier === "TOPUP" && p.insurerId !== main.insurerId) ?? null : null;
      const ruleOf = (p: NonNullable<typeof main>): PolicyRule & { roomRentLimit: Decimal | null } => ({ tier: p.tier, copayPercent: p.copayPercent === null ? null : D(p.copayPercent), deductible: D(p.deductible), deductibleUsed: D(p.deductibleUsed), sumInsured: p.sumInsured === null ? null : D(p.sumInsured), roomRentLimit: p.roomRentLimit === null ? null : D(p.roomRentLimit) });
      let pkg = null;
      if (input.packageId) {
        if (!main) throw new DomainError("VALIDATION_FAILED", "A package needs a valid main policy", 400, [{ path: "packageId", message: "No valid main policy" }]);
        pkg = await tx.insurerPackage.findFirst({ where: { id: input.packageId, tenantId: ctx.tenantId, insurerId: main.insurerId, status: "ACTIVE" } });
        if (!pkg) throw new DomainError("VALIDATION_FAILED", "That package is not one of the main insurer's active packages", 400, [{ path: "packageId", message: "Not this insurer's package" }]);
      }
      const svcIds = [...new Set(input.lines.flatMap((l) => (l.serviceId ? [l.serviceId] : [])))];
      const services = new Map((svcIds.length ? await tx.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: svcIds } } }) : []).map((s) => [s.id, s]));
      const rates = main && svcIds.length ? new Map((await tx.insurerRate.findMany({ where: { tenantId: ctx.tenantId, insurerId: main.insurerId, serviceId: { in: svcIds }, status: "ACTIVE" } })).map((r) => [r.serviceId, D(r.price)])) : new Map<string, Decimal>();
      const lines = input.lines.map((l) => {
        const svc = l.serviceId ? services.get(l.serviceId) : undefined;
        if (l.serviceId && !svc) throw new DomainError("VALIDATION_FAILED", "A chosen service does not exist", 400, [{ path: "lines", message: "Unknown service" }]);
        const unit = l.unitPrice ?? D(svc!.price); const taxPct = l.taxPercent ?? (svc ? D(svc.taxPercent) : ZERO);
        const a = computeLine({ quantity: String(l.quantity), unitPrice: unit.toFixed(2), discountAmount: 0, taxPercent: taxPct.toString() });
        const rate = svc ? rates.get(svc.id) : undefined;
        const overRate = rate && unit.gt(rate) ? unit.minus(rate).times(l.quantity) : undefined;
        return { description: l.description ?? svc!.name, kind: l.kind as LineKind, amount: D(a.total), notCovered: l.notCovered, ...(overRate ? { overRate } : {}) };
      });
      const e = estimateOf({ lines, days: input.days, roomRatePerDay: input.roomRatePerDay ?? ZERO, primary: main ? ruleOf(main) : null, topup: top ? ruleOf(top) : null, packagePrice: pkg ? D(pkg.price) : null, pkg: pkg ? { includesImplants: pkg.includesImplants, includesConsumables: pkg.includesConsumables, exclusions: pkg.exclusions, inclusions: pkg.inclusions } : null });
      const view = {
        total: fmt(e.total), roomTotal: fmt(e.roomTotal), roomRentExcess: fmt(e.roomRentExcess), notCovered: fmt(e.notCovered), aboveInsurerRate: fmt(e.overRate), packageExtras: fmt(e.packageExtras),
        mainInsurer: main && e.primary ? { insurer: main.insurer.name, policyNumber: main.policyNumber, pays: fmt(e.primary.pays), copay: fmt(e.primary.copay), deductible: fmt(e.primary.deductible), capped: e.primary.capped, roomEntitlement: main.roomEntitlement } : null,
        topupInsurer: top && e.topup ? { insurer: top.insurer.name, policyNumber: top.policyNumber, pays: fmt(e.topup.pays), capped: e.topup.capped } : null,
        family: { pays: fmt(e.split.patient) },
        addsUp: e.split.primary.plus(e.split.topup).plus(e.split.patient).eq(e.total),
        package: pkg ? { name: pkg.name, price: fmt(pkg.price), includesImplants: pkg.includesImplants, includesConsumables: pkg.includesConsumables, exclusionNote: pkg.exclusionNote } : null,
        lines: e.lines.map((l) => ({ description: l.description, amount: fmt(l.amount), scope: l.scope, why: l.why, notCovered: l.notCovered })), notes: e.notes,
      };
      const row = await tx.claimEstimate.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, packageId: pkg?.id ?? null, days: input.days, total: e.total.toFixed(2), input: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue, result: view as unknown as Prisma.InputJsonValue, createdById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_ESTIMATE_GIVEN", entityType: "ClaimEstimate", entityId: row.id, metadata: { patientId: input.patientId, total: fmt(e.total), family: fmt(e.split.patient) } });
      return { id: row.id, createdAt: row.createdAt, ...view };
    });
  }

  async estimateById(ctx: RequestContext, id: string) {
    const r = await this.prisma.claimEstimate.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { id: r.id, createdAt: r.createdAt, ...(r.result as Record<string, unknown>) };
  }

  // ───── 12. reports ─────

  private async range(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const tz = (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
    const to = q.to ?? localDateStr(new Date(), tz);
    const from = q.from ?? localDateStr(new Date(Date.now() - 89 * 86_400_000), tz);
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date must not be after the end date", 400);
    if ((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > 366) throw new DomainError("VALIDATION_FAILED", "Choose a range of at most a year", 400);
    return { from, to, start: new Date(`${from}T00:00:00Z`), end: new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) };
  }

  private async firstEventAt(ctx: RequestContext, claimIds: string[], toStatus: "SUBMITTED" | "APPROVED" | "REJECTED") {
    const ev = claimIds.length ? await this.prisma.claimEvent.groupBy({ by: ["claimId"], where: { tenantId: ctx.tenantId, claimId: { in: claimIds }, toStatus }, _min: { at: true } }) : [];
    return new Map(ev.map((e) => [e.claimId, e._min.at]));
  }

  /** Which claims are old: still waiting for the insurer's decision, or approved and not fully paid, by how long ago they were sent. */
  async ageing(ctx: RequestContext, now = new Date()) {
    const claims = await this.prisma.claim.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["SUBMITTED", "QUERY", "APPROVED"] } }, select: { id: true, claimNumber: true, status: true, claimedAmount: true, approvedAmount: true, settledAmount: true, policy: { select: { insurer: { select: { id: true, name: true } } } } }, orderBy: { id: "asc" }, take: 5000 });
    const sent = await this.firstEventAt(ctx, claims.map((c) => c.id), "SUBMITTED");
    const offs = claims.length ? (await this.ledgersFor(ctx, claims.map((c) => c.id))).offs : new Map();
    const open = claims.map((c) => {
      const owed = c.approvedAmount === null ? D(c.claimedAmount) : Decimal.max(0, D(c.approvedAmount).minus(D(c.settledAmount)).minus(D(offs.get(c.id))));
      const at = sent.get(c.id) ?? null;
      return { c, owed, days: at ? daysBetween(at, now) : 0, sentAt: at };
    }).filter((x) => x.owed.gt(0));
    const by = new Map<string, { insurerId: string; insurer: string; buckets: Record<string, { claims: number; amount: Decimal }> }>();
    for (const x of open) {
      const ins = x.c.policy.insurer;
      const e = by.get(ins.id) ?? { insurerId: ins.id, insurer: ins.name, buckets: Object.fromEntries(AGE_BUCKETS.map((b) => [b, { claims: 0, amount: ZERO }])) };
      const b = e.buckets[ageBucket(x.days)]!; b.claims += 1; b.amount = b.amount.plus(x.owed); by.set(ins.id, e);
    }
    return {
      asOf: now,
      insurers: [...by.values()].map((e) => ({ insurerId: e.insurerId, insurer: e.insurer, buckets: AGE_BUCKETS.map((b) => ({ bucket: b, claims: e.buckets[b]!.claims, amount: fmt(e.buckets[b]!.amount) })) })).sort((a, b) => a.insurer.localeCompare(b.insurer)),
      oldest: open.sort((a, b) => b.days - a.days || a.c.claimNumber.localeCompare(b.c.claimNumber)).slice(0, 50).map((x) => ({ claimId: x.c.id, claimNumber: x.c.claimNumber, insurer: x.c.policy.insurer.name, status: x.c.status, amount: fmt(x.owed), days: x.days, bucket: ageBucket(x.days) })),
    };
  }

  /** Why claims get rejected, and what insurers cut and why. */
  async rejections(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const events = await this.prisma.claimEvent.findMany({ where: { tenantId: ctx.tenantId, toStatus: "REJECTED", at: { gte: r.start, lt: r.end }, claim: { facilityId: ctx.facilityId } }, select: { claimId: true, note: true, claim: { select: { claimedAmount: true, closeReason: true, policy: { select: { insurer: { select: { name: true } } } } } } } });
    const byReason = new Map<string, { reason: string; claims: number; amount: Decimal; insurers: Set<string> }>();
    for (const e of events) {
      const text = (e.note ?? e.claim.closeReason ?? "No reason recorded").trim();
      const k = text.toLowerCase();
      const g = byReason.get(k) ?? { reason: text, claims: 0, amount: ZERO, insurers: new Set<string>() };
      g.claims += 1; g.amount = g.amount.plus(D(e.claim.claimedAmount)); g.insurers.add(e.claim.policy.insurer.name); byReason.set(k, g);
    }
    const cuts = await this.prisma.claimDeduction.groupBy({ by: ["category"], where: { tenantId: ctx.tenantId, recordedAt: { gte: r.start, lt: r.end }, claim: { facilityId: ctx.facilityId } }, _sum: { amount: true }, _count: { _all: true } });
    return {
      from: r.from, to: r.to, rejected: events.length,
      reasons: [...byReason.values()].map((g) => ({ reason: g.reason, claims: g.claims, amount: fmt(g.amount), insurers: [...g.insurers].sort() })).sort((a, b) => b.claims - a.claims || a.reason.localeCompare(b.reason)),
      cuts: cuts.map((c) => ({ category: c.category, label: DEDUCTION_LABEL[c.category], count: c._count._all, amount: fmt(D(c._sum.amount)) })).sort((a, b) => D(b.amount).comparedTo(D(a.amount))),
    };
  }

  /** Which insurers pay late: days from approval to the money arriving, and what is overdue now. */
  async latePayers(ctx: RequestContext, q: z.infer<typeof rangeSchema>, now = new Date()) {
    const r = await this.range(ctx, q);
    const claims = await this.prisma.claim.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, approvedAmount: { not: null }, status: { in: ["APPROVED", "SETTLED", "CLOSED"] } }, select: { id: true, status: true, approvedAmount: true, settledAmount: true, policy: { select: { insurer: { select: { id: true, name: true } } } }, settlements: { select: { receivedOn: true }, orderBy: { receivedOn: "asc" } } }, orderBy: { id: "asc" }, take: 5000 });
    const approvedAt = await this.firstEventAt(ctx, claims.map((c) => c.id), "APPROVED");
    const offs = claims.length ? (await this.ledgersFor(ctx, claims.map((c) => c.id))).offs : new Map();
    const by = new Map<string, { insurerId: string; insurer: string; paid: number[]; overdue: number; overdueAmount: Decimal; open: number }>();
    for (const c of claims) {
      const at = approvedAt.get(c.id); if (!at) continue;
      const ins = c.policy.insurer;
      const e = by.get(ins.id) ?? { insurerId: ins.id, insurer: ins.name, paid: [], overdue: 0, overdueAmount: ZERO, open: 0 };
      if (c.status === "SETTLED" && c.settlements.length && at >= r.start && at < r.end) e.paid.push(daysBetween(at, c.settlements[c.settlements.length - 1]!.receivedOn));
      if (c.status === "APPROVED") {
        const owed = Decimal.max(0, D(c.approvedAmount).minus(D(c.settledAmount)).minus(D(offs.get(c.id))));
        if (owed.gt(0)) { e.open += 1; if (daysBetween(at, now) > q.slaDays) { e.overdue += 1; e.overdueAmount = e.overdueAmount.plus(owed); } }
      }
      by.set(ins.id, e);
    }
    return {
      from: r.from, to: r.to, slaDays: q.slaDays,
      insurers: [...by.values()].map((e) => ({ insurerId: e.insurerId, insurer: e.insurer, paidClaims: e.paid.length, averageDaysToPay: e.paid.length ? Math.round(e.paid.reduce((a, b) => a + b, 0) / e.paid.length) : null, slowestDays: e.paid.length ? Math.max(...e.paid) : null, openClaims: e.open, overdueClaims: e.overdue, overdueAmount: fmt(e.overdueAmount) }))
        .sort((a, b) => (b.averageDaysToPay ?? -1) - (a.averageDaysToPay ?? -1) || a.insurer.localeCompare(b.insurer)),
    };
  }
}
