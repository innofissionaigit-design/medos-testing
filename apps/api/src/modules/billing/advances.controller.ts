import { Body, Controller, Get, Headers, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { AdvancesService, applyAdvanceSchema, refundAdvanceSchema, takeAdvanceSchema } from "./advances.service";

/** Advance payments (docs/advance-payments.md). Every money movement needs an Idempotency-Key, like payments and refunds. */
@Controller()
export class AdvancesController {
  constructor(private readonly advances: AdvancesService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("patients/:id/advances")
  async list(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.advances.listForPatient(ctx, id(patientId)) };
  }

  @RequirePermissions("INVOICE_READ")
  @Get("advances/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") depositId: string) {
    return { data: await this.advances.get(ctx, id(depositId)) };
  }

  @RequirePermissions("PAYMENT_CREATE")
  @Post("patients/:id/advances")
  async take(
    @Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.advances.take(ctx, id(patientId), parse(takeAdvanceSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  /** Takes the booking fee of an appointment (an advance tied to it, so it can later be set against the visit's bill). */
  @RequirePermissions("PAYMENT_CREATE")
  @Post("appointments/:id/booking-fee")
  async takeBookingFee(
    @Ctx() ctx: RequestContext, @Param("id") appointmentId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const appt = await this.advances.appointmentOwner(ctx, id(appointmentId));
    const { result, replayed } = await this.advances.take(ctx, appt.patientId, parse(takeAdvanceSchema, body), parseIdempotencyKey(key), appt.id);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  /** Pays an issued invoice from the patient's advances. */
  @RequirePermissions("PAYMENT_CREATE")
  @Post("invoices/:id/advances")
  async apply(
    @Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.advances.apply(ctx, id(invoiceId), parse(applyAdvanceSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("PAYMENT_REFUND")
  @Post("advances/:id/refunds")
  async refund(
    @Ctx() ctx: RequestContext, @Param("id") depositId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.advances.refund(ctx, id(depositId), parse(refundAdvanceSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }
}
