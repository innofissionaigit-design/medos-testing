import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { createDataRequestSchema, listDataRequestsSchema, PrivacyService, recordConsentSchema, updateDataRequestSchema } from "./privacy.service";

@Controller()
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @RequirePermissions("PATIENT_READ")
  @Get("patients/:id/consents")
  async consents(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.privacy.consents(ctx, id(patientId)) };
  }

  @RequirePermissions("PATIENT_UPDATE")
  @Post("patients/:id/consents")
  async recordConsent(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) {
    return { data: await this.privacy.recordConsent(ctx, id(patientId), parse(recordConsentSchema, body)) };
  }

  @RequirePermissions("PATIENT_UPDATE")
  @Post("patients/:id/data-requests")
  async createRequest(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) {
    return { data: await this.privacy.createRequest(ctx, id(patientId), parse(createDataRequestSchema, body)) };
  }

  @RequirePermissions("PRIVACY_MANAGE")
  @Get("privacy/requests")
  async listRequests(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listDataRequestsSchema, query);
    const r = await this.privacy.listRequests(ctx, q);
    return { data: r.items, meta: { total: r.total, page: q.page, pageSize: q.pageSize } };
  }

  @RequirePermissions("PRIVACY_MANAGE")
  @Patch("privacy/requests/:id")
  @HttpCode(200)
  async updateRequest(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) {
    return { data: await this.privacy.updateRequest(ctx, id(requestId), parse(updateDataRequestSchema, body)) };
  }
}
