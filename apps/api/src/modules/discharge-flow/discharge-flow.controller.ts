import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequirePermissions, RequireAnyPermission } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { DischargeFlowService, delaySchema, familySheetSchema, flowRangeSchema, insurerSentSchema, planSchema } from "./discharge-flow.service";

/** Making discharge faster (docs/discharge-flow.md): the checklist and its clocks, the waiting board, delay reasons, the family's sheet and the management report. */
@Feature("IPD_ENABLED")
@Controller()
export class DischargeFlowController {
  constructor(private readonly flow: DischargeFlowService) {}

  /** The checklist of one patient: who must do what, the deadline, the clock and why anything is stuck. */
  @RequirePermissions("ADMISSION_READ")
  @Get("admissions/:id/discharge-flow")
  async one(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) { return { data: await this.flow.flow(ctx, id(admissionId)) }; }

  /** The treating doctor sets or changes the planned going-home date. */
  @RequirePermissions("ADMISSION_DISCHARGE")
  @Put("admissions/:id/discharge-plan")
  async plan(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.flow.setPlan(ctx, id(admissionId), parse(planSchema, body)) }; }

  /** Whoever is stuck says why. The reason's permission (the stage's own team, or the doctor) is checked in the service. */
  @RequirePermissions("ADMISSION_READ")
  @Post("admissions/:id/discharge-flow/delay")
  @HttpCode(200)
  async delay(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.flow.recordDelay(ctx, id(admissionId), parse(delaySchema, body)) }; }

  /** The insurance desk marks that the final bill went to the insurer: the insurer's own clock starts. */
  @RequirePermissions("CLAIM_MANAGE")
  @Post("admissions/:id/discharge-flow/insurer-bill-sent")
  @HttpCode(200)
  async insurerSent(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) { return { data: await this.flow.recordInsurerBillSent(ctx, id(admissionId), parse(insurerSentSchema, body)) }; }

  /** What is still pending and who is handling it, in English, Hindi or Bengali. */
  @RequirePermissions("ADMISSION_READ")
  @Get("admissions/:id/discharge-flow/family-sheet")
  async family(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Query() q: unknown) { return { data: await this.flow.familySheet(ctx, id(admissionId), parse(familySheetSchema, q)) }; }

  /** Everyone waiting to go home, longest wait first, with what is holding each one up. */
  @RequirePermissions("ADMISSION_READ")
  @Get("discharge-flow/board")
  async board(@Ctx() ctx: RequestContext) { return { data: await this.flow.board(ctx) }; }

  /** Only this person's own pending items. */
  @RequirePermissions("ADMISSION_READ")
  @Get("discharge-flow/my-work")
  async mine(@Ctx() ctx: RequestContext) { return { data: await this.flow.myWork(ctx) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_IPD")
  @Get("reports/ipd/discharge-flow")
  async report(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.flow.report(ctx, parse(flowRangeSchema, q)) }; }
}
