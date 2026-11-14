"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PatientPicker, type PickedPatient } from "@/components/pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Spinner, Table, Td } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

// Insurance money screens (docs/insurance-money.md): a claim's money panel (ledger, three-way split, cuts, write-offs, top-up), what insurers owe, recording a payment
// matched to claims, follow-ups, write-offs a manager approves, overpayments, the reports, and the estimate for the family. The server works out every figure.

const CUT_LABEL: [string, string][] = [["NOT_COVERED", "Item not covered"], ["ROOM_RENT_LIMIT", "Room rent too high"], ["PATIENT_COPAY", "Patient co-pay"], ["OVER_RATE", "Above the insurer's rate"], ["DEDUCTIBLE", "Deductible"], ["OTHER", "Other"]];
const dec = (v: string) => v.replace(/[^0-9.]/g, "");

interface Ledger {
  claimId: string; claimNumber: string; status: string; tier: string; insurer: string;
  claimed: string; approved: string | null; cut: string; cutExplained: string; cutUnexplained: string; received: string; receivedCash: string; tds: string; writtenOff: string; owed: string; awaitingDecision: string;
  cuts: { id: string; label: string; amount: string; note: string | null }[]; writeOffs: { id: string; amount: string; reason: string; status: string }[]; followUps: { id: string; kind: string; amount: string; status: string; note: string }[];
}
interface Split { invoiceNumber: string | null; total: string; primary: { claimNumber: string; insurer: string; status: string; pays: string; received: string }; topup: { claimNumber: string; insurer: string; status: string; pays: string; received: string } | null; patient: { pays: string }; addsUp: boolean }
interface PackageLines { package: { name: string | null; includesImplants: boolean; includesConsumables: boolean; exclusionNote: string | null }; lines: { id: string; description: string; amount: string; scope: "INSIDE_PACKAGE" | "EXTRA"; why: string }[]; extraTotal: string }

/** The money side of one claim: what was claimed, approved, received, cut (and why), written off and still owed; the split of the bill; top-up; package marking. */
export function ClaimMoney({ claimId, patientId, invoiceId, tier, status, canManage, hasPackage, hasTopup }: { claimId: string; patientId: string; invoiceId: string | null; tier: string; status: string; canManage: boolean; hasPackage: boolean; hasTopup: boolean }) {
  const { can, money } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const sent = !["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED"].includes(status);
  const led = useQuery({ queryKey: ["claim-ledger", claimId, status], queryFn: () => api.get<Ledger>(`/claims/${claimId}/ledger`), enabled: sent });
  const split = useQuery({ queryKey: ["claim-split", claimId, status], queryFn: () => api.get<Split>(`/claims/${claimId}/split`), enabled: sent, retry: false });
  const pk = useQuery({ queryKey: ["claim-pkglines", claimId, invoiceId, status], queryFn: () => api.get<PackageLines>(`/claims/${claimId}/package-lines`, invoiceId ? { invoiceId } : {}), enabled: hasPackage && !!invoiceId, retry: false });
  const policies = useQuery({ queryKey: ["policies", patientId], queryFn: () => api.get<{ id: string; policyNumber: string; tier: string; validToday: boolean; insurer: { name: string } }[]>(`/patients/${patientId}/policies`), enabled: tier === "PRIMARY" && canManage && sent });
  const [cut, setCut] = useState({ category: "NOT_COVERED", amount: "", note: "" });
  const [off, setOff] = useState({ amount: "", reason: "" });
  const [topPolicy, setTopPolicy] = useState("");
  const refresh = () => { for (const k of ["claim-ledger", "claim-split", "claim", "claims"]) void qc.invalidateQueries({ queryKey: [k] }); };
  const addCut = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/cuts`, { category: cut.category, amount: cut.amount, ...(cut.note.trim() ? { note: cut.note.trim() } : {}) }), onSuccess: () => { setCut({ category: "NOT_COVERED", amount: "", note: "" }); refresh(); } });
  const askOff = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/write-offs`, { amount: off.amount, reason: off.reason.trim() }), onSuccess: () => { setOff({ amount: "", reason: "" }); refresh(); } });
  const addTop = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/topup`, { policyId: topPolicy }), onSuccess: () => { setTopPolicy(""); refresh(); } });
  if (!sent) return <Card title="Money"><p className="text-sm text-slate-500"><T>The money record starts when the claim is submitted.</T></p></Card>;
  const l = led.data;
  const tops = (policies.data ?? []).filter((p) => p.tier === "TOPUP" && p.validToday);
  const pendingOff = l?.writeOffs.some((w) => w.status === "PENDING");
  return (
    <Card title="Money" >
      {led.isLoading ? <Spinner /> : l && (
        <div className="space-y-3 text-sm" data-testid="claim-money">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[["Claimed", l.claimed], ["Approved", l.approved ?? "—"], ["Received", l.received], ["Cut by insurer", l.cut], ["Written off", l.writtenOff], ["Still owed", l.owed]].map(([k, v]) => (
              <div key={k} className="rounded border border-slate-200 p-2"><div className="text-xs text-slate-500"><T>{k!}</T></div><div className="font-semibold">{v === "—" ? v : money(v)}</div></div>
            ))}
          </div>
          {Number(l.cut) > 0 && <p className="text-xs text-slate-600"><T>The insurer cut</T> {money(l.cut)}: {money(l.cutExplained)} <T>explained</T>{Number(l.cutUnexplained) > 0 ? <>, <b className="text-amber-700">{money(l.cutUnexplained)} <T>not yet explained</T></b></> : null}</p>}
          {l.cuts.length > 0 && <ul className="text-xs text-slate-700">{l.cuts.map((c) => <li key={c.id}>{t(c.label)} · {money(c.amount)}{c.note ? ` · ${c.note}` : ""}</li>)}</ul>}
          {canManage && Number(l.cutUnexplained) > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Why the insurer cut it"><Select value={cut.category} onChange={(e) => setCut({ ...cut, category: e.target.value })}>{CUT_LABEL.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select></Field>
              <Field label="Amount"><Input className="w-28" inputMode="decimal" value={cut.amount} onChange={(e) => setCut({ ...cut, amount: dec(e.target.value) })} /></Field>
              <Field label="Note"><Input className="w-56" maxLength={300} value={cut.note} onChange={(e) => setCut({ ...cut, note: e.target.value })} /></Field>
              <Button variant="secondary" disabled={!cut.amount || (cut.category === "OTHER" && cut.note.trim().length < 3)} loading={addCut.isPending} onClick={() => addCut.mutate()}>Record cut</Button>
            </div>
          )}
          <ErrorNote error={addCut.error} />
          {l.followUps.filter((f) => f.status === "OPEN").map((f) => <Notice key={f.id} tone="warn">{f.note}</Notice>)}
          {l.writeOffs.length > 0 && <ul className="text-xs text-slate-700">{l.writeOffs.map((w) => <li key={w.id}><T>Write-off</T> {money(w.amount)} · <Badge tone={w.status === "APPROVED" ? "green" : w.status === "PENDING" ? "amber" : "red"}>{w.status.toLowerCase()}</Badge> · {w.reason}</li>)}</ul>}
          {canManage && status === "APPROVED" && Number(l.owed) > 0 && !pendingOff && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Write off (a manager must approve)"><Input className="w-28" inputMode="decimal" value={off.amount} onChange={(e) => setOff({ ...off, amount: dec(e.target.value) })} /></Field>
              <Field label="Reason (at least 10 characters)"><Input className="w-72" maxLength={300} value={off.reason} onChange={(e) => setOff({ ...off, reason: e.target.value })} /></Field>
              <Button variant="secondary" disabled={!off.amount || off.reason.trim().length < 10} loading={askOff.isPending} onClick={() => askOff.mutate()}>Ask for write-off</Button>
            </div>
          )}
          <ErrorNote error={askOff.error} />
        </div>
      )}
      {split.data && (
        <div className="mt-3 rounded border border-slate-200 p-3 text-sm" data-testid="claim-split">
          <div className="mb-1 font-medium"><T>The bill split three ways</T> · {split.data.invoiceNumber} · {money(split.data.total)}</div>
          <Table head={["Who", "Pays", "Received"]}>
            <tr><Td>{split.data.primary.insurer} <span className="text-xs text-slate-500">(<T>main insurer</T>)</span></Td><Td>{money(split.data.primary.pays)}</Td><Td>{money(split.data.primary.received)}</Td></tr>
            {split.data.topup && <tr><Td>{split.data.topup.insurer} <span className="text-xs text-slate-500">(<T>top-up</T>)</span></Td><Td>{money(split.data.topup.pays)}</Td><Td>{money(split.data.topup.received)}</Td></tr>}
            <tr><Td><b><T>The patient</T></b></Td><Td><b>{money(split.data.patient.pays)}</b></Td><Td></Td></tr>
          </Table>
        </div>
      )}
      {tier === "PRIMARY" && canManage && !hasTopup && tops.length > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <Field label="Top-up insurer's claim"><Select value={topPolicy} onChange={(e) => setTopPolicy(e.target.value)}><option value="">{t("Choose the top-up policy")}</option>{tops.map((p) => <option key={p.id} value={p.id}>{p.insurer.name} · {p.policyNumber}</option>)}</Select></Field>
          <Button variant="secondary" disabled={!topPolicy} loading={addTop.isPending} onClick={() => addTop.mutate()}>Start top-up claim</Button>
          <ErrorNote error={addTop.error} />
        </div>
      )}
      {hasPackage && pk.data && (
        <div className="mt-3 text-sm" data-testid="package-lines">
          <div className="mb-1 font-medium">{pk.data.package.name} · <T>inside the package or extra</T></div>
          {(!pk.data.package.includesImplants || !pk.data.package.includesConsumables) && <Notice tone="warn">{pk.data.package.exclusionNote}</Notice>}
          <Table head={["Charge", "Amount", "Package"]}>
            {pk.data.lines.map((x) => <tr key={x.id}><Td>{x.description}<div className="text-xs text-slate-500">{x.why}</div></Td><Td>{money(x.amount)}</Td><Td><Badge tone={x.scope === "EXTRA" ? "amber" : "green"}>{x.scope === "EXTRA" ? "extra" : "inside the package"}</Badge></Td></tr>)}
          </Table>
          {can("CLAIM_READ") && <p className="mt-1 text-xs text-slate-500"><T>Extra charges are billed on top of the package price.</T> {money(pk.data.extraTotal)}</p>}
        </div>
      )}
    </Card>
  );
}

// ───── what insurers owe, and their payments ─────

interface InsurerRow { insurerId: string; insurer: string; claims: number; claimed: string; approved: string | null; received: string; tds: string; cut: string; cutUnexplained: string; writtenOff: string; owed: string; awaitingDecision: string; refundDue: string }

export function OwedTab() {
  const { money } = useMe();
  const q = useQuery({ queryKey: ["insurance-ledger"], queryFn: () => api.get<InsurerRow[]>("/insurance/ledger"), refetchInterval: 60_000 });
  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];
  return (
    <Card title="What each insurer owes">
      {rows.length === 0 ? <p className="text-sm text-slate-500"><T>No claims have been sent to insurers yet.</T></p> : (
        <Table head={["Insurer", "Claims", "Claimed", "Approved", "Received", "Cut", "Written off", "Still owed", "Refund due"]}>
          {rows.map((r) => (
            <tr key={r.insurerId} data-testid="ledger-row">
              <Td><b>{r.insurer}</b></Td><Td>{r.claims}</Td><Td>{money(r.claimed)}</Td><Td>{r.approved ? money(r.approved) : "—"}</Td><Td>{money(r.received)}{Number(r.tds) > 0 ? <div className="text-xs text-slate-500">incl. TDS {money(r.tds)}</div> : null}</Td>
              <Td>{money(r.cut)}{Number(r.cutUnexplained) > 0 ? <div className="text-xs text-amber-700">{money(r.cutUnexplained)} unexplained</div> : null}</Td><Td>{money(r.writtenOff)}</Td><Td><b>{money(r.owed)}</b>{Number(r.awaitingDecision) > 0 ? <div className="text-xs text-slate-500">{money(r.awaitingDecision)} awaiting decision</div> : null}</Td><Td>{Number(r.refundDue) > 0 ? <Badge tone="amber">{money(r.refundDue)}</Badge> : "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

interface ClaimOpt { id: string; claimNumber: string; patient: string; insurer: string; outstanding: string | null }

export function PaymentTab() {
  const { money } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const insurers = useQuery({ queryKey: ["insurers"], queryFn: () => api.get<{ id: string; name: string; status: string }[]>("/claims/insurers") });
  const approved = useQuery({ queryKey: ["claims", "APPROVED", "pay"], queryFn: () => api.get<{ items: ClaimOpt[] }>("/claims", { status: "APPROVED", pageSize: 100 }) });
  const [f, setF] = useState({ insurerId: "", reference: "", receivedOn: new Date().toISOString().slice(0, 10), amount: "" });
  const [lines, setLines] = useState<Record<string, { amount: string; tds: string; final: boolean }>>({});
  const [key, setKey] = useState(newKey());
  const insurer = insurers.data?.find((i) => i.id === f.insurerId);
  const claims = (approved.data?.items ?? []).filter((c) => insurer && c.insurer === insurer.name);
  const matched = Object.values(lines).reduce((a, l) => a + Number(l.amount || 0), 0);
  const body = { insurerId: f.insurerId, reference: f.reference.trim(), receivedOn: f.receivedOn, amount: f.amount, lines: Object.entries(lines).filter(([, l]) => Number(l.amount) > 0).map(([claimId, l]) => ({ claimId, amount: l.amount, ...(Number(l.tds) > 0 ? { tdsAmount: l.tds } : {}), final: l.final })) };
  const save = useMutation({
    mutationFn: () => api.post<{ overpayment: string; followUps: unknown[] }>("/insurance/payments", body, key),
    onSuccess: () => { setF({ ...f, reference: "", amount: "" }); setLines({}); setKey(newKey()); for (const k of ["insurance-ledger", "claims", "follow-ups", "overpayments", "payments"]) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  const pays = useQuery({ queryKey: ["payments"], queryFn: () => api.get<{ items: { id: string; insurer: string; reference: string; receivedOn: string; amount: string; overpaid: string; claims: { claimNumber: string; amount: string }[] }[] }>("/insurance/payments") });
  const set = (id: string, patch: Partial<{ amount: string; tds: string; final: boolean }>) => setLines({ ...lines, [id]: { amount: "", tds: "", final: false, ...lines[id], ...patch } });
  return (
    <>
      <Card title="Record a payment from an insurer">
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Insurer"><Select value={f.insurerId} onChange={(e) => { setF({ ...f, insurerId: e.target.value }); setLines({}); }}><option value="">{t("Choose the insurer")}</option>{insurers.data?.filter((i) => i.status === "ACTIVE").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
            <Field label="Bank reference"><Input className="w-44" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
            <Field label="Received on"><Input type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} /></Field>
            <Field label="Total received"><Input className="w-32" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: dec(e.target.value) })} /></Field>
          </div>
          {insurer && (claims.length === 0 ? <p className="text-slate-500"><T>This insurer has no approved claims waiting for money.</T></p> : (
            <Table head={["Claim", "Patient", "Still owed", "Cash paid on it", "Tax deducted (TDS)", "Insurer's last word on it"]}>
              {claims.map((c) => (
                <tr key={c.id} data-testid="pay-line">
                  <Td><b>{c.claimNumber}</b></Td><Td>{c.patient}</Td><Td>{c.outstanding ? money(c.outstanding) : "—"}</Td>
                  <Td><Input aria-label={`Cash on ${c.claimNumber}`} className="w-28" inputMode="decimal" value={lines[c.id]?.amount ?? ""} onChange={(e) => set(c.id, { amount: dec(e.target.value) })} /></Td>
                  <Td><Input aria-label={`TDS on ${c.claimNumber}`} className="w-24" inputMode="decimal" value={lines[c.id]?.tds ?? ""} onChange={(e) => set(c.id, { tds: dec(e.target.value) })} /></Td>
                  <Td><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={lines[c.id]?.final ?? false} onChange={(e) => set(c.id, { final: e.target.checked })} /> final: nothing more coming</label></Td>
                </tr>
              ))}
            </Table>
          ))}
          {f.amount && matched > Number(f.amount) && <Notice tone="error">The lines add up to more than the payment.</Notice>}
          {f.amount && matched < Number(f.amount) && <Notice tone="warn">{money(String(Number(f.amount) - matched))} <T>is matched to no claim and will be recorded as an overpayment to refund.</T></Notice>}
          <ErrorNote error={save.error} />
          {save.data && <Notice tone="success">Payment recorded.{Number(save.data.overpayment) > 0 ? ` ${money(save.data.overpayment)} is an overpayment to refund.` : ""}{save.data.followUps.length ? ` ${save.data.followUps.length} follow-up(s) raised.` : ""}</Notice>}
          <Button disabled={!f.insurerId || f.reference.trim().length < 4 || !f.amount || matched > Number(f.amount)} loading={save.isPending} onClick={() => save.mutate()}>Record payment</Button>
        </div>
      </Card>
      <Card title="Payments received">
        <Table head={["Received", "Insurer", "Reference", "Amount", "Matched to", "Overpaid"]} {...(pays.data?.items.length === 0 ? { empty: "No payments yet." } : {})}>
          {pays.data?.items.map((p) => <tr key={p.id}><Td>{p.receivedOn}</Td><Td>{p.insurer}</Td><Td>{p.reference}</Td><Td>{money(p.amount)}</Td><Td className="text-xs">{p.claims.map((c) => `${c.claimNumber} ${money(c.amount)}`).join(", ")}</Td><Td>{Number(p.overpaid) > 0 ? <Badge tone="amber">{money(p.overpaid)}</Badge> : "—"}</Td></tr>)}
        </Table>
      </Card>
    </>
  );
}

// ───── follow-ups, write-offs, overpayments ─────

export function FollowUpTab() {
  const { money, can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["follow-ups"], queryFn: () => api.get<{ items: { id: string; claimNumber: string; insurer: string; kind: string; amount: string; note: string }[] }>("/insurance/follow-ups") });
  const [note, setNote] = useState<Record<string, string>>({});
  const done = useMutation({ mutationFn: (id: string) => api.post(`/insurance/follow-ups/${id}/done`, { note: (note[id] ?? "").trim() }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["follow-ups"] }); } });
  return (
    <Card title="Follow-ups for the insurance desk">
      {q.isLoading ? <Spinner /> : (q.data?.items.length ?? 0) === 0 ? <p className="text-sm text-slate-500"><T>Nothing to follow up.</T></p> : (
        <Table head={["Claim", "Insurer", "What", "Amount", "", ""]}>
          {q.data!.items.map((f) => (
            <tr key={f.id} data-testid="follow-up">
              <Td><b>{f.claimNumber}</b></Td><Td>{f.insurer}</Td><Td className="text-xs">{f.note}</Td><Td>{money(f.amount)}</Td>
              <Td>{can("CLAIM_MANAGE") && <Input aria-label="What was done" className="w-48" placeholder="What was done" value={note[f.id] ?? ""} onChange={(e) => setNote({ ...note, [f.id]: e.target.value })} />}</Td>
              <Td>{can("CLAIM_MANAGE") && <Button variant="secondary" disabled={(note[f.id] ?? "").trim().length < 3} loading={done.isPending && done.variables === f.id} onClick={() => done.mutate(f.id)}>Done</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorNote error={done.error} />
    </Card>
  );
}

export function WriteOffTab() {
  const { money, can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["write-offs"], queryFn: () => api.get<{ items: { id: string; claimNumber: string; insurer: string; amount: string; reason: string; status: string; requestedBy: string | null; decidedBy: string | null }[] }>("/insurance/write-offs") });
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({ mutationFn: (a: { id: string; decision: "APPROVE" | "REJECT" }) => api.post(`/insurance/write-offs/${a.id}/decision`, { decision: a.decision, ...((note[a.id] ?? "").trim() ? { note: note[a.id]!.trim() } : {}) }), onSuccess: () => { for (const k of ["write-offs", "insurance-ledger", "claims"]) void qc.invalidateQueries({ queryKey: [k] }); } });
  return (
    <Card title="Write-offs">
      <p className="mb-2 text-xs text-slate-600"><T>A write-off needs a reason and a manager's approval. The person who asked cannot approve it.</T></p>
      {q.isLoading ? <Spinner /> : (
        <Table head={["Claim", "Insurer", "Amount", "Reason", "Asked by", "Status", ""]} {...(q.data?.items.length === 0 ? { empty: "No write-offs." } : {})}>
          {q.data?.items.map((w) => (
            <tr key={w.id} data-testid="write-off">
              <Td><b>{w.claimNumber}</b></Td><Td>{w.insurer}</Td><Td>{money(w.amount)}</Td><Td className="text-xs">{w.reason}</Td><Td>{w.requestedBy}</Td>
              <Td><Badge tone={w.status === "APPROVED" ? "green" : w.status === "PENDING" ? "amber" : "red"}>{w.status.toLowerCase()}</Badge>{w.decidedBy ? <div className="text-xs text-slate-500">{w.decidedBy}</div> : null}</Td>
              <Td>{w.status === "PENDING" && can("CLAIM_WRITEOFF_APPROVE") && (
                <div className="flex items-center gap-1">
                  <Input aria-label="Note" className="w-36" placeholder="Note" value={note[w.id] ?? ""} onChange={(e) => setNote({ ...note, [w.id]: e.target.value })} />
                  <Button loading={decide.isPending && decide.variables?.id === w.id} onClick={() => decide.mutate({ id: w.id, decision: "APPROVE" })}>Approve</Button>
                  <Button variant="secondary" disabled={(note[w.id] ?? "").trim().length < 5} onClick={() => decide.mutate({ id: w.id, decision: "REJECT" })}>Refuse</Button>
                </div>
              )}</Td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorNote error={decide.error} />
    </Card>
  );
}

export function OverpaymentTab() {
  const { money, can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["overpayments"], queryFn: () => api.get<{ items: { id: string; insurer: string; paymentReference: string; amount: string; refunded: string; refundDue: string; status: string; reason: string }[] }>("/insurance/overpayments") });
  const [f, setF] = useState<Record<string, { amount: string; reference: string }>>({});
  const refund = useMutation({
    mutationFn: (id: string) => api.post(`/insurance/overpayments/${id}/refunds`, { amount: f[id]!.amount, reference: f[id]!.reference.trim(), refundedOn: new Date().toISOString().slice(0, 10) }, newKey()),
    onSuccess: () => { for (const k of ["overpayments", "insurance-ledger"]) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  return (
    <Card title="Insurer overpayments">
      {q.isLoading ? <Spinner /> : (
        <Table head={["Insurer", "Payment", "Overpaid", "Refunded", "Still to refund", "Status", ""]} {...(q.data?.items.length === 0 ? { empty: "No overpayments." } : {})}>
          {q.data?.items.map((o) => (
            <tr key={o.id} data-testid="overpayment">
              <Td>{o.insurer}</Td><Td>{o.paymentReference}</Td><Td>{money(o.amount)}</Td><Td>{money(o.refunded)}</Td><Td><b>{money(o.refundDue)}</b></Td><Td><Badge tone={o.status === "REFUNDED" ? "green" : "amber"}>{o.status.toLowerCase().replace(/_/g, " ")}</Badge></Td>
              <Td>{o.status !== "REFUNDED" && can("CLAIM_SETTLE") && (
                <div className="flex items-center gap-1">
                  <Input aria-label="Refund amount" className="w-24" inputMode="decimal" placeholder="Amount" value={f[o.id]?.amount ?? ""} onChange={(e) => setF({ ...f, [o.id]: { reference: "", ...f[o.id], amount: dec(e.target.value) } })} />
                  <Input aria-label="Refund reference" className="w-32" placeholder="Bank reference" value={f[o.id]?.reference ?? ""} onChange={(e) => setF({ ...f, [o.id]: { amount: "", ...f[o.id], reference: e.target.value } })} />
                  <Button variant="secondary" disabled={!f[o.id]?.amount || (f[o.id]?.reference ?? "").trim().length < 4} loading={refund.isPending && refund.variables === o.id} onClick={() => refund.mutate(o.id)}>Record refund</Button>
                </div>
              )}</Td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorNote error={refund.error} />
    </Card>
  );
}

// ───── reports ─────

export function InsuranceReports() {
  const { money } = useMe();
  const age = useQuery({ queryKey: ["ins-ageing"], queryFn: () => api.get<{ insurers: { insurerId: string; insurer: string; buckets: { bucket: string; claims: number; amount: string }[] }[]; oldest: { claimId: string; claimNumber: string; insurer: string; amount: string; days: number }[] }>("/reports/insurance/ageing") });
  const rej = useQuery({ queryKey: ["ins-rej"], queryFn: () => api.get<{ rejected: number; reasons: { reason: string; claims: number; amount: string; insurers: string[] }[]; cuts: { label: string; count: number; amount: string }[] }>("/reports/insurance/rejections") });
  const late = useQuery({ queryKey: ["ins-late"], queryFn: () => api.get<{ slaDays: number; insurers: { insurerId: string; insurer: string; paidClaims: number; averageDaysToPay: number | null; slowestDays: number | null; openClaims: number; overdueClaims: number; overdueAmount: string }[] }>("/reports/insurance/late-payers") });
  return (
    <div className="space-y-4" data-testid="ins-reports">
      <Card title="Old claims: how long ago they were sent">
        {age.isLoading ? <Spinner /> : (age.data?.insurers.length ?? 0) === 0 ? <p className="text-sm text-slate-500"><T>No claims are waiting.</T></p> : (
          <Table head={["Insurer", "0-30 days", "31-60 days", "61-90 days", "Over 90 days"]}>
            {age.data!.insurers.map((i) => <tr key={i.insurerId}><Td><b>{i.insurer}</b></Td>{i.buckets.map((b) => <Td key={b.bucket}>{b.claims ? `${b.claims} · ${money(b.amount)}` : "—"}</Td>)}</tr>)}
          </Table>
        )}
      </Card>
      <Card title="Why claims are rejected">
        {rej.isLoading ? <Spinner /> : (rej.data?.reasons.length ?? 0) === 0 ? <p className="text-sm text-slate-500"><T>No claims were rejected in the last 90 days.</T></p> : (
          <Table head={["Reason", "Claims", "Amount", "Insurers"]}>{rej.data!.reasons.map((r) => <tr key={r.reason}><Td>{r.reason}</Td><Td>{r.claims}</Td><Td>{money(r.amount)}</Td><Td className="text-xs">{r.insurers.join(", ")}</Td></tr>)}</Table>
        )}
        {(rej.data?.cuts.length ?? 0) > 0 && <div className="mt-3"><div className="mb-1 text-sm font-medium"><T>What insurers cut</T></div><Table head={["Reason", "Times", "Amount"]}>{rej.data!.cuts.map((c) => <tr key={c.label}><Td>{c.label}</Td><Td>{c.count}</Td><Td>{money(c.amount)}</Td></tr>)}</Table></div>}
      </Card>
      <Card title="Which insurers pay late">
        {late.isLoading ? <Spinner /> : (late.data?.insurers.length ?? 0) === 0 ? <p className="text-sm text-slate-500"><T>No approved claims yet.</T></p> : (
          <Table head={["Insurer", "Paid claims", "Average days to pay", "Slowest", "Open", "Overdue", "Overdue amount"]}>
            {late.data!.insurers.map((i) => <tr key={i.insurerId}><Td><b>{i.insurer}</b></Td><Td>{i.paidClaims}</Td><Td>{i.averageDaysToPay ?? "—"}</Td><Td>{i.slowestDays ?? "—"}</Td><Td>{i.openClaims}</Td><Td>{i.overdueClaims ? <Badge tone="red">{i.overdueClaims}</Badge> : 0}</Td><Td>{money(i.overdueAmount)}</Td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ───── the estimate for the family ─────

interface Est {
  id: string; total: string; roomRentExcess: string; notCovered: string; aboveInsurerRate: string; packageExtras: string; addsUp: boolean;
  mainInsurer: { insurer: string; policyNumber: string; pays: string; copay: string; roomEntitlement: string | null } | null; topupInsurer: { insurer: string; policyNumber: string; pays: string } | null;
  family: { pays: string }; package: { name: string; price: string; includesImplants: boolean; includesConsumables: boolean; exclusionNote: string | null } | null;
  lines: { description: string; amount: string; scope: string | null; why: string | null; notCovered: boolean }[]; notes: string[];
}
interface Svc { id: string; name: string; price: string }
interface EstLine { serviceId: string; quantity: string; notCovered: boolean }

/** Before admission: what each insurer is expected to pay and what the family pays. It is kept, and printable for the family. */
export function EstimatePanel() {
  const { money, can } = useMe();
  const t = useT();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [days, setDays] = useState("0");
  const [room, setRoom] = useState("");
  const [pkgId, setPkgId] = useState("");
  const [lines, setLines] = useState<EstLine[]>([{ serviceId: "", quantity: "1", notCovered: false }]);
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<Svc>("/services", { pageSize: 100 }) });
  const policies = useQuery({ queryKey: ["policies", patient?.id], queryFn: () => api.get<{ id: string; tier: string; validToday: boolean; insurer: { id: string; name: string } }[]>(`/patients/${patient!.id}/policies`), enabled: !!patient });
  const mainInsurer = policies.data?.find((p) => p.tier === "PRIMARY" && p.validToday)?.insurer;
  const packs = useQuery({ queryKey: ["insurer-packages", mainInsurer?.id], queryFn: () => api.get<{ id: string; code: string; name: string; price: string; status: string }[]>(`/claims/insurers/${mainInsurer!.id}/packages`), enabled: !!mainInsurer });
  const make = useMutation({
    mutationFn: () => api.post<Est>("/insurance/estimates", {
      patientId: patient!.id, days: Number(days) || 0, ...(room ? { roomRatePerDay: room } : {}), ...(pkgId ? { packageId: pkgId } : {}),
      lines: lines.filter((l) => l.serviceId).map((l) => ({ serviceId: l.serviceId, quantity: Math.max(1, Number(l.quantity) || 1), notCovered: l.notCovered })),
    }),
  });
  const r = make.data;
  return (
    <div className="space-y-4">
      <Card title="Estimate for the family">
        <div className="space-y-3 text-sm print:hidden">
          <PatientPicker value={patient} onPick={(p) => { setPatient(p); setPkgId(""); }} />
          {patient && (
            <>
              <p className="text-slate-600">{mainInsurer ? <>{t("Main insurer")}: <b>{mainInsurer.name}</b></> : t("No valid insurance: the family pays the whole bill.")}</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Days in hospital"><Input className="w-24" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /></Field>
                <Field label="Room rate per day"><Input className="w-32" inputMode="decimal" value={room} onChange={(e) => setRoom(dec(e.target.value))} /></Field>
                {(packs.data?.length ?? 0) > 0 && <Field label="Package (optional)"><Select value={pkgId} onChange={(e) => setPkgId(e.target.value)}><option value="">{t("No package")}</option>{packs.data!.filter((p) => p.status === "ACTIVE").map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}</Select></Field>}
              </div>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field label={i === 0 ? "Service" : ""}><Select value={l.serviceId} onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, serviceId: e.target.value } : x)))}><option value="">{t("Choose a service")}</option>{services.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.price)}</option>)}</Select></Field>
                  <Field label={i === 0 ? "Quantity" : ""}><Input className="w-20" inputMode="numeric" value={l.quantity} onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, quantity: e.target.value.replace(/\D/g, "") } : x)))} /></Field>
                  <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" checked={l.notCovered} onChange={(e) => setLines(lines.map((x, n) => (n === i ? { ...x, notCovered: e.target.checked } : x)))} /> not covered by insurance</label>
                </div>
              ))}
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setLines([...lines, { serviceId: "", quantity: "1", notCovered: false }])}>Add another service</Button>
                <Button loading={make.isPending} disabled={!can("CLAIM_READ")} onClick={() => make.mutate()}>Work out the estimate</Button>
              </div>
              <ErrorNote error={make.error} />
            </>
          )}
        </div>
      </Card>
      {r && (
        <Card title="Estimate" actions={<Button variant="secondary" onClick={() => window.print()}>Print</Button>}>
          <div className="space-y-3 text-sm" data-testid="estimate-result">
            {patient && <p><T>For</T> <b>{patient.name}</b> · {money(r.total)} <T>in all</T></p>}
            <Table head={["Who", "Pays"]}>
              {r.mainInsurer && <tr><Td>{r.mainInsurer.insurer} <span className="text-xs text-slate-500">(<T>main insurer</T>{r.mainInsurer.roomEntitlement ? ` · ${r.mainInsurer.roomEntitlement}` : ""})</span></Td><Td>{money(r.mainInsurer.pays)}</Td></tr>}
              {r.topupInsurer && <tr><Td>{r.topupInsurer.insurer} <span className="text-xs text-slate-500">(<T>top-up</T>)</span></Td><Td>{money(r.topupInsurer.pays)}</Td></tr>}
              <tr><Td><b><T>The family</T></b></Td><Td><b data-testid="family-pays">{money(r.family.pays)}</b></Td></tr>
            </Table>
            {Number(r.notCovered) > 0 && <p className="text-xs text-slate-600"><T>Not covered by insurance</T>: {money(r.notCovered)}</p>}
            {Number(r.aboveInsurerRate) > 0 && <p className="text-xs text-slate-600"><T>Above the insurer's rate</T>: {money(r.aboveInsurerRate)}</p>}
            {r.package && <p className="text-xs text-slate-600">{r.package.name} · {money(r.package.price)}{r.package.exclusionNote ? ` · ${r.package.exclusionNote}` : ""}</p>}
            <ul className="list-disc pl-5 text-xs text-slate-600">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        </Card>
      )}
    </div>
  );
}
