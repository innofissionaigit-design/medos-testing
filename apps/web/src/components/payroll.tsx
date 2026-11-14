"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Spinner, Table, Td } from "./ui";
import { PrintLink } from "@/components/print-link";

interface Structure { id: string; effectiveFrom: string; basic: string; hra: string; otherAllowance: string; gross: string }
interface Employee { id: string; employeeCode: string; fullName: string; designation: string; department: string | null; joinedOn: string; status: string; bankAccount: string | null; current: Structure | null }
interface RunRow { id: string; month: string; status: string; gross: string; net: string; payslips: number }
interface Slip { id: string; employee: { code: string; name: string }; daysInMonth: number; lopDays: string; basic: string; hra: string; otherAllowance: string; bonus: string; arrears: string; arrearsNote: string | null; gross: string; pfEmployee: string; esiEmployee: string; professionalTax: string; tds: string; otherDeduction: string; totalDeductions: string; net: string; note: string | null }
interface RunDetail extends RunRow { deductions: string; employerCost: string; preparedBy: string | null; approvedBy: string | null; paidBy: string | null; paidOn: string | null; cancelReason: string | null; slips: Slip[] }
interface Mine extends Slip { month: string; runStatus: string }

const TONE: Record<string, "gray" | "blue" | "green" | "red"> = { DRAFT: "gray", APPROVED: "blue", PAID: "green", CANCELLED: "red" };
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

function SlipEditor({ runId, slip, onClose }: { runId: string; slip: Slip; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ lopDays: slip.lopDays, bonus: slip.bonus, arrears: slip.arrears, arrearsNote: slip.arrearsNote ?? "", tds: slip.tds, otherDeduction: slip.otherDeduction, note: slip.note ?? "" });
  // Pay owed for earlier months (a backdated raise): suggested from the approved payslips of the last year, added once each.
  const sug = useQuery({ queryKey: ["payroll-arrears", runId, slip.id], queryFn: () => api.get<{ payslipId: string; month: string; paid: string; shouldHaveBeen: string; amount: string }[]>(`/payroll/runs/${runId}/payslips/${slip.id}/arrears`) });
  const [picked, setPicked] = useState<string[]>([]);
  const addSuggested = useMutation({ mutationFn: () => api.post<Slip>(`/payroll/runs/${runId}/payslips/${slip.id}/arrears`, { payslipIds: picked }), onSuccess: (s) => { setF((x) => ({ ...x, arrears: s.arrears, arrearsNote: s.arrearsNote ?? "" })); setPicked([]); void sug.refetch(); void qc.invalidateQueries({ queryKey: ["payroll-run", runId] }); } });
  const save = useMutation({ mutationFn: () => api.put(`/payroll/runs/${runId}/payslips/${slip.id}`, { lopDays: Number(f.lopDays), bonus: f.bonus, arrears: f.arrears || "0", arrearsNote: f.arrearsNote.trim() || null, tds: f.tds, otherDeduction: f.otherDeduction, note: f.note.trim() || null }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payroll-run", runId] }); onClose(); } });
  const num = (k: "lopDays" | "bonus" | "arrears" | "tds" | "otherDeduction") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value.replace(/[^0-9.]/g, "") });
  return (
    <Modal title={`${slip.employee.name}: pay for this month`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Days of loss of pay (of ${slip.daysInMonth})`}><Input inputMode="decimal" value={f.lopDays} onChange={num("lopDays")} /></Field>
          <Field label="Bonus"><Input inputMode="decimal" value={f.bonus} onChange={num("bonus")} /></Field>
          <Field label="Arrears (pay owed for earlier months)"><Input inputMode="decimal" value={f.arrears} onChange={num("arrears")} /></Field>
          <Field label="Arrears for"><Input value={f.arrearsNote} placeholder="e.g. raise from December" onChange={(e) => setF({ ...f, arrearsNote: e.target.value })} /></Field>
          <Field label="Income tax (TDS)"><Input inputMode="decimal" value={f.tds} onChange={num("tds")} /></Field>
          <Field label="Other deductions"><Input inputMode="decimal" value={f.otherDeduction} onChange={num("otherDeduction")} /></Field>
        </div>
        {(sug.data?.length ?? 0) > 0 && (
          <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
            <p className="font-medium">Pay owed for earlier months</p>
            {sug.data!.map((s) => (
              <label key={s.payslipId} className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(s.payslipId)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.payslipId] : picked.filter((x) => x !== s.payslipId))} /> {s.month}: paid {s.paid}, should have been {s.shouldHaveBeen} <b>(owed {s.amount})</b></label>
            ))}
            <Button variant="secondary" disabled={picked.length === 0} loading={addSuggested.isPending} onClick={() => addSuggested.mutate()}>Add to this payslip</Button>
            <ErrorNote error={addSuggested.error} />
            <p className="text-xs text-slate-600">Each month can be added once. Arrears are paid on top of this month's pay; provident fund, ESI and professional tax are not recalculated for them.</p>
          </div>
        )}
        <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <p className="text-xs text-slate-500">Provident fund, ESI and professional tax are worked out for you when you save.</p>
        <ErrorNote error={save.error} />
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
    </Modal>
  );
}

function RunModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["payroll-run", runId], queryFn: () => api.get<RunDetail>(`/payroll/runs/${runId}`) });
  const [editing, setEditing] = useState<Slip | null>(null);
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["payroll-run", runId] }); void qc.invalidateQueries({ queryKey: ["payroll-runs"] }); };
  const act = useMutation({ mutationFn: (a: { path: string; body?: Record<string, unknown> }) => api.post(`/payroll/runs/${runId}/${a.path}`, a.body ?? {}, newKey()), onSuccess: refresh });
  const r = q.data;
  if (!r) return <Modal title="Payroll run" onClose={onClose} wide><Spinner /></Modal>;
  const draft = r.status === "DRAFT";
  // While a draft the run's totals are not fixed yet: show the sum of the payslips as they stand (whole paise, for display only; the server fixes the real totals on approval).
  const paise = (v: string) => Math.round(Number(v) * 100);
  const shown = (k: "gross" | "net" | "totalDeductions", fixed: string) => (draft ? (r.slips.reduce((a, x) => a + paise(x[k]), 0) / 100).toFixed(2) : fixed);
  return (
    <Modal title={`Payroll for ${r.month}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={TONE[r.status] ?? "gray"}>{r.status.toLowerCase()}</Badge><span className="text-slate-600">{r.slips.length} payslips · prepared by {r.preparedBy ?? "—"}{r.approvedBy ? ` · approved by ${r.approvedBy}` : ""}{r.paidOn ? ` · paid on ${r.paidOn}` : ""}</span></div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([["Gross pay", shown("gross", r.gross)], ["Deductions", shown("totalDeductions", r.deductions)], ["Net to pay", shown("net", r.net)], ["Cost to hospital", draft ? "" : r.employerCost]] as const).map(([k, v]) => <div key={k} className="rounded-md border border-slate-200 p-2"><div className="text-xs text-slate-500">{k}</div><div className="font-medium">{v ? money(v) : "—"}</div></div>)}
        </div>
        {draft && <Notice>Totals are fixed when the run is approved. Enter days of loss of pay, bonus and TDS on each payslip first.</Notice>}
        {r.cancelReason && <Notice tone="error">Cancelled: {r.cancelReason}</Notice>}
        <ErrorNote error={act.error} />
        <Table head={["Employee", "Days lost", "Gross", "PF", "ESI", "Prof. tax", "TDS", "Net", ""]}>
          {r.slips.map((s) => (
            <tr key={s.id}><Td>{s.employee.name}<div className="text-xs text-slate-500">{s.employee.code}</div></Td><Td>{s.lopDays}</Td><Td>{money(s.gross)}</Td><Td>{money(s.pfEmployee)}</Td><Td>{money(s.esiEmployee)}</Td><Td>{money(s.professionalTax)}</Td><Td>{money(s.tds)}</Td><Td className="font-medium">{money(s.net)}</Td>
              <Td className="whitespace-nowrap">{draft && can("PAYROLL_MANAGE") && <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button>} <PrintLink className="text-brand-700" href={printUrl(`payslips/${s.id}`)}>Payslip</PrintLink></Td></tr>
          ))}
        </Table>
        <div className="flex flex-wrap items-end gap-2">
          {draft && can("PAYROLL_APPROVE") && <Button loading={act.isPending} onClick={() => act.mutate({ path: "approve" })}>Approve payroll</Button>}
          {r.status === "APPROVED" && can("PAYROLL_APPROVE") && <>
            <Field label="Paid on"><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
            <Field label="Bank batch reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <Button loading={act.isPending} onClick={() => act.mutate({ path: "pay", body: { paidOn, ...(reference.trim().length >= 4 ? { reference: reference.trim() } : {}) } })}>Mark as paid</Button>
          </>}
          {draft && can("PAYROLL_MANAGE") && <><Field label="Reason to cancel" className="min-w-52 flex-1"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Button variant="secondary" disabled={reason.trim().length < 5} onClick={() => act.mutate({ path: "cancel", body: { reason: reason.trim() } })}>Cancel this draft</Button></>}
        </div>
      </div>
      {editing && <SlipEditor runId={runId} slip={editing} onClose={() => setEditing(null)} />}
    </Modal>
  );
}

export function PayrollRuns() {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["payroll-runs"], queryFn: () => api.get<RunRow[]>("/payroll/runs") });
  const [month, setMonth] = useState(thisMonth());
  const [open, setOpen] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [incomplete, setIncomplete] = useState<string[]>([]);
  const create = useMutation({ mutationFn: () => api.post<{ id: string; skipped: { fullName: string; reason: string }[]; incomplete: { fullName: string; unmarkedDays: number }[] }>("/payroll/runs", { month }), onSuccess: (r) => { setSkipped(r.skipped.map((s) => `${s.fullName}: ${s.reason}`)); setIncomplete(r.incomplete.map((s) => `${s.fullName} (${s.unmarkedDays})`)); void qc.invalidateQueries({ queryKey: ["payroll-runs"] }); setOpen(r.id); } });
  return (
    <Card title="Monthly payroll">
      {can("PAYROLL_MANAGE") && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <Button loading={create.isPending} onClick={() => create.mutate()}>Start this month's payroll</Button>
        </div>
      )}
      <ErrorNote error={create.error} />
      {skipped.length > 0 && <Notice tone="warn">Left out: {skipped.join("; ")}</Notice>}
      {incomplete.length > 0 && <Notice tone="warn">Attendance not marked for some days (not charged as loss of pay): {incomplete.join("; ")}. Days of loss of pay can still be edited on each payslip while the run is a draft.</Notice>}
      {list.isLoading ? <Spinner /> : (
        <Table head={["Month", "Status", "Payslips", "Gross", "Net", ""]} {...(list.data?.length === 0 ? { empty: "No payroll run yet." } : {})}>
          {list.data?.map((r) => <tr key={r.id}><Td>{r.month}</Td><Td><Badge tone={TONE[r.status] ?? "gray"}>{r.status.toLowerCase()}</Badge></Td><Td>{r.payslips}</Td><Td>{money(r.gross)}</Td><Td>{money(r.net)}</Td><Td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open</Button></Td></tr>)}
        </Table>
      )}
      {open && <RunModal runId={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function PayModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["structures", employee.id], queryFn: () => api.get<Structure[]>(`/payroll/employees/${employee.id}/structures`) });
  const [f, setF] = useState({ effectiveFrom: today(), basic: "", hra: "0", otherAllowance: "0" });
  const save = useMutation({ mutationFn: () => api.post(`/payroll/employees/${employee.id}/structures`, { effectiveFrom: f.effectiveFrom, basic: f.basic, hra: f.hra || "0", otherAllowance: f.otherAllowance || "0" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["structures", employee.id] }); void qc.invalidateQueries({ queryKey: ["payroll-employees"] }); setF({ ...f, basic: "" }); } });
  const { money, can } = useMe();
  const num = (k: "basic" | "hra" | "otherAllowance") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value.replace(/[^0-9.]/g, "") });
  return (
    <Modal title={`Pay of ${employee.fullName}`} onClose={onClose}>
      <div className="space-y-3">
        <Table head={["From", "Basic", "HRA", "Other", "Gross"]} {...(list.data?.length === 0 ? { empty: "No pay set yet." } : {})}>
          {list.data?.map((s) => <tr key={s.id}><Td>{s.effectiveFrom}</Td><Td>{money(s.basic)}</Td><Td>{money(s.hra)}</Td><Td>{money(s.otherAllowance)}</Td><Td className="font-medium">{money(s.gross)}</Td></tr>)}
        </Table>
        {can("PAYROLL_MANAGE") && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <p className="text-sm font-medium">New pay from a date (earlier pay is kept)</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From"><Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
              <Field label="Basic"><Input inputMode="decimal" value={f.basic} onChange={num("basic")} /></Field>
              <Field label="House rent allowance"><Input inputMode="decimal" value={f.hra} onChange={num("hra")} /></Field>
              <Field label="Other allowance"><Input inputMode="decimal" value={f.otherAllowance} onChange={num("otherAllowance")} /></Field>
            </div>
            <ErrorNote error={save.error} />
            <Button disabled={!f.basic} loading={save.isPending} onClick={() => save.mutate()}>Save pay</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function PayrollEmployees() {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["payroll-employees"], queryFn: () => api.get<{ items: Employee[] }>("/payroll/employees", { pageSize: 100 }) });
  const [adding, setAdding] = useState(false);
  const [pay, setPay] = useState<Employee | null>(null);
  const [f, setF] = useState({ fullName: "", designation: "", department: "", joinedOn: today() });
  const add = useMutation({ mutationFn: () => api.post<Employee>("/payroll/employees", { fullName: f.fullName.trim(), designation: f.designation.trim(), joinedOn: f.joinedOn, ...(f.department.trim() ? { department: f.department.trim() } : {}) }), onSuccess: (e) => { setAdding(false); setF({ fullName: "", designation: "", department: "", joinedOn: today() }); void qc.invalidateQueries({ queryKey: ["payroll-employees"] }); setPay(e); } });
  const toggle = useMutation({ mutationFn: (e: Employee) => api.patch(`/payroll/employees/${e.id}`, { status: e.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payroll-employees"] }); } });
  return (
    <Card title="Employees" actions={can("PAYROLL_MANAGE") ? <Button onClick={() => setAdding(true)}>Add employee</Button> : undefined}>
      <ErrorNote error={toggle.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["Code", "Name", "Designation", "Joined", "Gross pay", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No employees yet." } : {})}>
          {list.data?.items.map((e) => (
            <tr key={e.id}><Td>{e.employeeCode}</Td><Td>{e.fullName}{e.department ? <div className="text-xs text-slate-500">{e.department}</div> : null}</Td><Td>{e.designation}</Td><Td>{e.joinedOn}</Td><Td>{e.current ? money(e.current.gross) : <span className="text-amber-700">no pay set</span>}</Td><Td><Badge tone={e.status === "ACTIVE" ? "green" : "gray"}>{e.status.toLowerCase()}</Badge></Td>
              <Td className="whitespace-nowrap"><Button variant="secondary" onClick={() => setPay(e)}>Pay</Button>{can("PAYROLL_MANAGE") && <> <Button variant="secondary" onClick={() => toggle.mutate(e)}>{e.status === "ACTIVE" ? "Make inactive" : "Make active"}</Button></>}</Td></tr>
          ))}
        </Table>
      )}
      {adding && (
        <Modal title="Add employee" onClose={() => setAdding(false)}>
          <div className="space-y-2">
            <Field label="Full name"><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
            <Field label="Designation"><Input value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
            <Field label="Department (optional)"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
            <Field label="Joined on"><Input type="date" value={f.joinedOn} onChange={(e) => setF({ ...f, joinedOn: e.target.value })} /></Field>
            <ErrorNote error={add.error} />
            <Button disabled={f.fullName.trim().length < 2 || f.designation.trim().length < 2} loading={add.isPending} onClick={() => add.mutate()}>Add and set pay</Button>
          </div>
        </Modal>
      )}
      {pay && <PayModal employee={pay} onClose={() => setPay(null)} />}
    </Card>
  );
}

/** The signed-in person's own payslips, once a run has been approved. Shown on the account page; empty for people who are not on the payroll. */
export function MyPayslips() {
  const { money } = useMe();
  const q = useQuery({ queryKey: ["my-payslips"], queryFn: () => api.get<Mine[]>("/payroll/my-payslips") });
  if (!q.data || q.data.length === 0) return null;
  return (
    <Card title="My payslips">
      <Table head={["Month", "Gross", "Deductions", "Net pay", "Status", ""]}>
        {q.data.map((p) => <tr key={p.id}><Td>{p.month}</Td><Td>{money(p.gross)}</Td><Td>{money(p.totalDeductions)}</Td><Td className="font-medium">{money(p.net)}</Td><Td><Badge tone={p.runStatus === "PAID" ? "green" : "blue"}>{p.runStatus.toLowerCase()}</Badge></Td><Td><PrintLink className="text-brand-700" href={printUrl(`payslips/${p.id}`)}>Print</PrintLink></Td></tr>)}
      </Table>
    </Card>
  );
}
