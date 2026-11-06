import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { chartPatientIds } from "../patients/patient-links";
import { NumberingService } from "../numbering/numbering.service";
import { SettingsService } from "../settings/settings.service";
import { balanceDue, computeLine, computeTotals, fmt, netReceived, refundable, type LineAmounts } from "./billing.domain";
import { LedgerService, type Method } from "./ledger.service";
import { amount, percent, quantity } from "./money.schema";

const uuid = z.string().uuid();
const catalogLine = z.object({ serviceId: uuid, quantity, discountAmount: amount().optional() }).strict();
const manualLine = z.object({ description: z.string().trim().min(2).max(200), unitPrice: amount(), taxPercent: percent, quantity, discountAmount: amount().optional() }).strict();
const lineInput = z.union([catalogLine, manualLine]);
export type LineInput = z.infer<typeof lineInput>;

export const createInvoiceSchema = z.object({
  patientId: uuid, encounterId: uuid.optional(),
  kind: z.enum(["OPD", "IPD", "PHARMACY", "OTHER"]).default("OPD"),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(lineInput).min(1).max(50),
}).strict();

/** Discount given by an approver (INVOICE_DISCOUNT) on lines of a DRAFT invoice, without needing to edit the bill itself. */
export const discountInvoiceSchema = z.object({
  version: z.number().int().min(1), reason: z.string().trim().min(5).max(240),
  lines: z.array(z.object({ lineNo: z.number().int().min(1), discountAmount: amount() }).strict()).min(1).max(50),
}).strict();
export const updateInvoiceSchema = z.object({
  version: z.number().int().min(1), notes: z.string().trim().max(500).nullable().optional(), lines: z.array(lineInput).min(1).max(50),
}).strict();

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(5).max(240),
  refunds: z.array(z.object({ method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]), amount: amount({ positive: true }), reference: z.string().trim().min(4).max(60).optional() }).strict()).max(6).optional(),
}).strict();

export const listInvoicesSchema = z.object({
  patientId: uuid.optional(), encounterId: uuid.optional(),
  status: z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "CANCELLED", "REFUNDED"]).optional(),
  outstanding: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  kind: z.enum(["OPD", "IPD", "PHARMACY", "OTHER", "REGISTRATION"]).optional(),
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

interface ResolvedLine { serviceId: string | null; hsnSac: string | null; description: string; quantity: Decimal; unitPrice: Decimal; taxPercent: Decimal; discount: Decimal; amounts: LineAmounts }

const INVOICE_INCLUDE = {
  patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" as const }, select: { value: true } } } },
  lines: { orderBy: { lineNo: "asc" as const } },
  receipts: { orderBy: { receivedAt: "asc" as const }, include: { payments: { orderBy: { method: "asc" as const } } } },
  refunds: { orderBy: { createdAt: "asc" as const } },
  creditNotes: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.InvoiceInclude;
type InvoiceFull = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

export function toInvoiceView(i: InvoiceFull) {
  const money = { total: i.total, paidTotal: i.paidTotal, refundedTotal: i.refundedTotal, creditedTotal: i.creditedTotal };
  return {
    id: i.id, invoiceNumber: i.invoiceNumber, status: i.status, kind: i.kind, patientId: i.patientId, encounterId: i.encounterId,
    patientName: [i.patient.firstName, i.patient.lastName].filter(Boolean).join(" "), mrn: i.patient.identifiers[0]?.value ?? null,
    subtotal: fmt(i.subtotal), discountTotal: fmt(i.discountTotal), taxTotal: fmt(i.taxTotal), roundOff: fmt(i.roundOff), taxSplit: i.taxSplit, roundsToRupee: i.roundsToRupee,
    cgstTotal: i.taxSplit ? fmt(i.taxTotal.div(2)) : null, sgstTotal: i.taxSplit ? fmt(i.taxTotal.div(2)) : null, total: fmt(i.total),
    paidTotal: fmt(i.paidTotal), refundedTotal: fmt(i.refundedTotal), creditedTotal: fmt(i.creditedTotal),
    netReceived: fmt(netReceived(money)), balanceDue: i.status === "DRAFT" || i.status === "CANCELLED" || i.status === "REFUNDED" ? "0.00" : fmt(balanceDue(money)), refundable: fmt(refundable(money)),
    notes: i.notes, issuedAt: i.issuedAt, cancelledAt: i.cancelledAt, cancelReason: i.cancelReason, version: i.version, createdAt: i.createdAt,
    lines: i.lines.map((l) => ({
      lineNo: l.lineNo, serviceId: l.serviceId, hsnSac: l.hsnSac, description: l.description, quantity: l.quantity.toString(), unitPrice: fmt(l.unitPrice),
      discountAmount: fmt(l.discountAmount), taxPercent: fmt(l.taxPercent), taxAmount: fmt(l.taxAmount), cgstAmount: i.taxSplit ? fmt(l.taxAmount.div(2)) : null, sgstAmount: i.taxSplit ? fmt(l.taxAmount.div(2)) : null, lineTotal: fmt(l.lineTotal), sourceType: l.sourceType,
    })),
    receipts: i.receipts.map((r) => ({ id: r.id, receiptNumber: r.receiptNumber, total: fmt(r.total), receivedAt: r.receivedAt, payments: r.payments.map((p) => ({ method: p.method, amount: fmt(p.amount), reference: p.reference })) })),
    refunds: i.refunds.map((r) => ({ id: r.id, refundNumber: r.refundNumber, method: r.method, amount: fmt(r.amount), reason: r.reason, createdAt: r.createdAt, cancelsInvoice: r.cancelsInvoice })),
    creditNotes: i.creditNotes.map((c) => ({ id: c.id, creditNoteNumber: c.creditNoteNumber, amount: fmt(c.amount), reason: c.reason, createdAt: c.createdAt })),
  };
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
  ) {}

  /** How a NEW invoice treats tax and rounding, read from the facility settings. It is recorded on the invoice, which then keeps it for life. */
  async invoiceOptions(db: Db, ctx: RequestContext): Promise<{ taxSplit: boolean; roundsToRupee: boolean }> {
    const [taxSplit, roundsToRupee] = await Promise.all([
      this.settings.get(db, ctx.tenantId, ctx.facilityId, "INVOICE_TAX_SPLIT"), this.settings.get(db, ctx.tenantId, ctx.facilityId, "INVOICE_ROUND_OFF"),
    ]);
    return { taxSplit, roundsToRupee };
  }

  // ───── queries ─────

  async get(ctx: RequestContext, id: string) {
    const i = await this.prisma.invoice.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: INVOICE_INCLUDE });
    if (!i) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return toInvoiceView(i);
  }

  async list(ctx: RequestContext, q: z.infer<typeof listInvoicesSchema>) {
    const where: Prisma.InvoiceWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId,
      ...(q.patientId ? { patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, q.patientId)) ?? [q.patientId] } } : {}), ...(q.encounterId ? { encounterId: q.encounterId } : {}),
      ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}),
      ...(q.outstanding ? { status: { in: ["ISSUED", "PARTIALLY_PAID"] } } : {}),
      ...(q.q ? { invoiceNumber: { contains: q.q, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, include: INVOICE_INCLUDE, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items: rows.map(toInvoiceView), total };
  }

  // ───── draft ─────

  async create(ctx: RequestContext, input: z.infer<typeof createInvoiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (input.encounterId) {
        const enc = await tx.encounter.findFirst({ where: { id: input.encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId }, select: { id: true } });
        if (!enc) throw new DomainError("VALIDATION_FAILED", "The visit does not belong to this patient at this facility", 400);
      }
      const opts = await this.invoiceOptions(tx, ctx);
      const resolved = await this.resolveLines(tx, ctx, input.lines, opts.taxSplit);
      const totals = computeTotals(resolved.map((l) => l.amounts), { roundToRupee: opts.roundsToRupee });
      const inv = await tx.invoice.create({
        data: {
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, encounterId: input.encounterId ?? null, kind: input.kind, notes: input.notes ?? null, createdById: ctx.userId,
          taxSplit: opts.taxSplit, roundsToRupee: opts.roundsToRupee, roundOff: totals.roundOff.toFixed(2),
          subtotal: totals.subtotal.toFixed(2), discountTotal: totals.discountTotal.toFixed(2), taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2),
        },
      });
      await this.writeLines(tx, ctx, inv.id, resolved);
      await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_CREATED", entityType: "Invoice", entityId: inv.id, metadata: { lines: resolved.length, total: fmt(totals.total), kind: input.kind } });
      if (totals.discountTotal.gt(0)) await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_DISCOUNT_APPLIED", entityType: "Invoice", entityId: inv.id, metadata: { discount: fmt(totals.discountTotal) } });
      return this.view(tx, ctx, inv.id);
    });
  }

  /** Replaces the lines of a DRAFT invoice. Totals are always recomputed here; the client never supplies them. */
  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateInvoiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, id);
      if (inv.status !== "DRAFT") throw new DomainError("INVOICE_ALREADY_ISSUED", "An issued invoice cannot be edited. Use a credit note, refund or cancellation.", 409);
      if (inv.version !== input.version) throw new DomainError("STALE_VERSION", "This invoice was changed by someone else. Reload and try again.", 409, { currentVersion: inv.version });
      const resolved = await this.resolveLines(tx, ctx, input.lines, inv.taxSplit);
      const totals = computeTotals(resolved.map((l) => l.amounts), { roundToRupee: inv.roundsToRupee });
      await tx.invoiceLine.deleteMany({ where: { tenantId: ctx.tenantId, invoiceId: id } });
      await this.writeLines(tx, ctx, id, resolved);
      const res = await tx.invoice.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "DRAFT", version: input.version },
        data: {
          subtotal: totals.subtotal.toFixed(2), discountTotal: totals.discountTotal.toFixed(2), taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2), roundOff: totals.roundOff.toFixed(2),
          ...(input.notes !== undefined ? { notes: input.notes } : {}), version: { increment: 1 },
        },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "This invoice was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_DRAFT_UPDATED", entityType: "Invoice", entityId: id, metadata: { lines: resolved.length, total: fmt(totals.total) } });
      if (totals.discountTotal.gt(0)) await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_DISCOUNT_APPLIED", entityType: "Invoice", entityId: id, metadata: { discount: fmt(totals.discountTotal) } });
      return this.view(tx, ctx, id);
    });
  }

  /**
   * Sets the discount on chosen lines of a DRAFT invoice. Lines are updated in place (never rewritten) so links to the
   * charge or dispense they bill are kept; totals are recomputed here and the change is audited with before/after and reason.
   */
  async applyDiscount(ctx: RequestContext, id: string, input: z.infer<typeof discountInvoiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, id);
      if (inv.status !== "DRAFT") throw new DomainError("INVOICE_ALREADY_ISSUED", "A discount can only be given before the invoice is issued. Use a credit note instead.", 409);
      if (inv.version !== input.version) throw new DomainError("STALE_VERSION", "This invoice was changed by someone else. Reload and try again.", 409, { currentVersion: inv.version });
      const lines = await tx.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, invoiceId: id }, orderBy: { lineNo: "asc" } });
      const wanted = new Map(input.lines.map((l) => [l.lineNo, l.discountAmount]));
      if (wanted.size !== input.lines.length) throw new DomainError("VALIDATION_FAILED", "Each line can appear only once", 400, [{ path: "lines", message: "Duplicate line" }]);
      for (const n of wanted.keys()) if (!lines.some((l) => l.lineNo === n)) throw new DomainError("VALIDATION_FAILED", `Line ${n} is not on this invoice`, 400, [{ path: "lines", message: "Unknown line" }]);

      const computed = lines.map((l) => {
        const discount = wanted.get(l.lineNo) ?? new Decimal(l.discountAmount.toString());
        try {
          return { line: l, discount, amounts: computeLine({ quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountAmount: discount, taxPercent: l.taxPercent.toString() }, { split: inv.taxSplit }) };
        } catch (e) {
          throw new DomainError("INVALID_AMOUNT", `Line ${l.lineNo}: ${e instanceof RangeError ? e.message : "invalid discount"}`, 400, [{ path: "lines", message: "Invalid discount" }]);
        }
      });
      const changes: { lineNo: number; from: string; to: string }[] = [];
      for (const c of computed) {
        const before = new Decimal(c.line.discountAmount.toString());
        if (!wanted.has(c.line.lineNo) || before.eq(c.amounts.discount)) continue;
        await tx.invoiceLine.updateMany({
          where: { id: c.line.id, tenantId: ctx.tenantId },
          data: { discountAmount: c.amounts.discount.toFixed(2), taxAmount: c.amounts.tax.toFixed(2), lineTotal: c.amounts.total.toFixed(2) },
        });
        changes.push({ lineNo: c.line.lineNo, from: fmt(before), to: fmt(c.amounts.discount) });
      }
      if (changes.length === 0) throw new DomainError("VALIDATION_FAILED", "No discount was changed", 400, [{ path: "lines", message: "No change" }]);

      const totals = computeTotals(computed.map((c) => c.amounts), { roundToRupee: inv.roundsToRupee });
      const res = await tx.invoice.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "DRAFT", version: input.version },
        data: { subtotal: totals.subtotal.toFixed(2), discountTotal: totals.discountTotal.toFixed(2), taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2), roundOff: totals.roundOff.toFixed(2), version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("STALE_VERSION", "This invoice was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_DISCOUNT_APPLIED", entityType: "Invoice", entityId: id, metadata: { reason: input.reason, lines: changes, discount: fmt(totals.discountTotal), total: fmt(totals.total) } });
      return this.view(tx, ctx, id);
    });
  }

  // ───── issue ─────

  /** DRAFT -> ISSUED: assigns the number, recomputes totals from the stored lines, and freezes the invoice. */
  async issue(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, id);
      if (inv.status !== "DRAFT") throw new DomainError("INVOICE_ALREADY_ISSUED", "This invoice is already issued", 409);
      const lines = await tx.invoiceLine.findMany({ where: { tenantId: ctx.tenantId, invoiceId: id }, orderBy: { lineNo: "asc" } });
      if (lines.length === 0) throw new DomainError("VALIDATION_FAILED", "Add at least one line before issuing", 400);
      const amounts = lines.map((l) => computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount, taxPercent: l.taxPercent }, { split: inv.taxSplit }));
      const totals = computeTotals(amounts, { roundToRupee: inv.roundsToRupee });
      if (!totals.total.gt(0)) throw new DomainError("INVALID_AMOUNT", "An invoice must have a total greater than zero", 400);
      const invoiceNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "INVOICE");
      const res = await tx.invoice.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "DRAFT" },
        data: {
          status: "ISSUED", invoiceNumber, issuedAt: new Date(), issuedById: ctx.userId, version: { increment: 1 },
          subtotal: totals.subtotal.toFixed(2), discountTotal: totals.discountTotal.toFixed(2), taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2), roundOff: totals.roundOff.toFixed(2),
        },
      });
      if (res.count !== 1) throw new DomainError("INVOICE_ALREADY_ISSUED", "This invoice was issued by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_ISSUED", entityType: "Invoice", entityId: id, metadata: { invoiceNumber, total: fmt(totals.total), discount: fmt(totals.discountTotal) } });
      return this.view(tx, ctx, id);
    });
  }

  // ───── cancel ─────

  /**
   * Cancels an invoice. If money was received it must all be refunded in the same operation (by the methods it
   * came in through); the invoice then becomes REFUNDED. Nothing is deleted and the lines stay as issued.
   */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelInvoiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.ledger.lock(tx, ctx, id);
      if (inv.status === "CANCELLED" || inv.status === "REFUNDED") throw new DomainError("INVALID_STATE", "This invoice is already cancelled", 409);
      const net = netReceived(inv);
      const refunds = input.refunds ?? [];
      const refundSum = refunds.reduce((a, r) => a.plus(r.amount), new Decimal(0));

      if (inv.status === "DRAFT") {
        if (refunds.length) throw new DomainError("VALIDATION_FAILED", "A draft has no payments to refund", 400);
      } else if (net.gt(0)) {
        if (!ctx.permissions.has("PAYMENT_REFUND")) throw new DomainError("FORBIDDEN", "Cancelling an invoice with payments also requires refund permission", 403);
        if (!refundSum.equals(net)) throw new DomainError("REFUND_EXCEEDS_PAID", `Refund exactly ${fmt(net)} (the amount retained) to cancel this invoice`, 409, { required: fmt(net) });
      } else if (refunds.length) {
        throw new DomainError("VALIDATION_FAILED", "Nothing has been received on this invoice", 400);
      }

      let refundedTotal = inv.refundedTotal;
      for (const r of refunds) {
        const out = await this.ledger.refund(tx, ctx, { ...inv, refundedTotal }, { method: r.method as Method, amount: r.amount, reason: input.reason, reference: r.reference ?? null, cancelsInvoice: true }, { skipOverpaymentCheck: true });
        refundedTotal = out.refundedTotal;
      }
      const finalStatus = inv.status !== "DRAFT" && net.gt(0) ? "REFUNDED" : "CANCELLED";
      const res = await tx.invoice.updateMany({
        where: { id, tenantId: ctx.tenantId, version: inv.version },
        data: { status: finalStatus, refundedTotal: refundedTotal.toFixed(2), cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: input.reason, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The invoice was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_CANCELLED", entityType: "Invoice", entityId: id, metadata: { reason: input.reason, previousStatus: inv.status, refunded: fmt(refundSum), invoiceNumber: inv.invoiceNumber } });
      return this.view(tx, ctx, id);
    });
  }

  // ───── internal issuing ─────
  /**
   * Internal: creates and issues an invoice in the caller's transaction for operational sources (pharmacy dispense, IPD final bill).
   * Lines carry sourceType/sourceId so the same operational record can never be billed twice (unique index).
   */
  async createIssuedFromSource(
    tx: Db, ctx: RequestContext,
    input: { patientId: string; encounterId: string | null; kind: "OPD" | "IPD" | "PHARMACY" | "OTHER" | "REGISTRATION"; notes?: string; lines: { description: string; quantity: Decimal; unitPrice: Decimal; taxPercent: Decimal; sourceType: string; sourceId: string; hsnSac?: string | null }[] },
  ) {
    const opts = await this.invoiceOptions(tx, ctx);
    const amounts = input.lines.map((l) => computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: 0, taxPercent: l.taxPercent }, { split: opts.taxSplit }));
    const totals = computeTotals(amounts, { roundToRupee: opts.roundsToRupee });
    if (!totals.total.gt(0)) throw new DomainError("INVALID_AMOUNT", "An invoice must have a total greater than zero", 400);
    const inv = await tx.invoice.create({
      data: {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, encounterId: input.encounterId, kind: input.kind, notes: input.notes ?? null, createdById: ctx.userId,
        taxSplit: opts.taxSplit, roundsToRupee: opts.roundsToRupee, roundOff: totals.roundOff.toFixed(2),
        subtotal: totals.subtotal.toFixed(2), discountTotal: "0.00", taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2),
      },
    });
    await tx.invoiceLine.createMany({
      data: input.lines.map((l, i) => ({
        tenantId: ctx.tenantId, invoiceId: inv.id, lineNo: i + 1, description: l.description, hsnSac: l.hsnSac ?? null, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(2), discountAmount: "0.00",
        taxPercent: l.taxPercent.toFixed(2), taxAmount: (amounts[i] as LineAmounts).tax.toFixed(2), lineTotal: (amounts[i] as LineAmounts).total.toFixed(2), sourceType: l.sourceType, sourceId: l.sourceId,
      })),
    });
    const invoiceNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "INVOICE");
    await tx.invoice.updateMany({ where: { id: inv.id, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "ISSUED", invoiceNumber, issuedAt: new Date(), issuedById: ctx.userId, version: { increment: 1 } } });
    await this.audit.record(tx, actorOf(ctx), { action: "INVOICE_ISSUED", entityType: "Invoice", entityId: inv.id, metadata: { invoiceNumber, total: fmt(totals.total), source: input.lines[0]?.sourceType ?? null } });
    return { id: inv.id, invoiceNumber, total: totals.total };
  }
  // ───── internals ─────

  async view(db: Db, ctx: RequestContext, id: string) {
    const i = await db.invoice.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: INVOICE_INCLUDE });
    return toInvoiceView(i);
  }

  private async resolveLines(tx: Db, ctx: RequestContext, inputs: LineInput[], split: boolean): Promise<ResolvedLine[]> {
    const serviceIds = [...new Set(inputs.flatMap((l) => ("serviceId" in l ? [l.serviceId] : [])))];
    const services = serviceIds.length
      ? await tx.service.findMany({ where: { id: { in: serviceIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } })
      : [];
    const byId = new Map(services.map((s) => [s.id, s]));
    const resolved: ResolvedLine[] = [];
    for (const [i, l] of inputs.entries()) {
      let serviceId: string | null = null;
      let hsnSac: string | null = null;
      let description: string;
      let unitPrice: Decimal;
      let taxPercent: Decimal;
      if ("serviceId" in l) {
        const s = byId.get(l.serviceId);
        if (!s) throw new DomainError("VALIDATION_FAILED", "A selected service does not exist or is inactive", 400, [{ path: `lines.${i}.serviceId`, message: "Unknown or inactive service" }]);
        serviceId = s.id; hsnSac = s.sacCode; description = s.name; unitPrice = new Decimal(s.price.toString()); taxPercent = new Decimal(s.taxPercent.toString());
      } else {
        description = l.description; unitPrice = l.unitPrice; taxPercent = l.taxPercent;
      }
      const discount = l.discountAmount ?? new Decimal(0);
      if (discount.gt(0) && !ctx.permissions.has("INVOICE_DISCOUNT")) {
        throw new DomainError("FORBIDDEN", "You do not have permission to apply discounts", 403);
      }
      let amounts: LineAmounts;
      try {
        amounts = computeLine({ quantity: l.quantity, unitPrice, discountAmount: discount, taxPercent }, { split });
      } catch (e) {
        throw new DomainError("INVALID_AMOUNT", e instanceof RangeError ? e.message : "Invalid line amounts", 400, [{ path: `lines.${i}.discountAmount`, message: "Invalid discount" }]);
      }
      resolved.push({ serviceId, hsnSac, description, quantity: l.quantity, unitPrice, taxPercent, discount, amounts });
    }
    return resolved;
  }

  private async writeLines(tx: Db, ctx: RequestContext, invoiceId: string, lines: ResolvedLine[]): Promise<void> {
    await tx.invoiceLine.createMany({
      data: lines.map((l, i) => ({
        tenantId: ctx.tenantId, invoiceId, lineNo: i + 1, serviceId: l.serviceId, hsnSac: l.hsnSac, description: l.description,
        quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(2), discountAmount: l.discount.toFixed(2), taxPercent: l.taxPercent.toFixed(2),
        taxAmount: l.amounts.tax.toFixed(2), lineTotal: l.amounts.total.toFixed(2),
      })),
    });
  }
}
