import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { balanceDue, fmt } from "../billing/billing.domain";
import { LedgerService } from "../billing/ledger.service";
import { payInvoiceSchema } from "../billing/payments.service";
import { TestOrdersService } from "./test-orders.service";

export const collectSchema = z.object({
  /** The bills being collected (those shown on the patient's card). The amounts due are read from the server. */
  invoiceIds: z.array(z.string().uuid()).max(30).default([]),
  /** Visits whose tests are still to be billed: they are billed from the Cashier's saved lines in the same step, then paid with everything else. */
  billTests: z.array(z.string().uuid()).max(10).default([]),
  /** One or several ways of paying (cash, UPI, card, bank transfer, other): the same rules as paying a single bill. */
  payments: payInvoiceSchema.shape.payments,
}).strict().refine((v) => v.invoiceIds.length + v.billTests.length > 0, "Choose at least one bill");

/**
 * One collection for several of a patient's bills (the Cashier's "Collect total"). Everything happens in one transaction: either every bill gets its share
 * of the money and its own receipt, or nothing is taken. The money is spread over the bills oldest first, so a part-payment settles the earliest bills.
 */
@Injectable()
export class CashierCollectService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService, private readonly ledger: LedgerService, private readonly audit: AuditService, private readonly tests: TestOrdersService) {}

  async collect(ctx: RequestContext, patientId: string, input: z.infer<typeof collectSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for payments", 400);
    return this.idempotency.run(ctx.tenantId, `COLLECT:${patientId}`, key, input, async (tx) => {
      // Tests still to be billed are billed first, in this same transaction: if the payment is then refused, they are not billed either.
      const newInvoices: string[] = [];
      const billedTests: { encounterId: string; invoiceNumber: string | null; total: string }[] = [];
      for (const encounterId of [...new Set(input.billTests)].sort()) {
        if (!(await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        const r = await this.tests.billSavedInTx(tx, ctx, encounterId);
        if (r.invoiceId) { newInvoices.push(r.invoiceId); billedTests.push({ encounterId, invoiceNumber: r.invoiceNumber, total: r.total }); }
      }
      const ids = [...new Set([...input.invoiceIds, ...newInvoices])];
      if (ids.length === 0) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "Nothing is left to collect on these bills", 409);
      // Medicines bills (pharmacy) and tests bills only, and only this patient's, at this facility.
      const found = await tx.invoice.findMany({
        where: { id: { in: ids }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, kind: { in: ["PHARMACY", "OTHER"] } },
        select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (found.length !== ids.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      // Locked one by one in a fixed order, so two cashiers collecting overlapping bills cannot deadlock.
      const bills = [];
      for (const f of found) {
        const inv = await this.ledger.lock(tx, ctx, f.id);
        bills.push({ inv, due: inv.status === "ISSUED" || inv.status === "PARTIALLY_PAID" ? balanceDue(inv) : new Decimal(0) });
      }
      const totalDue = bills.reduce((n, b) => n.plus(b.due), new Decimal(0));
      if (totalDue.lte(0)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", "Nothing is left to collect on these bills", 409);
      const tendered = input.payments.reduce((n, p) => n.plus(p.amount), new Decimal(0));
      if (tendered.gt(totalDue)) throw new DomainError("PAYMENT_EXCEEDS_BALANCE", `The payment of ${fmt(tendered)} exceeds the total due of ${fmt(totalDue)}`, 409, { balanceDue: fmt(totalDue) });

      const pool = input.payments.map((p) => ({ method: p.method, left: new Decimal(p.amount), reference: p.reference ?? null }));
      const receipts: { invoiceId: string; invoiceNumber: string | null; receiptId: string; receiptNumber: string; amount: string; invoiceStatus: string }[] = [];
      for (const { inv, due } of bills) {
        if (due.lte(0)) continue;
        let need = due;
        const tenders: { method: (typeof pool)[number]["method"]; amount: Decimal; reference: string | null }[] = [];
        for (const t of pool) {
          if (need.lte(0)) break;
          if (t.left.lte(0)) continue;
          const take = Decimal.min(need, t.left);
          tenders.push({ method: t.method, amount: take, reference: t.reference });
          t.left = t.left.minus(take);
          need = need.minus(take);
        }
        if (tenders.length === 0) break; // the money has run out (a part-payment): the later bills stay as they are
        const r = await this.ledger.receive(tx, ctx, inv, tenders);
        receipts.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, receiptId: r.receiptId, receiptNumber: r.receiptNumber, amount: fmt(r.total), invoiceStatus: r.invoiceStatus });
      }
      await this.audit.record(tx, actorOf(ctx), {
        action: "PATIENT_PAYMENT_COLLECTED", entityType: "Patient", entityId: patientId,
        metadata: { bills: receipts.length, total: fmt(tendered), methods: [...new Set(input.payments.map((p) => p.method))] },
      });
      return { patientId, total: fmt(tendered), stillDue: fmt(totalDue.minus(tendered)), billedTests, receipts };
    });
  }
}
