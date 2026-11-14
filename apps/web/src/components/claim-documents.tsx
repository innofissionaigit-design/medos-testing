"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/lib/api";
import { Badge, Button, ErrorNote, Field, Input, Notice, Select, Spinner } from "./ui";

interface DocRow { id: string; label: string; fileName: string; contentType: string; sizeBytes: number; uploadedAt: string }

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "application/pdf"];
/** What insurers and TPAs usually ask for with a claim; any other label can be typed. */
const LABELS = ["Discharge summary", "Policy card", "ID proof", "Investigation reports", "Final bill", "Prescription", "Pre-authorisation form", "Other"];
export const claimDocumentUrl = (id: string) => `/api/proxy/claim-documents/${id}/content`;
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The supporting documents of a claim (docs/claims.md): scans and PDFs the insurer or TPA asks for. Added and removed by the claims officer while the claim is open. */
export function ClaimDocuments({ claimId, open, canManage }: { claimId: string; open: boolean; canManage: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(LABELS[0]!);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DocRow | null>(null);
  const [reason, setReason] = useState("");
  const list = useQuery({ queryKey: ["claim-documents", claimId], queryFn: () => api.get<DocRow[]>(`/claims/${claimId}/documents`) });
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["claim-documents", claimId] }), qc.invalidateQueries({ queryKey: ["claim-checklist", claimId] })]); };
  const chosen = (label === "Other" ? custom : label).trim();

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!ACCEPT.includes(file.type)) throw new Error("Choose a PNG or JPEG image, or a PDF.");
      if (file.size > MAX_BYTES) throw new Error("The file is larger than 5 MB.");
      const q = new URLSearchParams({ filename: file.name, label: chosen });
      const res = await fetch(`/api/proxy/claims/${claimId}/documents?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": file.type, "x-medos-csrf": "1" }, body: file });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new Error(j.error?.message ?? "Upload failed"); }
    },
    onSuccess: async () => { setError(null); if (input.current) input.current.value = ""; await refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({ mutationFn: () => api.post(`/claim-documents/${removing!.id}/remove`, { reason: reason.trim() }), onSuccess: async () => { setRemoving(null); setReason(""); await refresh(); } });

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <p className="text-sm font-medium">Documents for the insurer</p>
      {list.isLoading ? <Spinner /> : (list.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No documents attached yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {list.data?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <div><Badge tone="gray">{d.label}</Badge> <a className="text-brand-700 hover:underline" href={claimDocumentUrl(d.id)}>{d.fileName}</a> <span className="text-xs text-slate-500">{size(d.sizeBytes)}</span></div>
              {canManage && open && <Button variant="secondary" onClick={() => { remove.reset(); setReason(""); setRemoving(d); }}>Remove</Button>}
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <Notice tone="warn">Remove {removing.fileName}? It stops showing but stays on the record with your name and reason.</Notice>
          <Field label="Reason" hint="At least 5 characters"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorNote error={remove.error} />
          <div className="flex gap-2"><Button variant="danger" loading={remove.isPending} disabled={reason.trim().length < 5} onClick={() => remove.mutate()}>Remove document</Button><Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button></div>
        </div>
      )}
      {canManage && open && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="What it is"><Select value={label} onChange={(e) => setLabel(e.target.value)}>{LABELS.map((l) => <option key={l} value={l}>{l}</option>)}</Select></Field>
          {label === "Other" && <Field label="Name it"><Input value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>}
          <input ref={input} type="file" aria-label="Choose a document" accept="image/png,image/jpeg,application/pdf" disabled={chosen.length < 2} className="text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setError(null); upload.mutate(f); } }} />
        </div>
      )}
      {upload.isPending && <p className="text-sm text-slate-500">Uploading…</p>}
      {error && <Notice tone="error">{error}</Notice>}
      {canManage && open && <p className="text-xs text-slate-500">PNG, JPEG or PDF, up to 5 MB each, 30 per claim. Documents are kept with the claim; nothing is sent to the insurer from here.</p>}
    </div>
  );
}
