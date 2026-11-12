"use client";
import { ClaimExchange } from "./claim-exchange";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { ClaimCover, type Appeal, type Enhancement, type NonPayable, type Verification } from "./claim-cover";
import { ClaimDocuments } from "./claim-documents";
import { InsurerPrices } from "./insurer-prices";
import { PatientPicker, type PickedPatient } from "./pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea, useDebounced } from "./ui";

interface Insurer { id: string; name: string; kind: string; contact: string | null; status: string }
interface Policy { id: string; policyNumber: string; memberId: string | null; validFrom: string; validTo: string; status: string; validToday: boolean; insurer: { id: string; name: string }; copayPercent?: string | null; deductible?: string; hasCopayRule?: boolean }
interface CopayPreview { hasRule: boolean; invoiceAmount: string; nonPayable?: string; packagePrice?: string | null; mostToClaim?: string; deductibleApplied?: string; copayPercent?: string; copayAmount?: string; claimAmount?: string; patientShare?: string; cappedBySumInsured?: boolean }
interface Row { id: string; claimNumber: string; type: string; status: string; claimedAmount: string | null; approvedAmount: string | null; settledAmount: string | null; outstanding: string | null; patient: string; mrn: string | null; insurer: string; policyNumber: string }
interface Detail {
  id: string; claimNumber: string; type: string; status: string; diagnosis: string | null; closeReason: string | null; nextSteps: string[];
  patient: { id: string; name: string; mrn: string | null }; policy: Policy;
  preauthRequested: string | null; preauthApproved: string | null; claimedAmount: string | null; approvedAmount: string | null; settledAmount: string | null; outstanding: string | null;
  invoice: { id: string; invoiceNumber: string | null; total: string; balanceDue: string } | null;
  copay: { calculatedAmount: string | null; patientShare: string | null; copayPercent: string | null; deductibleApplied: string | null; overrideReason: string | null } | null;
  events: { at: string; from: string | null; to: string; amount: string | null; note: string | null; by: string | null }[];
  settlements: { id: string; amount: string; tdsAmount: string; reference: string; receivedOn: string; by: string | null }[];
  verification: Verification | null; enhancements: Enhancement[]; nonPayables: NonPayable[]; nonPayableTotal: string; appeals: Appeal[];
  package: { id: string; name: string | null; price: string | null } | null; extraInvoices: { id: string; invoiceNumber: string | null; total: string; balanceDue: string }[];
}
interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; total: string }
interface Summary { insurerId: string; insurer: string; claims: number; waitingForDecision: string; toReceive: string }

const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { DRAFT: "gray", PREAUTH_PENDING: "amber", PREAUTH_APPROVED: "blue", SUBMITTED: "blue", QUERY: "amber", APPROVED: "green", REJECTED: "red", SETTLED: "green", CLOSED: "gray" };
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

/** The claim's page: where it stands, the steps open now, the money received, and the timeline. */
export function ClaimModal({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["claim", claimId], queryFn: () => api.get<Detail>(`/claims/${claimId}`) });
  const c = q.data;
  const invoices = useQuery({ queryKey: ["claim-invoices", c?.patient.id], queryFn: () => api.page<InvoiceRow>("/invoices", { patientId: c!.patient.id, pageSize: 20 }), enabled: !!c && ["DRAFT", "PREAUTH_APPROVED", "QUERY"].includes(c.status) });
  const [amountText, setAmountText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [overrideText, setOverrideText] = useState("");
  const [extraIds, setExtraIds] = useState<string[]>([]);
  // With a co-pay rule on the policy, the amount to claim and the patient's share are worked out for the chosen invoice and shown before submitting.
  const preview = useQuery({ queryKey: ["claim-copay", claimId, invoiceId, extraIds.join(",")], queryFn: () => api.post<CopayPreview>(`/claims/${claimId}/copay-preview`, { invoiceId, ...(extraIds.length ? { extraInvoiceIds: extraIds } : {}) }), enabled: !!c && c.nextSteps.includes("SUBMIT") && !!invoiceId });
  const [ref, setRef] = useState("");
  const [tds, setTds] = useState("");
  const [moreInvoice, setMoreInvoice] = useState("");
  const [on, setOn] = useState(today());
  const refresh = () => { setAmountText(""); setNoteText(""); setOverrideText(""); setRef(""); setTds(""); setExtraIds([]); setMoreInvoice(""); void qc.invalidateQueries({ queryKey: ["claim", claimId] }); void qc.invalidateQueries({ queryKey: ["claims"] }); void qc.invalidateQueries({ queryKey: ["claims-summary"] }); };
  const step = useMutation({ mutationFn: (a: { path: string; body: Record<string, unknown> }) => api.post(`/claims/${claimId}/${a.path}`, a.body, newKey()), onSuccess: refresh });
  // The structured claim file the TPA desk uploads on the insurer's portal (MedOS does not send it; docs/claims.md).
  const pkg = useMutation({
    mutationFn: () => api.get<unknown>(`/claims/${claimId}/package`),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `claim-package-${c?.claimNumber ?? claimId}.json`; link.click();
      URL.revokeObjectURL(url);
    },
  });
  const settle = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/settlements`, { amount: amountText, ...(tds ? { tdsAmount: tds } : {}), reference: ref.trim(), receivedOn: on }, newKey()), onSuccess: refresh });
  if (!c) return <Modal title="Claim" onClose={onClose} wide><Spinner /></Modal>;
  const go = (path: string, body: Record<string, unknown>) => step.mutate({ path, body });
  const has = (s: string) => c.nextSteps.includes(s);
  const manage = can("CLAIM_MANAGE");
  const open = c.status !== "SETTLED" && c.status !== "CLOSED" && c.status !== "REJECTED";
  const rule = preview.data?.hasRule ? preview.data : null;
  // Leaving the amount empty uses the calculated one; typing a different amount needs a reason.
  const overriding = !!rule && amountText !== "" && Number(amountText) !== Number(rule.claimAmount);
  const canSubmit = !!invoiceId && !preview.isLoading && (rule ? !overriding || overrideText.trim().length >= 10 : amountText !== "");
  return (
    <Modal title={`${c.claimNumber}: ${c.patient.name}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge><span>{c.type.toLowerCase()}</span><span className="text-slate-500">· {c.policy.insurer.name} · policy {c.policy.policyNumber}</span>
          <a className="ml-auto text-brand-700" href={printUrl(`claims/${c.id}`)} target="_blank" rel="noreferrer">Print claim form</a>
          {manage && c.invoice && <Button variant="secondary" loading={pkg.isPending} onClick={() => pkg.mutate()}>Download claim package</Button>}
        </div>
        <ClaimExchange claimId={c.id} hasInvoice={!!c.invoice} />
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([["Pre-authorised", c.preauthApproved], ["Claimed", c.claimedAmount], ["Approved", c.approvedAmount], ["Received", c.settledAmount]] as const).map(([k, v]) => <div key={k} className="rounded-md border border-slate-200 p-2"><div className="text-xs text-slate-500">{k}</div><div className="font-medium">{v ? money(v) : "—"}</div></div>)}
        </div>
        {c.invoice && <p className="text-sm text-slate-600">Invoice {c.invoice.invoiceNumber} · total {money(c.invoice.total)} · balance due {money(c.invoice.balanceDue)}{c.extraInvoices.map((x) => ` · also ${x.invoiceNumber} ${money(x.total)} (due ${money(x.balanceDue)})`).join("")}</p>}
        {c.copay?.patientShare && (
          <p className="text-sm text-slate-600">
            Patient pays {money(c.copay.patientShare)}
            {[Number(c.copay.deductibleApplied ?? 0) > 0 ? `deductible ${money(c.copay.deductibleApplied ?? "0")}` : "", Number(c.copay.copayPercent ?? 0) > 0 ? `co-pay ${Number(c.copay.copayPercent)}%` : ""].filter(Boolean).join(", ").replace(/^(.+)$/, " ($1)")}
            {c.copay.overrideReason ? ` · amount changed from the calculated ${money(c.copay.calculatedAmount ?? "0")}: ${c.copay.overrideReason}` : ""}
          </p>
        )}
        {c.closeReason && <Notice tone={c.status === "REJECTED" ? "error" : "info"}>{c.closeReason}</Notice>}
        <ErrorNote error={step.error ?? settle.error} />
        {manage && open && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            {(has("REQUEST_PREAUTH") || has("DECIDE_PREAUTH") || has("SUBMIT") || has("DECIDE") || has("SETTLE")) && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={has("SETTLE") ? "Cash received" : has("SUBMIT") && rule ? "Amount (leave empty to use the calculated one)" : "Amount"}><Input className="w-36" inputMode="decimal" placeholder={has("SUBMIT") && rule ? rule.claimAmount : undefined} value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
                {has("SUBMIT") && <Field label="Invoice"><Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}><option value="">Choose an issued invoice</option>{invoices.data?.data.filter((i) => ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {money(i.total)}</option>)}</Select></Field>}
                {has("SETTLE") && can("CLAIM_SETTLE") && <><Field label="Tax deducted (TDS), if any"><Input className="w-32" inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value.replace(/[^0-9.]/g, ""))} /></Field><Field label="Bank reference"><Input className="w-40" value={ref} onChange={(e) => setRef(e.target.value)} /></Field><Field label="Received on"><Input type="date" className="w-40" value={on} onChange={(e) => setOn(e.target.value)} /></Field></>}
              </div>
            )}
            {has("SUBMIT") && (invoices.data?.data.filter((i) => i.id !== invoiceId && ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).length ?? 0) > 0 && !!invoiceId && (
              <div className="text-sm">
                <div className="mb-1 text-xs text-slate-500">Also cover these invoices in the same claim</div>
                <div className="flex flex-wrap gap-3">{invoices.data?.data.filter((i) => i.id !== invoiceId && ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).map((i) => <label key={i.id} className="flex items-center gap-1"><input type="checkbox" checked={extraIds.includes(i.id)} onChange={(e) => setExtraIds(e.target.checked ? [...extraIds, i.id] : extraIds.filter((x) => x !== i.id))} />{i.invoiceNumber} · {money(i.total)}</label>)}</div>
              </div>
            )}
            {has("RESUBMIT") && (invoices.data?.data.filter((i) => i.id !== c.invoice?.id && !c.extraInvoices.some((x) => x.id === i.id) && ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).length ?? 0) > 0 && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Add another invoice to this claim"><Select value={moreInvoice} onChange={(e) => setMoreInvoice(e.target.value)}><option value="">Choose an invoice</option>{invoices.data?.data.filter((i) => i.id !== c.invoice?.id && !c.extraInvoices.some((x) => x.id === i.id) && ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status)).map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {money(i.total)}</option>)}</Select></Field>
                <Button variant="secondary" disabled={!moreInvoice} loading={step.isPending} onClick={() => go("invoices", { invoiceId: moreInvoice })}>Add invoice</Button>
              </div>
            )}
            {has("SUBMIT") && rule && (
              <div className="space-y-1 rounded-md border border-blue-200 bg-blue-50 p-2 text-sm">
                <div className="font-medium">Worked out from the policy</div>
                <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-5">
                  <div><div className="text-xs text-slate-500">Invoice{Number(rule.nonPayable ?? 0) > 0 ? ` (${money(rule.nonPayable ?? "0")} not payable)` : ""}</div>{money(rule.invoiceAmount)}</div>
                  <div><div className="text-xs text-slate-500">Deductible</div>{money(rule.deductibleApplied ?? "0")}</div>
                  <div><div className="text-xs text-slate-500">Co-pay {Number(rule.copayPercent ?? 0)}%</div>{money(rule.copayAmount ?? "0")}</div>
                  <div><div className="text-xs text-slate-500">Ask the insurer for</div><span className="font-semibold">{money(rule.claimAmount ?? "0")}</span></div>
                  <div><div className="text-xs text-slate-500">Patient pays</div><span className="font-semibold">{money(rule.patientShare ?? "0")}</span></div>
                </div>
                {rule.cappedBySumInsured && <p className="text-xs text-amber-800">Limited to the sum insured on the policy.</p>}
                {overriding && <Field label="Why is the amount different? (at least 10 characters)"><Input value={overrideText} onChange={(e) => setOverrideText(e.target.value)} /></Field>}
              </div>
            )}
            <Field label="Note or reason"><Textarea rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              {has("REQUEST_PREAUTH") && <Button variant="secondary" disabled={!amountText} loading={step.isPending} onClick={() => go("preauth", { requestedAmount: amountText, ...(noteText ? { note: noteText } : {}) })}>Ask for pre-authorisation</Button>}
              {has("DECIDE_PREAUTH") && <><Button disabled={!amountText} loading={step.isPending} onClick={() => go("preauth-decision", { decision: "APPROVE", amount: amountText })}>Pre-auth approved</Button><Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("preauth-decision", { decision: "REJECT", reason: noteText })}>Pre-auth rejected</Button></>}
              {has("SUBMIT") && <Button disabled={!canSubmit} loading={step.isPending} onClick={() => go("submit", { invoiceId, ...(extraIds.length ? { extraInvoiceIds: extraIds } : {}), ...(amountText ? { claimedAmount: amountText } : {}), ...(overriding ? { overrideReason: overrideText.trim() } : {}), ...(noteText ? { note: noteText } : {}) })}>Submit to insurer</Button>}
              {has("RAISE_QUERY") && <Button variant="secondary" disabled={noteText.trim().length < 3} onClick={() => go("query", { note: noteText })}>Insurer raised a query</Button>}
              {has("RESUBMIT") && <Button disabled={noteText.trim().length < 3 || (!!c.copay?.calculatedAmount && amountText !== "" && Number(amountText) !== Number(c.copay.calculatedAmount) && noteText.trim().length < 10)} loading={step.isPending} onClick={() => go("resubmit", { note: noteText, ...(amountText ? { claimedAmount: amountText } : {}), ...(amountText && c.copay?.calculatedAmount && Number(amountText) !== Number(c.copay.calculatedAmount) ? { overrideReason: noteText.trim() } : {}) })}>Resubmit with reply</Button>}
              {has("DECIDE") && <>{c.status === "SUBMITTED" && <Button disabled={!amountText} loading={step.isPending} onClick={() => go("decision", { decision: "APPROVE", approvedAmount: amountText, ...(noteText ? { reason: noteText } : {}) })}>Insurer approved</Button>}<Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("decision", { decision: "REJECT", reason: noteText })}>Insurer rejected</Button></>}
              {has("SETTLE") && can("CLAIM_SETTLE") && <Button disabled={!amountText || ref.trim().length < 4} loading={settle.isPending} onClick={() => settle.mutate()}>Record money received</Button>}
              {has("CLOSE") && <Button variant="secondary" disabled={noteText.trim().length < 5} onClick={() => go("close", { reason: noteText })}>Close claim</Button>}
            </div>
          </div>
        )}
        <ClaimCover claimId={c.id} type={c.type} status={c.status} verification={c.verification} insurerId={c.policy.insurer.id} invoiceId={c.invoice?.id ?? invoiceId} tariff={c.package} enhancements={c.enhancements} nonPayables={c.nonPayables} nonPayableTotal={c.nonPayableTotal} appeals={c.appeals} submitted={!!c.invoice && !!c.claimedAmount} canManage={manage} open={open} />
        <ClaimDocuments claimId={c.id} open={open} canManage={manage} />
        <Table head={["When", "Step", "Amount", "Note", "By"]}>
          {c.events.map((e, i) => <tr key={i}><Td>{new Date(e.at).toLocaleString()}</Td><Td>{e.from ? `${label(e.from)} → ` : ""}{label(e.to)}</Td><Td>{e.amount ? money(e.amount) : ""}</Td><Td>{e.note}</Td><Td>{e.by}</Td></tr>)}
        </Table>
        {c.settlements.some((s) => Number(s.tdsAmount) > 0) && <p className="text-xs text-slate-500">Tax deducted at source (TDS) is credited to the invoice as an "other" payment marked TDS; it is not cash.</p>}
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
  const [add, setAdd] = useState({ insurerId: "", policyNumber: "", memberId: "", validFrom: today(), validTo: "", copayPercent: "", deductible: "", deductibleUsed: "" });
  const addPolicy = useMutation({ mutationFn: () => api.post<Policy>(`/patients/${patient!.id}/policies`, { insurerId: add.insurerId, policyNumber: add.policyNumber.trim(), ...(add.memberId ? { memberId: add.memberId } : {}), validFrom: add.validFrom, validTo: add.validTo, ...(add.copayPercent ? { copayPercent: add.copayPercent } : {}), ...(add.deductible ? { deductible: add.deductible } : {}), ...(add.deductibleUsed ? { deductibleUsed: add.deductibleUsed } : {}) }), onSuccess: (p) => { setPolicyId(p.id); void qc.invalidateQueries({ queryKey: ["policies", patient?.id] }); } });
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
                  <div className="flex gap-2">
                    <Field label="Patient pays % (co-pay)"><Input inputMode="decimal" placeholder="e.g. 10" value={add.copayPercent} onChange={(e) => setAdd({ ...add, copayPercent: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
                    <Field label="Deductible"><Input inputMode="decimal" placeholder="0" value={add.deductible} onChange={(e) => setAdd({ ...add, deductible: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
                    <Field label="Deductible already used"><Input inputMode="decimal" placeholder="0" value={add.deductibleUsed} onChange={(e) => setAdd({ ...add, deductibleUsed: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
                  </div>
                  <p className="text-xs text-slate-500">Leave these empty if the policy has no co-pay rule. With them, the amount to claim is worked out for you when you submit.</p>
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
  const [prices, setPrices] = useState<Insurer | null>(null);
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
          {list.data?.map((i) => <tr key={i.id}><Td>{i.name}</Td><Td>{label(i.kind)}</Td><Td><Badge tone={i.status === "ACTIVE" ? "green" : "gray"}>{i.status.toLowerCase()}</Badge></Td><Td><div className="flex gap-2"><Button variant="secondary" onClick={() => setPrices(i)}>Rates and packages</Button>{can("CLAIM_MASTERS") && <Button variant="secondary" onClick={() => toggle.mutate(i)}>{i.status === "ACTIVE" ? "Make inactive" : "Make active"}</Button>}</div></Td></tr>)}
        </Table>
      )}
      {prices && <InsurerPrices insurer={prices} onClose={() => setPrices(null)} />}
    </Card>
  );
}
