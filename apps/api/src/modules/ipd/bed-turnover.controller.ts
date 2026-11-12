import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { BedTurnoverService } from "./bed-turnover.service";

/** Bed turnover after a discharge (docs/discharge-stages.md): housekeeping's list of beds to turn around, start cleaning, mark ready. */
@Feature("IPD_ENABLED")
@Controller()
export class BedTurnoverController {
  constructor(private readonly turnover: BedTurnoverService) {}

  @RequirePermissions("BED_HOUSEKEEPING")
  @Get("bed-turnovers")
  async list(@Ctx() ctx: RequestContext) { return { data: await this.turnover.list(ctx) }; }

  @RequirePermissions("BED_HOUSEKEEPING")
  @Post("bed-turnovers/:id/start")
  @HttpCode(200)
  async start(@Ctx() ctx: RequestContext, @Param("id") turnoverId: string) { return { data: await this.turnover.startCleaning(ctx, id(turnoverId)) }; }

  @RequirePermissions("BED_HOUSEKEEPING")
  @Post("bed-turnovers/:id/ready")
  @HttpCode(200)
  async ready(@Ctx() ctx: RequestContext, @Param("id") turnoverId: string) { return { data: await this.turnover.markReady(ctx, id(turnoverId)) }; }
}
