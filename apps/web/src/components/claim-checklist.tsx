"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea } from "./ui";

interface Item { requirementId: string; label: string; state: "ATTACHED" | "WAIVED" | "MISSING"; documentId?: string; waiverReason?: string }
interface Checklist { claimId: string; status: string; items: Item[]; missing: string[]; complete: boolean }
interface Requirement { id: string; label: string; claimType: "CASHLESS" | "REIMBURSEMENT" | null; active: boolean }

const TONE = { ATTACHED: "green", WAIVED: "amber", MISSING: "red" } as const;
const STATE = { ATTACHED: "attached", WAIVED: "not needed", MISSING: "missing" } as const;
const SENT = ["SUBMITTED", "QUERY", "APPROVED", "REJECTED", "SETTLED", "CLOSED"];

/**
 * The documents the insurer asks for before a claim is sent (docs/claim-checklist.md): what is attached, what a manager has said is not needed, and what is still
 * missing. The claim cannot be sent while anything is missing.
 */
export function ClaimChecklist({ claimId, status }: { claimId: string; status: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const [waiving, setWaiving] = useState<Item | null>(null);
  const [reason, setReason] = useState("");
  const list = useQuery({ queryKey: ["claim-checklist", claimId], queryFn: () => api.get<Checklist>(`/claims/${claimId}/checklist`) });
  const waive = useMutation({
    mutationFn: () => api.post(`/claims/${claimId}/checklist/waive`, { label: waiving!.label, reason: reason.trim() }),
    onSuccess: async () => { setWaiving(null); setReason(""); await qc.invalidateQueries({ queryKey: ["claim-checklist", claimId] }); },
  });
  const data = list.data;
  if (list.isLoading) return <Spinner />;
  if (!data || data.items.length === 0) return null;
  const sent = SENT.includes(status);
  return (
    <section aria-label="Documents the insurer needs" className="space-y-2">
      <h3 className="text-sm font-semibold">Documents the insurer needs</h3>
      {!sent && (data.complete
        ? <Notice tone="success">Everything the insurer asks for is attached. The claim can be sent.</Notice>
        : <Notice tone="warn">The claim cannot be sent yet. Still missing: {data.missing.join(", ")}.</Notice>)}
      <Table head={["Document", "Status", ""]}>
        {data.items.map((i) => (
          <tr key={i.requirementId}>
            <Td>{i.label}{i.waiverReason && <div className="text-xs text-slate-500">Not needed: {i.waiverReason}</div>}</Td>
            <Td><Badge tone={TONE[i.state]}>{STATE[i.state]}</Badge></Td>
            <Td>{i.state === "MISSING" && !sent && can("CLAIM_DOCUMENT_WAIVE") && <Button variant="ghost" onClick={() => { setWaiving(i); setReason(""); }}>Not needed…</Button>}</Td>
          </tr>
        ))}
      </Table>
      {waiving && (
        <Modal title={`${waiving.label} is not needed`} onClose={() => setWaiving(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">This lets the claim be sent without this document. Your name and the reason are kept on the claim and cannot be changed.</p>
            <Field label="Why is it not needed? (at least 10 letters)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <ErrorNote error={waive.error} />
            <div className="flex gap-2">
              <Button disabled={reason.trim().length < 10} loading={waive.isPending} onClick={() => waive.mutate()}>Confirm: not needed</Button>
              <Button variant="secondary" onClick={() => setWaiving(null)}>Cancel</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** The documents one insurer requires with every claim: added, and switched off when no longer needed (never deleted). */
export function RequiredDocuments({ insurer, onClose }: { insurer: { id: string; name: string }; onClose: () => void }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");
  const key = ["required-documents", insurer.id];
  const list = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Requirement[] }>(`/claims/insurers/${insurer.id}/required-documents`) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({ mutationFn: () => api.post(`/claims/insurers/${insurer.id}/required-documents`, { label: name.trim(), claimType: kind || null }), onSuccess: async () => { setName(""); await refresh(); } });
  const toggle = useMutation({ mutationFn: (r: Requirement) => api.post(`/claims/required-documents/${r.id}/active`, { active: !r.active }), onSuccess: refresh });
  const manage = can("CLAIM_MASTERS");
  return (
    <Modal title={`Documents ${insurer.name} needs`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">A claim to this insurer cannot be sent until each document below is attached. A manager can say one is not needed for a single claim.</p>
        {manage && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Document" className="min-w-60 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Discharge summary" /></Field>
            <Field label="Needed for"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All claims</option><option value="CASHLESS">Cashless claims</option><option value="REIMBURSEMENT">Reimbursement claims</option></Select></Field>
            <Button disabled={name.trim().length < 2} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
          </div>
        )}
        {add.error ? <p role="alert" className="text-sm text-red-700">{errorText(add.error)}</p> : <ErrorNote error={toggle.error} />}
        {list.isLoading ? <Spinner /> : (
          <Table head={["Document", "Needed for", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No documents are required yet, so claims to this insurer are not held back." } : {})}>
            {list.data?.items.map((r) => (
              <tr key={r.id}>
                <Td>{r.label}</Td>
                <Td>{r.claimType === "CASHLESS" ? "Cashless claims" : r.claimType === "REIMBURSEMENT" ? "Reimbursement claims" : "All claims"}</Td>
                <Td><Badge tone={r.active ? "green" : "gray"}>{r.active ? "required" : "switched off"}</Badge></Td>
                <Td>{manage && <Button variant="ghost" loading={toggle.isPending && toggle.variables?.id === r.id} onClick={() => toggle.mutate(r)}>{r.active ? "Switch off" : "Switch on"}</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Modal>
  );
}
