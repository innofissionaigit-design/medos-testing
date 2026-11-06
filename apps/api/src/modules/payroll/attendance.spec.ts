import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";
import { summariseAttendance } from "./payroll.domain";

type User = { id: string; token: string };

describe("attendance: the days of loss of pay a month's marks cost", () => {
  it("an absence and a day of unpaid leave cost a day, a half day costs half; paid leave, weekly offs, holidays and presence cost nothing", () => {
    const s = summariseAttendance([
      { status: "PRESENT" }, { status: "PRESENT" }, { status: "ABSENT" }, { status: "ABSENT" }, { status: "HALF_DAY" },
      { status: "ON_LEAVE", unpaidLeave: true }, { status: "ON_LEAVE", unpaidLeave: true }, { status: "ON_LEAVE", unpaidLeave: false }, { status: "WEEKLY_OFF" }, { status: "HOLIDAY" },
    ]);
    assert.deepEqual([s.present, s.absent, s.halfDay, s.unpaidLeave, s.paidLeave, s.weeklyOff, s.holiday, s.lossOfPay.toString()], [2, 2, 1, 2, 1, 1, 1, "4.5"]);
    assert.equal(summariseAttendance([]).lossOfPay.toString(), "0");
  });
});

describe("attendance and leave: marking, applying, approving, and the monthly payroll run", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let officer: User; let approver: User; let nurse: User; let bOfficer: User; let bApprover: User;
  let casual: string; let unpaid: string;

  const addEmployee = (body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", "/payroll/employees", tok).send({ fullName: "Sunita Das", designation: "Staff nurse", joinedOn: "2025-01-01", ...body });
  const employee = async (body: Record<string, unknown> = {}, pay = true) => {
    const e = await addEmployee(body);
    assert.equal(e.status, 201, JSON.stringify(e.body));
    if (pay) assert.equal((await t.api("post", `/payroll/employees/${e.body.data.id}/structures`, officer.token).send({ effectiveFrom: "2025-01-01", basic: "31000", hra: "0", otherAllowance: "0", pfApplicable: false, esiApplicable: false, ptApplicable: false })).status, 201);
    return e.body.data as { id: string; employeeCode: string };
  };
  const mark = (date: string, entries: { employeeId: string; status: string; note?: string }[], tok = officer.token) => t.api("put", "/payroll/attendance", tok).send({ date, entries });
  const apply = (employeeId: string, leaveTypeId: string, fromDate: string, toDate: string, tok = officer.token) => t.api("post", "/payroll/leave-requests", tok).send({ employeeId, leaveTypeId, fromDate, toDate, reason: "Family function" });
  const decide = (id: string, what: "approve" | "reject" | "cancel", body: Record<string, unknown> = {}, tok = approver.token) => t.api("post", `/payroll/leave-requests/${id}/${what}`, tok).send(body);
  const sheet = async (m: string, tok = officer.token) => (await t.api("get", `/payroll/attendance?month=${m}`, tok)).body.data as { locked: boolean; employees: { id: string; unmarked: number; lossOfPay: string; absent: number; days: ({ status: string; leave: string | null } | null)[] }[] };
  const types = async () => (await t.api("get", "/payroll/leave-types", officer.token)).body.data as { id: string; name: string; isPaid: boolean; yearlyAllowance: string | null }[];

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("att-a"); b = await t.makeTenant("att-b");
    officer = await t.makeUser(a, ["PAYROLL_OFFICER"]); approver = await t.makeUser(a, ["ADMINISTRATOR"]); nurse = await t.makeUser(a, ["NURSE"]);
    bOfficer = await t.makeUser(b, ["PAYROLL_OFFICER"]); bApprover = await t.makeUser(b, ["ADMINISTRATOR"]);
    assert.equal((await t.api("post", "/payroll/leave-types/standard", officer.token)).body.data.added, 4);
    const all = await types();
    casual = all.find((x) => x.name === "Casual leave")!.id; unpaid = all.find((x) => x.name === "Leave without pay")!.id;
  });
  after(async () => { await t.close(); });

  it("leave types: the standard set is added once; a type that has been used cannot swap between paid and unpaid; names are unique", async () => {
    assert.equal((await t.api("post", "/payroll/leave-types/standard", officer.token)).body.data.added, 0, "repeating adds nothing");
    const all = await types();
    assert.deepEqual(all.map((x) => [x.name, x.isPaid, x.yearlyAllowance]).sort(), [["Casual leave", true, "12"], ["Earned leave", true, "15"], ["Leave without pay", false, null], ["Sick leave", true, "12"]]);
    assert.equal((await t.api("post", "/payroll/leave-types", officer.token).send({ name: "Casual leave", isPaid: true, yearlyAllowance: 3 })).status, 409);
    assert.equal((await t.api("post", "/payroll/leave-types", officer.token).send({ name: "Bad", isPaid: true, yearlyAllowance: -1 })).status, 400);
    assert.equal((await t.api("post", "/payroll/leave-types", approver.token).send({ name: "Study leave", isPaid: true, yearlyAllowance: 5 })).status, 403, "the approver does not keep the masters");
    assert.equal((await t.api("post", "/payroll/leave-types", nurse.token).send({ name: "Study leave", isPaid: true, yearlyAllowance: 5 })).status, 403);
    const study = (await t.api("post", "/payroll/leave-types", officer.token).send({ name: "Study leave", isPaid: true, yearlyAllowance: 5 })).body.data;
    assert.equal((await t.api("patch", `/payroll/leave-types/${study.id}`, officer.token).send({ isPaid: false })).status, 200, "unused: may change");
    const e = await employee();
    assert.equal((await apply(e.id, study.id, "2025-02-03", "2025-02-03")).status, 201);
    const r = await t.api("patch", `/payroll/leave-types/${study.id}`, officer.token).send({ isPaid: true });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((await t.api("patch", `/payroll/leave-types/${study.id}`, officer.token).send({ yearlyAllowance: 6 })).status, 200, "the allowance may change");
    assert.equal((await t.api("get", "/payroll/leave-types", bOfficer.token)).body.data.length, 0, "another hospital sees none of these");
  });

  it("marking attendance: payroll staff only; real dates, within employment, not in the future; a correction is audited; leave days cannot be overwritten", async () => {
    const e = await employee();
    const ok = await mark("2025-03-03", [{ employeeId: e.id, status: "PRESENT" }]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.corrected, 0);
    assert.equal((await mark("2025-03-03", [{ employeeId: e.id, status: "ABSENT", note: "Called in sick" }], approver.token)).status, 403, "the approver does not mark attendance");
    assert.equal((await mark("2025-03-03", [{ employeeId: e.id, status: "ABSENT" }], nurse.token)).status, 403);
    assert.equal((await t.api("put", "/payroll/attendance").send({})).status, 401);
    for (const bad of [{ date: "2025-02-30", entries: [{ employeeId: e.id, status: "PRESENT" }] }, { date: "2025-03-03", entries: [] }, { date: "2025-03-03", entries: [{ employeeId: e.id, status: "ON_LEAVE" }] }, { date: "2025-03-03", entries: [{ employeeId: e.id, status: "PRESENT" }, { employeeId: e.id, status: "ABSENT" }] }, { date: "2025-03-03", entries: [{ employeeId: e.id, status: "PRESENT", extra: 1 }] }]) {
      assert.equal((await t.api("put", "/payroll/attendance", officer.token).send(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await mark("2024-12-31", [{ employeeId: e.id, status: "PRESENT" }])).status, 400, "before joining");
    const tomorrow = new Date(Date.now() + 19_800_000 + 2 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await mark(tomorrow, [{ employeeId: e.id, status: "PRESENT" }])).status, 400, "presence cannot be marked for a day to come");
    assert.equal((await mark(tomorrow, [{ employeeId: e.id, status: "HOLIDAY" }])).status, 200, "a holiday can be set ahead");
    // another hospital's employee looks like one that does not exist
    const foreign = (await t.api("post", "/payroll/employees", bOfficer.token).send({ fullName: "Other Hospital", designation: "Cook", joinedOn: "2025-01-01" })).body.data;
    assert.equal((await mark("2025-03-03", [{ employeeId: foreign.id, status: "ABSENT" }])).status, 404);
    assert.equal((await mark("2025-03-03", [{ employeeId: randomUUID(), status: "ABSENT" }])).status, 404);

    const fix = await mark("2025-03-03", [{ employeeId: e.id, status: "ABSENT", note: "Called in sick" }]);
    assert.equal(fix.body.data.corrected, 1);
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "ATTENDANCE_CORRECTED", metadata: { path: ["employeeId"], equals: e.id } } });
    assert.deepEqual([ev.actorUserId, (ev.metadata as { from: string }).from, (ev.metadata as { to: string }).to], [officer.id, "PRESENT", "ABSENT"]);
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "ATTENDANCE_MARKED" } }) >= 2, true);

    const mine = (await sheet("2025-03")).employees.find((x) => x.id === e.id)!;
    assert.deepEqual([mine.days[2]?.status, mine.absent, mine.lossOfPay], ["ABSENT", 1, "1"]);
    assert.equal((await t.api("get", "/payroll/attendance?month=2025-03", nurse.token)).status, 403);
    assert.equal((await t.api("get", "/payroll/attendance?month=2025-03", bOfficer.token)).body.data.employees.some((x: { id: string }) => x.id === e.id), false, "another hospital's sheet never lists them");
    assert.equal((await t.api("get", "/payroll/attendance?month=2025-13", officer.token)).status, 400);
  });

  it("leave: an application changes nothing until approved; approval marks the days (not weekly offs) and counts the balance; rejection needs a reason; cancelling gives the days back", async () => {
    const e = await employee();
    assert.equal((await mark("2025-04-06", [{ employeeId: e.id, status: "WEEKLY_OFF" }])).status, 200);
    const req = await apply(e.id, casual, "2025-04-05", "2025-04-08");
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(req.body.data.status, "PENDING");
    assert.equal((await sheet("2025-04")).employees.find((x) => x.id === e.id)!.days[4], null, "still unmarked");
    assert.equal((await decide(req.body.data.id, "approve", {}, officer.token)).status, 403, "the officer does not approve leave");
    assert.equal((await decide(req.body.data.id, "approve", {}, nurse.token)).status, 403);
    assert.equal((await apply(e.id, casual, "2025-04-07", "2025-04-09")).status, 409, "overlapping days");
    const ok = await decide(req.body.data.id, "approve");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.days, "3", "four days minus the weekly off");
    const days = (await sheet("2025-04")).employees.find((x) => x.id === e.id)!.days;
    assert.deepEqual([days[4]?.status, days[5]?.status, days[6]?.status, days[7]?.status], ["ON_LEAVE", "WEEKLY_OFF", "ON_LEAVE", "ON_LEAVE"]);
    assert.equal(days[4]?.leave, "Casual leave");
    assert.equal((await decide(req.body.data.id, "approve")).status, 409, "decided once");
    assert.equal((await mark("2025-04-05", [{ employeeId: e.id, status: "PRESENT" }])).status, 409, "a day of approved leave is not overwritten by a mark");

    const bal = (await t.api("get", `/payroll/employees/${e.id}/leave-balance?year=2025`, officer.token)).body.data.find((x: { leaveTypeId: string }) => x.leaveTypeId === casual);
    assert.deepEqual([bal.allowance, bal.taken, bal.remaining], ["12", "3", "9"]);

    const long = await apply(e.id, casual, "2025-05-01", "2025-05-20");
    assert.equal(long.status, 409, "20 days against 9 left");
    assert.equal(long.body.error.code, "INSUFFICIENT_LEAVE_BALANCE");
    const next = await apply(e.id, casual, "2025-04-20", "2025-04-21");
    assert.equal((await decide(next.body.data.id, "reject", {}, approver.token)).status, 400, "a reason is needed");
    const rej = await decide(next.body.data.id, "reject", { note: "Short staffed that week" });
    assert.deepEqual([rej.status, rej.body.data.status, rej.body.data.decisionNote], [200, "REJECTED", "Short staffed that week"]);
    assert.equal((await decide(next.body.data.id, "cancel", {}, officer.token)).status, 409, "a rejected application is closed");

    const back = await decide(req.body.data.id, "cancel", { reason: "Plans changed" }, officer.token);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const after = (await sheet("2025-04")).employees.find((x) => x.id === e.id)!.days;
    assert.deepEqual([after[4], after[5]?.status, after[6]], [null, "WEEKLY_OFF", null], "the leave days are unmarked again; the weekly off stays");
    const events = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: req.body.data.id } })).map((x) => x.action).sort();
    assert.deepEqual(events, ["LEAVE_APPROVED", "LEAVE_CANCELLED", "LEAVE_REQUESTED"]);
    assert.equal((await t.api("get", `/payroll/leave-requests?employeeId=${e.id}`, bOfficer.token)).body.data.total, 0, "another hospital sees none of it");
    assert.equal((await decide(req.body.data.id, "approve", {}, bApprover.token)).status, 404);
  });

  it("an employee applies for their own leave and cancels it; nobody approves their own leave", async () => {
    const worker = await t.makeUser(a, ["NURSE"]);
    const mineBefore = await t.api("get", "/payroll/my-leave", worker.token);
    assert.equal(mineBefore.body.data.linked, false);
    assert.equal((await t.api("post", "/payroll/my-leave", worker.token).send({ leaveTypeId: casual, fromDate: "2025-06-02", toDate: "2025-06-02" })).status, 404, "a login that is not linked to an employee");
    const e = await employee({ userId: worker.id });
    const mine = await t.api("get", "/payroll/my-leave", worker.token);
    assert.equal(mine.body.data.linked, true);
    assert.ok(mine.body.data.types.length >= 4);
    const r = await t.api("post", "/payroll/my-leave", worker.token).send({ leaveTypeId: casual, fromDate: "2025-06-02", toDate: "2025-06-03", reason: "Wedding" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.employee.id, e.id, "the employee comes from the login, never from the request");
    assert.equal((await t.api("post", "/payroll/my-leave", worker.token).send({ employeeId: randomUUID(), leaveTypeId: casual, fromDate: "2025-06-09", toDate: "2025-06-09" })).status, 400, "an unexpected field is refused");
    // someone else's application cannot be cancelled through the employee's own route
    const other = await t.makeUser(a, ["NURSE"]);
    assert.equal((await t.api("post", `/payroll/my-leave/${r.body.data.id}/cancel`, other.token).send({})).status, 404);
    assert.equal((await t.api("post", `/payroll/my-leave/${r.body.data.id}/cancel`, worker.token).send({ reason: "Postponed" })).status, 200);
    assert.equal((await t.api("post", `/payroll/my-leave/${r.body.data.id}/cancel`, worker.token).send({})).status, 409);

    // an administrator who is also an employee: their own application is decided by another administrator
    const adminEmployee = await employee({ userId: approver.id, fullName: "Admin Employee" });
    const own = await t.api("post", "/payroll/my-leave", approver.token).send({ leaveTypeId: casual, fromDate: "2025-06-10", toDate: "2025-06-10" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.data.employee.id, adminEmployee.id);
    assert.equal((await decide(own.body.data.id, "approve", {}, approver.token)).status, 403, "not their own");
    assert.equal((await decide(own.body.data.id, "reject", { note: "Not allowed" }, approver.token)).status, 403);
    const second = await t.makeUser(a, ["ADMINISTRATOR"]);
    assert.equal((await decide(own.body.data.id, "approve", {}, second.token)).status, 200);
    // an application the payroll officer typed in for an employee cannot be approved by the officer, and is not the employee's own to approve either
    const entered = await apply(e.id, casual, "2025-06-16", "2025-06-16");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET status = 'APPROVED', days = 1, "decidedById" = "requestedById", "decidedAt" = now() WHERE id = '${entered.body.data.id}'::uuid`), /someone other than/);
  });

  it("the payroll run takes days of loss of pay from attendance, reports unmarked days, and freezes the month's sheet until a draft is cancelled", async () => {
    const e = await employee({ fullName: "March Worker" });
    assert.equal((await mark("2025-03-03", [{ employeeId: e.id, status: "ABSENT" }])).status, 200);
    assert.equal((await mark("2025-03-04", [{ employeeId: e.id, status: "ABSENT" }])).status, 200);
    assert.equal((await mark("2025-03-05", [{ employeeId: e.id, status: "HALF_DAY" }])).status, 200);
    assert.equal((await mark("2025-03-06", [{ employeeId: e.id, status: "PRESENT" }])).status, 200);
    const lwp = await apply(e.id, unpaid, "2025-03-10", "2025-03-11");
    assert.equal((await decide(lwp.body.data.id, "approve")).status, 200);
    const cl = await apply(e.id, casual, "2025-03-12", "2025-03-12");
    assert.equal((await decide(cl.body.data.id, "approve")).status, 200);

    const mineFirst = (await sheet("2025-03")).employees.find((x) => x.id === e.id)!;
    assert.deepEqual([mineFirst.absent, mineFirst.lossOfPay, mineFirst.unmarked], [2, "4.5", 24]);

    const r = await t.api("post", "/payroll/runs", officer.token).send({ month: "2025-03" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.data.incomplete.some((x: { employeeCode: string; unmarkedDays: number }) => x.employeeCode === e.employeeCode && x.unmarkedDays === 24), "unmarked days are reported");
    const run = (await t.api("get", `/payroll/runs/${r.body.data.id}`, officer.token)).body.data as { slips: { employee: { code: string }; lopDays: string; basic: string; note: string | null }[] };
    const slip = run.slips.find((x) => x.employee.code === e.employeeCode)!;
    assert.deepEqual([slip.lopDays, slip.basic, slip.note], ["4.5", "26500.00", "From attendance: 2 absent, 1 half day, 2 unpaid leave"]);

    // the month is frozen while the run is live
    const locked = await mark("2025-03-20", [{ employeeId: e.id, status: "ABSENT" }]);
    assert.deepEqual([locked.status, locked.body.error.code], [409, "PAYROLL_MONTH_LOCKED"]);
    assert.equal((await apply(e.id, casual, "2025-03-25", "2025-03-25")).body.error.code, "PAYROLL_MONTH_LOCKED");
    assert.equal((await decide(cl.body.data.id, "cancel", {}, officer.token)).body.error.code, "PAYROLL_MONTH_LOCKED", "approved leave of a run month cannot be cancelled either");
    assert.equal((await sheet("2025-03")).locked, true);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AttendanceDay" SET status = 'PRESENT', "leaveRequestId" = NULL WHERE "employeeId" = '${e.id}'::uuid AND date = '2025-03-03'`), /payroll run cannot change/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "AttendanceDay" WHERE "employeeId" = '${e.id}'::uuid AND date = '2025-03-03'`), /payroll run cannot change/);

    // cancelling the draft run frees the month: the sheet can be corrected and a new run picks the correction up
    assert.equal((await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Attendance needs a correction" })).status, 200);
    assert.equal((await mark("2025-03-03", [{ employeeId: e.id, status: "PRESENT" }])).status, 200);
    const r2 = await t.api("post", "/payroll/runs", officer.token).send({ month: "2025-03" });
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    const slip2 = ((await t.api("get", `/payroll/runs/${r2.body.data.id}`, officer.token)).body.data as { slips: { employee: { code: string }; lopDays: string }[] }).slips.find((x) => x.employee.code === e.employeeCode)!;
    assert.equal(slip2.lopDays, "3.5");
    await t.api("post", `/payroll/runs/${r2.body.data.id}/cancel`, officer.token).send({ reason: "Test finished, freeing the month" });
  });

  it("attendance outside the employee's time at the hospital does not count, and loss of pay never exceeds the days in the month", async () => {
    const e = await employee({ fullName: "Left Mid Month", joinedOn: "2025-01-01" });
    assert.equal((await t.api("patch", `/payroll/employees/${e.id}`, officer.token).send({ exitedOn: "2025-07-10" })).status, 200);
    assert.equal((await mark("2025-07-11", [{ employeeId: e.id, status: "ABSENT" }])).status, 400, "after the last day");
    assert.equal((await mark("2025-07-08", [{ employeeId: e.id, status: "ABSENT" }])).status, 200);
    const late = await apply(e.id, casual, "2025-07-09", "2025-07-14");
    assert.equal(late.status, 400, "leave beyond the last day");
    const r = await t.api("post", "/payroll/runs", officer.token).send({ month: "2025-07" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const slip = ((await t.api("get", `/payroll/runs/${r.body.data.id}`, officer.token)).body.data as { slips: { employee: { code: string }; lopDays: string; daysInMonth: number }[] }).slips.find((x) => x.employee.code === e.employeeCode)!;
    assert.equal(slip.lopDays, "22", "21 days after the last day plus 1 absence");
    await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Test finished, freeing the month" });
  });

  it("DATABASE: leave applications cannot be deleted or have their person, dates or type changed; an approved one can only be cancelled; a leave day needs its application", async () => {
    const e = await employee({ fullName: "Db Checks" });
    const r = await apply(e.id, casual, "2025-08-04", "2025-08-05");
    const id = r.body.data.id as string;
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LeaveRequest" WHERE id = '${id}'::uuid`), /cannot be deleted/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET "toDate" = '2025-08-09' WHERE id = '${id}'::uuid`), /cannot change its person, type or dates/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET status = 'REJECTED', "decidedById" = '${approver.id}'::uuid, "decidedAt" = now() WHERE id = '${id}'::uuid`), /check|decisionNote/i, "a rejection needs its reason");
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "AttendanceDay" ("tenantId", "facilityId", "employeeId", date, status, "markedById", "updatedAt") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${e.id}'::uuid, '2025-08-06', 'ON_LEAVE', '${officer.id}'::uuid, now())`), /check/i);
    await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "AttendanceDay" ("tenantId", "facilityId", "employeeId", date, status, "markedById", "leaveRequestId", "updatedAt") VALUES ('${a.tenantId}'::uuid, '${a.facilityId}'::uuid, '${e.id}'::uuid, '2025-08-06', 'PRESENT', '${officer.id}'::uuid, '${id}'::uuid, now())`), /check/i);
    assert.equal((await decide(id, "approve")).status, 200);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET "decisionNote" = 'tidy' , days = 1 WHERE id = '${id}'::uuid`), /only be cancelled/);
    assert.equal((await decide(id, "cancel", {}, officer.token)).status, 200);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "LeaveRequest" SET status = 'PENDING' WHERE id = '${id}'::uuid`), /cannot change/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "LeaveType" WHERE id = '${casual}'::uuid`));
  });

  it("concurrency: two approvals of one application make one approval; an application and a month's run never produce a payslip that disagrees with the sheet", async () => {
    const e = await employee({ fullName: "Race Leave" });
    const r = await apply(e.id, unpaid, "2025-09-01", "2025-09-02");
    const [p, q] = [await t.makeUser(a, ["ADMINISTRATOR"]), await t.makeUser(a, ["ADMINISTRATOR"])];
    const rs = await Promise.all([decide(r.body.data.id, "approve", {}, p.token), decide(r.body.data.id, "approve", {}, q.token)]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409], JSON.stringify(rs.map((x) => x.body)));
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "LEAVE_APPROVED", entityId: r.body.data.id } }), 1);
    assert.equal(await t.prisma.attendanceDay.count({ where: { tenantId: a.tenantId, leaveRequestId: r.body.data.id } }), 2);

    // marking a day while the month's run is being started: either the mark lands before the run (and is counted) or it is refused; the slip always agrees with the sheet
    const [m1, run] = await Promise.all([mark("2025-09-10", [{ employeeId: e.id, status: "ABSENT" }]), t.api("post", "/payroll/runs", officer.token).send({ month: "2025-09" })]);
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const slip = ((await t.api("get", `/payroll/runs/${run.body.data.id}`, officer.token)).body.data as { slips: { employee: { code: string }; lopDays: string }[] }).slips.find((x) => x.employee.code === e.employeeCode)!;
    const marked = await t.prisma.attendanceDay.count({ where: { tenantId: a.tenantId, employeeId: e.id, date: new Date("2025-09-10T00:00:00Z"), status: "ABSENT" } });
    assert.equal(m1.status === 200, marked === 1);
    assert.equal(slip.lopDays, marked === 1 ? "3" : "2");
    await t.api("post", `/payroll/runs/${run.body.data.id}/cancel`, officer.token).send({ reason: "Test finished, freeing the month" });
  });

  it("the payroll officer may mark attendance and the administrator may decide leave", async () => {
    const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "PAYROLL_OFFICER", isSystem: true }, include: { permissions: true } });
    assert.deepEqual(r.permissions.map((x) => x.permission).sort(), ["ATTENDANCE_MANAGE", "PAYROLL_MANAGE", "PAYROLL_READ"]);
    const admin = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "ADMINISTRATOR", isSystem: true }, include: { permissions: true } });
    assert.ok(admin.permissions.some((x) => x.permission === "LEAVE_APPROVE"));
    assert.ok(!admin.permissions.some((x) => x.permission === "ATTENDANCE_MANAGE"), "the person who decides leave does not also keep the attendance sheet");
  });
});
