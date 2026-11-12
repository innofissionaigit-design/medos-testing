import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { cancelSchema, doneSchema, HousekeepingService, listSchema, requestSchema } from "./housekeeping.service";

/** Housekeeping and maintenance requests (docs/housekeeping.md). */
@Controller()
export class HousekeepingController {
  constructor(private readonly housekeeping: HousekeepingService) {}

  @RequireAnyPermission("HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE")
  @Get("housekeeping/requests")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.housekeeping.list(ctx, parse(listSchema, query)) }; }

  @RequirePermissions("HOUSEKEEPING_REQUEST")
  @Post("housekeeping/requests")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.housekeeping.create(ctx, parse(requestSchema, body)) }; }

  @RequirePermissions("HOUSEKEEPING_MANAGE")
  @Post("housekeeping/requests/:id/start")
  @HttpCode(200)
  async start(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.housekeeping.start(ctx, id(requestId)) }; }

  @RequirePermissions("HOUSEKEEPING_MANAGE")
  @Post("housekeeping/requests/:id/done")
  @HttpCode(200)
  async done(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.housekeeping.done(ctx, id(requestId), parse(doneSchema, body)) }; }

  @RequireAnyPermission("HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE")
  @Post("housekeeping/requests/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.housekeeping.cancel(ctx, id(requestId), parse(cancelSchema, body)) }; }
}
