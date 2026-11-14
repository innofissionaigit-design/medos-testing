"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, PageHeader, Select, Spinner, StatusBadge, Textarea } from "@/components/ui";
import { AmendModal, VersionHistory, type VersionRow } from "@/components/amend-consultation";
import { FollowUpCard } from "@/components/follow-up-extras";
import { VitalsCard } from "@/components/ipd-extras";
import { VisitLabResults } from "@/components/lab";
import { AiAssist } from "@/components/ai";
import { VisitRadiology } from "@/components/radiology";
import { HandwrittenCard, InvestigationsPicker, RxPreview, ShareCard, StopMedicinesCard, TemplatesBar } from "@/components/prescription-extras";
import type { FillResult } from "@/components/scan-prescription";
import { blankItem, RxRows, toPayload, type RxItem } from "@/components/rx-editor";
import { api, ApiError, printUrl } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

interface Workspace {
  header: { patientId: string; mrn: string | null; name: string; gender: string; age: AgeValue; bloodGroup: string | null; encounterId: string; encounterNumber: string; visitStatus: string; startedAt: string; practitionerId: string | null; practitionerName: string | null; practitionerSpecialty: string | null; practitionerRegistrationNo: string | null; departmentName: string | null; consultedByVideo?: boolean };
  allergies: { id: string; allergen: string; severity: string; reaction: string | null }[];
  latestVitals: Record<string, { value: string; unit: string; recordedAt: string }>;
  previousVisits: { id: string; encounterNumber: string; startedAt: string; practitionerName: string | null; diagnoses?: { text: string }[]; summary?: string | null }[];
  consultation: Consultation;
}
interface Order { id: string; orderNumber: string | null; status: string; source?: string; items: RxItem[] }
interface Consultation {
  document: { id: string; status: string; version: number; currentVersion: number; content: Content; signedAt: string | null; signedByName: string | null; versions: VersionRow[] } | null;
  diagnoses: { id: string; text: string; code: string | null; type: string }[];
  prescription: { orders: Order[]; allergyWarnings: Warning[] } | null;
}
interface Content { chiefComplaint?: string; historyOfPresentIllness?: string; pastHistory?: string; otherTestsAdvised?: string[]; cardiologyAdvised?: string[]; proceduresAdvised?: string[]; examination?: string; advice?: string; dietAdvice?: string; referral?: string; investigationsAdvised?: string[]; followUp?: { afterDays?: number; date?: string; notes?: string } }
interface Warning { allergyId: string; allergen: string; severity: string; matchedItem: string }

export default function VisitPage() {
  const { id } = useParams<{ id: string }>();
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace", id], queryFn: () => api.get<Workspace>(`/encounters/${id}/workspace`) });
  const [note, setNote] = useState<Content>({});
  const [items, setItems] = useState<RxItem[]>([]);
  const [dx, setDx] = useState({ text: "", code: "", type: "PROVISIONAL" });
  const [amending, setAmending] = useState(false);
  const [ack, setAck] = useState<Warning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  // Signing locks the record, so it is confirmed, but the confirmation stays on screen until the doctor answers (a timed-out confirm looked like a dead button).
  const [confirmSign, setConfirmSign] = useState(false);
  // The note and the prescription are saved separately, so each re-syncs from the server independently: saving one must not wipe unsaved edits to the other.
  const [synced, setSynced] = useState<{ note: string | null; rx: string | null }>({ note: null, rx: null });

  const c = ws.data?.consultation;
  const doc = c?.document;
  const signed = !!doc && doc.status !== "DRAFT";
  const orders = c?.prescription?.orders ?? [];
  const digital = orders.filter((o) => o.source !== "HANDWRITTEN");
  const rxOrder = digital.find((o) => o.status === "DRAFT") ?? digital.find((o) => o.status === "SIGNED");
  // The same list the handwritten prescription card shows (one shared request): with a picture uploaded, the doctor can sign straight away.
  const scans = useQuery({ queryKey: ["rx-scans", id], queryFn: () => api.get<{ pharmacy: { outcome: string | null } }[]>(`/encounters/${id}/prescription-scans`), enabled: can("CONSULTATION_READ") });
  const hasHandwritten = (scans.data ?? []).some((x) => x.pharmacy.outcome !== "REJECTED");

  useEffect(() => {
    if (!ws.data) return;
    if (synced.note !== id) setNote(doc?.content ?? {});
    if (synced.rx !== id) setItems(rxOrder?.items.map((i) => ({ ...i })) ?? []);
    if (synced.note !== id || synced.rx !== id) setSynced({ note: id, rx: id });
  }, [ws.data, id, synced, doc, rxOrder]);

  const reload = () => qc.invalidateQueries({ queryKey: ["workspace", id] });
  /**
   * Puts what the doctor approved in the handwritten-picture review onto this screen: medicines and tests are added to what is already here, advice is added
   * below it, and the diagnoses are recorded like any diagnosis added by hand. Nothing is saved or signed: the doctor checks it here, then saves and signs.
   */
  const fillFromScan = async (r: FillResult) => {
    const have = new Set((c?.diagnoses ?? []).map((d) => d.text.trim().toLowerCase()));
    for (const text of r.diagnoses) if (!have.has(text.toLowerCase())) { await api.post(`/encounters/${id}/diagnoses`, { text, type: "PROVISIONAL" }); have.add(text.toLowerCase()); }
    if (r.diagnoses.length > 0) await reload();
    const merge = (a: string[] | undefined, b: string[]): string[] => [...new Set([...(a ?? []), ...b])].slice(0, 20);
    const join = (a: string | undefined, b: string): string => [a?.trim(), b].filter(Boolean).join("\n");
    const inv = merge(note.investigationsAdvised, r.investigationsAdvised), img = merge(note.otherTestsAdvised, r.otherTestsAdvised), card = merge(note.cardiologyAdvised, r.cardiologyAdvised), proc = merge(note.proceduresAdvised, r.proceduresAdvised);
    setNote({
      ...note,
      ...(inv.length ? { investigationsAdvised: inv } : {}), ...(img.length ? { otherTestsAdvised: img } : {}), ...(card.length ? { cardiologyAdvised: card } : {}), ...(proc.length ? { proceduresAdvised: proc } : {}),
      ...(r.advice ? { advice: join(note.advice, r.advice) } : {}), ...(r.dietAdvice ? { dietAdvice: join(note.dietAdvice, r.dietAdvice) } : {}),
      ...(r.referral && !note.referral?.trim() ? { referral: r.referral } : {}),
      ...(r.followUpDays && !note.followUp?.afterDays && !note.followUp?.date ? { followUp: { ...note.followUp, afterDays: r.followUpDays } } : {}),
    });
    if (r.items.length > 0) setItems([...items.filter((i) => i.genericName.trim()), ...r.items]);
  };
  // Fetch the saved copy FIRST, then refill the boxes from it. Refilling from the copy loaded before the save would blank the text just typed.
  const resync = async (part: "note" | "rx" | "all") => { await reload(); setSynced((x) => ({ note: part === "rx" ? x.note : null, rx: part === "note" ? x.rx : null })); };

  const saveNote = useMutation({ mutationFn: () => api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) }), onSuccess: () => resync("note") });
  const saveRx = useMutation({ mutationFn: () => api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) }), onSuccess: () => resync("rx") });
  const addDx = useMutation({
    mutationFn: () => api.post(`/encounters/${id}/diagnoses`, { text: dx.text, type: dx.type, ...(dx.code ? { code: dx.code } : {}) }),
    onSuccess: () => { setDx({ text: "", code: "", type: "PROVISIONAL" }); void reload(); },
  });
  const rmDx = useMutation({ mutationFn: (dxId: string) => api.post(`/diagnoses/${dxId}/remove`, { reason: "Removed by clinician" }), onSuccess: () => void reload() });
  const sign = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      const saved = await api.put<{ version: number }>(`/encounters/${id}/consultation`, { content: clean(note), ...(doc ? { version: doc.version } : {}) });
      if (items.some((i) => i.genericName.trim())) await api.put(`/encounters/${id}/prescription`, { items: items.filter((i) => i.genericName.trim()).map(toPayload) });
      return api.post(`/encounters/${id}/consultation/sign`, { version: saved.version, ...(acknowledge ? { acknowledgeAllergyWarnings: true } : {}) });
    },
    onSuccess: () => { setAck(null); setAckChecked(false); resync("all"); },
    // The note is saved before the prescription and the signature, so a failure part-way leaves the server ahead of this page: refetch (without resetting what the doctor typed) so a retry carries the current note version.
    onError: (e) => { void reload(); if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: Warning[] } | undefined)?.allergyWarnings) ?? []); },
  });

  if (ws.isLoading) return <Spinner />;
  if (ws.error || !ws.data) return <ErrorNote error={ws.error ?? new Error("Visit not found")} />;
  const h = ws.data.header;
  const canWrite = can("CONSULTATION_CREATE") && !signed && h.visitStatus === "ACTIVE";
  const rxWarnings = c?.prescription?.allergyWarnings ?? [];
  // Mirrors the server's signing rules so the doctor is told what is missing in plain words; the server still enforces them.
  const needComplaint = !note.chiefComplaint?.trim();
  const needDiagnosis = (c?.diagnoses.length ?? 0) === 0;
  const signBlocker = hasHandwritten ? null : needComplaint && needDiagnosis ? "Before you can sign: add the chief complaint and at least one diagnosis." : needComplaint ? "Before you can sign: add the chief complaint." : needDiagnosis ? "Before you can sign: add at least one diagnosis." : null;
  const hasMedicines = items.some((i) => i.genericName.trim());

  return (
    <Gate anyOf={["CONSULTATION_READ"]}>
      <PageHeader
        title={h.name} subtitle={`MRN ${h.mrn ?? "—"} · ${h.gender.toLowerCase()}${ageText(h.age) ? `, ${ageText(h.age)}` : ""}${h.bloodGroup ? ` · ${h.bloodGroup.replace("_POS", "+").replace("_NEG", "−")}` : ""} · ${h.encounterNumber} · started ${dateTime(h.startedAt)}`}
        actions={<>
          {h.consultedByVideo && <Badge tone="blue">Consulted by video</Badge>}
          <StatusBadge value={signed ? "SIGNED" : h.visitStatus} />
          {signed && can("CONSULTATION_AMEND") && <Button variant="secondary" onClick={() => setAmending(true)}>Amend…</Button>}
          {signed && <PrintLink className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`prescriptions/${id}`)}>Print prescription</PrintLink>}
          {signed && <a download className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`prescriptions/${id}`)}?format=pdf&download=1`}>PDF</a>}
        </>}
      />
      {ws.data.allergies.length > 0 && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
          <strong>Allergies:</strong> {ws.data.allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase().replace("_", " ")})`).join(", ")}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          {/* Same card as the ward: history of readings, and wrong ones marked "entered in error" rather than deleted. */}
          <VitalsCard encounterId={id} open={h.visitStatus === "ACTIVE"} />
          <VisitLabResults encounterId={id} />
          <VisitRadiology encounterId={id} />
          <AiAssist encounterId={id} />
          <Card title="Previous visits">
            {ws.data.previousVisits.length === 0 ? <p className="text-sm text-slate-500">No earlier completed visits.</p> : (
              <ul className="space-y-2 text-sm">{ws.data.previousVisits.map((v) => <li key={v.id}><div className="font-medium"><Link className="text-brand-700 hover:underline" href={`/visits/${v.id}`}>{dateTime(v.startedAt)}</Link></div><div className="text-slate-500">{v.practitionerName}{v.diagnoses?.length ? ` · ${v.diagnoses.map((d) => d.text).join(", ")}` : ""}</div><PrintLink className="text-xs text-brand-700 hover:underline" href={printUrl(`prescriptions/${v.id}`)}>Prescription</PrintLink></li>)}</ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card title="Consultation" actions={signed ? <Badge tone="green">signed by {doc?.signedByName ?? "doctor"}, {dateTime(doc?.signedAt)}</Badge> : undefined}>
            <div className="grid gap-3">
              <Field label="Chief complaints / symptoms"><Textarea disabled={!canWrite} value={note.chiefComplaint ?? ""} onChange={(e) => setNote({ ...note, chiefComplaint: e.target.value })} /></Field>
              <Field label="Medical history (present illness)"><Textarea disabled={!canWrite} value={note.historyOfPresentIllness ?? ""} onChange={(e) => setNote({ ...note, historyOfPresentIllness: e.target.value })} /></Field>
              <Field label="Past medical history (illnesses, surgeries, current medicines)"><Textarea disabled={!canWrite} value={note.pastHistory ?? ""} onChange={(e) => setNote({ ...note, pastHistory: e.target.value })} /></Field>
              <Field label="Examination"><Textarea disabled={!canWrite} value={note.examination ?? ""} onChange={(e) => setNote({ ...note, examination: e.target.value })} /></Field>
              <Field label="Doctor's advice and recommendations"><Textarea disabled={!canWrite} value={note.advice ?? ""} onChange={(e) => setNote({ ...note, advice: e.target.value })} /></Field>
              <Field label="Laboratory investigations" as="div"><InvestigationsPicker disabled={!canWrite} value={note.investigationsAdvised ?? []} onChange={(v) => setNote({ ...note, investigationsAdvised: v })} /></Field>
              <Field label="Radiology / imaging investigations" as="div"><InvestigationsPicker disabled={!canWrite} label="imaging test" example="Chest X-ray" value={note.otherTestsAdvised ?? []} onChange={(v) => setNote({ ...note, otherTestsAdvised: v })} /></Field>
              <Field label="Cardiology investigations" as="div"><InvestigationsPicker disabled={!canWrite} label="cardiology test" example="ECG" value={note.cardiologyAdvised ?? []} onChange={(v) => setNote({ ...note, cardiologyAdvised: v })} /></Field>
              <Field label="Other diagnostic procedures" as="div"><InvestigationsPicker disabled={!canWrite} label="procedure" example="Spirometry" value={note.proceduresAdvised ?? []} onChange={(v) => setNote({ ...note, proceduresAdvised: v })} /></Field>
              <Field label="Diet advice"><Textarea disabled={!canWrite} value={note.dietAdvice ?? ""} onChange={(e) => setNote({ ...note, dietAdvice: e.target.value })} /></Field>
              <Field label="Referral (optional)"><Input disabled={!canWrite} placeholder="e.g. Cardiologist if chest pain returns" value={note.referral ?? ""} onChange={(e) => setNote({ ...note, referral: e.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-[160px_180px_1fr]">
                <Field label="Follow up after (days)"><Input disabled={!canWrite} inputMode="numeric" value={note.followUp?.afterDays ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), afterDays: e.target.value ? Number(e.target.value) : undefined } })} /></Field>
                <Field label="or on this date"><Input type="date" disabled={!canWrite} value={note.followUp?.date ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), date: e.target.value || undefined } })} /></Field>
                <Field label="Follow-up instructions (optional)"><Input disabled={!canWrite} placeholder="e.g. Bring the blood test reports" value={note.followUp?.notes ?? ""} onChange={(e) => setNote({ ...note, followUp: { ...(note.followUp ?? {}), notes: e.target.value } })} /></Field>
              </div>
            </div>
            {canWrite && <div className="mt-3 flex items-center gap-2"><Button variant="secondary" loading={saveNote.isPending} onClick={() => saveNote.mutate()}>Save draft</Button><ErrorNote error={saveNote.error} /></div>}
          </Card>

          <FollowUpCard encounterId={id} practitionerId={h.practitionerId} afterDays={note.followUp?.afterDays} visitStatus={h.visitStatus} />

          <Card title="Diagnosis">
            <ul className="mb-3 space-y-1">
              {c?.diagnoses.map((d) => (
                <li key={d.id} className="flex items-center justify-between text-sm"><span><span className="font-medium">{d.text}</span> <span className="text-slate-500">{d.code ? `· ${d.code} ` : ""}· {d.type.toLowerCase()}</span></span>
                  {canWrite && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => rmDx.mutate(d.id)}>remove</button>}</li>
              ))}
              {c?.diagnoses.length === 0 && <li className="text-sm text-slate-500">No diagnosis recorded yet.</li>}
            </ul>
            {canWrite && (
              <form className="grid grid-cols-6 gap-2" onSubmit={(e) => { e.preventDefault(); if (dx.text.trim().length >= 2) addDx.mutate(); }}>
                <Input className="col-span-3" placeholder="Diagnosis" aria-label="Diagnosis" value={dx.text} onChange={(e) => setDx({ ...dx, text: e.target.value })} />
                <Input className="col-span-1" placeholder="ICD code" aria-label="Code" value={dx.code} onChange={(e) => setDx({ ...dx, code: e.target.value })} />
                <Select className="col-span-1" aria-label="Type" value={dx.type} onChange={(e) => setDx({ ...dx, type: e.target.value })}><option value="PROVISIONAL">Provisional</option><option value="FINAL">Final</option><option value="SECONDARY">Secondary</option></Select>
                <Button type="submit" variant="secondary" loading={addDx.isPending}>Add</Button>
                <div className="col-span-6"><ErrorNote error={addDx.error ?? rmDx.error} /></div>
              </form>
            )}
          </Card>

          <Card title="Prescription" actions={rxOrder?.orderNumber ? <Badge tone="gray">{rxOrder.orderNumber}</Badge> : undefined}>
            {rxWarnings.length > 0 && !signed && <div className="mb-3"><Notice tone="warn">Allergy alert: {rxWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
            {canWrite && <TemplatesBar note={note} items={items} disabled={!canWrite} onApply={(parts, tplItems) => {
              setNote({ ...note, investigationsAdvised: [...new Set([...(note.investigationsAdvised ?? []), ...(parts.investigationsAdvised ?? [])])].slice(0, 20), ...(parts.advice ? { advice: [note.advice?.trim(), parts.advice].filter(Boolean).join("\n") } : {}), ...(parts.dietAdvice ? { dietAdvice: [note.dietAdvice?.trim(), parts.dietAdvice].filter(Boolean).join("\n") } : {}), ...(parts.referral && !note.referral?.trim() ? { referral: parts.referral } : {}) });
              setItems([...items.filter((i) => i.genericName.trim()), ...tplItems]);
            }} />}
            <RxRows items={items} setItems={setItems} disabled={!canWrite} />
            {canWrite && <div className="mt-3 flex items-center gap-2"><Button variant="secondary" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button><Button variant="secondary" loading={saveRx.isPending} disabled={items.length === 0} onClick={() => saveRx.mutate()}>Save prescription</Button><ErrorNote error={saveRx.error} /></div>}
          </Card>

          {signed && <ShareCard encounterId={id} />}
          {signed && <StopMedicinesCard orders={digital} canStop={can("PRESCRIPTION_SIGN")} onChanged={() => void reload()} />}
          <HandwrittenCard encounterId={id} open={h.visitStatus !== "CANCELLED"} onFill={canWrite ? fillFromScan : undefined} />

          <Card title="Prescription preview" actions={signed ? <Badge tone="green">signed</Badge> : <Badge tone="amber">draft</Badge>}>
            <RxPreview sheet={{
              patient: { name: h.name, mrn: h.mrn, ageGender: [h.gender.toLowerCase(), ageText(h.age)].filter(Boolean).join(", "), visit: `${h.encounterNumber} · ${dateTime(h.startedAt)}` },
              allergies: ws.data.allergies.map((x) => `${x.allergen} (${x.severity.toLowerCase().replace("_", " ")})`),
              vitals: Object.entries(ws.data.latestVitals).map(([k, v]) => `${k.replace(/_/g, " ").toLowerCase()} ${v.value} ${v.unit}`),
              doctor: { name: h.practitionerName, specialty: h.practitionerSpecialty, registrationNo: h.practitionerRegistrationNo, department: h.departmentName },
              complaint: note.chiefComplaint, history: note.historyOfPresentIllness, pastHistory: note.pastHistory, examination: note.examination,
              diagnoses: c?.diagnoses.map((d) => d.text) ?? [], items, note, followUpDays: note.followUp?.afterDays, followUpDate: note.followUp?.date, followUpNotes: note.followUp?.notes,
              signed, signedBy: doc?.signedByName,
            }} />
            {signed && <div className="mt-3 flex flex-wrap gap-2"><PrintLink className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`prescriptions/${id}`)}>Open prescription</PrintLink><a download className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`prescriptions/${id}`)}?format=pdf&download=1`}>Download PDF</a></div>}
          </Card>

          {canWrite && can("CONSULTATION_SIGN") && (
            <Card title="Sign">
              {ack ? (
                <div className="space-y-3">
                  <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen} (${w.severity.toLowerCase().replace("_", " ")})`).join("; ")}</Notice>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to sign.</label>
                  <div className="flex gap-2"><Button disabled={!ackChecked} loading={sign.isPending} onClick={() => sign.mutate(true)}>Sign with acknowledged warning</Button><Button variant="ghost" onClick={() => setAck(null)}>Go back and change</Button></div>
                </div>
              ) : (
                <div className="space-y-3">
                  {signBlocker && <Notice tone="warn">{signBlocker}</Notice>}
                  {hasHandwritten && (needComplaint || needDiagnosis) && !hasMedicines && <Notice tone="info">A handwritten prescription is uploaded, so you can sign now without writing the details. The pharmacy already has the picture. Add the complaint and diagnosis first if you want them on the record.</Notice>}
                  {!signBlocker && !hasMedicines && !hasHandwritten && <Notice tone="info">No medicines have been prescribed, so nothing will be sent to the pharmacy.</Notice>}
                  {confirmSign && !signBlocker ? (
                    <div className="space-y-2">
                      <Notice tone="warn">{hasMedicines ? "Sign now? The note and prescription will be locked and the prescription will be sent to the pharmacy." : hasHandwritten ? "Sign now? The note will be locked. The pharmacy already has your handwritten prescription." : "Sign now? The note will be locked. No medicines are prescribed."}</Notice>
                      <div className="flex flex-wrap gap-2">
                        <Button loading={sign.isPending} onClick={() => { setConfirmSign(false); sign.mutate(false); }}>{hasMedicines ? "Yes, sign and send to pharmacy" : "Yes, sign"}</Button>
                        <Button variant="ghost" onClick={() => setConfirmSign(false)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button loading={sign.isPending} disabled={signBlocker !== null} onClick={() => setConfirmSign(true)}>Sign consultation</Button>
                      <span className="text-xs text-slate-500">Saves the note and prescription, then signs both. Corrections after signing are made as amendments.</span>
                    </div>
                  )}
                </div>
              )}
              {!ack && <div className="mt-2"><ErrorNote error={sign.error instanceof ApiError && sign.error.code === "ALLERGY_CONFLICT" ? null : sign.error} /></div>}
            </Card>
          )}
          {signed && <Notice tone="success">This consultation is signed. Corrections are recorded as amendments and the original stays on file.</Notice>}
          {signed && digital.some((o) => o.status === "SIGNED") && <Notice tone="success">The prescription has been sent to the pharmacy.</Notice>}
          {signed && doc && <VersionHistory encounterId={id} versions={doc.versions ?? []} />}
        </div>
      </div>
      {amending && doc && <AmendModal encounterId={id} currentVersion={doc.currentVersion} content={doc.content} diagnoses={c?.diagnoses ?? []} rxItems={(digital.find((o) => o.status === "SIGNED")?.items ?? []).filter((i) => i.status !== "STOPPED")} onClose={() => setAmending(false)} onDone={() => { setAmending(false); resync("all"); }} />}
    </Gate>
  );
}

function clean(c: Content): Content {
  const out: Content = {};
  for (const k of ["chiefComplaint", "historyOfPresentIllness", "pastHistory", "examination", "advice"] as const) { const v = c[k]?.trim(); if (v) out[k] = v; }
  for (const k of ["dietAdvice", "referral"] as const) { const v = c[k]?.trim(); if (v) out[k] = v; }
  if (c.investigationsAdvised?.length) out.investigationsAdvised = c.investigationsAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.cardiologyAdvised?.length) out.cardiologyAdvised = c.cardiologyAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.proceduresAdvised?.length) out.proceduresAdvised = c.proceduresAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  if (c.otherTestsAdvised?.length) out.otherTestsAdvised = c.otherTestsAdvised.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 20);
  const notes = c.followUp?.notes?.trim();
  if (c.followUp?.afterDays || c.followUp?.date || notes) out.followUp = { ...(c.followUp?.afterDays ? { afterDays: c.followUp.afterDays } : {}), ...(c.followUp?.date ? { date: c.followUp.date } : {}), ...(notes ? { notes } : {}) };
  return out;
}
