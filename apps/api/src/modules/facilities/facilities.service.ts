import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const phone = z.string().trim().regex(/^[+0-9][0-9 ()-]{6,19}$/, "Invalid phone number");

const profile = {
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(240).nullable(),
  city: z.string().trim().max(80).nullable(),
  district: z.string().trim().max(80).nullable(),
  state: z.string().trim().max(80).nullable(),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, "Postal code must be 6 digits").nullable(),
  phone: phone.nullable(),
  email: z.string().trim().toLowerCase().email().nullable(),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, "Invalid GSTIN").nullable(),
};

export const createFacilitySchema = z.object({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/, "Uppercase letters, digits, hyphen; max 16"),
  ...profile,
  name: profile.name,
}).partial({ address: true, city: true, district: true, state: true, postalCode: true, phone: true, email: true, gstin: true }).strict();

export const updateFacilitySchema = z.object({ ...profile, status: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");

const SELECT = {
  id: true, name: true, code: true, address: true, city: true, district: true, state: true,
  postalCode: true, phone: true, email: true, gstin: true, timezone: true, status: true,
} as const;

@Injectable()
export class FacilitiesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(ctx: RequestContext) {
    const all = ctx.permissions.has("ADMIN_SETTINGS");
    return this.prisma.facility.findMany({
      where: { tenantId: ctx.tenantId, ...(all ? {} : { userFacilities: { some: { userId: ctx.userId, tenantId: ctx.tenantId } } }) },
      select: SELECT,
      orderBy: { name: "asc" },
    });
  }

  async get(ctx: RequestContext, id: string) {
    const all = ctx.permissions.has("ADMIN_SETTINGS");
    const f = await this.prisma.facility.findFirst({
      where: { id, tenantId: ctx.tenantId, ...(all ? {} : { userFacilities: { some: { userId: ctx.userId, tenantId: ctx.tenantId } } }) },
      select: SELECT,
    });
    if (!f) throw new DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);
    return f;
  }

  async create(ctx: RequestContext, input: z.infer<typeof createFacilitySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: ctx.tenantId }, select: { timezone: true } });
      const f = await tx.facility.create({ data: { ...input, tenantId: ctx.tenantId, timezone: tenant.timezone }, select: SELECT });
      await tx.userFacility.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, facilityId: f.id } });
      await this.audit.record(tx, { ...actorOf(ctx), facilityId: f.id }, { action: "FACILITY_CREATED", entityType: "Facility", entityId: f.id, metadata: { code: f.code } });
      return f;
    });
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updateFacilitySchema>) {
    if (input.status === "INACTIVE" && id === ctx.facilityId) {
      throw new DomainError("INVALID_STATE", "You cannot deactivate the facility you are currently working in", 409);
    }
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.facility.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new DomainError("FACILITY_NOT_FOUND", "Facility not found", 404);
      if (input.status === "INACTIVE" && existing.status === "ACTIVE") {
        // Switching a facility off stops everybody signing in to it, so it must not be done while patients are in its beds.
        const admitted = await tx.admission.count({ where: { tenantId: ctx.tenantId, facilityId: id, status: "ADMITTED" } });
        if (admitted > 0) throw new DomainError("INVALID_STATE", `${admitted} patient${admitted === 1 ? ' is' : 's are'} still admitted at this facility. Discharge them first.`, 409, { admitted });
      }
      const f = await tx.facility.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: SELECT });
      await this.audit.record(tx, { ...actorOf(ctx), facilityId: id }, {
        action: input.status && input.status !== existing.status ? "FACILITY_STATUS_CHANGED" : "FACILITY_UPDATED",
        entityType: "Facility", entityId: id, metadata: { changed: Object.keys(input) },
      });
      return f;
    });
  }
}
