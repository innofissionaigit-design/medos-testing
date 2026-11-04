import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { percent } from "../billing/money.schema";

export const FORMS = ["TABLET", "CAPSULE", "SYRUP", "INJECTION", "OINTMENT", "DROPS", "INHALER", "SACHET", "OTHER"] as const;
const name = z.string().trim().min(2).max(120);

export const identityKey = (brand: string, generic: string, strength: string | null | undefined, form: string): string =>
  [brand, generic, strength ?? "", form].map((s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()).join("|");

const base = {
  brandName: name, genericName: name,
  strength: z.string().trim().min(1).max(40).nullable(),
  dosageForm: z.enum(FORMS),
  manufacturer: z.string().trim().min(2).max(120).nullable(),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "HSN code must be 4-8 digits").nullable(),
  gstPercent: percent,
  reorderLevel: z.number().int().min(0).max(1_000_000),
};

export const createMedicineSchema = z.object(base).partial({ strength: true, manufacturer: true, hsnCode: true, gstPercent: true, reorderLevel: true }).strict();
export const updateMedicineSchema = z.object({ ...base, status: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const searchMedicinesSchema = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+0-9][0-9 ()-]{6,19}$/).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN").optional(),
  address: z.string().trim().max(240).optional(),
}).strict();
export const updateSupplierSchema = createSupplierSchema.partial().extend({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");

const VIEW = { id: true, brandName: true, genericName: true, strength: true, dosageForm: true, manufacturer: true, hsnCode: true, gstPercent: true, reorderLevel: true, status: true } satisfies Prisma.MedicineSelect;
const SUPPLIER = { id: true, name: true, phone: true, email: true, gstin: true, address: true, status: true } satisfies Prisma.SupplierSelect;
export const toMedicineView = (m: Prisma.MedicineGetPayload<{ select: typeof VIEW }>) => ({ ...m, gstPercent: m.gstPercent.toFixed(2) });

@Injectable()
export class MedicinesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async search(ctx: RequestContext, q: z.infer<typeof searchMedicinesSchema>) {
    const showInactive = q.includeInactive && ctx.permissions.has("PHARMACY_MASTERS");
    const where: Prisma.MedicineWhereInput = {
      tenantId: ctx.tenantId, ...(showInactive ? {} : { status: "ACTIVE" }),
      // Every word must match the brand, generic name or strength, so "Cefixime 200 mg" finds Cefixime-Rx 200 mg.
      ...(q.q ? { AND: q.q.split(/\s+/).filter(Boolean).slice(0, 6).map((w) => ({ OR: [{ brandName: { contains: w, mode: "insensitive" as const } }, { genericName: { contains: w, mode: "insensitive" as const } }, { strength: { contains: w, mode: "insensitive" as const } }] })) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.medicine.findMany({ where, select: VIEW, orderBy: [{ brandName: "asc" }, { strength: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.medicine.count({ where }),
    ]);
    return { items: rows.map(toMedicineView), total };
  }

  async create(ctx: RequestContext, input: z.infer<typeof createMedicineSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.medicine.create({
        data: {
          tenantId: ctx.tenantId, brandName: input.brandName, genericName: input.genericName, strength: input.strength ?? null, dosageForm: input.dosageForm,
          manufacturer: input.manufacturer ?? null, hsnCode: input.hsnCode ?? null, gstPercent: (input.gstPercent ?? 0).toString(), reorderLevel: input.reorderLevel ?? 0,
          identityKey: identityKey(input.brandName, input.genericName, input.strength, input.dosageForm),
        },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "MEDICINE_CREATED", entityType: "Medicine", entityId: m.id, metadata: { gstPercent: m.gstPercent.toFixed(2) } });
      return toMedicineView(m);
    });
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateMedicineSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.medicine.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const data: Prisma.MedicineUpdateInput = {};
      if (input.brandName !== undefined) data.brandName = input.brandName;
      if (input.genericName !== undefined) data.genericName = input.genericName;
      if (input.strength !== undefined) data.strength = input.strength;
      if (input.dosageForm !== undefined) data.dosageForm = input.dosageForm;
      if (input.manufacturer !== undefined) data.manufacturer = input.manufacturer;
      if (input.hsnCode !== undefined) data.hsnCode = input.hsnCode;
      if (input.gstPercent !== undefined) data.gstPercent = input.gstPercent.toString();
      if (input.reorderLevel !== undefined) data.reorderLevel = input.reorderLevel;
      if (input.status !== undefined) data.status = input.status;
      data.identityKey = identityKey(input.brandName ?? ex.brandName, input.genericName ?? ex.genericName, input.strength === undefined ? ex.strength : input.strength, input.dosageForm ?? ex.dosageForm);
      const m = await tx.medicine.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data, select: VIEW });
      const gstChanged = input.gstPercent !== undefined && !ex.gstPercent.equals(input.gstPercent);
      await this.audit.record(tx, actorOf(ctx), { action: gstChanged ? "MEDICINE_GST_CHANGED" : "MEDICINE_UPDATED", entityType: "Medicine", entityId: id, metadata: { changed: Object.keys(input), ...(gstChanged ? { gstPercent: [ex.gstPercent.toFixed(2), m.gstPercent.toFixed(2)] } : {}) } });
      return toMedicineView(m);
    });
  }

  // ───── suppliers ─────

  async listSuppliers(ctx: RequestContext, includeInactive: boolean) {
    return this.prisma.supplier.findMany({ where: { tenantId: ctx.tenantId, ...(includeInactive ? {} : { status: "ACTIVE" }) }, select: SUPPLIER, orderBy: { name: "asc" }, take: 500 });
  }

  async createSupplier(ctx: RequestContext, input: z.infer<typeof createSupplierSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.supplier.create({ data: { tenantId: ctx.tenantId, ...input }, select: SUPPLIER });
      await this.audit.record(tx, actorOf(ctx), { action: "SUPPLIER_CREATED", entityType: "Supplier", entityId: s.id });
      return s;
    });
  }

  async updateSupplier(ctx: RequestContext, id: string, input: z.infer<typeof updateSupplierSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.supplier.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const s = await tx.supplier.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: SUPPLIER });
      await this.audit.record(tx, actorOf(ctx), { action: "SUPPLIER_UPDATED", entityType: "Supplier", entityId: id, metadata: { changed: Object.keys(input) } });
      return s;
    });
  }
}
