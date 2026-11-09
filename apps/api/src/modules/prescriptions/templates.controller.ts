import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { createTemplateSchema, TemplatesService } from "./templates.service";

/** A doctor's saved prescriptions (docs/prescriptions.md). */
@Controller("prescription-templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @RequirePermissions("PRESCRIPTION_CREATE")
  @Get()
  async list(@Ctx() ctx: RequestContext) { return { data: await this.templates.list(ctx) }; }

  @RequirePermissions("PRESCRIPTION_CREATE")
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.templates.create(ctx, parse(createTemplateSchema, body)) }; }

  @RequirePermissions("PRESCRIPTION_CREATE")
  @Post(":id/remove")
  @HttpCode(200)
  async remove(@Ctx() ctx: RequestContext, @Param("id") templateId: string) { return { data: await this.templates.remove(ctx, id(templateId)) }; }
}
