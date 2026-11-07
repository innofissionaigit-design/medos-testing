import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { cancelTeleSchema, createTeleSchema, joinTeleSchema, listTeleSchema, TelemedicineService } from "./telemedicine.service";

/** Video consultations (docs/telemedicine.md): make an appointment a video consultation, the doctor's join and end, and cancelling. */
@Controller("teleconsults")
export class TelemedicineController {
  constructor(private readonly tele: TelemedicineService) {}

  @RequirePermissions("TELE_READ")
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.tele.list(ctx, parse(listTeleSchema, query)) }; }

  @RequirePermissions("TELE_MANAGE")
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.tele.create(ctx, parse(createTeleSchema, body)) }; }

  @RequirePermissions("TELE_CONDUCT")
  @Post(":id/join")
  @HttpCode(200)
  async join(@Ctx() ctx: RequestContext, @Param("id") teleId: string, @Body() body: unknown) { return { data: await this.tele.join(ctx, id(teleId), parse(joinTeleSchema, body ?? {})) }; }

  @RequirePermissions("TELE_CONDUCT")
  @Post(":id/end")
  @HttpCode(200)
  async end(@Ctx() ctx: RequestContext, @Param("id") teleId: string) { return { data: await this.tele.end(ctx, id(teleId)) }; }

  @RequirePermissions("TELE_MANAGE")
  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") teleId: string, @Body() body: unknown) { return { data: await this.tele.cancel(ctx, id(teleId), parse(cancelTeleSchema, body)) }; }
}
