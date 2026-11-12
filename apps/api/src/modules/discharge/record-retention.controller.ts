import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { RecordRetentionService, retentionListSchema, retentionReviewSchema } from "./record-retention.service";

/** Medical-record retention (docs/record-retention.md): finished visits whose retention period is over, and the Medical Records Department's decisions on them. */
@Controller()
export class RecordRetentionController {
  constructor(private readonly retention: RecordRetentionService) {}

  @RequirePermissions("MRD_RETENTION")
  @Get("records/retention")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.retention.list(ctx, parse(retentionListSchema, query)) }; }

  @RequirePermissions("MRD_RETENTION")
  @Post("records/retention/:encounterId/review")
  @HttpCode(201)
  async review(@Ctx() ctx: RequestContext, @Param("encounterId") encounterId: string, @Body() body: unknown) { return { data: await this.retention.review(ctx, id(encounterId), parse(retentionReviewSchema, body)) }; }
}
