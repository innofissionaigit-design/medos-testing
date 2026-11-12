import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequireAnyPermission, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { approveSchema, indentSchema, listSchema, orderSchema, ProcurementService, reasonSchema } from "./procurement.service";

/** Procurement (docs/procurement.md): stock requirement, indents and their approval, and purchase orders. */
@Feature("PHARMACY_ENABLED")
@Controller()
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @RequireAnyPermission("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ")
  @Get("procurement/requirement")
  async requirement(@Ctx() ctx: RequestContext) { return { data: await this.procurement.requirement(ctx) }; }

  @RequireAnyPermission("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ")
  @Get("procurement/indents")
  async indents(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.procurement.listIndents(ctx, parse(listSchema, q)) }; }

  @RequirePermissions("STORES_INDENT")
  @Post("procurement/indents")
  async createIndent(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.procurement.createIndent(ctx, parse(indentSchema, body)) }; }

  @RequireAnyPermission("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ")
  @Get("procurement/indents/:id")
  async indent(@Ctx() ctx: RequestContext, @Param("id") indentId: string) { return { data: await this.procurement.getIndent(ctx, id(indentId)) }; }

  @RequirePermissions("STORES_INDENT")
  @Put("procurement/indents/:id")
  async updateIndent(@Ctx() ctx: RequestContext, @Param("id") indentId: string, @Body() body: unknown) { return { data: await this.procurement.updateIndent(ctx, id(indentId), parse(indentSchema, body)) }; }

  @RequirePermissions("STORES_INDENT")
  @Post("procurement/indents/:id/submit")
  @HttpCode(200)
  async submitIndent(@Ctx() ctx: RequestContext, @Param("id") indentId: string) { return { data: await this.procurement.submitIndent(ctx, id(indentId)) }; }

  @RequirePermissions("PURCHASE_APPROVE")
  @Post("procurement/indents/:id/approve")
  @HttpCode(200)
  async approveIndent(@Ctx() ctx: RequestContext, @Param("id") indentId: string, @Body() body: unknown) { return { data: await this.procurement.decideIndent(ctx, id(indentId), "APPROVE", parse(approveSchema, body).note) }; }

  @RequirePermissions("PURCHASE_APPROVE")
  @Post("procurement/indents/:id/reject")
  @HttpCode(200)
  async rejectIndent(@Ctx() ctx: RequestContext, @Param("id") indentId: string, @Body() body: unknown) { return { data: await this.procurement.decideIndent(ctx, id(indentId), "REJECT", parse(reasonSchema, body).reason) }; }

  @RequireAnyPermission("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE")
  @Post("procurement/indents/:id/cancel")
  @HttpCode(200)
  async cancelIndent(@Ctx() ctx: RequestContext, @Param("id") indentId: string, @Body() body: unknown) { return { data: await this.procurement.cancelIndent(ctx, id(indentId), parse(reasonSchema, body).reason) }; }

  @RequireAnyPermission("PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ", "PHARMACY_PURCHASE")
  @Get("procurement/orders")
  async orders(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.procurement.listOrders(ctx, parse(listSchema, q)) }; }

  @RequirePermissions("PURCHASE_ORDER")
  @Post("procurement/orders")
  async createOrder(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.procurement.createOrder(ctx, parse(orderSchema, body)) }; }

  @RequireAnyPermission("PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ", "PHARMACY_PURCHASE")
  @Get("procurement/orders/:id")
  async order(@Ctx() ctx: RequestContext, @Param("id") orderId: string) { return { data: await this.procurement.getOrder(ctx, id(orderId)) }; }

  @RequireAnyPermission("PURCHASE_ORDER", "PURCHASE_APPROVE")
  @Post("procurement/orders/:id/issue")
  @HttpCode(200)
  async issueOrder(@Ctx() ctx: RequestContext, @Param("id") orderId: string) { return { data: await this.procurement.issueOrder(ctx, id(orderId)) }; }

  @RequirePermissions("PURCHASE_APPROVE")
  @Post("procurement/orders/:id/approve")
  @HttpCode(200)
  async approveOrder(@Ctx() ctx: RequestContext, @Param("id") orderId: string) { return { data: await this.procurement.approveOrder(ctx, id(orderId)) }; }

  @RequirePermissions("PURCHASE_ORDER")
  @Post("procurement/orders/:id/cancel")
  @HttpCode(200)
  async cancelOrder(@Ctx() ctx: RequestContext, @Param("id") orderId: string, @Body() body: unknown) { return { data: await this.procurement.cancelOrder(ctx, id(orderId), parse(reasonSchema, body).reason) }; }

  @RequirePermissions("PURCHASE_ORDER")
  @Post("procurement/orders/:id/close")
  @HttpCode(200)
  async closeOrder(@Ctx() ctx: RequestContext, @Param("id") orderId: string, @Body() body: unknown) { return { data: await this.procurement.closeOrder(ctx, id(orderId), parse(reasonSchema, body).reason) }; }
}
