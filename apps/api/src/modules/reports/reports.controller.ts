import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, parse, RequireAnyPermission } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { exportLogSchema, expirySchema, outstandingSchema, rangeSchema, ReportsService } from "./reports.service";

/**
 * Operational reports only. All are read-only, facility-scoped from the session, and bounded (date ranges ≤ 93 days).
 * Each report needs REPORT_READ (every report) or the permission for its own area.
 */
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Called just before a report is saved as a file, so every export is on the audit trail. The report-specific permission is checked in the service. */
  @RequireAnyPermission("REPORT_READ", "REPORT_OPD", "REPORT_FINANCE", "REPORT_IPD", "REPORT_PHARMACY", "REPORT_MY_PRACTICE")
  @Post("export-log")
  async exportLog(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.reports.logExport(ctx, parse(exportLogSchema, body)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_OPD")
  @Get("opd/daily")
  async opdDaily(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdDaily(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_OPD")
  @Get("opd/by-doctor")
  async opdByDoctor(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdByDoctor(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_OPD")
  @Get("opd/by-department")
  async opdByDepartment(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdByDepartment(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("collections")
  async collections(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.collections(ctx, parse(rangeSchema, q)) }; }

  /** Registrations with their fee, bill, receipt and payment: for the Cashier, Manager and Administrator. */
  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("registrations")
  async registrations(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.registrations(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("booking-fee-skips")
  async bookingFeeSkips(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.bookingFeeSkips(ctx, parse(rangeSchema, q)) }; }

  /** Organisation view: all doctors, with the hospital's and the doctors' shares. */
  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("bookings/by-doctor")
  async bookingsByDoctor(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.bookingsByDoctor(ctx, parse(rangeSchema, q)) }; }

  /** A doctor's own bookings and earnings. Only the signed-in doctor's own numbers, whoever asks. */
  @RequireAnyPermission("REPORT_MY_PRACTICE")
  @Get("bookings/my")
  async myBookings(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.myBookings(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("cashier-shifts")
  async shifts(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.shifts(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_FINANCE")
  @Get("outstanding-invoices")
  async outstanding(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.outstanding(ctx, parse(outstandingSchema, q)) }; }

  @Feature("IPD_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY", "REPORT_FINANCE")
  @Get("pharmacy/consumption-cost")
  async consumptionCost(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.consumptionCost(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_IPD")
  @Get("ipd/current-admissions")
  async currentAdmissions(@Ctx() ctx: RequestContext) { return { data: await this.reports.currentAdmissions(ctx) }; }

  @Feature("IPD_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_IPD")
  @Get("ipd/discharge-turnaround")
  async dischargeTurnaround(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.dischargeTurnaround(ctx, parse(rangeSchema, q)) }; }

  @RequireAnyPermission("REPORT_READ", "REPORT_IPD")
  @Get("ipd/admissions-discharges")
  async admissionsAndDischarges(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.admissionsAndDischarges(ctx, parse(rangeSchema, q)) }; }

  @Feature("IPD_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_IPD")
  @Get("ipd/bed-occupancy")
  async bedOccupancy(@Ctx() ctx: RequestContext) { return { data: await this.reports.bedOccupancy(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY")
  @Get("pharmacy/sales")
  async pharmacySales(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.pharmacySales(ctx, parse(rangeSchema, q)) }; }

  @Feature("PHARMACY_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY")
  @Get("pharmacy/stock-movement")
  async stockMovement(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.stockMovement(ctx, parse(rangeSchema, q)) }; }

  @Feature("PHARMACY_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY")
  @Get("pharmacy/stock")
  async currentStock(@Ctx() ctx: RequestContext) { return { data: await this.reports.currentStock(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY")
  @Get("pharmacy/low-stock")
  async lowStock(@Ctx() ctx: RequestContext) { return { data: await this.reports.lowStock(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequireAnyPermission("REPORT_READ", "REPORT_PHARMACY")
  @Get("pharmacy/near-expiry")
  async nearExpiry(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.nearExpiry(ctx, parse(expirySchema, q)) }; }
}
