import { Body, Controller, Get, Headers, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { cancelTransferSchema, closeTransferSchema, consumeSchema, consumptionListSchema, createLocationSchema, StockLocationsService, transferListSchema, transferSchema, updateLocationSchema, wardIssueSchema } from "./stock-locations.service";

function respond(res: Response, replayed: boolean): void {
  res.status(replayed ? 200 : 201);
  if (replayed) res.setHeader("Idempotent-Replayed", "true");
}

/** Stock locations (ward stores and the like) and transfers of stock between them and the main store (docs/stock-transfers.md). */
@Feature("PHARMACY_ENABLED")
@Controller()
export class StockLocationsController {
  constructor(private readonly locations: StockLocationsService) {}

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/locations")
  async list(@Ctx() ctx: RequestContext) { return { data: await this.locations.list(ctx) }; }

  @RequirePermissions("PHARMACY_MASTERS")
  @Post("pharmacy/locations")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.locations.create(ctx, parse(createLocationSchema, body)) }; }

  @RequirePermissions("PHARMACY_MASTERS")
  @Put("pharmacy/locations/:id")
  async update(@Ctx() ctx: RequestContext, @Param("id") locationId: string, @Body() body: unknown) { return { data: await this.locations.update(ctx, id(locationId), parse(updateLocationSchema, body)) }; }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/locations/:id/stock")
  async stock(@Ctx() ctx: RequestContext, @Param("id") locationId: string) { return { data: await this.locations.stockOf(ctx, id(locationId)) }; }

  /** Moving stock changes where it is, not how much there is: the same permission as adjusting stock, and a header that makes a retry safe. */
  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("pharmacy/transfers")
  async transfer(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.locations.transfer(ctx, parse(transferSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  /** The place the stock was sent to confirms it arrived (pharmacy staff, or nurses for a ward store). */
  @RequireAnyPermission("PHARMACY_ADJUST_STOCK", "NURSING_MEDICATION_ADMINISTER")
  @Post("pharmacy/transfers/:id/receive")
  async receive(@Ctx() ctx: RequestContext, @Param("id") transferId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.locations.receive(ctx, id(transferId), parse(closeTransferSchema, body ?? {}), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  /** The stock did not arrive or is refused: it goes back to where it was sent from. */
  @RequireAnyPermission("PHARMACY_ADJUST_STOCK", "NURSING_MEDICATION_ADMINISTER")
  @Post("pharmacy/transfers/:id/send-back")
  async sendBack(@Ctx() ctx: RequestContext, @Param("id") transferId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.locations.cancel(ctx, id(transferId), parse(cancelTransferSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/transfers")
  async transfers(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.locations.listTransfers(ctx, parse(transferListSchema, query)) }; }
}

/** What a nurse needs from the ward stores: see them, receive stock sent to the ward, and draw a medicine for an admitted patient (docs/stock-transfers.md). */
@Feature("NURSING_ENABLED")
@Controller()
export class WardStoresController {
  constructor(private readonly locations: StockLocationsService) {}

  @RequirePermissions("NURSING_READ")
  @Get("nursing/ward-stores")
  async stores(@Ctx() ctx: RequestContext) { return { data: (await this.locations.list(ctx)).filter((l) => l.status === "ACTIVE") }; }

  @RequirePermissions("NURSING_READ")
  @Get("nursing/ward-stores/:id/stock")
  async stock(@Ctx() ctx: RequestContext, @Param("id") locationId: string) { return { data: await this.locations.stockOf(ctx, id(locationId)) }; }

  /** Stock that has been sent to a ward store and is waiting to be received. */
  @RequirePermissions("NURSING_READ")
  @Get("nursing/ward-stores/incoming")
  async incoming(@Ctx() ctx: RequestContext) { return { data: await this.locations.listTransfers(ctx, parse(transferListSchema, { status: "IN_TRANSIT", pageSize: "50" })) }; }

  @RequireAnyPermission("NURSING_MEDICATION_ADMINISTER", "PHARMACY_DISPENSE")
  @Post("admissions/:id/ward-store-issues")
  async issue(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.locations.issueToPatient(ctx, id(admissionId), parse(wardIssueSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequireAnyPermission("NURSING_READ", "PHARMACY_READ")
  @Get("admissions/:id/ward-store-issues")
  async issues(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) { return { data: await this.locations.issuesOf(ctx, id(admissionId)) }; }

  @RequirePermissions("STOCK_CONSUME")
  @Post("procurement/consumption")
  async consume(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.locations.consume(ctx, parse(consumeSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequirePermissions("STOCK_CONSUME")
  @Get("procurement/consumption/procedures")
  async openProcedures(@Ctx() ctx: RequestContext) { return { data: await this.locations.openProcedures(ctx) }; }

  @RequireAnyPermission("STOCK_CONSUME", "PURCHASE_READ", "PHARMACY_READ")
  @Get("procurement/consumption")
  async consumption(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.locations.listConsumption(ctx, parse(consumptionListSchema, query)) }; }
}
