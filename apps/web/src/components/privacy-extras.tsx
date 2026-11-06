"use client";
import { useState } from "react";
import { T } from "@/lib/i18n";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, StatusBadge, Table, Td } from "./ui";

// Records what a patient agreed to and asked for. It records only: which consents are required and how requests must be
// answered are legal decisions that are still pending (docs/privacy.md, docs/reviews/pending-decisions.md).

interface Consent { id: string; purpose: string; status: "GRANTED" | "WITHDRAWN"; method: string; noticeVersion: string | null; recordedAt: string }
const PURPOSE: Record<string, string> = { PRIVACY_NOTICE_ACKNOWLEDGED: "Privacy notice acknowledged", APPOINTMENT_REMINDERS: "Appointment reminders by SMS", EMAIL_MESSAGES: "Appointment, receipt and report emails" };
const TYPE: Record<string, string> = { ACCESS: "Copy of records", CORRECTION: "Correction", ERASURE: "Erasure", GRIEVANCE: "Complaint" };

function DataRequestModal({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const [type, setType] = useState("ACCESS");
  const [details, setDetails] = useState("");
  const [dueOn, setDueOn] = useState("");
  const save = useMutation({ mutationFn: () => api.post(`/patients/${patientId}/data-requests`, { type, details: details.trim(), ...(dueOn ? { dueOn } : {}) }), onSuccess: onClose });
  return (
    <Modal title="Log a data request" onClose={onClose}>
      <div className="space-y-3">
        <Field label="What is the patient asking for?"><Select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Details" hint="At least 10 characters. Do not paste medical records here."><Input autoFocus value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
        <Field label="Answer due by (optional)"><Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
        <p className="text-xs text-slate-500">This only logs the request. It does not change or remove any record.</p>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={details.trim().length < 10} onClick={() => save.mutate()}>Log request</Button></div>
        <ErrorNote error={save.error} />
      </div>
    </Modal>
  );
}

/** On the patient record: what the patient has agreed to, and a way to record a change or log a request. */
export function ConsentCard({ patientId }: { patientId: string }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["consents", patientId], queryFn: () => api.get<{ current: Consent[]; history: Consent[] }>(`/patients/${patientId}/consents`) });
  const [logging, setLogging] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const record = useMutation({
    mutationFn: (v: { purpose: string; status: "GRANTED" | "WITHDRAWN" }) => api.post(`/patients/${patientId}/consents`, { ...v, method: "VERBAL" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["consents", patientId] }),
  });
  const stateOf = (purpose: string) => q.data?.current.find((c) => c.purpose === purpose);
  return (
    <Card title="Privacy and consent" actions={can("PATIENT_UPDATE") ? <Button variant="secondary" onClick={() => setLogging(true)}>Log a data request</Button> : undefined}>
      {q.isLoading ? <Spinner /> : (
        <div className="space-y-2">
          {Object.entries(PURPOSE).map(([purpose, label]) => {
            const s = stateOf(purpose);
            return (
              <div key={purpose} className="flex items-center justify-between gap-2 text-sm">
                <div><T>{label}</T><div className="text-xs text-slate-500">{s ? `${s.status === "GRANTED" ? "Agreed" : "Withdrawn"} · ${s.method.toLowerCase()} · ${dateTime(s.recordedAt)}${s.noticeVersion ? ` · notice ${s.noticeVersion}` : ""}` : <T>Nothing recorded</T>}</div></div>
                <div className="flex items-center gap-2">
                  {s ? <StatusBadge value={s.status} /> : <Badge>not recorded</Badge>}
                  {can("PATIENT_UPDATE") && (
                    s?.status === "GRANTED"
                      ? <Button variant="ghost" loading={record.isPending} onClick={() => record.mutate({ purpose, status: "WITHDRAWN" })}>Withdraw</Button>
                      : <Button variant="secondary" loading={record.isPending} onClick={() => record.mutate({ purpose, status: "GRANTED" })}>Record agreement</Button>
                  )}
                </div>
              </div>
            );
          })}
          <ErrorNote error={record.error} />
          {(q.data?.history.length ?? 0) > 0 && <button className="text-xs text-brand-700 hover:underline" onClick={() => setShowHistory(!showHistory)}>{showHistory ? "Hide history" : `Show history (${q.data?.history.length})`}</button>}
          {showHistory && <ul className="space-y-0.5 text-xs text-slate-600">{q.data?.history.map((h) => <li key={h.id}>{dateTime(h.recordedAt)}: {PURPOSE[h.purpose] ?? h.purpose}, {h.status.toLowerCase()} ({h.method.toLowerCase()})</li>)}</ul>}
        </div>
      )}
      {logging && <DataRequestModal patientId={patientId} onClose={() => { setLogging(false); }} />}
    </Card>
  );
}

interface DataRequest { id: string; patientId: string; patientName: string; mrn: string | null; type: string; status: string; details: string; receivedOn: string; dueOn: string | null; resolution: string | null; version: number; overdue: boolean }

function Work({ r, onClose }: { r: DataRequest; onClose: () => void }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const move = useMutation({
    mutationFn: (status: "IN_PROGRESS" | "COMPLETED" | "REJECTED") => api.patch(`/privacy/requests/${r.id}`, { status, version: r.version, ...(status === "IN_PROGRESS" ? {} : { resolution: outcome.trim() }) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["privacy-requests"] }); onClose(); },
  });
  return (
    <Modal title={`${TYPE[r.type] ?? r.type}: ${r.patientName}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap">{r.details}</p>
        <p className="text-xs text-slate-500">Received {r.receivedOn}{r.dueOn ? ` · due ${r.dueOn}` : ""}. Closing a request records the outcome only; it does not change or remove any record.</p>
        {r.status === "OPEN" || r.status === "IN_PROGRESS" ? (
          <>
            <Field label="Outcome (needed to close, at least 5 characters)"><Input value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>
            <div className="flex flex-wrap justify-end gap-2">
              {r.status === "OPEN" && <Button variant="secondary" loading={move.isPending} onClick={() => move.mutate("IN_PROGRESS")}>Start work</Button>}
              <Button variant="secondary" disabled={outcome.trim().length < 5} loading={move.isPending} onClick={() => move.mutate("REJECTED")}>Close as declined</Button>
              <Button disabled={outcome.trim().length < 5} loading={move.isPending} onClick={() => move.mutate("COMPLETED")}>Close as done</Button>
            </div>
          </>
        ) : <p><span className="font-medium">Outcome:</span> {r.resolution}</p>}
        <ErrorNote error={move.error} />
      </div>
    </Modal>
  );
}

/** For privacy managers: every patient's data request, oldest first, with overdue ones flagged. */
export function PrivacyRequests() {
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<DataRequest | null>(null);
  const q = useQuery({ queryKey: ["privacy-requests", status], queryFn: () => api.page<DataRequest>("/privacy/requests", { ...(status ? { status } : {}), pageSize: 100 }) });
  return (
    <Card title="Patients' data requests" actions={<Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETED">Done</option><option value="REJECTED">Declined</option></Select>}>
      {q.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Request", "Received", "Due", "Status", ""]} {...(q.data?.data.length === 0 ? { empty: "No requests." } : {})}>
          {q.data?.data.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50">
              <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${r.patientId}`}>{r.patientName}</Link><div className="text-xs text-slate-500">{r.mrn}</div></Td>
              <Td>{TYPE[r.type] ?? r.type}</Td><Td>{r.receivedOn}</Td>
              <Td>{r.dueOn ?? "—"}{r.overdue && <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">overdue</span>}</Td>
              <Td><StatusBadge value={r.status} /></Td>
              <Td><Button variant="ghost" onClick={() => setOpen(r)}>Open</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 text-xs text-slate-500">This list tracks requests and their outcomes. It does not retrieve, correct or erase any record.</p>
      {open && <Work r={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
