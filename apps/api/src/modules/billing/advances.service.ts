import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { NumberingService } from "../numbering/numbering.service";
import { chartPatientIds } from "../patients/patient-links";
import { balanceDue, fmt } from "./billing.domain";
import { InvoicesService } from "./invoices.service";
import { LedgerService, type Method } from "./ledger.service";
import { amount } from "./money.schema";
import { feePaid, feeState } from "../appointments/booking-fee";
import { PaymentLinksService } from "../appointments/payment-links.service";

const method = z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]);
const reference = z.string().trim().min(4).max(60);

export const takeAdvanceSchema = z.object({
  tenders: z.array(z.object({ method, amount: amount({ positive: true }), reference: reference.optional() }).strict()).min(1).max(6),
  note: z.string().trim().max(240).optional(),
}).strict();
export const applyAdvanceSchema = z.object({ amount: amount({ positive: true }) }).strict();
export const refundAdvanceSchema = z.object({ method, amount: amount({ positive: true }), reason: z.string().trim().min(5).max(240), reference: reference.optional() }).strict();

const ZERO = new Decimal(0);
const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

interface DepositRow { id: string; amount: Decimal; used: Decimal; returned: Decimal; refunded: Decimal }
/** What is left: received, minus what paid bills, plus what came back when those bills were refunded, minus what was given back to the patient. */
const balanceOf = (d: DepositRow) => d.amount.minus(d.used).plus(d.returned).minus(d.refunded);

/**
 * Advance payments (docs/advance-payments.md): money taken before it is billed. It is owed back to the patient until it is applied to an
 * issued invoice, so it is kept apart from invoices and receipts. Using it pays the invoice through an ordinary receipt (method OTHER) whose
 * payment line points back at the advance, so invoice totals, statuses and receipts work exactly as before and reports do not count the money twice.
 */
@Injectable()
export class AdvancesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService, private readonly numbering: NumberingService, private readonly invoices: InvoicesService,
    private readonly paymentLinks: PaymentLinksService,
  ) {}

  // ───── take ─────

  /** `forAppointment` makes the advance the booking fee of that appointment (docs/booking-fee.md): it must cover what is still due. */
  async take(ctx: RequestContext, patientId: string, input: z.infer<typeof takeAdvanceSchema>, key: string | undefined, forAppointment?: string) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for advance payments", 400);
    return this.idempotency.run(ctx.tenantId, forAppointment ? `BOOKING_FEE:${forAppointment}` : `ADVANCE:${patientId}`, key, input, async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true, status: true, mergedIntoId: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (patient.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Take the advance on the real patient.", 409, { mergedIntoId: patient.mergedIntoId });
      if (patient.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This patient record is inactive", 409);
      for (const t of input.tenders) {
        if (t.method !== "CASH" && (!t.reference || t.reference.length < 4)) {
          throw new DomainError("VALIDATION_FAILED", `A reference (transaction id / last digits) is required for ${t.method.replace("_", " ").toLowerCase()} payments`, 400, [{ path: "tenders", message: "Reference required" }]);
        }
      }
      const total = input.tenders.reduce((a, t) => a.plus(t.amount), ZERO);
      if (forAppointment) await this.assertCoversBookingFee(tx, ctx, patientId, forAppointment, total);
      const shiftId = input.tenders.some((t) => t.method === "CASH") ? await this.ledger.shiftForCash(tx, ctx, "taking") : await this.ledger.openShift(tx, ctx);
      const receiptNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "RECEIPT");
      const dep = await tx.advanceDeposit.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, receiptNumber, amount: total.toFixed(2), note: input.note ?? null, appointmentId: forAppointment ?? null, receivedById: ctx.userId, shiftId },
      });
      await tx.advanceTender.createMany({ data: input.tenders.map((t) => ({ tenantId: ctx.tenantId, depositId: dep.id, method: t.method, amount: t.amount.toFixed(2), reference: t.reference ?? null })) });
      if (forAppointment) await this.paymentLinks.close(tx, ctx.tenantId, forAppointment, "PAID"); // the fee is covered: the deadline no longer applies
      await this.audit.record(tx, actorOf(ctx), {
        action: "ADVANCE_RECEIVED", entityType: "AdvanceDeposit", entityId: dep.id,
        metadata: { patientId, receiptNumber, total: fmt(total), methods: input.tenders.map((t) => t.method), ...(forAppointment ? { bookingFeeFor: forAppointment } : {}) },
      });
      return this.view(tx, ctx, dep.id);
    });
  }

  /** The appointment must be this patient's, not yet checked in, carry an unpaid fee, and the payment must cover what is still due. */
  private async assertCoversBookingFee(tx: Db, ctx: RequestContext, patientId: string, appointmentId: string, total: Decimal): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Appointment" WHERE id = ${appointmentId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    const appt = locked.length ? await tx.appointment.findFirst({ where: { id: appointmentId, tenantId: ctx.tenantId, patientId } }) : null;
    if (!appt) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (appt.bookingFee === null) throw new DomainError("INVALID_STATE", "This appointment has no booking fee", 409);
    if (appt.feeSkippedAt) throw new DomainError("INVALID_STATE", "The booking fee of this appointment was skipped", 409);
    if (appt.status !== "BOOKED") throw new DomainError("APPOINTMENT_INVALID_STATE", "The booking fee can only be taken before check-in", 409);
    const deposits = await tx.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, appointmentId }, select: { amount: true, refunds: { select: { amount: true } } } });
    const state = feeState(appt, feePaid(deposits));
    if (state.status === "PAID") throw new DomainError("INVALID_STATE", "The booking fee has already been paid", 409);
    if (total.lt(state.due)) throw new DomainError("INVALID_AMOUNT", `The booking fee still due is ${state.due}`, 409, { due: state.due });
  }

  // ───── use ─────

  /** Pays an issued invoice from the patient's advances, oldest first. */
  async apply(ctx: RequestContext, invoiceId: string, input: z.infer<typeof applyAdvanceSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for advance payments", 400);
    return this.idempotency.run(ctx.tenantId, `ADVANCE_USE:${invoiceId}`, key, input, async (tx) => {
      const r = await this.applyInTx(tx, ctx, invoiceId, input.amount);
      return { ...r, invoice: await this.invoices.view(tx, ctx, invoiceId) };
    });
  }

  /**
   * Pays an issued invoice from advances inside the caller's transaction. `onlyForAppointment` limits it to that appointment's booking fee
   * (used to settle a cancellation charge from the fee the patient paid for that booking).
   */
  async applyInTx(tx: Db, ctx: RequestContext, invoiceId: string, amount: Decimal, onlyForAppointment?: string) {
    const inv = await this.ledger.lock(tx, ctx, invoiceId);
    const chart = await chartPatientIds(tx, ctx.tenantId, inv.patientId);
    if (!chart) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const deposits = await this.lockedDeposits(tx, ctx, chart, onlyForAppointment);
    const available = deposits.reduce((a, d) => a.plus(balanceOf(d)), ZERO);
    if (available.lte(0)) throw new DomainError("INSUFFICIENT_ADVANCE", "This patient has no advance left to use", 409, { available: fmt(ZERO) });
    if (amount.gt(available)) throw new DomainError("INSUFFICIENT_ADVANCE", `Only ${fmt(available)} of advance is available`, 409, { available: fmt(available) });
    // receive() checks the invoice state and that the amount does not exceed what is due.
    const due = balanceDue(inv);
    if (amount.gt(due) && due.gt(0)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The amount of ${fmt(amount)} exceeds the balance due of ${fmt(due)}`, 409, { balanceDue: fmt(due) });

    let left = amount;
    const parts: { id: string; depositId: string; amount: Decimal }[] = [];
    for (const d of deposits) {
      if (left.lte(0)) break;
      const take = Decimal.min(left, balanceOf(d));
      if (take.lte(0)) continue;
      parts.push({ id: randomUUID(), depositId: d.id, amount: take });
      left = left.minus(take);
    }
    const label = await tx.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, id: { in: parts.map((p) => p.depositId) } }, select: { id: true, receiptNumber: true } });
    const numberOf = new Map(label.map((l) => [l.id, l.receiptNumber]));
    const r = await this.ledger.receive(tx, ctx, inv, parts.map((p) => ({ method: "OTHER" as Method, amount: p.amount, reference: `ADV-${numberOf.get(p.depositId)}`, advanceUseId: p.id })));
    await tx.advanceUse.createMany({ data: parts.map((p) => ({ id: p.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, depositId: p.depositId, invoiceId, receiptId: r.receiptId, amount: p.amount.toFixed(2), appliedById: ctx.userId })) });
    await this.audit.record(tx, actorOf(ctx), {
      action: "ADVANCE_APPLIED", entityType: "Invoice", entityId: invoiceId,
      metadata: { receiptId: r.receiptId, receiptNumber: r.receiptNumber, total: fmt(amount), deposits: parts.map((p) => ({ depositId: p.depositId, amount: fmt(p.amount) })), invoiceStatus: r.invoiceStatus },
    });
    return { receiptId: r.receiptId, receiptNumber: r.receiptNumber, applied: fmt(amount) };
  }

  // ───── give back ─────

  async refund(ctx: RequestContext, depositId: string, input: z.infer<typeof refundAdvanceSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for advance refunds", 400);
    return this.idempotency.run(ctx.tenantId, `ADVANCE_REFUND:${depositId}`, key, input, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "AdvanceDeposit" WHERE id = ${depositId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const [d] = await this.rows(tx, ctx, [depositId]);
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const bal = balanceOf(d);
      if (input.amount.gt(bal)) throw new DomainError("REFUND_EXCEEDS_PAID", `Only ${fmt(bal)} of this advance is left to give back`, 409, { refundable: fmt(bal) });
      if (input.method !== "CASH" && (!input.reference || input.reference.length < 4)) {
        throw new DomainError("VALIDATION_FAILED", "A reference is required for non-cash refunds", 400, [{ path: "reference", message: "Reference required" }]);
      }
      // Like invoice refunds: a method can only be returned up to what was taken through it.
      const [tendered, given] = await Promise.all([
        tx.advanceTender.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, depositId }, _sum: { amount: true } }),
        tx.advanceRefund.groupBy({ by: ["method"], where: { tenantId: ctx.tenantId, depositId }, _sum: { amount: true } }),
      ]);
      const room = dec(tendered.find((x) => x.method === input.method)?._sum.amount).minus(dec(given.find((x) => x.method === input.method)?._sum.amount));
      if (input.amount.gt(room)) throw new DomainError("REFUND_EXCEEDS_PAID", `Only ${fmt(Decimal.max(ZERO, room))} of this advance was received by ${input.method.replace("_", " ").toLowerCase()}; give it back by the original method`, 409);
      const shiftId = input.method === "CASH" ? await this.ledger.shiftForCash(tx, ctx, "refunding") : await this.ledger.openShift(tx, ctx);
      const refundNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "REFUND");
      const row = await tx.advanceRefund.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, depositId, refundNumber, method: input.method, amount: input.amount.toFixed(2), reason: input.reason, reference: input.reference ?? null, createdById: ctx.userId, shiftId },
      });
      await this.audit.record(tx, actorOf(ctx), {
        action: "ADVANCE_REFUNDED", entityType: "AdvanceDeposit", entityId: depositId,
        metadata: { refundId: row.id, refundNumber, amount: fmt(input.amount), method: input.method, reason: input.reason },
      });
      return { refund: { id: row.id, refundNumber, method: row.method, amount: fmt(row.amount), reason: row.reason, createdAt: row.createdAt }, advance: await this.view(tx, ctx, depositId) };
    });
  }

  // ───── read ─────

  /** A patient's advances at this facility, including those taken on a merged duplicate of the same person. */
  async listForPatient(ctx: RequestContext, patientId: string) {
    const chart = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!chart) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const ids = (await this.prisma.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: { in: chart } }, orderBy: [{ receivedAt: "desc" }, { id: "asc" }], take: 100, select: { id: true } })).map((x) => x.id);
    const items = await Promise.all(ids.map((id) => this.view(this.prisma, ctx, id)));
    return { items, balance: fmt(items.reduce((a, i) => a.plus(i.balance), ZERO)) };
  }

  /** The appointment (at this facility) a booking fee is being taken for. */
  async appointmentOwner(ctx: RequestContext, appointmentId: string) {
    const a = await this.prisma.appointment.findFirst({ where: { id: appointmentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
    if (!a) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return a;
  }

  async get(ctx: RequestContext, depositId: string) {
    return this.view(this.prisma, ctx, depositId);
  }

  // ───── internals ─────

  private async rows(db: Db, ctx: RequestContext, ids: string[]): Promise<DepositRow[]> {
    const [deps, uses, returns, refunds] = await Promise.all([
      db.advanceDeposit.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, amount: true } }),
      db.advanceUse.groupBy({ by: ["depositId"], where: { tenantId: ctx.tenantId, depositId: { in: ids } }, _sum: { amount: true } }),
      db.advanceReturn.groupBy({ by: ["depositId"], where: { tenantId: ctx.tenantId, depositId: { in: ids } }, _sum: { amount: true } }),
      db.advanceRefund.groupBy({ by: ["depositId"], where: { tenantId: ctx.tenantId, depositId: { in: ids } }, _sum: { amount: true } }),
    ]);
    return deps.map((d) => ({ id: d.id, amount: dec(d.amount), used: dec(uses.find((u) => u.depositId === d.id)?._sum.amount), returned: dec(returns.find((u) => u.depositId === d.id)?._sum.amount), refunded: dec(refunds.find((r) => r.depositId === d.id)?._sum.amount) }));
  }

  /** The patient's advances at this facility with something left, oldest first, row-locked so two applications cannot spend the same money. */
  private async lockedDeposits(tx: Db, ctx: RequestContext, chart: string[], onlyForAppointment?: string): Promise<DepositRow[]> {
    const locked = onlyForAppointment
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "AdvanceDeposit"
          WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "appointmentId" = ${onlyForAppointment}::uuid
          ORDER BY "receivedAt", id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "AdvanceDeposit"
          WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND "patientId" = ANY(${chart}::uuid[])
          ORDER BY "receivedAt", id FOR UPDATE`;
    const ids = locked.map((l) => l.id);
    const rows = await this.rows(tx, ctx, ids);
    return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is DepositRow => !!r && balanceOf(r).gt(0));
  }

  private async view(db: Db, ctx: RequestContext, depositId: string) {
    const d = await db.advanceDeposit.findFirst({
      where: { id: depositId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: {
        tenders: { orderBy: { method: "asc" } },
        uses: { orderBy: { appliedAt: "asc" }, select: { id: true, invoiceId: true, receiptId: true, amount: true, appliedAt: true, invoice: { select: { invoiceNumber: true } } } },
        refunds: { orderBy: { createdAt: "asc" }, select: { id: true, refundNumber: true, method: true, amount: true, reason: true, createdAt: true } },
        returns: { orderBy: { createdAt: "asc" }, select: { id: true, invoiceId: true, amount: true, createdAt: true, invoice: { select: { invoiceNumber: true } } } },
        patient: { select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
      },
    });
    if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const user = await db.user.findFirst({ where: { id: d.receivedById, tenantId: ctx.tenantId }, select: { fullName: true } });
    const used = d.uses.reduce((a, u) => a.plus(dec(u.amount)), ZERO);
    const refunded = d.refunds.reduce((a, r) => a.plus(dec(r.amount)), ZERO);
    const returned = d.returns.reduce((a, r) => a.plus(dec(r.amount)), ZERO);
    return {
      id: d.id, receiptNumber: d.receiptNumber, patientId: d.patientId, receivedAt: d.receivedAt, receivedBy: user?.fullName ?? null, note: d.note,
      patientName: [d.patient.firstName, d.patient.lastName].filter(Boolean).join(" "), mrn: d.patient.identifiers[0]?.value ?? null,
      amount: fmt(d.amount), used: fmt(used), returned: fmt(returned), refunded: fmt(refunded), balance: fmt(dec(d.amount).minus(used).plus(returned).minus(refunded)),
      tenders: d.tenders.map((t) => ({ method: t.method, amount: fmt(t.amount), reference: t.reference })),
      uses: d.uses.map((u) => ({ id: u.id, invoiceId: u.invoiceId, invoiceNumber: u.invoice.invoiceNumber, receiptId: u.receiptId, amount: fmt(u.amount), appliedAt: u.appliedAt })),
      returns: d.returns.map((r) => ({ id: r.id, invoiceId: r.invoiceId, invoiceNumber: r.invoice.invoiceNumber, amount: fmt(r.amount), createdAt: r.createdAt })),
      refunds: d.refunds.map((r) => ({ id: r.id, refundNumber: r.refundNumber, method: r.method, amount: fmt(r.amount), reason: r.reason, createdAt: r.createdAt })),
    };
  }
}
