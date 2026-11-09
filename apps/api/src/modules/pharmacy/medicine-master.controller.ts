import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { AnyAuthenticated, Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { createMedicineSchema, MedicinesService, searchMedicinesSchema, updateMedicineSchema } from "./medicines.service";

/** The medicine master is shared by prescribers and pharmacy, so it stays available even when the pharmacy module is switched off. */
@Controller()
export class MedicineMasterController {
  constructor(private readonly medicines: MedicinesService) {}

  @AnyAuthenticated()
  @Get("medicines")
  async search(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(searchMedicinesSchema, query);
    const { items, total } = await this.medicines.search(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PHARMACY_MASTERS")
  @Post("medicines")
  async createMedicine(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.medicines.create(ctx, parse(createMedicineSchema, body)) };
  }

  @RequirePermissions("PHARMACY_MASTERS")
  @Patch("medicines/:id")
  async updateMedicine(@Ctx() ctx: RequestContext, @Param("id") medicineId: string, @Body() body: unknown) {
    return { data: await this.medicines.update(ctx, id(medicineId), parse(updateMedicineSchema, body)) };
  }
}
