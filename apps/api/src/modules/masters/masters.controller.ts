import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { AnyAuthenticated, Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import {
  createDepartmentSchema, createPractitionerSchema, listMasterSchema, MastersService,
  updateDepartmentSchema, updatePractitionerSchema,
} from "./masters.service";

@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @AnyAuthenticated()
  @Get("departments")
  async departments(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.masters.listDepartments(ctx, parse(listMasterSchema, query).includeInactive) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("departments")
  async createDepartment(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.masters.createDepartment(ctx, parse(createDepartmentSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("departments/:id")
  async updateDepartment(@Ctx() ctx: RequestContext, @Param("id") deptId: string, @Body() body: unknown) {
    return { data: await this.masters.updateDepartment(ctx, id(deptId), parse(updateDepartmentSchema, body)) };
  }

  @AnyAuthenticated()
  @Get("practitioners")
  async practitioners(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.masters.listPractitioners(ctx, parse(listMasterSchema, query)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("practitioners")
  async createPractitioner(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.masters.createPractitioner(ctx, parse(createPractitionerSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("practitioners/:id")
  async updatePractitioner(@Ctx() ctx: RequestContext, @Param("id") pracId: string, @Body() body: unknown) {
    return { data: await this.masters.updatePractitioner(ctx, id(pracId), parse(updatePractitionerSchema, body)) };
  }
}
