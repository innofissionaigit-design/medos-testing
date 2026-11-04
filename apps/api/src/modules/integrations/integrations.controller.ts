import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { Ctx, id, parse, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { allowedIpsSchema, createClientSchema, IntegrationsService, revokeClientSchema } from "./integrations.service";
import { saveWebhookSchema, WebhooksService } from "./webhooks.service";

/** Administration of API clients (docs/integration-api.md). Only people with ADMIN_INTEGRATIONS; an API key itself can never reach these routes. */
@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService, private readonly webhooks: WebhooksService) {}

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Get("abilities")
  abilities() { return { data: this.integrations.abilities() }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Get("clients")
  async list(@Ctx() ctx: RequestContext) { return { data: await this.integrations.list(ctx) }; }

  /** The response carries the API key. It is shown once and cannot be retrieved again. */
  @RequirePermissions("ADMIN_INTEGRATIONS")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("clients")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.integrations.create(ctx, parse(createClientSchema, body)) }; }

  /** Where a key may be used from. Empty means from anywhere. */
  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Put("clients/:id/allowed-ips")
  async setAllowedIps(@Ctx() ctx: RequestContext, @Param("id") clientId: string, @Body() body: unknown) { return { data: await this.integrations.setAllowedIps(ctx, id(clientId), parse(allowedIpsSchema, body)) }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Get("clients/:id/webhook")
  async webhook(@Ctx() ctx: RequestContext, @Param("id") clientId: string) { return { data: await this.webhooks.get(ctx, id(clientId)) }; }

  /** The response of a new endpoint carries its signing secret. It is shown once. */
  @RequirePermissions("ADMIN_INTEGRATIONS")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Put("clients/:id/webhook")
  async saveWebhook(@Ctx() ctx: RequestContext, @Param("id") clientId: string, @Body() body: unknown) { return { data: await this.webhooks.save(ctx, id(clientId), parse(saveWebhookSchema, body)) }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  @Post("clients/:id/webhook/rotate-secret")
  @HttpCode(200)
  async rotate(@Ctx() ctx: RequestContext, @Param("id") clientId: string) { return { data: await this.webhooks.rotateSecret(ctx, id(clientId)) }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  @Post("clients/:id/webhook/test")
  @HttpCode(200)
  async testWebhook(@Ctx() ctx: RequestContext, @Param("id") clientId: string) { return { data: await this.webhooks.test(ctx, id(clientId)) }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Post("clients/:id/webhook/deliveries/:deliveryId/retry")
  @HttpCode(200)
  async retryDelivery(@Ctx() ctx: RequestContext, @Param("id") clientId: string, @Param("deliveryId") deliveryId: string) { return { data: await this.webhooks.retry(ctx, id(clientId), id(deliveryId)) }; }

  @RequirePermissions("ADMIN_INTEGRATIONS")
  @Post("clients/:id/revoke")
  @HttpCode(200)
  async revoke(@Ctx() ctx: RequestContext, @Param("id") clientId: string, @Body() body: unknown) { return { data: await this.integrations.revoke(ctx, id(clientId), parse(revokeClientSchema, body)) }; }
}
