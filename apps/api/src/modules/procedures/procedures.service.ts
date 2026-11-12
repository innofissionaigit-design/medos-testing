import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { chargeAmounts } from "../ipd/charges.service";

const uuid = z.string().uuid();
const when = z.string().datetime({ offset: true });
const reason = z.string().trim().min(3).max(200);

export const planProcedureSchema = z.object({ serviceId: uuid, scheduledAt: when.optional(), surgeonId: uuid.optional(), notes: z.string().trim().max(500).optional() }).strict();
export const performProcedureSchema = z.object({ performedAt: when.optional(), notes: z.string().trim().max(500).optional() }).strict();
export const addItemSchema = z.object({ kind: z.enum(["IMPLANT", "CONSUMABLE"]), serviceId: uuid, quantity: z.number().int().min(1).max(999), serialNo: z.string().trim().min(2).max(60).optional() }).strict()
  .refine((v) => v.kind !== "IMPLANT" || !!v.serialNo, { message: "An implant needs its serial or lot number", path: ["serialNo"] });
export const removeItemSchema = z.object({ reason }).strict();
export const cancelProcedureSchema = z.object({ reason }).strict();

const KIND_LABEL = { IMPLANT: "Implant", CONSUMABLE: "Consumable" } as const;

/**
 * Procedures for an admitted patient (docs/procedures.md). The doctor (or the RMO) plans a procedure from the price list; the OT / procedure coordinator
 * performs it (its charge is posted to the admission), records the implants and consumables used (each a price-list item, with its charge) and finalises it.
 * Once finalised a procedure, its implants and its consumables never change. The discharge stage "OT / procedure" watches all of this.
 */
@Injectable()
export class ProceduresService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async admission(db: Db, ctx: RequestContext, admissionId: string) {
    const adm = await db.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return adm;
  }

  /** Charges can be added or voided only on a current admission whose final bill has not been issued. */
  private openForCharges(adm: { status: string; finalInvoiceId: string | null }): void {
    if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The admission is already closed", 409);
    if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued, so the procedure record can no longer change", 409);
  }

  /** Row-locks the procedure so two people cannot perform, change or finalise it at the same moment. */
  private async lock(tx: Db, ctx: RequestContext, procedureId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Procedure" WHERE id = ${procedureId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const proc = await tx.procedure.findFirstOrThrow({ where: { id: procedureId, tenantId: ctx.tenantId }, include: { items: { orderBy: { recordedAt: "asc" } } } });
    const adm = await this.admission(tx, ctx, proc.admissionId);
    return { proc, adm };
  }

  private async service(tx: Db, ctx: RequestContext, serviceId: string, category?: "PROCEDURE") {
    const s = await tx.service.findFirst({ where: { id: serviceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", ...(category ? { category } : {}) } });
    if (!s) throw new DomainError("VALIDATION_FAILED", category ? "Choose an active procedure from the price list" : "Choose an active item from the price list", 400, [{ path: "serviceId", message: "Unknown or inactive price-list item" }]);
    return s;
  }

  // ───── read ─────

  async list(ctx: RequestContext, admissionId: string) {
    const adm = await this.admission(this.prisma, ctx, admissionId);
    const procs = await this.prisma.procedure.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, orderBy: { plannedAt: "asc" }, include: { items: { orderBy: { recordedAt: "asc" } } } });
    const chargeIds = procs.flatMap((p) => [p.chargeId, ...p.items.map((i) => i.chargeId)]).filter((x): x is string => !!x);
    const charges = chargeIds.length ? await this.prisma.charge.findMany({ where: { tenantId: ctx.tenantId, id: { in: chargeIds } } }) : [];
    const amount = (id: string | null): string | null => { const c = charges.find((x) => x.id === id); return c ? fmt(chargeAmounts(c).total) : null; };
    const userIds = [...new Set(procs.flatMap((p) => [p.plannedById, p.performedById, p.finalisedById, p.cancelledById]).filter((x): x is string => !!x))];
    const surgeonIds = [...new Set(procs.map((p) => p.surgeonId).filter((x): x is string => !!x))];
    const users = new Map((userIds.length ? await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: userIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const surgeons = new Map((surgeonIds.length ? await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, id: { in: surgeonIds } }, select: { id: true, displayName: true } }) : []).map((p) => [p.id, p.displayName]));
    return procs.map((p) => ({
      id: p.id, name: p.name, status: p.status, scheduledAt: p.scheduledAt, notes: p.notes, surgeonName: p.surgeonId ? surgeons.get(p.surgeonId) ?? null : null,
      plannedAt: p.plannedAt, plannedByName: users.get(p.plannedById) ?? null,
      performedAt: p.performedAt, performedByName: p.performedById ? users.get(p.performedById) ?? null : null, amount: amount(p.chargeId),
      finalisedAt: p.finalisedAt, finalisedByName: p.finalisedById ? users.get(p.finalisedById) ?? null : null,
      cancelReason: p.cancelReason, cancelledByName: p.cancelledById ? users.get(p.cancelledById) ?? null : null,
      items: p.items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, quantity: i.quantity, serialNo: i.serialNo, amount: amount(i.chargeId), recordedAt: i.recordedAt, removed: !!i.removedAt, removeReason: i.removeReason })),
    }));
  }

  // ───── plan, perform ─────

  async plan(ctx: RequestContext, admissionId: string, input: z.infer<typeof planProcedureSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(tx, ctx, admissionId);
      this.openForCharges(adm);
      const svc = await this.service(tx, ctx, input.serviceId, "PROCEDURE");
      if (input.surgeonId && !(await tx.practitioner.findFirst({ where: { id: input.surgeonId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } }))) {
        throw new DomainError("VALIDATION_FAILED", "The surgeon is not an active practitioner at this facility", 400, [{ path: "surgeonId", message: "Unknown practitioner" }]);
      }
      const p = await tx.procedure.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId: adm.id, patientId: adm.patientId, serviceId: svc.id, name: svc.name, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, surgeonId: input.surgeonId ?? null, notes: input.notes ?? null, plannedById: ctx.userId },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_PLANNED", entityType: "Procedure", entityId: p.id, metadata: { admissionId: adm.id, name: p.name } });
      return { id: p.id, name: p.name, status: p.status };
    });
  }

  async perform(ctx: RequestContext, procedureId: string, input: z.infer<typeof performProcedureSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const { proc, adm } = await this.lock(tx, ctx, procedureId);
      this.openForCharges(adm);
      if (proc.status !== "PLANNED") throw new DomainError("INVALID_STATE", `A ${proc.status.toLowerCase()} procedure cannot be performed`, 409);
      const svc = await this.service(tx, ctx, proc.serviceId);
      const charge = await tx.charge.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId: adm.id, type: "PROCEDURE", serviceId: svc.id, description: proc.name, quantity: "1", unitPrice: new Decimal(svc.price.toString()).toFixed(2), taxPercent: new Decimal(svc.taxPercent.toString()).toFixed(2), sourceKey: `PROCEDURE:${proc.id}`, chargedById: ctx.userId },
        select: { id: true },
      });
      await tx.procedure.update({ where: { id: proc.id }, data: { status: "PERFORMED", performedAt: input.performedAt ? new Date(input.performedAt) : new Date(), performedById: ctx.userId, chargeId: charge.id, ...(input.notes ? { notes: input.notes } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_PERFORMED", entityType: "Procedure", entityId: proc.id, metadata: { admissionId: adm.id, name: proc.name, chargeId: charge.id } });
      return { id: proc.id, status: "PERFORMED" as const };
    });
  }

  // ───── implants and consumables ─────

  async addItem(ctx: RequestContext, procedureId: string, input: z.infer<typeof addItemSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const { proc, adm } = await this.lock(tx, ctx, procedureId);
      this.openForCharges(adm);
      if (proc.status !== "PLANNED" && proc.status !== "PERFORMED") throw new DomainError("INVALID_STATE", `A ${proc.status.toLowerCase()} procedure takes no more implants or consumables`, 409);
      const svc = await this.service(tx, ctx, input.serviceId);
      const itemId = (await tx.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0]!.id;
      const description = `${KIND_LABEL[input.kind]}: ${svc.name}${input.serialNo ? ` (${input.serialNo})` : ""} · ${proc.name}`;
      const charge = await tx.charge.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId: adm.id, type: "SERVICE", serviceId: svc.id, description, quantity: String(input.quantity), unitPrice: new Decimal(svc.price.toString()).toFixed(2), taxPercent: new Decimal(svc.taxPercent.toString()).toFixed(2), sourceKey: `PROCEDURE_ITEM:${itemId}`, chargedById: ctx.userId },
        select: { id: true },
      });
      const item = await tx.procedureItem.create({ data: { id: itemId, tenantId: ctx.tenantId, procedureId: proc.id, kind: input.kind, serviceId: svc.id, name: svc.name, quantity: input.quantity, serialNo: input.serialNo ?? null, chargeId: charge.id, recordedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_ITEM_RECORDED", entityType: "Procedure", entityId: proc.id, metadata: { admissionId: adm.id, itemId: item.id, kind: item.kind, name: item.name, quantity: item.quantity, serialNo: item.serialNo, chargeId: charge.id } });
      return { id: item.id, kind: item.kind, name: item.name, quantity: item.quantity, serialNo: item.serialNo };
    });
  }

  async removeItem(ctx: RequestContext, procedureId: string, itemId: string, input: z.infer<typeof removeItemSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const { proc, adm } = await this.lock(tx, ctx, procedureId);
      this.openForCharges(adm);
      if (proc.status !== "PLANNED" && proc.status !== "PERFORMED") throw new DomainError("INVALID_STATE", `A ${proc.status.toLowerCase()} procedure cannot be changed`, 409);
      const item = proc.items.find((i) => i.id === itemId);
      if (!item) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (item.removedAt) throw new DomainError("CONFLICT", "This item was already removed", 409);
      const voided = await tx.charge.updateMany({ where: { id: item.chargeId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "VOIDED", voidReason: `Removed from ${proc.name}: ${input.reason}`, voidedById: ctx.userId, voidedAt: new Date() } });
      if (voided.count !== 1) throw new DomainError("INVALID_STATE", "This item is already on a bill. Ask billing for a credit note.", 409);
      await tx.procedureItem.update({ where: { id: item.id }, data: { removedAt: new Date(), removedById: ctx.userId, removeReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_ITEM_REMOVED", entityType: "Procedure", entityId: proc.id, metadata: { admissionId: adm.id, itemId: item.id, name: item.name, reason: input.reason } });
      return { id: item.id, removed: true as const };
    });
  }

  // ───── finalise, cancel ─────

  /** The coordinator confirms the procedure, its implants and its consumables are all recorded and charged. After this nothing about it can change. */
  async finalise(ctx: RequestContext, procedureId: string) {
    return this.prisma.$transaction(async (tx) => {
      const { proc, adm } = await this.lock(tx, ctx, procedureId);
      this.openForCharges(adm);
      if (proc.status !== "PERFORMED") throw new DomainError("INVALID_STATE", proc.status === "PLANNED" ? "Perform the procedure before finalising it" : `A ${proc.status.toLowerCase()} procedure cannot be finalised`, 409);
      const active = proc.items.filter((i) => !i.removedAt);
      const ids = [proc.chargeId, ...active.map((i) => i.chargeId)].filter((x): x is string => !!x);
      const live = new Set((await tx.charge.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids }, status: { not: "VOIDED" } }, select: { id: true } })).map((c) => c.id));
      const missing = [...(proc.chargeId && !live.has(proc.chargeId) ? [proc.name] : []), ...active.filter((i) => !live.has(i.chargeId)).map((i) => `${KIND_LABEL[i.kind].toLowerCase()} ${i.name}`)];
      if (missing.length) throw new DomainError("INVALID_STATE", `These have no live charge: ${missing.join(", ")}. Record them again before finalising.`, 409);
      await tx.procedure.update({ where: { id: proc.id }, data: { status: "FINALISED", finalisedAt: new Date(), finalisedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_FINALISED", entityType: "Procedure", entityId: proc.id, metadata: { admissionId: adm.id, name: proc.name, implants: active.filter((i) => i.kind === "IMPLANT").length, consumables: active.filter((i) => i.kind === "CONSUMABLE").length } });
      return { id: proc.id, status: "FINALISED" as const };
    });
  }

  /** A planned procedure that will not happen is cancelled with a reason; anything recorded against it is taken off the bill. */
  async cancel(ctx: RequestContext, procedureId: string, input: z.infer<typeof cancelProcedureSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const { proc, adm } = await this.lock(tx, ctx, procedureId);
      this.openForCharges(adm);
      if (proc.status !== "PLANNED") throw new DomainError("INVALID_STATE", proc.status === "PERFORMED" ? "A performed procedure cannot be cancelled. Remove what was recorded in error, then finalise it." : `A ${proc.status.toLowerCase()} procedure cannot be cancelled`, 409);
      for (const i of proc.items.filter((x) => !x.removedAt)) {
        const voided = await tx.charge.updateMany({ where: { id: i.chargeId, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "VOIDED", voidReason: `${proc.name} cancelled: ${input.reason}`, voidedById: ctx.userId, voidedAt: new Date() } });
        if (voided.count !== 1) throw new DomainError("INVALID_STATE", "An item is already on a bill, so the procedure cannot be cancelled. Ask billing for a credit note.", 409);
        await tx.procedureItem.update({ where: { id: i.id }, data: { removedAt: new Date(), removedById: ctx.userId, removeReason: `Procedure cancelled: ${input.reason}` } });
      }
      await tx.procedure.update({ where: { id: proc.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "PROCEDURE_CANCELLED", entityType: "Procedure", entityId: proc.id, metadata: { admissionId: adm.id, name: proc.name, reason: input.reason } });
      return { id: proc.id, status: "CANCELLED" as const };
    });
  }
}
