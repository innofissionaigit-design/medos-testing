import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { InvoicesService } from "../billing/invoices.service";
import { LedgerService, type Tender } from "../billing/ledger.service";
import { amount as moneyInput } from "../billing/money.schema";
import { SettingsService } from "../settings/settings.service";

/** At the desk a registration fee is taken in cash, by UPI or by card. */
const METHODS = ["CASH", "UPI", "CARD"] as const;
const paymentsSchema = z.array(z.object({ method: z.enum(METHODS), amount: moneyInput({ positive: true }), reference: z.string().trim().min(4).max(60).optional() }).strict()).min(1).max(3);

/** How the registration fee is settled: paid (cash, UPI or card, split allowed) or exempted with a listed reason. Exactly one of the two. */
export const registrationSettlementSchema = z.object({
  payments: paymentsSchema.optional(),
  exemption: z.object({ reason: z.string().trim().min(3).max(60) }).strict().optional(),
}).strict().refine((v) => (v.payments ? 1 : 0) + (v.exemption ? 1 : 0) === 1, { message: "Give either the payments or an exemption, not both and not neither" });
export type RegistrationSettlement = z.infer<typeof registrationSettlementSchema>;

/** What happens to the fee when a patient is created: collected now, left for the front desk, or not applicable (data migration). */
export type RegistrationMode = "COLLECT" | "PENDING" | "NONE";

export interface RegistrationSummary {
  status: "PAID" | "EXEMPTED" | "PENDING";
  amount: string;
  invoiceId?: string; invoiceNumber?: string | null; receiptId?: string; receiptNumber?: string; methods?: string[]; exemptionReason?: string;
}

/**
 * The one-time registration fee (docs/registration-fee.md). At Reception the fee is collected in the same transaction that creates the patient, so the Patient ID
 * exists only once the fee is paid (or exempted by someone allowed to): there is no half-registered patient and no second charge, because each patient has at most
 * one registration row. Patients created where no cashier is present (a booking bot) are left PENDING; they cannot be checked in or admitted until it is settled.
 * Patients registered before the fee existed, and imported ones, have no row and are never charged.
 */
@Injectable()
export class RegistrationFeeService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly invoices: InvoicesService, private readonly ledger: LedgerService, private readonly idempotency: IdempotencyService,
  ) {}

  /** The fee in force, or null when no fee is set up. */
  async fee(db: Db, ctx: RequestContext): Promise<Decimal | null> {
    if (!(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "REGISTRATION_FEE_ENABLED"))) return null;
    const a = new Decimal(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "REGISTRATION_FEE_AMOUNT"));
    return a.gt(0) ? a : null;
  }

  async config(ctx: RequestContext) {
    const fee = await this.fee(this.prisma, ctx);
    return {
      enabled: fee !== null, amount: fee ? fee.toFixed(2) : "0.00", methods: [...METHODS],
      exemptReasons: await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "REGISTRATION_FEE_EXEMPT_REASONS"),
      canCollect: ctx.permissions.has("PAYMENT_CREATE"), canExempt: ctx.permissions.has("REGISTRATION_FEE_EXEMPT"),
    };
  }

  /** Runs inside the patient-creation transaction. A failure here (no fee given, wrong amount, no open shift for cash, not allowed) undoes the registration. */
  async onRegister(tx: Db, ctx: RequestContext, patientId: string, mode: RegistrationMode, given: RegistrationSettlement | undefined): Promise<RegistrationSummary | null> {
    if (mode === "NONE") return null;
    const fee = await this.fee(tx, ctx);
    if (!fee) {
      if (given) throw new DomainError("VALIDATION_FAILED", "No registration fee is set up, so there is nothing to pay or exempt", 400, [{ path: "registration", message: "No registration fee" }]);
      return null;
    }
    if (mode === "COLLECT" && !given) {
      throw new DomainError("REGISTRATION_FEE_REQUIRED", `Collect the registration fee of ${fmt(fee)} before registering the patient`, 409, { amount: fee.toFixed(2) });
    }
    const row = await tx.patientRegistration.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, amount: fee.toFixed(2), createdById: ctx.userId }, select: { id: true } });
    if (mode === "PENDING" || !given) {
      await this.audit.record(tx, actorOf(ctx), { action: "REGISTRATION_FEE_DUE", entityType: "PatientRegistration", entityId: row.id, metadata: { patientId, amount: fee.toFixed(2) } });
      return { status: "PENDING", amount: fee.toFixed(2) };
    }
    return this.settleRow(tx, ctx, row.id, patientId, fee, given);
  }

  /** The front desk settles a fee that was left pending. Safe against double submission: the row is locked and a settled one cannot be settled again. */
  async settlePending(ctx: RequestContext, patientId: string, input: RegistrationSettlement, key: string | undefined) {
    const { result, replayed } = await this.idempotency.run(ctx.tenantId, `REGISTRATION_FEE:${patientId}`, key, input, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; amount: string }[]>`
        SELECT id, status::text AS status, amount::text AS amount FROM "PatientRegistration" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "patientId" = ${patientId}::uuid FOR UPDATE`;
      const row = locked[0];
      if (!row) {
        // An id that is not a patient of this hospital (unknown, or another hospital's) is "not found", the same for both.
        const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!patient) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        throw new DomainError("INVALID_STATE", "This patient has no registration fee to collect", 409);
      }
      if (row.status !== "PENDING") throw new DomainError("INVALID_STATE", `The registration fee of this patient is already ${row.status === "PAID" ? "paid" : "exempted"}`, 409);
      return this.settleRow(tx, ctx, row.id, patientId, new Decimal(row.amount), input);
    });
    return { registration: result, replayed };
  }

  private async settleRow(tx: Db, ctx: RequestContext, rowId: string, patientId: string, fee: Decimal, given: RegistrationSettlement): Promise<RegistrationSummary> {
    const now = new Date();
    if (given.exemption) {
      if (!ctx.permissions.has("REGISTRATION_FEE_EXEMPT")) throw new DomainError("FORBIDDEN", "You do not have permission to register a patient without the registration fee", 403);
      const allowed = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "REGISTRATION_FEE_EXEMPT_REASONS");
      const reason = allowed.find((r) => r.toLowerCase() === given.exemption!.reason.toLowerCase());
      if (!reason) throw new DomainError("VALIDATION_FAILED", "Choose one of the reasons set up for exempting the registration fee", 400, [{ path: "exemption.reason", message: "Not an allowed reason" }]);
      const res = await tx.patientRegistration.updateMany({ where: { id: rowId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "EXEMPTED", exemptionReason: reason, exemptedById: ctx.userId, settledAt: now, settledById: ctx.userId } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The registration fee was settled by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "REGISTRATION_FEE_EXEMPTED", entityType: "PatientRegistration", entityId: rowId, metadata: { patientId, amount: fee.toFixed(2), reason } });
      return { status: "EXEMPTED", amount: fee.toFixed(2), exemptionReason: reason };
    }
    if (!ctx.permissions.has("PAYMENT_CREATE")) throw new DomainError("FORBIDDEN", "You do not have permission to take payments", 403);
    const tenders: Tender[] = (given.payments ?? []).map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? null }));
    const paid = tenders.reduce((a, t) => a.plus(t.amount), new Decimal(0));
    if (!paid.eq(fee)) throw new DomainError("VALIDATION_FAILED", `The registration fee is ${fmt(fee)}; the payments add up to ${fmt(paid)}`, 400, [{ path: "registration.payments", message: "Must equal the registration fee" }]);
    // The bill is created and receipted inside this transaction; the bill's source (REGISTRATION + patient) can exist only once.
    const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
      patientId, encounterId: null, kind: "REGISTRATION", notes: "Registration fee",
      lines: [{ description: "Registration fee", quantity: new Decimal(1), unitPrice: fee, taxPercent: new Decimal(0), sourceType: "REGISTRATION", sourceId: patientId }],
    });
    const locked = await this.ledger.lock(tx, ctx, inv.id);
    const r = await this.ledger.receive(tx, ctx, locked, tenders);
    const res = await tx.patientRegistration.updateMany({ where: { id: rowId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "PAID", invoiceId: inv.id, settledAt: now, settledById: ctx.userId } });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "The registration fee was settled by someone else", 409);
    await this.audit.record(tx, actorOf(ctx), { action: "REGISTRATION_FEE_PAID", entityType: "PatientRegistration", entityId: rowId, metadata: { patientId, amount: fee.toFixed(2), methods: tenders.map((t) => t.method), receiptNumber: r.receiptNumber, invoiceNumber: inv.invoiceNumber } });
    return { status: "PAID", amount: fee.toFixed(2), invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, receiptId: r.receiptId, receiptNumber: r.receiptNumber, methods: tenders.map((t) => t.method) };
  }

  /** A patient whose registration fee is still pending cannot be checked in or admitted (an emergency check-in is never held up: the fee stays pending). */
  async gate(db: Db, ctx: RequestContext, patientId: string, emergency = false): Promise<void> {
    if (emergency) return;
    const row = await db.patientRegistration.findFirst({ where: { tenantId: ctx.tenantId, patientId, status: "PENDING" }, select: { amount: true } });
    if (row) throw new DomainError("REGISTRATION_FEE_PENDING", `The registration fee of ${fmt(row.amount.toString())} has not been paid. Collect it at Reception, or have someone with permission exempt it.`, 409, { amount: fmt(row.amount.toString()) });
  }

  /** The registration fee state of one patient, for the patient page. Patients with no row (registered before the fee, or imported) are NOT_APPLICABLE. */
  async view(ctx: RequestContext, patientId: string) {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    const row = await this.prisma.patientRegistration.findFirst({
      where: { tenantId: ctx.tenantId, patientId },
      include: { invoice: { select: { id: true, invoiceNumber: true, status: true, receipts: { orderBy: { receivedAt: "asc" }, select: { id: true, receiptNumber: true, receivedAt: true, payments: { select: { method: true, amount: true } } } } } } },
    });
    if (!row) return { status: "NOT_APPLICABLE" as const };
    const r = row.invoice?.receipts[0];
    return {
      status: row.status, amount: fmt(row.amount.toString()), exemptionReason: row.exemptionReason, settledAt: row.settledAt,
      invoiceId: row.invoice?.id ?? null, invoiceNumber: row.invoice?.invoiceNumber ?? null, invoiceStatus: row.invoice?.status ?? null,
      receiptId: r?.id ?? null, receiptNumber: r?.receiptNumber ?? null, methods: r ? r.payments.map((x) => ({ method: x.method, amount: fmt(x.amount.toString()) })) : [],
    };
  }
}
