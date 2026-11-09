"use client";
import { useState } from "react";
import { T } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Card, ErrorNote, Input, Select, Spinner } from "./ui";

interface Identifier { id: string; type: string; value: string; issuer: string | null; fromMergedMrn: string | null; canRetire: boolean }

const LABEL: Record<string, string> = { MRN: "Patient ID (MRN)", LEGACY: "Old hospital number", EXTERNAL: "Other ID", ABHA: "ABHA" };

/**
 * The numbers a patient is known by: the MRN, an old hospital number from a previous system, and other IDs such as an insurance or scheme card. Search finds the patient by any of them.
 * A number cannot be edited. One entered wrongly is removed (with a reason, and kept in the record) and the right one added.
 */
export function IdentifiersCard({ patientId, canEdit }: { patientId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["patient-identifiers", patientId], queryFn: () => api.get<Identifier[]>(`/patients/${patientId}/identifiers`) });
  const done = async () => { await qc.invalidateQueries({ queryKey: ["patient-identifiers", patientId] }); };
  const [form, setForm] = useState({ type: "EXTERNAL", value: "", issuer: "" });
  const add = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/identifiers`, { type: form.type, value: form.value.trim(), ...(form.issuer.trim() ? { issuer: form.issuer.trim() } : {}) }),
    onSuccess: async () => { setForm({ ...form, value: "", issuer: form.type === "EXTERNAL" ? "" : form.issuer }); await done(); },
  });
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const remove = useMutation({
    mutationFn: (id: string) => api.post(`/patients/${patientId}/identifiers/${id}/remove`, { reason: reason.trim() }),
    onSuccess: async () => { setRemoving(null); setReason(""); await done(); },
  });
  const needsIssuer = form.type === "EXTERNAL";
  const ready = form.value.trim().length >= 2 && (!needsIssuer || form.issuer.trim().length >= 2);

  return (
    <Card title="Patient numbers">
      {list.isLoading ? <Spinner /> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {list.data?.map((i) => (
            <li key={i.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500"><T>{LABEL[i.type] ?? i.type}</T></span>
                <b className="font-mono">{i.value}</b>
                {i.issuer && <span className="text-xs text-slate-500">({i.issuer})</span>}
                {i.fromMergedMrn && <Badge tone="gray">{`from merged record ${i.fromMergedMrn}`}</Badge>}
                {canEdit && i.canRetire && removing !== i.id && <button className="ml-auto text-xs text-slate-500 hover:text-red-700" onClick={() => { setRemoving(i.id); setReason(""); remove.reset(); }}>Remove</button>}
              </div>
              {removing === i.id && (
                <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) remove.mutate(i.id); }}>
                  <Input aria-label="Why is it removed" placeholder="Why? e.g. typed wrongly" className="min-w-48 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <Button type="submit" variant="danger" loading={remove.isPending} disabled={reason.trim().length < 3}>Remove number</Button>
                  <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>Keep</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={remove.error} />
      {canEdit && (
        <form className="mt-3 grid grid-cols-2 gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
          <Select aria-label="Kind of number" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="EXTERNAL">Other ID (card, policy, scheme)</option>
            <option value="LEGACY">Old hospital number</option>
          </Select>
          <Input aria-label="Issued by" placeholder={needsIssuer ? "Issued by, e.g. Star Health" : "Previous system (optional)"} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />
          <Input aria-label="Number" className="col-span-2 sm:col-span-1" placeholder="Number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          <Button type="submit" loading={add.isPending} disabled={!ready}>Add number</Button>
          <div className="col-span-2"><ErrorNote error={add.error} /></div>
          <p className="col-span-2 text-xs text-slate-500"><T>Aadhaar numbers are not stored. A number can belong to one patient only.</T></p>
        </form>
      )}
    </Card>
  );
}
