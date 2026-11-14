import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { ClaimChecklistService, requiredDocumentActiveSchema, requiredDocumentSchema, waiverSchema } from "./claim-checklist.service";

/** The documents each insurer requires before a claim is sent, the checklist of one claim, and a manager's waiver (docs/claim-checklist.md). */
@Controller()
export class ClaimChecklistController {
  constructor(private readonly checklist: ClaimChecklistService) {}

  @RequirePermissions("CLAIM_READ")
  @Get("claims/insurers/:insurerId/required-documents")
  async required(@Ctx() ctx: RequestContext, @Param("insurerId") insurerId: string) { return { data: await this.checklist.required(ctx, id(insurerId)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Post("claims/insurers/:insurerId/required-documents")
  async add(@Ctx() ctx: RequestContext, @Param("insurerId") insurerId: string, @Body() body: unknown) { return { data: await this.checklist.addRequired(ctx, id(insurerId), parse(requiredDocumentSchema, body)) }; }

  @RequirePermissions("CLAIM_MASTERS")
  @Post("claims/required-documents/:id/active")
  @HttpCode(200)
  async setActive(@Ctx() ctx: RequestContext, @Param("id") requirementId: string, @Body() body: unknown) { return { data: await this.checklist.setRequiredActive(ctx, id(requirementId), parse(requiredDocumentActiveSchema, body).active) }; }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id/checklist")
  async forClaim(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.checklist.checklist(ctx, id(claimId)) }; }

  /** Only a manager. */
  @RequirePermissions("CLAIM_DOCUMENT_WAIVE")
  @Post("claims/:id/checklist/waive")
  @HttpCode(200)
  async waive(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Body() body: unknown) { return { data: await this.checklist.waive(ctx, id(claimId), parse(waiverSchema, body)) }; }
}
