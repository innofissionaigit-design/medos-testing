import { Body, Controller, Get, Headers, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { createRuleSchema, EarningsService, ledgerQuerySchema, setModelSchema } from "./earnings.service";
import { createPayoutSchema, myStatementQuerySchema, payoutListSchema, PayoutsService, reversePayoutSchema, statementQuerySchema } from "./payouts.service";

/** A doctor's own payout statement, listed with the other reports so a doctor finds it where they find their own bookings and earnings. */
@Controller("reports/earnings")
export class EarningsReportsController {
  constructor(private readonly payouts: PayoutsService) {}

  @RequirePermissions("REPORT_MY_PRACTICE")
  @Get("my-statement")
  async myStatement(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.payouts.myStatement(ctx, parse(myStatementQuerySchema, query)) }; }
}

/** How the amount collected for consultations is split between the hospital and each doctor (docs/earnings-and-reports.md), and paying doctors their share (docs/doctor-payouts.md). */
@Controller("earnings")
export class EarningsController {
  constructor(private readonly earnings: EarningsService, private readonly payouts: PayoutsService) {}

  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ")
  @Get("rules")
  async list(@Ctx() ctx: RequestContext) { return { data: await this.earnings.list(ctx) }; }

  /** Rules are never edited: this adds a new dated rule, and visits before its start date keep the rule that applied then. */
  @RequirePermissions("EARNINGS_CONFIGURE")
  @Post("rules")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.earnings.create(ctx, parse(createRuleSchema, body)) }; }

  /** Commission, fixed value, or either one for each doctor. */
  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("model")
  async model(@Ctx() ctx: RequestContext) { return { data: await this.earnings.model(ctx) }; }

  @RequirePermissions("EARNINGS_CONFIGURE")
  @Put("model")
  async setModel(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.earnings.setModel(ctx, parse(setModelSchema, body)) }; }

  /** The doctor-share ledger for a date range. */
  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("ledger")
  async ledger(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.earnings.ledger(ctx, parse(ledgerQuerySchema, query)) }; }

  /** One visit's bills, deposit use, doctor share and hospital net, for the final bill screen. */
  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("visits/:id")
  async visit(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.earnings.visit(ctx, id(encounterId)) }; }

  // ───── payouts ─────

  /** What each doctor has earned, been paid and is still owed. */
  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("payouts/balances")
  async balances(@Ctx() ctx: RequestContext) { return { data: await this.payouts.balances(ctx) }; }

  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("payouts")
  async payoutList(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.payouts.list(ctx, parse(payoutListSchema, query)) }; }

  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("payouts/:id")
  async payout(@Ctx() ctx: RequestContext, @Param("id") payoutId: string) { return { data: await this.payouts.get(ctx, id(payoutId)) }; }

  /** Pays a doctor part or all of what they are owed. A retry with the same Idempotency-Key replays the same voucher. */
  @RequirePermissions("EARNINGS_CONFIGURE")
  @Post("payouts")
  async pay(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.payouts.pay(ctx, parse(createPayoutSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  /** Undoes a payout made in error with a mirror voucher; the original is kept. */
  @RequirePermissions("EARNINGS_CONFIGURE")
  @Post("payouts/:id/reverse")
  async reverse(@Ctx() ctx: RequestContext, @Param("id") payoutId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.payouts.reverse(ctx, id(payoutId), parse(reversePayoutSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  /** A doctor's account for a date range: owed at the start, earned, paid out (with tax deducted) and owed at the end. */
  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE")
  @Get("statement")
  async statement(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(statementQuerySchema, query);
    return { data: await this.payouts.statement(ctx, q.practitionerId, q) };
  }

  /** The signed-in doctor's own statement. */
  @RequirePermissions("REPORT_MY_PRACTICE")
  @Get("my-statement")
  async myStatement(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.payouts.myStatement(ctx, parse(myStatementQuerySchema, query)) }; }
}
