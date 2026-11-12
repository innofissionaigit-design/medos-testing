import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import {
  ClaimsService, addInvoiceSchema, appealDecisionSchema, appealSchema, closeSchema, copayPreviewSchema, createClaimSchema, decisionSchema, enhancementDecisionSchema, enhancementSchema, insurerSchema, listClaimsSchema, packageSchema, packageUpdateSchema, rateCheckSchema, rateSchema, tariffSchema, nonPayableSchema, removeSchema, policyCopaySchema, policySchema, policyStatusSchema, preauthDecisionSchema, preauthSchema, querySchema, resubmitSchema, settleSchema, submitSchema, verifySchema,
} from "./claims.service";
import { ClaimExchangeService, exportQuerySchema, transmitSchema } from "./claim-exchange.service";

/** Insurance claims (docs/claims.md): insurers, policies, and a claim's steps from pre-authorisation to settlement. */
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService, private readonly exchange: ClaimExchangeService) {}

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
  @Get("claims/insurers/:id/rates")
  async rates(@Ctx() ctx: RequestContext, @Param("id") insurerId: string) { return { data: await this.claims.rates(ctx, id(insurerId)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Put("claims/insurers/:id/rates/:serviceId")
  async setRate(@Ctx() ctx: RequestContext, @Param("id") insurerId: string, @Param("serviceId") serviceId: string, @Body() body: unknown) { return { data: await this.claims.setRate(ctx, id(insurerId), id(serviceId), parse(rateSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/insurers/:id/packages")
  async packages(@Ctx() ctx: RequestContext, @Param("id") insurerId: string) { return { data: await this.claims.packages(ctx, id(insurerId)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Post("claims/insurers/:id/packages")
  async addPackage(@Ctx() ctx: RequestContext, @Param("id") insurerId: string, @Body() body: unknown) { return { data: await this.claims.addPackage(ctx, id(insurerId), parse(packageSchema, body)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Put("claims/insurers/:id/packages/:packageId")
  async updatePackage(@Ctx() ctx: RequestContext, @Param("id") insurerId: string, @Param("packageId") packageId: string, @Body() body: unknown) { return { data: await this.claims.updatePackage(ctx, id(insurerId), id(packageId), parse(packageUpdateSchema, body)) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("patients/:id/policies")
  async policies(@Ctx() ctx: RequestContext, @Param("id") patientId: string) { return { data: await this.claims.policies(ctx, id(patientId)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Get("claims/:id/package")
  async claimPackage(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.claims.claimPackage(ctx, id(claimId)) }; }

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
  @Post("claims/:id/verification")
  @HttpCode(200)
  async verify(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.verifyPayer(ctx, id(claimId), parse(verifySchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/enhancements")
  async enhance(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.requestEnhancement(ctx, id(claimId), parse(enhancementSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/enhancements/:enhancementId/decision")
  @HttpCode(200)
  async enhancementDecision(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Param("enhancementId") enhancementId: string, @Body() body: unknown) { return { data: await this.claims.decideEnhancement(ctx, id(claimId), id(enhancementId), parse(enhancementDecisionSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/tariff-package")
  @HttpCode(200)
  async tariff(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.chooseTariff(ctx, id(claimId), parse(tariffSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/invoices")
  async addInvoice(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.addInvoice(ctx, id(claimId), parse(addInvoiceSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Get("claims/:id/rate-check")
  async rateCheck(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Query() query: unknown) { return { data: await this.claims.rateCheck(ctx, id(claimId), parse(rateCheckSchema, query).invoiceId) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/rate-check/apply")
  @HttpCode(200)
  async applyRateCheck(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.applyRateCheck(ctx, id(claimId), parse(rateCheckSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/non-payables")
  async addNonPayable(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.addNonPayable(ctx, id(claimId), parse(nonPayableSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/non-payables/:itemId/remove")
  @HttpCode(200)
  async removeNonPayable(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Param("itemId") itemId: string, @Body() body: unknown) { return { data: await this.claims.removeNonPayable(ctx, id(claimId), id(itemId), parse(removeSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/appeals")
  async appeal(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.claims.requestAppeal(ctx, id(claimId), parse(appealSchema, body)) }; }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/appeals/:appealId/decision")
  @HttpCode(200)
  async appealDecision(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Param("appealId") appealId: string, @Body() body: unknown) { return { data: await this.claims.decideAppeal(ctx, id(claimId), id(appealId), parse(appealDecisionSchema, body)) }; }

  @RequireAnyPermission("CLAIM_READ", "CLAIM_MANAGE")
  @Get("claims/:id/eligibility-request")
  async eligibilityRequest(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.exchange.eligibilityRequest(ctx, id(claimId)) }; }

  @RequireAnyPermission("CLAIM_READ", "CLAIM_MANAGE")
  @Get("claims/:id/export")
  async exportClaim(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(exportQuerySchema, query);
    const out = await this.exchange.export(ctx, id(claimId), q);
    res.setHeader("content-type", out.contentType);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-disposition", `${q.download === "1" ? "attachment" : "inline"}; filename="${out.filename}"`);
    res.status(200).send(out.body);
  }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/transmit")
  @HttpCode(200)
  async transmit(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.exchange.transmit(ctx, id(claimId), parse(transmitSchema, body)) }; }

  @RequireAnyPermission("CLAIM_READ", "CLAIM_MANAGE")
  @Get("claims/:id/transmissions")
  async transmissions(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.exchange.transmissions(ctx, id(claimId)) }; }

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
