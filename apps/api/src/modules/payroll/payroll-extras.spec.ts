import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@medos/shared";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";
import { computePay, DEFAULT_RATES, ratesFromSetting, statusFromPunches, summariseAttendance } from "./payroll.domain";

type User = { id: string; token: string };
const f = (v: Decimal) => v.toFixed(2);
const FLAT = { basic: "31000", hra: "0", otherAllowance: "0", pfApplicable: false, esiApplicable: false, ptApplicable: false };

describe("payroll extras: the calculations", () => {
  it("arrears are added to gross but do not change provident fund, ESI or professional tax", () => {
    const base = computePay({ basic: 12000, hra: 3000, otherAllowance: 0, pfApplicable: true, esiApplicable: true, ptApplicable: true }, { daysInMonth: 30, lopDays: 0 });
    const withArrears = computePay({ basic: 12000, hra: 3000, otherAllowance: 0, pfApplicable: true, esiApplicable: true, ptApplicable: true }, { daysInMonth: 30, lopDays: 0, arrears: "9000" });
    assert.deepEqual([f(withArrears.gross), f(withArrears.arrears), f(withArrears.pfEmployee), f(withArrears.esiEmployee), f(withArrears.professionalTax)], ["24000.00", "9000.00", f(base.pfEmployee), f(base.esiEmployee), f(base.professionalTax)]);
    assert.equal(f(withArrears.net), f(base.net.plus(9000)));
  });
  it("the rates come from the hospital's setting", () => {
    const own = ratesFromSetting({ pfWageCeiling: 20000, pfRate: 0.1, esiGrossCeiling: 25000, esiEmployeeRate: 0.01, esiEmployerRate: 0.03, ptSlabs: [{ upTo: 12000, tax: 0 }, { upTo: 30000, tax: 100 }], ptTop: 250 });
    const c = computePay({ basic: 18000, hra: 4000, otherAllowance: 0, pfApplicable: true, esiApplicable: true, ptApplicable: true }, { daysInMonth: 30, lopDays: 0 }, own);
    assert.deepEqual([f(c.pfEmployee), f(c.esiEmployee), f(c.professionalTax)], ["1800.00", "220.00", "100.00"]);
    const d = computePay({ basic: 18000, hra: 4000, otherAllowance: 0, pfApplicable: true, esiApplicable: true, ptApplicable: true }, { daysInMonth: 30, lopDays: 0 }, DEFAULT_RATES);
    assert.deepEqual([f(d.pfEmployee), f(d.esiEmployee), f(d.professionalTax)], ["1800.00", "0.00", "130.00"], "the defaults are unchanged");
  });
  it("half a day of unpaid leave costs half a day, paid half leave costs nothing", () => {
    const s = summariseAttendance([{ status: "ON_LEAVE", unpaidLeave: true, halfLeave: true }, { status: "ON_LEAVE", unpaidLeave: false, halfLeave: true }, { status: "ON_LEAVE", unpaidLeave: true }]);
    assert.deepEqual([s.unpaidLeave, s.paidLeave, s.lossOfPay.toString()], [1.5, 0.5, "1.5"]);
  });
  it("time-clock hours decide present, half day or absent; a shift past midnight counts to the next morning", () => {
    assert.deepEqual(statusFromPunches("09:00", "17:30", 8, 4), { status: "PRESENT", hours: 8.5 });
    assert.equal(statusFromPunches("09:00", "13:30", 8, 4).status, "HALF_DAY");
    assert.equal(statusFromPunches("09:00", "10:00", 8, 4).status, "ABSENT");
    assert.deepEqual(statusFromPunches("21:00", "06:00", 8, 4), { status: "PRESENT", hours: 9 });
    assert.equal(statusFromPunches("09:00", "17:00", 8, 4).status, "PRESENT", "exactly the full-day hours counts");
  });
});

describe("payroll extras: half-day leave, carry-forward, holidays, time-clock import and arrears", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let officer: User; let approver: User; let nurse: User; let bOfficer: User;
  let casual: string; let unpaid: string;

  const employee = async (body: Record<string, unknown> = {}, pay: Record<string, unknown> | null = FLAT) => {
    const e = await t.api("post", "/payroll/employees", officer.token).send({ fullName: "Test Person", designation: "Staff nurse", joinedOn: "2024-01-01", ...body });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    if (pay) assert.equal((await t.api("post", `/payroll/employees/${e.body.data.id}/structures`, officer.token).send({ effectiveFrom: (body.joinedOn as string | undefined) ?? "2024-01-01", ...pay })).status, 201);
    return e.body.data as { id: string; employeeCode: string };
  };
  const mark = (date: string, entries: { employeeId: string; status: string }[], tok = officer.token) => t.api("put", "/payroll/attendance", tok).send({ date, entries });
  const apply = (employeeId: string, leaveTypeId: string, fromDate: string, toDate: string, extra: Record<string, unknown> = {}) => t.api("post", "/payroll/leave-requests", officer.token).send({ employeeId, leaveTypeId, fromDate, toDate, ...extra });
  const decide = (id: string, what: "approve" | "reject" | "cancel", body: Record<string, unknown> = {}, tok = approver.token) => t.api("post", `/payroll/leave-requests/${id}/${what}`, tok).send(body);
  const sheet = async (m: string) => (await t.api("get", `/payroll/attendance?month=${m}`, officer.token)).body.data as { employees: { id: string; unmarked: number; lossOfPay: string; holiday: number; weeklyOff: number; unpaidLeave: number; days: ({ status: string; halfDay: boolean; calendar: boolean } | null)[] }[] };
  const balances = async (employeeId: string, year: number) => (await t.api("get", `/payroll/employees/${employeeId}/leave-balance?year=${year}`, officer.token)).body.data as { leaveTypeId: string; name: string; allowance: string | null; carriedIn: string; taken: string; remaining: string | null }[];
  const startRun = (m: string) => t.api("post", "/payroll/runs", officer.token).send({ month: m });
  const cancelRun = (id: string) => t.api("post", `/payroll/runs/${id}/cancel`, officer.token).send({ reason: "Test finished, freeing the month" });
  const getRun = async (id: string) => (await t.api("get", `/payroll/runs/${id}`, officer.token)).body.data as { slips: { id: string; employee: { code: string }; lopDays: string; basic: string; gross: string; net: string; arrears: string; arrearsNote: string | null; pfEmployee: string; note: string | null }[] };
  const setting = (k: string, value: unknown) => t.api("put", `/settings/${k}`, approver.token).send({ value });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("pex-a"); b = await t.makeTenant("pex-b");
    officer = await t.makeUser(a, ["PAYROLL_OFFICER"]); approver = await t.makeUser(a, ["ADMINISTRATOR"]); nurse = await t.makeUser(a, ["NURSE"]);
    bOfficer = await t.makeUser(b, ["PAYROLL_OFFICER"]);
    assert.equal((await t.api("post", "/payroll/leave-types/standard", officer.token)).status, 200);
    const all = (await t.api("get", "/payroll/leave-types", officer.token)).body.data as { id: string; name: string }[];
    casual = all.find((x) => x.name === "Casual leave")!.id; unpaid = all.find((x) => x.name === "Leave without pay")!.id;
  });
  after(async () => { await t.close(); });

  it("half-day leave: one day only; counts half; unpaid half costs half a day of pay; the nature of the leave cannot be changed afterwards", async () => {
    const e = await employee({ fullName: "Half Day" });
    assert.equal((await apply(e.id, casual, "2025-05-12", "2025-05-13", { halfDay: true })).status, 400, "half-day leave is for a single day");
    const u = await apply(e.id, unpaid, "2025-05-12", "2025-05-12", { halfDay: true });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    assert.equal(u.body.data.halfDay, true);
    const p = await apply(e.id, casual, "2025-05-13", "2025-05-13", { halfDay: true });
    const range = await apply(e.id, casual, "2025-05-20", "2025-05-22");
    assert.equal((await decide(u.body.data.id, "approve")).body.data.days, "0.5");
    assert.equal((await decide(p.body.data.id, "approve")).body.data.days, "0.5");
    const bal = (await balances(e.id, 2025)).find((x) => x.leaveTypeId === casual)!;
    assert.deepEqual([bal.taken, bal.remaining], ["0.5", "11.5"]);
    const s = (await sheet("2025-05")).employees.find((x) => x.id === e.id)!;
    assert.deepEqual([s.days[11]?.status, s.days[11]?.halfDay, s.lossOfPay, s.unpaidLeave], ["ON_LEAVE", true, "0.5", 0.5], "only the unpaid half counts as loss of pay");

    const run = await startRun("2025-05");
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const slip = (await getRun(run.body.data.id)).slips.find((x) => x.employee.code === e.employeeCode)!;
    assert.deepEqual([slip.lopDays, slip.basic, slip.note], ["0.5", "30500.00", "From attendance: 0.5 unpaid leave"]);
    assert.equal((await cancelRun(run.body.data.id)).status, 200);

    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET "halfDay" = true WHERE id = '${range.body.data.id}'::uuid`), /cannot change its person, type or dates/);
    await mark("2025-05-26", [{ employeeId: e.id, status: "PRESENT" }]);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AttendanceDay" SET "halfDay" = true WHERE "employeeId" = '${e.id}'::uuid AND date = '2025-05-26'`), /check/i);
  });

  it("carry-forward: the unused part of last year's own allowance, up to the limit, for someone who was there last year", async () => {
    const bad = await t.api("post", "/payroll/leave-types", officer.token).send({ name: "Carry no limit", isPaid: false, yearlyAllowance: null, carryForwardMax: 3 });
    assert.equal(bad.status, 400, "no allowance, nothing to carry");
    const type = (await t.api("post", "/payroll/leave-types", officer.token).send({ name: "Earned CF", isPaid: true, yearlyAllowance: 10, carryForwardMax: 4 })).body.data as { id: string };
    assert.equal((await t.api("patch", `/payroll/leave-types/${unpaid}`, officer.token).send({ carryForwardMax: 2 })).status, 400);
    const old = await employee({ fullName: "Old Hand" });
    const fresh = await employee({ fullName: "New Joiner", joinedOn: "2025-01-10" });
    const taken = await apply(old.id, type.id, "2024-03-04", "2024-03-06");
    assert.equal((await decide(taken.body.data.id, "approve")).body.data.days, "3");
    const y24 = (await balances(old.id, 2024)).find((x) => x.leaveTypeId === type.id)!;
    assert.deepEqual([y24.carriedIn, y24.remaining], ["0", "7"], "nothing carries into the year they joined");
    const y25 = (await balances(old.id, 2025)).find((x) => x.leaveTypeId === type.id)!;
    assert.deepEqual([y25.carriedIn, y25.remaining], ["4", "14"], "7 unused, limit 4");
    assert.deepEqual([(await balances(fresh.id, 2025)).find((x) => x.leaveTypeId === type.id)!.carriedIn], ["0"], "joined in 2025: nothing to carry");
    const tooMany = await apply(old.id, type.id, "2025-06-02", "2025-06-16");
    assert.deepEqual([tooMany.status, tooMany.body.error.code], [409, "INSUFFICIENT_LEAVE_BALANCE"], "15 days against 14");
    assert.equal((await apply(old.id, type.id, "2025-06-02", "2025-06-15")).status, 201);
    assert.equal((await t.api("patch", `/payroll/leave-types/${type.id}`, officer.token).send({ carryForwardMax: 6 })).status, 200);
    assert.equal((await balances(old.id, 2025)).find((x) => x.leaveTypeId === type.id)!.carriedIn, "6");
  });

  it("holidays and weekly offs: need no marking, are not charged, are skipped by leave, and are frozen with the month", async () => {
    assert.equal((await setting("PAYROLL_WEEKLY_OFF_DAYS", [0])).status, 200);
    const h = await t.api("post", "/payroll/holidays", officer.token).send({ date: "2024-10-02", name: "Gandhi Jayanti" });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal((await t.api("post", "/payroll/holidays", officer.token).send({ date: "2024-10-02", name: "Again" })).status, 409);
    assert.equal((await t.api("post", "/payroll/holidays", approver.token).send({ date: "2024-10-12", name: "Not mine" })).status, 403, "the approver does not keep the calendar");
    assert.equal((await t.api("post", "/payroll/holidays", nurse.token).send({ date: "2024-10-12", name: "Not mine" })).status, 403);
    assert.equal((await t.api("post", "/payroll/holidays", officer.token).send({ date: "2024-02-30", name: "Nope" })).status, 400);
    assert.deepEqual((await t.api("get", "/payroll/holidays?year=2024", officer.token)).body.data.map((x: { date: string }) => x.date), ["2024-10-02"]);
    assert.deepEqual((await t.api("get", "/payroll/holidays?year=2024", bOfficer.token)).body.data, [], "another hospital has its own calendar");
    assert.equal((await t.api("post", `/payroll/holidays/${h.body.data.id}/remove`, bOfficer.token)).status, 404);

    const e = await employee({ fullName: "Calendar Worker" });
    const s0 = (await sheet("2024-10")).employees.find((x) => x.id === e.id)!;
    assert.deepEqual([s0.days[1]?.status, s0.days[1]?.calendar, s0.days[5]?.status, s0.holiday, s0.weeklyOff, s0.unmarked], ["HOLIDAY", true, "WEEKLY_OFF", 1, 4, 26], "31 days less four Sundays and the holiday");
    await mark("2024-10-03", [{ employeeId: e.id, status: "PRESENT" }]);
    const lv = await apply(e.id, casual, "2024-10-01", "2024-10-07");
    const ok = await decide(lv.body.data.id, "approve");
    assert.equal(ok.body.data.days, "5", "seven days less the holiday and the Sunday");
    assert.equal((await mark("2024-10-02", [{ employeeId: e.id, status: "PRESENT" }])).status, 200, "working on a holiday can be recorded");

    const run = await startRun("2024-10");
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.ok(run.body.data.incomplete.some((x: { employeeCode: string; unmarkedDays: number }) => x.employeeCode === e.employeeCode && x.unmarkedDays === 21), JSON.stringify(run.body.data.incomplete));
    const slip = (await getRun(run.body.data.id)).slips.find((x) => x.employee.code === e.employeeCode)!;
    assert.equal(slip.lopDays, "0", "offs and holidays cost nothing");
    const locked = await t.api("post", "/payroll/holidays", officer.token).send({ date: "2024-10-15", name: "Local fair" });
    assert.deepEqual([locked.status, locked.body.error.code], [409, "PAYROLL_MONTH_LOCKED"]);
    assert.equal((await t.api("post", `/payroll/holidays/${h.body.data.id}/remove`, officer.token)).body.error.code, "PAYROLL_MONTH_LOCKED");
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PayrollHoliday" WHERE id = '${h.body.data.id}'::uuid`), /cannot change/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PayrollHoliday" SET name = 'Edited' WHERE id = '${h.body.data.id}'::uuid`), /cannot be edited/);
    assert.equal((await cancelRun(run.body.data.id)).status, 200);
    assert.equal((await t.api("post", `/payroll/holidays/${h.body.data.id}/remove`, officer.token)).status, 200);
    assert.deepEqual(await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: h.body.data.id }, select: { action: true }, orderBy: { createdAt: "asc" } }), [{ action: "PAYROLL_HOLIDAY_ADDED" }, { action: "PAYROLL_HOLIDAY_REMOVED" }]);
    assert.equal((await setting("PAYROLL_WEEKLY_OFF_DAYS", [7])).status, 400, "day numbers are 0 to 6");
    assert.equal((await setting("PAYROLL_WEEKLY_OFF_DAYS", [])).status, 200);
  });

  it("time-clock import: hours decide the mark; preview writes nothing; bad rows are rejected with a reason, never guessed at; repeating changes nothing", async () => {
    const i1 = await employee({ fullName: "Clock One" }); const i2 = await employee({ fullName: "Clock Two" }); const i3 = await employee({ fullName: "Clock Three", joinedOn: "2024-02-01" }); const i4 = await employee({ fullName: "Clock Four" });
    const lv = await apply(i4.id, casual, "2024-09-09", "2024-09-09");
    assert.equal((await decide(lv.body.data.id, "approve")).status, 200);
    const future = new Date(Date.now() + 19_800_000 + 5 * 86_400_000).toISOString().slice(0, 10);
    const rows = [
      { employeeCode: i1.employeeCode, date: "2024-09-02", timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i1.employeeCode, date: "2024-09-03", timeIn: "09:00", timeOut: "13:30" },
      { employeeCode: i1.employeeCode, date: "2024-09-04", timeIn: "09:00", timeOut: "10:00" },
      { employeeCode: i2.employeeCode, date: "2024-09-02", timeIn: "21:00", timeOut: "06:00" },
      { employeeCode: i2.employeeCode, date: "2024-09-03" },
      { employeeCode: i2.employeeCode, date: "2024-09-04", timeIn: "09:00" },
      { employeeCode: "EMP-9999", date: "2024-09-02", timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i1.employeeCode, date: "2024-09-02", timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i3.employeeCode, date: future, timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i3.employeeCode, date: "2024-01-15", timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i4.employeeCode, date: "2024-09-09", timeIn: "09:00", timeOut: "17:30" },
      { employeeCode: i1.employeeCode, date: "2024-09-05", timeIn: "09:00", timeOut: "09:00" },
    ];
    const imp = (body: Record<string, unknown>, tok = officer.token) => t.api("post", "/payroll/attendance/import", tok).send({ fullDayHours: 8, halfDayHours: 4, ...body });
    assert.equal((await imp({ rows, apply: false }, approver.token)).status, 403, "the approver does not keep the attendance sheet");
    assert.equal((await imp({ rows, apply: false }, nurse.token)).status, 403);
    assert.equal((await imp({ rows, apply: false, fullDayHours: 4 })).status, 400, "half-day hours must be less than full-day hours");
    assert.equal((await imp({ rows: [], apply: false })).status, 400);
    assert.equal((await imp({ rows: [{ employeeCode: i1.employeeCode, date: "2024-09-02", timeIn: "9am", timeOut: "5pm" }], apply: false })).status, 400);

    const preview = await imp({ rows, apply: false });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual([preview.body.data.applied, preview.body.data.marked, preview.body.data.skipped, preview.body.data.rejected], [false, 4, 2, 6]);
    const out = preview.body.data.rows as { row: number; action: string; status?: string; reason?: string }[];
    assert.deepEqual(out.slice(0, 4).map((x) => [x.action, x.status]), [["MARK", "PRESENT"], ["MARK", "HALF_DAY"], ["MARK", "ABSENT"], ["MARK", "PRESENT"]]);
    assert.deepEqual(out.slice(4).map((x) => x.reason), ["No punches", "Needs both an in time and an out time", "No active employee with this code", "This employee and day appear twice", "A day that has not come yet", "Outside the employee's time at the hospital", "On approved leave", "In and out times are the same"]);
    assert.equal(await t.prisma.attendanceDay.count({ where: { tenantId: a.tenantId, employeeId: i1.id } }), 0, "a preview writes nothing");

    const done = await imp({ rows, apply: true });
    assert.deepEqual([done.body.data.applied, done.body.data.marked], [true, 4]);
    const written = await t.prisma.attendanceDay.findMany({ where: { tenantId: a.tenantId, employeeId: { in: [i1.id, i2.id] } }, orderBy: [{ employeeId: "asc" }, { date: "asc" }] });
    assert.equal(written.length, 4);
    assert.equal(written.find((x) => x.employeeId === i1.id && x.date.toISOString().slice(0, 10) === "2024-09-03")!.status, "HALF_DAY");
    assert.equal(written.find((x) => x.employeeId === i1.id && x.date.toISOString().slice(0, 10) === "2024-09-02")!.note, "Time clock 09:00-17:30");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "ATTENDANCE_IMPORTED" } }), 1);

    const again = await imp({ rows, apply: true });
    assert.deepEqual([again.body.data.marked, again.body.data.skipped], [0, 6], "the same file again changes nothing");
    const fix = await imp({ rows: [{ employeeCode: i1.employeeCode, date: "2024-09-02", timeIn: "09:00", timeOut: "11:00" }], apply: true });
    assert.equal(fix.body.data.marked, 1);
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "ATTENDANCE_CORRECTED", metadata: { path: ["source"], equals: "TIME_CLOCK" } } });
    assert.deepEqual([(ev.metadata as { from: string }).from, (ev.metadata as { to: string }).to], ["PRESENT", "ABSENT"]);

    const other = await t.api("post", "/payroll/attendance/import", bOfficer.token).send({ fullDayHours: 8, halfDayHours: 4, apply: true, rows: [{ employeeCode: i1.employeeCode, date: "2024-09-10", timeIn: "09:00", timeOut: "17:30" }] });
    assert.deepEqual([other.body.data.marked, other.body.data.rows[0].reason], [0, "No active employee with this code"], "another hospital cannot reach these employees");

    const run = await startRun("2024-09");
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const locked = await imp({ rows: [{ employeeCode: i1.employeeCode, date: "2024-09-10", timeIn: "09:00", timeOut: "17:30" }], apply: true });
    assert.deepEqual([locked.body.data.marked, locked.body.data.rows[0].reason], [0, "Payroll has already been started for that month"]);
    await cancelRun(run.body.data.id);
  });

  it("arrears: a backdated raise is suggested once, added to the draft payslip, kept out of the statutory base; a cancelled run frees it; rates are the hospital's setting", async () => {
    const e = await employee({ fullName: "Raise Backdated" });
    const pf = await employee({ fullName: "Provident Fund" }, { basic: "20000", hra: "0", otherAllowance: "0", pfApplicable: true, esiApplicable: false, ptApplicable: false });
    for (const m of ["2024-11", "2024-12"]) {
      const r = await startRun(m);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await t.api("post", `/payroll/runs/${r.body.data.id}/approve`, approver.token)).status, 200);
    }
    assert.equal((await t.api("post", `/payroll/employees/${e.id}/structures`, officer.token).send({ effectiveFrom: "2024-12-01", ...FLAT, basic: "33100" })).status, 201);

    const r1 = await startRun("2025-01");
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const run1 = await getRun(r1.body.data.id);
    const slip = run1.slips.find((x) => x.employee.code === e.employeeCode)!;
    const url = `/payroll/runs/${r1.body.data.id}/payslips/${slip.id}/arrears`;
    assert.equal((await t.api("get", url, nurse.token)).status, 403);
    assert.equal((await t.api("get", url, approver.token)).status, 403, "the approver does not edit payslips");
    const sug = (await t.api("get", url, officer.token)).body.data as { payslipId: string; month: string; paid: string; shouldHaveBeen: string; amount: string }[];
    assert.deepEqual(sug.map((x) => [x.month, x.paid, x.shouldHaveBeen, x.amount]), [["2024-12", "31000.00", "33100.00", "2100.00"]], "November's pay was right; December should have been the raised pay");
    assert.equal((await t.api("post", url, officer.token).send({ payslipIds: [] })).status, 400);
    assert.equal((await t.api("post", url, officer.token).send({ payslipIds: ["00000000-0000-4000-8000-000000000000"] })).status, 409);
    const added = await t.api("post", url, officer.token).send({ payslipIds: [sug[0]!.payslipId] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual([added.body.data.arrears, added.body.data.gross, added.body.data.arrearsNote], ["2100.00", "35200.00", "Arrears for 2024-12"]);
    assert.equal((await t.api("post", url, officer.token).send({ payslipIds: [sug[0]!.payslipId] })).status, 409, "a month is added once");
    assert.deepEqual((await t.api("get", url, officer.token)).body.data, []);

    const adj = await t.api("put", `/payroll/runs/${r1.body.data.id}/payslips/${slip.id}`, officer.token).send({ bonus: "100" });
    assert.deepEqual([adj.body.data.arrears, adj.body.data.gross], ["2100.00", "35300.00"], "editing the slip keeps the arrears");
    const manual = await t.api("put", `/payroll/runs/${r1.body.data.id}/payslips/${slip.id}`, officer.token).send({ arrears: "500", arrearsNote: "Manual correction" });
    assert.deepEqual([manual.body.data.arrears, manual.body.data.gross, manual.body.data.arrearsNote], ["500.00", "33700.00", "Manual correction"]);

    // the database keeps the cover honest
    const slipRow = await t.prisma.payslip.findFirstOrThrow({ where: { tenantId: a.tenantId, id: slip.id } });
    const dec = sug[0]!.payslipId;
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Payslip" SET arrears = -1 WHERE id = '${slip.id}'::uuid`), /check|violates/i);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "PayslipArrearsCover" ("tenantId", "payslipId", "coveredPayslipId", amount, "createdById") VALUES ('${a.tenantId}'::uuid, '${slipRow.id}'::uuid, '${dec}'::uuid, 5, '${officer.id}'::uuid)`), /already been added/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "PayslipArrearsCover" ("tenantId", "payslipId", "coveredPayslipId", amount, "createdById") VALUES ('${a.tenantId}'::uuid, '${dec}'::uuid, '${slipRow.id}'::uuid, 5, '${officer.id}'::uuid)`), /draft payroll run/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PayslipArrearsCover" WHERE "payslipId" = '${slip.id}'::uuid`), /append-only/);

    // rates: the default first, then the hospital's own
    const pfSlip = run1.slips.find((x) => x.employee.code === pf.employeeCode)!;
    assert.equal((await t.api("put", `/payroll/runs/${r1.body.data.id}/payslips/${pfSlip.id}`, officer.token).send({ lopDays: 0 })).body.data.pfEmployee, "1800.00");
    const bad = await setting("PAYROLL_STATUTORY_RATES", { pfWageCeiling: 15000, pfRate: 0.1, esiGrossCeiling: 21000, esiEmployeeRate: 0.0075, esiEmployerRate: 0.0325, ptSlabs: [{ upTo: 20000, tax: 100 }, { upTo: 10000, tax: 50 }], ptTop: 200 });
    assert.equal(bad.status, 400, "slabs must rise");
    assert.equal((await setting("PAYROLL_STATUTORY_RATES", { pfWageCeiling: 15000, pfRate: 0.1, esiGrossCeiling: 21000, esiEmployeeRate: 0.0075, esiEmployerRate: 0.0325, ptSlabs: [{ upTo: 10000, tax: 0 }], ptTop: 200 })).status, 200);
    assert.equal((await t.api("put", `/payroll/runs/${r1.body.data.id}/payslips/${pfSlip.id}`, officer.token).send({ lopDays: 0 })).body.data.pfEmployee, "1500.00", "the new rate applies when the payslip is recalculated");

    // cancelling the run frees the month again
    assert.equal((await cancelRun(r1.body.data.id)).status, 200);
    const r2 = await startRun("2025-01");
    const slip2 = (await getRun(r2.body.data.id)).slips.find((x) => x.employee.code === e.employeeCode)!;
    const again = (await t.api("get", `/payroll/runs/${r2.body.data.id}/payslips/${slip2.id}/arrears`, officer.token)).body.data as { month: string }[];
    assert.deepEqual(again.map((x) => x.month), ["2024-12"], "suggested again because the run that took it was cancelled");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PAYROLL_ARREARS_ADDED" } }), 1);
    await cancelRun(r2.body.data.id);
  });
});
