"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td } from "./ui";

const VITALS: { type: string; label: string; unit: string }[] = [
  { type: "SYSTOLIC_BP", label: "BP systolic", unit: "mmHg" }, { type: "DIASTOLIC_BP", label: "BP diastolic", unit: "mmHg" }, { type: "PULSE", label: "Pulse", unit: "/min" },
  { type: "TEMPERATURE", label: "Temperature", unit: "°C" }, { type: "SPO2", label: "SpO₂", unit: "%" }, { type: "RESPIRATORY_RATE", label: "Resp. rate", unit: "/min" }, { type: "WEIGHT", label: "Weight", unit: "kg" },
];

interface Obs { id: string; type: string; value: string; unit: string; recordedAt: string; status: string }

/** Vitals for an inpatient: record a set of readings and see the recent ones. Wrong readings are marked in error, never deleted. */
export function VitalsCard({ encounterId, open }: { encounterId: string; open: boolean }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const [vit, setVit] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ["ipd-vitals", encounterId], queryFn: () => api.get<{ items: Obs[] }>(`/encounters/${encounterId}/observations`), enabled: can("VITALS_READ") });
  const add = useMutation({
    mutationFn: () => api.post(`/encounters/${encounterId}/observations`, { observations: Object.entries(vit).filter(([, v]) => v.trim() !== "").map(([type, v]) => ({ type, value: Number(v) })) }),
    onSuccess: async () => { setVit({}); await qc.invalidateQueries({ queryKey: ["ipd-vitals", encounterId] }); },
  });
  const wrong = useMutation({ mutationFn: (id: string) => api.post(`/observations/${id}/enter-in-error`, { reason: "Recorded in error" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["ipd-vitals", encounterId] }) });
  const rows = (list.data?.items ?? []).filter((o) => o.status === "FINAL").slice(0, 12);
  return (
    <Card title="Vitals">
      {open && can("VITALS_CREATE") && (
        <form className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          {VITALS.map((v) => <Input key={v.type} inputMode="decimal" placeholder={`${v.label} (${v.unit})`} aria-label={v.label} value={vit[v.type] ?? ""} onChange={(e) => setVit({ ...vit, [v.type]: e.target.value })} />)}
          <Button type="submit" variant="secondary" loading={add.isPending} disabled={!Object.values(vit).some((x) => x.trim())}>Record vitals</Button>
          <div className="col-span-2 sm:col-span-4"><ErrorNote error={add.error ?? wrong.error} /></div>
        </form>
      )}
      {list.isLoading ? <Spinner /> : (
        <Table head={["When", "Reading", "Value", ""]} {...(rows.length === 0 ? { empty: "No vitals recorded yet." } : {})}>
          {rows.map((o) => (
            <tr key={o.id}><Td>{dateTime(o.recordedAt)}</Td><Td>{VITALS.find((v) => v.type === o.type)?.label ?? o.type}</Td><Td>{o.value} {o.unit}</Td>
              <Td>{open && can("VITALS_CREATE") && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => wrong.mutate(o.id)}>entered in error</button>}</Td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

interface Task { id: string; type: string; title: string; dueAt: string; status: string }

/** Nursing tasks (vitals rounds, procedures, reminders) with due times. */
export function TasksCard({ admissionId, open }: { admissionId: string; open: boolean }) {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const [f, setF] = useState({ type: "OTHER", title: "", dueAt: "" });
  const list = useQuery({ queryKey: ["tasks", admissionId], queryFn: () => api.get<Task[]>(`/admissions/${admissionId}/tasks`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks", admissionId] });
  const add = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/tasks`, { type: f.type, title: f.title.trim(), dueAt: new Date(f.dueAt).toISOString() }), onSuccess: async () => { setF({ type: "OTHER", title: "", dueAt: "" }); await refresh(); } });
  const done = useMutation({ mutationFn: (id: string) => api.post(`/tasks/${id}/complete`, {}), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/tasks/${id}/cancel`, { reason: "No longer needed" }), onSuccess: refresh });
  const canDoc = open && can("NURSING_DOCUMENT");
  return (
    <Card title="Tasks">
      <Table head={["Task", "Due", "Status", ""]} {...((Array.isArray(list.data) ? list.data.length : 0) === 0 ? { empty: "No tasks." } : {})}>
        {(Array.isArray(list.data) ? list.data : []).map((t) => (
          <tr key={t.id}><Td>{t.title}<div className="text-xs text-slate-500">{t.type.toLowerCase()}</div></Td><Td>{dateTime(t.dueAt)}</Td><Td><Badge tone={t.status === "PENDING" ? "amber" : t.status === "DONE" ? "green" : "gray"}>{t.status.toLowerCase()}</Badge></Td>
            <Td>{canDoc && t.status === "PENDING" && <div className="flex gap-1"><Button onClick={() => done.mutate(t.id)}>Done</Button><Button variant="ghost" onClick={() => cancel.mutate(t.id)}>Cancel</Button></div>}</Td></tr>
        ))}
      </Table>
      {canDoc && (
        <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); if (f.title.trim().length >= 3 && f.dueAt) add.mutate(); }}>
          <Select aria-label="Task type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="OTHER">Other</option><option value="VITALS">Vitals round</option><option value="MEDICATION">Medication</option></Select>
          <Input className="sm:col-span-2" placeholder="Task (e.g. Check drain output)" aria-label="Task title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <Input type="datetime-local" aria-label="Due time" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
          <Button type="submit" loading={add.isPending} disabled={f.title.trim().length < 3 || !f.dueAt}>Add task</Button>
          <div className="col-span-2 sm:col-span-5"><ErrorNote error={add.error ?? done.error ?? cancel.error} /></div>
        </form>
      )}
    </Card>
  );
}

/** "Missed" and "Refused" doses need a remark so the record explains itself. */
export function DoseReasonModal({ status, onClose, onSubmit, error, busy }: { status: "MISSED" | "REFUSED" | "HELD"; onClose: () => void; onSubmit: (remarks: string) => void; error: unknown; busy: boolean }) {
  const [remarks, setRemarks] = useState("");
  return (
    <Modal title={`Mark dose as ${status.toLowerCase()}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Remarks" hint="Why was the dose not given? At least 3 characters."><Input autoFocus value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Back</Button><Button disabled={remarks.trim().length < 3} loading={busy} onClick={() => onSubmit(remarks.trim())}>Save</Button></div>
      </div>
    </Modal>
  );
}

/** Waive a clearance step (not medical fitness) with a written reason; the waiver is audited. */
export function WaiveButton({ admissionId, step, onDone }: { admissionId: string; step: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const waive = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/discharge/waive`, { step, reason: reason.trim() }), onSuccess: () => { setOpen(false); setReason(""); onDone(); } });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>Waive…</Button>
      {open && (
        <Modal title={`Waive “${step.replace(/_/g, " ").toLowerCase()}”`} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Field label="Reason" hint="At least 10 characters. This is recorded permanently."><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <ErrorNote error={waive.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 10} loading={waive.isPending} onClick={() => waive.mutate()}>Waive this step</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Cancel an admission that was created by mistake (frees the bed). Discharge is the normal way to end a stay. */
export function CancelAdmission({ admissionId, onDone }: { admissionId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const cancel = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/cancel`, { reason: reason.trim() }), onSuccess: onDone });
  return (
    <Card title="Admitted by mistake?">
      <div className="space-y-2">
        <p className="text-sm text-slate-600">Cancelling releases the bed and closes the admission as cancelled. For a normal end of stay, use Discharge.</p>
        <Input placeholder="Reason (at least 3 characters)" aria-label="Cancel reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorNote error={cancel.error} />
        <ConfirmButton label="Cancel this admission" confirmLabel="Yes, cancel the admission" disabled={reason.trim().length < 3} loading={cancel.isPending} onConfirm={() => cancel.mutate()} />
      </div>
    </Card>
  );
}
