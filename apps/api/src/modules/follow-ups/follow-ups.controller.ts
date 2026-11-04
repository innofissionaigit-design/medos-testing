import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { FollowUpsService, scheduleFollowUpSchema } from "./follow-ups.service";
import { RemindersService } from "./reminders.service";

/** Rescheduling, cancellation, no-show and check-in of a follow-up use the ordinary /appointments/:id routes. */
@Controller()
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService, private readonly reminders: RemindersService) {}

  @RequirePermissions("FOLLOWUP_SCHEDULE")
  @Post("encounters/:id/follow-ups")
  async schedule(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.followUps.schedule(ctx, id(encounterId), parse(scheduleFollowUpSchema, body)) };
  }

  @RequireAnyPermission("APPOINTMENT_READ", "CONSULTATION_READ")
  @Get("encounters/:id/follow-ups")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) {
    return { data: await this.followUps.listForEncounter(ctx, id(encounterId)) };
  }

  @RequirePermissions("APPOINTMENT_READ")
  @Get("appointments/:id/reminders")
  async listReminders(@Ctx() ctx: RequestContext, @Param("id") appointmentId: string) {
    return { data: await this.reminders.list(ctx, id(appointmentId)) };
  }
}
