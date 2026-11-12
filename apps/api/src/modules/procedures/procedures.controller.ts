import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { addItemSchema, cancelProcedureSchema, performProcedureSchema, planProcedureSchema, ProceduresService, removeItemSchema } from "./procedures.service";

@Feature("IPD_ENABLED")
@Controller()
export class ProceduresController {
  constructor(private readonly procedures: ProceduresService) {}

  @RequirePermissions("PROCEDURE_READ")
  @Get("admissions/:id/procedures")
  async list(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.procedures.list(ctx, id(admissionId)) };
  }

  /** The doctor or the RMO plans a procedure from the price list. */
  @RequirePermissions("PROCEDURE_PLAN")
  @Post("admissions/:id/procedures")
  async plan(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.procedures.plan(ctx, id(admissionId), parse(planProcedureSchema, body)) };
  }

  /** The OT / procedure coordinator performs it: its charge is posted to the admission. */
  @RequirePermissions("PROCEDURE_MANAGE")
  @Post("procedures/:id/perform")
  @HttpCode(200)
  async perform(@Ctx() ctx: RequestContext, @Param("id") procedureId: string, @Body() body: unknown) {
    return { data: await this.procedures.perform(ctx, id(procedureId), parse(performProcedureSchema, body ?? {})) };
  }

  @RequirePermissions("PROCEDURE_MANAGE")
  @Post("procedures/:id/items")
  async addItem(@Ctx() ctx: RequestContext, @Param("id") procedureId: string, @Body() body: unknown) {
    return { data: await this.procedures.addItem(ctx, id(procedureId), parse(addItemSchema, body)) };
  }

  @RequirePermissions("PROCEDURE_MANAGE")
  @Post("procedures/:id/items/:itemId/remove")
  @HttpCode(200)
  async removeItem(@Ctx() ctx: RequestContext, @Param("id") procedureId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return { data: await this.procedures.removeItem(ctx, id(procedureId), id(itemId), parse(removeItemSchema, body)) };
  }

  /** The coordinator confirms the procedure, implants and consumables are all recorded and charged; nothing can change afterwards. */
  @RequirePermissions("PROCEDURE_MANAGE")
  @Post("procedures/:id/finalise")
  @HttpCode(200)
  async finalise(@Ctx() ctx: RequestContext, @Param("id") procedureId: string) {
    return { data: await this.procedures.finalise(ctx, id(procedureId)) };
  }

  @RequirePermissions("PROCEDURE_PLAN")
  @Post("procedures/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") procedureId: string, @Body() body: unknown) {
    return { data: await this.procedures.cancel(ctx, id(procedureId), parse(cancelProcedureSchema, body)) };
  }
}
