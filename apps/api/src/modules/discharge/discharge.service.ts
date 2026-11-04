import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { balanceDue, fmt } from "../billing/billing.domain";
import { InvoicesService } from "../billing/invoices.service";
import { ClinicianService } from "../clinical/clinician.service";
import { EncountersService } from "../encounters/encounters.service";
import { AdmissionsService } from "../ipd/admissions.service";
import { chargeAmounts, ChargesService } from "../ipd/charges.service";
import { SettingsService } from "../settings/settings.service";

export type Step = "MEDICALLY_FIT" | "NURSING" | "CHARGES_REVIEWED" | "PHARMACY" | "BILLING";
const STEP_ORDER: Step[] = ["MEDICALLY_FIT", "NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"];

export const clearSchema = z.object({ step: z.enum(["MEDICALLY_FIT", "NURSING", "CHARGES_REVIEWED", "PHARMACY"]), note: z.string().trim().min(3).max(300).optional() }).strict();
export const waiveSchema = z.object({ step: z.enum(["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"]), reason: z.string().trim().min(10, "Explain why this step is being waived").max(300) }).strict();
export const completeSchema = z.object({ type: z.enum(["ROUTINE", "LAMA", "REFERRED", "ABSCONDED", "DEATH"]).default("ROUTINE"), note: z.string().trim().max(300).optional() }).strict();

const OVERDUE_MIN = 30;

@Injectable()
export class DischargeService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly admissions: AdmissionsService, private readonly charges: ChargesService, private readonly invoices: InvoicesService,
    private readonly encounters: EncountersService, private readonly clinicians: ClinicianService,
  ) {}

  // ───── status ─────

  /** Everything the discharge screen needs: each step, what blocks it, the bill, the summary, and whether discharge can complete. */
  async status(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.evaluate(this.prisma, ctx, adm);
  }

  private async evaluate(db: Db, ctx: RequestContext, adm: { id: string; status: string; encounterId: string; patientId: string; finalInvoiceId: string | null; dischargedAt: Date | null; dischargeType: string | null }) {
    const required = new Set<Step>(["MEDICALLY_FIT", ...(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "DISCHARGE_REQUIRED_STEPS")) as Step[]]);
    const requireSummary = await this.settings.get(db, ctx.tenantId, ctx.facilityId, "DISCHARGE_REQUIRE_SUMMARY");
    const now = Date.now();
    const [clearances, pendingTasks, overdueMar, pendingCharges, summary, invoice] = await Promise.all([
      db.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id } }),
      db.nursingTask.count({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "PENDING" } }),
      db.medicationAdministration.count({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "DUE", scheduledAt: { lt: new Date(now - OVERDUE_MIN * 60_000) }, item: { status: "ACTIVE" } } }),
      db.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "PENDING" } }),
      db.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" }, select: { status: true } }),
      adm.finalInvoiceId ? db.invoice.findFirst({ where: { id: adm.finalInvoiceId, tenantId: ctx.tenantId } }) : Promise.resolve(null),
    ]);
    const pendingTotal = pendingCharges.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
    const unfilled = await db.medicationOrderItem.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE", quantity: { not: null }, order: { encounterId: adm.encounterId, status: "SIGNED" } }, select: { quantity: true, dispensedQuantity: true } });
    const unresolvedRx = unfilled.filter((i) => i.quantity !== null && i.dispensedQuantity < i.quantity).length;

    const done = (s: Step) => clearances.find((c) => c.step === s);
    const invoiceDue = invoice ? balanceDue({ total: invoice.total, paidTotal: invoice.paidTotal, refundedTotal: invoice.refundedTotal, creditedTotal: invoice.creditedTotal }) : null;
    const settled = invoice !== null && (invoice.status === "CANCELLED" || invoice.status === "REFUNDED" || (invoiceDue?.isZero() ?? false));

    const blockers: Record<Step, string[]> = { MEDICALLY_FIT: [], NURSING: [], CHARGES_REVIEWED: [], PHARMACY: [], BILLING: [] };
    if (pendingTasks > 0) blockers.NURSING.push(`${pendingTasks} nursing task(s) still pending`);
    if (overdueMar > 0) blockers.NURSING.push(`${overdueMar} overdue medication dose(s) not recorded`);
    if (unresolvedRx > 0) blockers.PHARMACY.push(`${unresolvedRx} prescribed medicine(s) not yet fully dispensed (confirm they are resolved)`);
    if (!invoice && pendingTotal.gt(0)) blockers.BILLING.push("Generate the final bill");
    if (invoice && !settled) blockers.BILLING.push(`Payment pending: ${fmt(invoiceDue ?? 0)} due`);
    const fitCleared = !!done("MEDICALLY_FIT");

    const steps = STEP_ORDER.map((step) => {
      const row = done(step);
      const billingAuto = step === "BILLING" && !row && (settled || (!invoice && pendingTotal.isZero() && fitCleared));
      // Pharmacy clears itself once nothing is left to dispense, so dispensing in the pharmacy updates this checklist without a second step.
      // If something is still undispensed it stays pending and a pharmacist can still clear or waive it by hand.
      const pharmacyAuto = step === "PHARMACY" && !row && fitCleared && unresolvedRx === 0;
      const auto = billingAuto || pharmacyAuto;
      const autoNote = billingAuto ? "Settled automatically" : pharmacyAuto ? (unfilled.length > 0 ? "All prescribed medicines dispensed" : "Nothing to dispense") : null;
      return {
        step, required: required.has(step), status: row ? row.status : auto ? "CLEARED" : "PENDING", by: row?.byId ?? null, at: row?.at ?? null, note: row?.note ?? autoNote,
        blockers: row || auto ? [] : blockers[step], automatic: step === "BILLING",
      };
    });
    const summaryOk = !requireSummary || summary?.status === "SIGNED" || summary?.status === "AMENDED";
    const completionBlockers: string[] = [];
    for (const s of steps) if (s.required && s.status === "PENDING") completionBlockers.push(`${s.step.replace(/_/g, " ").toLowerCase()} not cleared`);
    if (!summaryOk) completionBlockers.push("discharge summary is not signed");
    const billingWaived = done("BILLING")?.status === "WAIVED";
    if (!invoice && pendingTotal.gt(0) && !billingWaived) completionBlockers.push("charges have not been billed");
    return {
      admissionId: adm.id, status: adm.status, dischargedAt: adm.dischargedAt, dischargeType: adm.dischargeType,
      requireSummary, summaryStatus: summary?.status ?? null, steps,
      pendingCharges: { count: pendingCharges.length, total: fmt(pendingTotal) },
      finalInvoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, total: fmt(invoice.total), balanceDue: fmt(invoiceDue ?? 0) } : null,
      warnings: unresolvedRx > 0 ? [`${unresolvedRx} prescribed medicine(s) are not fully dispensed`] : [],
      canComplete: adm.status === "ADMITTED" && completionBlockers.length === 0, blockers: adm.status === "ADMITTED" ? completionBlockers : ["admission is already closed"],
    };
  }

  // ───── clear / waive ─────

  async clear(ctx: RequestContext, admissionId: string, input: z.infer<typeof clearSchema>) {
    const perm = { MEDICALLY_FIT: "ADMISSION_DISCHARGE", NURSING: "NURSING_DOCUMENT", CHARGES_REVIEWED: "CHARGE_CREATE", PHARMACY: "PHARMACY_DISPENSE" } as const;
    if (!ctx.permissions.has(perm[input.step])) throw new DomainError("FORBIDDEN", "You do not have permission to clear this step", 403);
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (input.step === "MEDICALLY_FIT") await this.clinicians.requireActive(tx, ctx);
      const have = await tx.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId } });
      if (have.some((c) => c.step === input.step)) throw new DomainError("CONFLICT", "This step is already cleared", 409);
      if (input.step !== "MEDICALLY_FIT" && !have.some((c) => c.step === "MEDICALLY_FIT")) throw new DomainError("DISCHARGE_BLOCKED", "The doctor must mark the patient medically fit first", 409);
      if (adm.finalInvoiceId && input.step === "CHARGES_REVIEWED") throw new DomainError("DISCHARGE_BLOCKED", "The final bill has already been issued", 409);

      if (input.step === "NURSING") {
        const ev = await this.evaluate(tx, ctx, adm);
        const nb = ev.steps.find((s) => s.step === "NURSING")!.blockers;
        if (nb.length) throw new DomainError("DISCHARGE_BLOCKED", `Nursing clearance blocked: ${nb.join("; ")}`, 409, { blockers: nb });
      }
      if (input.step === "CHARGES_REVIEWED") await this.charges.postBedDays(ctx, admissionId, tx);
      await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: input.step, status: "CLEARED", note: input.note ?? null, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_STEP_CLEARED", entityType: "Admission", entityId: admissionId, metadata: { step: input.step } });
      return this.evaluate(tx, ctx, adm);
    });
  }

  async waive(ctx: RequestContext, admissionId: string, input: z.infer<typeof waiveSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      const have = await tx.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId } });
      if (have.some((c) => c.step === input.step)) throw new DomainError("CONFLICT", "This step is already cleared or waived", 409);
      if (!have.some((c) => c.step === "MEDICALLY_FIT")) throw new DomainError("DISCHARGE_BLOCKED", "The doctor must mark the patient medically fit first", 409);
      await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: input.step, status: "WAIVED", note: input.reason, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_STEP_WAIVED", entityType: "Admission", entityId: admissionId, metadata: { step: input.step, reason: input.reason } });
      return this.evaluate(tx, ctx, adm);
    });
  }

  // ───── final bill ─────

  /** Bills every pending charge (including bed days) on one invoice. The charges become BILLED and can never be billed again. */
  async finalInvoice(ctx: RequestContext, admissionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (adm.finalInvoiceId) throw new DomainError("CONFLICT", "The final bill has already been issued", 409);
      const ev = await this.evaluate(tx, ctx, adm);
      const preBilling = ev.steps.filter((s) => s.required && s.step !== "BILLING" && s.status === "PENDING");
      if (preBilling.length) throw new DomainError("DISCHARGE_BLOCKED", `Clear these steps before billing: ${preBilling.map((s) => s.step.toLowerCase().replace(/_/g, " ")).join(", ")}`, 409);

      await this.charges.postBedDays(ctx, admissionId, tx);
      const pending = await tx.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING" }, orderBy: { chargedAt: "asc" } });
      const total = pending.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
      if (pending.length === 0 || !total.gt(0)) {
        const have = await tx.dischargeClearance.findFirst({ where: { tenantId: ctx.tenantId, admissionId, step: "BILLING" } });
        if (!have) await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: "BILLING", status: "CLEARED", note: "No chargeable items", byId: ctx.userId } });
        return { invoice: null, status: await this.evaluate(tx, ctx, adm) };
      }
      const sacById = new Map((await tx.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(pending.flatMap((c) => (c.serviceId ? [c.serviceId] : [])))] } }, select: { id: true, sacCode: true } })).map((s) => [s.id, s.sacCode]));
      const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: adm.patientId, encounterId: adm.encounterId, kind: "IPD", notes: `Final bill for admission ${adm.admissionNumber}`,
        lines: pending.map((c) => ({ description: c.description, quantity: new Decimal(c.quantity.toString()), unitPrice: new Decimal(c.unitPrice.toString()), taxPercent: new Decimal(c.taxPercent.toString()), sourceType: "CHARGE", sourceId: c.id, hsnSac: c.serviceId ? sacById.get(c.serviceId) ?? null : null })),
      });
      const billed = await tx.charge.updateMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING", id: { in: pending.map((c) => c.id) } }, data: { status: "BILLED", invoiceId: inv.id } });
      if (billed.count !== pending.length) throw new DomainError("INVALID_STATE", "Charges changed while billing; try again", 409);
      await tx.admission.updateMany({ where: { id: admissionId, tenantId: ctx.tenantId, status: "ADMITTED", finalInvoiceId: null }, data: { finalInvoiceId: inv.id, version: { increment: 1 } } });
      await this.audit.record(tx, actorOf(ctx), { action: "FINAL_INVOICE_CREATED", entityType: "Admission", entityId: admissionId, metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, charges: pending.length, total: fmt(inv.total) } });
      const fresh = await tx.admission.findFirstOrThrow({ where: { id: admissionId, tenantId: ctx.tenantId } });
      return { invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, total: fmt(inv.total) }, status: await this.evaluate(tx, ctx, fresh) };
    });
  }

  // ───── complete ─────

  /** Completes the discharge: closes the admission and visit and releases the bed, all or nothing. */
  async complete(ctx: RequestContext, admissionId: string, input: z.infer<typeof completeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      await this.clinicians.requireActive(tx, ctx);
      const ev = await this.evaluate(tx, ctx, adm);
      if (!ev.canComplete) throw new DomainError("DISCHARGE_BLOCKED", `Discharge cannot be completed: ${ev.blockers.join("; ")}`, 409, { blockers: ev.blockers });
      const now = new Date();
      const bedStatus = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BED_AFTER_DISCHARGE");
      await this.admissions.releaseBed(tx, ctx, admissionId, bedStatus as "CLEANING" | "AVAILABLE", now);
      const res = await tx.admission.updateMany({
        where: { id: admissionId, tenantId: ctx.tenantId, status: "ADMITTED" },
        data: { status: "DISCHARGED", dischargedAt: now, dischargeType: input.type, dischargeNote: input.note ?? null, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The admission was changed by someone else", 409);
      await this.encounters.transition(tx, ctx, adm.encounterId, "COMPLETED");
      await this.audit.record(tx, actorOf(ctx), { action: "ADMISSION_DISCHARGED", entityType: "Admission", entityId: admissionId, metadata: { type: input.type, bedStatus } });
      return this.admissions.view(tx, ctx, admissionId);
    });
  }

  // ───── internals ─────

  /** Row-locks the admission so clearances, billing and completion for one patient are serialised. */
  private async lockAdmission(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const adm = await tx.admission.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
    if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "This admission is already closed", 409);
    return adm;
  }
}
