import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { Ctx, id, parse, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AiService, draftSchema, reviewSchema, saveAiConfigSchema } from "./ai.service";

/** The AI assistant (docs/ai-assistant.md): the hospital's provider connection, and doctor-reviewed drafts for a visit. */
@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @RequirePermissions("AI_CONFIGURE")
  @Get("ai/config")
  async config(@Ctx() ctx: RequestContext) { return { data: await this.ai.view(ctx) }; }

  @RequirePermissions("AI_CONFIGURE")
  @Put("ai/config")
  async save(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.ai.save(ctx, parse(saveAiConfigSchema, body)) }; }

  @RequirePermissions("AI_CONFIGURE")
  @Delete("ai/config")
  async disconnect(@Ctx() ctx: RequestContext) { return { data: await this.ai.disconnect(ctx) }; }

  @RequirePermissions("AI_CONFIGURE")
  @Post("ai/config/test")
  @HttpCode(200)
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  async test(@Ctx() ctx: RequestContext) { return { data: await this.ai.test(ctx) }; }

  @RequirePermissions("AI_USE")
  @Get("ai/status")
  async status(@Ctx() ctx: RequestContext) { return { data: await this.ai.status(ctx) }; }

  @RequirePermissions("AI_USE")
  @Post("encounters/:id/ai/drafts")
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  async draft(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) { return { data: await this.ai.draft(ctx, id(encounterId), parse(draftSchema, body)) }; }

  @RequirePermissions("AI_USE")
  @Get("encounters/:id/ai/drafts")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.ai.list(ctx, id(encounterId)) }; }

  @RequirePermissions("AI_USE")
  @Post("ai/drafts/:id/review")
  @HttpCode(200)
  async review(@Ctx() ctx: RequestContext, @Param("id") draftId: string, @Body() body: unknown) { return { data: await this.ai.review(ctx, id(draftId), parse(reviewSchema, body)) }; }
}
