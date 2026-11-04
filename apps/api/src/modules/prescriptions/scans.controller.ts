import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Ctx, id, parse, RateLimit, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { PrescriptionDraftService } from "./prescription-draft.service";
import { approveScanSchema, correctScanSchema, saveLinesSchema, ScansService, uploadScanQuerySchema } from "./scans.service";

/** Handwritten prescriptions: upload after a consultation, read with OCR, structure, check and approve (docs/prescriptions.md). */
@Controller()
export class ScansController {
  constructor(private readonly scans: ScansService, private readonly drafts: PrescriptionDraftService) {}

  /** The three dropdowns (Drug, Medicine, Lab test) and the standard advice, from the hospital's own lists. */
  @RequireAnyPermission("PRESCRIPTION_SCAN", "PRESCRIPTION_CREATE")
  @Get("prescription-scans/options")
  async options(@Ctx() ctx: RequestContext) { return { data: await this.drafts.options(ctx) }; }

  /** What can be built into a prescription from a picture: matched to the hospital's lists, for the doctor to review. Saves nothing. */
  @RequirePermissions("PRESCRIPTION_SCAN")
  @Get("prescription-scans/:id/prescription-draft")
  async draft(@Ctx() ctx: RequestContext, @Param("id") scanId: string) { return { data: await this.drafts.fromScan(ctx, id(scanId)) }; }

  /** Whether uploading and OCR are switched on, and whether an OCR service is connected, for the screens. */
  @RequirePermissions("CONSULTATION_READ")
  @Get("prescription-scans/config")
  async config(@Ctx() ctx: RequestContext) { return { data: await this.scans.config(ctx) }; }

  @RequirePermissions("CONSULTATION_READ")
  @Get("encounters/:id/prescription-scans")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.scans.list(ctx, id(encounterId)) }; }

  /** The image is the raw request body (PNG, JPEG or PDF, up to 5 MB); the file name goes in the query. */
  @RequirePermissions("PRESCRIPTION_SCAN")
  @RateLimit({ limit: 30, windowMs: 60_000, by: "session" })
  @Post("encounters/:id/prescription-scans")
  async upload(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    return { data: await this.scans.upload(ctx, id(encounterId), parse(uploadScanQuerySchema, query), contentType, req.body) };
  }

  @RequirePermissions("PRESCRIPTION_SCAN")
  @RateLimit({ limit: 30, windowMs: 60_000, by: "session" })
  @Post("prescription-scans/:id/extract")
  @HttpCode(200)
  async extract(@Ctx() ctx: RequestContext, @Param("id") scanId: string) { return { data: await this.scans.extract(ctx, id(scanId)) }; }

  @RequirePermissions("PRESCRIPTION_SCAN")
  @Put("prescription-scans/:id/correction")
  async correct(@Ctx() ctx: RequestContext, @Param("id") scanId: string, @Body() body: unknown) { return { data: await this.scans.correct(ctx, id(scanId), parse(correctScanSchema, body)) }; }

  /** Saves the structured medicine lines (a draft). */
  @RequirePermissions("PRESCRIPTION_SCAN")
  @Put("prescription-scans/:id/lines")
  async lines(@Ctx() ctx: RequestContext, @Param("id") scanId: string, @Body() body: unknown) { return { data: await this.scans.saveLines(ctx, id(scanId), parse(saveLinesSchema, body)) }; }

  /** The doctor's approval: creates the prescription the pharmacy dispenses from. Needs the right to sign prescriptions. */
  @RequirePermissions("PRESCRIPTION_SCAN", "PRESCRIPTION_SIGN")
  @Post("prescription-scans/:id/approve")
  @HttpCode(200)
  async approve(@Ctx() ctx: RequestContext, @Param("id") scanId: string, @Body() body: unknown) { return { data: await this.scans.approve(ctx, id(scanId), parse(approveScanSchema, body)) }; }
}
