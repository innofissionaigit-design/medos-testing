import { Controller, Get, Query } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, parse, RequireAnyPermission } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { PostDischargeService, postDischargeListSchema } from "./post-discharge.service";

/** The post-discharge list (docs/discharge-stages.md): records to complete, claims to follow and money still owed, for MRD, the TPA desk and finance. */
@Feature("IPD_ENABLED")
@Controller()
export class PostDischargeController {
  constructor(private readonly post: PostDischargeService) {}

  @RequireAnyPermission("MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE")
  @Get("post-discharge")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.post.list(ctx, parse(postDischargeListSchema, query)) }; }
}
