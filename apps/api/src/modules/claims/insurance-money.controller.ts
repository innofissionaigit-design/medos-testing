import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { ClaimsService, topupSchema } from "./claims.service";
import {
  cutSchema, estimateSchema, packageLinesQuerySchema, followUpDoneSchema, InsuranceMoneyService, listSchema, paymentSchema, rangeSchema, refundSchema, writeOffDecisionSchema, writeOffSchema,
} from "./insurance-money.service";

/**
 * Insurance money (docs/insurance-money.md): top-up claims, what insurers cut and why, the payments they make matched to claims, overpayments and refunds,
 * write-offs a manager approves, follow-up tasks, the running ledger, the split of a bill, package marking, the family's estimate, and the reports.
 */
@Controller()
export class InsuranceMoneyController {
  constructor(private readonly claims: ClaimsService, private readonly money: InsuranceMoneyService) {}

  // ───── on one claim ─────

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/topup")
  async topup(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.createTopup(ctx, id(claimId), parse(topupSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id/split")
  async split(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.money.split(ctx, id(claimId)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id/ledger")
  async ledger(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.money.claimLedger(ctx, id(claimId)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id/package-lines")
  async packageLines(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Query() q: unknown) { return { data: await this.money.packageLines(ctx, id(claimId), parse(packageLinesQuerySchema, q).invoiceId) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/cuts")
  async cut(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.money.recordCut(ctx, id(claimId), parse(cutSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/write-offs")
  async requestWriteOff(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.money.requestWriteOff(ctx, id(claimId), parse(writeOffSchema, body)) }; }

  // ───── write-offs, follow-ups ─────

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/write-offs")
  async writeOffs(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.money.writeOffs(ctx, parse(listSchema, q)) }; }

  /** Only a manager (never the person who asked for it). */
  @RequirePermissions("CLAIM_WRITEOFF_APPROVE")
  @Post("insurance/write-offs/:id/decision")
  @HttpCode(200)
  async decideWriteOff(@Ctx() ctx: RequestContext, @Param("id") writeOffId: string, @Body() body: unknown) { return { data: await this.money.decideWriteOff(ctx, id(writeOffId), parse(writeOffDecisionSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/follow-ups")
  async followUps(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.money.followUps(ctx, parse(listSchema, q)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("insurance/follow-ups/:id/done")
  @HttpCode(200)
  async followUpDone(@Ctx() ctx: RequestContext, @Param("id") followUpId: string, @Body() body: unknown) { return { data: await this.money.completeFollowUp(ctx, id(followUpId), parse(followUpDoneSchema, body)) }; }

  // ───── the insurers' payments ─────

  @RequirePermissions("CLAIM_SETTLE")
  @Post("insurance/payments")
  async recordPayment(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.money.recordPayment(ctx, parse(paymentSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/payments")
  async payments(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const raw = (q ?? {}) as Record<string, unknown>;
    const insurerId = typeof raw["insurerId"] === "string" ? id(raw["insurerId"]) : undefined;
    const { insurerId: _omit, ...rest } = raw; void _omit;
    return { data: await this.money.payments(ctx, { ...parse(listSchema, rest), ...(insurerId ? { insurerId } : {}) }) };
  }

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/overpayments")
  async overpayments(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.money.overpayments(ctx, parse(listSchema, q)) }; }

  @RequirePermissions("CLAIM_SETTLE")
  @Post("insurance/overpayments/:id/refunds")
  async refund(@Ctx() ctx: RequestContext, @Param("id") overpaymentId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.money.refund(ctx, id(overpaymentId), parse(refundSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  // ───── the running ledger ─────

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/ledger")
  async ledgers(@Ctx() ctx: RequestContext) { return { data: await this.money.insurerLedgers(ctx) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/ledger/:insurerId")
  async insurerLedger(@Ctx() ctx: RequestContext, @Param("insurerId") insurerId: string) { return { data: await this.money.insurerLedger(ctx, id(insurerId)) }; }

  // ───── the estimate for the family ─────

  @RequirePermissions("CLAIM_READ")
  @Post("insurance/estimates")
  async estimate(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { res.status(201); return { data: await this.money.estimate(ctx, parse(estimateSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("insurance/estimates/:id")
  async estimateById(@Ctx() ctx: RequestContext, @Param("id") estimateId: string) { return { data: await this.money.estimateById(ctx, id(estimateId)) }; }

  // ───── reports ─────

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("reports/insurance/ageing")
  async ageing(@Ctx() ctx: RequestContext) { return { data: await this.money.ageing(ctx) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("reports/insurance/rejections")
  async rejections(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.money.rejections(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("reports/insurance/late-payers")
  async latePayers(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.money.latePayers(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("reports/insurance/owed")
  async owed(@Ctx() ctx: RequestContext) { return { data: await this.money.insurerLedgers(ctx) }; }
}
