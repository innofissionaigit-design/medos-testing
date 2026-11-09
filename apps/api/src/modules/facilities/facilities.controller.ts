import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { AnyAuthenticated, Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { createFacilitySchema, FacilitiesService, updateFacilitySchema } from "./facilities.service";

@Controller("facilities")
export class FacilitiesController {
  constructor(private readonly facilities: FacilitiesService) {}

  @AnyAuthenticated()
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.facilities.list(ctx) };
  }

  @AnyAuthenticated()
  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") facilityId: string) {
    return { data: await this.facilities.get(ctx, id(facilityId)) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.facilities.create(ctx, parse(createFacilitySchema, body)) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Patch(":id")
  async update(@Ctx() ctx: RequestContext, @Param("id") facilityId: string, @Body() body: unknown) {
    return { data: await this.facilities.update(ctx, id(facilityId), parse(updateFacilitySchema, body)) };
  }
}
