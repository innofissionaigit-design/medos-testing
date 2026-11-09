import { Body, Controller, Get, Headers, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { BookingApiService, doctorsQuerySchema, patientLookupSchema, registerPatientSchema } from "./booking-api.service";

/** Calls made for booking by outside systems and bots (docs/integration-api.md). Staff screens can use them too. */
@Controller("booking")
export class BookingApiController {
  constructor(private readonly booking: BookingApiService) {}

  /** Doctors at the facility with their next free times for a day, in one call. */
  @RequirePermissions("APPOINTMENT_READ")
  @Get("doctors")
  async doctors(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.booking.doctors(ctx, parse(doctorsQuerySchema, query)) };
  }

  /** Patients with this mobile number, as minimal details (first name, last initial, gender, age). */
  @RequirePermissions("BOOKING_PATIENT_LOOKUP")
  @Get("patients")
  async find(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.booking.findByMobile(ctx, parse(patientLookupSchema, query)) };
  }

  /** Registers a new patient for booking. Send an Idempotency-Key so a retry never registers twice. */
  @RequirePermissions("BOOKING_PATIENT_REGISTER")
  @Post("patients")
  async register(
    @Ctx() ctx: RequestContext, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { patient, replayed } = await this.booking.register(ctx, parse(registerPatientSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: patient };
  }
}
