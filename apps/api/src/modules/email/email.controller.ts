import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { addSuppressionSchema, EmailService, languageSchema, listOutboxSchema, previewSchema, saveTemplateSchema, testSchema } from "./email.service";

/**
 * Email (docs/email.md). Setting it up needs EMAIL_MANAGE; reading the delivery log needs EMAIL_LOG_READ. Whether email is on is the ADMIN_SETTINGS setting EMAIL_ENABLED.
 * Everything is the signed-in hospital's and facility's own, taken from the session.
 */
@Controller()
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @RequireAnyPermission("EMAIL_MANAGE", "EMAIL_LOG_READ")
  @Get("email/status")
  async status(@Ctx() ctx: RequestContext) { return { data: await this.email.status(ctx) }; }

  @RequireAnyPermission("EMAIL_MANAGE", "EMAIL_LOG_READ")
  @Get("email/templates")
  async templates(@Ctx() ctx: RequestContext) { return { data: await this.email.templates(ctx) }; }

  @RequirePermissions("EMAIL_MANAGE")
  @Put("email/templates/:key/:language")
  async saveTemplate(@Ctx() ctx: RequestContext, @Param("key") key: string, @Param("language") language: string, @Body() body: unknown) {
    return { data: await this.email.saveTemplate(ctx, key, parse(languageSchema, language), parse(saveTemplateSchema, body)) };
  }

  @RequirePermissions("EMAIL_MANAGE")
  @Delete("email/templates/:key/:language")
  @HttpCode(204)
  async resetTemplate(@Ctx() ctx: RequestContext, @Param("key") key: string, @Param("language") language: string): Promise<void> {
    await this.email.resetTemplate(ctx, key, parse(languageSchema, language));
  }

  @RequireAnyPermission("EMAIL_MANAGE", "EMAIL_LOG_READ")
  @Post("email/templates/:key/:language/preview")
  @HttpCode(200)
  preview(@Param("key") key: string, @Param("language") language: string, @Body() body: unknown) {
    return { data: this.email.preview(key, parse(languageSchema, language), parse(previewSchema, body ?? {})) };
  }

  @RequirePermissions("EMAIL_MANAGE")
  @Post("email/test")
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.email.sendTest(ctx, parse(testSchema, body)) }; }

  @RequirePermissions("EMAIL_LOG_READ")
  @Get("email/outbox")
  async outbox(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listOutboxSchema, query);
    const r = await this.email.list(ctx, q);
    return { data: r.items, meta: { page: q.page, pageSize: q.pageSize, total: r.total } };
  }

  @RequirePermissions("EMAIL_MANAGE")
  @Post("email/outbox/:id/retry")
  @HttpCode(200)
  async retry(@Ctx() ctx: RequestContext, @Param("id") emailId: string) { return { data: await this.email.retry(ctx, id(emailId)) }; }

  @RequirePermissions("EMAIL_MANAGE")
  @Post("email/outbox/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") emailId: string) { return { data: await this.email.cancel(ctx, id(emailId)) }; }

  @RequireAnyPermission("EMAIL_MANAGE", "EMAIL_LOG_READ")
  @Get("email/suppressions")
  async suppressions(@Ctx() ctx: RequestContext) { return { data: await this.email.suppressions(ctx) }; }

  @RequirePermissions("EMAIL_MANAGE")
  @Post("email/suppressions")
  async addSuppression(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.email.addSuppression(ctx, parse(addSuppressionSchema, body)) }; }

  @RequirePermissions("EMAIL_MANAGE")
  @Delete("email/suppressions/:id")
  @HttpCode(204)
  async removeSuppression(@Ctx() ctx: RequestContext, @Param("id") suppressionId: string): Promise<void> { await this.email.removeSuppression(ctx, id(suppressionId)); }

  /** "Email receipt" on a bill: queues the receipt email to the patient (when they have an address and agreed). */
  @RequirePermissions("INVOICE_READ")
  @Post("invoices/:id/email-receipt")
  @HttpCode(200)
  async emailReceipt(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string) { return { data: await this.email.emailReceipt(ctx, id(invoiceId)) }; }
}
