"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, ErrorNote, Field, Input } from "./ui";

export interface Verification { outcome: "VERIFIED" | "NOT_ELIGIBLE"; reference: string | null; note: string | null; at: string | null; by: string | null }
export interface Enhancement { id: string; requestedAmount: string; reason: string; status: "PENDING" | "APPROVED" | "REJECTED"; approvedAmount: string | null; decisionNote: string | null; requestedAt: string; requestedBy: string | null; decidedAt: string | null; decidedBy: string | null }

interface RateCheck { totalExcess: string; lines: { lineNo: number; description: string; quantity: string; unitPrice: string; contractedPrice: string; excess: string }[] }
const editableOpen = (st: string) => ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "QUERY"].includes(st);
export interface NonPayable { id: string; description: string; amount: string; reason: string; status: "ACTIVE" | "REMOVED"; removeReason: string | null }
export interface Appeal { id: string; reason: string; status: "PENDING" | "OVERTURNED" | "UPHELD"; approvedAmount: string | null; decisionNote: string | null; requestedAt: string; requestedBy: string | null; decidedAt: string | null; decidedBy: string | null }

const APPEAL_TONE = { PENDING: "amber", OVERTURNED: "green", UPHELD: "red" } as const;
const TONE = { PENDING: "amber", APPROVED: "green", REJECTED: "red" } as const;

/**
 * The cashless cover section of a claim (docs/claims.md): the check of the patient's cover with the insurer, and requests for more authorisation while the patient is
 * admitted. MedOS records what the insurer or TPA said; it does not contact them.
 */
export function ClaimCover({ claimId, insurerId, invoiceId, tariff, type, status, verification, enhancements, nonPayables, nonPayableTotal, appeals, submitted, canManage, open }: {
  claimId: string; insurerId: string; invoiceId: string | undefined; tariff: { id: string; name: string | null; price: string | null } | null; type: string; status: string; verification: Verification | null; enhancements: Enhancement[]; nonPayables: NonPayable[]; nonPayableTotal: string; appeals: Appeal[]; submitted: boolean; canManage: boolean; open: boolean;
}) {
  const { money } = useMe();
  const qc = useQueryClient();
  const [ref, setRef] = useState("");
  const [vNote, setVNote] = useState("");
  const [ask, setAsk] = useState({ amount: "", reason: "" });
  const [answer, setAnswer] = useState({ amount: "", reason: "" });
  const done = () => { setRef(""); setVNote(""); setAsk({ amount: "", reason: "" }); setAnswer({ amount: "", reason: "" }); void qc.invalidateQueries({ queryKey: ["claim", claimId] }); void qc.invalidateQueries({ queryKey: ["claims"] }); };
  const verify = useMutation({ mutationFn: (outcome: "VERIFIED" | "NOT_ELIGIBLE") => api.post(`/claims/${claimId}/verification`, { outcome, reference: ref.trim(), ...(vNote.trim() ? { note: vNote.trim() } : {}) }), onSuccess: done });
  const request = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/enhancements`, { requestedAmount: ask.amount, reason: ask.reason.trim() }, newKey()), onSuccess: done });
  const decide = useMutation({ mutationFn: (a: { id: string; decision: "APPROVE" | "REJECT" }) => api.post(`/claims/${claimId}/enhancements/${a.id}/decision`, a.decision === "APPROVE" ? { decision: "APPROVE", amount: answer.amount, ...(answer.reason.trim() ? { reason: answer.reason.trim() } : {}) } : { decision: "REJECT", reason: answer.reason.trim() }), onSuccess: done });

  const [np, setNp] = useState({ description: "", amount: "", reason: "" });
  const [appealReason, setAppealReason] = useState("");
  const [ruling, setRuling] = useState({ amount: "", reason: "" });
  const doneMore = () => { setNp({ description: "", amount: "", reason: "" }); setAppealReason(""); setRuling({ amount: "", reason: "" }); void qc.invalidateQueries({ queryKey: ["claim", claimId] }); void qc.invalidateQueries({ queryKey: ["claims"] }); void qc.invalidateQueries({ queryKey: ["claims-summary"] }); void qc.invalidateQueries({ queryKey: ["claim-copay", claimId] }); };
  const addNp = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/non-payables`, { description: np.description.trim(), amount: np.amount, reason: np.reason.trim() }, newKey()), onSuccess: doneMore });
  const dropNp = useMutation({ mutationFn: (a: { id: string; reason: string }) => api.post(`/claims/${claimId}/non-payables/${a.id}/remove`, { reason: a.reason }), onSuccess: doneMore });
  const appeal = useMutation({ mutationFn: () => api.post(`/claims/${claimId}/appeals`, { reason: appealReason.trim() }, newKey()), onSuccess: doneMore });
  const rule = useMutation({ mutationFn: (a: { id: string; decision: "OVERTURN" | "UPHOLD" }) => api.post(`/claims/${claimId}/appeals/${a.id}/decision`, a.decision === "OVERTURN" ? { decision: "OVERTURN", amount: ruling.amount, ...(ruling.reason.trim() ? { reason: ruling.reason.trim() } : {}) } : { decision: "UPHOLD", reason: ruling.reason.trim() }), onSuccess: doneMore });
  const packs = useQuery({ queryKey: ["insurer-packages", insurerId], queryFn: () => api.get<{ id: string; code: string; name: string; price: string; status: string }[]>(`/claims/insurers/${insurerId}/packages`), enabled: editableOpen(status) });
  const choose = useMutation({ mutationFn: (packageId: string | null) => api.post(`/claims/${claimId}/tariff-package`, { packageId }), onSuccess: doneMore });
  const [checked, setChecked] = useState<RateCheck | null>(null);
  const check = useMutation({ mutationFn: () => api.get<RateCheck>(`/claims/${claimId}/rate-check`, invoiceId ? { invoiceId } : {}), onSuccess: (r) => setChecked(r) });
  const applyCheck = useMutation({ mutationFn: () => api.post<{ added: number }>(`/claims/${claimId}/rate-check/apply`, invoiceId ? { invoiceId } : {}), onSuccess: () => { setChecked(null); doneMore(); } });
  const editableItems = ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "QUERY"].includes(status);
  const pendingAppeal = appeals.find((x) => x.status === "PENDING");
  const canAppeal = canManage && status === "REJECTED" && submitted && !pendingAppeal;
  const pending = enhancements.find((e) => e.status === "PENDING");
  const canAsk = canManage && type === "CASHLESS" && status === "PREAUTH_APPROVED" && !pending;
  if (!verification && !open && enhancements.length === 0 && nonPayables.length === 0 && appeals.length === 0 && !canAppeal) return null;

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 text-sm">
      <div className="space-y-2" aria-label="Insurer check">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Insurer check</span>
          {verification ? <Badge tone={verification.outcome === "VERIFIED" ? "green" : "red"}>{verification.outcome === "VERIFIED" ? "Cover confirmed" : "Not eligible"}</Badge> : <Badge tone="gray">Not checked yet</Badge>}
          {verification && <span className="text-slate-500">ref {verification.reference}{verification.at ? ` · ${new Date(verification.at).toLocaleString()}` : ""}{verification.by ? ` · ${verification.by}` : ""}</span>}
        </div>
        {verification?.note && <p className="text-slate-600">{verification.note}</p>}
        {canManage && open && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Insurer's reference"><Input className="w-40" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
            <Field label="What they said (needed if not eligible)"><Input className="w-64" value={vNote} onChange={(e) => setVNote(e.target.value)} /></Field>
            <Button variant="secondary" disabled={ref.trim().length < 3} loading={verify.isPending} onClick={() => verify.mutate("VERIFIED")}>Cover confirmed</Button>
            <Button variant="secondary" disabled={ref.trim().length < 3 || vNote.trim().length < 5} loading={verify.isPending} onClick={() => verify.mutate("NOT_ELIGIBLE")}>Not eligible</Button>
          </div>
        )}
        <ErrorNote error={verify.error} />
      </div>

      {(type === "CASHLESS" && (enhancements.length > 0 || canAsk)) && (
        <div className="space-y-2 border-t border-slate-200 pt-3" aria-label="More authorisation">
          <div className="font-medium">More authorisation while admitted</div>
          {enhancements.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[e.status]}>{e.status.toLowerCase()}</Badge>
              <span>asked {money(e.requestedAmount)}{e.approvedAmount ? `, approved ${money(e.approvedAmount)}` : ""}</span>
              <span className="text-slate-500">· {e.reason}{e.decisionNote ? ` · insurer: ${e.decisionNote}` : ""}</span>
            </div>
          ))}
          {pending && canManage && open && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Amount approved"><Input className="w-36" inputMode="decimal" value={answer.amount} onChange={(e) => setAnswer({ ...answer, amount: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Field label="Insurer's note (needed if rejected)"><Input className="w-64" value={answer.reason} onChange={(e) => setAnswer({ ...answer, reason: e.target.value })} /></Field>
              <Button disabled={!answer.amount} loading={decide.isPending} onClick={() => decide.mutate({ id: pending.id, decision: "APPROVE" })}>Insurer approved</Button>
              <Button variant="secondary" disabled={answer.reason.trim().length < 5} loading={decide.isPending} onClick={() => decide.mutate({ id: pending.id, decision: "REJECT" })}>Insurer rejected</Button>
            </div>
          )}
          {canAsk && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Extra amount to ask for"><Input className="w-36" inputMode="decimal" value={ask.amount} onChange={(e) => setAsk({ ...ask, amount: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Field label="Why (at least 10 characters)"><Input className="w-72" value={ask.reason} onChange={(e) => setAsk({ ...ask, reason: e.target.value })} /></Field>
              <Button variant="secondary" disabled={!ask.amount || ask.reason.trim().length < 10} loading={request.isPending} onClick={() => request.mutate()}>Ask for more</Button>
            </div>
          )}
          <ErrorNote error={request.error ?? decide.error} />
        </div>
      )}

      {canManage && editableItems && (
        <div className="space-y-2 border-t border-slate-200 pt-3" aria-label="Insurer prices">
          <div className="font-medium">Insurer's prices</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Package"><select className="rounded-md border border-slate-300 px-2 py-1.5" value={tariff?.id ?? ""} onChange={(e) => choose.mutate(e.target.value || null)}><option value="">No package</option>{packs.data?.filter((p) => p.status === "ACTIVE" || p.id === tariff?.id).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name} · {money(p.price)}</option>)}</select></Field>
            <Button variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>Check against the insurer's rates</Button>
          </div>
          {tariff && <p className="text-slate-600">Under package {tariff.name}: the insurer is never asked for more than {money(tariff.price ?? "0")}; the rest is paid by the patient.</p>}
          {checked && (
            <div className="space-y-1">
              {checked.lines.length === 0 ? <p className="text-slate-600">None of this invoice's lines have a rate on this insurer's card.</p> : (
                <>
                  {checked.lines.map((l) => <div key={l.lineNo} className="flex flex-wrap gap-2"><span>{l.description}</span><span className="text-slate-500">billed {money(l.unitPrice)}, insurer pays {money(l.contractedPrice)}{Number(l.excess) > 0 ? ` · ${money(l.excess)} above` : " · within the rate"}</span></div>)}
                  {Number(checked.totalExcess) > 0 ? <Button variant="secondary" loading={applyCheck.isPending} onClick={() => applyCheck.mutate()}>Leave {money(checked.totalExcess)} to the patient (add as not payable)</Button> : <p className="text-slate-600">Everything is within the insurer's rates.</p>}
                </>
              )}
            </div>
          )}
          <ErrorNote error={choose.error ?? check.error ?? applyCheck.error} />
        </div>
      )}

      {(nonPayables.length > 0 || (canManage && editableItems)) && (
        <div className="space-y-2 border-t border-slate-200 pt-3" aria-label="Not payable by the insurer">
          <div className="font-medium">Not payable by the insurer {Number(nonPayableTotal) > 0 && <span className="font-normal text-slate-600">· patient pays {money(nonPayableTotal)} of these</span>}</div>
          {nonPayables.map((n) => (
            <div key={n.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={n.status === "ACTIVE" ? "amber" : "gray"}>{n.status === "ACTIVE" ? money(n.amount) : "removed"}</Badge>
              <span className={n.status === "REMOVED" ? "text-slate-400 line-through" : ""}>{n.description}</span>
              <span className="text-slate-500">· {n.reason}{n.removeReason ? ` · removed: ${n.removeReason}` : ""}</span>
              {n.status === "ACTIVE" && canManage && editableItems && <Button variant="secondary" loading={dropNp.isPending} onClick={() => { const why = window.prompt("Why is this item being removed? (at least 5 characters)"); if (why && why.trim().length >= 5) dropNp.mutate({ id: n.id, reason: why.trim() }); }}>Remove</Button>}
            </div>
          ))}
          {canManage && editableItems && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Item"><Input className="w-56" value={np.description} onChange={(e) => setNp({ ...np, description: e.target.value })} /></Field>
              <Field label="Amount"><Input className="w-28" inputMode="decimal" value={np.amount} onChange={(e) => setNp({ ...np, amount: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Field label="Why not payable"><Input className="w-64" value={np.reason} onChange={(e) => setNp({ ...np, reason: e.target.value })} /></Field>
              <Button variant="secondary" disabled={np.description.trim().length < 3 || !np.amount || np.reason.trim().length < 5} loading={addNp.isPending} onClick={() => addNp.mutate()}>Add item</Button>
            </div>
          )}
          <ErrorNote error={addNp.error ?? dropNp.error} />
        </div>
      )}

      {(appeals.length > 0 || canAppeal) && (
        <div className="space-y-2 border-t border-slate-200 pt-3" aria-label="Appeal">
          <div className="font-medium">Appeal against the rejection</div>
          {appeals.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={APPEAL_TONE[x.status]}>{x.status === "OVERTURNED" ? "won" : x.status === "UPHELD" ? "lost" : "waiting"}</Badge>
              <span>{x.reason}</span>
              <span className="text-slate-500">{x.approvedAmount ? `· now approved ${money(x.approvedAmount)}` : ""}{x.decisionNote ? ` · insurer: ${x.decisionNote}` : ""}</span>
            </div>
          ))}
          {pendingAppeal && canManage && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Amount now approved"><Input className="w-36" inputMode="decimal" value={ruling.amount} onChange={(e) => setRuling({ ...ruling, amount: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Field label="Insurer's note (needed if the appeal is lost)"><Input className="w-64" value={ruling.reason} onChange={(e) => setRuling({ ...ruling, reason: e.target.value })} /></Field>
              <Button disabled={!ruling.amount} loading={rule.isPending} onClick={() => rule.mutate({ id: pendingAppeal.id, decision: "OVERTURN" })}>Appeal won</Button>
              <Button variant="secondary" disabled={ruling.reason.trim().length < 5} loading={rule.isPending} onClick={() => rule.mutate({ id: pendingAppeal.id, decision: "UPHOLD" })}>Appeal lost</Button>
            </div>
          )}
          {canAppeal && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Why the rejection is wrong (at least 10 characters)"><Input className="w-96" value={appealReason} onChange={(e) => setAppealReason(e.target.value)} /></Field>
              <Button variant="secondary" disabled={appealReason.trim().length < 10} loading={appeal.isPending} onClick={() => appeal.mutate()}>Send appeal</Button>
            </div>
          )}
          <ErrorNote error={appeal.error ?? rule.error} />
        </div>
      )}
    </div>
  );
}
