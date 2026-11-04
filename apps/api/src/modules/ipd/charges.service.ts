import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { dateOnly, localDateStr } from "../../common/time";
import { computeLine, fmt } from "../billing/billing.domain";
import { amount, percent, quantity } from "../billing/money.schema";

const catalogCharge = z.object({ type: z.enum(["DOCTOR_VISIT", "PROCEDURE", "SERVICE"]).default("SERVICE"), serviceId: z.string().uuid(), quantity }).strict();
const manualCharge = z.object({ type: z.enum(["DOCTOR_VISIT", "PROCEDURE", "SERVICE"]).default("SERVICE"), description: z.string().trim().min(2).max(200), unitPrice: amount(), taxPercent: percent.prefault(0), quantity }).strict();
export const postChargeSchema = z.union([catalogCharge, manualCharge]);
export const voidChargeSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();
export const listChargesSchema = z.object({ status: z.enum(["PENDING", "BILLED", "VOIDED"]).optional() }).strict();

const VIEW = { id: true, type: true, description: true, quantity: true, unitPrice: true, taxPercent: true, status: true, sourceKey: true, chargedAt: true, chargedById: true, invoiceId: true, voidReason: true, serviceId: true } satisfies Prisma.ChargeSelect;
type Row = Prisma.ChargeGetPayload<{ select: typeof VIEW }>;

export function chargeAmounts(c: { quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; taxPercent: Prisma.Decimal }) {
  return computeLine({ quantity: c.quantity.toString(), unitPrice: c.unitPrice.toString(), discountAmount: 0, taxPercent: c.taxPercent.toString() });
}

export const toChargeView = (c: Row) => {
  const a = chargeAmounts(c);
  return { ...c, quantity: c.quantity.toString(), unitPrice: fmt(c.unitPrice), taxPercent: fmt(c.taxPercent), taxAmount: fmt(a.tax), lineTotal: fmt(a.total) };
};

function datesBetween(startStr: string, endStr: string): string[] {
  const out: string[] = [];
  for (let d = dateOnly(startStr); d.toISOString().slice(0, 10) <= endStr; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

@Injectable()
export class ChargesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: RequestContext, admissionId: string, status?: "PENDING" | "BILLED" | "VOIDED") {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { id: true } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.summarise(this.prisma, ctx, admissionId, status);
  }

  /** Charges waiting to be billed, grouped by current admission, so the cashier sees what each admitted patient owes before discharge. */
  async unbilled(ctx: RequestContext) {
    const rows = await this.prisma.charge.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "PENDING", admission: { status: "ADMITTED" } },
      select: { ...VIEW, admission: { select: { id: true, admissionNumber: true, admittedAt: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } } } } },
      orderBy: { chargedAt: "asc" },
      take: 5000,
    });
    const byAdmission = new Map<string, { admissionId: string; admissionNumber: string; admittedAt: Date; patientName: string; mrn: string | null; charges: number; pendingTotal: Decimal; items: ReturnType<typeof toChargeView>[] }>();
    for (const { admission, ...c } of rows) {
      const g = byAdmission.get(admission.id) ?? { admissionId: admission.id, admissionNumber: admission.admissionNumber, admittedAt: admission.admittedAt, patientName: [admission.patient.firstName, admission.patient.lastName].filter(Boolean).join(" "), mrn: admission.patient.identifiers[0]?.value ?? null, charges: 0, pendingTotal: new Decimal(0), items: [] };
      g.charges += 1;
      g.pendingTotal = g.pendingTotal.plus(chargeAmounts(c).total);
      g.items.push(toChargeView(c));
      byAdmission.set(admission.id, g);
    }
    return [...byAdmission.values()].map((g) => ({ ...g, pendingTotal: fmt(g.pendingTotal) }));
  }

  async post(ctx: RequestContext, admissionId: string, input: z.infer<typeof postChargeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "Charges can only be added to a current admission", 409);
      if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued", 409);
      let description: string; let unitPrice: Decimal; let taxPercent: Decimal; let serviceId: string | null = null;
      if ("serviceId" in input) {
        const s = await tx.service.findFirst({ where: { id: input.serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
        if (!s) throw new DomainError("VALIDATION_FAILED", "The selected service does not exist or is inactive", 400, [{ path: "serviceId", message: "Unknown or inactive service" }]);
        description = s.name; unitPrice = new Decimal(s.price.toString()); taxPercent = new Decimal(s.taxPercent.toString()); serviceId = s.id;
      } else {
        if (!ctx.permissions.has("INVOICE_CREATE")) throw new DomainError("FORBIDDEN", "Free-price charges need billing permission; choose a service from the catalogue", 403);
        description = input.description; unitPrice = input.unitPrice; taxPercent = input.taxPercent;
      }
      const c = await tx.charge.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, type: input.type, serviceId, description, quantity: input.quantity.toString(), unitPrice: unitPrice.toFixed(2), taxPercent: taxPercent.toFixed(2), chargedById: ctx.userId },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_POSTED", entityType: "Charge", entityId: c.id, metadata: { admissionId, type: c.type, total: toChargeView(c).lineTotal } });
      return toChargeView(c);
    });
  }

  async void(ctx: RequestContext, chargeId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.charge.findFirst({ where: { id: chargeId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (c.status !== "PENDING") throw new DomainError("INVALID_STATE", c.status === "BILLED" ? "This charge is already on an invoice. Use a credit note instead." : "This charge is already voided", 409);
      const res = await tx.charge.updateMany({ where: { id: chargeId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "VOIDED", voidReason: reason, voidedById: ctx.userId, voidedAt: new Date() } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The charge was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "CHARGE_VOIDED", entityType: "Charge", entityId: chargeId, metadata: { admissionId: c.admissionId, reason } });
      return toChargeView(await tx.charge.findFirstOrThrow({ where: { id: chargeId, tenantId: ctx.tenantId }, select: VIEW }));
    });
  }

  /**
   * Posts one bed charge per local calendar day of the stay, at the daily rate of the bed occupied. Idempotent: a day already
   * charged (by this or any earlier call) is skipped, so the endpoint can be called daily or at discharge.
   */
  async postBedDays(ctx: RequestContext, admissionId: string, db: Db = this.prisma) {
    const adm = await db.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "Bed charges can only be posted for a current admission", 409);
    if (adm.finalInvoiceId) return { posted: 0, ...(await this.summarise(db, ctx, admissionId)) };
    const run = async (tx: Db) => {
      const tz = (await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
      const assignments = await tx.bedAssignment.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { assignedAt: "asc" }, include: { bed: { select: { code: true, ward: { select: { name: true } } } } } });
      const existing = new Set((await tx.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, sourceKey: { startsWith: `BED:${admissionId}:` } }, select: { sourceKey: true } })).map((c) => c.sourceKey));
      const today = localDateStr(new Date(), tz);
      const rows: Prisma.ChargeCreateManyInput[] = [];
      for (const a of assignments) {
        for (const day of datesBetween(localDateStr(a.assignedAt, tz), a.releasedAt ? localDateStr(a.releasedAt, tz) : today)) {
          const sourceKey = `BED:${admissionId}:${day}`;
          if (existing.has(sourceKey)) continue;
          existing.add(sourceKey);
          rows.push({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, type: "BED", description: `Bed ${a.bed.code} (${a.bed.ward.name}) - ${day}`, quantity: "1", unitPrice: a.dailyRate.toFixed(2), taxPercent: "0", sourceKey, chargedById: ctx.userId });
        }
      }
      if (rows.length) await tx.charge.createMany({ data: rows, skipDuplicates: true });
      if (rows.length) await this.audit.record(tx, actorOf(ctx), { action: "BED_CHARGES_POSTED", entityType: "Admission", entityId: admissionId, metadata: { days: rows.length } });
      return rows.length;
    };
    const posted = "$transaction" in db ? await (db as PrismaService).$transaction((tx) => run(tx)) : await run(db);
    return { posted, ...(await this.summarise(db, ctx, admissionId)) };
  }

  async summarise(db: Db, ctx: RequestContext, admissionId: string, status?: "PENDING" | "BILLED" | "VOIDED") {
    const rows = await db.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, ...(status ? { status } : {}) }, select: VIEW, orderBy: { chargedAt: "asc" } });
    const views = rows.map(toChargeView);
    const pending = rows.filter((r) => r.status === "PENDING").reduce((a, r) => a.plus(chargeAmounts(r).total), new Decimal(0));
    return { items: views, pendingTotal: fmt(pending) };
  }
}
