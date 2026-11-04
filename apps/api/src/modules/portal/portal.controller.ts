import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Ctx, id, parse, Public, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { patientJoinSchema, TelemedicineService } from "../telemedicine/telemedicine.service";
import {
  handleRequestSchema, listRequestsSchema, otpRequestSchema, otpVerifySchema, patientQuerySchema, PortalAuthService, PortalGuard, type PortalRequest, PortalService, requestSchema,
} from "./portal.service";

/** The patient app's sign-in (docs/patient-app.md). Public: it is how a patient gets a session. */
@Controller("patient-portal/auth")
export class PortalAuthController {
  constructor(private readonly auth: PortalAuthService) {}

  @Public()
  @RateLimit({ limit: 10, windowMs: 60_000 })
  @Post("code")
  @HttpCode(200)
  async code(@Body() body: unknown) { return { data: await this.auth.requestCode(parse(otpRequestSchema, body)) }; }

  @Public()
  @RateLimit({ limit: 20, windowMs: 60_000 })
  @Post("verify")
  @HttpCode(200)
  async verify(@Body() body: unknown) { return { data: await this.auth.verifyCode(parse(otpVerifySchema, body)) }; }
}

/** What a signed-in patient sees. Public to the staff login (it has its own guard that accepts a patient session and nothing else). */
@Public()
@UseGuards(PortalGuard)
@Controller("patient-portal")
export class PortalController {
  constructor(private readonly portal: PortalService, private readonly auth: PortalAuthService, private readonly tele: TelemedicineService) {}

  private session(req: PortalRequest) { return req.portal!; }

  @Public()
  @Get("me")
  async me(@Req() req: PortalRequest) { return { data: await this.portal.profiles(this.session(req)) }; }

  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: PortalRequest) { return { data: await this.auth.logout(this.session(req)) }; }

  @Public()
  @Get("doctors")
  async doctors(@Req() req: PortalRequest) { return { data: await this.portal.doctors(this.session(req)) }; }

  @Public()
  @Get("appointments")
  async appointments(@Req() req: PortalRequest, @Query() query: unknown) { return { data: await this.portal.appointments(this.session(req), parse(patientQuerySchema, query).patientId) }; }

  /** Joins the video consultation of an appointment: the first time needs the patient's agreement. Returns the link to the room. */
  @Public()
  @Post("teleconsults/:id/join")
  @HttpCode(200)
  async joinVideo(@Req() req: PortalRequest, @Param("id") teleId: string, @Body() body: unknown) { return { data: await this.tele.patientJoin(this.session(req), id(teleId), parse(patientJoinSchema, body ?? {})) }; }

  @Public()
  @Get("visits")
  async visits(@Req() req: PortalRequest, @Query() query: unknown) { return { data: await this.portal.visits(this.session(req), parse(patientQuerySchema, query).patientId) }; }

  @Public()
  @Get("reports")
  async reports(@Req() req: PortalRequest, @Query() query: unknown) { return { data: await this.portal.reports(this.session(req), parse(patientQuerySchema, query).patientId) }; }

  @Public()
  @Get("bills")
  async bills(@Req() req: PortalRequest, @Query() query: unknown) { return { data: await this.portal.bills(this.session(req), parse(patientQuerySchema, query).patientId) }; }

  @Public()
  @Get("appointment-requests")
  async requests(@Req() req: PortalRequest, @Query() query: unknown) { return { data: await this.portal.requests(this.session(req), parse(patientQuerySchema, query).patientId) }; }

  @Public()
  @Post("appointment-requests")
  async createRequest(@Req() req: PortalRequest, @Body() body: unknown) { return { data: await this.portal.createRequest(this.session(req), parse(requestSchema, body)) }; }

  @Public()
  @Post("appointment-requests/:id/cancel")
  @HttpCode(200)
  async cancelRequest(@Req() req: PortalRequest, @Param("id") requestId: string) { return { data: await this.portal.cancelRequest(this.session(req), id(requestId)) }; }
}

/** The front desk's list of appointment requests from the patient app, and their answers. */
@Controller("appointment-requests")
export class AppointmentRequestsController {
  constructor(private readonly portal: PortalService) {}

  @RequirePermissions("APPOINTMENT_READ")
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.portal.listForStaff(ctx, parse(listRequestsSchema, query)) }; }

  @RequirePermissions("APPOINTMENT_CREATE")
  @Post(":id/answer")
  @HttpCode(200)
  async answer(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.portal.handle(ctx, id(requestId), parse(handleRequestSchema, body)) }; }
}
