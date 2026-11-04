import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "@medos/shared";
import { startApp, type TestApp, type TestTenant } from "../../test/harness";
import { computePay, daysIn, professionalTax } from "./payroll.domain";

type User = { id: string; token: string };
const s = (v: Decimal) => v.toFixed(2);
const structure = (basic: string, hra: string, other: string, o: Partial<{ pfApplicable: boolean; esiApplicable: boolean; ptApplicable: boolean }> = {}) => ({ basic, hra, otherAllowance: other, pfApplicable: true, esiApplicable: true, ptApplicable: true, ...o });

describe("payroll: the calculation", () => {
  it("a well-paid employee: provident fund on the ceiling, no ESI, professional tax at the top slab", () => {
    const c = computePay(structure("30000", "10000", "5000"), { daysInMonth: 30, lopDays: 0 });
    assert.deepEqual([s(c.gross), s(c.pfEmployee), s(c.esiEmployee), s(c.professionalTax), s(c.totalDeductions), s(c.net), s(c.pfEmployer)], ["45000.00", "1800.00", "0.00", "200.00", "2000.00", "43000.00", "1800.00"]);
  });
  it("a low-paid employee: ESI is rounded up to the rupee, employer's share is separate", () => {
    const c = computePay(structure("12000", "3000", "0"), { daysInMonth: 30, lopDays: 0 });
    assert.deepEqual([s(c.gross), s(c.pfEmployee), s(c.esiEmployee), s(c.esiEmployer), s(c.professionalTax), s(c.net)], ["15000.00", "1440.00", "113.00", "488.00", "110.00", "13337.00"]);
  });
  it("days of loss of pay reduce every component in proportion; bonus, TDS and other deductions are added in", () => {
    const c = computePay(structure("30000", "10000", "5000"), { daysInMonth: 30, lopDays: 3, bonus: "1000", tds: "2500.50", otherDeduction: "300" });
    assert.deepEqual([s(c.basic), s(c.hra), s(c.otherAllowance), s(c.gross), s(c.tds), s(c.otherDeduction), s(c.net)], ["27000.00", "9000.00", "4500.00", "41500.00", "2500.50", "300.00", "36699.50"]);
    assert.equal(s(computePay(structure("100", "0", "0"), { daysInMonth: 30, lopDays: 1 }).basic), "96.67", "rounded to the paisa");
    assert.throws(() => computePay(structure("100", "0", "0"), { daysInMonth: 30, lopDays: 31 }), RangeError);
    assert.throws(() => computePay(structure("100", "0", "0"), { daysInMonth: 30, lopDays: -1 }), RangeError);
  });
  it("what is switched off for an employee is not deducted; the slabs and month lengths are right", () => {
    const c = computePay(structure("12000", "3000", "0", { pfApplicable: false, esiApplicable: false, ptApplicable: false }), { daysInMonth: 31, lopDays: 0 });
    assert.deepEqual([s(c.pfEmployee), s(c.esiEmployee), s(c.professionalTax), s(c.net)], ["0.00", "0.00", "0.00", "15000.00"]);
    assert.deepEqual([10000, 10001, 15000, 15001, 25000, 25001, 40000, 40001].map((g) => Number(professionalTax(new Decimal(g)))), [0, 110, 110, 130, 130, 150, 150, 200]);
    assert.deepEqual([daysIn(new Date("2026-02-01T00:00:00Z")), daysIn(new Date("2028-02-01T00:00:00Z")), daysIn(new Date("2026-11-01T00:00:00Z")), daysIn(new Date("2026-12-01T00:00:00Z"))], [28, 29, 30, 31]);
  });
});

describe("payroll: employees, pay structures, and a monthly run from draft to paid", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let officer: User; let approver: User; let cashier: User; let staffUser: User; let bOfficer: User; let bApprover: User;
  const month = (n: number) => `2026-${String(n).padStart(2, "0")}`;

  const addEmployee = (body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", "/payroll/employees", tok).send({ fullName: "Sunita Das", designation: "Staff nurse", joinedOn: "2025-01-01", ...body });
  const setPay = (employeeId: string, body: Record<string, unknown> = {}, tok = officer.token) => t.api("post", `/payroll/employees/${employeeId}/structures`, tok).send({ effectiveFrom: "2025-01-01", basic: "30000", hra: "10000", otherAllowance: "5000", ...body });
  const employee = async (body: Record<string, unknown> = {}, pay: Record<string, unknown> | null = {}) => {
    const e = await addEmployee(body);
    assert.equal(e.status, 201, JSON.stringify(e.body));
    if (pay) assert.equal((await setPay(e.body.data.id, pay)).status, 201);
    return e.body.data as { id: string; employeeCode: string };
  };
  const createRun = (m: string, tok = officer.token) => t.api("post", "/payroll/runs", tok).send({ month: m });
  const run = async (id: string, tok = officer.token) => (await t.api("get", `/payroll/runs/${id}`, tok)).body.data as { status: string; net: string; gross: string; deductions: string; employerCost: string; slips: { id: string; employee: { code: string }; net: string; gross: string; lopDays: string; pfEmployee: string; tds: string }[] };
  const slipOf = (r: Awaited<ReturnType<typeof run>>, code: string) => r.slips.find((x) => x.employee.code === code)!;
  const adjust = (runId: string, slipId: string, body: Record<string, unknown>, tok = officer.token) => t.api("put", `/payroll/runs/${runId}/payslips/${slipId}`, tok).send(body);

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("pay-a"); b = await t.makeTenant("pay-b");
    officer = await t.makeUser(a, ["PAYROLL_OFFICER"]); approver = await t.makeUser(a, ["ADMINISTRATOR"]); cashier = await t.makeUser(a, ["CASHIER"]); staffUser = await t.makeUser(a, ["NURSE"]);
    bOfficer = await t.makeUser(b, ["PAYROLL_OFFICER"]); bApprover = await t.makeUser(b, ["ADMINISTRATOR"]);
  });
  after(async () => { await t.close(); });

  it("employees: added with a code and details checked; bank and PAN are masked; only payroll staff may see or keep them", async () => {
    const e = await addEmployee({ bankAccount: "123456789012", ifsc: "SBIN0001234", pan: "ABCDE1234F", uan: "100200300400", department: "Nursing" });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.match(e.body.data.employeeCode, /^EMP-\d{4}$/);
    assert.deepEqual([e.body.data.bankAccount, e.body.data.pan], ["•".repeat(8) + "9012", "•".repeat(6) + "234F"], "only the last four characters show");
    for (const bad of [{ pan: "123" }, { ifsc: "BAD" }, { bankAccount: "12ab" }, { fullName: "x" }, { joinedOn: "soon" }, { extra: 1 }, { uan: "1" }]) assert.equal((await addEmployee(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await addEmployee({}, cashier.token)).status, 403);
    assert.equal((await addEmployee({}, approver.token)).status, 403, "the approver reads and approves; the officer keeps the records");
    assert.equal((await t.api("get", "/payroll/employees", approver.token)).status, 200);
    assert.equal((await t.api("get", "/payroll/employees", cashier.token)).status, 403);
    assert.equal((await t.api("get", "/payroll/employees")).status, 401);
    const upd = await t.api("patch", `/payroll/employees/${e.body.data.id}`, officer.token).send({ designation: "Senior staff nurse", status: "INACTIVE" });
    assert.deepEqual([upd.status, upd.body.data?.designation, upd.body.data?.status], [200, "Senior staff nurse", "INACTIVE"]);
    assert.equal((await t.api("patch", `/payroll/employees/${e.body.data.id}`, officer.token).send({ exitedOn: "2024-01-01" })).status, 400, "before joining");
    assert.equal((await t.api("patch", `/payroll/employees/${e.body.data.id}`, officer.token).send({ joinedOn: "2020-01-01" })).status, 400, "the joining date is not changed here");
    assert.equal((await t.api("patch", `/payroll/employees/${e.body.data.id}`, bOfficer.token).send({ designation: "Hijacked" })).status, 404);
    assert.equal(((await t.api("get", "/payroll/employees?pageSize=100", bOfficer.token)).body.data.items as unknown[]).length, 0);
    const found = (await t.api("get", `/payroll/employees?q=${e.body.data.employeeCode}`, officer.token)).body.data.items as { id: string }[];
    assert.deepEqual(found.map((x) => x.id), [e.body.data.id]);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PAYROLL_EMPLOYEE_ADDED", entityId: e.body.data.id } }));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "Employee" WHERE id = '${e.body.data.id}'::uuid`), /cannot be deleted|append-only/);
  });

  it("an employee can be linked to one user; the link needs a real user of the same hospital", async () => {
    const e = await addEmployee({ fullName: "Linked Nurse", userId: staffUser.id });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.equal((await addEmployee({ fullName: "Second Link", userId: staffUser.id })).status, 409);
    assert.equal((await addEmployee({ fullName: "Ghost", userId: randomUUID() })).status, 404);
    const other = await t.makeUser(b, ["NURSE"]);
    assert.equal((await addEmployee({ fullName: "Foreign", userId: other.id })).status, 404, "another hospital's user");
  });

  it("pay structures: a new one from a date, the old ones kept; not before joining; not twice for one date", async () => {
    const e = await employee({ fullName: "Structure Test", joinedOn: "2025-06-01" }, null);
    assert.equal((await setPay(e.id, { effectiveFrom: "2025-05-31" })).status, 400, "before joining");
    for (const bad of [{ basic: "0" }, { basic: "-5" }, { hra: "-1" }, { effectiveFrom: "x" }, { extra: 1 }]) assert.equal((await setPay(e.id, { effectiveFrom: "2025-06-01", ...bad })).status, 400, JSON.stringify(bad));
    assert.equal((await setPay(e.id, { effectiveFrom: "2025-06-01" }, cashier.token)).status, 403);
    assert.equal((await setPay(e.id, { effectiveFrom: "2025-06-01" }, bOfficer.token)).status, 404);
    const first = await setPay(e.id, { effectiveFrom: "2025-06-01" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.gross, "45000.00");
    assert.equal((await setPay(e.id, { effectiveFrom: "2025-06-01" })).status, 409);
    assert.equal((await setPay(e.id, { effectiveFrom: "2026-01-01", basic: "35000" })).status, 201);
    const list = (await t.api("get", `/payroll/employees/${e.id}/structures`, officer.token)).body.data as { effectiveFrom: string; basic: string }[];
    assert.deepEqual(list.map((x) => [x.effectiveFrom, x.basic]), [["2026-01-01", "35000.00"], ["2025-06-01", "30000.00"]]);
    const row = await t.prisma.salaryStructure.findFirstOrThrow({ where: { employeeId: e.id } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "SalaryStructure" SET basic = 1 WHERE id = '${row.id}'::uuid`), /append-only/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "SalaryStructure" WHERE id = '${row.id}'::uuid`), /append-only/);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PAYROLL_STRUCTURE_SET", entityId: e.id } }));
  });

  it("a run: a payslip for each employee who has pay, those without are listed, the latest structure in force is used, joining mid-month is prorated", async () => {
    const full = await employee({ fullName: "Full Month" });
    const none = await employee({ fullName: "No Pay Yet" }, null);
    const joiner = await employee({ fullName: "Joined Late", joinedOn: "2026-01-16" }, { effectiveFrom: "2026-01-16" });
    await setPay(full.id, { effectiveFrom: "2026-01-01", basic: "40000", hra: "0", otherAllowance: "0" });
    const r = await createRun(month(1));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.data.skipped.some((x: { employeeCode: string; reason: string }) => x.employeeCode === none.employeeCode && x.reason === "No salary structure"));
    const v = await run(r.body.data.id);
    assert.equal(v.status, "DRAFT");
    const f = slipOf(v, full.employeeCode);
    assert.equal(f.gross, "40000.00", "the newer structure is the one in force");
    const j = slipOf(v, joiner.employeeCode);
    assert.equal(j.lopDays, "15", "the 15 days before joining are unpaid");
    assert.equal(j.gross, "23225.81", "16 of the 31 days of January: 45000 x 16 / 31");
    assert.equal(v.slips.some((x) => x.employee.code === none.employeeCode), false);
    assert.equal((await createRun(month(1))).status, 409, "one run per month");
    assert.equal((await createRun("2099-01")).status, 400, "not a month that has not started");
    for (const bad of ["2026-13", "2026", "January"]) assert.equal((await createRun(bad)).status, 400, bad);
    assert.equal((await createRun(month(2), cashier.token)).status, 403);
    assert.equal((await createRun(month(2), approver.token)).status, 403);
    assert.equal((await t.api("get", `/payroll/runs/${r.body.data.id}`, bOfficer.token)).status, 404);
    assert.equal(((await t.api("get", "/payroll/runs", bOfficer.token)).body.data as unknown[]).length, 0);
    assert.ok(((await t.api("get", "/payroll/runs", officer.token)).body.data as { id: string }[]).some((x) => x.id === r.body.data.id));
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PAYROLL_RUN_CREATED", entityId: r.body.data.id } }));
    await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Test run, month reused below" });
  });

  it("a draft payslip: days of loss of pay, bonus, TDS and other deductions are entered, and every figure is recalculated by the server", async () => {
    const e = await employee({ fullName: "Adjust Me" });
    const r = await createRun(month(2));
    const v = await run(r.body.data.id);
    const sl = slipOf(v, e.employeeCode);
    const ok = await adjust(r.body.data.id, sl.id, { lopDays: 3, bonus: "1000", tds: "2500.50", otherDeduction: "300", note: "Advance recovered" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.gross, ok.body.data.net, ok.body.data.pfEmployee, ok.body.data.tds, ok.body.data.note], ["41178.57", "36378.07", "1800.00", "2500.50", "Advance recovered"]);
    assert.equal((await adjust(r.body.data.id, sl.id, { lopDays: 29 })).status, 400, "February 2026 has 28 days: 29 is too many");
  });

  it("a draft payslip refuses wrong entries and other people", async () => {
    const e = await employee({ fullName: "Strict Entry" });
    const r = await createRun(month(3));
    const sl = slipOf(await run(r.body.data.id), e.employeeCode);
    for (const bad of [{ lopDays: -1 }, { lopDays: 32 }, { lopDays: 1.3 }, { bonus: "-5" }, { tds: "abc" }, { extra: 1 }]) assert.equal((await adjust(r.body.data.id, sl.id, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await adjust(r.body.data.id, sl.id, { lopDays: 32 })).status, 400);
    assert.equal((await adjust(r.body.data.id, sl.id, { tds: "99999" })).status, 400, "the deductions are more than the pay");
    assert.equal((await adjust(r.body.data.id, sl.id, { bonus: "5" }, cashier.token)).status, 403);
    assert.equal((await adjust(r.body.data.id, sl.id, { bonus: "5" }, approver.token)).status, 403);
    assert.equal((await adjust(r.body.data.id, sl.id, { bonus: "5" }, bOfficer.token)).status, 404);
    assert.equal((await adjust(r.body.data.id, randomUUID(), { bonus: "5" })).status, 404);
    assert.equal((await adjust(randomUUID(), sl.id, { bonus: "5" })).status, 404);
    await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Only needed for the checks" });
  });

  it("approval: not by the person who prepared it; fixes every figure; then the run is paid once; nothing can be changed after", async () => {
    const e = await employee({ fullName: "Approval Flow", bankAccount: "998877665544" });
    const r = await createRun(month(4));
    const id = r.body.data.id as string;
    const sl = slipOf(await run(id), e.employeeCode);
    await adjust(id, sl.id, { tds: "1000" });
    assert.equal((await t.api("post", `/payroll/runs/${id}/pay`, approver.token).send({ paidOn: "2026-05-01" })).status, 409, "not approved yet");
    assert.equal((await t.api("post", `/payroll/runs/${id}/approve`, officer.token)).status, 403, "the preparer cannot approve (and has no approval right)");
    const second = await t.makeUser(a, ["ADMINISTRATOR", "PAYROLL_OFFICER"]);
    assert.equal((await t.api("post", `/payroll/runs/${id}/approve`, bApprover.token)).status, 404, "another hospital");
    const makerChecker = await t.makeUser(a, ["ADMINISTRATOR", "PAYROLL_OFFICER"]);
    const mine = await createRun(month(5), makerChecker.token);
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal((await t.api("post", `/payroll/runs/${mine.body.data.id}/approve`, makerChecker.token)).status, 403, "even with both rights, not your own run");
    await t.api("post", `/payroll/runs/${mine.body.data.id}/cancel`, makerChecker.token).send({ reason: "Checked the maker-checker rule" });
    const ap = await t.api("post", `/payroll/runs/${id}/approve`, second.token);
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const v = await run(id);
    assert.deepEqual([v.status, Number(v.net) > 0, v.net === ap.body.data.net], ["APPROVED", true, true]);
    const total = v.slips.reduce((acc, x) => acc.plus(x.net), new Decimal(0));
    assert.equal(s(total), v.net, "the run's total is the sum of its payslips");
    assert.ok(Number(v.employerCost) > Number(v.gross), "employer cost includes the employer's provident fund");
    assert.equal((await adjust(id, sl.id, { bonus: "1" })).status, 409, "an approved run is frozen");
    assert.equal((await t.api("post", `/payroll/runs/${id}/approve`, second.token)).status, 409);
    assert.equal((await t.api("post", `/payroll/runs/${id}/cancel`, officer.token).send({ reason: "Trying to cancel it" })).status, 409);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Payslip" SET bonus = 500, gross = gross + 500, net = net + 500 WHERE id = '${sl.id}'::uuid`), /not a draft/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "Payslip" WHERE id = '${sl.id}'::uuid`), /not a draft/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PayrollRun" SET net = 1 WHERE id = '${id}'::uuid`), /fixed|only be marked paid/);
    assert.equal((await t.api("post", `/payroll/runs/${id}/pay`, officer.token).send({ paidOn: "2026-05-01" })).status, 403);
    assert.equal((await t.api("post", `/payroll/runs/${id}/pay`, second.token).send({ paidOn: "2099-01-01" })).status, 400, "the payment date cannot be in the future");
    const paid = await t.api("post", `/payroll/runs/${id}/pay`, second.token).send({ paidOn: "2026-05-01", reference: "NEFT-BATCH-0042" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal((await t.api("post", `/payroll/runs/${id}/pay`, second.token).send({ paidOn: "2026-05-01" })).status, 409, "already paid");
    const done = await run(id);
    assert.equal(done.status, "PAID");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PayrollRun" SET status = 'DRAFT' WHERE id = '${id}'::uuid`), /paid or cancelled/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PayrollRun" WHERE id = '${id}'::uuid`), /cannot be deleted/);
    for (const action of ["PAYROLL_RUN_CREATED", "PAYROLL_SLIP_ADJUSTED", "PAYROLL_RUN_APPROVED", "PAYROLL_RUN_PAID"]) assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action, entityId: action === "PAYROLL_SLIP_ADJUSTED" ? sl.id : id } }), action);
  });

  it("a cancelled draft frees its month; a run with nobody to pay cannot be approved", async () => {
    const r = await createRun(month(6));
    assert.equal(r.status, 201);
    assert.equal((await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "no" })).status, 400);
    assert.equal((await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, approver.token).send({ reason: "Started by mistake" })).status, 403);
    assert.equal((await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Started by mistake" })).status, 200);
    const again = await createRun(month(6));
    assert.equal(again.status, 201, "the month is free again");
    const stale = await t.prisma.payslip.findFirstOrThrow({ where: { runId: r.body.data.id } });
    assert.equal((await adjust(again.body.data.id, stale.id, { bonus: "1" })).status, 404, "a payslip of another run is not found under this one");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Payslip" SET note = 'x' WHERE id = '${stale.id}'::uuid`), /not a draft/);
    await t.api("post", `/payroll/runs/${again.body.data.id}/cancel`, officer.token).send({ reason: "Checked the month is free" });
  });

  it("employees see only their own payslips, only after approval; payroll staff see all; the payslip prints", async () => {
    const user = await t.makeUser(a, ["NURSE"]);
    const emp = await employee({ fullName: "Self Service", userId: user.id });
    const r = await createRun(month(7));
    const id = r.body.data.id as string;
    const sl = slipOf(await run(id), emp.employeeCode);
    assert.deepEqual((await t.api("get", "/payroll/my-payslips", user.token)).body.data, [], "a draft is not shown");
    assert.equal((await t.api("get", `/print/payslips/${sl.id}`, user.token)).status, 404, "not yet approved");
    const approver2 = await t.makeUser(a, ["ADMINISTRATOR"]);
    await t.api("post", `/payroll/runs/${id}/approve`, approver2.token);
    const list = (await t.api("get", "/payroll/my-payslips", user.token)).body.data as { id: string; month: string; net: string; employee: { code: string } }[];
    assert.deepEqual([list.length, list[0]?.month, list[0]?.employee.code], [1, month(7), emp.employeeCode]);
    const html = await t.api("get", `/print/payslips/${sl.id}`, user.token);
    assert.equal(html.status, 200, JSON.stringify(html.body));
    for (const text of ["Payslip for", month(7), "Self Service", "Provident fund", "Net pay"]) assert.ok(html.text.includes(text), text);
    assert.equal((await t.api("get", `/print/payslips/${sl.id}`, staffUser.token)).status, 404, "someone else's payslip");
    assert.equal((await t.api("get", `/print/payslips/${sl.id}`, bOfficer.token)).status, 404);
    assert.equal((await t.api("get", `/print/payslips/${sl.id}`, officer.token)).status, 200);
    assert.equal((await t.api("get", "/payroll/my-payslips", cashier.token)).status, 200);
    assert.deepEqual((await t.api("get", "/payroll/my-payslips", cashier.token)).body.data, [], "no employee record: nothing to show");
    assert.equal((await t.api("get", "/payroll/my-payslips")).status, 401);
  });

  it("DATABASE: a run needs its checks; a payslip must add up and use the employee's own structure", async () => {
    const e = await employee({ fullName: "Database Check" });
    const other = await employee({ fullName: "Other Person" });
    const r = await createRun(month(8));
    const sl = slipOf(await run(r.body.data.id), e.employeeCode);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Payslip" SET net = net + 1 WHERE id = '${sl.id}'::uuid`), /payslip_values|check constraint/i);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PayrollRun" SET status = 'PAID', "approvedById" = '${approver.id}'::uuid, "approvedAt" = now(), "paidById" = '${approver.id}'::uuid, "paidAt" = now(), "paidOn" = now() WHERE id = '${r.body.data.id}'::uuid`), /approved before it is paid/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PayrollRun" SET status = 'APPROVED', "approvedById" = '${officer.id}'::uuid, "approvedAt" = now() WHERE id = '${r.body.data.id}'::uuid`), /someone other than/);
    const foreign = await t.prisma.salaryStructure.findFirstOrThrow({ where: { employeeId: other.id } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "Payslip" SET "structureId" = '${foreign.id}'::uuid WHERE id = '${sl.id}'::uuid`), /cannot move/);
    await t.api("post", `/payroll/runs/${r.body.data.id}/cancel`, officer.token).send({ reason: "Database checks done" });
  });

  it("concurrency: two people starting the same month make one run; two approvals make one approval", async () => {
    await employee({ fullName: "Race Person" });
    const [x, y] = await Promise.all([createRun(month(9)), createRun(month(9))]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409], JSON.stringify([x.body, y.body]));
    const id = (x.status === 201 ? x : y).body.data.id as string;
    const [p, q] = [await t.makeUser(a, ["ADMINISTRATOR"]), await t.makeUser(a, ["ADMINISTRATOR"])];
    const rs = await Promise.all([t.api("post", `/payroll/runs/${id}/approve`, p.token), t.api("post", `/payroll/runs/${id}/approve`, q.token)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PAYROLL_RUN_APPROVED", entityId: id } }), 1);
  });

  it("the payroll officer role exists with what it needs; the approver is the administrator", async () => {
    const r = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "PAYROLL_OFFICER", isSystem: true }, include: { permissions: true } });
    assert.deepEqual(r.permissions.map((x) => x.permission).sort(), ["PAYROLL_MANAGE", "PAYROLL_READ"]);
    const admin = await t.prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, name: "ADMINISTRATOR", isSystem: true }, include: { permissions: true } });
    assert.ok(admin.permissions.some((x) => x.permission === "PAYROLL_APPROVE"));
  });
});
