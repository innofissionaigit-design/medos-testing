"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

// The discharge flow screens (docs/discharge-flow.md): the checklist with its clocks on the admission, the family's sheet, the board of everyone
// waiting to go home, and the management report. The server decides every clock and every state; these screens only show them.

type ClockState = "ON_TIME" | "REMINDER_DUE" | "OVERDUE";
interface Reason { code: string; label: string; note: string | null; at: string }
export interface FlowItem { stage: string; label: string; owner: string; state: ClockState; deadline: string | null; waitingMinutes: number; blockers: string[]; reason: Reason | null; mine: boolean }
interface InsurerClock { startedAt: string; answeredAt: string | null; elapsedMinutes: number; state: ClockState; deadline: string; targetMinutes: number; reminderMinutes: number; reason: Reason | null; mine: boolean }
export interface Flow {
  admissionId: string; admissionNumber: string; patientName: string; admissionStatus: string; bed?: string | null;
  plan: { expectedDate: string; note: string | null } | null;
  fitToGo: { at: string; byName: string | null } | null;
  clock: { running: boolean; startedAt: string | null; stoppedAt: string | null; elapsedMinutes: number; state: ClockState; deadline: string | null; targetMinutes: number; reminderMinutes: number };
  items: FlowItem[]; insurer: InsurerClock | null;
}

const REASONS: [string, string][] = [
  ["WAITING_FOR_INSURANCE", "Waiting for insurance"], ["FAMILY_ARRANGING_MONEY", "Family arranging money"], ["SUMMARY_NOT_WRITTEN", "Summary not written"],
  ["WAITING_FOR_LAB_OR_REPORT", "Waiting for a test or report"], ["WAITING_FOR_MEDICINES", "Waiting for medicines"], ["WAITING_FOR_DOCTOR", "Waiting for the doctor"],
  ["WAITING_FOR_TRANSPORT", "Waiting for transport"], ["PATIENT_OR_FAMILY_NOT_READY", "Patient or family not ready"], ["OTHER", "Other reason"],
];
const TONE = { ON_TIME: "green", REMINDER_DUE: "amber", OVERDUE: "red" } as const;
const STATE_TEXT = { ON_TIME: "on time", REMINDER_DUE: "running late", OVERDUE: "overdue" } as const;

const hm = (m: number, t: (s: string) => string = (s) => s) => (m >= 60 ? `${Math.floor(m / 60)} ${t("h")} ${m % 60} ${t("min")}` : `${m} ${t("min")}`);

export function ClockBadge({ state, minutes, target }: { state: ClockState; minutes: number; target: number }) {
  const t = useT();
  return <Badge tone={TONE[state]}>{`${hm(minutes, t)} / ${hm(target, t)} · ${t(STATE_TEXT[state])}`}</Badge>;
}

/** Someone says why a stage is stuck. The server accepts it only while the stage really is waiting. */
function ReasonPicker({ admissionId, stage, current, onDone }: { admissionId: string; stage: string; current: Reason | null; onDone: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(current?.code ?? "");
  const [note, setNote] = useState("");
  const save = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/discharge-flow/delay`, { stage, reason, ...(note.trim() ? { note: note.trim() } : {}) }), onSuccess: () => { setOpen(false); setNote(""); onDone(); } });
  if (!open) return (
    <div className="text-xs">
      {current ? <span><b><T>{current.label}</T></b>{current.note ? ` · ${current.note}` : ""}</span> : <span className="text-slate-500"><T>No reason given</T></span>}{" "}
      <button type="button" className="text-brand-700 underline" onClick={() => setOpen(true)}>{t(current ? "Change" : "Say why")}</button>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Select aria-label="Reason" className="w-52" value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">{t("Choose a reason")}</option>
        {REASONS.map(([c, l]) => <option key={c} value={c}>{t(l)}</option>)}
      </Select>
      {reason === "OTHER" && <Input aria-label="What is the reason" className="w-44" placeholder="What is the reason" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
      <Button variant="secondary" disabled={!reason || (reason === "OTHER" && note.trim().length < 3)} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      <ErrorNote error={save.error} />
    </div>
  );
}

/** What is still pending and who is handling it, to hand to the family. */
export function FamilySheetModal({ admissionId, onClose }: { admissionId: string; onClose: () => void }) {
  const [lang, setLang] = useState<"en" | "hi" | "bn">("en");
  const q = useQuery({ queryKey: ["family-sheet", admissionId, lang], queryFn: () => api.get<{ title: string; lines: string[] }>(`/admissions/${admissionId}/discharge-flow/family-sheet`, { lang }) });
  return (
    <Modal title="Sheet for the family" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2 print:hidden">
        <Select aria-label="Language" className="w-40" value={lang} onChange={(e) => setLang(e.target.value as "en" | "hi" | "bn")}>
          <option value="en">English</option><option value="hi">हिन्दी</option><option value="bn">বাংলা</option>
        </Select>
        <Button variant="secondary" onClick={() => window.print()}>Print</Button>
      </div>
      {q.isLoading ? <Spinner /> : (
        <div className="space-y-1 text-sm" data-testid="family-sheet">
          {q.data?.lines.map((l, i) => <p key={i} className={i === 0 ? "text-base font-semibold" : ""}>{l}</p>)}
        </div>
      )}
      <ErrorNote error={q.error} />
    </Modal>
  );
}

/** On the admission's Discharge tab: the planned date, the doctor's "fit to go" and the 2-hour clock, the checklist with owners and reasons, and the insurer's own clock. */
export function DischargeFlowCard({ admissionId, open }: { admissionId: string; open: boolean }) {
  const { can, dateTime } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["flow", admissionId], queryFn: () => api.get<Flow>(`/admissions/${admissionId}/discharge-flow`), refetchInterval: 30_000 });
  const reload = () => { void qc.invalidateQueries({ queryKey: ["flow", admissionId] }); };
  const [date, setDate] = useState("");
  const [sheet, setSheet] = useState(false);
  const plan = useMutation({ mutationFn: () => api.put(`/admissions/${admissionId}/discharge-plan`, { expectedDate: date }), onSuccess: () => { setDate(""); reload(); } });
  const sent = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/discharge-flow/insurer-bill-sent`, {}), onSuccess: reload });
  if (q.isLoading) return <Spinner />;
  const f = q.data;
  if (!f) return <ErrorNote error={q.error} />;
  const mayExplain = (i: FlowItem) => i.mine || can("ADMISSION_DISCHARGE");
  return (
    <Card title="Going home" actions={<Button variant="secondary" onClick={() => setSheet(true)}>Sheet for the family</Button>}>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div>
          <div className="text-xs text-slate-500"><T>Planned going-home date</T></div>
          <b data-testid="planned-date">{f.plan ? f.plan.expectedDate : t("Not set")}</b>
        </div>
        {open && can("ADMISSION_DISCHARGE") && (
          <div className="flex items-end gap-2">
            <Field label="New date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Button variant="secondary" disabled={!date} loading={plan.isPending} onClick={() => plan.mutate()}>Save date</Button>
          </div>
        )}
        <div className="ml-auto text-right">
          {f.fitToGo ? (
            <>
              <div className="text-xs text-slate-500"><T>Doctor said fit to go</T> · {dateTime(f.fitToGo.at)}{f.fitToGo.byName ? ` · ${f.fitToGo.byName}` : ""}</div>
              <ClockBadge state={f.clock.running ? f.clock.state : "ON_TIME"} minutes={f.clock.elapsedMinutes} target={f.clock.targetMinutes} />
              {!f.clock.running && f.clock.stoppedAt && <div className="text-xs text-slate-500"><T>Left</T> · {dateTime(f.clock.stoppedAt)}</div>}
            </>
          ) : <span className="text-xs text-slate-500"><T>The clock starts when the doctor records that the patient is fit to go.</T></span>}
        </div>
      </div>
      <ErrorNote error={plan.error ?? sent.error} />

      {f.items.length > 0 && (
        <div className="mt-3">
          <Table head={["Still to do", "Who", "Deadline", "Why it is waiting"]}>
            {f.items.map((i) => (
              <tr key={i.stage} data-testid="flow-item">
                <Td><b><T>{i.label}</T></b>{i.blockers.length > 0 && <ul className="mt-0.5 text-xs text-slate-600">{i.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}</Td>
                <Td><T>{i.owner}</T>{i.mine && <> <Badge tone="blue">yours</Badge></>}</Td>
                <Td>{i.deadline ? dateTime(i.deadline) : "—"}</Td>
                <Td>{mayExplain(i) ? <ReasonPicker admissionId={admissionId} stage={i.stage} current={i.reason} onDone={reload} /> : i.reason ? <span className="text-xs"><T>{i.reason.label}</T></span> : "—"}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {f.fitToGo && f.items.length === 0 && f.clock.running && <p className="mt-3 text-sm text-emerald-700"><T>Nothing is pending. The patient can go.</T></p>}

      <div className="mt-3 rounded border border-slate-200 p-3 text-sm" data-testid="insurer-clock">
        <div className="font-medium"><T>Insurer&apos;s reply</T></div>
        {f.insurer ? (
          <div className="mt-1 space-y-1">
            <div>
              {f.insurer.answeredAt ? <Badge tone="green">answered</Badge> : <ClockBadge state={f.insurer.state} minutes={f.insurer.elapsedMinutes} target={f.insurer.targetMinutes} />}
              <span className="ml-2 text-xs text-slate-500"><T>Final bill sent</T> · {dateTime(f.insurer.startedAt)}</span>
            </div>
            {!f.insurer.answeredAt && (f.insurer.mine || can("ADMISSION_DISCHARGE")) && <ReasonPicker admissionId={admissionId} stage="INSURER_PAYMENT" current={f.insurer.reason} onDone={reload} />}
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500"><T>The insurer&apos;s clock starts when the insurance desk sends the final bill.</T></span>
            {can("CLAIM_MANAGE") && <Button variant="secondary" loading={sent.isPending} onClick={() => sent.mutate()}>Final bill sent to insurer</Button>}
          </div>
        )}
      </div>
      {sheet && <FamilySheetModal admissionId={admissionId} onClose={() => setSheet(false)} />}
    </Card>
  );
}

// ───── the board ─────

interface Board { waiting: Flow[]; insurerWaiting: Flow[]; capped: boolean }
interface MyWork { items: (FlowItem & { admissionId: string; admissionNumber: string; patientName: string; bed: string | null })[]; insurerWaiting: Flow[] }

const ageMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

export function WaitingBoard() {
  const t = useT();
  const q = useQuery({ queryKey: ["flow-board"], queryFn: () => api.get<Board>("/discharge-flow/board"), refetchInterval: 20_000 });
  const [sheet, setSheet] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  const rows = q.data?.waiting ?? [];
  return (
    <Card title={`${t("Waiting to go home")} (${rows.length})`}>
      {rows.length === 0 ? <p className="text-sm text-slate-500"><T>Nobody is waiting to go home.</T></p> : (
        <Table head={["Patient", "Bed", "Planned date", "Waiting", "What is holding them up", ""]}>
          {rows.map((r) => (
            <tr key={r.admissionId} data-testid="board-row">
              <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patientName}</Link><div className="text-xs text-slate-500">{r.admissionNumber}</div></Td>
              <Td>{r.bed ?? "—"}</Td>
              <Td>{r.plan?.expectedDate ?? "—"}</Td>
              <Td><ClockBadge state={r.clock.state} minutes={r.clock.elapsedMinutes} target={r.clock.targetMinutes} /></Td>
              <Td>
                {r.items.length === 0 ? <span className="text-emerald-700"><T>Ready</T></span> : (
                  <ul className="space-y-0.5 text-xs">
                    {r.items.filter((i) => i.stage !== "EXIT").map((i) => <li key={i.stage}><b><T>{i.label}</T></b> · <T>{i.owner}</T>{i.reason ? <> · <i><T>{i.reason.label}</T></i></> : null}</li>)}
                    {r.items.every((i) => i.stage === "EXIT") && <li><b><T>Leaving the ward</T></b></li>}
                  </ul>
                )}
              </Td>
              <Td><Button variant="secondary" onClick={() => setSheet(r.admissionId)}>Family sheet</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {q.data?.capped && <Notice tone="warn">Only the 50 longest-waiting patients are shown.</Notice>}
      <ErrorNote error={q.error} />
      {sheet && <FamilySheetModal admissionId={sheet} onClose={() => setSheet(null)} />}
    </Card>
  );
}

export function MyWorkList() {
  const t = useT();
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["flow-mine"], queryFn: () => api.get<MyWork>("/discharge-flow/my-work"), refetchInterval: 20_000 });
  if (q.isLoading) return <Spinner />;
  const items = q.data?.items ?? [];
  const ins = q.data?.insurerWaiting ?? [];
  return (
    <>
      <Card title={`${t("My pending work")} (${items.length})`}>
        {items.length === 0 ? <p className="text-sm text-slate-500"><T>You have nothing pending for patients waiting to go home.</T></p> : (
          <Table head={["Patient", "Bed", "Step", "Waiting", "Deadline"]}>
            {items.map((i) => (
              <tr key={`${i.admissionId}:${i.stage}`} data-testid="mine-row">
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${i.admissionId}`}>{i.patientName}</Link><div className="text-xs text-slate-500">{i.admissionNumber}</div></Td>
                <Td>{i.bed ?? "—"}</Td>
                <Td><b><T>{i.label}</T></b></Td>
                <Td><Badge tone={TONE[i.state]}>{`${hm(i.waitingMinutes, t)} · ${t(STATE_TEXT[i.state])}`}</Badge></Td>
                <Td>{i.deadline ? dateTime(i.deadline) : "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {ins.length > 0 && <InsurerList rows={ins} />}
    </>
  );
}

export function InsurerList({ rows }: { rows: Flow[] }) {
  const t = useT();
  const { dateTime } = useMe();
  return (
    <Card title={`${t("Insurer replies awaited")} (${rows.length})`}>
      <Table head={["Patient", "Bill sent", "Waiting", "Why it is waiting"]}>
        {rows.map((r) => r.insurer && (
          <tr key={r.admissionId} data-testid="insurer-row">
            <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patientName}</Link><div className="text-xs text-slate-500">{r.admissionNumber}</div></Td>
            <Td>{dateTime(r.insurer.startedAt)}<div className="text-xs text-slate-500">{ageMin(r.insurer.startedAt)} {t("min ago")}</div></Td>
            <Td><ClockBadge state={r.insurer.state} minutes={r.insurer.elapsedMinutes} target={r.insurer.targetMinutes} /></Td>
            <Td>{r.insurer.reason ? <T>{r.insurer.reason.label}</T> : "—"}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

export function InsurerBoard() {
  const q = useQuery({ queryKey: ["flow-board"], queryFn: () => api.get<Board>("/discharge-flow/board"), refetchInterval: 20_000 });
  if (q.isLoading) return <Spinner />;
  const rows = q.data?.insurerWaiting ?? [];
  return rows.length ? <InsurerList rows={rows} /> : <Card title="Insurer replies awaited"><p className="text-sm text-slate-500"><T>No insurer reply is awaited.</T></p></Card>;
}

// ───── the management report ─────

interface FlowReport {
  from: string; to: string; targetMinutes: number; stays: number; averageMinutes: number | null; withinTarget: number; withinTargetPercent: number | null; beforeNoon: number; beforeNoonPercent: number | null;
  delaysByReason: { code: string; label: string; count: number }[]; delaysByDepartment: { stage: string; label: string; owner: string; count: number }[];
  slowestStages: { stage: string; label: string; owner: string; averageMinutesAfterFit: number; stays: number }[];
  insurer: { answered: number; averageMinutes: number | null; withinTarget: number; targetMinutes: number };
}

const isoDay = (d: Date) => new Intl.DateTimeFormat("en-CA").format(d);

export function FlowReportView() {
  const t = useT();
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const q = useQuery({ queryKey: ["flow-report", from, to], queryFn: () => api.get<FlowReport>("/reports/ipd/discharge-flow", { from, to }) });
  const r = q.data;
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
  return (
    <Card title="Going-home times">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? <Spinner /> : r && (
        <div className="space-y-4" data-testid="flow-report">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Patients who left" value={String(r.stays)} />
            <Stat label="Average time to leave" value={r.averageMinutes === null ? "—" : hm(r.averageMinutes, t)} />
            <Stat label={`${t("Left within")} ${hm(r.targetMinutes, t)}`} value={pct(r.withinTargetPercent)} />
            <Stat label="Left before noon" value={pct(r.beforeNoonPercent)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-1 text-sm font-medium"><T>Delays by reason</T></h4>
              {r.delaysByReason.length === 0 ? <p className="text-sm text-slate-500"><T>No reasons were recorded.</T></p> : <Table head={["Reason", "Times"]}>{r.delaysByReason.map((d) => <tr key={d.code}><Td><T>{d.label}</T></Td><Td>{d.count}</Td></tr>)}</Table>}
            </div>
            <div>
              <h4 className="mb-1 text-sm font-medium"><T>Delays by department</T></h4>
              {r.delaysByDepartment.length === 0 ? <p className="text-sm text-slate-500"><T>No reasons were recorded.</T></p> : <Table head={["Department", "Times"]}>{r.delaysByDepartment.map((d) => <tr key={d.stage}><Td><T>{d.owner || d.label}</T> <span className="text-xs text-slate-500">· <T>{d.label}</T></span></Td><Td>{d.count}</Td></tr>)}</Table>}
            </div>
          </div>
          {r.slowestStages.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-medium"><T>Slowest steps after the doctor says fit to go</T></h4>
              <Table head={["Step", "Average", "Patients"]}>{r.slowestStages.map((s) => <tr key={s.stage}><Td><T>{s.label}</T></Td><Td>{hm(s.averageMinutesAfterFit, t)}</Td><Td>{s.stays}</Td></tr>)}</Table>
            </div>
          )}
          <p className="text-sm"><T>Insurer replies</T>: {r.insurer.answered} · <T>average</T> {r.insurer.averageMinutes === null ? "—" : hm(r.insurer.averageMinutes, t)} · {r.insurer.withinTarget} <T>within</T> {hm(r.insurer.targetMinutes, t)}</p>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500"><T>{label}</T></div><div className="text-xl font-semibold">{value}</div></div>;
}

// ───── bill preview and late charges ─────

interface BillPreview {
  finalBill: { id: string; invoiceNumber: string | null; status: string; total: string } | null;
  waiting: { kind: "FINAL" | "LATE"; count: number; total: string; lines: { id: string; description: string; quantity: string; total: string }[] };
  supplementaryBills: { sequence: number; id: string; invoiceNumber: string | null; status: string; total: string }[];
  finalBillReady: boolean; notReady: { step: string; stage: string; blockers: string[] }[];
}

/** The bill so far during the stay. A charge that arrives after the final bill waits here and is billed on its own small bill: the first bill is never altered. */
export function BillPreviewCard({ admissionId }: { admissionId: string }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bill-preview", admissionId], queryFn: () => api.get<BillPreview>(`/admissions/${admissionId}/discharge/bill-preview`), refetchInterval: 30_000 });
  const bill = useMutation({
    mutationFn: () => api.post(`/admissions/${admissionId}/discharge/supplementary-invoice`),
    onSuccess: () => { for (const k of ["bill-preview", "discharge", "flow", "admission-charges"]) void qc.invalidateQueries({ queryKey: [k, admissionId] }); },
  });
  const p = q.data;
  if (q.isLoading) return <Spinner />;
  if (!p) return <ErrorNote error={q.error} />;
  const late = p.waiting.kind === "LATE";
  return (
    <Card title="Bill so far">
      <div className="space-y-2 text-sm" data-testid="bill-preview">
        {p.finalBill ? <p><T>Final bill</T>: <b>{p.finalBill.invoiceNumber ?? ""}</b> · {money(p.finalBill.total)} · {p.finalBill.status.toLowerCase().replace(/_/g, " ")}</p>
          : p.finalBillReady ? <Notice tone="success">Everything is ready: the final bill can be generated.</Notice>
          : p.notReady.length > 0 && <Notice tone="warn"><b><T>Not ready yet</T>: </b>{p.notReady.map((n) => n.stage).join(", ")}</Notice>}
        {p.waiting.count > 0 ? (
          <div>
            <div className="font-medium">{late ? <T>Late charges waiting for a separate bill</T> : <T>Charges waiting for the final bill</T>} · {money(p.waiting.total)}</div>
            <ul className="mt-1 text-xs text-slate-600">{p.waiting.lines.map((l) => <li key={l.id}>{l.description} × {l.quantity} · {money(l.total)}</li>)}</ul>
            {late && can("IPD_FINAL_BILL") && <div className="mt-2"><Button loading={bill.isPending} onClick={() => bill.mutate()}>Bill late charges separately</Button></div>}
            {late && <p className="mt-1 text-xs text-slate-500"><T>The first bill is not changed; these charges get their own small bill.</T></p>}
          </div>
        ) : <p className="text-slate-500"><T>No charges are waiting to be billed.</T></p>}
        {p.supplementaryBills.length > 0 && (
          <div>
            <div className="font-medium"><T>Separate bills for late charges</T></div>
            <ul className="text-xs text-slate-600">{p.supplementaryBills.map((b) => <li key={b.id}>#{b.sequence} · {b.invoiceNumber ?? ""} · {money(b.total)} · {b.status.toLowerCase().replace(/_/g, " ")}</li>)}</ul>
          </div>
        )}
        <ErrorNote error={bill.error} />
      </div>
    </Card>
  );
}
