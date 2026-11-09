import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Ctx, id, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { PrescriptionDeliveryService } from "./prescription-delivery.service";

/** Sending the patient their prescription link by message (docs/prescriptions.md). Staff who may share prescriptions can send, retry and see what happened. */
@Controller()
export class PrescriptionDeliveryController {
  constructor(private readonly deliveries: PrescriptionDeliveryService) {}

  /** Whether a real message provider is connected and what the hospital chose (automatic sending, channel, link days). */
  @RequirePermissions("PRESCRIPTION_SHARE")
  @Get("prescription-deliveries/config")
  async config(@Ctx() ctx: RequestContext) { return { data: await this.deliveries.config_(ctx) }; }

  @RequirePermissions("PRESCRIPTION_SHARE")
  @Get("encounters/:id/prescription-deliveries")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.deliveries.list(ctx, id(encounterId)) }; }

  @RequirePermissions("PRESCRIPTION_SHARE")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("encounters/:id/prescription-deliveries")
  async send(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.deliveries.sendNow(ctx, id(encounterId)) }; }

  @RequirePermissions("PRESCRIPTION_SHARE")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("prescription-deliveries/:id/retry")
  @HttpCode(200)
  async retry(@Ctx() ctx: RequestContext, @Param("id") deliveryId: string) { return { data: await this.deliveries.retry(ctx, id(deliveryId)) }; }
}
