import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { amount, percent } from "./money.schema";

const CATEGORIES = ["CONSULTATION", "ROOM_BED", "PROCEDURE", "NURSING", "INJECTION_DRESSING", "INVESTIGATION", "OTHER"] as const;

export const createServiceSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/),
  name: z.string().trim().min(2).max(120),
  category: z.enum(CATEGORIES),
  price: amount(),
  taxPercent: percent.prefault(0),
  sacCode: z.string().trim().regex(/^\d{4,8}$/, "SAC/HSN code must be 4-8 digits").optional(),
}).strict();

export const updateServiceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.enum(CATEGORIES),
  price: amount(),
  taxPercent: percent,
  sacCode: z.string().trim().regex(/^\d{4,8}$/, "SAC/HSN code must be 4-8 digits").nullable(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
}).partial().strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");

export const listServicesSchema = z.object({
  q: z.string().trim().max(60).optional(),
  category: z.enum(CATEGORIES).optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

const SELECT = { id: true, code: true, name: true, category: true, price: true, taxPercent: true, sacCode: true, status: true } satisfies Prisma.ServiceSelect;
type Row = Prisma.ServiceGetPayload<{ select: typeof SELECT }>;
export const toServiceView = (s: Row) => ({ ...s, price: s.price.toFixed(2), taxPercent: s.taxPercent.toFixed(2) });

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: RequestContext, q: z.infer<typeof listServicesSchema>) {
    const showInactive = q.includeInactive && ctx.permissions.has("ADMIN_MASTERS");
    const where: Prisma.ServiceWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(showInactive ? {} : { status: "ACTIVE" }),
      ...(q.category ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q.toUpperCase() } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.service.findMany({ where, select: SELECT, orderBy: [{ category: "asc" }, { name: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.service.count({ where }),
    ]);
    return { items: rows.map(toServiceView), total };
  }

  async create(ctx: RequestContext, input: z.infer<typeof createServiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.service.create({ data: { ...input, tenantId: ctx.tenantId, facilityId: ctx.facilityId, price: input.price.toFixed(2), taxPercent: input.taxPercent.toFixed(2) }, select: SELECT });
      await this.audit.record(tx, actorOf(ctx), { action: "SERVICE_CREATED", entityType: "Service", entityId: s.id, metadata: { code: s.code, price: s.price.toFixed(2), taxPercent: s.taxPercent.toFixed(2) } });
      return toServiceView(s);
    });
  }

  /** Price and tax changes are audited with before/after: invoices snapshot prices, so old invoices are unaffected. */
  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateServiceSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.service.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const data: Prisma.ServiceUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.category !== undefined) data.category = input.category;
      if (input.status !== undefined) data.status = input.status;
      if (input.price !== undefined) data.price = input.price.toFixed(2);
      if (input.taxPercent !== undefined) data.taxPercent = input.taxPercent.toFixed(2);
      if (input.sacCode !== undefined) data.sacCode = input.sacCode;
      const s = await tx.service.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data, select: SELECT });
      const priceChanged = input.price !== undefined && !existing.price.equals(input.price);
      const taxChanged = input.taxPercent !== undefined && !existing.taxPercent.equals(input.taxPercent);
      await this.audit.record(tx, actorOf(ctx), {
        action: priceChanged || taxChanged ? "SERVICE_PRICE_CHANGED" : "SERVICE_UPDATED", entityType: "Service", entityId: id,
        metadata: { changed: Object.keys(input), ...(priceChanged ? { price: [existing.price.toFixed(2), s.price.toFixed(2)] } : {}), ...(taxChanged ? { taxPercent: [existing.taxPercent.toFixed(2), s.taxPercent.toFixed(2)] } : {}) },
      });
      return toServiceView(s);
    });
  }
}
