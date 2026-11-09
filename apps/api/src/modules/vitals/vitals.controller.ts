import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { errorSchema, listVitalsSchema, recordVitalsSchema, VitalsService } from "./vitals.service";

@Controller()
export class VitalsController {
  constructor(private readonly vitals: VitalsService) {}

  @RequirePermissions("VITALS_CREATE")
  @Post("encounters/:id/observations")
  async record(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.vitals.record(ctx, id(encounterId), parse(recordVitalsSchema, body)) };
  }

  @RequirePermissions("VITALS_READ")
  @Get("encounters/:id/observations")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Query() query: unknown) {
    const q = parse(listVitalsSchema, query);
    return { data: await this.vitals.listForEncounter(ctx, id(encounterId), q.includeErrors) };
  }

  @RequirePermissions("VITALS_READ")
  @Get("patients/:id/observations")
  async forPatient(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Query() query: unknown) {
    const q = parse(listVitalsSchema, query);
    const { items, total } = await this.vitals.listForPatient(ctx, id(patientId), q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("VITALS_CREATE")
  @Post("observations/:id/enter-in-error")
  @HttpCode(200)
  async enterInError(@Ctx() ctx: RequestContext, @Param("id") observationId: string, @Body() body: unknown) {
    return { data: await this.vitals.enterInError(ctx, id(observationId), parse(errorSchema, body).reason) };
  }
}
