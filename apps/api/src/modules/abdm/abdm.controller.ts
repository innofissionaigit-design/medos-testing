import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AbdmService, recordAbhaSchema, removeAbhaSchema, saveAbdmConfigSchema } from "./abdm.service";

/** ABDM groundwork (docs/abdm.md): the facility's gateway connection and the ABHA number on a patient's chart. */
@Controller()
export class AbdmController {
  constructor(private readonly abdm: AbdmService) {}

  @RequirePermissions("ADMIN_SETTINGS")
  @Get("abdm/config")
  async config(@Ctx() ctx: RequestContext) { return { data: await this.abdm.view(ctx) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @Put("abdm/config")
  async save(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.abdm.save(ctx, parse(saveAbdmConfigSchema, body)) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @Delete("abdm/config")
  async disconnect(@Ctx() ctx: RequestContext) { return { data: await this.abdm.disconnect(ctx) }; }

  @RequirePermissions("ADMIN_SETTINGS")
  @Post("abdm/config/test")
  @HttpCode(200)
  async test(@Ctx() ctx: RequestContext) { return { data: await this.abdm.test(ctx) }; }

  @RequirePermissions("PATIENT_READ")
  @Get("patients/:id/abha")
  async abha(@Ctx() ctx: RequestContext, @Param("id") patientId: string) { return { data: await this.abdm.abha(ctx, id(patientId)) }; }

  @RequirePermissions("PATIENT_UPDATE")
  @Post("patients/:id/abha")
  async record(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) { return { data: await this.abdm.record(ctx, id(patientId), parse(recordAbhaSchema, body)) }; }

  @RequirePermissions("PATIENT_UPDATE")
  @Post("patients/:id/abha/:linkId/remove")
  @HttpCode(200)
  async remove(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Param("linkId") linkId: string, @Body() body: unknown) { return { data: await this.abdm.remove(ctx, id(patientId), id(linkId), parse(removeAbhaSchema, body)) }; }
}
