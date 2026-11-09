import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { AnyAuthenticated, Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import {
  AttendanceService, attendanceMonthSchema, balanceQuerySchema, cancelLeaveSchema, holidaySchema, holidaysQuerySchema, importAttendanceSchema, leaveRequestSchema, leaveTypeSchema, listLeaveSchema, markAttendanceSchema, myLeaveSchema, rejectLeaveSchema, updateLeaveTypeSchema,
} from "./attendance.service";

/** Attendance and leave (docs/payroll.md). Reading needs PAYROLL_READ; marking attendance and entering leave for others needs ATTENDANCE_MANAGE; deciding leave needs LEAVE_APPROVE. */
@Controller("payroll")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @RequirePermissions("PAYROLL_READ")
  @Get("leave-types")
  async leaveTypes(@Ctx() ctx: RequestContext) { return { data: await this.attendance.leaveTypes(ctx) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("leave-types")
  async createLeaveType(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.attendance.createLeaveType(ctx, parse(leaveTypeSchema, body)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("leave-types/standard")
  @HttpCode(200)
  async standardLeaveTypes(@Ctx() ctx: RequestContext) { return { data: await this.attendance.createStandardLeaveTypes(ctx) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Patch("leave-types/:id")
  async updateLeaveType(@Ctx() ctx: RequestContext, @Param("id") typeId: string, @Body() body: unknown) { return { data: await this.attendance.updateLeaveType(ctx, id(typeId), parse(updateLeaveTypeSchema, body)) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("attendance")
  async sheet(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.attendance.sheet(ctx, parse(attendanceMonthSchema, query)) }; }

  @RequirePermissions("ATTENDANCE_MANAGE")
  @Put("attendance")
  async mark(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.attendance.mark(ctx, parse(markAttendanceSchema, body)) }; }

  @RequirePermissions("ATTENDANCE_MANAGE")
  @Post("attendance/import")
  @HttpCode(200)
  async importPunches(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.attendance.importPunches(ctx, parse(importAttendanceSchema, body)) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("holidays")
  async holidays(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.attendance.holidays(ctx, parse(holidaysQuerySchema, query).year) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("holidays")
  async addHoliday(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.attendance.addHoliday(ctx, parse(holidaySchema, body)) }; }

  @RequirePermissions("PAYROLL_MANAGE")
  @Post("holidays/:id/remove")
  @HttpCode(200)
  async removeHoliday(@Ctx() ctx: RequestContext, @Param("id") holidayId: string) { return { data: await this.attendance.removeHoliday(ctx, id(holidayId)) }; }

  @RequirePermissions("PAYROLL_READ")
  @Get("leave-requests")
  async leaveRequests(@Ctx() ctx: RequestContext, @Query() query: unknown) { return { data: await this.attendance.leaveRequests(ctx, parse(listLeaveSchema, query)) }; }

  @RequirePermissions("ATTENDANCE_MANAGE")
  @Post("leave-requests")
  async createLeave(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const { employeeId, ...rest } = parse(leaveRequestSchema, body);
    return { data: await this.attendance.createLeave(ctx, employeeId, rest) };
  }

  @RequirePermissions("PAYROLL_READ")
  @Get("employees/:id/leave-balance")
  async balance(@Ctx() ctx: RequestContext, @Param("id") employeeId: string, @Query() query: unknown) { return { data: await this.attendance.balances(ctx, id(employeeId), parse(balanceQuerySchema, query).year) }; }

  @RequirePermissions("LEAVE_APPROVE")
  @Post("leave-requests/:id/approve")
  @HttpCode(200)
  async approve(@Ctx() ctx: RequestContext, @Param("id") leaveId: string) { return { data: await this.attendance.approve(ctx, id(leaveId)) }; }

  @RequirePermissions("LEAVE_APPROVE")
  @Post("leave-requests/:id/reject")
  @HttpCode(200)
  async reject(@Ctx() ctx: RequestContext, @Param("id") leaveId: string, @Body() body: unknown) { return { data: await this.attendance.reject(ctx, id(leaveId), parse(rejectLeaveSchema, body)) }; }

  @RequirePermissions("ATTENDANCE_MANAGE")
  @Post("leave-requests/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") leaveId: string, @Body() body: unknown) { return { data: await this.attendance.cancel(ctx, id(leaveId), parse(cancelLeaveSchema, body ?? {}), false) }; }

  // ───── the employee's own leave (any signed-in person whose user is linked to an employee) ─────

  @AnyAuthenticated()
  @Get("my-leave")
  async mine(@Ctx() ctx: RequestContext) { return { data: await this.attendance.mine(ctx) }; }

  @AnyAuthenticated()
  @Post("my-leave")
  async apply(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const employeeId = await this.attendance.myEmployeeId(ctx);
    if (!employeeId) throw new DomainError("NOT_FOUND", "Your login is not linked to an employee record. Ask the payroll officer", 404);
    return { data: await this.attendance.createLeave(ctx, employeeId, parse(myLeaveSchema, body)) };
  }

  @AnyAuthenticated()
  @Post("my-leave/:id/cancel")
  @HttpCode(200)
  async cancelMine(@Ctx() ctx: RequestContext, @Param("id") leaveId: string, @Body() body: unknown) { return { data: await this.attendance.cancel(ctx, id(leaveId), parse(cancelLeaveSchema, body ?? {}), true) }; }
}
