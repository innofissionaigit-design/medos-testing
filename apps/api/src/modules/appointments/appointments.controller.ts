import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { AnyAuthenticated, Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import {
  AppointmentsService, availabilitySchema, cancelSchema, skipBookingFeeSchema, createAppointmentSchema, historySchema, listAppointmentsSchema,
  rescheduleSchema, scheduleSchema, walkInSchema,
} from "./appointments.service";

const walkInPriority = z.object({ priority: z.enum(["NORMAL", "PRIORITY", "EMERGENCY"]).default("NORMAL") }).strict();

@Controller()
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @RequirePermissions("APPOINTMENT_READ")
  @Get("practitioners/:id/schedule")
  async getSchedule(@Ctx() ctx: RequestContext, @Param("id") practitionerId: string) {
    return { data: await this.appointments.getSchedule(ctx, id(practitionerId)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Put("practitioners/:id/schedule")
  async setSchedule(@Ctx() ctx: RequestContext, @Param("id") practitionerId: string, @Body() body: unknown) {
    return { data: await this.appointments.setSchedule(ctx, id(practitionerId), parse(scheduleSchema, body)) };
  }

  @RequirePermissions("APPOINTMENT_READ")
  @Get("practitioners/:id/availability")
  async availability(@Ctx() ctx: RequestContext, @Param("id") practitionerId: string, @Query() query: unknown) {
    return { data: await this.appointments.availability(ctx, id(practitionerId), parse(availabilitySchema, query).date) };
  }

  @RequirePermissions("APPOINTMENT_READ")
  @Get("appointments")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listAppointmentsSchema, query);
    const { items, total } = await this.appointments.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  /** Whether the OPD consultation has been paid, so the patient's page can say what to do before an OPD visit starts. */
  @RequirePermissions("APPOINTMENT_CREATE")
  @Get("patients/:id/consultation-payment")
  async consultationPayment(@Ctx() ctx: RequestContext, @Param("id") patientId: string) { return { data: await this.appointments.consultationPayment(ctx, id(patientId)) }; }

  @RequirePermissions("APPOINTMENT_READ")
  @Get("patients/:id/appointments")
  async history(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Query() query: unknown) {
    const q = parse(historySchema, query);
    const { items, total } = await this.appointments.history(ctx, id(patientId), q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("APPOINTMENT_CREATE")
  @Post("appointments")
  async create(
    @Ctx() ctx: RequestContext, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const input = parse(createAppointmentSchema, body);
    // With an Idempotency-Key a retry returns the first booking (200, Idempotent-Replayed) instead of booking twice; without one the call works as before.
    if (key === undefined) return { data: await this.appointments.create(ctx, input) };
    const checked = parseIdempotencyKey(key);
    if (checked === undefined) return { data: await this.appointments.create(ctx, input) };
    const { result, replayed } = await this.appointments.createIdempotent(ctx, input, checked);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("APPOINTMENT_CREATE", "QUEUE_MANAGE")
  @Post("appointments/walk-in")
  async walkIn(
    @Ctx() ctx: RequestContext, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.appointments.walkIn(ctx, parse(walkInSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  /** What the booking fee is and which skip reasons are allowed, for the booking and check-in screens. */
  @AnyAuthenticated()
  @Get("booking-fee/config")
  async bookingFeeConfig(@Ctx() ctx: RequestContext) {
    return { data: await this.appointments.bookingFeeConfig(ctx) };
  }

  @RequirePermissions("BOOKING_FEE_SKIP")
  @Post("appointments/:id/booking-fee/skip")
  @HttpCode(200)
  async skipBookingFee(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string, @Body() body: unknown) {
    return { data: await this.appointments.skipBookingFee(ctx, id(appointmentId), parse(skipBookingFeeSchema, body)) };
  }

  @RequirePermissions("APPOINTMENT_READ")
  @Get("appointments/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string) {
    return { data: await this.appointments.get(ctx, id(appointmentId)) };
  }

  @RequirePermissions("APPOINTMENT_UPDATE")
  @Patch("appointments/:id")
  async reschedule(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string, @Body() body: unknown) {
    return { data: await this.appointments.reschedule(ctx, id(appointmentId), parse(rescheduleSchema, body)) };
  }

  @RequirePermissions("APPOINTMENT_CANCEL")
  @Post("appointments/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string, @Body() body: unknown) {
    return { data: await this.appointments.cancel(ctx, id(appointmentId), parse(cancelSchema, body)) };
  }

  @RequirePermissions("APPOINTMENT_UPDATE")
  @Post("appointments/:id/no-show")
  @HttpCode(200)
  async noShow(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string) {
    return { data: await this.appointments.markNoShow(ctx, id(appointmentId)) };
  }

  @RequirePermissions("APPOINTMENT_UPDATE", "QUEUE_MANAGE")
  @Post("appointments/:id/check-in")
  @HttpCode(200)
  async checkIn(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string, @Body() body: unknown) {
    const priority = parse(walkInPriority, body ?? {}).priority;
    return { data: await this.appointments.checkIn(ctx, id(appointmentId), priority) };
  }
}
