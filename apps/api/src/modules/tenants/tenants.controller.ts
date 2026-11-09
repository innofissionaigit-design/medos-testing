import { Body, Controller, Get, Patch } from "@nestjs/common";
import { AnyAuthenticated, Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { TenantsService, updateTenantSchema } from "./tenants.service";

@Controller("tenants")
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @AnyAuthenticated()
  @Get("current")
  async current(@Ctx() ctx: RequestContext) {
    return { data: await this.tenants.getCurrent(ctx) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Patch("current")
  async update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.tenants.updateCurrent(ctx, parse(updateTenantSchema, body)) };
  }
}
