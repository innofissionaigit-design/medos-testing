import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import {
  ClaimsService, closeSchema, copayPreviewSchema, createClaimSchema, decisionSchema, insurerSchema, listClaimsSchema, policyCopaySchema, policySchema, policyStatusSchema, preauthDecisionSchema, preauthSchema, querySchema, resubmitSchema, settleSchema, submitSchema,
} from "./claims.service";

/** Insurance claims (docs/claims.md): insurers, policies, and a claim's steps from pre-authorisation to settlement. */
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @RequirePermissions("CLAIM_READ")
  @Get("claims/insurers")
  async insurers(@Ctx() ctx: RequestContext) { return { data: await this.claims.insurers(ctx) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Post("claims/insurers")
  async addInsurer(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.claims.saveInsurer(ctx, null, parse(insurerSchema, body)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Put("claims/insurers/:id")
  async updateInsurer(@Ctx() ctx: RequestContext, @Param("id") insurerId: string, @Body() body: unknown) { return { data: await this.claims.saveInsurer(ctx, id(insurerId), parse(insurerSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("patients/:id/policies")
  async policies(@Ctx() ctx: RequestContext, @Param("id") patientId: string) { return { data: await this.claims.policies(ctx, id(patientId)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("patients/:id/policies")
  async addPolicy(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) { return { data: await this.claims.addPolicy(ctx, id(patientId), parse(policySchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Put("policies/:id")
  async policyStatus(@Ctx() ctx: RequestContext, @Param("id") policyId: string, @Body() body: unknown) { return { data: await this.claims.setPolicyStatus(ctx, id(policyId), parse(policyStatusSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Put("policies/:id/copay")
  async policyCopay(@Ctx() ctx: RequestContext, @Param("id") policyId: string, @Body() body: unknown) { return { data: await this.claims.setPolicyCopay(ctx, id(policyId), parse(policyCopaySchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/copay-preview")
  @HttpCode(200)
  async copayPreview(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.copayPreview(ctx, id(claimId), parse(copayPreviewSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/summary")
  async summary(@Ctx() ctx: RequestContext) { return { data: await this.claims.summary(ctx) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.claims.list(ctx, parse(listClaimsSchema, query)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.claims.create(ctx, parse(createClaimSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id")
  async view(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.claims.view(ctx, id(claimId)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/preauth")
  @HttpCode(200)
  async preauth(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.requestPreauth(ctx, id(claimId), parse(preauthSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/preauth-decision")
  @HttpCode(200)
  async preauthDecision(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.decidePreauth(ctx, id(claimId), parse(preauthDecisionSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/submit")
  @HttpCode(200)
  async submit(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.submit(ctx, id(claimId), parse(submitSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/query")
  @HttpCode(200)
  async query(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.raiseQuery(ctx, id(claimId), parse(querySchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/resubmit")
  @HttpCode(200)
  async resubmit(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.resubmit(ctx, id(claimId), parse(resubmitSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/decision")
  @HttpCode(200)
  async decision(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.decide(ctx, id(claimId), parse(decisionSchema, body)) }; }

  @RequirePermissions("CLAIM_SETTLE")
  @Post("claims/:id/settlements")
  async settle(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.claims.settle(ctx, id(claimId), parse(settleSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/close")
  @HttpCode(200)
  async close(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.close(ctx, id(claimId), parse(closeSchema, body)) }; }
}
