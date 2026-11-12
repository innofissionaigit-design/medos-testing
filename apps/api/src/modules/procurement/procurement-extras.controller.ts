import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { CostLedgerBackfillService } from "./cost-ledger-backfill.service";
import { CostLedgerService, ledgerEntriesSchema, ledgerRangeSchema } from "./cost-ledger.service";
import { creditSchema, debitNoteListSchema, PayablesService, payableListSchema, payStatementSchema, paySchema } from "./payables.service";
import { approveCountSchema, countListSchema, decisionSchema, enterCountsSchema, startCountSchema, StockCountsService } from "./stock-counts.service";
import { closeRequestSchema, issueRequestSchema, requestListSchema, stockRequestSchema, StockRequestsService } from "./stock-requests.service";

function respond(res: Response, replayed: boolean): void {
  res.status(replayed ? 200 : 201);
  if (replayed) res.setHeader("Idempotent-Replayed", "true");
}

/** Store requests, supplier payables and debit notes, and physical stock counts (docs/procurement.md). */
@Feature("PHARMACY_ENABLED")
@Controller()
export class ProcurementExtrasController {
  constructor(private readonly requests: StockRequestsService, private readonly payables: PayablesService, private readonly counts: StockCountsService, private readonly ledger: CostLedgerService, private readonly backfill: CostLedgerBackfillService) {}

  // ───── store requests ─────

  @RequireAnyPermission("STORES_INDENT", "PHARMACY_ADJUST_STOCK", "PURCHASE_READ")
  @Get("procurement/stock-requests")
  async listRequests(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.requests.list(ctx, parse(requestListSchema, q)) }; }

  @RequirePermissions("STORES_INDENT")
  @Post("procurement/stock-requests")
  async createRequest(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.requests.create(ctx, parse(stockRequestSchema, body)) }; }

  @RequireAnyPermission("STORES_INDENT", "PHARMACY_ADJUST_STOCK", "PURCHASE_READ")
  @Get("procurement/stock-requests/:id")
  async getRequest(@Ctx() ctx: RequestContext, @Param("id") requestId: string) { return { data: await this.requests.get(ctx, id(requestId)) }; }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("procurement/stock-requests/:id/issue")
  async issueRequest(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.requests.issue(ctx, id(requestId), parse(issueRequestSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequirePermissions("PHARMACY_ADJUST_STOCK")
  @Post("procurement/stock-requests/:id/reject")
  @HttpCode(200)
  async rejectRequest(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.requests.reject(ctx, id(requestId), parse(closeRequestSchema, body)) }; }

  @RequireAnyPermission("STORES_INDENT", "PHARMACY_ADJUST_STOCK")
  @Post("procurement/stock-requests/:id/cancel")
  @HttpCode(200)
  async cancelRequest(@Ctx() ctx: RequestContext, @Param("id") requestId: string, @Body() body: unknown) { return { data: await this.requests.cancel(ctx, id(requestId), parse(closeRequestSchema, body)) }; }

  // ───── supplier payables, payments, debit notes ─────

  @RequireAnyPermission("SUPPLIER_PAY", "PURCHASE_READ")
  @Get("procurement/payables")
  async listPayables(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.payables.list(ctx, parse(payableListSchema, q)) }; }

  @RequirePermissions("SUPPLIER_PAY")
  @Post("procurement/payables/statement-payments")
  async payStatement(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.payables.payStatement(ctx, parse(payStatementSchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequireAnyPermission("REPORT_FINANCE", "PURCHASE_READ", "SUPPLIER_PAY")
  @Get("procurement/cost-ledger")
  async costLedger(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.ledger.trialBalance(ctx, parse(ledgerRangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_FINANCE", "PURCHASE_READ", "SUPPLIER_PAY")
  @Get("procurement/cost-ledger/reconciliation")
  async costLedgerReconciliation(@Ctx() ctx: RequestContext) { return { data: await this.ledger.reconciliation(ctx) }; }

  @RequireAnyPermission("SUPPLIER_PAY", "ADMIN_SETTINGS")
  @Get("procurement/cost-ledger/backfill")
  async backfillPending(@Ctx() ctx: RequestContext) { return { data: await this.backfill.pending(ctx) }; }

  @RequireAnyPermission("SUPPLIER_PAY", "ADMIN_SETTINGS")
  @Post("procurement/cost-ledger/backfill")
  @HttpCode(200)
  async backfillRun(@Ctx() ctx: RequestContext) { return { data: await this.backfill.run(ctx) }; }

  @RequireAnyPermission("REPORT_FINANCE", "PURCHASE_READ", "SUPPLIER_PAY")
  @Get("procurement/cost-ledger/entries")
  async costLedgerEntries(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.ledger.entries(ctx, parse(ledgerEntriesSchema, q)) }; }

  @RequirePermissions("SUPPLIER_PAY")
  @Post("procurement/payables/:purchaseId/payments")
  async pay(@Ctx() ctx: RequestContext, @Param("purchaseId") purchaseId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.payables.pay(ctx, id(purchaseId), parse(paySchema, body), parseIdempotencyKey(key));
    respond(res, replayed);
    return { data: result };
  }

  @RequireAnyPermission("SUPPLIER_PAY", "PURCHASE_READ", "PHARMACY_PURCHASE")
  @Get("procurement/debit-notes")
  async listDebitNotes(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.payables.listDebitNotes(ctx, parse(debitNoteListSchema, q)) }; }

  @RequireAnyPermission("SUPPLIER_PAY", "PHARMACY_PURCHASE")
  @Post("procurement/debit-notes/:id/credit")
  @HttpCode(200)
  async credit(@Ctx() ctx: RequestContext, @Param("id") noteId: string, @Body() body: unknown) { return { data: await this.payables.creditDebitNote(ctx, id(noteId), parse(creditSchema, body)) }; }

  // ───── stock counts ─────

  @RequireAnyPermission("STOCK_COUNT", "STOCK_COUNT_APPROVE", "PURCHASE_READ")
  @Get("procurement/stock-counts")
  async listCounts(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.counts.list(ctx, parse(countListSchema, q)) }; }

  @RequirePermissions("STOCK_COUNT")
  @Post("procurement/stock-counts")
  async startCount(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.counts.start(ctx, parse(startCountSchema, body)) }; }

  @RequireAnyPermission("STOCK_COUNT", "STOCK_COUNT_APPROVE", "PURCHASE_READ")
  @Get("procurement/stock-counts/:id")
  async getCount(@Ctx() ctx: RequestContext, @Param("id") countId: string) { return { data: await this.counts.get(ctx, id(countId)) }; }

  @RequirePermissions("STOCK_COUNT")
  @Put("procurement/stock-counts/:id/counts")
  async enterCounts(@Ctx() ctx: RequestContext, @Param("id") countId: string, @Body() body: unknown) { return { data: await this.counts.enter(ctx, id(countId), parse(enterCountsSchema, body)) }; }

  @RequirePermissions("STOCK_COUNT")
  @Post("procurement/stock-counts/:id/submit")
  @HttpCode(200)
  async submitCount(@Ctx() ctx: RequestContext, @Param("id") countId: string) { return { data: await this.counts.submit(ctx, id(countId)) }; }

  @RequirePermissions("STOCK_COUNT_APPROVE")
  @Post("procurement/stock-counts/:id/approve")
  @HttpCode(200)
  async approveCount(@Ctx() ctx: RequestContext, @Param("id") countId: string, @Body() body: unknown) { return { data: await this.counts.approve(ctx, id(countId), parse(approveCountSchema, body)) }; }

  @RequireAnyPermission("STOCK_COUNT", "STOCK_COUNT_APPROVE")
  @Post("procurement/stock-counts/:id/cancel")
  @HttpCode(200)
  async cancelCount(@Ctx() ctx: RequestContext, @Param("id") countId: string, @Body() body: unknown) { return { data: await this.counts.cancel(ctx, id(countId), parse(decisionSchema, body)) }; }
}
