import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SettingsService } from "../settings/settings.service";
import { daysIn, statusFromPunches, summariseAttendance, type AttendanceKind } from "./payroll.domain";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-02");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30");
const text = (max: number) => z.string().trim().max(max);
const halves = z.number().min(0).max(366).multipleOf(0.5);

export const MARKABLE = ["PRESENT", "ABSENT", "HALF_DAY", "WEEKLY_OFF", "HOLIDAY"] as const;
export const markAttendanceSchema = z.object({
  date: day,
  entries: z.array(z.object({ employeeId: uuid, status: z.enum(MARKABLE), note: text(200).min(1).optional() }).strict()).min(1).max(300),
}).strict();
export const attendanceMonthSchema = z.object({ month }).strict();
export const leaveTypeSchema = z.object({ name: text(60).min(2), isPaid: z.boolean(), yearlyAllowance: halves.nullable(), carryForwardMax: halves.default(0) }).strict()
  .refine((v) => v.carryForwardMax === 0 || v.yearlyAllowance !== null, { path: ["carryForwardMax"], message: "Only a leave type with a yearly allowance can carry days forward" });
export const updateLeaveTypeSchema = z.object({ name: text(60).min(2), isPaid: z.boolean(), yearlyAllowance: halves.nullable(), carryForwardMax: halves, status: z.enum(["ACTIVE", "INACTIVE"]) }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");
export const leaveRequestSchema = z.object({ employeeId: uuid, leaveTypeId: uuid, fromDate: day, toDate: day, halfDay: z.boolean().default(false), reason: text(300).min(3).optional() }).strict();
export const myLeaveSchema = leaveRequestSchema.omit({ employeeId: true });
export const rejectLeaveSchema = z.object({ note: text(300).min(3) }).strict();
export const cancelLeaveSchema = z.object({ reason: text(300).min(3).optional() }).strict();
export const listLeaveSchema = z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(), employeeId: uuid.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const balanceQuerySchema = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() }).strict();
export const holidaysQuerySchema = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() }).strict();
export const holidaySchema = z.object({ date: day, name: text(80).min(2) }).strict();
export const importAttendanceSchema = z.object({
  rows: z.array(z.object({ employeeCode: text(30).min(2), date: day, timeIn: clock.optional(), timeOut: clock.optional() }).strict()).min(1).max(2000),
  fullDayHours: z.number().min(1).max(24), halfDayHours: z.number().min(0.5).max(24), apply: z.boolean(),
}).strict().refine((v) => v.halfDayHours < v.fullDayHours, { path: ["halfDayHours"], message: "Half-day hours must be less than full-day hours" });

/** Hospital time is India time (CLAUDE.md §43): "today" for attendance is the date in Asia/Kolkata. */
const todayIst = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string): Date => {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || iso(d) !== s) throw new DomainError("VALIDATION_FAILED", "Not a real date", 400, [{ path: "date", message: "Not a real date" }]);
  return d;
};
const monthOf = (d: Date) => iso(d).slice(0, 7);
const eachDay = (from: Date, to: Date): Date[] => { const out: Date[] = []; for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) out.push(new Date(t)); return out; };

/** Default leave types a hospital can start from; every number can be edited afterwards. They are suggestions, not law: the hospital's own leave policy decides. */
export const STANDARD_LEAVE_TYPES: { name: string; isPaid: boolean; yearlyAllowance: number | null }[] = [
  { name: "Casual leave", isPaid: true, yearlyAllowance: 12 }, { name: "Sick leave", isPaid: true, yearlyAllowance: 12 },
  { name: "Earned leave", isPaid: true, yearlyAllowance: 15 }, { name: "Leave without pay", isPaid: false, yearlyAllowance: null },
];

type AnyDb = PrismaService | Db;
type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: { employee: { select: { employeeCode: true; fullName: true; userId: true } }; leaveType: { select: { name: true; isPaid: true } } } }>;
const LEAVE_INCLUDE = { employee: { select: { employeeCode: true, fullName: true, userId: true } }, leaveType: { select: { name: true, isPaid: true } } } as const;
type OffDay = { kind: "WEEKLY_OFF" | "HOLIDAY"; name: string | null };

/**
 * Attendance and leave (docs/payroll.md). Attendance is marked day by day (or imported from a time clock); approved leave writes ON_LEAVE days; the monthly payroll
 * run turns absences, half days and unpaid leave into days of loss of pay. Weekly offs (a hospital setting) and public holidays (a calendar) need no marking.
 * A month that has a live payroll run is frozen: the officer cancels the draft run to correct it. All writes to a month take the same lock as starting that
 * month's run, so a run can never be built from a sheet that is still changing.
 */
@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  // ───── helpers ─────

  /** Waits for any payroll run being started for each month, then says which of the months already have a live run. */
  private async takeMonthLocks(tx: Db, ctx: RequestContext, months: string[]): Promise<Set<string>> {
    const live = new Set<string>();
    for (const m of [...new Set(months)].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:${ctx.tenantId}:${ctx.facilityId}:${m}`}, 0))`;
      const start = new Date(`${m}-01T00:00:00.000Z`);
      if (await tx.payrollRun.count({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, month: start, status: { not: "CANCELLED" } } }) > 0) live.add(m);
    }
    return live;
  }

  /** Same, but refuses when a month already has a live run. */
  private async lockMonths(tx: Db, ctx: RequestContext, months: string[]): Promise<void> {
    const live = await this.takeMonthLocks(tx, ctx, months);
    if (live.size > 0) throw new DomainError("PAYROLL_MONTH_LOCKED", `Payroll for ${[...live].sort()[0]} has already been started. Cancel the draft payroll run first if attendance must change`, 409);
  }

  private async employee(db: AnyDb, ctx: RequestContext, id: string) {
    const e = await db.employee.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, employeeCode: true, fullName: true, joinedOn: true, exitedOn: true, status: true, userId: true } });
    if (!e) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return e;
  }

  /** Weekly offs (from the hospital setting) and public holidays in a date range. A holiday wins over a weekly off. Days people did not mark are treated as these. */
  async calendarOffs(db: AnyDb, ctx: RequestContext, from: Date, to: Date): Promise<Map<string, OffDay>> {
    const [weekly, holidays] = await Promise.all([
      this.settings.get(db, ctx.tenantId, ctx.facilityId, "PAYROLL_WEEKLY_OFF_DAYS"),
      db.payrollHoliday.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, date: { gte: from, lte: to } }, select: { date: true, name: true } }),
    ]);
    const out = new Map<string, OffDay>();
    for (const d of eachDay(from, to)) if (weekly.includes(d.getUTCDay())) out.set(iso(d), { kind: "WEEKLY_OFF", name: null });
    for (const h of holidays) out.set(iso(h.date), { kind: "HOLIDAY", name: h.name });
    return out;
  }

  // ───── leave types ─────

  private typeView(t: { id: string; name: string; isPaid: boolean; yearlyAllowance: Prisma.Decimal | null; carryForwardMax: Prisma.Decimal; status: string }) {
    return { id: t.id, name: t.name, isPaid: t.isPaid, yearlyAllowance: t.yearlyAllowance ? t.yearlyAllowance.toString() : null, carryForwardMax: t.carryForwardMax.toString(), status: t.status };
  }

  async leaveTypes(ctx: RequestContext) {
    return (await this.prisma.leaveType.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, orderBy: { name: "asc" }, take: 100 })).map((t) => this.typeView(t));
  }

  async createLeaveType(ctx: RequestContext, input: z.infer<typeof leaveTypeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      try {
        const t = await tx.leaveType.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: input.name, isPaid: input.isPaid, yearlyAllowance: input.yearlyAllowance === null ? null : input.yearlyAllowance.toFixed(1), carryForwardMax: input.carryForwardMax.toFixed(1), createdById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_TYPE_CREATED", entityType: "LeaveType", entityId: t.id, metadata: { name: input.name, isPaid: input.isPaid, yearlyAllowance: input.yearlyAllowance, carryForwardMax: input.carryForwardMax } });
        return this.typeView(t);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "There is already a leave type with this name", 409);
        throw e;
      }
    });
  }

  /** Adds the standard leave types that are missing. Safe to repeat. */
  async createStandardLeaveTypes(ctx: RequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const have = new Set((await tx.leaveType.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { name: true } })).map((t) => t.name.toLowerCase()));
      const add = STANDARD_LEAVE_TYPES.filter((t) => !have.has(t.name.toLowerCase()));
      for (const t of add) {
        const row = await tx.leaveType.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, name: t.name, isPaid: t.isPaid, yearlyAllowance: t.yearlyAllowance === null ? null : t.yearlyAllowance.toFixed(1), createdById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_TYPE_CREATED", entityType: "LeaveType", entityId: row.id, metadata: { name: t.name, isPaid: t.isPaid, yearlyAllowance: t.yearlyAllowance, standard: true } });
      }
      return { added: add.length };
    });
  }

  async updateLeaveType(ctx: RequestContext, id: string, input: z.infer<typeof updateLeaveTypeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.leaveType.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      // Changing paid/unpaid after leave was taken would change the pay of months that are not yet run, so it is closed once the type has been used.
      if (input.isPaid !== undefined && input.isPaid !== t.isPaid && await tx.leaveRequest.count({ where: { tenantId: ctx.tenantId, leaveTypeId: id } }) > 0) {
        throw new DomainError("INVALID_STATE", "This leave type has already been used, so it cannot change between paid and unpaid. Add a new leave type instead", 409);
      }
      const allowance = input.yearlyAllowance !== undefined ? input.yearlyAllowance : t.yearlyAllowance ? Number(t.yearlyAllowance.toString()) : null;
      const carry = input.carryForwardMax ?? Number(t.carryForwardMax.toString());
      if (carry > 0 && allowance === null) throw new DomainError("VALIDATION_FAILED", "Only a leave type with a yearly allowance can carry days forward", 400, [{ path: "carryForwardMax", message: "Needs a yearly allowance" }]);
      try {
        const r = await tx.leaveType.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id } },
          data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.isPaid !== undefined ? { isPaid: input.isPaid } : {}), ...(input.status !== undefined ? { status: input.status } : {}), ...(input.yearlyAllowance !== undefined ? { yearlyAllowance: input.yearlyAllowance === null ? null : input.yearlyAllowance.toFixed(1) } : {}), ...(input.carryForwardMax !== undefined ? { carryForwardMax: input.carryForwardMax.toFixed(1) } : {}) },
        });
        await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_TYPE_UPDATED", entityType: "LeaveType", entityId: id, metadata: { fields: Object.keys(input) } });
        return this.typeView(r);
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "There is already a leave type with this name", 409);
        throw e;
      }
    });
  }

  // ───── holidays ─────

  async holidays(ctx: RequestContext, year?: number) {
    const y = year ?? Number(todayIst().slice(0, 4));
    const rows = await this.prisma.payrollHoliday.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, date: { gte: new Date(Date.UTC(y, 0, 1)), lte: new Date(Date.UTC(y, 11, 31)) } }, orderBy: { date: "asc" }, take: 100 });
    return rows.map((h) => ({ id: h.id, date: iso(h.date), name: h.name }));
  }

  async addHoliday(ctx: RequestContext, input: z.infer<typeof holidaySchema>) {
    const date = asDate(input.date);
    return this.prisma.$transaction(async (tx) => {
      await this.lockMonths(tx, ctx, [monthOf(date)]);
      try {
        const h = await tx.payrollHoliday.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, date, name: input.name, createdById: ctx.userId } });
        await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_HOLIDAY_ADDED", entityType: "PayrollHoliday", entityId: h.id, metadata: { date: input.date, name: input.name } });
        return { id: h.id, date: input.date, name: h.name };
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "There is already a holiday on this date", 409);
        throw e;
      }
    });
  }

  async removeHoliday(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const h = await tx.payrollHoliday.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!h) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.lockMonths(tx, ctx, [monthOf(h.date)]);
      await tx.payrollHoliday.delete({ where: { tenantId_id: { tenantId: ctx.tenantId, id } } });
      await this.audit.record(tx, actorOf(ctx), { action: "PAYROLL_HOLIDAY_REMOVED", entityType: "PayrollHoliday", entityId: id, metadata: { date: iso(h.date), name: h.name } });
      return { id, removed: true as const };
    });
  }

  // ───── attendance ─────

  /** Marks one day for many employees at once (the usual way: the attendance sheet for the day). Re-marking a day corrects it; each correction is audited. */
  async mark(ctx: RequestContext, input: z.infer<typeof markAttendanceSchema>) {
    const date = asDate(input.date);
    return this.prisma.$transaction(async (tx) => {
      await this.lockMonths(tx, ctx, [monthOf(date)]);
      const ids = [...new Set(input.entries.map((e) => e.employeeId))];
      if (ids.length !== input.entries.length) throw new DomainError("VALIDATION_FAILED", "An employee appears twice", 400, [{ path: "entries", message: "Duplicate employee" }]);
      const emps = await tx.employee.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, employeeCode: true, fullName: true, joinedOn: true, exitedOn: true } });
      if (emps.length !== ids.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const byId = new Map(emps.map((e) => [e.id, e]));
      const future = date.getTime() > asDate(todayIst()).getTime();
      const existing = new Map((await tx.attendanceDay.findMany({ where: { tenantId: ctx.tenantId, employeeId: { in: ids }, date } })).map((r) => [r.employeeId, r]));
      for (const e of input.entries) {
        const emp = byId.get(e.employeeId)!;
        if (date < emp.joinedOn || (emp.exitedOn && date > emp.exitedOn)) throw new DomainError("VALIDATION_FAILED", `${emp.fullName} was not employed on ${input.date}`, 400, [{ path: "entries", message: "Outside employment" }]);
        if (future && (e.status === "PRESENT" || e.status === "ABSENT" || e.status === "HALF_DAY")) throw new DomainError("VALIDATION_FAILED", "Attendance cannot be marked for a day that has not come yet", 400, [{ path: "date", message: "In the future" }]);
        if (existing.get(e.employeeId)?.status === "ON_LEAVE") throw new DomainError("CONFLICT", `${emp.fullName} is on approved leave that day. Cancel the leave first`, 409);
      }
      const changes: { employeeId: string; from: string | null; to: string }[] = [];
      for (const e of input.entries) {
        const before = existing.get(e.employeeId);
        const row = await tx.attendanceDay.upsert({
          where: { tenantId_employeeId_date: { tenantId: ctx.tenantId, employeeId: e.employeeId, date } },
          create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, employeeId: e.employeeId, date, status: e.status, note: e.note ?? null, markedById: ctx.userId },
          update: { status: e.status, note: e.note ?? null, markedById: ctx.userId },
          select: { id: true },
        });
        if (before && (before.status !== e.status || (before.note ?? null) !== (e.note ?? null))) {
          changes.push({ employeeId: e.employeeId, from: before.status, to: e.status });
          await this.audit.record(tx, actorOf(ctx), { action: "ATTENDANCE_CORRECTED", entityType: "AttendanceDay", entityId: row.id, metadata: { employeeId: e.employeeId, date: input.date, from: before.status, to: e.status } });
        }
      }
      await this.audit.record(tx, actorOf(ctx), { action: "ATTENDANCE_MARKED", entityType: "AttendanceDay", entityId: ctx.facilityId, metadata: { date: input.date, employees: input.entries.length, corrected: changes.length } });
      return { date: input.date, marked: input.entries.length, corrected: changes.length };
    });
  }

  /**
   * Reads a time-clock export (employee code, date, first punch in, last punch out) and turns each row into a mark by the hours worked, using the full-day and
   * half-day hours the officer chooses. With apply off it only reports what would happen. A row is rejected, never guessed at, when the code is unknown, the day
   * is outside employment or in the future, the month already has payroll, the same employee and day appear twice, or only one punch is given. Days of approved
   * leave and days already marked the same way are left alone.
   */
  async importPunches(ctx: RequestContext, input: z.infer<typeof importAttendanceSchema>) {
    type Out = { row: number; employeeCode: string; date: string; action: "MARK" | "SKIP" | "REJECT"; status?: "PRESENT" | "HALF_DAY" | "ABSENT"; hours?: number; reason?: string };
    return this.prisma.$transaction(async (tx) => {
      const dates = input.rows.flatMap((r) => { try { return [asDate(r.date)]; } catch { return []; } });
      const live = await this.takeMonthLocks(tx, ctx, dates.map((d) => monthOf(d)));
      const emps = new Map((await tx.employee.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", employeeCode: { in: [...new Set(input.rows.map((r) => r.employeeCode))] } }, select: { id: true, employeeCode: true, joinedOn: true, exitedOn: true } })).map((e) => [e.employeeCode, e]));
      const min = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : new Date(0), max = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : new Date(0);
      const existing = new Map((await tx.attendanceDay.findMany({ where: { tenantId: ctx.tenantId, employeeId: { in: [...emps.values()].map((e) => e.id) }, date: { gte: min, lte: max } } })).map((r) => [`${r.employeeId}|${iso(r.date)}`, r]));
      const today = asDate(todayIst());
      const seen = new Set<string>();
      const out: Out[] = [];
      input.rows.forEach((r, i) => {
        const base = { row: i + 1, employeeCode: r.employeeCode, date: r.date };
        const reject = (reason: string): void => { out.push({ ...base, action: "REJECT", reason }); };
        const emp = emps.get(r.employeeCode);
        let date: Date;
        try { date = asDate(r.date); } catch { reject("Not a real date"); return; }
        if (!emp) { reject("No active employee with this code"); return; }
        const key = `${emp.id}|${r.date}`;
        if (seen.has(key)) { reject("This employee and day appear twice"); return; }
        seen.add(key);
        if (!r.timeIn && !r.timeOut) { out.push({ ...base, action: "SKIP", reason: "No punches" }); return; }
        if (!r.timeIn || !r.timeOut) { reject("Needs both an in time and an out time"); return; }
        if (r.timeIn === r.timeOut) { reject("In and out times are the same"); return; }
        if (live.has(monthOf(date))) { reject("Payroll has already been started for that month"); return; }
        if (date < emp.joinedOn || (emp.exitedOn && date > emp.exitedOn)) { reject("Outside the employee's time at the hospital"); return; }
        if (date > today) { reject("A day that has not come yet"); return; }
        const was = existing.get(key);
        if (was?.status === "ON_LEAVE") { out.push({ ...base, action: "SKIP", reason: "On approved leave" }); return; }
        const { status, hours } = statusFromPunches(r.timeIn, r.timeOut, input.fullDayHours, input.halfDayHours);
        if (was?.status === status) { out.push({ ...base, action: "SKIP", status, hours, reason: "Already marked the same way" }); return; }
        out.push({ ...base, action: "MARK", status, hours: Math.round(hours * 100) / 100 });
      });
      const marks = out.filter((o) => o.action === "MARK");
      let corrected = 0;
      if (input.apply) {
        for (const o of marks) {
          const emp = emps.get(o.employeeCode)!;
          const date = asDate(o.date);
          const src = input.rows[o.row - 1]!;
          const note = `Time clock ${src.timeIn}-${src.timeOut}`;
          const before = existing.get(`${emp.id}|${o.date}`);
          const row = await tx.attendanceDay.upsert({
            where: { tenantId_employeeId_date: { tenantId: ctx.tenantId, employeeId: emp.id, date } },
            create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, employeeId: emp.id, date, status: o.status!, note, markedById: ctx.userId },
            update: { status: o.status!, note, markedById: ctx.userId }, select: { id: true },
          });
          if (before) { corrected++; await this.audit.record(tx, actorOf(ctx), { action: "ATTENDANCE_CORRECTED", entityType: "AttendanceDay", entityId: row.id, metadata: { employeeId: emp.id, date: o.date, from: before.status, to: o.status, source: "TIME_CLOCK" } }); }
        }
        await this.audit.record(tx, actorOf(ctx), { action: "ATTENDANCE_IMPORTED", entityType: "AttendanceDay", entityId: ctx.facilityId, metadata: { rows: input.rows.length, marked: marks.length, corrected, skipped: out.filter((o) => o.action === "SKIP").length, rejected: out.filter((o) => o.action === "REJECT").length, fullDayHours: input.fullDayHours, halfDayHours: input.halfDayHours } });
      }
      return { applied: input.apply, marked: marks.length, skipped: out.filter((o) => o.action === "SKIP").length, rejected: out.filter((o) => o.action === "REJECT").length, rows: out };
    });
  }

  /** The month's sheet: for each employee employed in the month, every day's mark (weekly offs and holidays filled in), the counts and the days of loss of pay that follow. */
  async sheet(ctx: RequestContext, input: z.infer<typeof attendanceMonthSchema>) {
    const start = new Date(`${input.month}-01T00:00:00.000Z`);
    const dim = daysIn(start);
    const end = new Date(start.getTime() + (dim - 1) * 86_400_000);
    const emps = await this.prisma.employee.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", joinedOn: { lte: end }, OR: [{ exitedOn: null }, { exitedOn: { gte: start } }] },
      orderBy: { employeeCode: "asc" }, take: 300, select: { id: true, employeeCode: true, fullName: true, designation: true, joinedOn: true, exitedOn: true },
    });
    const [rows, run, offs] = await Promise.all([
      this.prisma.attendanceDay.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, date: { gte: start, lte: end }, employeeId: { in: emps.map((e) => e.id) } }, select: { employeeId: true, date: true, status: true, note: true, halfDay: true, leaveRequest: { select: { leaveType: { select: { name: true, isPaid: true } } } } } }),
      this.prisma.payrollRun.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, month: start, status: { not: "CANCELLED" } }, select: { id: true, status: true } }),
      this.calendarOffs(this.prisma, ctx, start, end),
    ]);
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.employeeId, [...(by.get(r.employeeId) ?? []), r]);
    const dayList = eachDay(start, end);
    return {
      month: input.month, daysInMonth: dim, locked: !!run, runStatus: run?.status ?? null, offDays: [...offs].map(([date, o]) => ({ date, kind: o.kind, name: o.name })),
      employees: emps.map((e) => {
        const mine = (by.get(e.id) ?? []).filter((r) => r.date >= e.joinedOn && (!e.exitedOn || r.date <= e.exitedOn));
        const marks = new Map(mine.map((r) => [iso(r.date), r]));
        const employedDays = dayList.filter((d) => d >= e.joinedOn && (!e.exitedOn || d <= e.exitedOn));
        const virtual = employedDays.filter((d) => !marks.has(iso(d)) && offs.has(iso(d)));
        const s = summariseAttendance([
          ...mine.map((r) => ({ status: r.status as AttendanceKind, unpaidLeave: r.leaveRequest ? !r.leaveRequest.leaveType.isPaid : false, halfLeave: r.halfDay })),
          ...virtual.map((d) => ({ status: offs.get(iso(d))!.kind as AttendanceKind })),
        ]);
        return {
          id: e.id, code: e.employeeCode, name: e.fullName, designation: e.designation, employedDays: employedDays.length, unmarked: Math.max(0, employedDays.length - mine.length - virtual.length),
          days: dayList.map((d) => {
            const m = marks.get(iso(d));
            if (m) return { status: m.status, leave: m.leaveRequest?.leaveType.name ?? null, note: m.note, halfDay: m.halfDay, calendar: false };
            const off = offs.get(iso(d));
            return off && employedDays.some((x) => x.getTime() === d.getTime()) ? { status: off.kind, leave: null, note: off.name, halfDay: false, calendar: true } : null;
          }),
          present: s.present, absent: s.absent, halfDay: s.halfDay, paidLeave: s.paidLeave, unpaidLeave: s.unpaidLeave, weeklyOff: s.weeklyOff, holiday: s.holiday, lossOfPay: s.lossOfPay.toString(),
        };
      }),
    };
  }

  /** Used by the payroll run: the attendance of each employee for the month, as days of loss of pay and the number of employed days nobody marked. */
  async forPayroll(tx: Db, ctx: RequestContext, start: Date, end: Date, emps: { id: string; joinedOn: Date; exitedOn: Date | null }[]) {
    const [rows, offs] = await Promise.all([
      tx.attendanceDay.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, date: { gte: start, lte: end }, employeeId: { in: emps.map((e) => e.id) } }, select: { employeeId: true, date: true, status: true, halfDay: true, leaveRequest: { select: { leaveType: { select: { isPaid: true } } } } } }),
      this.calendarOffs(tx, ctx, start, end),
    ]);
    const out = new Map<string, { lossOfPay: Decimal; absent: number; halfDay: number; unpaidLeave: number; unmarked: number }>();
    for (const e of emps) {
      const mine = rows.filter((r) => r.employeeId === e.id && r.date >= e.joinedOn && (!e.exitedOn || r.date <= e.exitedOn));
      const s = summariseAttendance(mine.map((r) => ({ status: r.status as AttendanceKind, unpaidLeave: r.leaveRequest ? !r.leaveRequest.leaveType.isPaid : false, halfLeave: r.halfDay })));
      const marked = new Set(mine.map((r) => iso(r.date)));
      const employed = eachDay(start, end).filter((d) => d >= e.joinedOn && (!e.exitedOn || d <= e.exitedOn));
      const unmarked = employed.filter((d) => !marked.has(iso(d)) && !offs.has(iso(d))).length;
      out.set(e.id, { lossOfPay: s.lossOfPay, absent: s.absent, halfDay: s.halfDay, unpaidLeave: s.unpaidLeave, unmarked });
    }
    return out;
  }

  // ───── leave ─────

  private leaveView(r: LeaveRow) {
    return {
      id: r.id, employee: { id: r.employeeId, code: r.employee.employeeCode, name: r.employee.fullName }, leaveType: { id: r.leaveTypeId, name: r.leaveType.name, isPaid: r.leaveType.isPaid },
      fromDate: iso(r.fromDate), toDate: iso(r.toDate), halfDay: r.halfDay, days: r.days ? r.days.toString() : null, reason: r.reason, status: r.status, decisionNote: r.decisionNote, decidedAt: r.decidedAt, createdAt: r.createdAt,
    };
  }

  async leaveRequests(ctx: RequestContext, q: z.infer<typeof listLeaveSchema>) {
    const where: Prisma.LeaveRequestWhereInput = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}), ...(q.employeeId ? { employeeId: q.employeeId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({ where, orderBy: [{ fromDate: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: LEAVE_INCLUDE }),
      this.prisma.leaveRequest.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => this.leaveView(r)) };
  }

  /**
   * What each leave type allows this year, what was carried in from last year, what has been taken and what is left. Pending applications are not counted until
   * approved. Carry-forward: the unused part of last year's own allowance (not last year's carried days again), up to the type's limit, for an employee who joined
   * before this year began.
   */
  async balances(ctx: RequestContext, employeeId: string, year?: number) {
    await this.employee(this.prisma, ctx, employeeId);
    return this.balancesFor(this.prisma, ctx, employeeId, year ?? Number(todayIst().slice(0, 4)));
  }

  private async balancesFor(db: AnyDb, ctx: RequestContext, employeeId: string, year: number) {
    const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year, 11, 31));
    const prevFrom = new Date(Date.UTC(year - 1, 0, 1)), prevTo = new Date(Date.UTC(year - 1, 11, 31));
    const [emp, types, used, prevUsed] = await Promise.all([
      db.employee.findFirst({ where: { id: employeeId, tenantId: ctx.tenantId }, select: { joinedOn: true } }),
      db.leaveType.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, orderBy: { name: "asc" }, take: 100 }),
      db.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { tenantId: ctx.tenantId, employeeId, status: "APPROVED", fromDate: { gte: from, lte: to } }, _sum: { days: true } }),
      db.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { tenantId: ctx.tenantId, employeeId, status: "APPROVED", fromDate: { gte: prevFrom, lte: prevTo } }, _sum: { days: true } }),
    ]);
    const taken = new Map(used.map((u) => [u.leaveTypeId, new Decimal(u._sum.days?.toString() ?? "0")]));
    const takenBefore = new Map(prevUsed.map((u) => [u.leaveTypeId, new Decimal(u._sum.days?.toString() ?? "0")]));
    const joinedBeforeYear = !!emp && emp.joinedOn < from;
    return types.map((t) => {
      const u = taken.get(t.id) ?? new Decimal(0);
      const cap = new Decimal(t.carryForwardMax.toString());
      const carried = t.yearlyAllowance && joinedBeforeYear && cap.gt(0)
        ? Decimal.min(cap, Decimal.max(0, new Decimal(t.yearlyAllowance.toString()).minus(takenBefore.get(t.id) ?? 0)))
        : new Decimal(0);
      return {
        leaveTypeId: t.id, name: t.name, isPaid: t.isPaid, year, allowance: t.yearlyAllowance ? t.yearlyAllowance.toString() : null, carriedIn: carried.toString(), taken: u.toString(),
        remaining: t.yearlyAllowance ? new Decimal(t.yearlyAllowance.toString()).plus(carried).minus(u).toString() : null,
      };
    });
  }

  private async assertBalance(db: AnyDb, ctx: RequestContext, employeeId: string, typeId: string, allowance: Prisma.Decimal | null, year: number, days: number): Promise<void> {
    if (!allowance) return;
    const row = (await this.balancesFor(db, ctx, employeeId, year)).find((b) => b.leaveTypeId === typeId);
    const left = new Decimal(row?.remaining ?? allowance.toString());
    if (left.lt(days)) throw new DomainError("INSUFFICIENT_LEAVE_BALANCE", `Only ${left.toString()} day(s) of this leave are left this year`, 409);
  }

  /** An application for leave: by the employee for themselves, or entered by the payroll officer. Nothing changes in attendance until it is approved. */
  async createLeave(ctx: RequestContext, employeeId: string, input: Omit<z.infer<typeof leaveRequestSchema>, "employeeId">) {
    const from = asDate(input.fromDate), to = asDate(input.toDate);
    if (to < from) throw new DomainError("VALIDATION_FAILED", "The last day is before the first day", 400, [{ path: "toDate", message: "Before the first day" }]);
    if (from.getUTCFullYear() !== to.getUTCFullYear()) throw new DomainError("VALIDATION_FAILED", "Leave across two years must be applied for separately for each year", 400, [{ path: "toDate", message: "Different year" }]);
    if (input.halfDay && input.fromDate !== input.toDate) throw new DomainError("VALIDATION_FAILED", "Half-day leave is for a single day", 400, [{ path: "halfDay", message: "Choose one day" }]);
    return this.prisma.$transaction(async (tx) => {
      const emp = await this.employee(tx, ctx, employeeId);
      if (emp.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This employee is not active", 409);
      if (from < emp.joinedOn || (emp.exitedOn && to > emp.exitedOn)) throw new DomainError("VALIDATION_FAILED", "The leave must fall within the employee's time at the hospital", 400, [{ path: "fromDate", message: "Outside employment" }]);
      const type = await tx.leaveType.findFirst({ where: { id: input.leaveTypeId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
      if (!type) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.lockMonths(tx, ctx, eachDay(from, to).map((d) => monthOf(d)));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`leave:${ctx.tenantId}:${employeeId}`}, 0))`;
      if (await tx.leaveRequest.count({ where: { tenantId: ctx.tenantId, employeeId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } } }) > 0) {
        throw new DomainError("CONFLICT", "There is already leave applied for or approved on some of these days", 409);
      }
      const offs = await this.calendarOffs(tx, ctx, from, to);
      const estimate = input.halfDay ? 0.5 : eachDay(from, to).filter((d) => !offs.has(iso(d))).length;
      await this.assertBalance(tx, ctx, employeeId, type.id, type.yearlyAllowance, from.getUTCFullYear(), estimate);
      const r = await tx.leaveRequest.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, employeeId, leaveTypeId: type.id, fromDate: from, toDate: to, halfDay: input.halfDay, reason: input.reason ?? null, requestedById: ctx.userId }, include: LEAVE_INCLUDE });
      await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_REQUESTED", entityType: "LeaveRequest", entityId: r.id, metadata: { employeeId, leaveType: type.name, fromDate: input.fromDate, toDate: input.toDate, halfDay: input.halfDay } });
      return this.leaveView(r);
    });
  }

  /** The signed-in person's own employee record, when their user is linked to one at this facility. */
  async myEmployeeId(ctx: RequestContext): Promise<string | null> {
    return (await this.prisma.employee.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, status: "ACTIVE" }, select: { id: true } }))?.id ?? null;
  }

  async mine(ctx: RequestContext) {
    const id = await this.myEmployeeId(ctx);
    if (!id) return { linked: false as const, types: [], balances: [], requests: [] };
    const [types, balances, rows] = await Promise.all([
      this.leaveTypes(ctx),
      this.balancesFor(this.prisma, ctx, id, Number(todayIst().slice(0, 4))),
      this.prisma.leaveRequest.findMany({ where: { tenantId: ctx.tenantId, employeeId: id }, orderBy: { fromDate: "desc" }, take: 30, include: LEAVE_INCLUDE }),
    ]);
    return { linked: true as const, types: types.filter((t) => t.status === "ACTIVE"), balances, requests: rows.map((r) => this.leaveView(r)) };
  }

  private async lockLeave(tx: Db, ctx: RequestContext, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LeaveRequest" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return tx.leaveRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: { employee: { select: { employeeCode: true, fullName: true, userId: true, joinedOn: true } }, leaveType: { select: { name: true, isPaid: true, yearlyAllowance: true } } } });
  }

  /**
   * Approving puts the employee on leave for each day in the range, except weekly offs and holidays (marked or from the calendar), which are not counted. A half day
   * of leave marks the one day as half leave. Nobody approves their own leave.
   */
  async approve(ctx: RequestContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockLeave(tx, ctx, id);
      if (r.status !== "PENDING") throw new DomainError("INVALID_STATE", "Only leave that is waiting can be approved", 409);
      if (r.requestedById === ctx.userId || r.employee.userId === ctx.userId) throw new DomainError("FORBIDDEN", "Leave must be approved by someone other than the person it is for", 403);
      const range = eachDay(r.fromDate, r.toDate);
      await this.lockMonths(tx, ctx, range.map((d) => monthOf(d)));
      const [marked, calendar] = await Promise.all([
        tx.attendanceDay.findMany({ where: { tenantId: ctx.tenantId, employeeId: r.employeeId, date: { gte: r.fromDate, lte: r.toDate } }, select: { id: true, date: true, status: true } }),
        this.calendarOffs(tx, ctx, r.fromDate, r.toDate),
      ]);
      // A weekly off or holiday (marked by hand or from the calendar) is never leave, even if someone marked the person present that day.
      const off = new Set([...marked.filter((m) => m.status === "WEEKLY_OFF" || m.status === "HOLIDAY").map((m) => iso(m.date)), ...calendar.keys()]);
      const take = range.filter((d) => !off.has(iso(d)));
      if (take.length === 0) throw new DomainError("VALIDATION_FAILED", "Every day in this range is already a weekly off or holiday", 400, [{ path: "fromDate", message: "Nothing to approve" }]);
      const days = r.halfDay ? 0.5 : take.length;
      await this.assertBalance(tx, ctx, r.employeeId, r.leaveTypeId, r.leaveType.yearlyAllowance, r.fromDate.getUTCFullYear(), days);
      const overwritten = marked.filter((m) => !off.has(iso(m.date))).length;
      await tx.attendanceDay.deleteMany({ where: { tenantId: ctx.tenantId, employeeId: r.employeeId, date: { in: take } } });
      await tx.attendanceDay.createMany({ data: take.map((date) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, employeeId: r.employeeId, date, status: "ON_LEAVE" as const, halfDay: r.halfDay, leaveRequestId: r.id, markedById: ctx.userId })) });
      await tx.leaveRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "APPROVED", days: days.toFixed(1), decidedById: ctx.userId, decidedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_APPROVED", entityType: "LeaveRequest", entityId: id, metadata: { employeeId: r.employeeId, leaveType: r.leaveType.name, days, halfDay: r.halfDay, overwrittenMarks: overwritten } });
      return this.leaveView(await tx.leaveRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: LEAVE_INCLUDE }));
    });
  }

  async reject(ctx: RequestContext, id: string, input: z.infer<typeof rejectLeaveSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockLeave(tx, ctx, id);
      if (r.status !== "PENDING") throw new DomainError("INVALID_STATE", "Only leave that is waiting can be rejected", 409);
      if (r.requestedById === ctx.userId || r.employee.userId === ctx.userId) throw new DomainError("FORBIDDEN", "Leave must be decided by someone other than the person it is for", 403);
      await tx.leaveRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: input.note } });
      await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_REJECTED", entityType: "LeaveRequest", entityId: id, metadata: { employeeId: r.employeeId, leaveType: r.leaveType.name } });
      return this.leaveView(await tx.leaveRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: LEAVE_INCLUDE }));
    });
  }

  /** Cancels waiting or approved leave. Approved leave gives its days back (they become unmarked), which is refused once the month has a payroll run. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelLeaveSchema>, own: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockLeave(tx, ctx, id);
      if (own && r.employee.userId !== ctx.userId) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (r.status !== "PENDING" && r.status !== "APPROVED") throw new DomainError("INVALID_STATE", "This leave is already closed", 409);
      if (r.status === "APPROVED") {
        await this.lockMonths(tx, ctx, eachDay(r.fromDate, r.toDate).map((d) => monthOf(d)));
        await tx.attendanceDay.deleteMany({ where: { tenantId: ctx.tenantId, leaveRequestId: id } });
      }
      await tx.leaveRequest.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id } }, data: { status: "CANCELLED", ...(input.reason ? { decisionNote: input.reason } : {}) } });
      await this.audit.record(tx, actorOf(ctx), { action: "LEAVE_CANCELLED", entityType: "LeaveRequest", entityId: id, metadata: { employeeId: r.employeeId, wasApproved: r.status === "APPROVED", ...(input.reason ? { reason: input.reason } : {}) } });
      return this.leaveView(await tx.leaveRequest.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: LEAVE_INCLUDE }));
    });
  }
}
