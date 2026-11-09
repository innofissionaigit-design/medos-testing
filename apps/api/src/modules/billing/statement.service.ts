import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { chartPatientIds } from "../patients/patient-links";
import { fmt } from "./billing.domain";

export type EntryKind =
  | "BILL" | "BILL_CANCELLED" | "CREDIT_NOTE" | "PAYMENT" | "PAID_FROM_ADVANCE" | "REFUND" | "REFUND_TO_ADVANCE"
  | "ADVANCE_RECEIVED" | "BOOKING_FEE_RECEIVED" | "ADVANCE_GIVEN_BACK" | "BOOKING_FEE_GIVEN_BACK";

export interface StatementEntry {
  at: Date; kind: EntryKind; reference: string | null; description: string;
  /** Amount charged to the patient, or money paid back out to the patient. */
  debit: string;
  /** Money received from the patient, or a charge taken back (credit note, cancelled bill). */
  credit: string;
  /** Running balance after this entry: positive = the patient owes the hospital; negative = the hospital holds the patient's money (advance). */
  balance: string;
  invoiceId: string | null;
}

const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

/**
 * The patient's account statement (docs/patient-ledger.md): every money event in date order, as debits and credits with a running balance, the way a
 * hospital reconciles a patient account. Built from the ledger tables, never stored, so it always agrees with them. A transfer from the patient's
 * advance to a bill moves no money and is listed with zero amounts, so the balance is not counted twice.
 */
@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  async forPatient(ctx: RequestContext, patientId: string) {
    const chart = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!chart) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [invoices, receipts, refunds, credits, deposits, advanceRefunds] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenantId: t, facilityId: f, patientId: { in: chart }, issuedAt: { not: null } },
        select: { id: true, invoiceNumber: true, kind: true, notes: true, total: true, creditedTotal: true, issuedAt: true, cancelledAt: true, status: true, lines: { select: { sourceType: true }, take: 1 } },
      }),
      this.prisma.receipt.findMany({ where: { tenantId: t, facilityId: f, invoice: { patientId: { in: chart } } }, select: { id: true, receiptNumber: true, receivedAt: true, invoiceId: true, invoice: { select: { invoiceNumber: true } }, payments: { select: { method: true, amount: true, advanceUseId: true } } } }),
      this.prisma.refund.findMany({ where: { tenantId: t, facilityId: f, invoice: { patientId: { in: chart } } }, select: { id: true, refundNumber: true, createdAt: true, amount: true, advanceReturned: true, method: true, reason: true, invoiceId: true, cancelsInvoice: true, invoice: { select: { invoiceNumber: true } } } }),
      this.prisma.creditNote.findMany({ where: { tenantId: t, facilityId: f, invoice: { patientId: { in: chart } } }, select: { id: true, creditNoteNumber: true, createdAt: true, amount: true, reason: true, invoiceId: true, invoice: { select: { invoiceNumber: true } } } }),
      this.prisma.advanceDeposit.findMany({ where: { tenantId: t, facilityId: f, patientId: { in: chart } }, select: { id: true, receiptNumber: true, receivedAt: true, amount: true, appointmentId: true, appointment: { select: { startAt: true } }, tenders: { select: { method: true } } } }),
      this.prisma.advanceRefund.findMany({ where: { tenantId: t, facilityId: f, deposit: { patientId: { in: chart } } }, select: { id: true, refundNumber: true, createdAt: true, amount: true, method: true, reason: true, deposit: { select: { receiptNumber: true, appointmentId: true, appointment: { select: { status: true } } } } } }),
    ]);

    const raw: Omit<StatementEntry, "balance">[] = [];
    const methods = (xs: { method: string }[]) => [...new Set(xs.map((x) => x.method.replace("_", " ").toLowerCase()))].join(" + ");
    const zero = "0.00";
    for (const i of invoices) {
      const label = i.lines[0]?.sourceType === "APPOINTMENT_CANCELLATION" ? "Cancellation charge" : `${i.kind.charAt(0)}${i.kind.slice(1).toLowerCase()} bill`;
      raw.push({ at: i.issuedAt as Date, kind: "BILL", reference: i.invoiceNumber, description: label, debit: fmt(i.total), credit: zero, invoiceId: i.id });
      if (i.cancelledAt && (i.status === "CANCELLED" || i.status === "REFUNDED")) {
        const reversed = D(i.total).minus(D(i.creditedTotal));
        if (reversed.gt(0)) raw.push({ at: i.cancelledAt, kind: "BILL_CANCELLED", reference: i.invoiceNumber, description: "Bill cancelled: the charge is reversed", debit: zero, credit: fmt(reversed), invoiceId: i.id });
      }
    }
    for (const c of credits) raw.push({ at: c.createdAt, kind: "CREDIT_NOTE", reference: c.creditNoteNumber, description: `Credit note on ${c.invoice.invoiceNumber ?? "bill"}: ${c.reason}`, debit: zero, credit: fmt(c.amount), invoiceId: c.invoiceId });
    for (const r of receipts) {
      const cash = r.payments.filter((p) => !p.advanceUseId);
      const fromAdvance = r.payments.filter((p) => p.advanceUseId).reduce((a, p) => a.plus(D(p.amount)), new Decimal(0));
      const received = cash.reduce((a, p) => a.plus(D(p.amount)), new Decimal(0));
      if (received.gt(0)) raw.push({ at: r.receivedAt, kind: "PAYMENT", reference: r.receiptNumber, description: `Payment for ${r.invoice.invoiceNumber ?? "bill"} (${methods(cash)})`, debit: zero, credit: fmt(received), invoiceId: r.invoiceId });
      if (fromAdvance.gt(0)) raw.push({ at: r.receivedAt, kind: "PAID_FROM_ADVANCE", reference: r.receiptNumber, description: `${fmt(fromAdvance)} of ${r.invoice.invoiceNumber ?? "bill"} paid from the patient's advance (no money moved)`, debit: zero, credit: zero, invoiceId: r.invoiceId });
    }
    for (const r of refunds) {
      const out = D(r.amount).minus(D(r.advanceReturned));
      if (out.gt(0)) raw.push({ at: r.createdAt, kind: "REFUND", reference: r.refundNumber, description: `Refund on ${r.invoice.invoiceNumber ?? "bill"} (${r.method.replace("_", " ").toLowerCase()})${r.cancelsInvoice ? ", bill cancelled" : ""}: ${r.reason}`, debit: fmt(out), credit: zero, invoiceId: r.invoiceId });
      if (D(r.advanceReturned).gt(0)) raw.push({ at: r.createdAt, kind: "REFUND_TO_ADVANCE", reference: r.refundNumber, description: `${fmt(r.advanceReturned)} of ${r.invoice.invoiceNumber ?? "bill"} returned to the patient's advance (no money moved)`, debit: zero, credit: zero, invoiceId: r.invoiceId });
    }
    for (const d of deposits) {
      const booking = !!d.appointmentId;
      raw.push({
        at: d.receivedAt, kind: booking ? "BOOKING_FEE_RECEIVED" : "ADVANCE_RECEIVED", reference: d.receiptNumber,
        description: booking ? `Booking fee received${d.appointment ? ` for the appointment of ${d.appointment.startAt.toISOString().slice(0, 10)}` : ""} (${methods(d.tenders)})` : `Advance received (${methods(d.tenders)})`,
        debit: zero, credit: fmt(d.amount), invoiceId: null,
      });
    }
    for (const r of advanceRefunds) {
      const booking = !!r.deposit.appointmentId;
      const cancelled = r.deposit.appointment?.status === "CANCELLED";
      raw.push({
        at: r.createdAt, kind: booking ? "BOOKING_FEE_GIVEN_BACK" : "ADVANCE_GIVEN_BACK", reference: r.refundNumber,
        description: `${booking ? `Booking fee ${r.deposit.receiptNumber} given back${cancelled ? " (appointment cancelled)" : ""}` : `Advance ${r.deposit.receiptNumber} given back`} (${r.method.replace("_", " ").toLowerCase()}): ${r.reason}`,
        debit: fmt(r.amount), credit: zero, invoiceId: null,
      });
    }
    raw.sort((a, b) => a.at.getTime() - b.at.getTime());

    let balance = new Decimal(0);
    let debits = new Decimal(0);
    let creditsTotal = new Decimal(0);
    const entries: StatementEntry[] = raw.map((e) => {
      balance = balance.plus(D(e.debit)).minus(D(e.credit));
      debits = debits.plus(D(e.debit));
      creditsTotal = creditsTotal.plus(D(e.credit));
      return { ...e, balance: fmt(balance) };
    });
    return {
      entries, totals: { debit: fmt(debits), credit: fmt(creditsTotal), balance: fmt(balance) },
      position: balance.gt(0) ? "PATIENT_OWES" : balance.lt(0) ? "HELD_FOR_PATIENT" : "SETTLED",
    };
  }
}
