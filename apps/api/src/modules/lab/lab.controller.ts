import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { amendSchema, collectSchema, draftSchema, LabService, rejectSampleSchema, saveTestSchema, verifySchema, worklistSchema } from "./lab.service";

/** The laboratory (docs/lims.md): tests and their parameters, the work list, samples, results, verification and critical values. */
@Controller()
export class LabController {
  constructor(private readonly lab: LabService) {}

  @RequirePermissions("LAB_READ")
  @Get("lab/tests")
  async tests(@Ctx() ctx: RequestContext) { return { data: await this.lab.tests(ctx) }; }

  @RequirePermissions("LAB_MASTERS")
  @Put("lab/tests/:serviceId")
  async saveTest(@Ctx() ctx: RequestContext, @Param("serviceId") serviceId: string, @Body() body: unknown) { return { data: await this.lab.saveTest(ctx, id(serviceId), parse(saveTestSchema, body)) }; }

  @RequirePermissions("LAB_READ")
  @Get("lab/worklist")
  async worklist(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.lab.worklist(ctx, parse(worklistSchema, query)) }; }

  @RequirePermissions("LAB_COLLECT")
  @Post("lab/orders/:id/sample")
  async collect(@Ctx() ctx: RequestContext, @Param("id") testOrderId: string, @Body() body: unknown) { return { data: await this.lab.collect(ctx, id(testOrderId), parse(collectSchema, body ?? {})) }; }

  @RequirePermissions("LAB_COLLECT")
  @Post("lab/samples/:id/reject")
  @HttpCode(200)
  async reject(@Ctx() ctx: RequestContext, @Param("id") sampleId: string, @Body() body: unknown) { return { data: await this.lab.rejectSample(ctx, id(sampleId), parse(rejectSampleSchema, body)) }; }

  @RequirePermissions("LAB_READ")
  @Get("lab/orders/:id/result")
  async result(@Ctx() ctx: RequestContext, @Param("id") testOrderId: string) { return { data: await this.lab.result(ctx, id(testOrderId)) }; }

  @RequirePermissions("LAB_RESULT")
  @Put("lab/results/:id/draft")
  async draft(@Ctx() ctx: RequestContext, @Param("id") resultId: string, @Body() body: unknown) { return { data: await this.lab.saveDraft(ctx, id(resultId), parse(draftSchema, body)) }; }

  @RequirePermissions("LAB_VERIFY")
  @Post("lab/results/:id/verify")
  @HttpCode(200)
  async verify(@Ctx() ctx: RequestContext, @Param("id") resultId: string, @Body() body: unknown) { return { data: await this.lab.verify(ctx, id(resultId), parse(verifySchema, body)) }; }

  @RequirePermissions("LAB_VERIFY")
  @Post("lab/results/:id/amend")
  @HttpCode(200)
  async amend(@Ctx() ctx: RequestContext, @Param("id") resultId: string, @Body() body: unknown) { return { data: await this.lab.amend(ctx, id(resultId), parse(amendSchema, body)) }; }

  /** The doctor of the visit confirms a critical result has been seen. */
  @RequirePermissions("LAB_READ")
  @Post("lab/results/:id/acknowledge")
  @HttpCode(200)
  async acknowledge(@Ctx() ctx: RequestContext, @Param("id") resultId: string) { return { data: await this.lab.acknowledgeCritical(ctx, id(resultId)) }; }

  @RequirePermissions("LAB_READ")
  @Get("lab/critical")
  async critical(@Ctx() ctx: RequestContext) { return { data: await this.lab.critical(ctx) }; }

  @RequirePermissions("LAB_READ")
  @Get("encounters/:id/lab-results")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.lab.forEncounter(ctx, id(encounterId)) }; }
}
