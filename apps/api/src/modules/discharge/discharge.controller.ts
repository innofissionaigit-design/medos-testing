import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { clearSchema, completeSchema, DischargeService, waiveSchema } from "./discharge.service";
import { amendSummarySchema, saveSummarySchema, signSummarySchema, SummaryService } from "./summary.service";

@Feature("IPD_ENABLED")
@Controller("admissions/:id")
export class DischargeController {
  constructor(private readonly discharge: DischargeService, private readonly summary: SummaryService) {}

  @RequirePermissions("ADMISSION_READ")
  @Get("discharge")
  async status(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.discharge.status(ctx, id(admissionId)) };
  }

  /** Per-step permission (doctor: fit, nurse: nursing, billing staff: charges, pharmacist: pharmacy) is enforced in the service. */
  @RequirePermissions("ADMISSION_READ")
  @Post("discharge/clear")
  @HttpCode(200)
  async clear(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.clear(ctx, id(admissionId), parse(clearSchema, body)) };
  }

  @RequirePermissions("ADMISSION_DISCHARGE")
  @Post("discharge/waive")
  @HttpCode(200)
  async waive(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.waive(ctx, id(admissionId), parse(waiveSchema, body)) };
  }

  @RequirePermissions("IPD_FINAL_BILL")
  @Post("discharge/final-invoice")
  @HttpCode(200)
  async finalInvoice(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.discharge.finalInvoice(ctx, id(admissionId)) };
  }

  @RequirePermissions("ADMISSION_DISCHARGE")
  @Post("discharge/complete")
  @HttpCode(200)
  async complete(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.complete(ctx, id(admissionId), parse(completeSchema, body ?? {})) };
  }

  // ───── discharge summary ─────

  @RequirePermissions("CONSULTATION_READ")
  @Get("discharge-summary")
  async getSummary(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.summary.get(ctx, id(admissionId)) };
  }

  @RequirePermissions("CONSULTATION_CREATE")
  @Put("discharge-summary")
  async saveSummary(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.summary.saveDraft(ctx, id(admissionId), parse(saveSummarySchema, body)) };
  }

  @RequirePermissions("CONSULTATION_SIGN")
  @Post("discharge-summary/sign")
  @HttpCode(200)
  async signSummary(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.summary.sign(ctx, id(admissionId), parse(signSummarySchema, body)) };
  }

  @RequirePermissions("CONSULTATION_AMEND")
  @Post("discharge-summary/amend")
  @HttpCode(200)
  async amendSummary(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.summary.amend(ctx, id(admissionId), parse(amendSummarySchema, body)) };
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("discharge-summary/versions/:version")
  async summaryVersion(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Param("version") version: string) {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { data: await this.summary.getVersion(ctx, id(admissionId), n) };
  }
}
