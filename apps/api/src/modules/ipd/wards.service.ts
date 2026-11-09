import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { amount } from "../billing/money.schema";

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/);
const uuid = z.string().uuid();
const BED_STATUSES = ["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING", "MAINTENANCE"] as const;

export const createWardSchema = z.object({ name: z.string().trim().min(2).max(80), code }).strict();
export const updateWardSchema = z.object({ name: z.string().trim().min(2).max(80), status: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const createRoomSchema = z.object({ wardId: uuid, name: z.string().trim().min(1).max(80), code }).strict();
export const updateRoomSchema = updateWardSchema;
export const createBedSchema = z.object({ roomId: uuid, code, dailyRate: amount().prefault(0) }).strict();
export const updateBedSchema = z.object({ dailyRate: amount(), active: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const bedStatusSchema = z.object({ status: z.enum(["AVAILABLE", "CLEANING", "MAINTENANCE", "RESERVED"]), reason: z.string().trim().min(3).max(200).optional() }).strict();
export const listBedsSchema = z.object({ wardId: uuid.optional(), status: z.enum(BED_STATUSES).optional(), includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

/** Manual status changes: who may move a bed where. OCCUPIED is only ever set by an admission or transfer. */
const MANUAL_FROM: Record<string, string[]> = {
  AVAILABLE: ["CLEANING", "MAINTENANCE", "RESERVED"],
  CLEANING: ["AVAILABLE", "MAINTENANCE"],
  MAINTENANCE: ["AVAILABLE", "CLEANING"],
  RESERVED: ["AVAILABLE", "MAINTENANCE"],
};

const BED = { id: true, code: true, status: true, active: true, dailyRate: true, wardId: true, roomId: true, version: true } satisfies Prisma.BedSelect;
const toBed = (b: Prisma.BedGetPayload<{ select: typeof BED }>) => ({ ...b, dailyRate: fmt(b.dailyRate) });

@Injectable()
export class WardsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ───── masters ─────

  async listWards(ctx: RequestContext, includeInactive: boolean) {
    return this.prisma.ward.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(includeInactive ? {} : { status: "ACTIVE" }) }, select: { id: true, name: true, code: true, status: true }, orderBy: { name: "asc" } });
  }

  async createWard(ctx: RequestContext, input: z.infer<typeof createWardSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.ward.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...input }, select: { id: true, name: true, code: true, status: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "WARD_CREATED", entityType: "Ward", entityId: w.id, metadata: { code: w.code } });
      return w;
    });
  }

  async updateWard(ctx: RequestContext, id: string, input: z.infer<typeof updateWardSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.ward.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.status === "INACTIVE") {
        const live = await tx.bed.count({ where: { tenantId: ctx.tenantId, wardId: id, status: { in: ["OCCUPIED", "RESERVED"] } } });
        if (live > 0) throw new DomainError("INVALID_STATE", "This ward still has occupied or reserved beds", 409);
      }
      const w = await tx.ward.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: { id: true, name: true, code: true, status: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "WARD_UPDATED", entityType: "Ward", entityId: id, metadata: { changed: Object.keys(input) } });
      return w;
    });
  }

  async listRooms(ctx: RequestContext, wardId: string | undefined, includeInactive = false) {
    return this.prisma.room.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(includeInactive ? {} : { status: "ACTIVE" as const }), ...(wardId ? { wardId } : {}) }, select: { id: true, name: true, code: true, wardId: true, status: true }, orderBy: { name: "asc" } });
  }

  async createRoom(ctx: RequestContext, input: z.infer<typeof createRoomSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ward = await tx.ward.findFirst({ where: { id: input.wardId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
      if (!ward) throw new DomainError("VALIDATION_FAILED", "Ward not found or inactive", 400, [{ path: "wardId", message: "Unknown ward" }]);
      const r = await tx.room.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...input }, select: { id: true, name: true, code: true, wardId: true, status: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "ROOM_CREATED", entityType: "Room", entityId: r.id, metadata: { code: r.code } });
      return r;
    });
  }

  async updateRoom(ctx: RequestContext, id: string, input: z.infer<typeof updateRoomSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.room.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.status === "INACTIVE" && (await tx.bed.count({ where: { tenantId: ctx.tenantId, roomId: id, status: { in: ["OCCUPIED", "RESERVED"] } } })) > 0) {
        throw new DomainError("INVALID_STATE", "This room still has occupied or reserved beds", 409);
      }
      if (input.status === "ACTIVE" && ex.status !== "ACTIVE") {
        const ward = await tx.ward.findFirst({ where: { id: ex.wardId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { status: true } });
        if (ward?.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "Switch the ward back on first", 409);
      }
      const r = await tx.room.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: input, select: { id: true, name: true, code: true, wardId: true, status: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "ROOM_UPDATED", entityType: "Room", entityId: id, metadata: { changed: Object.keys(input) } });
      return r;
    });
  }

  async createBed(ctx: RequestContext, input: z.infer<typeof createBedSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: { id: input.roomId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
      if (!room) throw new DomainError("VALIDATION_FAILED", "Room not found or inactive", 400, [{ path: "roomId", message: "Unknown room" }]);
      const ward = await tx.ward.findFirst({ where: { id: room.wardId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true } });
      if (!ward) throw new DomainError("VALIDATION_FAILED", "The ward of this room is switched off", 400, [{ path: "roomId", message: "Ward is inactive" }]);
      const b = await tx.bed.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, wardId: room.wardId, roomId: room.id, code: input.code, dailyRate: input.dailyRate.toFixed(2) }, select: BED });
      await this.audit.record(tx, actorOf(ctx), { action: "BED_CREATED", entityType: "Bed", entityId: b.id, metadata: { code: b.code } });
      return toBed(b);
    });
  }

  async updateBed(ctx: RequestContext, id: string, input: z.infer<typeof updateBedSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const ex = await tx.bed.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (input.active === "INACTIVE" && (ex.status === "OCCUPIED" || ex.status === "RESERVED")) throw new DomainError("BED_NOT_AVAILABLE", "An occupied or reserved bed cannot be retired", 409);
      if (input.active === "ACTIVE" && ex.active !== "ACTIVE") {
        const [ward, room] = await Promise.all([
          tx.ward.findFirst({ where: { id: ex.wardId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { status: true } }),
          tx.room.findFirst({ where: { id: ex.roomId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { status: true } }),
        ]);
        if (ward?.status !== "ACTIVE" || room?.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "Switch the ward and room back on first", 409);
      }
      const b = await tx.bed.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { ...(input.dailyRate !== undefined ? { dailyRate: input.dailyRate.toFixed(2) } : {}), ...(input.active ? { active: input.active } : {}), version: { increment: 1 } }, select: BED,
      });
      const rateChanged = input.dailyRate !== undefined && !ex.dailyRate.equals(input.dailyRate);
      await this.audit.record(tx, actorOf(ctx), { action: rateChanged ? "BED_RATE_CHANGED" : "BED_UPDATED", entityType: "Bed", entityId: id, metadata: { changed: Object.keys(input), ...(rateChanged ? { dailyRate: [fmt(ex.dailyRate), fmt(b.dailyRate)] } : {}) } });
      return toBed(b);
    });
  }

  async listBeds(ctx: RequestContext, q: z.infer<typeof listBedsSchema>) {
    const rows = await this.prisma.bed.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.includeInactive ? {} : { active: "ACTIVE" }), ...(q.wardId ? { wardId: q.wardId } : {}), ...(q.status ? { status: q.status } : {}) },
      select: BED, orderBy: [{ code: "asc" }], take: 1000,
    });
    return rows.map(toBed);
  }

  // ───── bed status ─────

  async setBedStatus(ctx: RequestContext, id: string, input: z.infer<typeof bedStatusSchema>) {
    const can = (p: Parameters<RequestContext["permissions"]["has"]>[0]) => ctx.permissions.has(p);
    const allowed = input.status === "MAINTENANCE" ? can("ADMIN_MASTERS")
      : input.status === "RESERVED" ? can("ADMISSION_CREATE")
        : can("NURSING_DOCUMENT") || can("ADMIN_MASTERS");
    if (!allowed) throw new DomainError("FORBIDDEN", "You do not have permission to set this bed status", 403);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "Bed" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      const from = locked[0]?.status;
      if (!from) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!MANUAL_FROM[input.status]?.includes(from)) {
        throw new DomainError("BED_NOT_AVAILABLE", `A ${from.toLowerCase()} bed cannot be set to ${input.status.toLowerCase()} manually`, 409);
      }
      const b = await tx.bed.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: input.status, version: { increment: 1 } }, select: BED });
      await this.audit.record(tx, actorOf(ctx), { action: "BED_STATUS_CHANGED", entityType: "Bed", entityId: id, metadata: { from, to: input.status, ...(input.reason ? { reason: input.reason } : {}) } });
      return toBed(b);
    });
  }

  /** Ward -> room -> bed board with the current occupant of each bed. */
  async board(ctx: RequestContext) {
    const wards = await this.prisma.ward.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, orderBy: { name: "asc" },
      select: { id: true, name: true, code: true, rooms: { where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true, beds: { where: { active: "ACTIVE" }, orderBy: { code: "asc" }, select: BED } } } },
    });
    const open = await this.prisma.bedAssignment.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, releasedAt: null },
      select: { bedId: true, assignedAt: true, admission: { select: { id: true, admissionNumber: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } } } },
    });
    const byBed = new Map(open.map((o) => [o.bedId, o]));
    const summary = { total: 0, AVAILABLE: 0, OCCUPIED: 0, RESERVED: 0, CLEANING: 0, MAINTENANCE: 0 };
    const out = wards.map((w) => ({
      id: w.id, name: w.name, code: w.code,
      rooms: w.rooms.map((r) => ({
        id: r.id, name: r.name, code: r.code,
        beds: r.beds.map((b) => {
          summary.total++; summary[b.status]++;
          const o = byBed.get(b.id);
          return { ...toBed(b), occupant: o ? { admissionId: o.admission.id, admissionNumber: o.admission.admissionNumber, since: o.assignedAt, patientName: [o.admission.patient.firstName, o.admission.patient.lastName].filter(Boolean).join(" "), mrn: o.admission.patient.identifiers[0]?.value ?? null } : null };
        }),
      })),
    }));
    return { wards: out, summary };
  }
}
