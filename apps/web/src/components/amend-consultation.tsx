"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";
import { blankItem, RxRows, toPayload, type RxItem } from "./rx-editor";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Spinner, Textarea } from "./ui";

export interface ConsultContent { chiefComplaint?: string; historyOfPresentIllness?: string; examination?: string; advice?: string; followUp?: { afterDays?: number; notes?: string } }
export interface DxRow { id: string; text: string; code: string | null; type: string }
export interface VersionRow { version: number; kind: string; reason: string | null; authorName: string | null; createdAt: string }
interface Warning { allergen: string; matchedItem: string; severity: string }

/** Amend a signed consultation. The original stays on file; the amendment needs a reason and creates a new version. */
export function AmendModal({ encounterId, currentVersion, content, diagnoses, rxItems, onClose, onDone }: {
  encounterId: string; currentVersion: number; content: ConsultContent; diagnoses: DxRow[]; rxItems: RxItem[]; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState<ConsultContent>(content);
  const [dx, setDx] = useState<{ text: string; code: string; type: string }[]>(diagnoses.map((d) => ({ text: d.text, code: d.code ?? "", type: d.type })));
  const [items, setItems] = useState<RxItem[]>(rxItems.map((i) => ({ ...i })));
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState<Warning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);

  const dxChanged = JSON.stringify(dx.map((d) => [d.text.trim(), d.code.trim(), d.type])) !== JSON.stringify(diagnoses.map((d) => [d.text, d.code ?? "", d.type]));
  const rxChanged = JSON.stringify(items.filter((i) => i.genericName.trim()).map(toPayload)) !== JSON.stringify(rxItems.map(toPayload));
  const clean = (): ConsultContent => {
    const out: ConsultContent = {};
    for (const k of ["chiefComplaint", "historyOfPresentIllness", "examination", "advice"] as const) { const v = note[k]?.trim(); if (v) out[k] = v; }
    if (note.followUp?.afterDays) out.followUp = { afterDays: note.followUp.afterDays };
    return out;
  };
  const amend = useMutation({
    mutationFn: (acknowledge: boolean) => api.post(`/encounters/${encounterId}/consultation/amend`, {
      expectedVersion: currentVersion, reason: reason.trim(), content: clean(),
      ...(dxChanged ? { diagnoses: dx.filter((d) => d.text.trim()).map((d) => ({ text: d.text.trim(), type: d.type, ...(d.code.trim() ? { code: d.code.trim() } : {}) })) } : {}),
      ...(rxChanged ? { prescription: { items: items.filter((i) => i.genericName.trim()).map(toPayload) } } : {}),
      ...(acknowledge ? { acknowledgeAllergyWarnings: true } : {}),
    }),
    onSuccess: onDone,
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: Warning[] } | undefined)?.allergyWarnings) ?? []); },
  });
  const stale = amend.error instanceof ApiError && amend.error.code === "STALE_VERSION";

  return (
    <Modal title="Amend signed consultation" onClose={onClose} wide>
      <div className="space-y-3">
        <Notice tone="warn">The signed version stays on file. Your changes are recorded as a new version with your name, the time and your reason.</Notice>
        <Field label="Why is this being amended?" hint="At least 10 characters"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="Complaint"><Textarea value={note.chiefComplaint ?? ""} onChange={(e) => setNote({ ...note, chiefComplaint: e.target.value })} /></Field>
        <Field label="History"><Textarea value={note.historyOfPresentIllness ?? ""} onChange={(e) => setNote({ ...note, historyOfPresentIllness: e.target.value })} /></Field>
        <Field label="Examination"><Textarea value={note.examination ?? ""} onChange={(e) => setNote({ ...note, examination: e.target.value })} /></Field>
        <Field label="Advice"><Textarea value={note.advice ?? ""} onChange={(e) => setNote({ ...note, advice: e.target.value })} /></Field>
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Diagnoses</div>
          {dx.map((d, i) => (
            <div key={i} className="mb-1 grid grid-cols-12 gap-2">
              <Input className="col-span-6" aria-label="Diagnosis" value={d.text} onChange={(e) => setDx(dx.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <Input className="col-span-3" aria-label="Code" placeholder="ICD code" value={d.code} onChange={(e) => setDx(dx.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
              <select aria-label="Type" className="col-span-2 rounded-md border border-slate-300 px-2 text-sm" value={d.type} onChange={(e) => setDx(dx.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}><option value="PROVISIONAL">Provisional</option><option value="FINAL">Final</option><option value="SECONDARY">Secondary</option></select>
              <button className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove diagnosis" onClick={() => setDx(dx.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <Button variant="ghost" onClick={() => setDx([...dx, { text: "", code: "", type: "FINAL" }])}>+ Add diagnosis</Button>
        </div>
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Prescription</div>
          <RxRows items={items} setItems={setItems} disabled={false} />
          <Button variant="ghost" onClick={() => setItems([...items, blankItem()])}>+ Add medicine</Button>
        </div>
        {ack && (
          <div className="space-y-2">
            <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen}`).join("; ")}</Notice>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to amend.</label>
          </div>
        )}
        {stale ? <Notice tone="warn">This consultation was amended by someone else. Close this window, reopen the visit and review the latest version first.</Notice> : <ErrorNote error={amend.error instanceof ApiError && amend.error.code === "ALLERGY_CONFLICT" ? null : amend.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={reason.trim().length < 10 || !note.chiefComplaint?.trim() || (ack !== null && !ackChecked)} loading={amend.isPending} onClick={() => amend.mutate(ack !== null)}>Save as new version</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Version history of a signed consultation: who changed what version, when and why; any version can be read. */
export function VersionHistory({ encounterId, versions }: { encounterId: string; versions: VersionRow[] }) {
  const { dateTime } = useMe();
  const [open, setOpen] = useState<number | null>(null);
  const v = useQuery({ queryKey: ["consult-version", encounterId, open], queryFn: () => api.get<{ content: ConsultContent }>(`/encounters/${encounterId}/consultation/versions/${open}`), enabled: open !== null });
  const qc = useQueryClient();
  void qc;
  if (versions.length <= 1) return null;
  return (
    <Card title="Version history">
      <ul className="space-y-1 text-sm">
        {versions.map((x) => (
          <li key={x.version} className="flex flex-wrap items-center gap-2">
            <Badge tone={x.kind === "AMENDED" ? "amber" : "green"}>v{x.version} {x.kind.toLowerCase()}</Badge>
            <span className="text-slate-600">{x.authorName ?? "—"} · {dateTime(x.createdAt)}{x.reason ? ` · ${x.reason}` : ""}</span>
            <button className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(open === x.version ? null : x.version)}>{open === x.version ? "hide" : "view"}</button>
          </li>
        ))}
      </ul>
      {open !== null && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          {v.isLoading ? <Spinner /> : v.data ? (
            <dl className="space-y-1">
              {([["Complaint", v.data.content.chiefComplaint], ["History", v.data.content.historyOfPresentIllness], ["Examination", v.data.content.examination], ["Advice", v.data.content.advice]] as const).filter(([, t]) => t).map(([k, t]) => <div key={k}><dt className="text-xs uppercase text-slate-500">{k}</dt><dd className="whitespace-pre-wrap">{t}</dd></div>)}
            </dl>
          ) : <ErrorNote error={v.error} />}
        </div>
      )}
    </Card>
  );
}
