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
import { amount } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { nextStatus, stepAllowedForType, stepsFrom, type ClaimStatus, type ClaimStep } from "./claims.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const note = z.string().trim().min(3).max(500);
const reason = z.string().trim().min(5).max(300);

export const insurerSchema = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(["INSURER", "TPA", "GOVERNMENT", "CORPORATE"]).default("INSURER"), contact: z.string().trim().max(200).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict();
export const policySchema = z.object({
  insurerId: uuid, policyNumber: z.string().trim().min(3).max(60), memberId: z.string().trim().max(60).optional(), holderName: z.string().trim().max(120).optional(),
  validFrom: day, validTo: day, sumInsured: amount().optional(),
}).strict();
export const policyStatusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).strict();
export const createClaimSchema = z.object({ patientId: uuid, policyId: uuid, type: z.enum(["CASHLESS", "REIMBURSEMENT"]), encounterId: uuid.optional(), diagnosis: z.string().trim().max(300).optional() }).strict();
export const preauthSchema = z.object({ requestedAmount: amount({ positive: true }), note: note.optional() }).strict();
export const preauthDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), amount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
export const submitSchema = z.object({ invoiceId: uuid, claimedAmount: amount({ positive: true }), note: note.optional() }).strict();
export const querySchema = z.object({ note }).strict();
export const resubmitSchema = z.object({ note, claimedAmount: amount({ positive: true }).optional() }).strict();
export const decisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), approvedAmount: amount({ positive: true }).optional(), reason: reason.optional() }).strict();
export const settleSchema = z.object({ amount: amount({ positive: true }), reference: z.string().trim().min(4).max(60), receivedOn: day }).strict();
export const closeSchema = z.object({ reason }).strict();
export const listClaimsSchema = z.object({
  status: z.enum(["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED", "REJECTED", "SETTLED", "CLOSED"]).optional(),
  q: z.string().trim().min(2).max(60).optional(), patientId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const money = (v: Decimal.Value | null | undefined) => (v === null || v === undefined ? null : fmt(v));
const today = () => new Date(new Date().toISOString().slice(0, 10));

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

  private policyView(p: { id: string; policyNumber: string; memberId: string | null; holderName: string | null; validFrom: Date; validTo: Date; sumInsured: Prisma.Decimal | null; status: string; insurer: { id: string; name: string; kind: string } }) {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { id: p.id, policyNumber: p.policyNumber, memberId: p.memberId, holderName: p.holderName, validFrom: iso(p.validFrom), validTo: iso(p.validTo), sumInsured: money(p.sumInsured), status: p.status, insurer: p.insurer, validToday: p.status === "ACTIVE" && p.validFrom <= today() && p.validTo >= today() };
  }

  async policies(ctx: RequestContext, patientId: string) {
    const patient = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!patient) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.patientPolicy.findMany({ where: { tenantId: ctx.tenantId, patientId }, orderBy: { validTo: "desc" }, take: 50, include: { insurer: { select: { id: true, name: true, kind: true } } } });
    return rows.map((p) => this.policyView(p));
  }

  async addPolicy(ctx: RequestContext, patientId: string, input: z.infer<typeof policySchema>) {
    if (input.validFrom > input.validTo) throw new DomainError("VALIDATION_FAILED", "The policy ends before it starts", 400, [{ path: "validTo", message: "Before the start date" }]);
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
      const insurer = await tx.insurer.findFirst({ where: { id: input.insurerId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient || !insurer) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      try {
        const p = await tx.patientPolicy.create({
          data: { tenantId: ctx.tenantId, patientId, insurerId: input.insurerId, policyNumber: input.policyNumber, memberId: input.memberId ?? null, holderName: input.holderName ?? null, validFrom: new Date(input.validFrom), validTo: new Date(input.validTo), sumInsured: input.sumInsured?.toFixed(2) ?? null, createdById: ctx.userId },
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
        events: { orderBy: { at: "asc" } }, settlements: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set([...c.events.map((e) => e.actorId), ...c.settlements.map((s) => s.createdById)])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const status = c.status as ClaimStatus;
    return {
      id: c.id, claimNumber: c.claimNumber, type: c.type, status, diagnosis: c.diagnosis, closeReason: c.closeReason, encounterId: c.encounterId,
      patient: { id: c.patient.id, name: nameOf(c.patient), mrn: c.patient.identifiers[0]?.value ?? null }, policy: this.policyView(c.policy),
      preauthRequested: money(c.preauthRequested), preauthApproved: money(c.preauthApproved), claimedAmount: money(c.claimedAmount), approvedAmount: money(c.approvedAmount), settledAmount: money(c.settledAmount),
      outstanding: c.approvedAmount ? fmt(new Decimal(c.approvedAmount.toString()).minus(c.settledAmount.toString())) : null,
      invoice: c.invoice ? { id: c.invoice.id, invoiceNumber: c.invoice.invoiceNumber, status: c.invoice.status, total: fmt(c.invoice.total), balanceDue: fmt(balanceDue(c.invoice)) } : null,
      nextSteps: stepsFrom(status).filter((s) => stepAllowedForType(s, c.type)),
      events: c.events.map((e) => ({ at: e.at, from: e.fromStatus, to: e.toStatus, amount: money(e.amount), note: e.note, by: users.get(e.actorId) ?? null })),
      settlements: c.settlements.map((s) => ({ id: s.id, amount: fmt(s.amount), reference: s.reference, receivedOn: s.receivedOn.toISOString().slice(0, 10), by: users.get(s.createdById) ?? null, receiptId: s.receiptId })),
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

  private async move(tx: Db, ctx: RequestContext, c: { id: string; status: ClaimStatus; claimNumber: string }, to: ClaimStatus, data: Prisma.ClaimUncheckedUpdateInput, ev: { amount?: Decimal | undefined; note?: string | undefined }, action: string) {
    await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { ...data, status: to } });
    await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: c.status, toStatus: to, amount: ev.amount?.toFixed(2) ?? null, note: ev.note ?? null, actorId: ctx.userId } });
    await this.audit.record(tx, actorOf(ctx), { action, entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, from: c.status, to, ...(ev.amount ? { amount: fmt(ev.amount) } : {}) } });
    return { id: c.id, status: to };
  }

  async requestPreauth(ctx: RequestContext, id: string, input: z.infer<typeof preauthSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "REQUEST_PREAUTH");
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

  /** Submitting attaches one issued invoice and the amount claimed from the insurer (never more than the invoice is worth). */
  async submit(ctx: RequestContext, id: string, input: z.infer<typeof submitSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const to = this.step(c, "SUBMIT");
      const inv = await this.invoiceFor(tx, ctx, c.patientId, input.invoiceId, input.claimedAmount);
      return this.attach(tx, ctx, c, to, inv.id, input.claimedAmount, input.note, "CLAIM_SUBMITTED");
    });
  }

  private async invoiceFor(tx: Db, ctx: RequestContext, patientId: string, invoiceId: string, claimed: Decimal) {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId } });
    if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(inv.status)) throw new DomainError("INVALID_STATE", "Only an issued invoice can be claimed", 409);
    if (claimed.gt(new Decimal(inv.total.toString()).minus(inv.creditedTotal.toString()))) throw new DomainError("VALIDATION_FAILED", "The claim is for more than the invoice is worth", 400, [{ path: "claimedAmount", message: "More than the invoice" }]);
    return inv;
  }

  private async attach(tx: Db, ctx: RequestContext, c: { id: string; status: ClaimStatus; claimNumber: string }, to: ClaimStatus, invoiceId: string, claimed: Decimal, noteText: string | undefined, action: string) {
    try {
      return await this.move(tx, ctx, c, to, { invoiceId, claimedAmount: claimed.toFixed(2) }, { amount: claimed, note: noteText }, action);
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
      if (c.invoiceId && input.claimedAmount) await this.invoiceFor(tx, ctx, c.patientId, c.invoiceId, input.claimedAmount);
      return this.move(tx, ctx, c, to, input.claimedAmount ? { claimedAmount: input.claimedAmount.toFixed(2) } : {}, { amount: claimed, note: input.note }, "CLAIM_RESUBMITTED");
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
      if (input.amount.gt(left)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The insurer approved ${fmt(approved)}; only ${fmt(left)} is still to be received`, 409, { outstanding: fmt(left) });
      const inv = await this.ledger.lock(tx, ctx, c.invoiceId!);
      const r = await this.ledger.receive(tx, ctx, inv, [{ method: "BANK_TRANSFER", amount: input.amount, reference: input.reference }]);
      await tx.claimSettlement.create({ data: { tenantId: ctx.tenantId, claimId: c.id, amount: input.amount.toFixed(2), reference: input.reference, receivedOn: new Date(input.receivedOn), receiptId: r.receiptId, createdById: ctx.userId } });
      const total = new Decimal(c.settledAmount.toString()).plus(input.amount);
      const done = total.eq(approved);
      const to: ClaimStatus = done ? "SETTLED" : "APPROVED";
      await tx.claim.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: c.id } }, data: { settledAmount: total.toFixed(2), status: to } });
      await tx.claimEvent.create({ data: { tenantId: ctx.tenantId, claimId: c.id, fromStatus: "APPROVED", toStatus: to, amount: input.amount.toFixed(2), note: `Received ${input.reference}`, actorId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_SETTLEMENT_RECEIVED", entityType: "Claim", entityId: c.id, metadata: { claimNumber: c.claimNumber, amount: fmt(input.amount), settled: fmt(total), receiptNumber: r.receiptNumber, status: to } });
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
