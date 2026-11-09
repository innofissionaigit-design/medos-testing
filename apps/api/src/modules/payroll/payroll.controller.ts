import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { AnyAuthenticated, Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { addArrearsSchema, adjustSlipSchema, cancelSchema, createRunSchema, employeeSchema, listEmployeesSchema, paySchema, PayrollService, structureSchema, updateEmployeeSchema } from "./payroll.service";

/** Payroll (docs/payroll.md): employees and salary structures, the monthly run, approval and payment, and payslips. */
@Controller()
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @RequirePermissions("PAYROLL_READ")
  @Get("payroll/employees")
  async employees(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.payroll.employees(ctx, parse(listEmployeesSchema, query)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("payroll/employees")
  async addEmployee(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.payroll.addEmployee(ctx, parse(employeeSchema, body)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Patch("payroll/employees/:id")
  async updateEmployee(@Ctx() ctx: RequestContext, @Param("id") employeeId: string, @Body() body: unknown) { return { data: await this.payroll.updateEmployee(ctx, id(employeeId), parse(updateEmployeeSchema, body)) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("payroll/employees/:id/structures")
  async structures(@Ctx() ctx: RequestContext, @Param("id") employeeId: string) { return { data: await this.payroll.structures(ctx, id(employeeId)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("payroll/employees/:id/structures")
  async setStructure(@Ctx() ctx: RequestContext, @Param("id") employeeId: string, @Body() body: unknown) { return { data: await this.payroll.setStructure(ctx, id(employeeId), parse(structureSchema, body)) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("payroll/runs")
  async runs(@Ctx() ctx: RequestContext) { return { data: await this.payroll.runs(ctx) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("payroll/runs")
  async createRun(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.payroll.createRun(ctx, parse(createRunSchema, body)) }; }

  @AnyAuthenticated()
  @Get("payroll/my-payslips")
  async mine(@Ctx() ctx: RequestContext) { return { data: await this.payroll.myPayslips(ctx) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("payroll/runs/:id")
  async run(@Ctx() ctx: RequestContext, @Param("id") runId: string) { return { data: await this.payroll.run(ctx, id(runId)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Put("payroll/runs/:id/payslips/:slipId")
  async adjust(@Ctx() ctx: RequestContext, @Param("id") runId: string, @Param("slipId") slipId: string, @Body() body: unknown) { return { data: await this.payroll.adjustSlip(ctx, id(runId), id(slipId), parse(adjustSlipSchema, body)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Get("payroll/runs/:id/payslips/:slipId/arrears")
  async arrearsSuggestions(@Ctx() ctx: RequestContext, @Param("id") runId: string, @Param("slipId") slipId: string) { return { data: await this.payroll.arrearsSuggestions(ctx, id(runId), id(slipId)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("payroll/runs/:id/payslips/:slipId/arrears")
  @HttpCode(200)
  async addArrears(@Ctx() ctx: RequestContext, @Param("id") runId: string, @Param("slipId") slipId: string, @Body() body: unknown) { return { data: await this.payroll.addArrears(ctx, id(runId), id(slipId), parse(addArrearsSchema, body)) }; }

  @RequirePermissions("PAYROLL_APPROVE")
  @Post("payroll/runs/:id/approve")
  @HttpCode(200)
  async approve(@Ctx() ctx: RequestContext, @Param("id") runId: string) { return { data: await this.payroll.approve(ctx, id(runId)) }; }

  @RequirePermissions("PAYROLL_APPROVE")
  @Post("payroll/runs/:id/pay")
  @HttpCode(200)
  async pay(@Ctx() ctx: RequestContext, @Param("id") runId: string, @Body() body: unknown) { return { data: await this.payroll.pay(ctx, id(runId), parse(paySchema, body)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("payroll/runs/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") runId: string, @Body() body: unknown) { return { data: await this.payroll.cancel(ctx, id(runId), parse(cancelSchema, body)) }; }
}
