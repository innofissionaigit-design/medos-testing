"use client";
import { FillFromScan, type FillResult } from "@/components/scan-prescription";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, StatusBadge, Textarea, useDebounced } from "@/components/ui";
import { FOOD_OPTIONS, RxRows, toPayload, type RxItem } from "@/components/rx-editor";
import { api, ApiError, errorText } from "@/lib/api";
import { useMe } from "@/lib/me";

/** The parts of a prescription besides the medicines. */
export interface NoteParts { investigationsAdvised?: string[] | undefined; otherTestsAdvised?: string[] | undefined; cardiologyAdvised?: string[] | undefined; proceduresAdvised?: string[] | undefined; advice?: string | undefined; dietAdvice?: string | undefined; referral?: string | undefined }

const FREQ_WORDS: Record<string, string> = { OD: "once daily", BD: "twice daily", TDS: "three times daily", QID: "four times daily", HS: "at bedtime", SOS: "when needed", STAT: "immediately" };
const foodLabel = (id?: string | null) => FOOD_OPTIONS.find((f) => f.id === id && f.id)?.label.toLowerCase();

/** Tests the doctor advises: pick from the hospital's investigation list or type any test. */
export function InvestigationsPicker({ value, onChange, disabled, label = "test", example = "CBC" }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; label?: string; example?: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const term = useDebounced(text.trim(), 250);
  const res = useQuery({ queryKey: ["investigation-search", term], queryFn: () => api.page<{ id: string; name: string }>("/services", { category: "INVESTIGATION", q: term, pageSize: 6 }), enabled: open && !disabled });
  const add = (name: string) => {
    const n = name.trim().slice(0, 120);
    if (n.length < 2 || value.length >= 20 || value.some((v) => v.toLowerCase() === n.toLowerCase())) return;
    onChange([...value, n]);
    setText("");
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-sm">{v}
            {!disabled && <button type="button" aria-label={`Remove ${v}`} className="text-slate-400 hover:text-red-700" onClick={() => onChange(value.filter((x) => x !== v))}>✕</button>}
          </span>
        ))}
        {value.length === 0 && <span className="text-sm text-slate-500">None advised.</span>}
      </div>
      {!disabled && (
        <div className="relative flex max-w-md items-center gap-2">
          <Input aria-label={`Add a ${label}`} placeholder={`Type a ${label} (e.g. ${example}) and press Enter or Add`} value={text} onFocus={() => setOpen(true)} onBlur={() => { add(text); setTimeout(() => setOpen(false), 150); }}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(text); } }} />
          <Button type="button" variant="secondary" disabled={text.trim().length < 2} onMouseDown={(e) => e.preventDefault()} onClick={() => add(text)}>Add</Button>
          {open && (res.data?.data.length ?? 0) > 0 && (
            <ul className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">
              {res.data!.data.map((s) => <li key={s.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onMouseDown={() => add(s.name)}>{s.name}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface Template { id: string; name: string; shared: boolean; mine: boolean; owner: string; content: { items: RxItem[]; investigationsAdvised: string[]; otherTestsAdvised?: string[]; cardiologyAdvised?: string[]; proceduresAdvised?: string[]; advice?: string; dietAdvice?: string; referral?: string } }

/** A doctor's saved prescriptions: apply one to fill the writer (the doctor still reviews and signs), or save what is on screen for next time. */
export function TemplatesBar({ note, items, onApply, disabled }: { note: NoteParts; items: RxItem[]; onApply: (parts: NoteParts, items: RxItem[]) => void; disabled: boolean }) {
  const qc = useQueryClient();
  const { can } = useMe();
  const list = useQuery({ queryKey: ["rx-templates"], queryFn: () => api.get<Template[]>("/prescription-templates"), enabled: can("PRESCRIPTION_CREATE") });
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const meds = items.filter((i) => i.genericName.trim());
  const content = {
    items: meds.map(toPayload), investigationsAdvised: note.investigationsAdvised ?? [], otherTestsAdvised: note.otherTestsAdvised ?? [], cardiologyAdvised: note.cardiologyAdvised ?? [], proceduresAdvised: note.proceduresAdvised ?? [],
    ...(note.advice?.trim() ? { advice: note.advice.trim() } : {}), ...(note.dietAdvice?.trim() ? { dietAdvice: note.dietAdvice.trim() } : {}), ...(note.referral?.trim() ? { referral: note.referral.trim() } : {}),
  };
  const something = content.items.length > 0 || content.investigationsAdvised.length > 0 || content.otherTestsAdvised.length > 0 || content.cardiologyAdvised.length > 0 || content.proceduresAdvised.length > 0 || !!content.advice || !!content.dietAdvice || !!content.referral;
  const save = useMutation({
    mutationFn: () => api.post("/prescription-templates", { name: name.trim(), shared, content }),
    onSuccess: () => { setName(""); setShared(false); setSaving(false); void qc.invalidateQueries({ queryKey: ["rx-templates"] }); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/prescription-templates/${id}/remove`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["rx-templates"] }) });
  const [picked, setPicked] = useState("");
  const chosen = list.data?.find((t) => t.id === picked);
  if (!can("PRESCRIPTION_CREATE")) return null;
  return (
    <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-700">Templates</span>
        <Select aria-label="Template" className="w-64" value={picked} onChange={(e) => setPicked(e.target.value)}>
          <option value="">{list.data?.length ? "Choose a saved prescription…" : "No templates saved yet"}</option>
          {list.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.shared && !t.mine ? ` · ${t.owner}` : t.shared ? " · shared" : ""}</option>)}
        </Select>
        <Button type="button" variant="secondary" title={!chosen ? "Choose a saved template first" : undefined} disabled={disabled || !chosen} onClick={() => chosen && onApply({ investigationsAdvised: chosen.content.investigationsAdvised, otherTestsAdvised: chosen.content.otherTestsAdvised ?? [], cardiologyAdvised: chosen.content.cardiologyAdvised ?? [], proceduresAdvised: chosen.content.proceduresAdvised ?? [], advice: chosen.content.advice, dietAdvice: chosen.content.dietAdvice, referral: chosen.content.referral }, chosen.content.items.map(({ id: _id, ...i }) => ({ ...i })))}>Use template</Button>
        {chosen?.mine && <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => { remove.mutate(chosen.id); setPicked(""); }}>remove</button>}
        {!disabled && <Button type="button" variant="ghost" title={!something ? "Add a medicine, a test or advice first" : undefined} disabled={!something} onClick={() => setSaving(!saving)}>Save this as a template</Button>}
      </div>
      {saving && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) save.mutate(); }}>
          <Input aria-label="Template name" className="w-64" placeholder="Name (e.g. Viral fever)" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Let other doctors use it</label>
          <Button type="submit" loading={save.isPending} disabled={name.trim().length < 2}>Save template</Button>
        </form>
      )}
      <ErrorNote error={save.error ?? remove.error} />
      <p className="mt-1 text-xs text-slate-500">A template holds medicines, tests and advice only, never patient details. Using one fills the screen; you check it and sign as usual.{!disabled && !something && " To save one: add a medicine, a test or advice below, then click Save this as a template. To use one: choose it in the list."}</p>
    </div>
  );
}

export interface PreviewSheet {
  patient: { name: string; mrn: string | null; ageGender: string; visit: string };
  allergies: string[]; vitals: string[];
  doctor: { name: string | null; specialty: string | null; registrationNo: string | null; department: string | null };
  complaint?: string | undefined; history?: string | undefined; pastHistory?: string | undefined; examination?: string | undefined;
  diagnoses: string[]; items: RxItem[]; note: NoteParts; followUpDays?: number | undefined; followUpDate?: string | undefined; followUpNotes?: string | undefined;
  signed: boolean; signedBy?: string | null | undefined;
}

/** The whole prescription as the patient will receive it, built live from the screen: patient, history, allergies, vitals, diagnosis, medicines, tests, advice,
 *  follow-up, and the doctor's details with the digital signature that is applied when the doctor signs. */
export function RxPreview({ sheet: x }: { sheet: PreviewSheet }) {
  const meds = x.items.filter((i) => i.genericName.trim());
  const block = (title: string, body: string | undefined) => (body?.trim() ? <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div><p className="whitespace-pre-line">{body}</p></div> : null);
  const list = (title: string, v: string[] | undefined) => (v && v.length > 0 ? block(title, v.join(", ")) : null);
  const follow = x.followUpDate ? `On or after ${x.followUpDate}` : x.followUpDays ? `After ${x.followUpDays} day${x.followUpDays === 1 ? "" : "s"}` : "";
  return (
    <div className="space-y-3 rounded-md border border-slate-300 bg-white p-4 text-sm" aria-label="Prescription preview">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 pb-2">
        <div><div className="text-base font-semibold">{x.patient.name}</div><div className="text-slate-600">MRN {x.patient.mrn ?? "—"} · {x.patient.ageGender}</div></div>
        <div className="text-right text-slate-600"><div>{x.patient.visit}</div><div>{x.doctor.name ?? ""}{x.doctor.specialty ? `, ${x.doctor.specialty}` : ""}</div></div>
      </div>
      {x.allergies.length > 0 && <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-900"><b>Allergies:</b> {x.allergies.join(", ")}</div>}
      {x.vitals.length > 0 && block("Vitals", x.vitals.join(" · "))}
      {block("Complaint", x.complaint)}{block("History", x.history)}{block("Past history", x.pastHistory)}{block("Examination", x.examination)}
      {x.diagnoses.length > 0 && block("Diagnosis", x.diagnoses.join(", "))}
      {meds.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Medicines</div>
          <ol className="list-decimal pl-5">
            {meds.map((m, i) => (
              <li key={i}><b>{[m.brandName ?? m.genericName, m.strength].filter(Boolean).join(" ")}</b> — {m.dosage}, {m.frequency === "OTHER" ? m.frequencyText ?? "as directed" : FREQ_WORDS[m.frequency] ?? m.frequency}
                {foodLabel(m.foodRelation) ? `, ${foodLabel(m.foodRelation)}` : ""}{m.durationDays ? `, for ${m.durationDays} day${m.durationDays === 1 ? "" : "s"}` : ""}{m.instructions ? `. ${m.instructions}` : ""}</li>
            ))}
          </ol>
        </div>
      )}
      {list("Laboratory investigations", x.note.investigationsAdvised)}{list("Radiology / imaging", x.note.otherTestsAdvised)}{list("Cardiology investigations", x.note.cardiologyAdvised)}{list("Other diagnostic procedures", x.note.proceduresAdvised)}
      {block("Advice", x.note.advice)}{block("Diet", x.note.dietAdvice)}{block("Referral", x.note.referral)}
      {(follow || x.followUpNotes?.trim()) && block("Follow-up", [follow, x.followUpNotes?.trim()].filter(Boolean).join(". "))}
      <div className="border-t border-slate-200 pt-2 text-right">
        <div className="font-medium">{x.doctor.name ?? "Doctor"}</div>
        <div className="text-slate-600">{[x.doctor.specialty, x.doctor.department].filter(Boolean).join(" · ")}{x.doctor.registrationNo ? ` · Reg. no. ${x.doctor.registrationNo}` : ""}</div>
        <div className={x.signed ? "text-green-800" : "text-amber-800"}>{x.signed ? `Digitally signed by ${x.signedBy ?? x.doctor.name ?? "the doctor"}` : "Digital signature is applied when you sign"}</div>
      </div>
    </div>
  );
}

interface ScanPage { pageNo: number; file: { id: string; contentType: string; fileName: string; removed: boolean }; status: string; error: string | null }
interface Scan {
  id: string; status: "UPLOADED" | "OCR_DONE" | "OCR_FAILED" | "OCR_NOT_CONFIGURED"; uploadedAt: string; uploadedBy: string | null;
  file: { id: string; contentType: string; fileName: string; removed: boolean };
  ocr: { text: string | null; confidence: number | null; error: string | null; attempts: number };
  needsReading: boolean; correctedStale: boolean; pages: ScanPage[];
  correctedText: string | null; text: string | null;
  pharmacy: { outcome: "DISPENSED" | "REJECTED" | null; at: string | null; by: string | null; note: string | null };
}
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/png", "image/jpeg", "application/pdf"];

function ScanRow({ scan, encounterId, canAct, ocrReady, onFill }: { scan: Scan; encounterId: string; canAct: boolean; ocrReady: boolean; onFill?: ((r: FillResult) => void | Promise<void>) | undefined }) {
  const [filling, setFilling] = useState(false);
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const [text, setText] = useState<string | null>(null);
  const handled = scan.pharmacy.outcome !== null;
  const shown = text ?? scan.text ?? "";
  const refresh = () => qc.invalidateQueries({ queryKey: ["rx-scans", encounterId] });
  const extract = useMutation({ mutationFn: () => api.post(`/prescription-scans/${scan.id}/extract`), onSuccess: refresh });
  const correct = useMutation({ mutationFn: () => api.put(`/prescription-scans/${scan.id}/correction`, { text: shown.trim() }), onSuccess: async () => { setText(null); await refresh(); } });
  const canRead = ocrReady && scan.needsReading && !handled;
  // A picture shown while it has never been read (for example uploaded before the OCR service was connected) is read once, automatically; a failure shows
  // its message and the Read button tries again.
  const autoRead = useRef(false);
  useEffect(() => {
    if (canAct && canRead && scan.ocr.attempts === 0 && !autoRead.current) { autoRead.current = true; extract.mutate(); }
  }, [canAct, canRead, scan.ocr.attempts]);
  const [pageError, setPageError] = useState<string | null>(null);
  const addPage = useMutation({
    mutationFn: async (file: File) => {
      const q = new URLSearchParams({ filename: file.name, scanId: scan.id });
      const res = await fetch(`/api/proxy/encounters/${encounterId}/prescription-scans?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": file.type, "x-medos-csrf": "1" }, body: file });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new Error(j.error?.message ?? "Upload failed"); }
    },
    onSuccess: async () => { setPageError(null); await refresh(); },
    onError: (e) => setPageError(errorText(e)),
  });
  const pickPage = (file: File | undefined) => {
    setPageError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) return setPageError("Choose a PNG or JPEG image, or a PDF.");
    if (file.size > MAX_BYTES) return setPageError("The file is larger than 5 MB.");
    addPage.mutate(file);
  };
  const isImage = scan.file.contentType.startsWith("image/");
  const url = `/api/proxy/files/${scan.file.id}/content`;
  return (
    <li className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-start gap-3">
        {isImage && !scan.file.removed && <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Handwritten prescription" className="h-28 w-28 rounded border border-slate-200 object-cover" /></a>}
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <a className="font-medium text-brand-700 hover:underline" href={url} target="_blank" rel="noreferrer">{scan.file.fileName}</a>
            <StatusBadge value={scan.pharmacy.outcome ?? "AT_PHARMACY"} />
            <span className="text-xs text-slate-500">{scan.uploadedBy ?? ""} · {dateTime(scan.uploadedAt)}</span>
          </div>
          {scan.pharmacy.outcome === null && <p className="text-xs text-slate-600">The pharmacy can see {scan.pages.length > 1 ? `all ${scan.pages.length} pages` : "this page"} now. The pharmacist checks the prescription, enters the medicines and dispenses them; the bill goes to the cashier.</p>}
          {scan.pharmacy.outcome === "DISPENSED" && <p className="text-xs text-green-800">Dispensed by {scan.pharmacy.by ?? "the pharmacist"}, {dateTime(scan.pharmacy.at)}.</p>}
          {scan.status === "OCR_DONE" && !handled && <p className="text-xs text-amber-800">Read automatically{scan.ocr.confidence !== null ? ` (${Math.round(scan.ocr.confidence * 100)}% sure)` : ""}. It can be wrong: the pharmacist works from the picture.</p>}
          {scan.ocr.error && scan.status !== "OCR_DONE" && <p className="text-xs text-slate-600">{scan.ocr.error}</p>}
        </div>
        {canAct && canRead && <Button type="button" variant="secondary" loading={extract.isPending} onClick={() => extract.mutate()}>Read {scan.pages.length > 1 ? "the unread pages" : "it"}</Button>}
        {canAct && onFill && <Button type="button" variant="secondary" onClick={() => setFilling(true)}>Fill the prescription from this picture</Button>}
      </div>
      {scan.pharmacy.outcome === "REJECTED" && <div className="mt-2"><Notice tone="warn">The pharmacy could not use this picture{scan.pharmacy.by ? ` (${scan.pharmacy.by})` : ""}: {scan.pharmacy.note}. Upload a clearer picture as a new prescription.</Notice></div>}
      {scan.pages.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {scan.pages.map((pg) => (
            <li key={pg.pageNo} className="rounded border border-slate-200 px-2 py-1"><a className="text-brand-700 hover:underline" href={`/api/proxy/files/${pg.file.id}/content`} target="_blank" rel="noreferrer">Page {pg.pageNo}</a> · {pg.status === "OCR_DONE" ? "read" : pg.status.replace(/_/g, " ").toLowerCase()}{pg.error && pg.status !== "OCR_DONE" ? ` — ${pg.error}` : ""}</li>
          ))}
        </ul>
      )}
      {canAct && !handled && scan.pages.length < 10 && (
        <div className="mt-2 text-xs text-slate-600">
          <label>Add another page <input type="file" aria-label="Add another page of this prescription" accept={ACCEPT.join(",")} disabled={addPage.isPending} onChange={(e) => { pickPage(e.target.files?.[0]); e.target.value = ""; }} className="ml-1 text-xs file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-0.5" /></label>
          {addPage.isPending && <span className="ml-2">Uploading…</span>}
          {pageError && <div className="mt-1"><Notice tone="error">{pageError}</Notice></div>}
        </div>
      )}
      {scan.correctedStale && !handled && <div className="mt-2"><Notice tone="warn">A page was added after you saved the text, so that page's text is not part of it. Open the new page and add what is missing to the text.</Notice></div>}
      {canAct && !handled ? (
        <div className="mt-3 space-y-1">
          <Field label="Note on what it says (optional, shown to the pharmacist as a help)" as="div"><Textarea aria-label="What the prescription says" placeholder="Anything that helps the pharmacist read the handwriting" value={shown} onChange={(e) => setText(e.target.value)} /></Field>
          <Button type="button" variant="secondary" loading={correct.isPending} disabled={text === null || shown.trim().length === 0} onClick={() => correct.mutate()}>Save note</Button>
        </div>
      ) : scan.text ? <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-sm">{scan.text}</pre> : null}
      <ErrorNote error={extract.error ?? correct.error} />
      {filling && onFill && <FillFromScan scanId={scan.id} onClose={() => setFilling(false)} onApply={onFill} />}
    </li>
  );
}

/** Photo or PDF of a handwritten prescription: uploaded at any point of the visit (also after the consultation is signed), read by OCR when that is on, turned
 *  by the doctor into structured medicine details, and approved by a doctor before the pharmacy sees it. Shown only when the hospital has switched it on. */
export function HandwrittenCard({ encounterId, open, onFill }: { encounterId: string; open: boolean; onFill?: ((r: FillResult) => void | Promise<void>) | undefined }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const cfg = useQuery({ queryKey: ["rx-scan-config"], queryFn: () => api.get<{ uploadEnabled: boolean; ocrEnabled: boolean; ocrConnected: boolean }>("/prescription-scans/config"), enabled: can("CONSULTATION_READ") });
  const list = useQuery({ queryKey: ["rx-scans", encounterId], queryFn: () => api.get<Scan[]>(`/encounters/${encounterId}/prescription-scans`), enabled: !!cfg.data?.uploadEnabled });
  const canAct = can("PRESCRIPTION_SCAN");
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const q = new URLSearchParams({ filename: file.name });
      const res = await fetch(`/api/proxy/encounters/${encounterId}/prescription-scans?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": file.type, "x-medos-csrf": "1" }, body: file });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new Error(j.error?.message ?? "Upload failed"); }
    },
    onSuccess: async () => { if (input.current) input.current.value = ""; await qc.invalidateQueries({ queryKey: ["rx-scans", encounterId] }); },
    onError: (e) => setError(errorText(e)),
  });
  if (!cfg.data?.uploadEnabled) return null;
  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) return setError("Choose a PNG or JPEG image, or a PDF.");
    if (file.size > MAX_BYTES) return setError("The file is larger than 5 MB.");
    upload.mutate(file);
  };
  const ocrReady = cfg.data.ocrEnabled && cfg.data.ocrConnected;
  return (
    <Card title="Handwritten prescription" actions={cfg.data.ocrEnabled ? <Badge tone={cfg.data.ocrConnected ? "green" : "gray"}>{cfg.data.ocrConnected ? "automatic reading on" : "reading service not connected"}</Badge> : undefined}>
      {canAct && open && (
        <div className="mb-3">
          <input ref={input} type="file" aria-label="Choose a photo or PDF of the handwritten prescription" accept={ACCEPT.join(",")} disabled={upload.isPending} onChange={(e) => pick(e.target.files?.[0])} className="text-sm file:mr-2 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2 file:py-1" />
          {upload.isPending && <p className="mt-1 text-sm text-slate-500">Uploading and reading…</p>}
          {error && <div className="mt-1"><Notice tone="error">{error}</Notice></div>}
          <p className="mt-1 text-xs text-slate-500">You can upload this at any time, also after the consultation is signed. The pharmacy sees the pictures, all pages, as soon as you upload them; the pharmacist checks the prescription and enters the medicines themselves.</p>
        </div>
      )}
      {list.isLoading ? null : (list.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No handwritten prescription uploaded for this visit.</p> : (
        <ul className="space-y-3">{list.data!.map((s) => <ScanRow key={s.id} scan={s} encounterId={encounterId} canAct={canAct} ocrReady={ocrReady} onFill={onFill} />)}</ul>
      )}
    </Card>
  );
}

interface ShareRow { id: string; status: "ACTIVE" | "EXPIRED" | "REVOKED"; createdAt: string; expiresAt: string; recipientMask: string | null; createdBy: string | null; openCount: number; lastOpenedAt: string | null }
interface SendConfig { provider: string; connected: boolean; autoSend: boolean; channel: "WHATSAPP" | "SMS"; linkDays: number }
interface SendRow { id: string; channel: string; to: string; trigger: "AUTO" | "MANUAL"; status: "PENDING" | "SENT" | "FAILED"; attempts: number; createdAt: string; sentAt: string | null; sentForReal: boolean; error: string | null; by: string | null }
interface ShareCreated { id: string; expiresAt: string; recipientMask: string | null; path: string; whatsappNumber: string | null }

/**
 * Changes one medicine of a signed prescription (dose, how often, how long, a different brand or medicine). The old medicine stays on the record as stopped; the new
 * one is signed as a one-medicine prescription with its own number. The signed note is not touched.
 */
export function AmendMedicine({ item, onClose, onDone }: { item: RxItem & { id: string }; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<RxItem[]>([{ ...item, qtyAuto: false }]);
  const [reason, setReason] = useState("");
  const [warnings, setWarnings] = useState<{ allergen: string; matchedItem: string }[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post(`/medication-order-items/${item.id}/amend`, { reason: reason.trim(), item: toPayload(rows[0]!), ...(confirmed ? { acknowledgeAllergyWarnings: true } : {}) }),
    onSuccess: onDone,
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setWarnings(((e.details as { allergyWarnings?: { allergen: string; matchedItem: string }[] } | undefined)?.allergyWarnings) ?? []); },
  });
  return (
    <Modal title={`Change ${item.genericName}`} onClose={onClose} wide>
      <div className="space-y-3">
        <Notice tone="info">The signed prescription stays as it was signed. {item.genericName} is marked stopped (with your reason) and the new medicine is signed now as its own prescription.{(item.dispensedQuantity ?? 0) > 0 ? ` The pharmacy has already given ${item.dispensedQuantity} of the old one.` : ""}</Notice>
        <RxRows items={rows} setItems={setRows} disabled={false} />
        <Field label="Why is it being changed?" hint="At least 3 characters; kept with the record"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {warnings && warnings.length > 0 && (
          <div className="space-y-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
            <p className="font-medium text-red-900">Allergy alert: {warnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I have reviewed this and still want to prescribe it</label>
          </div>
        )}
        <ErrorNote error={warnings ? null : save.error} />
        <div className="flex gap-2">
          <Button loading={save.isPending} disabled={reason.trim().length < 3 || !rows[0]?.genericName.trim() || (!!warnings && warnings.length > 0 && !confirmed)} onClick={() => save.mutate()}>Sign the change</Button>
          <Button variant="secondary" onClick={onClose}>Keep it as it is</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Stops a medicine of a signed prescription (for example after a reaction, or one the pharmacy has already given, which an amendment cannot replace). The signed
 * note stays as signed; the stop is kept as a separate record with the doctor's name, time and reason, and the pharmacy and nurses stop giving it.
 */
export function StopMedicinesCard({ orders, canStop, onChanged }: { orders: { id: string; status: string; items: RxItem[] }[]; canStop: boolean; onChanged: () => void }) {
  const [stopping, setStopping] = useState<{ id: string; name: string; given: number } | null>(null);
  const [reason, setReason] = useState("");
  const [changing, setChanging] = useState<(RxItem & { id: string }) | null>(null);
  const stop = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/medication-order-items/${v.id}/stop`, { reason: v.reason }), onSuccess: () => { setStopping(null); setReason(""); onChanged(); } });
  const signed = orders.filter((o) => o.status === "SIGNED");
  if (signed.length === 0) return null;
  return (
    <Card title="Signed medicines">
      {signed.map((o) => (
        <ul key={o.id} className="divide-y divide-slate-100 text-sm">
          {o.items.flatMap((i) => (i.id ? [{ ...i, id: i.id }] : [])).map((i) => {
            const name = [i.genericName, i.strength].filter(Boolean).join(" ");
            return (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div><span className={i.status === "STOPPED" ? "font-medium text-slate-500 line-through" : "font-medium"}>{name}</span> <span className="text-slate-600">{i.dosage}, {i.frequency === "OTHER" ? i.frequencyText ?? "as directed" : i.frequency}</span>
                  {(i.dispensedQuantity ?? 0) > 0 && <span className="ml-2 text-xs text-slate-500">{i.dispensedQuantity} given by pharmacy</span>}
                  {i.status === "STOPPED" && <div className="text-xs text-red-700">Stopped{i.stopReason ? `: ${i.stopReason}` : ""}</div>}
                </div>
                {i.status === "ACTIVE" && canStop && <div className="flex gap-2"><Button variant="secondary" onClick={() => setChanging(i)}>Change</Button><Button variant="secondary" onClick={() => { stop.reset(); setReason(""); setStopping({ id: i.id, name, given: i.dispensedQuantity ?? 0 }); }}>Stop</Button></div>}
                {i.status === "STOPPED" && i.stopReason?.startsWith("Amended:") && <span className="text-xs text-slate-500">replaced</span>}
              </li>
            );
          })}
        </ul>
      ))}
      {changing && <AmendMedicine item={changing} onClose={() => setChanging(null)} onDone={() => { setChanging(null); onChanged(); }} />}
      {stopping && (
        <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <Notice tone="warn">Stop {stopping.name}? The signed prescription stays as it was signed; this is recorded as stopped with your name and reason, and the pharmacy will not give any more.{stopping.given > 0 ? ` ${stopping.given} already given cannot be taken back.` : ""}</Notice>
          <Field label="Reason for stopping" hint="At least 3 characters"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button variant="danger" loading={stop.isPending} disabled={reason.trim().length < 3} onClick={() => stop.mutate({ id: stopping.id, reason: reason.trim() })}>Stop medicine</Button>
            <Button variant="secondary" onClick={() => { setStopping(null); setReason(""); }}>Keep it</Button>
          </div>
          <ErrorNote error={stop.error} />
        </div>
      )}
    </Card>
  );
}

/** Give the patient their signed prescription: a link that opens the prescription (and its PDF) without signing in. Nothing is sent by the system; staff copy the
 *  link or open WhatsApp with the message ready. The link is shown once, expires, and can be revoked. */
export function ShareCard({ encounterId }: { encounterId: string }) {
  const qc = useQueryClient();
  const { can, dateTime } = useMe();
  const [days, setDays] = useState("7");
  const [created, setCreated] = useState<ShareCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const list = useQuery({ queryKey: ["rx-shares", encounterId], queryFn: () => api.get<ShareRow[]>(`/encounters/${encounterId}/prescription-shares`), enabled: can("PRESCRIPTION_SHARE") });
  const create = useMutation({ mutationFn: () => api.post<ShareCreated>(`/encounters/${encounterId}/prescription-shares`, { days: Number(days) }), onSuccess: async (r) => { setCreated(r); setCopied(false); await qc.invalidateQueries({ queryKey: ["rx-shares", encounterId] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/prescription-shares/${id}/revoke`), onSuccess: async () => { setCreated(null); await qc.invalidateQueries({ queryKey: ["rx-shares", encounterId] }); } });
  const cfg = useQuery({ queryKey: ["rx-send-config"], queryFn: () => api.get<SendConfig>("/prescription-deliveries/config"), enabled: can("PRESCRIPTION_SHARE") });
  const sends = useQuery({ queryKey: ["rx-sends", encounterId], queryFn: () => api.get<SendRow[]>(`/encounters/${encounterId}/prescription-deliveries`), enabled: can("PRESCRIPTION_SHARE"), refetchInterval: (q) => (q.state.data?.some((r) => r.status === "PENDING") ? 5000 : false) });
  const send = useMutation({ mutationFn: () => api.post<SendRow>(`/encounters/${encounterId}/prescription-deliveries`), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["rx-sends", encounterId] }); await qc.invalidateQueries({ queryKey: ["rx-shares", encounterId] }); } });
  const retrySend = useMutation({ mutationFn: (id: string) => api.post<SendRow>(`/prescription-deliveries/${id}/retry`), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["rx-sends", encounterId] }); await qc.invalidateQueries({ queryKey: ["rx-shares", encounterId] }); } });
  if (!can("PRESCRIPTION_SHARE")) return null;
  const link = created ? `${window.location.origin}${created.path}` : "";
  const message = `Your prescription is ready. Open it here (valid until ${created ? new Date(created.expiresAt).toLocaleDateString("en-IN") : ""}): ${link}`;
  return (
    <Card title="Share with the patient">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Link valid for" className="w-40" value={days} onChange={(e) => setDays(e.target.value)}>{[["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["30", "30 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Button type="button" loading={create.isPending} onClick={() => create.mutate()}>Create patient link</Button>
      </div>
      {created && (
        <div className="mt-3 space-y-2">
          <Notice tone="success">This link is shown only now. Anyone who has it can open the prescription until {dateTime(created.expiresAt)}{created.recipientMask ? ` (patient's mobile ${created.recipientMask})` : ""}.</Notice>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Patient link" readOnly className="min-w-0 flex-1" value={link} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</Button>
            <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={link} target="_blank" rel="noreferrer">Open</a>
            {created.whatsappNumber && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`https://wa.me/${created.whatsappNumber}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
          </div>
          <p className="text-xs text-slate-500">Nothing has been sent. Copy the link, or use WhatsApp to open a chat with the message ready and press send yourself.</p>
        </div>
      )}
      {(list.data?.length ?? 0) > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {list.data!.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span><StatusBadge value={r.status} /> <span className="text-slate-600">{r.createdBy ?? ""} · {dateTime(r.createdAt)} · expires {dateTime(r.expiresAt)} · opened {r.openCount} time{r.openCount === 1 ? "" : "s"}{r.lastOpenedAt ? `, last ${dateTime(r.lastOpenedAt)}` : ""}</span></span>
              {r.status === "ACTIVE" && <button type="button" className="text-xs text-slate-500 hover:text-red-700" onClick={() => { if (window.confirm("Revoke this link? The patient will no longer be able to open it.")) revoke.mutate(r.id); }}>revoke</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" loading={send.isPending} onClick={() => send.mutate()}>Send to the patient's phone ({cfg.data?.channel === "SMS" ? "SMS" : "WhatsApp"})</Button>
          <span className="text-xs text-slate-500">{cfg.data?.autoSend ? "Also sent automatically when the prescription is signed." : "Not sent automatically. The hospital can turn that on in Settings."}</span>
        </div>
        {cfg.data && !cfg.data.connected && <div className="mt-2"><Notice tone="warn">No message provider is connected to this server yet, so messages are only recorded here and nothing reaches the patient. Ask your administrator to connect the hospital's approved WhatsApp or SMS service.</Notice></div>}
        {(sends.data?.length ?? 0) > 0 && (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {sends.data!.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span><StatusBadge value={r.status === "SENT" && !r.sentForReal ? "RECORDED_ONLY" : r.status} /> <span className="text-slate-600">{r.channel === "SMS" ? "SMS" : "WhatsApp"} to {r.to} · {r.trigger === "AUTO" ? "automatic" : r.by ?? ""} · {dateTime(r.sentAt ?? r.createdAt)}{r.status === "PENDING" && r.error ? ` · will try again: ${r.error}` : ""}{r.status === "FAILED" && r.error ? ` · ${r.error}` : ""}</span></span>
                {r.status === "FAILED" && <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => retrySend.mutate(r.id)}>try again</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ErrorNote error={create.error ?? revoke.error ?? send.error ?? retrySend.error} />
    </Card>
  );
}
