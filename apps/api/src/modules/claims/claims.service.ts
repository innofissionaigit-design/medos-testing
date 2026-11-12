import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { balanceDue, fmt } from "../billing/billing.domain";
import { LedgerService } from "../billing/ledger.service";
import { amount, percent } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { calculateCopay, type CopayRule, FINISHED, hasCopayRule, nextStatus, stepAllowedForType, stepsFrom, type ClaimStatus, type ClaimStep } from "./claims.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const note = z.string().trim().min(3).max(500);
const reason = z.string().trim().min(5).max(300);

export const insurerSchema = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(["INSURER", "TPA", "GOVERNMENT", "CORPORATE"]).default("INSURER"), contact: z.string().trim().max(200).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict();
export const policySchema = z.object({
  insurerId: uuid, policyNumber: z.string().trim().min(3).max(60), memberId: z.string().trim().max(60).optional(), holderName: z.string().trim().max(120).optional(),
  validFrom: day, validTo: day, sumInsured: amount().optional(),
  copayPercent: percent.optional(), deductible: amount().optional(), deductibleUsed: amount().optional(),
}).strict();
export const policyStatusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).strict();
/** Sets a policy's co-pay rule. `copayPercent: null` with no deductible removes the rule. */
export const policyCopaySchema = z.object({ copayPercent: percent.nullable(), deductible: amount(), deductibleUsed: amount() }).strict();
export const copayPreviewSchema = z.object({ invoiceId: uuid, extraInvoiceIds: z.array(uuid).max(10).optional() }).strict();
const overrideReason = z.string().trim().min(10).max(300);
export const createClaimSchema = z.object({ patientId: uuid, policyId: uuid, type: z.enum(["CASHLESS", "REIMBURSEMENT"]), encounterId: uuid.optional(), diagnosis: z.string().trim().max(300).optional() }).strict();
export const preauthSchema = z.object({ requestedAmount: amount({ positive: true }), note: note.optional() }).strict();
export const preauthDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), amount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
/** `claimedAmount` may be left out when the policy has a co-pay rule: the calculated amount is used. A different amount needs `overrideReason`. */
export const submitSchema = z.object({ invoiceId: uuid, extraInvoiceIds: z.array(uuid).max(10).optional(), claimedAmount: amount({ positive: true }).optional(), overrideReason: overrideReason.optional(), note: note.optional() }).strict();
/** Payer verification: what the insurer or TPA said about the patient's cover, with their reference (call, portal or email). A "not eligible" answer needs the reason they gave. */
export const verifySchema = z.object({ outcome: z.enum(["VERIFIED", "NOT_ELIGIBLE"]), reference: z.string().trim().min(3).max(60), note: z.string().trim().max(300).optional() }).strict()
  .refine((v) => v.outcome === "VERIFIED" || (v.note !== undefined && v.note.length >= 5), { path: ["note"], message: "Enter the reason the insurer gave" });
export const enhancementSchema = z.object({ requestedAmount: amount({ positive: true }), reason: z.string().trim().min(10).max(300) }).strict();
export const enhancementDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), amount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
export const nonPayableSchema = z.object({ description: z.string().trim().min(3).max(120), amount: amount({ positive: true }), reason: z.string().trim().min(5).max(300) }).strict();
export const removeSchema = z.object({ reason }).strict();
export const appealSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const appealDecisionSchema = z.object({ decision: z.enum(["OVERTURN", "UPHOLD"]), amount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
export const rateSchema = z.object({ price: amount(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict();
export const packageSchema = z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(2).max(120), price: amount({ positive: true }) }).strict();
export const packageUpdateSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), price: amount({ positive: true }).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict();
export const tariffSchema = z.object({ packageId: uuid.nullable() }).strict();
export const addInvoiceSchema = z.object({ invoiceId: uuid }).strict();
export const rateCheckSchema = z.object({ invoiceId: uuid.optional() }).strict();
export const querySchema = z.object({ note }).strict();
export const resubmitSchema = z.object({ note, claimedAmount: amount({ positive: true }).optional(), overrideReason: overrideReason.optional() }).strict();
export const decisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), approvedAmount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
/** `amount` is the cash received; `tdsAmount` is tax the insurer deducted at source. Both count towards the approved amount. */
export const settleSchema = z.object({ amount: amount({ positive: true }), tdsAmount: amount().optional(), reference: z.string().trim().min(4).max(60), receivedOn: day }).strict();
export const closeSchema = z.object({ reason }).strict();
export const listClaimsSchema = z.object({
  status: z.enum(["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED", "REJECTED", "SETTLED", "CLOSED"]).optional(),
  q: z.string().trim().min(2).max(60).optional(), patientId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const money = (v: Decimal.Value | null | undefined) => (v === null || v === undefined ? null : fmt(v));
const today = () => new Date(new Date().toISOString().slice(0, 10));
const ruleOf = (p: { copayPercent: Prisma.Decimal | null; deductible: Prisma.Decimal; deductibleUsed: Prisma.Decimal; sumInsured: Prisma.Decimal | null }): CopayRule => ({
  copayPercent: p.copayPercent === null ? null : new Decimal(p.copayPercent.toString()), deductible: new Decimal(p.deductible.toString()), deductibleUsed: new Decimal(p.deductibleUsed.toString()),
  sumInsured: p.sumInsured === null ? null : new Decimal(p.sumInsured.toString()),
});

/**
 * Insurance claims (docs/claims.md): insurers and TPAs, the patient's policies, and a claim that follows one issued invoice through pre-authorisation,
 * submission, queries, the insurer's decision and settlement. Every step is checked against the allowed order, written to the claim's timeline and audited.
 * Money received from the insurer is posted as a bank-transfer payment on the invoice in the same transaction, so the invoice and the claim never disagree.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService,
    private readonly ledger: LedgerService, private readonly idempotency: IdempotencyService,
  ) {}

  // ───── insurers and policies ─────

  async insurers(ctx: RequestContext) {
    const rows = await this.prisma.insurer.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { name: "asc" }, take: 500 });
    return rows.map((i) => ({ id: i.id, name: i.name, kind: i.kind, contact: i.contact, status: i.status }));
  }

  async saveInsurer(ctx: RequestContext, id: string | null, input: z.infer<typeof insurerSchema>) {
    return this.prisma.$transaction(async (tx) => {
      try {
        if (id) {
          const have = await tx.insurer.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { id: true } });
          if (!have) throw new DomainError("NOT_FOUND", "Resource not found", 404);
          const r = await tx.insurer.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { name: input.name, kind: input.kind, contact: input.contact ?? null, ...(input.status ? { status: input.status } : {}) } });
          await this.audit.record(tx, actorOf(ctx), { action: "INSURER_UPDATED", entityType: "Insurer", entityId: r.id, metadata: { name: r.name, status: r.status } });
          return { id: r.id, name: r.name, kind: r.kind, contact: r.contact, status: r.status };
        }
        const r = await tx.insurer.create({ data: { tenantId: ctx.tenantId, name: input.name, kind: input.kind, contact: input.contact ?? null } });
        await this.audit.record(tx, actorOf(ctx), { action: "INSURER_CREATED", entityType: "Insurer", entityId: r.id, metadata: { name: r.name, kind: r.kind } });
        return { id: r.id, name: r.name, kind: r.kind, contact: r.contact, status: r.status };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "An insurer with this name already exists", 409);
        throw e;
      }
    });
  }

  private policyView(p: { id: string; policyNumber: string; memberId: string | null; holderName: string | null; validFrom: Date; validTo: Date; sumInsured: Prisma.Decimal | null; copayPercent: Prisma.Decimal | null; deductible: Prisma.Decimal; deductibleUsed: Prisma.Decimal; status: string; insurer: { id: string; name: string; kind: string } }) {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return {
      id: p.id, policyNumber: p.policyNumber, memberId: p.memberId, holderName: p.holderName, validFrom: iso(p.validFrom), validTo: iso(p.validTo), sumInsured: money(p.sumInsured),
      copayPercent: p.copayPercent === null ? null : new Decimal(p.copayPercent.toString()).toFixed(2), deductible: fmt(p.deductible), deductibleUsed: fmt(p.deductibleUsed), hasCopayRule: hasCopayRule(ruleOf(p)),
      status: p.status, insurer: p.insurer, validToday: p.status === "ACTIVE" && p.validFrom <= today() && p.validTo >= today() };
  }

  async policies(ctx: RequestContext, patientId: string) {
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!patient) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.patientPolicy.findMany({ where: { tenantId: ctx.tenantId, patientId }, orderBy: { validTo: "desc" }, take: 50, include: { insurer: { select: { id: true, name: true, kind: true } } } });
    return rows.map((p) => this.policyView(p));
  }

  async addPolicy(ctx: RequestContext, patientId: string, input: z.infer<typeof policySchema>) {
    if (input.validFrom > input.validTo) throw new DomainError("VALIDATION_FAILED", "The policy ends before it starts", 400, [{ path: "validTo", message: "Before the start date" }]);
    this.checkRule(input.deductible ?? new Decimal(0), input.deductibleUsed ?? new Decimal(0));
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
      const insurer = await tx.insurer.findFirst({ where: { id: input.insurerId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient || !insurer) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      try {
        const p = await tx.patientPolicy.create({
          data: { tenantId: ctx.tenantId, patientId, insurerId: input.insurerId, policyNumber: input.policyNumber, memberId: input.memberId ?? null, holderName: input.holderName ?? null, validFrom: new Date(input.validFrom), validTo: new Date(input.validTo), sumInsured: input.sumInsured?.toFixed(2) ?? null, copayPercent: input.copayPercent?.toFixed(2) ?? null, deductible: (input.deductible ?? new Decimal(0)).toFixed(2), deductibleUsed: (input.deductibleUsed ?? new Decimal(0)).toFixed(2), createdById: ctx.userId },
          include: { insurer: { select: { id: true, name: true, kind: true } } },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "POLICY_ADDED", entityType: "PatientPolicy", entityId: p.id, metadata: { patientId, insurerId: input.insurerId } });
        return this.policyView(p);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This policy is already on the patient's record", 409);
        throw e;
      }
    });
  }

  private checkRule(deductible: Decimal, used: Decimal): void {
    if (used.gt(deductible)) throw new DomainError("VALIDATION_FAILED", "The deductible already used cannot be more than the deductible", 400, [{ path: "deductibleUsed", message: "More than the deductible" }]);
  }

  /** Sets (or removes) the policy's co-pay rule. Claims already submitted keep the calculation they were made with. */
  async setPolicyCopay(ctx: RequestContext, policyId: string, input: z.infer<typeof policyCopaySchema>) {
    this.checkRule(input.deductible, input.deductibleUsed);
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.patientPolicy.findFirst({ where: { id: policyId, tenantId: ctx.tenantId }, select: { id: true, copayPercent: true, deductible: true, deductibleUsed: true } });
      if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const r = await tx.patientPolicy.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: p.id } },
        data: { copayPercent: input.copayPercent?.toFixed(2) ?? null, deductible: input.deductible.toFixed(2), deductibleUsed: input.deductibleUsed.toFixed(2) },
        include: { insurer: { select: { id: true, name: true, kind: true } } },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "POLICY_COPAY_CHANGED", entityType: "PatientPolicy", entityId: p.id,
        metadata: { from: { copayPercent: p.copayPercent?.toString() ?? null, deductible: fmt(p.deductible), deductibleUsed: fmt(p.deductibleUsed) }, to: { copayPercent: input.copayPercent?.toFixed(2) ?? null, deductible: fmt(input.deductible), deductibleUsed: fmt(input.deductibleUsed) } },
      });
      return this.policyView(r);
    });
  }

  async setPolicyStatus(ctx: RequestContext, policyId: string, input: z.infer<typeof policyStatusSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.patientPolicy.findFirst({ where: { id: policyId, tenantId: ctx.tenantId }, select: { id: true, patientId: true } });
      if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const r = await tx.patientPolicy.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: p.id } }, data: { status: input.status }, include: { insurer: { select: { id: true, name: true, kind: true } } } });
      await this.audit.record(tx, actorOf(ctx), { action: "POLICY_STATUS_CHANGED", entityType: "PatientPolicy", entityId: p.id, metadata: { status: input.status } });
      return this.policyView(r);
    });
  }

  // ───── claims ─────

  async create(ctx: RequestContext, input: z.infer<typeof createClaimSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.patientPolicy.findFirst({ where: { id: input.policyId, tenantId: ctx.tenantId, patientId: input.patientId } });
      if (!policy) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (policy.status !== "ACTIVE" || policy.validFrom > today() || policy.validTo < today()) throw new DomainError("INVALID_STATE", "This policy is not valid today", 409);
      if (input.encounterId) {
        const e = await tx.encounter.findFirst({ where: { id: input.encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId }, select: { id: true } });
        if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const claimNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "CLAIM");
      const c = await tx.claim.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, policyId: input.policyId, encounterId: input.encounterId ?? null, claimNumber, type: input.type, diagnosis: input.diagnosis ?? null, createdById: ctx.userId }, select: { id: true } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: null, toStatus: "DRAFT", actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_CREATED", entityType: "Claim", entityId: c.id, metadata: { claimNumber, type: input.type } });
      return { id: c.id, claimNumber };
    });
  }

  async list(ctx: RequestContext, q: z.infer<typeof listClaimsSchema>) {
    const where: Prisma.ClaimWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}), ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.q ? { OR: [{ claimNumber: { contains: q.q, mode: "insensitive" } }, { policy: { policyNumber: { contains: q.q, mode: "insensitive" } } }, { patient: { searchName: { contains: q.q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim() } } }, { patient: { identifiers: { some: { type: "MRN", value: { contains: q.q, mode: "insensitive" } } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.claim.findMany({
        where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, claimNumber: true, type: true, status: true, claimedAmount: true, approvedAmount: true, settledAmount: true, updatedAt: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, policy: { select: { policyNumber: true, insurer: { select: { name: true } } } } },
      }),
      this.prisma.claim.count({ where }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((c) => ({ id: c.id, claimNumber: c.claimNumber, type: c.type, status: c.status, claimedAmount: money(c.claimedAmount), approvedAmount: money(c.approvedAmount), settledAmount: money(c.settledAmount), outstanding: c.approvedAmount ? fmt(new Decimal(c.approvedAmount.toString()).minus(c.settledAmount.toString())) : null, updatedAt: c.updatedAt, patient: nameOf(c.patient), mrn: c.patient.identifiers[0]?.value ?? null, insurer: c.policy.insurer.name, policyNumber: c.policy.policyNumber })),
    };
  }

  async view(ctx: RequestContext, id: string) {
    const c = await this.prisma.claim.findFirst({
      where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        policy: { include: { insurer: { select: { id: true, name: true, kind: true } } } },
        invoice: { select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, creditedTotal: true, refundedTotal: true } },
        events: { orderBy: { at: "asc" } }, settlements: { orderBy: { createdAt: "asc" } }, enhancements: { orderBy: { requestedAt: "asc" } }, nonPayables: { orderBy: { recordedAt: "asc" } }, appeals: { orderBy: { requestedAt: "asc" } },
        extraInvoices: { orderBy: { createdAt: "asc" }, select: { invoice: { select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, creditedTotal: true, refundedTotal: true } } } },
      },
    });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...c.events.map((e) => e.actorId), ...c.settlements.map((s) => s.createdById), ...c.enhancements.flatMap((e) => [e.requestedById, ...(e.decidedById ? [e.decidedById] : [])]), ...(c.verifiedById ? [c.verifiedById] : []), ...c.nonPayables.map((n) => n.recordedById), ...c.appeals.flatMap((a) => [a.requestedById, ...(a.decidedById ? [a.decidedById] : [])])])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const status = c.status as ClaimStatus;
    return {
      id: c.id, claimNumber: c.claimNumber, type: c.type, status, diagnosis: c.diagnosis, closeReason: c.closeReason, encounterId: c.encounterId,
      patient: { id: c.patient.id, name: nameOf(c.patient), mrn: c.patient.identifiers[0]?.value ?? null }, policy: this.policyView(c.policy),
      preauthRequested: money(c.preauthRequested), preauthApproved: money(c.preauthApproved), claimedAmount: money(c.claimedAmount), approvedAmount: money(c.approvedAmount), settledAmount: money(c.settledAmount),
      copay: c.calculatedAmount === null ? null : { calculatedAmount: money(c.calculatedAmount), patientShare: money(c.patientShare), copayPercent: money(c.copayPercentApplied), deductibleApplied: money(c.deductibleApplied), overrideReason: c.amountOverrideReason },
      outstanding: c.approvedAmount ? fmt(new Decimal(c.approvedAmount.toString()).minus(c.settledAmount.toString())) : null,
      verification: c.verification ? { outcome: c.verification, reference: c.verificationRef, note: c.verificationNote, at: c.verifiedAt, by: c.verifiedById ? users.get(c.verifiedById) ?? null : null } : null,
      enhancements: c.enhancements.map((e) => ({ id: e.id, requestedAmount: fmt(e.requestedAmount), reason: e.reason, status: e.status, approvedAmount: money(e.approvedAmount), decisionNote: e.decisionNote, requestedAt: e.requestedAt, requestedBy: users.get(e.requestedById) ?? null, decidedAt: e.decidedAt, decidedBy: e.decidedById ? users.get(e.decidedById) ?? null : null })),
      package: c.packageId ? { id: c.packageId, name: c.packageName, price: money(c.packagePrice) } : null,
      extraInvoices: c.extraInvoices.map((l) => ({ id: l.invoice.id, invoiceNumber: l.invoice.invoiceNumber, total: fmt(l.invoice.total), balanceDue: fmt(balanceDue(l.invoice)) })),
      nonPayables: c.nonPayables.map((n) => ({ id: n.id, description: n.description, amount: fmt(n.amount), reason: n.reason, status: n.status, recordedBy: users.get(n.recordedById) ?? null, removeReason: n.removeReason })),
      nonPayableTotal: fmt(c.nonPayables.filter((n) => n.status === "ACTIVE").reduce((t, n) => t.plus(n.amount.toString()), new Decimal(0))),
      appeals: c.appeals.map((a) => ({ id: a.id, reason: a.reason, status: a.status, approvedAmount: money(a.approvedAmount), decisionNote: a.decisionNote, requestedAt: a.requestedAt, requestedBy: users.get(a.requestedById) ?? null, decidedAt: a.decidedAt, decidedBy: a.decidedById ? users.get(a.decidedById) ?? null : null })),
      invoice: c.invoice ? { id: c.invoice.id, invoiceNumber: c.invoice.invoiceNumber, status: c.invoice.status, total: fmt(c.invoice.total), balanceDue: fmt(balanceDue(c.invoice)) } : null,
      nextSteps: stepsFrom(status).filter((s) => stepAllowedForType(s, c.type)),
      events: c.events.map((e) => ({ at: e.at, from: e.fromStatus, to: e.toStatus, amount: money(e.amount), note: e.note, by: users.get(e.actorId) ?? null })),
      settlements: c.settlements.map((s) => ({ id: s.id, amount: fmt(s.amount), tdsAmount: fmt(s.tdsAmount), reference: s.reference, receivedOn: s.receivedOn.toISOString().slice(0, 10), by: users.get(s.createdById) ?? null, receiptId: s.receiptId })),
    };
  }

  /**
   * The claim package the TPA desk hands to the insurer or uploads on its portal (docs/claims.md): the claim, patient, policy,
   * the issued invoice with its lines, the document list and the timeline, in one structured file. MedOS does not transmit it.
   * Exporting is audited. Only a claim with an invoice attached (submitted) has a package.
   */
  async claimPackage(ctx: RequestContext, claimId: string) {
    const claim = await this.view(ctx, claimId);
    if (!claim.invoice) throw new DomainError("INVALID_STATE", "Submit the claim with an invoice before preparing its package", 409);
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: claim.invoice.id, tenantId: ctx.tenantId },
      select: { invoiceNumber: true, issuedAt: true, total: true, lines: { orderBy: { lineNo: "asc" }, select: { lineNo: true, description: true, hsnSac: true, quantity: true, unitPrice: true, discountAmount: true, taxAmount: true, lineTotal: true } } },
    });
    if (!invoice) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const documents = await this.prisma.claimDocument.findMany({
      where: { claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" },
      orderBy: { uploadedAt: "asc" }, select: { label: true, fileName: true, contentType: true, sizeBytes: true, sha256: true },
    });
    const extraInvoices = await Promise.all(claim.extraInvoices.map(async (x) => {
      const i = await this.prisma.invoice.findFirst({ where: { id: x.id, tenantId: ctx.tenantId }, select: { invoiceNumber: true, issuedAt: true, total: true, lines: { orderBy: { lineNo: "asc" }, select: { lineNo: true, description: true, hsnSac: true, quantity: true, unitPrice: true, discountAmount: true, taxAmount: true, lineTotal: true } } } });
      return i ? { invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, total: fmt(i.total), lines: i.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, hsnSac: l.hsnSac, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice), discount: fmt(l.discountAmount), tax: fmt(l.taxAmount), total: fmt(l.lineTotal) })) } : null;
    }));
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "CLAIM_PACKAGE_EXPORTED", entityType: "Claim", entityId: claimId, metadata: { claimNumber: claim.claimNumber, documents: documents.length } }));
    return {
      format: "medos-claim-package/1", transmitted: false, claim,
      invoice: { invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt, total: fmt(invoice.total), lines: invoice.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, hsnSac: l.hsnSac, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice), discount: fmt(l.discountAmount), tax: fmt(l.taxAmount), total: fmt(l.lineTotal) })) },
      extraInvoices: extraInvoices.filter((x) => x !== null),
      documents,
    };
  }

  private async lock(tx: Db, ctx: RequestContext, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Claim" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.claim.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  /** Checks the step is allowed from where the claim stands, and for its type; returns the status it will have. */
  private step(c: { status: ClaimStatus; type: "CASHLESS" | "REIMBURSEMENT" }, step: ClaimStep, to?: ClaimStatus): ClaimStatus {
    const next = stepAllowedForType(step, c.type) ? nextStatus(c.status, step, to) : null;
    if (!next) throw new DomainError("INVALID_STATE", `This step is not possible for a ${c.status.toLowerCase().replace(/_/g, " ")} ${c.type.toLowerCase()} claim`, 409);
    return next;
  }

  private async move(tx: Db, ctx: RequestContext, c: { id: string; status: ClaimStatus; claimNumber: string }, to: ClaimStatus, data: Prisma.ClaimUncheckedUpdateInput, ev: { amount?: Decimal | undefined; note?: string | undefined }, action: string, meta: Record<string, unknown> = {}) {
    await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { ...data, status: to } });
    await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: to, amount: ev.amount?.toFixed(2) ?? null, note: ev.note ?? null, actorId: ctx.userId } });
    await this.audit.record(tx, actorOf(ctx), { action, entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, from: c.status, to, ...(ev.amount ? { amount: fmt(ev.amount) } : {}), ...meta } });
    return { id: c.id, status: to };
  }

  async requestPreauth(ctx: RequestContext, id: string, input: z.infer<typeof preauthSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "REQUEST_PREAUTH");
      if (c.verification === "NOT_ELIGIBLE") throw new DomainError("INVALID_STATE", "The insurer said this patient is not eligible; record a new verification before asking for pre-authorisation", 409);
      return this.move(tx, ctx, c, to, { preauthRequested: input.requestedAmount.toFixed(2) }, { amount: input.requestedAmount, note: input.note }, "CLAIM_PREAUTH_REQUESTED");
    });
  }

  async decidePreauth(ctx: RequestContext, id: string, input: z.infer<typeof preauthDecisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (input.decision === "APPROVE") {
        if (!input.amount) throw new DomainError("VALIDATION_FAILED", "Enter the amount the insurer approved", 400, [{ path: "amount", message: "Required" }]);
        const to = this.step(c, "DECIDE_PREAUTH", "PREAUTH_APPROVED");
        return this.move(tx, ctx, c, to, { preauthApproved: input.amount.toFixed(2) }, { amount: input.amount, note: input.reason }, "CLAIM_PREAUTH_APPROVED");
      }
      if (!input.reason) throw new DomainError("VALIDATION_FAILED", "Enter the reason the insurer gave", 400, [{ path: "reason", message: "Required" }]);
      const to = this.step(c, "DECIDE_PREAUTH", "REJECTED");
      return this.move(tx, ctx, c, to, { closeReason: input.reason }, { note: input.reason }, "CLAIM_PREAUTH_REJECTED");
    });
  }

  /**
   * Payer verification: the desk checks the patient's cover with the insurer or TPA and records the answer and their reference. MedOS does not contact the insurer;
   * a later check replaces the earlier one on the claim (every check stays on the timeline and in the audit trail). Possible until the claim is finished.
   */
  async verifyPayer(ctx: RequestContext, id: string, input: z.infer<typeof verifySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (FINISHED.includes(c.status as ClaimStatus)) throw new DomainError("INVALID_STATE", "This claim is finished", 409);
      const note = input.note ?? null;
      await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { verification: input.outcome, verifiedAt: new Date(), verifiedById: ctx.userId, verificationRef: input.reference, verificationNote: note } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, note: `${input.outcome === "VERIFIED" ? "Cover verified" : "Not eligible"} (ref ${input.reference})${note ? `: ${note}` : ""}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_PAYER_VERIFIED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, outcome: input.outcome, reference: input.reference } });
      return { id: c.id, verification: input.outcome };
    });
  }

  /** While the patient is admitted on an approved pre-authorisation, the desk asks the insurer to authorise more. One request waits at a time. */
  async requestEnhancement(ctx: RequestContext, id: string, input: z.infer<typeof enhancementSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.type !== "CASHLESS" || c.status !== "PREAUTH_APPROVED") throw new DomainError("INVALID_STATE", "More authorisation can only be asked for on a cashless claim whose pre-authorisation is approved and not yet submitted", 409);
      if (await tx.claimEnhancement.count({ where: { tenantId: ctx.tenantId, claimId: c.id, status: "PENDING" } }) > 0) throw new DomainError("CONFLICT", "An enhancement request is already waiting for the insurer", 409);
      const e = await tx.claimEnhancement.create({ data: { tenantId: ctx.tenantId, claimId: c.id, requestedAmount: input.requestedAmount.toFixed(2), reason: input.reason, requestedById: ctx.userId }, select: { id: true } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, amount: input.requestedAmount.toFixed(2), note: `Enhancement requested: ${input.reason}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_ENHANCEMENT_REQUESTED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, enhancementId: e.id, amount: fmt(input.requestedAmount) } });
      return { id: e.id, status: "PENDING" as const };
    });
  }

  /** The insurer's answer to an enhancement request. An approval (for up to what was asked) is added to the claim's authorised amount. */
  async decideEnhancement(ctx: RequestContext, id: string, enhancementId: string, input: z.infer<typeof enhancementDecisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const e = await tx.claimEnhancement.findFirst({ where: { id: enhancementId, tenantId: ctx.tenantId, claimId: c.id } });
      if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (e.status !== "PENDING") throw new DomainError("INVALID_STATE", "This request has already been decided", 409);
      if (c.status !== "PREAUTH_APPROVED") throw new DomainError("INVALID_STATE", "This claim is no longer waiting on its pre-authorisation", 409);
      const now = new Date();
      if (input.decision === "APPROVE") {
        if (!input.amount) throw new DomainError("VALIDATION_FAILED", "Enter the amount the insurer approved", 400, [{ path: "amount", message: "Required" }]);
        if (input.amount.gt(e.requestedAmount.toString())) throw new DomainError("VALIDATION_FAILED", "The insurer cannot approve more than was asked for", 400, [{ path: "amount", message: "More than requested" }]);
        await tx.claimEnhancement.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: e.id } }, data: { status: "APPROVED", approvedAmount: input.amount.toFixed(2), decisionNote: input.reason ?? null, decidedById: ctx.userId, decidedAt: now } });
        const total = new Decimal(c.preauthApproved!.toString()).plus(input.amount);
        await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { preauthApproved: total.toFixed(2) } });
        await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, amount: input.amount.toFixed(2), note: `Enhancement approved; authorised now ${fmt(total)}`, actorId: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_ENHANCEMENT_APPROVED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, enhancementId: e.id, amount: fmt(input.amount), authorised: fmt(total) } });
        return { id: e.id, status: "APPROVED" as const, authorised: fmt(total) };
      }
      if (!input.reason) throw new DomainError("VALIDATION_FAILED", "Enter the reason the insurer gave", 400, [{ path: "reason", message: "Required" }]);
      await tx.claimEnhancement.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: e.id } }, data: { status: "REJECTED", decisionNote: input.reason, decidedById: ctx.userId, decidedAt: now } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, note: `Enhancement rejected: ${input.reason}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_ENHANCEMENT_REJECTED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, enhancementId: e.id } });
      return { id: e.id, status: "REJECTED" as const, authorised: fmt(c.preauthApproved!) };
    });
  }

  private async nonPayableTotal(tx: Db, ctx: RequestContext, claimId: string): Promise<Decimal> {
    const rows = await tx.claimNonPayable.findMany({ where: { tenantId: ctx.tenantId, claimId, status: "ACTIVE" }, select: { amount: true } });
    return rows.reduce((t, r) => t.plus(r.amount.toString()), new Decimal(0));
  }

  /** A charge the insurer will not pay. It comes off what the claim asks for and is paid by the patient. Possible before submission, or while the claim is under query. */
  async addNonPayable(ctx: RequestContext, id: string, input: z.infer<typeof nonPayableSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      return this.insertNonPayable(tx, ctx, c, input);
    });
  }

  private async insertNonPayable(tx: Db, ctx: RequestContext, c: { id: string; status: string; invoiceId: string | null; claimNumber: string }, input: z.infer<typeof nonPayableSchema>) {
    if (!["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "QUERY"].includes(c.status)) throw new DomainError("INVALID_STATE", "Non-payable items can only be changed before the claim is submitted, or while it is under query", 409);
    if (c.invoiceId) {
      const base = await this.coveredBase(tx, ctx, c);
      const after = (await this.nonPayableTotal(tx, ctx, c.id)).plus(input.amount);
      if (after.gt(base)) throw new DomainError("VALIDATION_FAILED", "The non-payable items would add up to more than the invoices", 400, [{ path: "amount", message: "More than the invoices" }]);
    }
    const n = await tx.claimNonPayable.create({ data: { tenantId: ctx.tenantId, claimId: c.id, description: input.description, amount: input.amount.toFixed(2), reason: input.reason, recordedById: ctx.userId }, select: { id: true } });
    await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status as ClaimStatus, toStatus: c.status as ClaimStatus, amount: input.amount.toFixed(2), note: `Not payable by the insurer: ${input.description}`, actorId: ctx.userId } });
    await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_NON_PAYABLE_ADDED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, nonPayableId: n.id, amount: fmt(input.amount) } });
    return { id: n.id };
  }

  /** What the claim's invoices are worth together (after credit notes): its main invoice and any further ones. */
  private async coveredBase(tx: Db, ctx: RequestContext, c: { id: string; invoiceId: string | null }): Promise<Decimal> {
    const ids = [...(c.invoiceId ? [c.invoiceId] : []), ...(await tx.claimInvoice.findMany({ where: { tenantId: ctx.tenantId, claimId: c.id }, select: { invoiceId: true } })).map((l) => l.invoiceId)];
    const rows = await tx.invoice.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { total: true, creditedTotal: true } });
    return rows.reduce((t, r) => t.plus(r.total.toString()).minus(r.creditedTotal.toString()), new Decimal(0));
  }

  /** Checks further invoices for a claim: the same patient's issued invoices, none repeated, none held by another live claim. Returns them. */
  private async extraInvoicesFor(tx: Db, ctx: RequestContext, c: { id: string; patientId: string }, mainId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.includes(mainId)) throw new DomainError("VALIDATION_FAILED", "The main invoice is already on the claim", 400, [{ path: "extraInvoiceIds", message: "Repeated" }]);
    const rows = [];
    for (const invoiceId of unique) rows.push(await this.invoiceFor(tx, ctx, c.patientId, invoiceId, new Decimal(0)));
    for (const invoiceId of [mainId, ...unique]) {
      const held = await tx.claim.findFirst({ where: { tenantId: ctx.tenantId, id: { not: c.id }, status: { notIn: ["REJECTED", "CLOSED"] }, OR: [{ invoiceId }, { extraInvoices: { some: { invoiceId } } }] }, select: { id: true } });
      if (held) throw new DomainError("CONFLICT", "An invoice already has a claim in progress", 409);
    }
    return rows;
  }

  /** The most a package allows the insurer to be asked for, or null when the claim is not under a package. */
  private packageCap(c: { packagePrice: Prisma.Decimal | null }): Decimal | null {
    return c.packagePrice === null ? null : new Decimal(c.packagePrice.toString());
  }

  /** A wrong entry is marked removed with a reason; it stays on the record. */
  async removeNonPayable(ctx: RequestContext, id: string, nonPayableId: string, input: z.infer<typeof removeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const n = await tx.claimNonPayable.findFirst({ where: { id: nonPayableId, tenantId: ctx.tenantId, claimId: c.id } });
      if (!n) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (n.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This item was already removed", 409);
      if (!["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "QUERY"].includes(c.status)) throw new DomainError("INVALID_STATE", "Non-payable items can only be changed before the claim is submitted, or while it is under query", 409);
      await tx.claimNonPayable.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: n.id } }, data: { status: "REMOVED", removedById: ctx.userId, removedAt: new Date(), removeReason: input.reason } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, amount: n.amount.toString(), note: `Non-payable item removed: ${n.description} (${input.reason})`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_NON_PAYABLE_REMOVED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, nonPayableId: n.id, amount: fmt(n.amount) } });
      return { id: n.id, status: "REMOVED" as const };
    });
  }

  /** The insurer rejected a submitted claim and the hospital disputes it. One appeal waits at a time. */
  async requestAppeal(ctx: RequestContext, id: string, input: z.infer<typeof appealSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "REJECTED" || !c.invoiceId || c.claimedAmount === null) throw new DomainError("INVALID_STATE", "An appeal can only be made against a claim the insurer rejected after it was submitted", 409);
      if (await tx.claimAppeal.count({ where: { tenantId: ctx.tenantId, claimId: c.id, status: "PENDING" } }) > 0) throw new DomainError("CONFLICT", "An appeal is already waiting for the insurer", 409);
      const a = await tx.claimAppeal.create({ data: { tenantId: ctx.tenantId, claimId: c.id, reason: input.reason, requestedById: ctx.userId }, select: { id: true } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, note: `Appeal sent: ${input.reason}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_APPEAL_REQUESTED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, appealId: a.id } });
      return { id: a.id, status: "PENDING" as const };
    });
  }

  /** The insurer's answer to an appeal. Overturned: the claim is approved again for the amount they now allow (up to what was claimed), and settlement follows as usual. Upheld: it stays rejected. */
  async decideAppeal(ctx: RequestContext, id: string, appealId: string, input: z.infer<typeof appealDecisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const a = await tx.claimAppeal.findFirst({ where: { id: appealId, tenantId: ctx.tenantId, claimId: c.id } });
      if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (a.status !== "PENDING") throw new DomainError("INVALID_STATE", "This appeal has already been decided", 409);
      const now = new Date();
      if (input.decision === "OVERTURN") {
        if (!input.amount) throw new DomainError("VALIDATION_FAILED", "Enter the amount the insurer now approves", 400, [{ path: "amount", message: "Required" }]);
        if (input.amount.gt(c.claimedAmount!.toString())) throw new DomainError("VALIDATION_FAILED", "The insurer cannot approve more than was claimed", 400, [{ path: "amount", message: "More than claimed" }]);
        await tx.claimAppeal.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: a.id } }, data: { status: "OVERTURNED", approvedAmount: input.amount.toFixed(2), decisionNote: input.reason ?? null, decidedById: ctx.userId, decidedAt: now } });
        try {
          await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { status: "APPROVED", approvedAmount: input.amount.toFixed(2), closeReason: null } });
        } catch (e) {
          if (String((e as { message?: string }).message ?? "").includes("claim_one_per_invoice") || (e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This invoice already has another claim in progress, so this one cannot be approved again", 409);
          throw e;
        }
        await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: "REJECTED", toStatus: "APPROVED", amount: input.amount.toFixed(2), note: `Appeal succeeded${input.reason ? `: ${input.reason}` : ""}`, actorId: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_APPEAL_OVERTURNED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, appealId: a.id, amount: fmt(input.amount) } });
        return { id: a.id, status: "OVERTURNED" as const, claimStatus: "APPROVED" as const };
      }
      if (!input.reason) throw new DomainError("VALIDATION_FAILED", "Enter the reason the insurer gave", 400, [{ path: "reason", message: "Required" }]);
      await tx.claimAppeal.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: a.id } }, data: { status: "UPHELD", decisionNote: input.reason, decidedById: ctx.userId, decidedAt: now } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, note: `Appeal rejected: ${input.reason}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_APPEAL_UPHELD", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, appealId: a.id } });
      return { id: a.id, status: "UPHELD" as const, claimStatus: c.status };
    });
  }

  /** While the claim is under query another invoice of the patient (an interim or pharmacy bill, say) can join it; the next resubmission then claims for all of them. */
  async addInvoice(ctx: RequestContext, id: string, input: z.infer<typeof addInvoiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (c.status !== "QUERY" || !c.invoiceId) throw new DomainError("INVALID_STATE", "Another invoice can be added when the claim is submitted with its invoice and is under query, or when submitting", 409);
      const [inv] = await this.extraInvoicesFor(tx, ctx, c, c.invoiceId, [input.invoiceId]);
      await tx.claimInvoice.create({ data: { tenantId: ctx.tenantId, claimId: c.id, invoiceId: inv!.id, createdById: ctx.userId } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: c.status, note: `Invoice ${inv!.invoiceNumber ?? ""} added to the claim`.replace("  ", " "), actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_INVOICE_ADDED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, invoiceId: inv!.id } });
      return { id: c.id, invoiceId: inv!.id };
    });
  }

  // ───── insurer rate cards and packages ─────

  async rates(ctx: RequestContext, insurerId: string) {
    const ins = await this.prisma.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!ins) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.insurerRate.findMany({ where: { tenantId: ctx.tenantId, insurerId }, orderBy: { createdAt: "asc" }, take: 1000, include: { service: { select: { id: true, code: true, name: true, price: true } } } });
    return rows.map((r) => ({ serviceId: r.serviceId, code: r.service.code, name: r.service.name, standardPrice: fmt(r.service.price), price: fmt(r.price), status: r.status }));
  }

  async setRate(ctx: RequestContext, insurerId: string, serviceId: string, input: z.infer<typeof rateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ins = await tx.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true } });
      const svc = await tx.service.findFirst({ where: { id: serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
      if (!ins || !svc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const r = await tx.insurerRate.upsert({
        where: { tenantId_insurerId_serviceId: { tenantId: ctx.tenantId, insurerId, serviceId } },
        create: { tenantId: ctx.tenantId, insurerId, serviceId, price: input.price.toFixed(2), ...(input.status ? { status: input.status } : {}) },
        update: { price: input.price.toFixed(2), ...(input.status ? { status: input.status } : {}) },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_RATE_SET", entityType: "Insurer", entityId: insurerId, metadata: { serviceId, price: fmt(r.price), status: r.status } });
      return { serviceId, price: fmt(r.price), status: r.status };
    });
  }

  async packages(ctx: RequestContext, insurerId: string) {
    const ins = await this.prisma.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!ins) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.insurerPackage.findMany({ where: { tenantId: ctx.tenantId, insurerId }, orderBy: { code: "asc" }, take: 500 });
    return rows.map((p) => ({ id: p.id, code: p.code, name: p.name, price: fmt(p.price), status: p.status }));
  }

  async addPackage(ctx: RequestContext, insurerId: string, input: z.infer<typeof packageSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ins = await tx.insurer.findFirst({ where: { id: insurerId, tenantId: ctx.tenantId }, select: { id: true } });
      if (!ins) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      try {
        const p = await tx.insurerPackage.create({ data: { tenantId: ctx.tenantId, insurerId, code: input.code, name: input.name, price: input.price.toFixed(2) } });
        await this.audit.record(tx, actorOf(ctx), { action: "INSURER_PACKAGE_ADDED", entityType: "Insurer", entityId: insurerId, metadata: { packageId: p.id, code: p.code, price: fmt(p.price) } });
        return { id: p.id, code: p.code, name: p.name, price: fmt(p.price), status: p.status };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This insurer already has a package with this code", 409);
        throw e;
      }
    });
  }

  /** A changed package price does not alter claims that already chose it (they keep the price they chose it at). */
  async updatePackage(ctx: RequestContext, insurerId: string, packageId: string, input: z.infer<typeof packageUpdateSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const have = await tx.insurerPackage.findFirst({ where: { id: packageId, insurerId, tenantId: ctx.tenantId } });
      if (!have) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const p = await tx.insurerPackage.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: packageId } }, data: { ...(input.name ? { name: input.name } : {}), ...(input.price ? { price: input.price.toFixed(2) } : {}), ...(input.status ? { status: input.status } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "INSURER_PACKAGE_UPDATED", entityType: "Insurer", entityId: insurerId, metadata: { packageId, from: { price: fmt(have.price), status: have.status }, to: { price: fmt(p.price), status: p.status } } });
      return { id: p.id, code: p.code, name: p.name, price: fmt(p.price), status: p.status };
    });
  }

  /** Puts the claim under one of its insurer's packages (or takes it out). From then on it never asks the insurer for more than the package price. */
  async chooseTariff(ctx: RequestContext, id: string, input: z.infer<typeof tariffSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (!["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "QUERY"].includes(c.status)) throw new DomainError("INVALID_STATE", "The package can only be changed before the claim is submitted, or while it is under query", 409);
      let data: Prisma.ClaimUncheckedUpdateInput = { packageId: null, packageName: null, packagePrice: null };
      let note = "Package removed from the claim";
      if (input.packageId) {
        const policy = await tx.patientPolicy.findFirstOrThrow({ where: { id: c.policyId, tenantId: ctx.tenantId }, select: { insurerId: true } });
        const pkg = await tx.insurerPackage.findFirst({ where: { id: input.packageId, tenantId: ctx.tenantId, insurerId: policy.insurerId, status: "ACTIVE" } });
        if (!pkg) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        data = { packageId: pkg.id, packageName: pkg.name, packagePrice: pkg.price.toString() };
        note = `Claim put under package ${pkg.code} ${pkg.name} at ${fmt(pkg.price)}`;
      }
      await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status as ClaimStatus, toStatus: c.status as ClaimStatus, note, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_PACKAGE_CHOSEN", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, packageId: input.packageId } });
      return { id: c.id, packageId: input.packageId };
    });
  }

  /**
   * Compares the invoice's lines with the insurer's rate card: a line priced above the insurer's rate has its excess (before tax) left to the patient.
   * Lines without a rate are not touched. Nothing is changed here; `applyRateCheck` records the excess as non-payable items.
   */
  async rateCheck(ctx: RequestContext, claimId: string, invoiceId: string | undefined) {
    const c = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, invoiceId: true, patientId: true, policy: { select: { insurerId: true } } } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const target = invoiceId ?? c.invoiceId;
    if (!target) throw new DomainError("VALIDATION_FAILED", "Choose the invoice to check", 400, [{ path: "invoiceId", message: "Required" }]);
    const inv = await this.prisma.invoice.findFirst({ where: { id: target, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: c.patientId }, select: { id: true, lines: { orderBy: { lineNo: "asc" }, select: { lineNo: true, serviceId: true, description: true, quantity: true, unitPrice: true } } } });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rates = new Map((await this.prisma.insurerRate.findMany({ where: { tenantId: ctx.tenantId, insurerId: c.policy.insurerId, status: "ACTIVE" }, select: { serviceId: true, price: true } })).map((r) => [r.serviceId, new Decimal(r.price.toString())]));
    const lines = inv.lines.flatMap((l) => {
      const rate = l.serviceId ? rates.get(l.serviceId) : undefined;
      if (!rate) return [];
      const over = new Decimal(l.unitPrice.toString()).minus(rate);
      const excess = over.gt(0) ? over.times(l.quantity.toString()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : new Decimal(0);
      return [{ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice), contractedPrice: fmt(rate), excess: fmt(excess) }];
    });
    return { invoiceId: inv.id, lines, totalExcess: fmt(lines.reduce((t, l) => t.plus(l.excess), new Decimal(0))) };
  }

  /** Records each line's excess over the insurer's rate as a non-payable item (once per line; running it again adds nothing new). */
  async applyRateCheck(ctx: RequestContext, claimId: string, input: z.infer<typeof rateCheckSchema>) {
    const check = await this.rateCheck(ctx, claimId, input.invoiceId);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, claimId);
      const have = new Set((await tx.claimNonPayable.findMany({ where: { tenantId: ctx.tenantId, claimId, status: "ACTIVE" }, select: { description: true } })).map((n) => n.description));
      let added = 0;
      for (const l of check.lines) {
        if (new Decimal(l.excess).lte(0)) continue;
        const description = `Above contracted rate: ${l.description}`.slice(0, 120);
        if (have.has(description)) continue;
        await this.insertNonPayable(tx, ctx, c, { description, amount: new Decimal(l.excess), reason: `Insurer's rate is ${l.contractedPrice} each; billed ${l.unitPrice}` });
        added += 1;
      }
      return { added, totalExcess: check.totalExcess };
    });
  }

  /** Submitting attaches one issued invoice and the amount claimed from the insurer (never more than the invoice is worth). */
  async submit(ctx: RequestContext, id: string, input: z.infer<typeof submitSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "SUBMIT");
      const waiting = await tx.claimEnhancement.count({ where: { tenantId: ctx.tenantId, claimId: c.id, status: "PENDING" } });
      if (waiting > 0) throw new DomainError("INVALID_STATE", "An enhancement request is still waiting for the insurer; record its decision before submitting", 409);
      const inv = await this.invoiceFor(tx, ctx, c.patientId, input.invoiceId, new Decimal(0));
      const extras = await this.extraInvoicesFor(tx, ctx, c, inv.id, input.extraInvoiceIds ?? []);
      const base = [inv, ...extras].reduce((t, i) => t.plus(i.total.toString()).minus(i.creditedTotal.toString()), new Decimal(0));
      const policy = await tx.patientPolicy.findFirstOrThrow({ where: { id: c.policyId, tenantId: ctx.tenantId } });
      const np = await this.nonPayableTotal(tx, ctx, c.id);
      const d = this.decideAmount(policy, base, input.claimedAmount, input.overrideReason, np, this.packageCap(c));
      if (d.claimed.gt(d.coverable)) throw new DomainError("VALIDATION_FAILED", "The claim is for more than can be claimed from the insurer for these invoices", 400, [{ path: "claimedAmount", message: "More than can be claimed" }]);
      const r = await this.attach(tx, ctx, c, to, inv.id, d.claimed, input.note, "CLAIM_SUBMITTED", d.data, { ...d.meta, ...(extras.length ? { invoices: extras.length + 1 } : {}) });
      for (const x of extras) await tx.claimInvoice.create({ data: { tenantId: ctx.tenantId, claimId: c.id, invoiceId: x.id, createdById: ctx.userId } });
      return r;
    });
  }

  /** What a claim for this invoice would be under the policy's co-pay rule, without saving anything (the screen shows it before the officer submits). */
  async copayPreview(ctx: RequestContext, claimId: string, input: z.infer<typeof copayPreviewSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { patientId: true, policyId: true, packagePrice: true } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const inv = await this.invoiceFor(tx, ctx, c.patientId, input.invoiceId, new Decimal(0));
      const extras = await this.extraInvoicesFor(tx, ctx, { id: claimId, patientId: c.patientId }, inv.id, input.extraInvoiceIds ?? []);
      const policy = await tx.patientPolicy.findFirstOrThrow({ where: { id: c.policyId, tenantId: ctx.tenantId } });
      const base = [inv, ...extras].reduce((t, i) => t.plus(i.total.toString()).minus(i.creditedTotal.toString()), new Decimal(0));
      const np = await this.nonPayableTotal(tx, ctx, claimId);
      const cap = this.packageCap(c);
      const coverable = Decimal.max(0, cap ? Decimal.min(base.minus(np), cap) : base.minus(np));
      const rule = ruleOf(policy);
      if (!hasCopayRule(rule)) return { hasRule: false as const, invoiceAmount: fmt(base), nonPayable: fmt(np), packagePrice: cap ? fmt(cap) : null, mostToClaim: fmt(coverable) };
      const r = calculateCopay(coverable, rule);
      return { hasRule: true as const, invoiceAmount: fmt(base), nonPayable: fmt(np), packagePrice: cap ? fmt(cap) : null, deductibleApplied: fmt(r.deductibleApplied), copayPercent: r.copayPercentApplied.toFixed(2), copayAmount: fmt(r.copayAmount), claimAmount: fmt(r.claim), patientShare: fmt(base.minus(r.claim)), cappedBySumInsured: r.cappedBySumInsured };
    });
  }

  /**
   * Works out the amount to claim. With a co-pay rule the calculated amount is the default; a different amount needs a reason, which is kept with the claim.
   * Without a rule the officer enters the amount, as before.
   */
  private decideAmount(policy: { copayPercent: Prisma.Decimal | null; deductible: Prisma.Decimal; deductibleUsed: Prisma.Decimal; sumInsured: Prisma.Decimal | null }, base: Decimal, entered: Decimal | undefined, why: string | undefined, nonPayable: Decimal, packageCap: Decimal | null) {
    // Charges the insurer will not pay are never asked for; the patient bears them (the patient's share is whatever is not claimed).
    if (nonPayable.gt(base)) throw new DomainError("VALIDATION_FAILED", "The non-payable items add up to more than the invoice", 400, [{ path: "nonPayable", message: "More than the invoice" }]);
    // Under an insurer package the claim never asks for more than the package price; the rest is the patient's.
    const coverable = packageCap ? Decimal.min(base.minus(nonPayable), packageCap) : base.minus(nonPayable);
    const rule = ruleOf(policy);
    if (!hasCopayRule(rule)) {
      if (!entered) throw new DomainError("VALIDATION_FAILED", "Enter the amount to claim", 400, [{ path: "claimedAmount", message: "Required" }]);
      return { base, coverable, claimed: entered, data: {} as Prisma.ClaimUncheckedUpdateInput, meta: {} as Record<string, unknown> };
    }
    const r = calculateCopay(coverable, rule);
    if (r.claim.lte(0)) throw new DomainError("INVALID_STATE", "The patient's share covers the whole bill, so there is nothing to claim from the insurer", 409);
    const claimed = entered ?? r.claim;
    const overridden = !claimed.eq(r.claim);
    if (overridden && !why) throw new DomainError("VALIDATION_FAILED", "Give a reason for changing the calculated amount", 400, [{ path: "overrideReason", message: "Required" }]);
    return {
      base, coverable, claimed,
      data: { calculatedAmount: r.claim.toFixed(2), patientShare: base.minus(claimed).toFixed(2), copayPercentApplied: r.copayPercentApplied.toFixed(2), deductibleApplied: r.deductibleApplied.toFixed(2), amountOverrideReason: overridden ? why! : null } as Prisma.ClaimUncheckedUpdateInput,
      meta: { copayPercent: r.copayPercentApplied.toFixed(2), deductibleApplied: fmt(r.deductibleApplied), calculated: fmt(r.claim), ...(overridden ? { overridden: true, overrideReason: why } : {}) },
    };
  }

  private async invoiceFor(tx: Db, ctx: RequestContext, patientId: string, invoiceId: string, claimed: Decimal) {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId } });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(inv.status)) throw new DomainError("INVALID_STATE", "Only an issued invoice can be claimed", 409);
    if (claimed.gt(new Decimal(inv.total.toString()).minus(inv.creditedTotal.toString()))) throw new DomainError("VALIDATION_FAILED", "The claim is for more than the invoice is worth", 400, [{ path: "claimedAmount", message: "More than the invoice" }]);
    return inv;
  }

  private async attach(tx: Db, ctx: RequestContext, c: { id: string; status: ClaimStatus; claimNumber: string }, to: ClaimStatus, invoiceId: string, claimed: Decimal, noteText: string | undefined, action: string, extra: Prisma.ClaimUncheckedUpdateInput = {}, meta: Record<string, unknown> = {}) {
    try {
      return await this.move(tx, ctx, c, to, { invoiceId, claimedAmount: claimed.toFixed(2), ...extra }, { amount: claimed, note: noteText }, action, meta);
    } catch (e) {
      if (String((e as { message?: string }).message ?? "").includes("claim_one_per_invoice") || (e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "This invoice already has a claim in progress", 409);
      throw e;
    }
  }

  async raiseQuery(ctx: RequestContext, id: string, input: z.infer<typeof querySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "RAISE_QUERY");
      return this.move(tx, ctx, c, to, {}, { note: input.note }, "CLAIM_QUERY_RAISED");
    });
  }

  async resubmit(ctx: RequestContext, id: string, input: z.infer<typeof resubmitSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "RESUBMIT");
      const claimed = input.claimedAmount ?? new Decimal(c.claimedAmount!.toString());
      const base0 = c.invoiceId ? await this.coveredBase(tx, ctx, c) : null;
      if (base0) {
        const np0 = await this.nonPayableTotal(tx, ctx, c.id);
        const cap0 = this.packageCap(c);
        const most = cap0 ? Decimal.min(base0.minus(np0), cap0) : base0.minus(np0);
        if (claimed.gt(most)) throw new DomainError("VALIDATION_FAILED", `The claim is for more than can be claimed after the non-payable items and any package price (most ${fmt(Decimal.max(0, most))}); enter a lower amount`, 400, [{ path: "claimedAmount", message: "More than can be claimed" }]);
      }
      let extra: Prisma.ClaimUncheckedUpdateInput = {};
      let meta: Record<string, unknown> = {};
      if (c.invoiceId && input.claimedAmount) {
        await this.invoiceFor(tx, ctx, c.patientId, c.invoiceId, new Decimal(0));
        // A claim made under a co-pay rule keeps the calculation it was submitted with; changing the amount away from it needs a reason.
        if (c.calculatedAmount !== null) {
          const overridden = !input.claimedAmount.eq(c.calculatedAmount.toString());
          if (overridden && !input.overrideReason) throw new DomainError("VALIDATION_FAILED", "Give a reason for changing the calculated amount", 400, [{ path: "overrideReason", message: "Required" }]);
          extra = { patientShare: base0!.minus(input.claimedAmount).toFixed(2), amountOverrideReason: overridden ? input.overrideReason! : null };
          if (overridden) meta = { overridden: true, overrideReason: input.overrideReason };
        }
      }
      return this.move(tx, ctx, c, to, { ...(input.claimedAmount ? { claimedAmount: input.claimedAmount.toFixed(2) } : {}), ...extra }, { amount: claimed, note: input.note }, "CLAIM_RESUBMITTED", meta);
    });
  }

  /** The insurer's decision: approved (for an amount up to what was claimed) or rejected (with their reason). */
  async decide(ctx: RequestContext, id: string, input: z.infer<typeof decisionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (input.decision === "APPROVE") {
        if (!input.approvedAmount) throw new DomainError("VALIDATION_FAILED", "Enter the amount the insurer approved", 400, [{ path: "approvedAmount", message: "Required" }]);
        const to = this.step(c, "DECIDE", "APPROVED");
        if (input.approvedAmount.gt(c.claimedAmount!.toString())) throw new DomainError("VALIDATION_FAILED", "The insurer cannot approve more than was claimed", 400, [{ path: "approvedAmount", message: "More than claimed" }]);
        return this.move(tx, ctx, c, to, { approvedAmount: input.approvedAmount.toFixed(2) }, { amount: input.approvedAmount, note: input.reason }, "CLAIM_APPROVED");
      }
      if (!input.reason) throw new DomainError("VALIDATION_FAILED", "Enter the reason the insurer gave", 400, [{ path: "reason", message: "Required" }]);
      const to = this.step(c, "DECIDE", "REJECTED");
      return this.move(tx, ctx, c, to, { closeReason: input.reason }, { note: input.reason }, "CLAIM_REJECTED");
    });
  }

  /**
   * Money received from the insurer. It is posted as a bank-transfer payment on the invoice in the same transaction (so the invoice's balance falls by exactly this),
   * recorded against the claim, and the claim is settled when the approved amount has been received. A retry with the same Idempotency-Key replays.
   */
  async settle(ctx: RequestContext, id: string, input: z.infer<typeof settleSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for settlements", 400);
    return this.idempotency.run(ctx.tenantId, `CLAIM_SETTLE:${id}`, key, input, async (tx) => {
      const c = await this.lock(tx, ctx, id);
      this.step(c, "SETTLE", "APPROVED");
      const approved = new Decimal(c.approvedAmount!.toString());
      const left = approved.minus(c.settledAmount.toString());
      const tds = input.tdsAmount ?? new Decimal(0);
      const both = input.amount.plus(tds);
      if (both.gt(left)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The insurer approved ${fmt(approved)}; only ${fmt(left)} is still to be received`, 409, { outstanding: fmt(left) });
      // The money goes against the claim's invoices in order, the main invoice first, each up to what it still owes. Tax deducted at source is posted as an
      // "other" payment marked TDS, so every invoice shows it as paid; it is not cash (reports show it under other payments).
      const links = await tx.claimInvoice.findMany({ where: { tenantId: ctx.tenantId, claimId: c.id }, orderBy: { createdAt: "asc" }, select: { invoiceId: true } });
      let cash = input.amount; let tax = tds; let first: { receiptId: string; receiptNumber: string } | null = null;
      for (const invoiceId of [c.invoiceId!, ...links.map((l) => l.invoiceId)]) {
        if (cash.lte(0) && tax.lte(0)) break;
        const inv = await this.ledger.lock(tx, ctx, invoiceId);
        const due = balanceDue(inv);
        if (due.lte(0)) continue;
        const takeCash = Decimal.min(cash, due);
        const takeTax = Decimal.min(tax, due.minus(takeCash));
        if (takeCash.plus(takeTax).lte(0)) continue;
        const tenders = [...(takeCash.gt(0) ? [{ method: "BANK_TRANSFER" as const, amount: takeCash, reference: input.reference }] : []), ...(takeTax.gt(0) ? [{ method: "OTHER" as const, amount: takeTax, reference: `TDS ${input.reference}` }] : [])];
        const r = await this.ledger.receive(tx, ctx, inv, tenders);
        first ??= { receiptId: r.receiptId, receiptNumber: r.receiptNumber };
        cash = cash.minus(takeCash); tax = tax.minus(takeTax);
      }
      if (cash.gt(0) || tax.gt(0) || !first) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "The invoices on this claim owe less than this payment", 409);
      const r = first;
      await tx.claimSettlement.create({ data: { tenantId: ctx.tenantId, claimId: c.id, amount: input.amount.toFixed(2), tdsAmount: tds.toFixed(2), reference: input.reference, receivedOn: new Date(input.receivedOn), receiptId: r.receiptId, createdById: ctx.userId } });
      const total = new Decimal(c.settledAmount.toString()).plus(both);
      const done = total.eq(approved);
      const to: ClaimStatus = done ? "SETTLED" : "APPROVED";
      await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { settledAmount: total.toFixed(2), status: to } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: "APPROVED", toStatus: to, amount: input.amount.toFixed(2), note: `Received ${input.reference}${tds.gt(0) ? `; tax deducted at source ${fmt(tds)}` : ""}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_SETTLEMENT_RECEIVED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, amount: fmt(input.amount), ...(tds.gt(0) ? { tds: fmt(tds) } : {}), settled: fmt(total), receiptNumber: r.receiptNumber, status: to } });
      return { id: c.id, status: to, settledAmount: fmt(total), outstanding: fmt(approved.minus(total)), receiptNumber: r.receiptNumber };
    });
  }

  /** Closing ends the claim: withdrawn, or written off short of what was approved. The reason is kept. */
  async close(ctx: RequestContext, id: string, input: z.infer<typeof closeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "CLOSE");
      return this.move(tx, ctx, c, to, { closeReason: input.reason }, { note: input.reason }, "CLAIM_CLOSED");
    });
  }

  /** Receivable from insurers: approved and not yet received, and what is waiting on a decision, by insurer. */
  async summary(ctx: RequestContext) {
    const rows = await this.prisma.claim.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["SUBMITTED", "QUERY", "APPROVED"] } }, select: { status: true, claimedAmount: true, approvedAmount: true, settledAmount: true, policy: { select: { insurer: { select: { id: true, name: true } } } } }, take: 5000 });
    const by = new Map<string, { insurerId: string; insurer: string; waiting: Decimal; toReceive: Decimal; claims: number }>();
    for (const r of rows) {
      const e = by.get(r.policy.insurer.id) ?? { insurerId: r.policy.insurer.id, insurer: r.policy.insurer.name, waiting: new Decimal(0), toReceive: new Decimal(0), claims: 0 };
      if (r.status === "APPROVED") e.toReceive = e.toReceive.plus(new Decimal(r.approvedAmount!.toString()).minus(r.settledAmount.toString()));
      else e.waiting = e.waiting.plus(r.claimedAmount?.toString() ?? 0);
      e.claims += 1;
      by.set(e.insurerId, e);
    }
    return [...by.values()].map((e) => ({ insurerId: e.insurerId, insurer: e.insurer, claims: e.claims, waitingForDecision: fmt(e.waiting), toReceive: fmt(e.toReceive) })).sort((a, b) => a.insurer.localeCompare(b.insurer));
  }
}
