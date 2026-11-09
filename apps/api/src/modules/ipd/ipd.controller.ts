import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Feature } from "../../common/feature.guard";
import { AnyAuthenticated, Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { z } from "zod";
import { AdmissionsService, admitSchema, cancelAdmissionSchema, listAdmissionsSchema, transferSchema } from "./admissions.service";
import { ChargesService, listChargesSchema, postChargeSchema, voidChargeSchema } from "./charges.service";
import {
  bedStatusSchema, createBedSchema, createRoomSchema, createWardSchema, listBedsSchema, updateBedSchema, updateRoomSchema, updateWardSchema, WardsService,
} from "./wards.service";

const wardQuery = z.object({ includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();
const roomQuery = z.object({ wardId: z.string().uuid().optional(), includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

@Feature("IPD_ENABLED")
@Controller()
export class IpdController {
  constructor(private readonly wards: WardsService, private readonly admissions: AdmissionsService, private readonly charges: ChargesService) {}

  // ───── ward / room / bed masters ─────

  @RequirePermissions("ADMISSION_READ")
  @Get("wards")
  async listWards(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.wards.listWards(ctx, parse(wardQuery, query).includeInactive && ctx.permissions.has("ADMIN_MASTERS")) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("wards")
  async createWard(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.wards.createWard(ctx, parse(createWardSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("wards/:id")
  async updateWard(@Ctx() ctx: RequestContext, @Param("id") wardId: string, @Body() body: unknown) {
    return { data: await this.wards.updateWard(ctx, id(wardId), parse(updateWardSchema, body)) };
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("rooms")
  async listRooms(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(roomQuery, query);
    return { data: await this.wards.listRooms(ctx, q.wardId, q.includeInactive && ctx.permissions.has("ADMIN_MASTERS")) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("rooms")
  async createRoom(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.wards.createRoom(ctx, parse(createRoomSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("rooms/:id")
  async updateRoom(@Ctx() ctx: RequestContext, @Param("id") roomId: string, @Body() body: unknown) {
    return { data: await this.wards.updateRoom(ctx, id(roomId), parse(updateRoomSchema, body)) };
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("beds")
  async listBeds(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.wards.listBeds(ctx, parse(listBedsSchema, query)) };
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("beds/board")
  async board(@Ctx() ctx: RequestContext) {
    return { data: await this.wards.board(ctx) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("beds")
  async createBed(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.wards.createBed(ctx, parse(createBedSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("beds/:id")
  async updateBed(@Ctx() ctx: RequestContext, @Param("id") bedId: string, @Body() body: unknown) {
    return { data: await this.wards.updateBed(ctx, id(bedId), parse(updateBedSchema, body)) };
  }

  /** Permission depends on the target status (nurses clean, admins retire for maintenance, admissions reserve): enforced in the service. */
  @AnyAuthenticated()
  @Post("beds/:id/status")
  @HttpCode(200)
  async bedStatus(@Ctx() ctx: RequestContext, @Param("id") bedId: string, @Body() body: unknown) {
    return { data: await this.wards.setBedStatus(ctx, id(bedId), parse(bedStatusSchema, body)) };
  }

  // ───── admissions ─────

  @RequirePermissions("ADMISSION_CREATE")
  @Post("admissions")
  async admit(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.admissions.admit(ctx, parse(admitSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    return { data: result };
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("admissions")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listAdmissionsSchema, query);
    const { items, total } = await this.admissions.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("admissions/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.admissions.get(ctx, id(admissionId)) };
  }

  @RequirePermissions("ADMISSION_TRANSFER")
  @Post("admissions/:id/transfer")
  @HttpCode(200)
  async transfer(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.admissions.transfer(ctx, id(admissionId), parse(transferSchema, body)) };
  }

  @RequirePermissions("ADMISSION_CREATE")
  @Post("admissions/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.admissions.cancel(ctx, id(admissionId), parse(cancelAdmissionSchema, body)) };
  }

  // ───── charges ─────

  @RequirePermissions("INVOICE_READ")
  @Get("charges/unbilled")
  async unbilledCharges(@Ctx() ctx: RequestContext) {
    return { data: await this.charges.unbilled(ctx) };
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("admissions/:id/charges")
  async listCharges(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Query() query: unknown) {
    return { data: await this.charges.list(ctx, id(admissionId), parse(listChargesSchema, query).status) };
  }

  @RequirePermissions("CHARGE_CREATE")
  @Post("admissions/:id/charges")
  async postCharge(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.charges.post(ctx, id(admissionId), parse(postChargeSchema, body)) };
  }

  @RequirePermissions("CHARGE_CREATE")
  @Post("admissions/:id/charges/bed-days")
  @HttpCode(200)
  async bedDays(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.charges.postBedDays(ctx, id(admissionId)) };
  }

  @RequirePermissions("CHARGE_CREATE")
  @Post("charges/:id/void")
  @HttpCode(200)
  async voidCharge(@Ctx() ctx: RequestContext, @Param("id") chargeId: string, @Body() body: unknown) {
    return { data: await this.charges.void(ctx, id(chargeId), parse(voidChargeSchema, body).reason) };
  }
}
