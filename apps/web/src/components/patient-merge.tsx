"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

interface Found { id: string; mrn: string | null; firstName: string; lastName: string | null; gender: string; dateOfBirth: string | null; mobile: string | null; status: string }

/** Links this record (a duplicate) to the real patient. Nothing is moved or deleted and it cannot be undone, so it asks twice. */
export function MergeCard({ duplicate, onClose, onDone }: { duplicate: { id: string; mrn: string | null; version: number }; onClose: () => void; onDone: (intoId: string) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [into, setInto] = useState<Found | null>(null);
  const [reason, setReason] = useState("");
  const results = useQuery({
    queryKey: ["merge-search", q], enabled: q.trim().length >= 2 && !into,
    queryFn: () => api.page<Found>("/patients", { q: q.trim(), pageSize: 8 }),
  });
  const merge = useMutation({
    mutationFn: () => api.post<{ intoPatientId: string }>(`/patients/${duplicate.id}/merge`, { intoPatientId: (into as Found).id, version: duplicate.version, reason: reason.trim() }),
    onSuccess: async (r) => { await qc.invalidateQueries(); onDone(r.intoPatientId); },
  });
  const label = (p: Found) => `${[p.firstName, p.lastName].filter(Boolean).join(" ")} · MRN ${p.mrn ?? "—"}${p.mobile ? ` · ${p.mobile}` : ""}${p.dateOfBirth ? ` · born ${p.dateOfBirth}` : ""}`;
  return (
    <Card title="Merge into the real patient" actions={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <Notice tone="warn">Use this when the same person was registered twice. This record (MRN {duplicate.mrn ?? "—"}) stays on file and becomes inactive; the real patient’s chart will show the history of both. Nothing is deleted, and this cannot be undone.</Notice>
        {into ? (
          <div className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"><span>Real patient: <b>{label(into)}</b></span><Button variant="ghost" onClick={() => setInto(null)}>Change</Button></div>
        ) : (
          <Field label="Find the real patient (name, mobile or MRN)">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 characters" autoFocus />
          </Field>
        )}
        {!into && results.isFetching && <Spinner />}
        {!into && results.data && (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
            {results.data.data.filter((p) => p.id !== duplicate.id).map((p) => (
              <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => setInto(p)}>{label(p)}</button></li>
            ))}
            {results.data.data.filter((p) => p.id !== duplicate.id).length === 0 && <li className="px-3 py-2 text-slate-500">No other patient found.</li>}
          </ul>
        )}
        {into && (
          <>
            <Field label="Why are these the same person?"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={240} placeholder="For the record, at least 5 characters" /></Field>
            <ConfirmButton label="Merge…" confirmLabel="Yes, merge. This cannot be undone" loading={merge.isPending} disabled={reason.trim().length < 5} onConfirm={() => merge.mutate()} />
          </>
        )}
        <ErrorNote error={merge.error} />
      </div>
    </Card>
  );
}
