import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { MissedBillingService, missedBillingQuerySchema, reviewSchema } from "./missed-billing.service";

/** "Done but not billed": the possible missed income, and a billing person's decision on each flag (docs/missed-billing.md). */
@Controller()
export class MissedBillingController {
  constructor(private readonly missed: MissedBillingService) {}

  @RequirePermissions("MISSED_BILLING_READ")
  @Get("billing/missed-income")
  async report(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.missed.report(ctx, parse(missedBillingQuerySchema, query)) }; }

  @RequirePermissions("MISSED_BILLING_REVIEW")
  @Post("billing/missed-income/reviews")
  @HttpCode(201)
  async review(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.missed.review(ctx, parse(reviewSchema, body)) }; }
}
