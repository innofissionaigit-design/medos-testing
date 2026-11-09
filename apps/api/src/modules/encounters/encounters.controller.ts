import { Controller, Get, Param, Query } from "@nestjs/common";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { EncountersService, listEncountersSchema } from "./encounters.service";

@Controller()
export class EncountersController {
  constructor(private readonly encounters: EncountersService) {}

  @RequirePermissions("PATIENT_READ")
  @Get("encounters/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) {
    return { data: await this.encounters.get(ctx, id(encounterId)) };
  }

  @RequirePermissions("PATIENT_READ")
  @Get("patients/:patientId/encounters")
  async forPatient(@Ctx() ctx: RequestContext, @Param("patientId") patientId: string, @Query() query: unknown) {
    const q = parse(listEncountersSchema, query);
    const { items, total } = await this.encounters.listForPatient(ctx, id(patientId), q);
    return paginate(items, total, q.page, q.pageSize);
  }
}
