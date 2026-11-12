"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, ErrorNote } from "./ui";

interface Transmission { id: string; kind: string; status: string; channel: string; httpStatus: number | null; externalRef: string | null; detail: string | null; at: string; by: string | null }
const TONE: Record<string, "gray" | "green" | "red" | "amber"> = { SENT: "green", FAILED: "red", NOT_SENT: "amber" };
const WORDS: Record<string, string> = { SENT: "sent", FAILED: "failed", NOT_SENT: "recorded, not sent", ELIGIBILITY: "eligibility check", CLAIM: "claim" };
const proxy = (path: string) => `/api/proxy/${path}`;

/**
 * Standard-format exchange with the insurer (docs/claims.md): the eligibility request and the claim as FHIR or CSV to download, and a send through the hospital's insurer channel,
 * with every attempt listed. The insurer's answer is entered by hand in the steps around this panel.
 */
export function ClaimExchange({ claimId, hasInvoice }: { claimId: string; hasInvoice: boolean }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const [showing, setShowing] = useState(false);
  const history = useQuery({ queryKey: ["claim-transmissions", claimId], queryFn: () => api.get<Transmission[]>(`/claims/${claimId}/transmissions`), enabled: showing });
  const send = useMutation({ mutationFn: (kind: "ELIGIBILITY" | "CLAIM") => api.post(`/claims/${claimId}/transmit`, { kind }), onSuccess: async () => { setShowing(true); await qc.invalidateQueries({ queryKey: ["claim-transmissions", claimId] }); } });
  const eligibility = useMutation({
    mutationFn: () => api.get<unknown>(`/claims/${claimId}/eligibility-request`),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/fhir+json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `eligibility-${claimId}.json`; link.click();
      URL.revokeObjectURL(url);
    },
  });
  if (!can("CLAIM_MANAGE") && !can("CLAIM_READ")) return null;
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Insurer exchange (standard format)</span>
        <Button variant="secondary" loading={eligibility.isPending} onClick={() => eligibility.mutate()}>Eligibility request (FHIR)</Button>
        {hasInvoice
          ? <><a className="text-sm text-brand-700" href={proxy(`claims/${claimId}/export?format=fhir&download=1`)}>Claim (FHIR)</a><a className="text-sm text-brand-700" href={proxy(`claims/${claimId}/export?format=csv&download=1`)}>Claim (CSV)</a></>
          : <a className="text-sm text-brand-700" href={proxy(`claims/${claimId}/export?format=fhir&stage=PREAUTH&download=1`)}>Pre-authorisation (FHIR)</a>}
        {can("CLAIM_MANAGE") && <>
          <Button variant="secondary" loading={send.isPending} onClick={() => send.mutate("ELIGIBILITY")}>Send eligibility check</Button>
          <Button loading={send.isPending} onClick={() => send.mutate("CLAIM")}>Send {hasInvoice ? "claim" : "pre-authorisation"}</Button>
        </>}
        <button className="ml-auto text-xs text-slate-500 underline" onClick={() => setShowing(!showing)}>{showing ? "Hide" : "Show"} what was sent</button>
      </div>
      <ErrorNote error={send.error ?? eligibility.error} />
      {showing && (history.data?.length ? (
        <ul className="space-y-1 text-xs text-slate-600">
          {history.data.map((h) => <li key={h.id}><Badge tone={TONE[h.status] ?? "gray"}>{WORDS[h.status] ?? h.status}</Badge> {WORDS[h.kind] ?? h.kind} · {dateTime(h.at)}{h.by ? ` · ${h.by}` : ""}{h.externalRef ? ` · insurer ref ${h.externalRef}` : ""}{h.detail ? ` · ${h.detail}` : ""}</li>)}
        </ul>
      ) : <p className="text-xs text-slate-500">Nothing has been sent yet.</p>)}
      <p className="text-xs text-slate-500">The insurer&apos;s reply (eligibility result, decision, payment) is entered in the steps of the claim.</p>
    </div>
  );
}
