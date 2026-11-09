import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { Ctx, parse, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { OcrConfigService, saveOcrConfigSchema } from "./ocr-config.service";

/** Connect, test and disconnect the OCR service that reads handwritten prescriptions (docs/prescriptions.md). The API key is write-only. */
@Controller("ocr/config")
export class OcrConfigController {
  constructor(private readonly ocr: OcrConfigService) {}

  @RequirePermissions("ADMIN_SETTINGS")
  @Get()
  async get(@Ctx() ctx: RequestContext) { return { data: await this.ocr.view(ctx) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @Put()
  async save(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ocr.save(ctx, parse(saveOcrConfigSchema, body)) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  @Post("test")
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext) { return { data: await this.ocr.test(ctx) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @Post("disconnect")
  @HttpCode(200)
  async disconnect(@Ctx() ctx: RequestContext) { return { data: await this.ocr.disconnect(ctx) }; }
}
