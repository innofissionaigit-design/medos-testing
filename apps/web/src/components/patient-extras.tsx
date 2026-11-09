"use client";
import { useRef, useState } from "react";
import { T } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

export interface EditablePatient {
  id: string; firstName: string; lastName: string | null; gender: string; mobile: string | null; email?: string | null; addressLine: string | null; city: string | null; district: string | null; state: string | null;
  postalCode: string | null; guardianName: string | null; guardianRelation: string | null; guardianMobile: string | null; emergencyContactName: string | null; emergencyContactMobile: string | null;
  bloodGroup: string | null; version: number;
}

const BLOOD = ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"];
const bloodLabel = (b: string) => b.replace("_POS", "+").replace("_NEG", "−");
const FIELDS = ["firstName", "lastName", "gender", "mobile", "email", "addressLine", "city", "district", "state", "postalCode", "guardianName", "guardianRelation", "guardianMobile", "emergencyContactName", "emergencyContactMobile", "bloodGroup"] as const;
type FieldKey = (typeof FIELDS)[number];

/** Edit demographics. Only changed fields are sent; the record's version guards against two people editing at once. */
export function EditPatientModal({ patient, onClose }: { patient: EditablePatient; onClose: () => void }) {
  const qc = useQueryClient();
  const initial = Object.fromEntries(FIELDS.map((k) => [k, (patient[k] as string | null) ?? ""])) as Record<FieldKey, string>;
  const [v, setV] = useState(initial);
  const set = (k: FieldKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const changed = FIELDS.filter((k) => v[k].trim() !== initial[k]);
  const save = useMutation({
    mutationFn: () => api.patch(`/patients/${patient.id}`, {
      version: patient.version,
      ...Object.fromEntries(changed.map((k) => [k, v[k].trim() === "" ? (k === "firstName" || k === "gender" ? v[k] : null) : v[k].trim()])),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["patient", patient.id] }); onClose(); },
  });
  const stale = save.error instanceof ApiError && (save.error.code === "STALE_VERSION" || save.error.status === 409);
  const text = (k: FieldKey, label: string, extra?: { hint?: string; mode?: "tel" | "numeric" }) => (
    <Field label={label} {...(extra?.hint ? { hint: extra.hint } : {})}><Input value={v[k]} inputMode={extra?.mode} onChange={set(k)} /></Field>
  );
  return (
    <Modal title="Edit patient details" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        {text("firstName", "First name")}{text("lastName", "Last name")}
        <Field label="Gender"><Select value={v.gender} onChange={set("gender")}><option value="FEMALE">Female</option><option value="MALE">Male</option><option value="OTHER">Other</option><option value="UNKNOWN">Unknown</option></Select></Field>
        {text("mobile", "Mobile", { mode: "tel", hint: "10-digit Indian number" })}
        {text("email", "Email", { hint: "Used only if the patient agrees to be emailed" })}
        <Field label="Blood group"><Select value={v.bloodGroup} onChange={set("bloodGroup")}><option value="">Not recorded</option>{BLOOD.map((b) => <option key={b} value={b}>{bloodLabel(b)}</option>)}</Select></Field>
        {text("addressLine", "Address")}{text("city", "City")}{text("district", "District")}{text("state", "State")}{text("postalCode", "PIN code", { mode: "numeric" })}
        {text("guardianName", "Guardian name")}{text("guardianRelation", "Guardian relation")}{text("guardianMobile", "Guardian mobile", { mode: "tel" })}
        {text("emergencyContactName", "Emergency contact")}{text("emergencyContactMobile", "Emergency contact mobile", { mode: "tel" })}
        <div className="sm:col-span-2 space-y-2">
          {stale && <Notice tone="warn">Someone else changed this patient while you were editing. Close this window, reopen the patient and make your change again.</Notice>}
          {!stale && <ErrorNote error={save.error} />}
          <p className="text-xs text-slate-500">Date of birth and MRN cannot be changed here. Every change is recorded in the audit trail.</p>
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={changed.length === 0} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></div>
      </div>
    </Modal>
  );
}

export interface PatientFileRow { id: string; kind: "PHOTO" | "DOCUMENT"; title: string; fileName: string; contentType: string; sizeBytes: number; uploadedAt: string }
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "application/pdf"];

export const fileUrl = (id: string, download = false) => `/api/proxy/files/${id}/content${download ? "?download=1" : ""}`;

/** Profile photo and scanned documents for one patient. Files are validated again on the server (type, content, size). */
export function FilesCard({ patientId }: { patientId: string }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"PHOTO" | "DOCUMENT">("DOCUMENT");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PatientFileRow | null>(null);
  const [reason, setReason] = useState("");
  const list = useQuery({ queryKey: ["patient-files", patientId], queryFn: () => api.get<PatientFileRow[]>(`/patients/${patientId}/files`), enabled: can("PATIENT_READ") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["patient-files", patientId] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const q = new URLSearchParams({ kind, filename: file.name, ...(kind === "DOCUMENT" ? { title: title.trim() } : {}) });
      const res = await fetch(`/api/proxy/patients/${patientId}/files?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": file.type, "x-medos-csrf": "1" }, body: file });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new Error(j.error?.message ?? "Upload failed"); }
    },
    onSuccess: async () => { setTitle(""); if (input.current) input.current.value = ""; await refresh(); await qc.invalidateQueries({ queryKey: ["patient-photo", patientId] }); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.post(`/files/${removing!.id}/remove`, { reason: reason.trim() }),
    onSuccess: async () => { setRemoving(null); setReason(""); await refresh(); await qc.invalidateQueries({ queryKey: ["patient-photo", patientId] }); },
  });

  function pick(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) return setError("Choose a PNG or JPEG image, or a PDF.");
    if (file.size > MAX_BYTES) return setError("The file is larger than 5 MB.");
    if (kind === "PHOTO" && file.type === "application/pdf") return setError("A profile photo must be an image.");
    if (kind === "DOCUMENT" && title.trim().length < 2) return setError("Give the document a title first.");
    upload.mutate(file);
  }

  const photo = list.data?.find((f) => f.kind === "PHOTO");
  const docs = list.data?.filter((f) => f.kind === "DOCUMENT") ?? [];
  return (
    <Card title="Photo and documents">
      {list.isLoading ? <Spinner /> : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {photo ? <img src={fileUrl(photo.id)} alt="Patient photo" className="h-20 w-20 rounded-md border border-slate-200 object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs text-slate-400"><T>No photo</T></div>}
            {photo && can("PATIENT_UPDATE") && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => { setRemoving(photo); setReason(""); }}>remove photo</button>}
          </div>
          <ul className="divide-y divide-slate-100">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span><a className="font-medium text-brand-700 hover:underline" href={fileUrl(d.id, true)}>{d.title}</a> <span className="text-slate-500">· {d.fileName} · {Math.max(1, Math.round(d.sizeBytes / 1024))} KB · {dateTime(d.uploadedAt)}</span></span>
                {can("PATIENT_UPDATE") && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => { setRemoving(d); setReason(""); }}>remove</button>}
              </li>
            ))}
            {docs.length === 0 && <li className="py-1.5 text-sm text-slate-500"><T>No documents uploaded.</T></li>}
          </ul>
          {can("PATIENT_UPDATE") && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Select aria-label="Upload type" value={kind} onChange={(e) => setKind(e.target.value as "PHOTO" | "DOCUMENT")}><option value="DOCUMENT">Document</option><option value="PHOTO">Profile photo</option></Select>
              {kind === "DOCUMENT" && <Input className="sm:col-span-1" aria-label="Document title" placeholder="Title (e.g. Lab report)" value={title} onChange={(e) => setTitle(e.target.value)} />}
              <input ref={input} type="file" aria-label="Choose file" accept={ACCEPT.join(",")} disabled={upload.isPending} onChange={(e) => pick(e.target.files?.[0])} className="col-span-2 text-sm file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1" />
            </div>
          )}
          {upload.isPending && <p className="text-sm text-slate-500">Uploading…</p>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
      {removing && (
        <Modal title={`Remove ${removing.kind === "PHOTO" ? "photo" : removing.title}?`} onClose={() => setRemoving(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">The file is hidden from the record but kept for the retention period; the removal is audited.</p>
            <Field label="Reason"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <ErrorNote error={remove.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemoving(null)}>Keep</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** Small round avatar for a patient header. */
export function PatientPhoto({ patientId }: { patientId: string }) {
  const { can } = useMe();
  const q = useQuery({ queryKey: ["patient-photo", patientId], queryFn: async () => (await api.get<PatientFileRow[]>(`/patients/${patientId}/files`)).find((f) => f.kind === "PHOTO") ?? null, enabled: can("PATIENT_READ") });
  return q.data ? <img src={fileUrl(q.data.id)} alt="" className="h-12 w-12 rounded-full border border-slate-200 object-cover" /> : null;
}
