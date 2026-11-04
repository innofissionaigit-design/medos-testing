import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { DispensingService, dispenseListSchema, dispenseReturnSchema, dispenseSchema, queueQuerySchema, rejectHandwrittenSchema, suggestSchema } from "./dispensing.service";
import {
  adjustSchema, batchQuerySchema, blockBatchSchema, InventoryService, ledgerQuerySchema, openingBatchSchema, purchaseListSchema,
  purchaseReturnSchema, purchaseSchema, stockQuerySchema,
} from "./inventory.service";
import {
  createSupplierSchema, MedicinesService, updateSupplierSchema,
} from "./medicines.service";

function created(res: Response, replayed: boolean): void {
  res.status(replayed ? 200 : 201);
  if (replayed) res.setHeader("Idempotent-Replayed", "true");
}

@Feature("PHARMACY_ENABLED")
@Controller()
export class PharmacyController {
  constructor(
    private readonly medicines: MedicinesService,
    private readonly inventory: InventoryService,
    private readonly dispensing: DispensingService,
  ) {}

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/medicines/:id/suggest-batches")
  async suggest(@Ctx() ctx: RequestContext, @Param("id") medicineId: string, @Query() query: unknown) {
    return { data: await this.dispensing.suggest(ctx, id(medicineId), parse(suggestSchema, query).quantity) };
  }

  // ───── suppliers ─────

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/suppliers")
  async suppliers(@Ctx() ctx: RequestContext) {
    return { data: await this.medicines.listSuppliers(ctx, ctx.permissions.has("PHARMACY_MASTERS")) };
  }

  @RequirePermissions("PHARMACY_MASTERS")
  @Post("pharmacy/suppliers")
  async createSupplier(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.medicines.createSupplier(ctx, parse(createSupplierSchema, body)) };
  }

  @RequirePermissions("PHARMACY_MASTERS")
  @Patch("pharmacy/suppliers/:id")
  async updateSupplier(@Ctx() ctx: RequestContext, @Param("id") supplierId: string, @Body() body: unknown) {
    return { data: await this.medicines.updateSupplier(ctx, id(supplierId), parse(updateSupplierSchema, body)) };
  }

  // ───── batches and stock ─────

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/batches")
  async batches(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(batchQuerySchema, query);
    const { items, total } = await this.inventory.listBatches(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("pharmacy/batches")
  async openingBatch(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.inventory.createOpeningBatch(ctx, parse(openingBatchSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("pharmacy/batches/:id/block")
  @HttpCode(200)
  async block(@Ctx() ctx: RequestContext, @Param("id") batchId: string, @Body() body: unknown) {
    return { data: await this.inventory.setBlocked(ctx, id(batchId), true, parse(blockBatchSchema, body).reason) };
  }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("pharmacy/batches/:id/unblock")
  @HttpCode(200)
  async unblock(@Ctx() ctx: RequestContext, @Param("id") batchId: string) {
    return { data: await this.inventory.setBlocked(ctx, id(batchId), false, null) };
  }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/batches/:id/ledger")
  async ledger(@Ctx() ctx: RequestContext, @Param("id") batchId: string, @Query() query: unknown) {
    const q = parse(ledgerQuerySchema, query);
    const r = await this.inventory.ledger(ctx, id(batchId), q);
    return { data: { batch: r.batch, reconciliation: r.reconciliation, items: r.items }, meta: { page: q.page, pageSize: q.pageSize, total: r.total } };
  }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/stock")
  async stock(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(stockQuerySchema, query);
    const { items, total } = await this.inventory.stockSummary(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("pharmacy/stock/adjustments")
  async adjust(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.inventory.adjust(ctx, parse(adjustSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }

  // ───── procurement ─────

  @RequirePermissions("PHARMACY_PURCHASE")
  @Post("pharmacy/purchases")
  async receive(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.inventory.receivePurchase(ctx, parse(purchaseSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }

  @RequirePermissions("PHARMACY_PURCHASE")
  @Get("pharmacy/purchases")
  async purchases(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(purchaseListSchema, query);
    const { items, total } = await this.inventory.listPurchases(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PHARMACY_PURCHASE")
  @Get("pharmacy/purchases/:id")
  async purchase(@Ctx() ctx: RequestContext, @Param("id") purchaseId: string) {
    return { data: await this.inventory.getPurchase(ctx, id(purchaseId)) };
  }

  @RequirePermissions("PHARMACY_PURCHASE")
  @Post("pharmacy/purchases/:id/returns")
  async purchaseReturn(@Ctx() ctx: RequestContext, @Param("id") purchaseId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.inventory.returnPurchase(ctx, id(purchaseId), parse(purchaseReturnSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }

  // ───── prescription queue and dispensing ─────

  @RequirePermissions("PRESCRIPTION_READ", "PHARMACY_READ")
  @Get("pharmacy/queue")
  async queue(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(queueQuerySchema, query);
    const { items, total } = await this.dispensing.queue(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  /** Handwritten prescription pictures from the doctors, waiting for the pharmacist to check them, enter the medicines and dispense. */
  @RequirePermissions("PHARMACY_DISPENSE")
  @Get("pharmacy/handwritten")
  async handwritten(@Ctx() ctx: RequestContext) { return { data: await this.dispensing.handwrittenQueue(ctx) }; }

  @RequirePermissions("PHARMACY_DISPENSE")
  @Post("pharmacy/handwritten/:id/reject")
  @HttpCode(200)
  async rejectHandwritten(@Ctx() ctx: RequestContext, @Param("id") scanId: string, @Body() body: unknown) { return { data: await this.dispensing.rejectHandwritten(ctx, id(scanId), parse(rejectHandwrittenSchema, body)) }; }

  @RequirePermissions("PHARMACY_DISPENSE")
  @Post("pharmacy/dispenses")
  async dispense(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.dispensing.dispense(ctx, parse(dispenseSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/dispenses")
  async dispenses(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(dispenseListSchema, query);
    const { items, total } = await this.dispensing.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PHARMACY_READ")
  @Get("pharmacy/dispenses/:id")
  async dispenseGet(@Ctx() ctx: RequestContext, @Param("id") dispenseId: string) {
    return { data: await this.dispensing.get(ctx, id(dispenseId)) };
  }

  @RequirePermissions("PHARMACY_DISPENSE")
  @Post("pharmacy/dispenses/:id/returns")
  async dispenseReturn(@Ctx() ctx: RequestContext, @Param("id") dispenseId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.dispensing.returnItems(ctx, id(dispenseId), parse(dispenseReturnSchema, body), parseIdempotencyKey(key));
    created(res, replayed);
    return { data: result };
  }
}
