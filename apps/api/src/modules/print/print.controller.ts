import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { AnyAuthenticated, Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { PrintService, type Rendered } from "./print.service";

const formatQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0") }).strict();
const admissionFormQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0"), lang: z.enum(["en", "bn", "hi"]).default("en") }).strict();

/**
 * Printable documents: server-rendered, fully escaped HTML (default) or a PDF (`?format=pdf`, add `&download=1` to force a download).
 * Both are served with a locked-down CSP (no scripts, no network) and are never cached.
 */
export function sendRendered(res: Response, r: Rendered, download: boolean) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (r.contentType === "application/pdf") res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${r.fileName}"`);
  res.type(r.contentType).send(r.body);
}

@Controller("print")
export class PrintController {
  constructor(private readonly print: PrintService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("invoices/:id")
  async invoice(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.invoice(ctx, id(invoiceId), q.format), q.download === "1");
  }

  @RequirePermissions("INVOICE_READ")
  @Get("receipts/:id")
  async receipt(@Ctx() ctx: RequestContext, @Param("id") receiptId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.receipt(ctx, id(receiptId), q.format), q.download === "1");
  }

  @RequirePermissions("INVOICE_READ")
  @Get("advance-receipts/:id")
  async advanceReceipt(@Ctx() ctx: RequestContext, @Param("id") depositId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.advanceReceipt(ctx, id(depositId), q.format), q.download === "1");
  }

  @RequirePermissions("PRESCRIPTION_READ")
  @Get("prescriptions/:encounterId")
  async prescription(@Ctx() ctx: RequestContext, @Param("encounterId") encounterId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.prescription(ctx, id(encounterId), q.format), q.download === "1");
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("discharge-summaries/:admissionId")
  async dischargeSummary(@Ctx() ctx: RequestContext, @Param("admissionId") admissionId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.dischargeSummary(ctx, id(admissionId), q.format), q.download === "1");
  }

  @RequirePermissions("ADMISSION_READ")
  @Get("admission-forms/:admissionId")
  async admissionForm(@Ctx() ctx: RequestContext, @Param("admissionId") admissionId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(admissionFormQuery, query);
    sendRendered(res, await this.print.admissionForm(ctx, id(admissionId), q.format, q.lang), q.download === "1");
  }

  @RequireAnyPermission("EARNINGS_CONFIGURE", "REPORT_FINANCE", "REPORT_READ")
  @Get("doctor-payouts/:id")
  async payoutVoucher(@Ctx() ctx: RequestContext, @Param("id") payoutId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.payoutVoucher(ctx, id(payoutId), q.format), q.download === "1");
  }

  @RequirePermissions("LAB_READ")
  @Get("lab-reports/:testOrderId")
  async labReport(@Ctx() ctx: RequestContext, @Param("testOrderId") testOrderId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.labReport(ctx, id(testOrderId), q.format), q.download === "1");
  }

  @RequirePermissions("RAD_READ")
  @Get("radiology-reports/:testOrderId")
  async radiologyReport(@Ctx() ctx: RequestContext, @Param("testOrderId") testOrderId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.radiologyReport(ctx, id(testOrderId), q.format), q.download === "1");
  }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:claimId")
  async claimForm(@Ctx() ctx: RequestContext, @Param("claimId") claimId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.claimForm(ctx, id(claimId), q.format), q.download === "1");
  }

  @AnyAuthenticated()
  @Get("payslips/:slipId")
  async payslip(@Ctx() ctx: RequestContext, @Param("slipId") slipId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.payslip(ctx, id(slipId), q.format), q.download === "1");
  }

  @RequirePermissions("LAB_READ")
  @Get("lab-labels/:sampleId")
  async labLabel(@Ctx() ctx: RequestContext, @Param("sampleId") sampleId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.labLabel(ctx, id(sampleId), q.format), q.download === "1");
  }

  @RequirePermissions("PATIENT_READ")
  @Get("patient-labels/:patientId")
  async patientLabel(@Ctx() ctx: RequestContext, @Param("patientId") patientId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    sendRendered(res, await this.print.patientLabel(ctx, id(patientId), q.format), q.download === "1");
  }
}
