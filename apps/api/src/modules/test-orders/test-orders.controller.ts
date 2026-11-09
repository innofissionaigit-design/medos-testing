import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import { CashierCollectService, collectSchema } from "./cashier-collect.service";
import { CashierViewService } from "./cashier-view.service";
import { billTestsSchema, cancelTestSchema, saveBillingSchema, TestOrdersService } from "./test-orders.service";

/** Tests the doctor advised, billed by the Cashier (docs/test-orders.md). */
@Controller()
export class TestOrdersController {
  constructor(private readonly tests: TestOrdersService, private readonly cashierView: CashierViewService, private readonly collector: CashierCollectService) {}

  /** The Cashier's one place per patient: medicines (digital and handwritten), tests (digital and handwritten) and bills, with what is still to collect. */
  @RequirePermissions("TEST_BILL")
  @Get("cashier/prescriptions")
  async prescriptions(@Ctx() ctx: RequestContext) { return { data: await this.cashierView.patients(ctx) }; }

  /** Collect several of a patient's bills in one payment (every payment needs an Idempotency-Key, as for a single bill). */
  @RequirePermissions("PAYMENT_CREATE", "TEST_BILL")
  @Post("cashier/patients/:patientId/collect")
  async collect(@Ctx() ctx: RequestContext, @Param("patientId") patientId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { result, replayed } = await this.collector.collect(ctx, id(patientId), parse(collectSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    return { data: result };
  }

  @RequirePermissions("TEST_BILL")
  @Get("test-orders/queue")
  async queue(@Ctx() ctx: RequestContext) { return { data: await this.tests.queue(ctx) }; }

  @RequirePermissions("TEST_BILL")
  @Post("test-orders/bill")
  @HttpCode(201)
  async bill(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.tests.bill(ctx, parse(billTestsSchema, body)) }; }

  /** Saves the Cashier's edits of a visit's tests (name, price, quantity, tests added or taken off) as billing lines. The doctor's orders are not changed. */
  @RequirePermissions("TEST_BILL")
  @Put("test-orders/billing/:encounterId")
  async saveBilling(@Ctx() ctx: RequestContext, @Param("encounterId") encounterId: string, @Body() body: unknown) { return { data: await this.tests.saveBillingLines(ctx, id(encounterId), parse(saveBillingSchema, body)) }; }

  @RequirePermissions("TEST_BILL")
  @Post("test-orders/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") testId: string, @Body() body: unknown) { return { data: await this.tests.cancel(ctx, id(testId), parse(cancelTestSchema, body)) }; }

  @RequirePermissions("TEST_BILL")
  @Post("test-orders/pictures/:scanId/no-tests")
  @HttpCode(200)
  async noTests(@Ctx() ctx: RequestContext, @Param("scanId") scanId: string) { return { data: await this.tests.noTests(ctx, id(scanId)) }; }

  @RequireAnyPermission("CONSULTATION_READ", "TEST_BILL")
  @Get("encounters/:id/test-orders")
  async forEncounter(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.tests.forEncounter(ctx, id(encounterId)) }; }
}
