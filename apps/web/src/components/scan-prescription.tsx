"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Textarea } from "@/components/ui";
import type { RxItem } from "@/components/rx-editor";
import { api } from "@/lib/api";
import { calculateQuantity } from "@/lib/rx-quantity";

interface Matched { id: string; brandName: string; genericName: string; strength: string | null; dosageForm: string }
interface DraftMedicine { raw: string; name: string; strength?: string; form?: string; dosage?: string; route?: "ORAL" | "IM" | "TOPICAL" | "OTHER"; frequency?: string; foodRelation?: string; durationDays?: number; quantity?: number; instructions?: string; matched: Matched | null }
interface DraftTest { text: string; category: Kind; matched: { id: string; name: string; code: string } | null }
type Kind = "LABORATORY" | "RADIOLOGY" | "CARDIOLOGY" | "PROCEDURE";
type Check = "MATCH" | "PARTIAL" | "DIFFERENT" | "NOT_ON_PAPER";
interface Draft {
  hasText: boolean; ocrError: string | null; warnings: string[];
  patientCheck: { nameOnPaper: string | null; name: Check; ageOnPaper: number | null; age: Check; genderOnPaper: string | null; gender: Check };
  diagnoses: string[]; medicines: DraftMedicine[]; tests: DraftTest[]; advice: string[]; diet: string[]; referral: string | null; followUpDays: number | null;
}
interface Options { drugs: string[]; medicines: Matched[]; labTests: { id: string; name: string; code: string }[]; advice: string[]; truncated: { medicines: boolean; labTests: boolean } }

/** What the doctor approved in the review, ready to be put on the digital prescription screen. Nothing is saved by this. */
export interface FillResult {
  diagnoses: string[]; items: RxItem[];
  investigationsAdvised: string[]; otherTestsAdvised: string[]; cardiologyAdvised: string[]; proceduresAdvised: string[];
  advice: string; dietAdvice: string; referral: string; followUpDays: number | null;
}

const FREQS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT"];
const KIND_NAME: Record<Kind, string> = { LABORATORY: "Lab", RADIOLOGY: "Imaging", CARDIOLOGY: "Cardiology", PROCEDURE: "Procedure" };
const CHECK_TEXT: Record<Check, string> = { MATCH: "matches this patient", PARTIAL: "only partly matches this patient", DIFFERENT: "is different from this patient", NOT_ON_PAPER: "not written on the paper" };

interface MedRow { on: boolean; read: string; drug: string; medicineId: string; dosage: string; frequency: string; days: string; qty: string; qtyAuto: boolean; instructions: string; foodRelation: string; route: string }
interface TestRow { on: boolean; text: string; category: Kind }
interface DxRow { on: boolean; text: string }

const blankMed = (): MedRow => ({ on: true, read: "", drug: "", medicineId: "", dosage: "1 tablet", frequency: "BD", days: "3", qty: String(calculateQuantity("1 tablet", "BD", 3) ?? ""), qtyAuto: true, instructions: "", foodRelation: "", route: "ORAL" });
const posInt = (v: string, max: number): boolean => /^\d{1,5}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= max;

function toRows(d: Draft | null) {
  const meds: MedRow[] = (d?.medicines ?? []).map((m) => {
    const days = m.durationDays ? String(m.durationDays) : "";
    const dosage = m.dosage ?? "1 tablet";
    const frequency = m.frequency ?? "BD";
    const written = m.quantity ? String(m.quantity) : "";
    const calc = calculateQuantity(dosage, frequency, m.durationDays);
    return { on: true, read: m.raw, drug: m.matched?.genericName ?? m.name, medicineId: m.matched?.id ?? "", dosage, frequency, days, qty: written || (calc ? String(calc) : ""), qtyAuto: !written && calc !== null, instructions: m.instructions ?? "", foodRelation: m.foodRelation ?? "", route: m.route ?? "ORAL" };
  });
  return {
    dx: (d?.diagnoses ?? []).map((text): DxRow => ({ on: true, text })),
    meds,
    tests: (d?.tests ?? []).map((t): TestRow => ({ on: true, text: t.matched?.name ?? t.text, category: t.category })),
    advice: (d?.advice ?? []).join("\n"), diet: (d?.diet ?? []).join("\n"), referral: d?.referral ?? "", followUp: d?.followUpDays ? String(d.followUpDays) : "",
  };
}

/**
 * The doctor's review of a handwritten picture, before anything goes on the prescription (docs/prescriptions.md): what OCR read, next to the Drug, Medicine and
 * Lab test dropdowns, with the patient on the paper checked against the patient of the visit. "Apply" only fills the digital prescription screen; the doctor
 * reads it there, saves and signs as usual, and that signature is the approval.
 */
export function FillFromScan({ scanId, onClose, onApply }: { scanId: string; onClose: () => void; onApply: (r: FillResult) => void | Promise<void> }) {
  const options = useQuery({ queryKey: ["rx-options"], queryFn: () => api.get<Options>("/prescription-scans/options"), staleTime: 5 * 60_000 });
  const draft = useQuery({ queryKey: ["scan-draft", scanId], queryFn: () => api.get<Draft>(`/prescription-scans/${scanId}/prescription-draft`), staleTime: 0, gcTime: 0 });
  if (draft.isLoading) return <Modal title="Fill the prescription from the picture" onClose={onClose} wide><div className="flex items-center gap-2 text-sm text-slate-600"><Spinner /> Reading what was found in the picture…</div></Modal>;
  return <Form key={scanId} draft={draft.data ?? null} loadError={draft.error} options={options.data} optionsError={options.error} retryOptions={() => void options.refetch()} onClose={onClose} onApply={onApply} />;
}

function Form({ draft, loadError, options, optionsError, retryOptions, onClose, onApply }: { draft: Draft | null; loadError: unknown; options: Options | undefined; optionsError: unknown; retryOptions: () => void; onClose: () => void; onApply: (r: FillResult) => void | Promise<void> }) {
  const init = toRows(draft);
  const [dx, setDx] = useState<DxRow[]>(init.dx);
  const [meds, setMeds] = useState<MedRow[]>(init.meds);
  const [tests, setTests] = useState<TestRow[]>(init.tests);
  const [advice, setAdvice] = useState(init.advice);
  const [diet, setDiet] = useState(init.diet);
  const [referral, setReferral] = useState(init.referral);
  const [followUp, setFollowUp] = useState(init.followUp);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const brands = options?.medicines ?? [];

  const setMed = (i: number, p: Partial<MedRow>) => setMeds(meds.map((m, j) => {
    if (j !== i) return m;
    const next = { ...m, ...p };
    if (("dosage" in p || "frequency" in p || "days" in p) && !("qty" in p) && m.qtyAuto) { const q = calculateQuantity(next.dosage, next.frequency, next.days ? Number(next.days) : undefined); next.qty = q ? String(q) : ""; next.qtyAuto = q !== null; }
    if ("qty" in p) next.qtyAuto = false;
    return next;
  }));
  const pickDrug = (i: number, drug: string) => {
    const m = meds[i]!;
    const keep = brands.find((b) => b.id === m.medicineId && b.genericName.toLowerCase() === drug.toLowerCase());
    setMed(i, { drug, medicineId: keep ? keep.id : "" });
  };
  const pickBrand = (i: number, id: string) => { const b = brands.find((x) => x.id === id); setMed(i, { medicineId: id, ...(b ? { drug: b.genericName } : {}) }); };

  const medErrors = (m: MedRow): string | null => {
    if (!m.on) return null;
    if (m.drug.trim().length < 2) return "Choose or type the drug.";
    if (m.dosage.trim().length < 1) return "Enter the dose.";
    if (m.days.trim() && !posInt(m.days, 365)) return "Days must be a number from 1 to 365.";
    if (m.qty.trim() && !posInt(m.qty, 100_000)) return "Quantity must be a whole number above zero.";
    return null;
  };
  const dxOk = dx.every((d) => !d.on || d.text.trim().length >= 2);
  const testsOk = tests.every((t) => !t.on || t.text.trim().length >= 2);
  const followOk = !followUp.trim() || posInt(followUp, 365);
  const medsOk = meds.every((m) => medErrors(m) === null);
  const chosen = dx.filter((d) => d.on).length + meds.filter((m) => m.on).length + tests.filter((t) => t.on).length + (advice.trim() || diet.trim() || referral.trim() ? 1 : 0);
  const canApply = dxOk && testsOk && followOk && medsOk && chosen > 0 && !busy;

  const apply = async () => {
    setBusy(true); setFailed(null);
    const items: RxItem[] = meds.filter((m) => m.on).map((m) => {
      const b = brands.find((x) => x.id === m.medicineId);
      const food = m.foodRelation as RxItem["foodRelation"];
      return {
        ...(b ? { medicineId: b.id, brandName: b.brandName, ...(b.strength ? { strength: b.strength } : {}) } : {}),
        genericName: (b?.genericName ?? m.drug).trim(), dosage: m.dosage.trim(), route: m.route, frequency: m.frequency,
        ...(m.days.trim() ? { durationDays: Number(m.days) } : {}), ...(m.qty.trim() ? { quantity: Number(m.qty) } : {}), qtyAuto: m.qtyAuto,
        ...(m.instructions.trim() ? { instructions: m.instructions.trim() } : {}), ...(food ? { foodRelation: food } : {}),
      };
    });
    const by = (k: Kind) => [...new Set(tests.filter((t) => t.on && t.category === k).map((t) => t.text.trim()))];
    try {
      await onApply({
        diagnoses: dx.filter((d) => d.on).map((d) => d.text.trim()), items,
        investigationsAdvised: by("LABORATORY"), otherTestsAdvised: by("RADIOLOGY"), cardiologyAdvised: by("CARDIOLOGY"), proceduresAdvised: by("PROCEDURE"),
        advice: advice.trim(), dietAdvice: diet.trim(), referral: referral.trim(), followUpDays: followUp.trim() ? Number(followUp) : null,
      });
      onClose();
    } catch (e) { setFailed(e instanceof Error ? e.message : "Could not put this on the prescription"); setBusy(false); }
  };

  const pc = draft?.patientCheck;
  return (
    <Modal title="Fill the prescription from the picture" onClose={onClose} wide>
      <div className="space-y-4" data-testid="fill-from-scan">
        {loadError != null && <Notice tone="error">The picture could not be read into a draft just now. You can still fill in the prescription by hand below. <ErrorNote error={loadError} /></Notice>}
        {draft?.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
        {optionsError != null && <Notice tone="warn">The Drug, Medicine and Lab test lists could not be loaded. You can still type the names. <button className="font-medium underline" onClick={retryOptions}>Try again</button></Notice>}
        {options?.truncated.medicines || options?.truncated.labTests ? <Notice tone="info">The lists are long, so only the first part is shown. Type the name to enter one that is not shown.</Notice> : null}
        {pc && (pc.nameOnPaper || pc.ageOnPaper !== null) && (
          <p className="text-sm text-slate-600" data-testid="patient-check">On the paper: {pc.nameOnPaper ?? "no name"}{pc.ageOnPaper !== null ? `, age ${pc.ageOnPaper}` : ""}. Name {CHECK_TEXT[pc.name]}{pc.age !== "NOT_ON_PAPER" ? `; age ${CHECK_TEXT[pc.age]}` : ""}.</p>
        )}
        <p className="text-xs text-slate-500">Everything below is a suggestion read from handwriting and can be wrong. Change anything, untick what is not right, add what is missing, then press Apply. Nothing is saved or sent yet: the prescription screen shows it for you to check, save and sign.</p>

        <datalist id="rx-drugs">{options?.drugs.map((d) => <option key={d} value={d} />)}</datalist>
        <datalist id="rx-lab-tests">{options?.labTests.map((t) => <option key={t.id} value={t.name} />)}</datalist>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Diagnosis</h3>
          <ul className="space-y-1">
            {dx.map((d, i) => (
              <li key={i} className="flex items-center gap-2">
                <input type="checkbox" aria-label="Use this diagnosis" checked={d.on} onChange={(e) => setDx(dx.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <Input aria-label="Diagnosis" className="flex-1" value={d.text} onChange={(e) => setDx(dx.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={() => setDx([...dx, { on: true, text: "" }])}>Add a diagnosis</Button>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Medicines</h3>
          <div className="space-y-2">
            {meds.map((m, i) => {
              const err = medErrors(m);
              const forDrug = brands.filter((b) => !m.drug.trim() || b.genericName.toLowerCase() === m.drug.trim().toLowerCase());
              return (
                <div key={i} className={`rounded border p-2 ${m.on ? "border-slate-200" : "border-slate-100 opacity-60"}`} data-testid="med-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" aria-label="Use this medicine" checked={m.on} onChange={(e) => setMed(i, { on: e.target.checked })} />
                    <Input aria-label="Drug" list="rx-drugs" placeholder="Drug (choose or type)" className="w-48" value={m.drug} disabled={!m.on} onChange={(e) => pickDrug(i, e.target.value)} />
                    <Select aria-label="Medicine" className="w-56" value={m.medicineId} disabled={!m.on} onChange={(e) => pickBrand(i, e.target.value)}>
                      <option value="">{forDrug.length ? "Medicine (brand and strength)…" : "No listed medicine for this drug"}</option>
                      {forDrug.map((b) => <option key={b.id} value={b.id}>{b.brandName} {b.strength ?? ""} ({b.dosageForm.toLowerCase()})</option>)}
                    </Select>
                    <Input aria-label="Dose" placeholder="Dose" className="w-28" value={m.dosage} disabled={!m.on} onChange={(e) => setMed(i, { dosage: e.target.value })} />
                    <Select aria-label="Frequency" className="w-24" value={m.frequency} disabled={!m.on} onChange={(e) => setMed(i, { frequency: e.target.value })}>{FREQS.map((f) => <option key={f}>{f}</option>)}</Select>
                    <Input aria-label="Days" placeholder="Days" inputMode="numeric" className="w-16" value={m.days} disabled={!m.on} onChange={(e) => setMed(i, { days: e.target.value })} />
                    <Input aria-label="Quantity" placeholder="Qty" inputMode="numeric" className="w-16" value={m.qty} disabled={!m.on} onChange={(e) => setMed(i, { qty: e.target.value })} />
                    <button type="button" aria-label="Remove this medicine" className="text-slate-400 hover:text-red-700" onClick={() => setMeds(meds.filter((_, j) => j !== i))}>✕</button>
                  </div>
                  {m.read && <div className="mt-1 text-xs text-slate-500">Read from the picture as: “{m.read}”{m.medicineId ? "" : " — not matched to a listed medicine: choose one, or keep the typed drug"}{m.qtyAuto && m.qty ? " · quantity worked out from the dose, how often and the days" : ""}</div>}
                  {err && <div className="mt-1 text-xs text-red-700">{err}</div>}
                </div>
              );
            })}
          </div>
          <Button variant="ghost" onClick={() => setMeds([...meds, blankMed()])}>Add a medicine</Button>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lab tests and other investigations</h3>
          <ul className="space-y-1">
            {tests.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <input type="checkbox" aria-label="Use this test" checked={t.on} onChange={(e) => setTests(tests.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <Input aria-label="Lab test" list="rx-lab-tests" placeholder="Test (choose or type)" className="min-w-48 flex-1" value={t.text} disabled={!t.on} onChange={(e) => setTests(tests.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                <Select aria-label="Kind of test" className="w-32" value={t.category} disabled={!t.on} onChange={(e) => setTests(tests.map((x, j) => (j === i ? { ...x, category: e.target.value as Kind } : x)))}>{(Object.keys(KIND_NAME) as Kind[]).map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</Select>
                {draft?.tests[i] && <Badge tone={draft.tests[i]!.matched ? "green" : "gray"}>{draft.tests[i]!.matched ? "in the test list" : "not in the test list"}</Badge>}
                <button type="button" aria-label="Remove this test" className="text-slate-400 hover:text-red-700" onClick={() => setTests(tests.filter((_, j) => j !== i))}>✕</button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={() => setTests([...tests, { on: true, text: "", category: "LABORATORY" }])}>Add a test</Button>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Medical advice</h3>
          <Field label="Advice for the patient" as="div"><Textarea aria-label="Advice" value={advice} onChange={(e) => setAdvice(e.target.value)} placeholder="One instruction on each line" /></Field>
          {options && options.advice.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5" data-testid="advice-phrases">
              {options.advice.map((p) => <button key={p} type="button" className="rounded-full border border-slate-300 px-2 py-0.5 text-xs hover:bg-brand-50" onClick={() => setAdvice(advice.split("\n").map((l) => l.trim()).includes(p) ? advice : [advice.trim(), p].filter(Boolean).join("\n"))}>+ {p}</button>)}
            </div>
          )}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="Diet advice" as="div"><Textarea aria-label="Diet advice" value={diet} onChange={(e) => setDiet(e.target.value)} /></Field>
            <div className="space-y-2">
              <Field label="Referral" as="div"><Input aria-label="Referral" value={referral} onChange={(e) => setReferral(e.target.value)} /></Field>
              <Field label="Follow-up after (days)" as="div"><Input aria-label="Follow-up days" inputMode="numeric" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />{!followOk && <span className="text-xs text-red-700">A number of days from 1 to 365.</span>}</Field>
            </div>
          </div>
        </section>

        {failed && <Notice tone="error">{failed}</Notice>}
        <div className="flex items-center justify-between border-t border-slate-200 pt-3">
          <span className="text-xs text-slate-500">{chosen === 0 ? "Nothing selected yet." : "Ready to put on the prescription screen."}</span>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!canApply} onClick={() => void apply()}>Apply to the prescription</Button></div>
        </div>
      </div>
    </Modal>
  );
}
