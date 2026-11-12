import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { admissionScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { ClinicianService } from "../clinical/clinician.service";

export const orderTestSchema = z.object({ category: z.enum(["LABORATORY", "RADIOLOGY"]), name: z.string().trim().min(2).max(120) }).strict();

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Laboratory and radiology tests for an admitted patient (docs/discharge-stages.md). The treating doctor or the RMO orders a test from the admission;
 * it goes to the cashier like any advised test (docs/test-orders.md), is billed, performed and reported, and the discharge stage
 * "Laboratory / radiology" then watches it until everything is settled.
 */
@Injectable()
export class AdmissionTestsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly clinicians: ClinicianService) {}

  private async admission(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return adm;
  }

  /** The patient's laboratory and radiology tests for this stay (the admission's own visit, and any ordered since admission), and where each one stands. */
  async list(ctx: RequestContext, admissionId: string) {
    const adm = await this.admission(ctx, admissionId);
    const rows = await this.prisma.testOrder.findMany({
      where: { tenantId: ctx.tenantId, category: { in: ["LABORATORY", "RADIOLOGY"] }, OR: [{ encounterId: adm.encounterId }, { patientId: adm.patientId, createdAt: { gte: adm.admittedAt } }] },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, category: true, status: true, cancelReason: true, createdAt: true, labResult: { select: { status: true } }, radStudy: { select: { status: true } } },
    });
    return rows.map((o) => {
      const performed = o.category === "LABORATORY" ? o.labResult?.status === "VERIFIED" : o.radStudy?.status === "REPORTED";
      const state = o.status === "CANCELLED" ? "NOT_NEEDED" : o.status === "ORDERED" ? "TO_BE_BILLED" : performed ? "DONE" : o.category === "LABORATORY" ? "WAITING_FOR_RESULT" : "WAITING_FOR_REPORT";
      return { id: o.id, name: o.name, category: o.category, state, reason: o.cancelReason, orderedAt: o.createdAt };
    });
  }

  async order(ctx: RequestContext, admissionId: string, input: z.infer<typeof orderTestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.admission(ctx, admissionId);
      if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "The admission is already closed", 409);
      await this.clinicians.requireActive(tx, ctx);
      const name = input.name.trim().replace(/\s+/g, " ");
      const same = await tx.testOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, category: input.category, status: { not: "CANCELLED" }, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
      if (same) throw new DomainError("CONFLICT", "This test is already ordered for the admission", 409);
      // Matched to the price list by name or code, like the doctor's advised tests; the cashier chooses a price-list item if nothing matches.
      const services = await tx.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, name: true, code: true } });
      const byText = new Map<string, string>();
      for (const s of services) { byText.set(norm(s.name), s.id); if (!byText.has(norm(s.code))) byText.set(norm(s.code), s.id); }
      const created = await tx.testOrder.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, encounterId: adm.encounterId, category: input.category, name, serviceId: byText.get(norm(name)) ?? null, source: "DIGITAL", orderedById: ctx.userId },
        select: { id: true, name: true, category: true, serviceId: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDERS_PLACED", entityType: "Admission", entityId: adm.id, metadata: { count: 1, category: input.category, name, onPriceList: !!created.serviceId } });
      return { id: created.id, name: created.name, category: created.category, onPriceList: !!created.serviceId, state: "TO_BE_BILLED" as const };
    });
  }
}
