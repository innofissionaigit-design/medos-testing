import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { AllergiesService, findAllergyMatches, type AllergyWarning } from "../clinical/allergies.service";
import { ClinicianService } from "../clinical/clinician.service";
import { EncountersService } from "../encounters/encounters.service";
import { NumberingService } from "../numbering/numbering.service";

export const FOOD_RELATIONS = ["BEFORE_FOOD", "AFTER_FOOD", "WITH_FOOD", "EMPTY_STOMACH", "ANY_TIME"] as const;
const optText = (max: number) => z.string().trim().min(1).max(max).optional();

export const orderItemSchema = z.object({
  medicineId: z.string().uuid().optional(),
  genericName: z.string().trim().min(2).max(120),
  brandName: optText(120),
  strength: optText(40),
  dosage: z.string().trim().min(1).max(60),
  route: z.enum(["ORAL", "IV", "IM", "SC", "TOPICAL", "OTHER"]),
  frequency: z.enum(["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "OTHER"]),
  frequencyText: optText(60),
  foodRelation: z.enum(FOOD_RELATIONS).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
  instructions: optText(200),
}).strict().superRefine((v, c) => {
  if (v.frequency === "OTHER" && !v.frequencyText) c.addIssue({ code: "custom", path: ["frequencyText"], message: "Describe the frequency" });
});
export type OrderItemInput = z.infer<typeof orderItemSchema>;

export const saveDraftSchema = z.object({ items: z.array(orderItemSchema).min(1).max(30) }).strict();
export const signPrescriptionSchema = z.object({ acknowledgeAllergyWarnings: z.boolean().optional() }).strict();
export const stopItemSchema = z.object({ reason: z.string().trim().min(3).max(240) }).strict();

const ORDER_VIEW = {
  id: true, orderNumber: true, status: true, source: true, encounterId: true, patientId: true, orderedById: true, signedById: true, signedAt: true,
  supersededAtVersion: true, createdAt: true,
  items: {
    orderBy: { lineNo: "asc" as const },
    select: {
      id: true, lineNo: true, medicineId: true, genericName: true, brandName: true, strength: true, dosage: true, route: true, frequency: true,
      frequencyText: true, foodRelation: true, durationDays: true, quantity: true, instructions: true, status: true, dispensedQuantity: true, stopReason: true,
    },
  },
} satisfies Prisma.MedicationOrderSelect;
export type OrderView = Prisma.MedicationOrderGetPayload<{ select: typeof ORDER_VIEW }>;

const toItemData = (tenantId: string, orderId: string, items: OrderItemInput[]): Prisma.MedicationOrderItemCreateManyInput[] =>
  items.map((it, i) => ({
    tenantId, orderId, lineNo: i + 1, medicineId: it.medicineId ?? null, genericName: it.genericName, brandName: it.brandName ?? null, strength: it.strength ?? null,
    dosage: it.dosage, route: it.route, frequency: it.frequency, frequencyText: it.frequencyText ?? null, foodRelation: it.foodRelation ?? null,
    durationDays: it.durationDays ?? null, quantity: it.quantity ?? null, instructions: it.instructions ?? null,
  }));

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encounters: EncountersService,
    private readonly clinicians: ClinicianService,
    private readonly allergies: AllergiesService,
    private readonly numbering: NumberingService,
  ) {}

  /** The doctor's working prescription. Replaces the draft's items; the draft is not visible to pharmacy. */
  async saveDraft(ctx: RequestContext, encounterId: string, input: z.infer<typeof saveDraftSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      await this.clinicians.requireActive(tx, ctx);
      await this.assertOpenForPrescribing(tx, ctx, enc.type, encounterId);
      await this.assertMedicines(tx, ctx, input.items);

      let draft = await tx.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId, status: "DRAFT", source: "DIGITAL" } });
      if (draft && draft.orderedById !== ctx.userId) throw new DomainError("FORBIDDEN", "This draft prescription belongs to another doctor", 403);
      if (!draft) {
        draft = await tx.medicationOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, orderedById: ctx.userId } });
      } else {
        await tx.medicationOrderItem.deleteMany({ where: { tenantId: ctx.tenantId, orderId: draft.id } });
      }
      await tx.medicationOrderItem.createMany({ data: toItemData(ctx.tenantId, draft.id, input.items) });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_DRAFT_SAVED", entityType: "MedicationOrder", entityId: draft.id, metadata: { encounterId, items: input.items.length } });
      const order = await tx.medicationOrder.findFirstOrThrow({ where: { id: draft.id, tenantId: ctx.tenantId }, select: ORDER_VIEW });
      return { order, allergyWarnings: await this.warningsFor(tx, ctx, enc.patientId, input.items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])])) };
    });
  }

  async listForEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true, patientId: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const orders = await this.prisma.medicationOrder.findMany({
      where: { tenantId: ctx.tenantId, encounterId, status: { not: "CANCELLED" } }, select: ORDER_VIEW, orderBy: { createdAt: "desc" },
    });
    const draft = orders.find((o) => o.status === "DRAFT");
    const allergyWarnings = draft ? await this.warningsFor(this.prisma, ctx, enc.patientId, draft.items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])])) : [];
    return { orders, allergyWarnings };
  }

  /** IPD (non-consultation) signing. OPD prescriptions are signed together with the consultation. */
  async signStandalone(ctx: RequestContext, encounterId: string, acknowledge: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const enc = await this.encounters.assertActive(tx, ctx, encounterId);
      await this.clinicians.requireActive(tx, ctx);
      if (enc.type === "OPD") throw new DomainError("INVALID_STATE", "OPD prescriptions are signed together with the consultation", 409);
      const signed = await this.signDraft(tx, ctx, encounterId, acknowledge);
      if (!signed) throw new DomainError("INVALID_STATE", "There is no draft prescription to sign", 409);
      return signed;
    });
  }

  /** Signs the encounter's draft order inside the caller's transaction. Returns null when there is no draft. */
  async signDraft(tx: Db, ctx: RequestContext, encounterId: string, acknowledge: boolean): Promise<OrderView | null> {
    const draft = await tx.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId, status: "DRAFT", source: "DIGITAL" }, include: { items: true } });
    if (!draft) return null;
    if (!ctx.permissions.has("PRESCRIPTION_SIGN")) throw new DomainError("FORBIDDEN", "You do not have permission to sign prescriptions", 403);
    if (draft.items.length === 0) throw new DomainError("INVALID_STATE", "The draft prescription has no medicines", 409);
    const warnings = await this.warningsFor(tx, ctx, draft.patientId, draft.items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])]));
    if (warnings.length > 0 && !acknowledge) {
      throw new DomainError("ALLERGY_CONFLICT", "A prescribed medicine matches a recorded allergy. Review it, then confirm to continue.", 409, { allergyWarnings: warnings });
    }
    const orderNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PRESCRIPTION");
    const res = await tx.medicationOrder.updateMany({
      where: { id: draft.id, tenantId: ctx.tenantId, status: "DRAFT" },
      data: { status: "SIGNED", orderNumber, signedAt: new Date(), signedById: ctx.userId },
    });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "The prescription was changed by someone else", 409);
    await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SIGNED", entityType: "MedicationOrder", entityId: draft.id, metadata: { orderNumber, encounterId, items: draft.items.length } });
    if (warnings.length > 0) {
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_ALLERGY_ACKNOWLEDGED", entityType: "MedicationOrder", entityId: draft.id, metadata: { allergies: warnings.map((w) => w.allergen) } });
    }
    return tx.medicationOrder.findFirstOrThrow({ where: { id: draft.id, tenantId: ctx.tenantId }, select: ORDER_VIEW });
  }

  /**
   * Replaces the signed prescription during a consultation amendment. The old order is superseded (kept, never edited).
   * Refuses if any medicine was already dispensed, so pharmacy records can never be contradicted.
   */
  async amend(tx: Db, ctx: RequestContext, encounterId: string, patientId: string, items: OrderItemInput[], atVersion: number, acknowledge: boolean): Promise<OrderView> {
    const current = await tx.medicationOrder.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED", source: "DIGITAL" }, include: { items: true } });
    if (current.some((o) => o.items.some((i) => i.dispensedQuantity > 0))) {
      throw new DomainError("INVALID_STATE", "Some medicines were already dispensed. Stop those items instead of replacing the prescription.", 409);
    }
    await this.assertMedicines(tx, ctx, items);
    const warnings = await this.warningsFor(tx, ctx, patientId, items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])]));
    if (warnings.length > 0 && !acknowledge) throw new DomainError("ALLERGY_CONFLICT", "A prescribed medicine matches a recorded allergy. Review it, then confirm to continue.", 409, { allergyWarnings: warnings });

    await tx.medicationOrder.updateMany({ where: { tenantId: ctx.tenantId, encounterId, status: "DRAFT", source: "DIGITAL" }, data: { status: "CANCELLED" } });
    for (const o of current) {
      await tx.medicationOrder.updateMany({ where: { id: o.id, tenantId: ctx.tenantId, status: "SIGNED" }, data: { status: "SUPERSEDED", supersededAtVersion: atVersion } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SUPERSEDED", entityType: "MedicationOrder", entityId: o.id, metadata: { orderNumber: o.orderNumber, byVersion: atVersion } });
    }
    const created = await tx.medicationOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, encounterId, orderedById: ctx.userId } });
    await tx.medicationOrderItem.createMany({ data: toItemData(ctx.tenantId, created.id, items) });
    const orderNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PRESCRIPTION");
    await tx.medicationOrder.updateMany({ where: { id: created.id, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "SIGNED", orderNumber, signedAt: new Date(), signedById: ctx.userId } });
    await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SIGNED", entityType: "MedicationOrder", entityId: created.id, metadata: { orderNumber, encounterId, amendment: atVersion } });
    if (warnings.length > 0) await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_ALLERGY_ACKNOWLEDGED", entityType: "MedicationOrder", entityId: created.id, metadata: { allergies: warnings.map((w) => w.allergen) } });
    return tx.medicationOrder.findFirstOrThrow({ where: { id: created.id, tenantId: ctx.tenantId }, select: ORDER_VIEW });
  }

  /**
   * The doctor's approval of a handwritten prescription: creates and signs a prescription (source HANDWRITTEN) in the caller's transaction, so the
   * pharmacy sees it. The visit's own digital prescription is not touched. The caller has already checked the doctor's permission and that the lines are theirs.
   */
  async createApprovedFromScan(tx: Db, ctx: RequestContext, scan: { encounterId: string; patientId: string; id: string }, items: OrderItemInput[], acknowledge: boolean): Promise<OrderView> {
    await this.assertMedicines(tx, ctx, items);
    const warnings = await this.warningsFor(tx, ctx, scan.patientId, items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])]));
    if (warnings.length > 0 && !acknowledge) throw new DomainError("ALLERGY_CONFLICT", "A prescribed medicine matches a recorded allergy. Review it, then confirm to continue.", 409, { allergyWarnings: warnings });
    const created = await tx.medicationOrder.create({
      data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: scan.patientId, encounterId: scan.encounterId, orderedById: ctx.userId, source: "HANDWRITTEN", notes: "From a handwritten prescription" },
    });
    await tx.medicationOrderItem.createMany({ data: toItemData(ctx.tenantId, created.id, items) });
    const orderNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PRESCRIPTION");
    const res = await tx.medicationOrder.updateMany({ where: { id: created.id, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "SIGNED", orderNumber, signedAt: new Date(), signedById: ctx.userId } });
    if (res.count !== 1) throw new DomainError("INVALID_STATE", "The prescription was changed by someone else", 409);
    await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SIGNED", entityType: "MedicationOrder", entityId: created.id, metadata: { orderNumber, encounterId: scan.encounterId, items: items.length, source: "HANDWRITTEN", scanId: scan.id } });
    if (warnings.length > 0) await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_ALLERGY_ACKNOWLEDGED", entityType: "MedicationOrder", entityId: created.id, metadata: { allergies: warnings.map((w) => w.allergen) } });
    return tx.medicationOrder.findFirstOrThrow({ where: { id: created.id, tenantId: ctx.tenantId }, select: ORDER_VIEW });
  }

  /** Stops a single active item (e.g. an IPD infusion). The order and its history are untouched. */
  async stopItem(ctx: RequestContext, itemId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.clinicians.requireActive(tx, ctx);
      const item = await tx.medicationOrderItem.findFirst({ where: { id: itemId, tenantId: ctx.tenantId }, include: { order: true } });
      if (!item || item.order.facilityId !== ctx.facilityId) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (item.order.status !== "SIGNED") throw new DomainError("INVALID_STATE", "Only items of a signed prescription can be stopped", 409);
      if (item.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This medicine is already stopped", 409);
      const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: item.order.encounterId, kind: "CONSULTATION" }, select: { id: true } });
      if (doc) throw new DomainError("CONSULTATION_SIGNED", "This prescription belongs to a signed consultation; amend the consultation instead", 409);
      const res = await tx.medicationOrderItem.updateMany({ where: { id: itemId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "STOPPED", stoppedAt: new Date(), stoppedById: ctx.userId, stopReason: reason } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This medicine was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_ITEM_STOPPED", entityType: "MedicationOrderItem", entityId: itemId, metadata: { orderId: item.orderId, reason } });
      return tx.medicationOrderItem.findFirstOrThrow({ where: { id: itemId, tenantId: ctx.tenantId }, select: ORDER_VIEW.items.select });
    });
  }

  // ───── internals ─────

  private async assertMedicines(tx: Db, ctx: RequestContext, items: OrderItemInput[]): Promise<void> {
    const ids = [...new Set(items.flatMap((i) => (i.medicineId ? [i.medicineId] : [])))];
    if (ids.length === 0) return;
    const n = await tx.medicine.count({ where: { id: { in: ids }, tenantId: ctx.tenantId, status: "ACTIVE" } });
    if (n !== ids.length) throw new DomainError("VALIDATION_FAILED", "A selected medicine does not exist or is inactive", 400, [{ path: "items", message: "Unknown medicine" }]);
  }

  private async assertOpenForPrescribing(tx: Db, ctx: RequestContext, type: "OPD" | "IPD", encounterId: string): Promise<void> {
    if (type !== "OPD") return;
    const doc = await tx.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION" }, select: { status: true } });
    if (doc && doc.status !== "DRAFT") throw new DomainError("CONSULTATION_SIGNED", "The consultation is signed. Use an amendment to change the prescription.", 409);
  }

  private async warningsFor(db: Db, ctx: RequestContext, patientId: string, names: string[]): Promise<AllergyWarning[]> {
    return findAllergyMatches(await this.allergies.activeForMatching(db, ctx, patientId), names);
  }
}
