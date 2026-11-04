"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PatientPicker, type PickedPatient } from "./pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea, useDebounced } from "./ui";

interface Insurer { id: string; name: string; kind: string; contact: string | null; status: string }
interface Policy { id: string; policyNumber: string; memberId: string | null; validFrom: string; validTo: string; status: string; validToday: boolean; insurer: { id: string; name: string } }
interface Row { id: string; claimNumber: string; type: string; status: string; claimedAmount: string | null; approvedAmount: string | null; settledAmount: string | null; outstanding: string | null; patient: string; mrn: string | null; insurer: string; policyNumber: string }
interface Detail {
  id: string; claimNumber: string; type: string; status: string; diagnosis: string | null; closeReason: string | null; nextSteps: string[];
  patient: { id: string; name: string; mrn: string | null }; policy: Policy;
  preauthRequested: string | null; preauthApproved: string | null; claimedAmount: string | null; approvedAmount: string | null; settledAmount: string | null; outstanding: string | null;
  invoice: { id: string; invoiceNumber: string | null; total: string; balanceDue: string } | null;
  events: { at: string; from: string | null; to: string; amount: string | null; note: string | null; by: string | null }[];
  settlements: { id: string; amount: string; reference: string; receivedOn: string; by: string | null }[];
}
interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; total: string }
interface Summary { insurerId: string; insurer: string; claims: number; waitingForDecision: string; toReceive: string }

const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { DRAFT: "gray", PREAUTH_PENDING: "amber", PREAUTH_APPROVED: "blue", SUBMITTED: "blue", QUERY: "amber", APPROVED: "green", REJECTED: "red", SETTLED: "green", CLOSED: "gray" };
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

/** The claim's page: where it stands, the steps open now, the money received, and the timeline. */
function ClaimModal({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["claim", claimId], queryFn: () => api.get<Detail>(`/claims/${claimId}`) });
  const c = q.data;
  const invoices = useQuery({ queryKey: ["claim-invoices", c?.patient.id], queryFn: () => api.page<InvoiceRow>("/invoices", { patientId: c!.patient.id, pageSize: 20 }), enabled: !!c && ["DRAFT", "PREAUTH_APPROVED"].includes(c.status) });
  const [amountText, setAmountText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [ref, setRef] = useState("");
  const [on, setOn] = useState(today());
  const refresh = () => { setAmountText(""); setNoteText(""); setRef(""); void qc.invalidateQueries({ queryKey: ["claim", claimId] }); void qc.invalidateQueries({ queryKey: ["claims"] }); void qc.invalidateQueries({ queryKey: ["claims-summary"] }); };
  const step = useMutation({ mutationFn: (a: { path: string; body: Record<string, unknown> }) => api.post(`/claims/${claimId}/${a.path}`, a.body, newKey()), onSuccess: refresh });
  const settle = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/settlements`, { amount: amountText, reference: ref.trim(), receivedOn: on }, newKey()), onSuccess: refresh });
  if (!c) return <Modal title="Claim" onClose={onClose} wide><Spinner /></Modal>;
  const go = (path: string, body: Record<string, unknown>) => step.mutate({ path, body });
  const has = (s: string) => c.nextSteps.includes(s);
  const manage = can("CLAIM_MANAGE");
  const open = c.status !== "SETTLED" && c.status !== "CLOSED" && c.status !== "REJECTED";
  return (
    <Modal title={`${c.claimNumber}: ${c.patient.name}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge><span>{c.type.toLowerCase()}</span><span className="text-slate-500">· {c.policy.insurer.name} · policy {c.policy.policyNumber}</span>
          <a className="ml-auto text-brand-700" href={printUrl(`claims/${c.id}`)} target="_blank" rel="noreferrer">Print claim form</a>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([["Pre-authorised", c.preauthApproved], ["Claimed", c.claimedAmount], ["Approved", c.approvedAmount], ["Received", c.settledAmount]] as const).map(([k, v]) => <div key={k} className="rounded-md border border-slate-200 p-2"><div className="text-xs text-slate-500">{k}</div><div className="font-medium">{v ? money(v) : "—"}</div></div>)}
        </div>
        {c.invoice && <p className="text-sm text-slate-600">Invoice {c.invoice.invoiceNumber} · total {money(c.invoice.total)} · balance due {money(c.invoice.balanceDue)}</p>}
        {c.closeReason && <Notice tone={c.status === "REJECTED" ? "error" : "info"}>{c.closeReason}</Notice>}
        <ErrorNote error={step.error ?? settle.error} />
        {manage && open && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            {(has("REQUEST_PREAUTH") || has("DECIDE_PREAUTH") || has("SUBMIT") || has("DECIDE") || has("SETTLE")) && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={has("SETTLE") ? "Amount received" : "Amount"}><Input className="w-36" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
                {has("SUBMIT") && <Field label="Invoice"><Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}><option value="">Choose an issued invoice</option>{invoices.data?.data.filter((i) => ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {money(i.total)}</option>)}</Select></Field>}
                {has("SETTLE") && can("CLAIM_SETTLE") && <><Field label="Bank reference"><Input className="w-40" value={ref} onChange={(e) => setRef(e.target.value)} /></Field><Field label="Received on"><Input type="date" className="w-40" value={on} onChange={(e) => setOn(e.target.value)} /></Field></>}
              </div>
            )}
            <Field label="Note or reason"><Textarea rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              {has("REQUEST_PREAUTH") && <Button variant="secondary" disabled={!amountText} loading={step.isPending} onClick={() => go("preauth", { requestedAmount: amountText, ...(noteText ? { note: noteText } : {}) })}>Ask for pre-authorisation</Button>}
              {has("DECIDE_PREAUTH") && <><Button disabled={!amountText} loading={step.isPending} onClick={() => go("preauth-decision", { decision: "APPROVE", amount: amountText })}>Pre-auth approved</Button><Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("preauth-decision", { decision: "REJECT", reason: noteText })}>Pre-auth rejected</Button></>}
              {has("SUBMIT") && <Button disabled={!amountText || !invoiceId} loading={step.isPending} onClick={() => go("submit", { invoiceId, claimedAmount: amountText, ...(noteText ? { note: noteText } : {}) })}>Submit to insurer</Button>}
              {has("RAISE_QUERY") && <Button variant="secondary" disabled={noteText.trim().length < 3} onClick={() => go("query", { note: noteText })}>Insurer raised a query</Button>}
              {has("RESUBMIT") && <Button disabled={noteText.trim().length < 3} loading={step.isPending} onClick={() => go("resubmit", { note: noteText, ...(amountText ? { claimedAmount: amountText } : {}) })}>Resubmit with reply</Button>}
              {has("DECIDE") && <>{c.status === "SUBMITTED" && <Button disabled={!amountText} loading={step.isPending} onClick={() => go("decision", { decision: "APPROVE", approvedAmount: amountText, ...(noteText ? { reason: noteText } : {}) })}>Insurer approved</Button>}<Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("decision", { decision: "REJECT", reason: noteText })}>Insurer rejected</Button></>}
              {has("SETTLE") && can("CLAIM_SETTLE") && <Button disabled={!amountText || ref.trim().length < 4} loading={settle.isPending} onClick={() => settle.mutate()}>Record money received</Button>}
              {has("CLOSE") && <Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("close", { reason: noteText })}>Close claim</Button>}
            </div>
          </div>
        )}
        <Table head={["When", "Step", "Amount", "Note", "By"]}>
          {c.events.map((e, i) => <tr key={i}><Td>{new Date(e.at).toLocaleString()}</Td><Td>{e.from ? `${label(e.from)} → ` : ""}{label(e.to)}</Td><Td>{e.amount ? money(e.amount) : ""}</Td><Td>{e.note}</Td><Td>{e.by}</Td></tr>)}
        </Table>
      </div>
    </Modal>
  );
}

function NewClaim({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const { can } = useMe();
  const qc = useQueryClient();
  const insurers = useQuery({ queryKey: ["claim-insurers"], queryFn: () => api.get<Insurer[]>("/claims/insurers") });
  const policies = useQuery({ queryKey: ["policies", patient?.id], queryFn: () => api.get<Policy[]>(`/patients/${patient!.id}/policies`), enabled: !!patient });
  const [policyId, setPolicyId] = useState("");
  const [type, setType] = useState("CASHLESS");
  const [diagnosis, setDiagnosis] = useState("");
  const [add, setAdd] = useState({ insurerId: "", policyNumber: "", memberId: "", validFrom: today(), validTo: "" });
  const addPolicy = useMutation({ mutationFn: () => api.post<Policy>(`/patients/${patient!.id}/policies`, { insurerId: add.insurerId, policyNumber: add.policyNumber.trim(), ...(add.memberId ? { memberId: add.memberId } : {}), validFrom: add.validFrom, validTo: add.validTo }), onSuccess: (p) => { setPolicyId(p.id); void qc.invalidateQueries({ queryKey: ["policies", patient?.id] }); } });
  const create = useMutation({ mutationFn: () => api.post<{ id: string }>("/claims", { patientId: patient!.id, policyId, type, ...(diagnosis.trim() ? { diagnosis: diagnosis.trim() } : {}) }), onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["claims"] }); onCreated(r.id); } });
  const valid = (policies.data ?? []).filter((p) => p.validToday);
  return (
    <Modal title="New claim" onClose={onClose}>
      <div className="space-y-3">
        <PatientPicker value={patient} onPick={(p) => { setPatient(p); setPolicyId(""); }} autoFocus />
        {patient && (policies.isLoading ? <Spinner /> : (
          <>
            <Field label="Policy"><Select value={policyId} onChange={(e) => setPolicyId(e.target.value)}><option value="">{valid.length ? "Choose a policy" : "No valid policy: add one below"}</option>{valid.map((p) => <option key={p.id} value={p.id}>{p.insurer.name} · {p.policyNumber}</option>)}</Select></Field>
            {can("CLAIM_MANAGE") && (
              <details className="rounded-md border border-slate-200 p-2 text-sm">
                <summary className="cursor-pointer">Add a policy for this patient</summary>
                <div className="mt-2 space-y-2">
                  <Select aria-label="Insurer" value={add.insurerId} onChange={(e) => setAdd({ ...add, insurerId: e.target.value })}><option value="">Insurer or TPA</option>{insurers.data?.filter((i) => i.status === "ACTIVE").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
                  <div className="flex gap-2"><Input aria-label="Policy number" placeholder="Policy number" value={add.policyNumber} onChange={(e) => setAdd({ ...add, policyNumber: e.target.value })} /><Input aria-label="Member id" placeholder="Member id (optional)" value={add.memberId} onChange={(e) => setAdd({ ...add, memberId: e.target.value })} /></div>
                  <div className="flex gap-2"><Field label="Valid from"><Input type="date" value={add.validFrom} onChange={(e) => setAdd({ ...add, validFrom: e.target.value })} /></Field><Field label="Valid to"><Input type="date" value={add.validTo} onChange={(e) => setAdd({ ...add, validTo: e.target.value })} /></Field></div>
                  <ErrorNote error={addPolicy.error} />
                  <Button variant="secondary" disabled={!add.insurerId || add.policyNumber.trim().length < 3 || !add.validTo} loading={addPolicy.isPending} onClick={() => addPolicy.mutate()}>Save policy</Button>
                </div>
              </details>
            )}
            <div className="flex gap-2">
              <Field label="Kind"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="CASHLESS">Cashless</option><option value="REIMBURSEMENT">Reimbursement</option></Select></Field>
              <Field label="Diagnosis (optional)" className="flex-1"><Input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></Field>
            </div>
            <ErrorNote error={create.error} />
            <Button disabled={!policyId} loading={create.isPending} onClick={() => create.mutate()}>Start claim</Button>
          </>
        ))}
      </div>
    </Modal>
  );
}

export function ClaimsList() {
  const { can, money } = useMe();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["claims", status, term], queryFn: () => api.get<{ items: Row[] }>("/claims", { ...(status ? { status } : {}), ...(term.length >= 2 ? { q: term } : {}), pageSize: 50 }), refetchInterval: 30_000 });
  const summary = useQuery({ queryKey: ["claims-summary"], queryFn: () => api.get<Summary[]>("/claims/summary") });
  return (
    <div className="space-y-4">
      {(summary.data?.length ?? 0) > 0 && (
        <Card title="Owed by insurers">
          <Table head={["Insurer", "Open claims", "Waiting for a decision", "Approved, to receive"]}>
            {summary.data?.map((s) => <tr key={s.insurerId}><Td>{s.insurer}</Td><Td>{s.claims}</Td><Td>{money(s.waitingForDecision)}</Td><Td className="font-medium">{money(s.toReceive)}</Td></tr>)}
          </Table>
        </Card>
      )}
      <Card title="Claims" actions={can("CLAIM_MANAGE") ? <Button onClick={() => setAdding(true)}>New claim</Button> : undefined}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Select aria-label="Status" className="w-52" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All claims</option>{["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED", "REJECTED", "SETTLED", "CLOSED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
          <Input aria-label="Search" className="min-w-60 flex-1" placeholder="Search name, MRN, claim or policy number" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Claim", "Patient", "Insurer", "Claimed", "To receive", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No claims yet." } : {})}>
            {list.data?.items.map((r) => (
              <tr key={r.id}><Td>{r.claimNumber}<div className="text-xs text-slate-500">{r.type.toLowerCase()}</div></Td><Td><span className="font-medium">{r.patient}</span> <span className="text-slate-500">· {r.mrn}</span></Td><Td>{r.insurer}<div className="text-xs text-slate-500">{r.policyNumber}</div></Td>
                <Td>{r.claimedAmount ? money(r.claimedAmount) : "—"}</Td><Td>{r.outstanding ? money(r.outstanding) : "—"}</Td><Td><Badge tone={TONE[r.status] ?? "gray"}>{label(r.status)}</Badge></Td><Td><Button variant="secondary" onClick={() => setOpen(r.id)}>Open</Button></Td></tr>
            ))}
          </Table>
        )}
      </Card>
      {open && <ClaimModal claimId={open} onClose={() => setOpen(null)} />}
      {adding && <NewClaim onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setOpen(id); }} />}
    </div>
  );
}

export function InsurersTab() {
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["claim-insurers"], queryFn: () => api.get<Insurer[]>("/claims/insurers") });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("INSURER");
  const add = useMutation({ mutationFn: () => api.post("/claims/insurers", { name: name.trim(), kind }), onSuccess: () => { setName(""); void qc.invalidateQueries({ queryKey: ["claim-insurers"] }); } });
  const toggle = useMutation({ mutationFn: (i: Insurer) => api.put(`/claims/insurers/${i.id}`, { name: i.name, kind: i.kind, status: i.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["claim-insurers"] }); } });
  return (
    <Card title="Insurers and TPAs">
      {can("CLAIM_MASTERS") && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Name" className="min-w-60 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="INSURER">Insurer</option><option value="TPA">TPA</option><option value="GOVERNMENT">Government scheme</option><option value="CORPORATE">Corporate</option></Select></Field>
          <Button disabled={name.trim().length < 2} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </div>
      )}
      <ErrorNote error={add.error ?? toggle.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["Name", "Kind", "Status", ""]} {...(list.data?.length === 0 ? { empty: "No insurers yet." } : {})}>
          {list.data?.map((i) => <tr key={i.id}><Td>{i.name}</Td><Td>{label(i.kind)}</Td><Td><Badge tone={i.status === "ACTIVE" ? "green" : "gray"}>{i.status.toLowerCase()}</Badge></Td><Td>{can("CLAIM_MASTERS") && <Button variant="secondary" onClick={() => toggle.mutate(i)}>{i.status === "ACTIVE" ? "Make inactive" : "Make active"}</Button>}</Td></tr>)}
        </Table>
      )}
    </Card>
  );
}
