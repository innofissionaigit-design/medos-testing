"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Spinner, Table, Td, Textarea } from "./ui";

interface Day { status: string; leave: string | null; note: string | null; halfDay: boolean; calendar: boolean }
interface Sheet {
  month: string; daysInMonth: number; locked: boolean; runStatus: string | null;
  employees: { id: string; code: string; name: string; unmarked: number; days: (Day | null)[]; present: number; absent: number; halfDay: number; paidLeave: number; unpaidLeave: number; weeklyOff: number; holiday: number; lossOfPay: string }[];
}
interface LeaveType { id: string; name: string; isPaid: boolean; yearlyAllowance: string | null; carryForwardMax: string; status: string }
interface Leave { id: string; employee: { id: string; code: string; name: string }; leaveType: { id: string; name: string; isPaid: boolean }; fromDate: string; toDate: string; halfDay: boolean; days: string | null; reason: string | null; status: string; decisionNote: string | null }
interface Balance { leaveTypeId: string; name: string; allowance: string | null; carriedIn: string; taken: string; remaining: string | null }
interface Mine { linked: boolean; types: LeaveType[]; balances: Balance[]; requests: Leave[] }
interface Holiday { id: string; date: string; name: string }
interface ImportResult { applied: boolean; marked: number; skipped: number; rejected: number; rows: { row: number; employeeCode: string; date: string; action: string; status?: string; hours?: number; reason?: string }[] }

const STATUS_LABEL: Record<string, string> = { PRESENT: "Present", ABSENT: "Absent", HALF_DAY: "Half day", WEEKLY_OFF: "Weekly off", HOLIDAY: "Holiday", ON_LEAVE: "On leave" };
const LEAVE_TONE: Record<string, "gray" | "blue" | "green" | "red"> = { PENDING: "blue", APPROVED: "green", REJECTED: "red", CANCELLED: "gray" };
const today = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);

/** The day's attendance sheet: everyone starts as they were last marked (weekly offs and holidays come from the calendar), and one save marks the whole day. */
function DaySheet() {
  const { can } = useMe();
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const month = date.slice(0, 7);
  const q = useQuery({ queryKey: ["attendance", month], queryFn: () => api.get<Sheet>("/payroll/attendance", { month }) });
  const [marks, setMarks] = useState<Record<string, string>>({});
  const canMark = can("ATTENDANCE_MANAGE");
  const d = Number(date.slice(8, 10)) - 1;
  const startFor = (e: Sheet["employees"][number]) => e.days[d]?.status ?? "PRESENT";
  useEffect(() => {
    if (!q.data || q.data.month !== month) return;
    setMarks(Object.fromEntries(q.data.employees.map((e) => [e.id, startFor(e)])));
  }, [q.data, date, month]);
  const save = useMutation({
    mutationFn: () => api.put("/payroll/attendance", { date, entries: (q.data?.employees ?? []).filter((e) => marks[e.id] && marks[e.id] !== "ON_LEAVE").map((e) => ({ employeeId: e.id, status: marks[e.id] })) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["attendance", month] }),
  });
  return (
    <div className="space-y-4">
      <Card title="Attendance for a day">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Date"><Input type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
          {canMark && <Button variant="secondary" onClick={() => setMarks(Object.fromEntries((q.data?.employees ?? []).map((e) => [e.id, e.days[d]?.status === "ON_LEAVE" ? "ON_LEAVE" : e.days[d]?.calendar ? e.days[d]!.status : "PRESENT"])))}>Everyone present (offs and holidays kept)</Button>}
        </div>
        {q.data?.locked && <div className="mb-3"><Notice tone="warn">Payroll for {month} has been started ({q.data.runStatus?.toLowerCase()}), so its attendance is locked. To correct it, cancel the draft payroll run first.</Notice></div>}
        {q.isLoading ? <Spinner /> : (
          <Table head={["Employee", "Status"]} {...(q.data?.employees.length === 0 ? { empty: "No employees were working this month." } : {})}>
            {q.data?.employees.map((e) => (
              <tr key={e.id}>
                <Td>{e.name}<div className="text-xs text-slate-500">{e.code}</div></Td>
                <Td>{e.days[d]?.status === "ON_LEAVE"
                  ? <Badge tone="blue">{e.days[d]?.halfDay ? "Half day of leave" : "On leave"}{e.days[d]?.leave ? `: ${e.days[d]?.leave}` : ""}</Badge>
                  : <div className="flex items-center gap-2"><Select aria-label={`Attendance of ${e.name}`} disabled={!canMark || q.data?.locked} value={marks[e.id] ?? "PRESENT"} onChange={(ev) => setMarks({ ...marks, [e.id]: ev.target.value })}>
                    {["PRESENT", "ABSENT", "HALF_DAY", "WEEKLY_OFF", "HOLIDAY"].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </Select>{e.days[d]?.calendar && <span className="text-xs text-slate-500">{e.days[d]?.note ?? "weekly off"}</span>}</div>}</Td>
              </tr>
            ))}
          </Table>
        )}
        {canMark && !q.data?.locked && <div className="mt-3"><Button loading={save.isPending} disabled={!q.data || q.data.employees.length === 0} onClick={() => save.mutate()}>Save this day</Button><ErrorNote error={save.error} />{save.isSuccess && <span className="ml-2 text-sm text-green-700">Saved</span>}</div>}
      </Card>

      <Card title={`Month summary: ${month}`}>
        <Table head={["Employee", "Present", "Absent", "Half day", "Leave (paid)", "Leave (unpaid)", "Off / holiday", "Days not marked", "Days of loss of pay"]} {...(q.data?.employees.length === 0 ? { empty: "Nothing to show." } : {})}>
          {q.data?.employees.map((e) => (
            <tr key={e.id}><Td>{e.name}</Td><Td>{e.present}</Td><Td>{e.absent}</Td><Td>{e.halfDay}</Td><Td>{e.paidLeave}</Td><Td>{e.unpaidLeave}</Td><Td>{e.weeklyOff + e.holiday}</Td>
              <Td>{e.unmarked > 0 ? <span className="text-amber-700">{e.unmarked}</span> : 0}</Td><Td className="font-medium">{e.lossOfPay}</Td></tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Weekly offs (set in Administration → Settings) and holidays need no marking. Other days nobody marked are not charged as loss of pay: complete the sheet before starting the month's payroll.</p>
      </Card>
    </div>
  );
}

/** Reads a time-clock export pasted as lines of: employee code, date, in time, out time. Shows what would happen before anything is written. */
function TimeClockImport() {
  const qc = useQueryClient();
  const [textValue, setTextValue] = useState("");
  const [hours, setHours] = useState({ full: "8", half: "4" });
  const [result, setResult] = useState<ImportResult | null>(null);
  const rows = textValue.split("\n").map((l) => l.trim()).filter((l) => l && !/^employee/i.test(l)).map((l) => {
    const [employeeCode = "", date = "", timeIn = "", timeOut = ""] = l.split(/[,\t;]/).map((x) => x.trim());
    return { employeeCode, date, ...(timeIn ? { timeIn } : {}), ...(timeOut ? { timeOut } : {}) };
  });
  const run = useMutation({
    mutationFn: (apply: boolean) => api.post<ImportResult>("/payroll/attendance/import", { rows, fullDayHours: Number(hours.full), halfDayHours: Number(hours.half), apply }),
    onSuccess: (r) => { setResult(r); if (r.applied) void qc.invalidateQueries({ queryKey: ["attendance"] }); },
  });
  const ready = rows.length > 0 && Number(hours.full) > Number(hours.half) && Number(hours.half) > 0;
  return (
    <Card title="Import from a time clock">
      <p className="mb-2 text-sm text-slate-600">Paste one line per employee per day: <code>employee code, date (2026-11-02), in time (09:00), out time (17:30)</code>. The hours between first in and last out decide the mark. Check the preview, then apply.</p>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="Hours for a full day"><Input inputMode="decimal" value={hours.full} onChange={(e) => setHours({ ...hours, full: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
        <Field label="Hours for a half day"><Input inputMode="decimal" value={hours.half} onChange={(e) => setHours({ ...hours, half: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
      </div>
      <Textarea aria-label="Time clock lines" rows={6} value={textValue} onChange={(e) => { setTextValue(e.target.value); setResult(null); }} placeholder={"EMP-0001, 2026-11-02, 09:00, 17:30\nEMP-0002, 2026-11-02, 21:00, 06:00"} />
      <ErrorNote error={run.error} />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!ready} loading={run.isPending} onClick={() => run.mutate(false)}>Preview</Button>
        <Button disabled={!ready || !result || result.applied || result.marked === 0} loading={run.isPending} onClick={() => run.mutate(true)}>Apply {result && !result.applied ? `${result.marked} marks` : ""}</Button>
      </div>
      {result && (
        <div className="mt-3 space-y-2">
          <Notice tone={result.applied ? "success" : "info"}>{result.applied ? "Applied: " : "Preview: "}{result.marked} to mark, {result.skipped} left alone, {result.rejected} rejected.</Notice>
          <Table head={["Line", "Employee", "Date", "What happens"]}>
            {result.rows.map((r) => <tr key={r.row}><Td>{r.row}</Td><Td>{r.employeeCode}</Td><Td>{r.date}</Td><Td>{r.action === "MARK" ? <Badge tone="green">{STATUS_LABEL[r.status ?? ""] ?? r.status}{r.hours !== undefined ? ` (${r.hours} h)` : ""}</Badge> : <span className={r.action === "REJECT" ? "text-red-700" : "text-slate-500"}>{r.action === "REJECT" ? "Rejected" : "Left alone"}: {r.reason}</span>}</Td></tr>)}
          </Table>
        </div>
      )}
    </Card>
  );
}

export function AttendanceSheet() {
  return <div className="space-y-4"><DaySheet /><TimeClockImport /></div>;
}

/** The public-holiday calendar: a holiday needs no attendance and is not charged. Held for the year; holidays of a month with a payroll run cannot change. */
export function HolidaysCard() {
  const { can } = useMe();
  const qc = useQueryClient();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const q = useQuery({ queryKey: ["holidays", year], queryFn: () => api.get<Holiday[]>("/payroll/holidays", { year }) });
  const [f, setF] = useState({ date: today(), name: "" });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["holidays"] }); void qc.invalidateQueries({ queryKey: ["attendance"] }); };
  const add = useMutation({ mutationFn: () => api.post("/payroll/holidays", { date: f.date, name: f.name.trim() }), onSuccess: () => { setF({ ...f, name: "" }); refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/payroll/holidays/${id}/remove`, {}), onSuccess: refresh });
  return (
    <Card title="Holidays" actions={<Select aria-label="Year" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>{[year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i).map((y) => <option key={y} value={y}>{y}</option>)}</Select>}>
      {can("PAYROLL_MANAGE") && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Name" className="min-w-52 flex-1"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Button disabled={f.name.trim().length < 2 || !f.date} loading={add.isPending} onClick={() => add.mutate()}>Add holiday</Button>
        </div>
      )}
      <ErrorNote error={add.error ?? remove.error} />
      {q.isLoading ? <Spinner /> : (
        <Table head={["Date", "Holiday", ""]} {...(q.data?.length === 0 ? { empty: "No holidays added for this year." } : {})}>
          {q.data?.map((h) => <tr key={h.id}><Td>{h.date}</Td><Td>{h.name}</Td><Td>{can("PAYROLL_MANAGE") && <Button variant="secondary" onClick={() => remove.mutate(h.id)}>Remove</Button>}</Td></tr>)}
        </Table>
      )}
    </Card>
  );
}

/** The hospital's leave types: paid or not, the yearly allowance (blank = no limit) and how many unused days carry into the next year. */
export function LeaveTypesCard() {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["leave-types"], queryFn: () => api.get<LeaveType[]>("/payroll/leave-types") });
  const [f, setF] = useState({ name: "", isPaid: true, yearlyAllowance: "", carryForwardMax: "0" });
  const [editing, setEditing] = useState<Record<string, { yearlyAllowance: string; carryForwardMax: string }>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ["leave-types"] });
  const standard = useMutation({ mutationFn: () => api.post("/payroll/leave-types/standard", {}), onSuccess: refresh });
  const add = useMutation({ mutationFn: () => api.post("/payroll/leave-types", { name: f.name.trim(), isPaid: f.isPaid, yearlyAllowance: f.yearlyAllowance.trim() === "" ? null : Number(f.yearlyAllowance), carryForwardMax: Number(f.carryForwardMax || 0) }), onSuccess: () => { setF({ ...f, name: "", yearlyAllowance: "", carryForwardMax: "0" }); refresh(); } });
  const save = useMutation({ mutationFn: (v: { id: string; yearlyAllowance: string; carryForwardMax: string }) => api.patch(`/payroll/leave-types/${v.id}`, { yearlyAllowance: v.yearlyAllowance.trim() === "" ? null : Number(v.yearlyAllowance), carryForwardMax: Number(v.carryForwardMax || 0) }), onSuccess: (_r, v) => { setEditing((e) => { const n = { ...e }; delete n[v.id]; return n; }); refresh(); } });
  const manage = can("PAYROLL_MANAGE");
  const num = (s: string) => s.replace(/[^0-9.]/g, "");
  return (
    <Card title="Leave types" actions={manage && q.data?.length === 0 ? <Button variant="secondary" loading={standard.isPending} onClick={() => standard.mutate()}>Add the usual leave types</Button> : undefined}>
      {q.data?.length === 0 && manage && <div className="mb-3"><Notice>The usual types (casual, sick, earned, without pay) are a starting point only: change the days to match your hospital's leave policy.</Notice></div>}
      <ErrorNote error={standard.error ?? add.error ?? save.error} />
      {q.isLoading ? <Spinner /> : (
        <Table head={["Leave type", "Paid", "Days a year", "Carry forward up to", ""]} {...(q.data?.length === 0 ? { empty: "No leave types yet." } : {})}>
          {q.data?.map((t) => {
            const e = editing[t.id];
            return (
              <tr key={t.id}><Td>{t.name}{t.status !== "ACTIVE" && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}</Td><Td>{t.isPaid ? "Yes" : "No"}</Td>
                <Td>{e ? <Input aria-label="Days a year" inputMode="decimal" value={e.yearlyAllowance} placeholder="No limit" onChange={(ev) => setEditing({ ...editing, [t.id]: { ...e, yearlyAllowance: num(ev.target.value) } })} /> : t.yearlyAllowance ?? "No limit"}</Td>
                <Td>{e ? <Input aria-label="Carry forward" inputMode="decimal" value={e.carryForwardMax} onChange={(ev) => setEditing({ ...editing, [t.id]: { ...e, carryForwardMax: num(ev.target.value) } })} /> : Number(t.carryForwardMax) > 0 ? `${t.carryForwardMax} days` : "None"}</Td>
                <Td className="whitespace-nowrap">{manage && (e ? <><Button loading={save.isPending} onClick={() => save.mutate({ id: t.id, ...e })}>Save</Button> <Button variant="secondary" onClick={() => setEditing((x) => { const n = { ...x }; delete n[t.id]; return n; })}>Cancel</Button></> : <Button variant="secondary" onClick={() => setEditing({ ...editing, [t.id]: { yearlyAllowance: t.yearlyAllowance ?? "", carryForwardMax: t.carryForwardMax } })}>Change days</Button>)}</Td></tr>
            );
          })}
        </Table>
      )}
      {manage && (
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          <Field label="New leave type"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Paid?"><Select value={f.isPaid ? "yes" : "no"} onChange={(e) => setF({ ...f, isPaid: e.target.value === "yes" })}><option value="yes">Paid</option><option value="no">Unpaid</option></Select></Field>
          <Field label="Days a year (blank = no limit)"><Input inputMode="decimal" value={f.yearlyAllowance} onChange={(e) => setF({ ...f, yearlyAllowance: num(e.target.value) })} /></Field>
          <Field label="Carry forward up to"><Input inputMode="decimal" value={f.carryForwardMax} onChange={(e) => setF({ ...f, carryForwardMax: num(e.target.value) })} /></Field>
          <div className="flex items-end"><Button disabled={f.name.trim().length < 2} loading={add.isPending} onClick={() => add.mutate()}>Add</Button></div>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">Carry forward: the unused part of last year's days, up to this limit, is added for people who were here last year. A leave type that has been used cannot switch between paid and unpaid.</p>
    </Card>
  );
}

function LeaveList({ rows, children }: { rows: Leave[]; children?: (l: Leave) => React.ReactNode }) {
  return (
    <Table head={["Employee", "Leave", "From", "To", "Days", "Status", ""]} {...(rows.length === 0 ? { empty: "No leave applications." } : {})}>
      {rows.map((l) => (
        <tr key={l.id}>
          <Td>{l.employee.name}<div className="text-xs text-slate-500">{l.employee.code}</div></Td>
          <Td>{l.leaveType.name}{!l.leaveType.isPaid && <div className="text-xs text-slate-500">unpaid</div>}{l.halfDay && <div className="text-xs text-slate-500">half day</div>}{l.reason && <div className="text-xs text-slate-500">{l.reason}</div>}</Td>
          <Td>{l.fromDate}</Td><Td>{l.toDate}</Td><Td>{l.days ?? (l.halfDay ? "0.5" : "-")}</Td>
          <Td><Badge tone={LEAVE_TONE[l.status] ?? "gray"}>{l.status.toLowerCase()}</Badge>{l.decisionNote && <div className="text-xs text-slate-500">{l.decisionNote}</div>}</Td>
          <Td className="whitespace-nowrap">{children?.(l)}</Td>
        </tr>
      ))}
    </Table>
  );
}

/** Leave for the hospital: the payroll officer enters leave for anyone; the approver decides (never on their own leave). */
export function LeaveManager() {
  const { can } = useMe();
  const qc = useQueryClient();
  const [status, setStatus] = useState("PENDING");
  const types = useQuery({ queryKey: ["leave-types"], queryFn: () => api.get<LeaveType[]>("/payroll/leave-types") });
  const list = useQuery({ queryKey: ["leave-requests", status], queryFn: () => api.get<{ items: Leave[] }>("/payroll/leave-requests", { ...(status ? { status } : {}), pageSize: 100 }) });
  const emps = useQuery({ queryKey: ["payroll-employees-all"], queryFn: () => api.get<{ items: { id: string; employeeCode: string; fullName: string; status: string }[] }>("/payroll/employees", { status: "ACTIVE", pageSize: 100 }), enabled: can("ATTENDANCE_MANAGE") });
  const [f, setF] = useState({ employeeId: "", leaveTypeId: "", fromDate: today(), toDate: today(), halfDay: false, reason: "" });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["leave-requests"] }); void qc.invalidateQueries({ queryKey: ["attendance"] }); };
  const enter = useMutation({ mutationFn: () => api.post("/payroll/leave-requests", { employeeId: f.employeeId, leaveTypeId: f.leaveTypeId, fromDate: f.fromDate, toDate: f.halfDay ? f.fromDate : f.toDate, halfDay: f.halfDay, ...(f.reason.trim().length >= 3 ? { reason: f.reason.trim() } : {}) }), onSuccess: () => { setF({ ...f, reason: "" }); refresh(); } });
  const act = useMutation({ mutationFn: (a: { id: string; what: "approve" | "reject" | "cancel"; body?: Record<string, unknown> }) => api.post(`/payroll/leave-requests/${a.id}/${a.what}`, a.body ?? {}), onSuccess: () => { setRejecting(null); setNote(""); refresh(); } });
  const active = (types.data ?? []).filter((t) => t.status === "ACTIVE");
  return (
    <div className="space-y-4">
      <LeaveTypesCard />
      {can("ATTENDANCE_MANAGE") && (
        <Card title="Enter leave for an employee">
          <div className="grid gap-2 sm:grid-cols-5">
            <Field label="Employee"><Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose</option>{emps.data?.items.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}</Select></Field>
            <Field label="Leave type"><Select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}><option value="">Choose</option>{active.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? "" : " (unpaid)"}</option>)}</Select></Field>
            <Field label="From"><Input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: e.target.value > f.toDate ? e.target.value : f.toDate })} /></Field>
            <Field label="To"><Input type="date" disabled={f.halfDay} value={f.halfDay ? f.fromDate : f.toDate} min={f.fromDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></Field>
            <Field label="Reason (optional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.checked })} /> Half a day only (a single day, the other half is worked)</label>
          <ErrorNote error={enter.error} />
          <div className="mt-2"><Button disabled={!f.employeeId || !f.leaveTypeId || !f.fromDate || !f.toDate} loading={enter.isPending} onClick={() => enter.mutate()}>Apply for leave</Button></div>
        </Card>
      )}
      <Card title="Leave applications" actions={<Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="PENDING">Waiting</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option><option value="">All</option></Select>}>
        <ErrorNote error={act.error} />
        {list.isLoading ? <Spinner /> : (
          <LeaveList rows={list.data?.items ?? []}>
            {(l) => (
              <>
                {l.status === "PENDING" && can("LEAVE_APPROVE") && <><Button loading={act.isPending} onClick={() => act.mutate({ id: l.id, what: "approve" })}>Approve</Button> <Button variant="secondary" onClick={() => { act.reset(); setRejecting(l.id); setNote(""); }}>Reject</Button> </>}
                {(l.status === "PENDING" || l.status === "APPROVED") && can("ATTENDANCE_MANAGE") && <Button variant="secondary" onClick={() => act.mutate({ id: l.id, what: "cancel" })}>Cancel</Button>}
              </>
            )}
          </LeaveList>
        )}
        {rejecting && (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            <Field label="Reason for rejecting (the employee will see it)" className="min-w-64 flex-1"><Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Button variant="danger" disabled={note.trim().length < 3} loading={act.isPending} onClick={() => act.mutate({ id: rejecting, what: "reject", body: { note: note.trim() } })}>Reject leave</Button>
            <Button variant="secondary" onClick={() => setRejecting(null)}>Keep waiting</Button>
          </div>
        )}
      </Card>
      <HolidaysCard />
    </div>
  );
}

/** The signed-in employee's own leave: balances, a short form to apply, and their applications. Empty for people who are not linked to an employee record. */
export function MyLeave() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["my-leave"], queryFn: () => api.get<Mine>("/payroll/my-leave") });
  const [f, setF] = useState({ leaveTypeId: "", fromDate: today(), toDate: today(), halfDay: false, reason: "" });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["my-leave"] });
  const apply = useMutation({ mutationFn: () => api.post("/payroll/my-leave", { leaveTypeId: f.leaveTypeId, fromDate: f.fromDate, toDate: f.halfDay ? f.fromDate : f.toDate, halfDay: f.halfDay, ...(f.reason.trim().length >= 3 ? { reason: f.reason.trim() } : {}) }), onSuccess: () => { setF({ ...f, reason: "" }); refresh(); } });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/payroll/my-leave/${id}/cancel`, {}), onSuccess: refresh });
  if (!q.data?.linked) return null;
  return (
    <Card title="My leave">
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        {q.data.balances.map((b) => <Badge key={b.leaveTypeId} tone="gray">{b.name}: {b.remaining === null ? `${b.taken} taken` : `${b.remaining} left of ${b.allowance}${Number(b.carriedIn) > 0 ? ` + ${b.carriedIn} from last year` : ""}`}</Badge>)}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Leave type"><Select value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}><option value="">Choose</option>{q.data.types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? "" : " (unpaid)"}</option>)}</Select></Field>
        <Field label="From"><Input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: e.target.value > f.toDate ? e.target.value : f.toDate })} /></Field>
        <Field label="To"><Input type="date" disabled={f.halfDay} value={f.halfDay ? f.fromDate : f.toDate} min={f.fromDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} /></Field>
        <Field label="Reason (optional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.checked })} /> Half a day only</label>
      <ErrorNote error={apply.error ?? cancel.error} />
      <div className="mt-2 mb-3"><Button disabled={!f.leaveTypeId} loading={apply.isPending} onClick={() => apply.mutate()}>Apply for leave</Button></div>
      <LeaveList rows={q.data.requests}>
        {(l) => (l.status === "PENDING" || l.status === "APPROVED") && new Date(l.fromDate) > new Date() ? <Button variant="secondary" onClick={() => cancel.mutate(l.id)}>Cancel</Button> : null}
      </LeaveList>
    </Card>
  );
}
