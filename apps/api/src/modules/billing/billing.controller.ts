import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AnyAuthenticated, Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { CatalogService, createServiceSchema, listServicesSchema, updateServiceSchema } from "./catalog.service";
import { cancelInvoiceSchema, createInvoiceSchema, discountInvoiceSchema, InvoicesService, listInvoicesSchema, updateInvoiceSchema } from "./invoices.service";
import { creditNoteSchema, payInvoiceSchema, PaymentsService, refundSchema } from "./payments.service";
import { closeShiftSchema, listShiftsSchema, openShiftSchema, ShiftsService } from "./shifts.service";

@Controller()
export class BillingController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly shifts: ShiftsService,
  ) {}

  // ───── service catalogue ─────

  @AnyAuthenticated()
  @Get("services")
  async services(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listServicesSchema, query);
    const { items, total } = await this.catalog.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Post("services")
  async createService(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.catalog.create(ctx, parse(createServiceSchema, body)) };
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Patch("services/:id")
  async updateService(@Ctx() ctx: RequestContext, @Param("id") serviceId: string, @Body() body: unknown) {
    return { data: await this.catalog.update(ctx, id(serviceId), parse(updateServiceSchema, body)) };
  }

  // ───── invoices ─────

  @RequirePermissions("INVOICE_READ")
  @Get("invoices")
  async listInvoices(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listInvoicesSchema, query);
    const { items, total } = await this.invoices.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("INVOICE_CREATE")
  @Post("invoices")
  async createInvoice(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.invoices.create(ctx, parse(createInvoiceSchema, body)) };
  }

  @RequirePermissions("INVOICE_READ")
  @Get("invoices/:id")
  async getInvoice(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string) {
    return { data: await this.invoices.get(ctx, id(invoiceId)) };
  }

  @RequirePermissions("INVOICE_CREATE")
  @Put("invoices/:id")
  async updateInvoice(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown) {
    return { data: await this.invoices.update(ctx, id(invoiceId), parse(updateInvoiceSchema, body)) };
  }

  @RequirePermissions("INVOICE_DISCOUNT")
  @Post("invoices/:id/discount")
  @HttpCode(200)
  async discount(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown) {
    return { data: await this.invoices.applyDiscount(ctx, id(invoiceId), parse(discountInvoiceSchema, body)) };
  }

  @RequirePermissions("INVOICE_ISSUE")
  @Post("invoices/:id/issue")
  @HttpCode(200)
  async issue(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string) {
    return { data: await this.invoices.issue(ctx, id(invoiceId)) };
  }

  @RequirePermissions("INVOICE_CANCEL")
  @Post("invoices/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown) {
    return { data: await this.invoices.cancel(ctx, id(invoiceId), parse(cancelInvoiceSchema, body)) };
  }

  // ───── money movements (all require an Idempotency-Key) ─────

  @RequirePermissions("PAYMENT_CREATE")
  @Post("invoices/:id/payments")
  async pay(
    @Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.payments.pay(ctx, id(invoiceId), parse(payInvoiceSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("PAYMENT_REFUND")
  @Post("invoices/:id/refunds")
  async refund(
    @Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.payments.refund(ctx, id(invoiceId), parse(refundSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("INVOICE_ADJUST")
  @Post("invoices/:id/credit-notes")
  async creditNote(
    @Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { result, replayed } = await this.payments.creditNote(ctx, id(invoiceId), parse(creditNoteSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: result };
  }

  @RequirePermissions("INVOICE_READ")
  @Get("receipts/:id")
  async receipt(@Ctx() ctx: RequestContext, @Param("id") receiptId: string) {
    return { data: await this.payments.getReceipt(ctx, id(receiptId)) };
  }

  // ───── cashier shifts ─────

  @RequirePermissions("CASHIER_SHIFT_MANAGE")
  @Post("shifts/open")
  async openShift(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.shifts.open(ctx, parse(openShiftSchema, body)) };
  }

  @RequirePermissions("CASHIER_SHIFT_MANAGE")
  @Get("shifts/current")
  async currentShift(@Ctx() ctx: RequestContext) {
    return { data: await this.shifts.current(ctx) };
  }

  @RequirePermissions("CASHIER_SHIFT_MANAGE")
  @Get("shifts")
  async listShifts(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listShiftsSchema, query);
    const { items, total } = await this.shifts.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("CASHIER_SHIFT_MANAGE")
  @Get("shifts/:id")
  async getShift(@Ctx() ctx: RequestContext, @Param("id") shiftId: string) {
    return { data: await this.shifts.get(ctx, id(shiftId)) };
  }

  @RequirePermissions("CASHIER_SHIFT_MANAGE")
  @Post("shifts/:id/close")
  @HttpCode(200)
  async closeShift(@Ctx() ctx: RequestContext, @Param("id") shiftId: string, @Body() body: unknown) {
    return { data: await this.shifts.close(ctx, id(shiftId), parse(closeShiftSchema, body)) };
  }
}
