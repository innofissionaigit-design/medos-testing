import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { NumberingService, sequenceConfigSchema, sequenceTypeSchema } from "./numbering.service";
import { DomainError } from "@medos/shared";

@Controller("number-sequences")
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @RequirePermissions("ADMIN_SETTINGS")
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.numbering.list(ctx) };
  }

  @RequirePermissions("ADMIN_SETTINGS")
  @Put(":type")
  async update(@Ctx() ctx: RequestContext, @Param("type") type: string, @Body() body: unknown) {
    const t = sequenceTypeSchema.safeParse(type);
    if (!t.success) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { data: await this.numbering.update(ctx, t.data, parse(sequenceConfigSchema, body)) };
  }
}
