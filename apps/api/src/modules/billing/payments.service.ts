import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "./billing.domain";
import { InvoicesService } from "./invoices.service";
import { LedgerService } from "./ledger.service";
import { amount } from "./money.schema";

const method = z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]);
const reference = z.string().trim().min(4).max(60);

export const payInvoiceSchema = z.object({
  payments: z.array(z.object({ method, amount: amount({ positive: true }), reference: reference.optional() }).strict()).min(1).max(6),
}).strict();

export const refundSchema = z.object({ method, amount: amount({ positive: true }), reason: z.string().trim().min(5).max(240), reference: reference.optional() }).strict();
export const creditNoteSchema = z.object({ amount: amount({ positive: true }), reason: z.string().trim().min(5).max(240) }).strict();

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Takes a (possibly split) payment and returns the receipt. The Idempotency-Key is mandatory: a double-click or
   * network retry replays the original receipt instead of charging twice.
   */
  async pay(ctx: RequestContext, invoiceId: string, input: z.infer<typeof payInvoiceSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for payments", 400);
    return this.idempotency.run(ctx.tenantId, `PAYMENT:${invoiceId}`, key, input, async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, invoiceId);
      const r = await this.ledger.receive(tx, ctx, inv, input.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? null })));
      return { receipt: await this.receiptView(tx, ctx, r.receiptId), invoice: await this.invoices.view(tx, ctx, invoiceId) };
    });
  }

  async refund(ctx: RequestContext, invoiceId: string, input: z.infer<typeof refundSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for refunds", 400);
    return this.idempotency.run(ctx.tenantId, `REFUND:${invoiceId}`, key, input, async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, invoiceId);
      const out = await this.ledger.refund(tx, ctx, inv, { method: input.method, amount: input.amount, reason: input.reason, reference: input.reference ?? null });
      await this.ledger.settle(tx, ctx, inv, { refundedTotal: out.refundedTotal });
      return { refund: { id: out.row.id, refundNumber: out.row.refundNumber, method: out.row.method, amount: fmt(out.row.amount), reason: out.row.reason, createdAt: out.row.createdAt }, invoice: await this.invoices.view(tx, ctx, invoiceId) };
    });
  }

  async creditNote(ctx: RequestContext, invoiceId: string, input: z.infer<typeof creditNoteSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for credit notes", 400);
    return this.idempotency.run(ctx.tenantId, `CREDIT:${invoiceId}`, key, input, async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, invoiceId);
      const out = await this.ledger.credit(tx, ctx, inv, input);
      return { creditNote: { id: out.row.id, creditNoteNumber: out.row.creditNoteNumber, amount: fmt(out.row.amount), reason: out.row.reason, createdAt: out.row.createdAt }, invoice: await this.invoices.view(tx, ctx, invoiceId) };
    });
  }

  async getReceipt(ctx: RequestContext, receiptId: string) {
    return this.receiptView(this.prisma, ctx, receiptId);
  }

  private async receiptView(db: Db, ctx: RequestContext, receiptId: string) {
    const r = await db.receipt.findFirst({
      where: { id: receiptId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { payments: { orderBy: { method: "asc" } }, invoice: { select: { invoiceNumber: true, patientId: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } } } },
    });
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const cashier = await db.user.findFirst({ where: { id: r.receivedById, tenantId: ctx.tenantId }, select: { fullName: true } });
    return {
      id: r.id, receiptNumber: r.receiptNumber, total: fmt(r.total), receivedAt: r.receivedAt, invoiceId: r.invoiceId, invoiceNumber: r.invoice.invoiceNumber,
      patientName: [r.invoice.patient.firstName, r.invoice.patient.lastName].filter(Boolean).join(" "), mrn: r.invoice.patient.identifiers[0]?.value ?? null,
      receivedBy: cashier?.fullName ?? null, payments: r.payments.map((p) => ({ method: p.method, amount: fmt(p.amount), reference: p.reference })),
    };
  }
}
