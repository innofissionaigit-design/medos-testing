import { Body, Controller, HttpCode, Get, Post } from "@nestjs/common";
import { AnyAuthenticated, ClientIp, Ctx, parse, Public, RateLimit, RequestId } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AuthService, loginSchema, refreshSchema, switchFacilitySchema } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit({ limit: 10, windowMs: 60_000 })
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @RequestId() requestId: string | undefined, @ClientIp() _ip: string) {
    return { data: await this.auth.login(parse(loginSchema, body), requestId) };
  }

  @Public()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "refreshToken" })
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: unknown, @RequestId() requestId: string | undefined) {
    return { data: await this.auth.refresh(parse(refreshSchema, body).refreshToken, requestId) };
  }

  @Public()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "refreshToken" })
  @Post("logout")
  @HttpCode(204)
  async logout(@Body() body: unknown, @RequestId() requestId: string | undefined): Promise<void> {
    await this.auth.logout(parse(refreshSchema, body).refreshToken, requestId);
  }

  @AnyAuthenticated()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "refreshToken" })
  @Post("switch-facility")
  @HttpCode(200)
  async switchFacility(@Ctx() ctx: RequestContext, @Body() body: unknown, @RequestId() requestId: string | undefined) {
    return { data: await this.auth.switchFacility(ctx.userId, ctx.tenantId, parse(switchFacilitySchema, body), requestId) };
  }

  @AnyAuthenticated()
  @Get("me")
  async me(@Ctx() ctx: RequestContext) {
    return { data: await this.auth.me(ctx.tenantId, ctx.userId, ctx.facilityId, ctx.permissions, ctx.dataScope) };
  }
}
