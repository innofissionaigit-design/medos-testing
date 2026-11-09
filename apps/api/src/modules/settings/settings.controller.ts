import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { AnyAuthenticated, Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { putSettingSchema, SettingsService, settingKeySchema } from "./settings.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Which modules are enabled: drives role-aware navigation. */
  @AnyAuthenticated()
  @Get("features")
  async features(@Ctx() ctx: RequestContext) {
    return { data: await this.settings.features(ctx) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.settings.list(ctx) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Put(":key")
  async put(@Ctx() ctx: RequestContext, @Param("key") key: string, @Body() body: unknown) {
    const k = settingKeySchema.safeParse(key);
    if (!k.success) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { data: await this.settings.put(ctx, k.data, parse(putSettingSchema, body).value) };
  }
}
