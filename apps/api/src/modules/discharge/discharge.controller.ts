import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AdmissionTestsService, orderTestSchema } from "./admission-tests.service";
import { clearSchema, completeRecordsSchema, completeSchema, confirmDepartureSchema, DischargeService, financialExceptionSchema, recordFileSchema, waiveSchema } from "./discharge.service";
import { amendSummarySchema, saveSummarySchema, signSummarySchema, SummaryService, verifySummarySchema } from "./summary.service";

@Feature("IPD_ENABLED")
@Controller("admissions/:id")
export class DischargeController {
  constructor(private readonly discharge: DischargeService, private readonly summary: SummaryService, private readonly tests: AdmissionTestsService) {}

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

  /** Financial release as an authorised exception: billing / finance lets the patient leave with money still outstanding, with a written reason. */
  @RequirePermissions("DISCHARGE_FINANCIAL_EXCEPTION")
  @Post("discharge/financial-exception")
  @HttpCode(200)
  async financialException(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.authoriseFinancialException(ctx, id(admissionId), parse(financialExceptionSchema, body)) };
  }

  /** Post-discharge: the Medical Records Department signs off the record of a discharged stay as complete. */
  @RequirePermissions("MRD_RECORD_COMPLETE")
  @Post("discharge/records-complete")
  @HttpCode(200)
  async recordsComplete(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.completeRecords(ctx, id(admissionId), parse(completeRecordsSchema, body)) };
  }

  /** Post-discharge: the Medical Records Department moves the paper record (received, filed, issued, returned). */
  @RequirePermissions("MRD_RECORD_COMPLETE")
  @Post("discharge/record-file")
  @HttpCode(200)
  async recordFile(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.moveRecordFile(ctx, id(admissionId), parse(recordFileSchema, body)) };
  }

  /** Physical exit: the ward nurse or patient transport confirms when the discharged patient actually left. */
  @RequirePermissions("DISCHARGE_DEPARTURE_CONFIRM")
  @Post("discharge/departure")
  @HttpCode(200)
  async departure(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.discharge.confirmDeparture(ctx, id(admissionId), parse(confirmDepartureSchema, body)) };
  }

  /** The pharmacist puts back a medicine charge that went missing (for example voided at billing by mistake), so the pharmacy stage reconciles without a waiver. */
  @RequirePermissions("PHARMACY_DISPENSE")
  @Post("discharge/pharmacy/repost-charges")
  @HttpCode(200)
  async repostPharmacyCharges(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.discharge.repostPharmacyCharges(ctx, id(admissionId)) };
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

  // ───── laboratory and radiology tests for the admitted patient ─────

  @RequirePermissions("ADMISSION_READ")
  @Get("test-orders")
  async testOrders(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.tests.list(ctx, id(admissionId)) };
  }

  /** The treating doctor or the RMO orders a laboratory or radiology test from the admission; the cashier bills it like any advised test. */
  @RequirePermissions("CONSULTATION_CREATE")
  @Post("test-orders")
  async orderTest(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.tests.order(ctx, id(admissionId), parse(orderTestSchema, body)) };
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

  /** The RMO verifies the signed summary; it is checked in the service that this is not the person who signed it. */
  @RequirePermissions("CONSULTATION_VERIFY")
  @Post("discharge-summary/verify")
  @HttpCode(200)
  async verifySummary(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.summary.verify(ctx, id(admissionId), parse(verifySummarySchema, body)) };
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
