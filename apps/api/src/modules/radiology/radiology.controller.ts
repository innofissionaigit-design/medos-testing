import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { amendSchema, performSchema, RadiologyService, reportSchema, worklistSchema } from "./radiology.service";

/** Radiology (docs/radiology.md): the work list, performing a study, reporting and signing, amending, and critical findings. */
@Controller()
export class RadiologyController {
  constructor(private readonly rad: RadiologyService) {}

  @RequirePermissions("RAD_READ")
  @Get("rad/worklist")
  async worklist(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.rad.worklist(ctx, parse(worklistSchema, query)) }; }

  @RequirePermissions("RAD_PERFORM")
  @Post("rad/orders/:id/study")
  async perform(@Ctx() ctx: RequestContext, @Param("id") testOrderId: string, @Body() body: unknown) { return { data: await this.rad.perform(ctx, id(testOrderId), parse(performSchema, body)) }; }

  @RequirePermissions("RAD_READ")
  @Get("rad/orders/:id/study")
  async study(@Ctx() ctx: RequestContext, @Param("id") testOrderId: string) { return { data: await this.rad.study(ctx, id(testOrderId)) }; }

  @RequirePermissions("RAD_REPORT")
  @Post("rad/studies/:id/report")
  @HttpCode(200)
  async report(@Ctx() ctx: RequestContext, @Param("id") studyId: string, @Body() body: unknown) { return { data: await this.rad.report(ctx, id(studyId), parse(reportSchema, body)) }; }

  @RequirePermissions("RAD_REPORT")
  @Post("rad/studies/:id/amend")
  @HttpCode(200)
  async amend(@Ctx() ctx: RequestContext, @Param("id") studyId: string, @Body() body: unknown) { return { data: await this.rad.amend(ctx, id(studyId), parse(amendSchema, body)) }; }

  /** The doctor of the visit confirms a critical finding has been seen. */
  @RequirePermissions("RAD_READ")
  @Post("rad/studies/:id/acknowledge")
  @HttpCode(200)
  async acknowledge(@Ctx() ctx: RequestContext, @Param("id") studyId: string) { return { data: await this.rad.acknowledgeCritical(ctx, id(studyId)) }; }

  @RequirePermissions("RAD_READ")
  @Get("rad/critical")
  async critical(@Ctx() ctx: RequestContext) { return { data: await this.rad.critical(ctx) }; }

  @RequirePermissions("RAD_READ")
  @Get("encounters/:id/radiology")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.rad.forEncounter(ctx, id(encounterId)) }; }
}
