import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { amount } from "../billing/money.schema";
import { NumberingService } from "../numbering/numbering.service";
import { computePay, daysIn } from "./payroll.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const text = (max: number) => z.string().trim().max(max);

export const employeeSchema = z.object({
  fullName: text(120).min(2), designation: text(80).min(2), department: text(80).optional(), joinedOn: day, userId: uuid.optional(),
  bankAccount: z.string().trim().regex(/^\d{6,20}$/, "Digits only").optional(), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Not a valid IFSC").optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "Not a valid PAN").optional(), uan: z.string().trim().regex(/^\d{12}$/, "12 digits").optional(), esiNumber: z.string().trim().regex(/^\d{10,17}$/, "Digits only").optional(),
}).strict();
export const updateEmployeeSchema = employeeSchema.omit({ joinedOn: true, userId: true }).partial().extend({ status: z.enum(["ACTIVE", "INACTIVE"]).optional(), exitedOn: day.nullable().optional() }).strict();
export const structureSchema = z.object({
  effectiveFrom: day, basic: amount({ positive: true }), hra: amount().default(new Decimal(0)), otherAllowance: amount().default(new Decimal(0)),
  pfApplicable: z.boolean().default(true), esiApplicable: z.boolean().default(true), ptApplicable: z.boolean().default(true),
}).strict();
export const createRunSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11") }).strict();
export const adjustSlipSchema = z.object({
  lopDays: z.number().min(0).max(31).multipleOf(0.5).optional(), bonus: amount().optional(), tds: amount().optional(), otherDeduction: amount().optional(), note: text(200).nullable().optional(),
}).strict();
export const paySchema = z.object({ paidOn: day, reference: z.string().trim().min(4).max(60).optional() }).strict();
export const cancelSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const listEmployeesSchema = z.object({ q: z.string().trim().min(2).max(60).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).strict();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const mask = (v: string | null) => (v ? `${"•".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : null);
const monthStart = (m: string) => new Date(`${m}-01T00:00:00.000Z`);
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

type SlipRow = Prisma.PayslipGetPayload<{ include: { employee: { select: { employeeCode: true; fullName: true; designation: true; department: true; bankAccount: true; pan: true; uan: true; esiNumber: true } } } }>;

/**
 * Payroll (docs/payroll.md). A monthly run makes one payslip per active employee from their salary structure; the preparer enters days of loss of pay, bonus,
 * TDS and other deductions on each draft payslip; a different person approves the run (which fixes every figure), and it is then marked paid. Figures are
 * calculated here, never taken from the screen.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService) {}

  // ───── employees and structures ─────

  private employeeView(e: { id: string; employeeCode: string; fullName: string; designation: string; department: string | null; joinedOn: Date; exitedOn: Date | null; bankAccount: string | null; ifsc: string | null; pan: string | null; uan: string | null; esiNumber: string | null; status: string; userId: string | null }) {
    return { id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, designation: e.designation, department: e.department, joinedOn: iso(e.joinedOn), exitedOn: e.exitedOn ? iso(e.exitedOn) : null, bankAccount: mask(e.bankAccount), ifsc: e.ifsc, pan: mask(e.pan), uan: e.uan, esiNumber: e.esiNumber, status: e.status, userId: e.userId };
  }

  async employees(ctx: RequestContext, q: z.infer<typeof listEmployeesSchema>) {
    const where: Prisma.EmployeeWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}), ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" } }, { employeeCode: { contains: q.q, mode: "insensitive" } }] } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({ where, orderBy: [{ employeeCode: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { structures: { orderBy: { effectiveFrom: "desc" }, take: 1 } } }),
      this.prisma.employee.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((e) => ({ ...this.employeeView(e), current: e.structures[0] ? this.structureView(e.structures[0]) : null })) };
  }

  private structureView(s: { id: string; effectiveFrom: Date; basic: Prisma.Decimal; hra: Prisma.Decimal; otherAllowance: Prisma.Decimal; pfApplicable: boolean; esiApplicable: boolean; ptApplicable: boolean }) {
    return { id: s.id, effectiveFrom: iso(s.effectiveFrom), basic: fmt(s.basic), hra: fmt(s.hra), otherAllowance: fmt(s.otherAllowance), gross: fmt(new Decimal(s.basic.toString()).plus(s.hra.toString()).plus(s.otherAllowance.toString())), pfApplicable: s.pfApplicable, esiApplicable: s.esiApplicable, ptApplicable: s.ptApplicable };
  }

  async structures(ctx: RequestContext, employeeId: string) {
    const e = await this.prisma.employee.findFirst({ where: { id: employeeId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return (await this.prisma.salaryStructure.findMany({ where: { tenantId: ctx.tenantId, employeeId }, orderBy: { effectiveFrom: "desc" }, take: 50 })).map((s) => this.structureView(s));
  }

  async addEmployee(ctx: RequestContext, input: z.infer<typeof employeeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      if (input.userId) {
        const u = await tx.user.findFirst({ where: { id: input.userId, tenantId: ctx.tenantId, isService: false }, select: { id: true } });
        if (!u) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      }
      const employeeCode = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "EMPLOYEE");
      try {
        const e = await tx.employee.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: input.userId ?? null, employeeCode, fullName: input.fullName, designation: input.designation, department: input.department ?? null, joinedOn: new Date(input.joinedOn), bankAccount: input.bankAccount ?? null, ifsc: input.ifsc ?? null, pan: input.pan ?? null, uan: input.uan ?? null, esiNumber: input.esiNumber ?? null, createdById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_EMPLOYEE_ADDED", entityType: "Employee", entityId: e.id, metadata: { employeeCode, designation: input.designation } });
        return this.employeeView(e);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002" || String((e as { message?: string }).message ?? "").includes("employee_one_per_user")) throw new DomainError("CONFLICT", "This user is already linked to an employee", 409);
        throw e;
      }
    });
  }

  async updateEmployee(ctx: RequestContext, id: string, input: z.infer<typeof updateEmployeeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.employee.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const { exitedOn, ...rest } = input;
      if (exitedOn && new Date(exitedOn) < e.joinedOn) throw new DomainError("VALIDATION_FAILED", "The last day is before the joining date", 400, [{ path: "exitedOn", message: "Before joining" }]);
      const r = await tx.employee.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { ...rest, ...(exitedOn !== undefined ? { exitedOn: exitedOn ? new Date(exitedOn) : null } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_EMPLOYEE_UPDATED", entityType: "Employee", entityId: id, metadata: { fields: Object.keys(input) } });
      return this.employeeView(r);
    });
  }

  /** A new salary structure from a date. The old ones stay; a payslip uses the latest one that started on or before the month's last day. */
  async setStructure(ctx: RequestContext, employeeId: string, input: z.infer<typeof structureSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.employee.findFirst({ where: { id: employeeId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, joinedOn: true } });
      if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (new Date(input.effectiveFrom) < e.joinedOn) throw new DomainError("VALIDATION_FAILED", "The pay cannot start before the joining date", 400, [{ path: "effectiveFrom", message: "Before joining" }]);
      try {
        const s = await tx.salaryStructure.create({ data: { tenantId: ctx.tenantId, employeeId, effectiveFrom: new Date(input.effectiveFrom), basic: input.basic.toFixed(2), hra: input.hra.toFixed(2), otherAllowance: input.otherAllowance.toFixed(2), pfApplicable: input.pfApplicable, esiApplicable: input.esiApplicable, ptApplicable: input.ptApplicable, createdById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_STRUCTURE_SET", entityType: "Employee", entityId: employeeId, metadata: { effectiveFrom: input.effectiveFrom, gross: fmt(input.basic.plus(input.hra).plus(input.otherAllowance)) } });
        return this.structureView(s);
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "There is already a salary structure from this date", 409);
        throw err;
      }
    });
  }

  // ───── runs ─────

  private runView(r: { id: string; month: Date; status: string; gross: Prisma.Decimal; deductions: Prisma.Decimal; net: Prisma.Decimal; employerCost: Prisma.Decimal; createdAt: Date; approvedAt: Date | null; paidAt: Date | null; paidOn: Date | null; payReference: string | null; cancelReason: string | null }, count?: number) {
    return { id: r.id, month: iso(r.month).slice(0, 7), status: r.status, gross: fmt(r.gross), deductions: fmt(r.deductions), net: fmt(r.net), employerCost: fmt(r.employerCost), createdAt: r.createdAt, approvedAt: r.approvedAt, paidAt: r.paidAt, paidOn: r.paidOn ? iso(r.paidOn) : null, payReference: r.payReference, cancelReason: r.cancelReason, ...(count !== undefined ? { payslips: count } : {}) };
  }

  async runs(ctx: RequestContext) {
    const rows = await this.prisma.payrollRun.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, orderBy: [{ month: "desc" }, { createdAt: "desc" }], take: 60, include: { _count: { select: { payslips: true } } } });
    return rows.map((r) => this.runView(r, r._count.payslips));
  }

  /** Starts the month: one payslip for every active employee who was employed in it and has a salary structure; the rest are listed as skipped. */
  async createRun(ctx: RequestContext, input: z.infer<typeof createRunSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:${ctx.tenantId}:${ctx.facilityId}:${input.month}`}, 0))`;
      const start = monthStart(input.month);
      const end = new Date(nextMonth(start).getTime() - 86_400_000);
      if (start > new Date()) throw new DomainError("VALIDATION_FAILED", "That month has not started yet", 400, [{ path: "month", message: "In the future" }]);
      if (await tx.payrollRun.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, month: start, status: { not: "CANCELLED" } } }) > 0) throw new DomainError("CONFLICT", "There is already a payroll run for this month", 409);
      const emps = await tx.employee.findMany({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", joinedOn: { lte: end }, OR: [{ exitedOn: null }, { exitedOn: { gte: start } }] },
        orderBy: { employeeCode: "asc" }, include: { structures: { where: { effectiveFrom: { lte: end } }, orderBy: { effectiveFrom: "desc" }, take: 1 } },
      });
      const run = await tx.payrollRun.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, month: start, createdById: ctx.userId }, select: { id: true } });
      const dim = daysIn(start);
      const skipped: { employeeCode: string; fullName: string; reason: string }[] = [];
      for (const e of emps) {
        const s = e.structures[0];
        if (!s) { skipped.push({ employeeCode: e.employeeCode, fullName: e.fullName, reason: "No salary structure" }); continue; }
        const before = e.joinedOn > start ? Math.round((e.joinedOn.getTime() - start.getTime()) / 86_400_000) : 0;
        const after = e.exitedOn && e.exitedOn < end ? Math.round((end.getTime() - e.exitedOn.getTime()) / 86_400_000) : 0;
        const c = computePay(s, { daysInMonth: dim, lopDays: before + after });
        await tx.payslip.create({ data: { tenantId: ctx.tenantId, runId: run.id, employeeId: e.id, structureId: s.id, daysInMonth: dim, lopDays: before + after, ...this.money(c) } });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_RUN_CREATED", entityType: "PayrollRun", entityId: run.id, metadata: { month: input.month, payslips: emps.length - skipped.length, skipped: skipped.length } });
      return { id: run.id, month: input.month, payslips: emps.length - skipped.length, skipped };
    });
  }

  private money(c: ReturnType<typeof computePay>) {
    const f = (d: Decimal) => d.toFixed(2);
    return { basic: f(c.basic), hra: f(c.hra), otherAllowance: f(c.otherAllowance), bonus: f(c.bonus), gross: f(c.gross), pfEmployee: f(c.pfEmployee), esiEmployee: f(c.esiEmployee), professionalTax: f(c.professionalTax), tds: f(c.tds), otherDeduction: f(c.otherDeduction), totalDeductions: f(c.totalDeductions), net: f(c.net), pfEmployer: f(c.pfEmployer), esiEmployer: f(c.esiEmployer) };
  }

  private slipView(p: SlipRow) {
    return {
      id: p.id, runId: p.runId, employee: { id: p.employeeId, code: p.employee.employeeCode, name: p.employee.fullName, designation: p.employee.designation, department: p.employee.department, bankAccount: mask(p.employee.bankAccount), pan: mask(p.employee.pan), uan: p.employee.uan, esiNumber: p.employee.esiNumber },
      daysInMonth: p.daysInMonth, lopDays: p.lopDays.toString(), basic: fmt(p.basic), hra: fmt(p.hra), otherAllowance: fmt(p.otherAllowance), bonus: fmt(p.bonus), gross: fmt(p.gross),
      pfEmployee: fmt(p.pfEmployee), esiEmployee: fmt(p.esiEmployee), professionalTax: fmt(p.professionalTax), tds: fmt(p.tds), otherDeduction: fmt(p.otherDeduction), totalDeductions: fmt(p.totalDeductions), net: fmt(p.net), pfEmployer: fmt(p.pfEmployer), esiEmployer: fmt(p.esiEmployer), note: p.note,
    };
  }

  private static readonly SLIP_INCLUDE = { employee: { select: { employeeCode: true, fullName: true, designation: true, department: true, bankAccount: true, pan: true, uan: true, esiNumber: true } } } as const;

  async run(ctx: RequestContext, id: string) {
    const r = await this.prisma.payrollRun.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { payslips: { orderBy: { employee: { employeeCode: "asc" } }, include: PayrollService.SLIP_INCLUDE } } });
    if (!r) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [r.createdById, ...(r.approvedById ? [r.approvedById] : []), ...(r.paidById ? [r.paidById] : [])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return { ...this.runView(r, r.payslips.length), preparedBy: users.get(r.createdById) ?? null, approvedBy: r.approvedById ? users.get(r.approvedById) ?? null : null, paidBy: r.paidById ? users.get(r.paidById) ?? null : null, slips: r.payslips.map((p) => this.slipView(p)) };
  }

  private async lockRun(tx: Db, ctx: RequestContext, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PayrollRun" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.payrollRun.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
  }

  /** Days of loss of pay, bonus, TDS and other deductions for one employee while the run is a draft; every figure is recalculated here. */
  async adjustSlip(ctx: RequestContext, runId: string, slipId: string, input: z.infer<typeof adjustSlipSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, ctx, runId);
      if (run.status !== "DRAFT") throw new DomainError("INVALID_STATE", "Only a draft payroll run can be changed", 409);
      const p = await tx.payslip.findFirst({ where: { id: slipId, tenantId: ctx.tenantId, runId }, include: { structure: true } });
      if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const lop = input.lopDays ?? Number(p.lopDays);
      if (lop > p.daysInMonth) throw new DomainError("VALIDATION_FAILED", `The month has only ${p.daysInMonth} days`, 400, [{ path: "lopDays", message: "More than the days in the month" }]);
      const c = computePay(p.structure, { daysInMonth: p.daysInMonth, lopDays: lop, bonus: input.bonus ?? p.bonus.toString(), tds: input.tds ?? p.tds.toString(), otherDeduction: input.otherDeduction ?? p.otherDeduction.toString() });
      if (c.net.lt(0)) throw new DomainError("VALIDATION_FAILED", "The deductions are more than the pay", 400, [{ path: "tds", message: "Net pay would be negative" }]);
      await tx.payslip.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: p.id } }, data: { lopDays: lop, ...this.money(c), ...(input.note !== undefined ? { note: input.note } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_SLIP_ADJUSTED", entityType: "Payslip", entityId: p.id, metadata: { runId, fields: Object.keys(input) } });
      return this.slipView(await tx.payslip.findFirstOrThrow({ where: { id: p.id, tenantId: ctx.tenantId }, include: PayrollService.SLIP_INCLUDE }));
    });
  }

  /** Approving fixes every figure. It must be someone other than the person who prepared the run. */
  async approve(ctx: RequestContext, runId: string) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, ctx, runId);
      if (run.status !== "DRAFT") throw new DomainError("INVALID_STATE", "Only a draft payroll run can be approved", 409);
      if (run.createdById === ctx.userId) throw new DomainError("FORBIDDEN", "A payroll run must be approved by someone other than the person who prepared it", 403);
      const slips = await tx.payslip.findMany({ where: { tenantId: ctx.tenantId, runId }, select: { gross: true, totalDeductions: true, net: true, pfEmployer: true, esiEmployer: true } });
      if (slips.length === 0) throw new DomainError("INVALID_STATE", "There are no payslips in this run", 409);
      const sum = (f: (s: (typeof slips)[number]) => Prisma.Decimal) => slips.reduce((a, s) => a.plus(f(s).toString()), new Decimal(0));
      const gross = sum((s) => s.gross), deductions = sum((s) => s.totalDeductions), net = sum((s) => s.net), employer = gross.plus(sum((s) => s.pfEmployer)).plus(sum((s) => s.esiEmployer));
      await tx.payrollRun.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: runId } }, data: { status: "APPROVED", gross: gross.toFixed(2), deductions: deductions.toFixed(2), net: net.toFixed(2), employerCost: employer.toFixed(2), approvedById: ctx.userId, approvedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_RUN_APPROVED", entityType: "PayrollRun", entityId: runId, metadata: { month: iso(run.month).slice(0, 7), payslips: slips.length, net: fmt(net) } });
      return { id: runId, status: "APPROVED" as const, gross: fmt(gross), deductions: fmt(deductions), net: fmt(net), employerCost: fmt(employer) };
    });
  }

  async pay(ctx: RequestContext, runId: string, input: z.infer<typeof paySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, ctx, runId);
      if (run.status !== "APPROVED") throw new DomainError("INVALID_STATE", run.status === "PAID" ? "This payroll run is already paid" : "A payroll run must be approved before it is paid", 409);
      if (new Date(input.paidOn) > new Date(Date.now() + 86_400_000)) throw new DomainError("VALIDATION_FAILED", "The payment date is in the future", 400, [{ path: "paidOn", message: "In the future" }]);
      await tx.payrollRun.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: runId } }, data: { status: "PAID", paidById: ctx.userId, paidAt: new Date(), paidOn: new Date(input.paidOn), payReference: input.reference ?? null } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_RUN_PAID", entityType: "PayrollRun", entityId: runId, metadata: { month: iso(run.month).slice(0, 7), net: fmt(run.net), paidOn: input.paidOn } });
      return { id: runId, status: "PAID" as const };
    });
  }

  /** A draft that was started by mistake is cancelled (with a reason) so the month is free again. */
  async cancel(ctx: RequestContext, runId: string, input: z.infer<typeof cancelSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const run = await this.lockRun(tx, ctx, runId);
      if (run.status !== "DRAFT") throw new DomainError("INVALID_STATE", "Only a draft payroll run can be cancelled", 409);
      await tx.payrollRun.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: runId } }, data: { status: "CANCELLED", cancelReason: input.reason } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_RUN_CANCELLED", entityType: "PayrollRun", entityId: runId, metadata: { month: iso(run.month).slice(0, 7), reason: input.reason } });
      return { id: runId, status: "CANCELLED" as const };
    });
  }

  // ───── payslips for the employee ─────

  /** The signed-in person's own payslips: only runs that have been approved. */
  async myPayslips(ctx: RequestContext) {
    const e = await this.prisma.employee.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId }, select: { id: true } });
    if (!e) return [];
    const rows = await this.prisma.payslip.findMany({ where: { tenantId: ctx.tenantId, employeeId: e.id, run: { status: { in: ["APPROVED", "PAID"] } } }, orderBy: { run: { month: "desc" } }, take: 36, include: { ...PayrollService.SLIP_INCLUDE, run: { select: { month: true, status: true } } } });
    return rows.map((p) => ({ ...this.slipView(p), month: iso(p.run.month).slice(0, 7), runStatus: p.run.status }));
  }

  /** One payslip for printing: anyone with payroll access, or the employee themselves once the run is approved. */
  async payslip(ctx: RequestContext, slipId: string) {
    const p = await this.prisma.payslip.findFirst({ where: { id: slipId, tenantId: ctx.tenantId, run: { facilityId: ctx.facilityId } }, include: { ...PayrollService.SLIP_INCLUDE, run: { select: { month: true, status: true, paidOn: true } }, employee: { select: { userId: true, employeeCode: true, fullName: true, designation: true, department: true, bankAccount: true, pan: true, uan: true, esiNumber: true } } } });
    if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const own = p.employee.userId === ctx.userId;
    if (!ctx.permissions.has("PAYROLL_READ") && !(own && p.run.status !== "DRAFT" && p.run.status !== "CANCELLED")) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { ...this.slipView(p), month: iso(p.run.month).slice(0, 7), runStatus: p.run.status, paidOn: p.run.paidOn ? iso(p.run.paidOn) : null };
  }
}
