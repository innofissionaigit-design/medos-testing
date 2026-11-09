import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { assertPatientVisible } from "../../common/data-scope";
import { chartPatientIds, linkedPatientIds } from "../patients/patient-links";

export const createAllergySchema = z.object({
  allergen: z.string().trim().min(2).max(80),
  type: z.enum(["DRUG", "FOOD", "ENVIRONMENT", "OTHER"]),
  reaction: z.string().trim().max(200).optional(),
  severity: z.enum(["MILD", "MODERATE", "SEVERE", "LIFE_THREATENING"]),
}).strict();

export const allergyStatusSchema = z.object({
  status: z.enum(["ACTIVE", "RESOLVED", "ENTERED_IN_ERROR"]),
  reason: z.string().trim().min(3).max(240),
}).strict();

export const listAllergiesSchema = z.object({ all: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

const TRANSITIONS: Record<string, string[]> = { ACTIVE: ["RESOLVED", "ENTERED_IN_ERROR"], RESOLVED: ["ACTIVE", "ENTERED_IN_ERROR"], ENTERED_IN_ERROR: [] };

export const allergenKey = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const VIEW = {
  id: true, allergen: true, type: true, reaction: true, severity: true, status: true, recordedAt: true, recordedById: true,
  statusReason: true, statusChangedAt: true, statusChangedById: true,
} satisfies Prisma.AllergySelect;

export interface AllergyWarning { allergyId: string; allergen: string; severity: string; matchedItem: string }

/** Names match when either contains the other (min 3 chars), after normalisation. Deliberately generous: a false alarm is cheap. */
export function findAllergyMatches(allergies: { id: string; allergen: string; allergenKey: string; severity: string }[], itemNames: string[]): AllergyWarning[] {
  const out: AllergyWarning[] = [];
  for (const a of allergies) {
    for (const name of itemNames) {
      const k = allergenKey(name);
      if (k.length >= 3 && a.allergenKey.length >= 3 && (k.includes(a.allergenKey) || a.allergenKey.includes(k))) {
        out.push({ allergyId: a.id, allergen: a.allergen, severity: a.severity, matchedItem: name });
        break;
      }
    }
  }
  return out;
}

@Injectable()
export class AllergiesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: RequestContext, patientId: string, all: boolean) {
    // A chart includes the allergies recorded on any duplicate linked to the patient: a merge must never hide an allergy.
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    await assertPatientVisible(this.prisma, ctx, patientId);
    return this.prisma.allergy.findMany({
      where: { tenantId: ctx.tenantId, patientId: { in: ids }, ...(all ? {} : { status: "ACTIVE" }) },
      select: VIEW, orderBy: [{ severity: "desc" }, { recordedAt: "desc" }],
    });
  }

  async activeForMatching(db: Db, ctx: RequestContext, patientId: string) {
    const ids = (await chartPatientIds(db, ctx.tenantId, patientId)) ?? [patientId];
    return db.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: ids }, status: "ACTIVE" }, select: { id: true, allergen: true, allergenKey: true, severity: true } });
  }

  async create(ctx: RequestContext, patientId: string, input: z.infer<typeof createAllergySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true, mergedIntoId: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (patient.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Record the allergy on the real patient.", 409, { mergedIntoId: patient.mergedIntoId });
      const key = allergenKey(input.allergen);
      if (!key) throw new DomainError("VALIDATION_FAILED", "Enter the allergen name", 400);
      const dup = await tx.allergy.findFirst({ where: { tenantId: ctx.tenantId, patientId: { in: await linkedPatientIds(tx, ctx.tenantId, patientId) }, type: input.type, allergenKey: key, status: "ACTIVE" } });
      if (dup) throw new DomainError("CONFLICT", "This allergy is already recorded for the patient", 409);
      const a = await tx.allergy.create({
        data: { tenantId: ctx.tenantId, patientId, allergen: input.allergen, allergenKey: key, type: input.type, reaction: input.reaction ?? null, severity: input.severity, recordedById: ctx.userId },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "ALLERGY_RECORDED", entityType: "Allergy", entityId: a.id, metadata: { patientId, type: input.type, severity: input.severity } });
      return a;
    });
  }

  async changeStatus(ctx: RequestContext, id: string, input: z.infer<typeof allergyStatusSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.allergy.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!TRANSITIONS[existing.status]?.includes(input.status)) {
        throw new DomainError("INVALID_STATE", `An allergy that is ${existing.status.toLowerCase().replace(/_/g, " ")} cannot become ${input.status.toLowerCase().replace(/_/g, " ")}`, 409);
      }
      if (input.status === "ACTIVE") {
        const dup = await tx.allergy.findFirst({ where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(tx, ctx.tenantId, existing.patientId)) ?? [existing.patientId] }, type: existing.type, allergenKey: existing.allergenKey, status: "ACTIVE" } });
        if (dup) throw new DomainError("CONFLICT", "This allergy is already active", 409);
      }
      const res = await tx.allergy.updateMany({
        where: { id, tenantId: ctx.tenantId, status: existing.status },
        data: { status: input.status, statusReason: input.reason, statusChangedById: ctx.userId, statusChangedAt: new Date() },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The allergy was changed by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), {
        action: "ALLERGY_STATUS_CHANGED", entityType: "Allergy", entityId: id,
        metadata: { patientId: existing.patientId, from: existing.status, to: input.status, reason: input.reason },
      });
      return tx.allergy.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, select: VIEW });
    });
  }
}
