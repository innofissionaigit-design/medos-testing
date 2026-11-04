"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea, useDebounced } from "./ui";

interface WorkItem { testOrderId: string; test: string; state: string; accessionNumber: string | null; patient: string; mrn: string | null; modality: string | null; bodyPart: string | null; critical: boolean }
interface StudyView {
  testOrderId: string; test: string; patient: { name: string; gender: string; mrn: string | null }; state: string;
  study: { id: string; accessionNumber: string; modality: string; bodyPart: string; clinicalNotes: string | null; performedBy: string | null; currentVersion: number; hasCritical: boolean; criticalAcknowledged: boolean } | null;
  reports: { version: number; kind: string; findings: string; impression: string; reason: string | null; signedBy: string | null }[];
}
interface Critical { studyId: string; test: string; bodyPart: string; patient: string; mrn: string | null; doctor: string | null }

const STATE_LABEL: Record<string, string> = { WAITING_STUDY: "Waiting for scan", PERFORMED: "Scan done, to be reported", REPORTED: "Reported" };
const MODALITIES: [string, string][] = [["XRAY", "X-ray"], ["ULTRASOUND", "Ultrasound"], ["CT", "CT scan"], ["MRI", "MRI"], ["MAMMOGRAPHY", "Mammography"], ["OTHER", "Other"]];

/** Record that the scan was done; the radiologist then writes and signs the report here; a signed report can be printed or amended with a reason. */
function StudyModal({ testOrderId, onClose }: { testOrderId: string; onClose: () => void }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["rad-study", testOrderId], queryFn: () => api.get<StudyView>(`/rad/orders/${testOrderId}/study`) });
  const [modality, setModality] = useState("XRAY");
  const [bodyPart, setBodyPart] = useState("");
  const [notes, setNotes] = useState("");
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [critical, setCritical] = useState(false);
  const [reason, setReason] = useState("");
  const [amending, setAmending] = useState(false);
  const d = q.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["rad-study", testOrderId] }); void qc.invalidateQueries({ queryKey: ["rad-work"] }); void qc.invalidateQueries({ queryKey: ["rad-critical"] }); };
  const perform = useMutation({ mutationFn: () => api.post(`/rad/orders/${testOrderId}/study`, { modality, bodyPart: bodyPart.trim(), ...(notes.trim() ? { clinicalNotes: notes.trim() } : {}) }, newKey()), onSuccess: refresh });
  const sign = useMutation({ mutationFn: () => api.post(`/rad/studies/${d!.study!.id}/report`, { findings, impression, critical }, newKey()), onSuccess: refresh });
  const amend = useMutation({ mutationFn: () => api.post(`/rad/studies/${d!.study!.id}/amend`, { expectedVersion: d!.study!.currentVersion, findings, impression, critical, reason }, newKey()), onSuccess: () => { setAmending(false); setReason(""); refresh(); } });
  const latest = d?.reports[0];
  const reported = d?.state === "REPORTED";
  const startAmend = () => { setFindings(latest?.findings ?? ""); setImpression(latest?.impression ?? ""); setCritical(d?.study?.hasCritical ?? false); setAmending(true); };
  return (
    <Modal title={d ? `${d.test}: ${d.patient.name}` : "Radiology"} onClose={onClose} wide>
      {q.isLoading || !d ? <Spinner /> : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{d.patient.mrn} · {d.patient.gender.toLowerCase()}{d.study ? ` · study ${d.study.accessionNumber} (${d.study.bodyPart})` : ""}</p>
          {!d.study && (
            can("RAD_PERFORM") ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Field label="Type of scan"><Select value={modality} onChange={(e) => setModality(e.target.value)}>{MODALITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                  <Field label="Body part" className="min-w-48 flex-1"><Input value={bodyPart} placeholder="e.g. Chest PA" onChange={(e) => setBodyPart(e.target.value)} /></Field>
                </div>
                <Field label="Clinical notes (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
                <ErrorNote error={perform.error} />
                <Button disabled={bodyPart.trim().length < 2} loading={perform.isPending} onClick={() => perform.mutate()}>Scan done</Button>
              </div>
            ) : <Notice tone="warn">This scan has not been done yet.</Notice>
          )}
          {d.study?.hasCritical && <Notice tone="error">A critical finding was reported{d.study.criticalAcknowledged ? " and the doctor has acknowledged it." : ": the doctor must acknowledge it."}</Notice>}
          {d.study && d.study.clinicalNotes && <p className="text-sm text-slate-600">Clinical notes: {d.study.clinicalNotes}</p>}
          {reported && latest && !amending && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
              <div><span className="font-medium">Findings.</span> {latest.findings}</div>
              <div><span className="font-medium">Impression.</span> {latest.impression}</div>
              <div className="text-xs text-slate-500">Signed by {latest.signedBy ?? "—"} · version {latest.version}{latest.reason ? ` · amended: ${latest.reason}` : ""}</div>
            </div>
          )}
          {d.study && ((!reported && can("RAD_REPORT")) || amending) && (
            <div className="space-y-2">
              <Field label="Findings"><Textarea rows={5} value={findings} onChange={(e) => setFindings(e.target.value)} /></Field>
              <Field label="Impression"><Textarea rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> Critical finding: tell the doctor now</label>
              {amending && <Field label="Reason for the correction"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
            </div>
          )}
          <ErrorNote error={sign.error ?? amend.error} />
          <div className="flex flex-wrap gap-2">
            {d.study && !reported && can("RAD_REPORT") && <Button disabled={findings.trim().length < 3 || impression.trim().length < 3} loading={sign.isPending} onClick={() => sign.mutate()}>Sign report</Button>}
            {reported && !amending && can("RAD_REPORT") && <Button variant="secondary" onClick={startAmend}>Amend</Button>}
            {amending && <Button disabled={reason.trim().length < 5 || findings.trim().length < 3 || impression.trim().length < 3} loading={amend.isPending} onClick={() => amend.mutate()}>Save amended report</Button>}
            {reported && <a className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`radiology-reports/${testOrderId}`)} target="_blank" rel="noreferrer">Print report</a>}
          </div>
          {d.reports.length > 1 && <p className="text-xs text-slate-500">This report was amended {d.reports.length - 1} time(s); earlier versions are kept.</p>}
        </div>
      )}
    </Modal>
  );
}

export function RadWorklist() {
  const [state, setState] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["rad-work", state, term], queryFn: () => api.get<{ items: WorkItem[] }>("/rad/worklist", { ...(state ? { state } : {}), ...(term.length >= 2 ? { q: term } : {}), pageSize: 50 }), refetchInterval: 20_000 });
  return (
    <Card title="Work list">
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Show" className="w-60" value={state} onChange={(e) => setState(e.target.value)}><option value="">All scans</option><option value="WAITING_STUDY">Waiting for scan</option><option value="PERFORMED">To be reported</option><option value="REPORTED">Reported</option></Select>
        <Input aria-label="Search" className="min-w-60 flex-1" placeholder="Search name, MRN or study number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Scan", "Study no.", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No scans here." } : {})}>
          {list.data?.items.map((i) => (
            <tr key={i.testOrderId}>
              <Td><span className="font-medium">{i.patient}</span> <span className="text-slate-500">· {i.mrn}</span></Td><Td>{i.test}{i.bodyPart ? <div className="text-xs text-slate-500">{i.bodyPart}</div> : null}</Td><Td>{i.accessionNumber ?? "—"}</Td>
              <Td><Badge tone={i.state === "REPORTED" ? "green" : i.state === "PERFORMED" ? "blue" : "gray"}>{STATE_LABEL[i.state] ?? i.state}</Badge>{i.critical && <> <Badge tone="red">critical</Badge></>}</Td>
              <Td><Button variant="secondary" onClick={() => setOpen(i.testOrderId)}>{i.state === "WAITING_STUDY" ? "Record scan" : i.state === "REPORTED" ? "View" : "Report"}</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {open && <StudyModal testOrderId={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

export function RadCritical() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["rad-critical"], queryFn: () => api.get<Critical[]>("/rad/critical"), refetchInterval: 20_000 });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/rad/studies/${id}/acknowledge`, {}, newKey()), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["rad-critical"] }); } });
  return (
    <Card title="Critical findings waiting for the doctor">
      <ErrorNote error={ack.error} />
      <Table head={["Patient", "Scan", "Doctor", ""]} {...(list.data?.length === 0 ? { empty: "No critical findings are waiting." } : {})}>
        {list.data?.map((c) => <tr key={c.studyId}><Td><span className="font-medium">{c.patient}</span> <span className="text-slate-500">· {c.mrn}</span></Td><Td>{c.test} · {c.bodyPart}</Td><Td>{c.doctor ?? "—"}</Td>
          <Td><Button variant="secondary" loading={ack.isPending && ack.variables === c.studyId} onClick={() => ack.mutate(c.studyId)}>Acknowledge</Button></Td></tr>)}
      </Table>
    </Card>
  );
}

/** The doctor's view of the radiology tests of one visit: where each stands, the report once signed, and acknowledging a critical finding. */
export function VisitRadiology({ encounterId }: { encounterId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["visit-rad", encounterId], queryFn: () => api.get<{ testOrderId: string; test: string; state: string; studyId: string | null; critical: boolean; amended: boolean; report: { findings: string; impression: string } | null }[]>(`/encounters/${encounterId}/radiology`), enabled: can("RAD_READ"), refetchInterval: 30_000 });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/rad/studies/${id}/acknowledge`, {}, newKey()), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["visit-rad", encounterId] }); } });
  if (!can("RAD_READ") || !q.data || q.data.length === 0) return null;
  return (
    <Card title="Radiology reports">
      <ErrorNote error={ack.error} />
      <div className="space-y-3">
        {q.data.map((o) => (
          <div key={o.testOrderId} className="text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{o.test}</span><Badge tone={o.state === "REPORTED" ? "green" : "gray"}>{STATE_LABEL[o.state] ?? o.state}</Badge>{o.amended && <Badge tone="amber">amended</Badge>}
              {o.critical && o.studyId && <Button variant="secondary" loading={ack.isPending} onClick={() => ack.mutate(o.studyId!)}>Critical: acknowledge</Button>}
              {o.state === "REPORTED" && <a className="text-brand-700" href={printUrl(`radiology-reports/${o.testOrderId}`)} target="_blank" rel="noreferrer">Print report</a>}</div>
            {o.report && <div className="mt-1 text-slate-700"><div>{o.report.findings}</div><div className="font-medium">Impression: {o.report.impression}</div></div>}
          </div>
        ))}
      </div>
    </Card>
  );
}
