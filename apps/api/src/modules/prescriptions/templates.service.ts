import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { orderItemSchema } from "./prescriptions.service";

const text = (max: number) => z.string().trim().max(max);

/** What a template holds: the medicines and the other parts of a prescription a doctor writes again and again. Nothing about a patient. */
export const templateContentSchema = z.object({
  items: z.array(orderItemSchema).max(30).default([]),
  investigationsAdvised: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
  otherTestsAdvised: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
  cardiologyAdvised: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
  proceduresAdvised: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
  advice: text(4000).optional(),
  dietAdvice: text(4000).optional(),
  referral: text(500).optional(),
}).strict().refine((c) => c.items.length > 0 || c.investigationsAdvised.length > 0 || c.otherTestsAdvised.length > 0 || c.cardiologyAdvised.length > 0 || c.proceduresAdvised.length > 0 || !!c.advice?.trim() || !!c.dietAdvice?.trim() || !!c.referral?.trim(), "A template needs at least one medicine, test or piece of advice");

export const createTemplateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Shared templates can be used by every doctor of the facility; otherwise only by their owner. */
  shared: z.boolean().default(false),
  content: templateContentSchema,
}).strict();

const VIEW = { id: true, name: true, shared: true, content: true, ownerId: true, createdAt: true } as const;

/** A doctor's saved prescriptions, to reuse in one click (docs/prescriptions.md). Applying one only fills the editor; the doctor still reviews and signs. */
@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Own templates and the facility's shared ones. */
  async list(ctx: RequestContext) {
    const rows = await this.prisma.prescriptionTemplate.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", OR: [{ ownerId: ctx.userId }, { shared: true }] },
      select: { ...VIEW, owner: { select: { fullName: true } } }, orderBy: [{ name: "asc" }], take: 200,
    });
    return rows.map(({ owner, ownerId, ...r }) => ({ ...r, mine: ownerId === ctx.userId, owner: owner.fullName }));
  }

  async create(ctx: RequestContext, input: z.infer<typeof createTemplateSchema>) {
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.prescriptionTemplate.findFirst({ where: { tenantId: ctx.tenantId, ownerId: ctx.userId, name: input.name, status: "ACTIVE" }, select: { id: true } })) {
        throw new DomainError("CONFLICT", "You already have a template with this name", 409);
      }
      // A removed template's name can be used again: the old one is renamed out of the way, never deleted.
      await tx.prescriptionTemplate.updateMany({ where: { tenantId: ctx.tenantId, ownerId: ctx.userId, name: input.name, status: "INACTIVE" }, data: { name: `${input.name} (removed ${Date.now().toString(36)})` } });
      const row = await tx.prescriptionTemplate.create({
        data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ownerId: ctx.userId, name: input.name, shared: input.shared, content: input.content as Prisma.InputJsonObject },
        select: { id: true },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_TEMPLATE_SAVED", entityType: "PrescriptionTemplate", entityId: row.id, metadata: { name: input.name, shared: input.shared, medicines: input.content.items.length } });
      return row.id;
    });
    return (await this.list(ctx)).find((t) => t.id === id);
  }

  /** Only the owner removes a template. It is hidden, not deleted. */
  async remove(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.prescriptionTemplate.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ownerId: ctx.userId, status: "ACTIVE" } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await tx.prescriptionTemplate.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "INACTIVE" } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_TEMPLATE_REMOVED", entityType: "PrescriptionTemplate", entityId: id, metadata: { name: t.name } });
      return { id };
    });
  }
}
