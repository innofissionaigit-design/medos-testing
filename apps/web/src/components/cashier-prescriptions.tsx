"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Service } from "@/components/test-billing";
import { Badge, Button, Card, ErrorNote, Input, Modal, Notice, Select, Spinner } from "@/components/ui";
import { api, printUrl } from "@/lib/api";
import { canEditTests } from "@/lib/cashier-edit";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

interface Medicine { orderNumber: string | null; source: string; pharmacy: "WAITING" | "PARTLY_GIVEN" | "GIVEN"; items: { id: string; name: string; strength: string | null; dosage: string; frequency: string; days: number | null; quantity: number | null; suggestedQuantity?: number | null; given: number; status: string }[] }
interface Page { pageNo: number; fileId: string; fileName: string; contentType: string }
interface PictureInfo { scanId: string; uploadedAt: string; pharmacy: "WAITING" | "GIVEN" | "SENT_BACK"; testsRead: boolean; pages: Page[] }
interface TestInfo { id: string; category: string; name: string; source: string; status: string; price: string | null; taxPercent: string | null; invoiceNumber: string | null }
interface Bill { invoiceId: string; invoiceNumber: string | null; kind: string; status: string; total: string; balanceDue: string; lines: { description: string; quantity: string; total: string }[] }
type Category = "LABORATORY" | "RADIOLOGY" | "CARDIOLOGY" | "PROCEDURE";
/** One test as it will be billed. originalName is what the doctor wrote (empty for a test the Cashier added). */
interface Line { id: string | null; orderId: string | null; scanId: string | null; name: string; originalName: string | null; category: string; serviceId: string | null; quantity: number; price: string | null; taxPercent: string; removed: boolean; edited: boolean; source: string; total: string | null }
interface VisitInfo { encounterId: string; visitDate: string; doctorName: string | null; medicines: Medicine[]; pictures: PictureInfo[]; tests: TestInfo[]; billing: { lines: Line[]; total: string; unpriced: number }; bills: Bill[] }
interface PatientCard { patientId: string; patientName: string; mrn: string | null; visits: VisitInfo[]; toCollect: string; testsToBill: number; medicinesWaiting: number; picturesToRead: number }

const PHARMACY: Record<string, string> = { WAITING: "with the pharmacy", PARTLY_GIVEN: "partly given", GIVEN: "given", SENT_BACK: "sent back by the pharmacy" };
const CATEGORY: Record<string, string> = { LABORATORY: "lab", RADIOLOGY: "imaging", CARDIOLOGY: "cardiology", PROCEDURE: "procedure" };
const BILL_KIND: Record<string, string> = { PHARMACY: "Medicines bill", OTHER: "Tests bill" };
const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
const METHOD_NAME: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };

const cents = (v: string): number => Math.round(Number(v) * 100);
const validAmount = (v: string): boolean => /^\d{1,8}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;
const validTax = (v: string): boolean => /^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) && Number(v) <= 100;
const validQty = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 99;
const lineOk = (l: Line): boolean => l.removed || (l.name.trim().length >= 2 && l.price !== null && validAmount(l.price) && validTax(l.taxPercent) && validQty(l.quantity));
/** The Cashier's own estimate of what the tests come to; the server works out the real amounts when it bills. */
const lineCents = (l: Line): number => (l.removed || l.price === null || !validAmount(l.price) ? 0 : Math.round(cents(l.price) * l.quantity * (1 + (validTax(l.taxPercent) ? Number(l.taxPercent) : 0) / 100)));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mt-3"><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>{children}</div>;
}

/** The doctor's original handwritten page: opens in a viewer that zooms. */
function ImageViewer({ pages, start, onClose }: { pages: Page[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [zoom, setZoom] = useState(1);
  const pg = pages[i]!;
  const src = `/api/proxy/files/${pg.fileId}/content`;
  return (
    <Modal title={`Handwritten prescription, page ${pg.pageNo}`} onClose={onClose} wide>
      <div className="space-y-2" data-testid="image-viewer">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}>−</Button>
          <span className="w-14 text-center text-sm">{Math.round(zoom * 100)}%</span>
          <Button variant="secondary" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom + 0.25))}>+</Button>
          <Button variant="ghost" onClick={() => setZoom(1)}>Fit</Button>
          {pages.length > 1 && <><Button variant="ghost" disabled={i === 0} onClick={() => { setI(i - 1); setZoom(1); }}>Previous page</Button><Button variant="ghost" disabled={i === pages.length - 1} onClick={() => { setI(i + 1); setZoom(1); }}>Next page</Button></>}
          <a href={src} target="_blank" rel="noreferrer" className="ml-auto text-sm text-brand-700 hover:underline">Open in a new tab</a>
        </div>
        <div className="max-h-[70vh] overflow-auto rounded border border-slate-200 bg-slate-50">
          {pg.contentType.startsWith("image/")
            ? <img src={src} alt={`Handwritten prescription, page ${pg.pageNo}`} style={{ width: `${zoom * 100}%`, maxWidth: "none" }} />
            : <p className="p-3 text-sm">This page is a document. <a className="text-brand-700 underline" href={src} target="_blank" rel="noreferrer">Open it</a>.</p>}
        </div>
      </div>
    </Modal>
  );
}

/** The tests of one prescription, editable for billing. The doctor's order is never changed: edits are saved as billing lines (docs/test-orders.md). */
function TestLines({ lines, indexes, editing, services, scanId, onChange }: { lines: Line[]; indexes: number[]; editing: boolean; services: Service[]; scanId: string | null; onChange: (next: Line[]) => void }) {
  const { money } = useMe();
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => onChange(lines[i]!.orderId ? lines.map((l, j) => (j === i ? { ...l, removed: true } : l)) : lines.filter((_, j) => j !== i));
  const add = (patch: Partial<Line>) => onChange([...lines, { id: null, orderId: null, scanId, name: "", originalName: null, category: "LABORATORY", serviceId: null, quantity: 1, price: "", taxPercent: "0", removed: false, edited: true, source: scanId ? "HANDWRITTEN" : "CASHIER", total: null, ...patch }]);
  return (
    <div>
      <ul className="divide-y divide-slate-100 text-sm">
        {indexes.map((i) => {
          const l = lines[i]!;
          const bad = editing && !lineOk(l);
          if (!editing) {
            return (
              <li key={i} className={`flex flex-wrap items-center gap-2 py-1 ${l.removed ? "text-slate-400 line-through" : ""}`}>
                <Badge>{CATEGORY[l.category] ?? l.category.toLowerCase()}</Badge>
                <span className="flex-1">{l.name}{l.quantity > 1 ? ` × ${l.quantity}` : ""}
                  {l.edited && l.originalName && l.originalName !== l.name ? <span className="text-xs text-slate-500"> (doctor wrote: {l.originalName})</span> : null}
                  {l.originalName === null ? <span className="text-xs text-slate-500"> (added by the Cashier)</span> : null}
                  {l.removed ? <span className="text-xs"> — taken off the bill</span> : null}</span>
                {l.removed ? null : l.price === null ? <span className="text-xs text-amber-700">needs a price — use Edit</span> : <span>{l.total ? money(l.total) : money(l.price)}</span>}
              </li>
            );
          }
          return (
            <li key={i} className={`flex flex-wrap items-center gap-1.5 py-1.5 ${l.removed ? "opacity-50" : ""}`}>
              <Select aria-label="Kind of test" className="w-28" value={l.category} disabled={l.removed} onChange={(e) => set(i, { category: e.target.value as Category })}>
                <option value="LABORATORY">Lab</option><option value="RADIOLOGY">Imaging</option><option value="CARDIOLOGY">Cardiology</option><option value="PROCEDURE">Procedure</option>
              </Select>
              <Input aria-label="Test name" className="min-w-40 flex-1" value={l.name} disabled={l.removed} onChange={(e) => set(i, { name: e.target.value, serviceId: null })} />
              <Input aria-label="Quantity" inputMode="numeric" className="w-14" value={String(l.quantity)} disabled={l.removed} onChange={(e) => set(i, { quantity: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
              <Input aria-label="Price" placeholder="Price" inputMode="decimal" className="w-24" value={l.price ?? ""} disabled={l.removed} onChange={(e) => set(i, { price: e.target.value })} />
              <Input aria-label="Tax percent" placeholder="Tax %" inputMode="decimal" className="w-16" value={l.taxPercent} disabled={l.removed} onChange={(e) => set(i, { taxPercent: e.target.value })} />
              {l.removed ? <button className="text-xs text-brand-700 hover:underline" onClick={() => set(i, { removed: false })}>Put back</button> : <button aria-label="Take this test off the bill" className="text-slate-400 hover:text-red-700" onClick={() => remove(i)}>✕</button>}
              {bad && <span className="w-full text-xs text-red-700">Give the test a name (2+ letters), a price above zero and a quantity from 1 to 99.</span>}
              {l.originalName && l.originalName !== l.name && !l.removed && <span className="w-full text-xs text-slate-500">The doctor wrote: {l.originalName}</span>}
            </li>
          );
        })}
      </ul>
      {editing && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => add({})}>Add a test</Button>
          <Select aria-label="Add from the price list" className="w-56" value="" onChange={(e) => { const s = services.find((x) => x.id === e.target.value); if (s) add({ name: s.name, serviceId: s.id, price: s.price, taxPercent: s.taxPercent }); }}>
            <option value="">Add from the price list…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)}</option>)}
          </Select>
        </div>
      )}
    </div>
  );
}

function MedicineTable({ meds }: { meds: Medicine[] }) {
  return (
    <>
      {meds.map((m, i) => (
        <div key={i} className="mb-2">
          <div className="text-xs text-slate-500">{m.orderNumber ? `Prescription ${m.orderNumber} — ` : ""}pharmacy: {PHARMACY[m.pharmacy]}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="medicine-table">
              <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3 font-medium">Medicine</th><th className="pr-3 font-medium">Strength</th><th className="pr-3 font-medium">Dosage</th><th className="pr-3 font-medium">Frequency</th><th className="pr-3 font-medium">Days</th><th className="pr-3 font-medium">Quantity</th><th className="font-medium">Given</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {m.items.map((x) => (
                  <tr key={x.id}>
                    <td className="py-1 pr-3 font-medium">{x.name}</td><td className="pr-3">{x.strength ?? "—"}</td><td className="pr-3">{x.dosage}</td><td className="pr-3">{x.frequency}</td><td className="pr-3">{x.days ?? "—"}</td>
                    <td className="pr-3">{x.quantity ?? (x.suggestedQuantity ? `${x.suggestedQuantity} (calculated)` : "not written")}</td><td>{x.status !== "ACTIVE" ? x.status.toLowerCase() : x.given}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

interface CollectResult { total: string; stillDue: string; billedTests: { encounterId: string; invoiceNumber: string | null; total: string }[]; receipts: { invoiceId: string; invoiceNumber: string | null; receiptId: string; receiptNumber: string; amount: string; invoiceStatus: string }[] }

/** One payment for everything of the patient still to collect: the pharmacy's medicines bill, bills already made, and the visit's tests (billed from the saved lines in the same step). */
function CollectTotal({ patient, onClose }: { patient: PatientCard; onClose: () => void }) {
  const { money } = useMe();
  const qc = useQueryClient();
  const due = patient.visits.flatMap((v) => v.bills).filter((b) => Number(b.balanceDue) > 0);
  const testVisits = patient.visits.filter((v) => v.billing.lines.some((l) => !l.removed) && v.billing.unpriced === 0 && cents(v.billing.total) > 0);
  const [picked, setPicked] = useState<Set<string>>(new Set(due.map((b) => b.invoiceId)));
  const [pickedTests, setPickedTests] = useState<Set<string>>(new Set(testVisits.map((v) => v.encounterId)));
  const total = due.filter((b) => picked.has(b.invoiceId)).reduce((n, b) => n + cents(b.balanceDue), 0) + testVisits.filter((v) => pickedTests.has(v.encounterId)).reduce((n, v) => n + cents(v.billing.total), 0);
  const [rows, setRows] = useState([{ method: "CASH", amount: (total / 100).toFixed(2), reference: "" }]);
  const [edited, setEdited] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const entered = rows.reduce((n, r) => n + (validAmount(r.amount) ? cents(r.amount) : 0), 0);
  const rowsOk = rows.every((r) => !r.amount.trim() || (validAmount(r.amount) && (r.method === "CASH" || r.reference.trim().length >= 4)));
  const canPay = (picked.size > 0 || pickedTests.size > 0) && entered > 0 && entered <= total && rowsOk;
  const follow = (nextBills: Set<string>, nextTests: Set<string>) => {
    if (edited) return;
    const t = due.filter((b) => nextBills.has(b.invoiceId)).reduce((n, b) => n + cents(b.balanceDue), 0) + testVisits.filter((v) => nextTests.has(v.encounterId)).reduce((n, v) => n + cents(v.billing.total), 0);
    setRows([{ ...rows[0]!, amount: (t / 100).toFixed(2) }]);
  };
  const toggleBill = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); follow(n, pickedTests); };
  const toggleTests = (id: string) => { const n = new Set(pickedTests); if (n.has(id)) n.delete(id); else n.add(id); setPickedTests(n); follow(picked, n); };
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => { setEdited(true); setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const pay = useMutation({
    mutationFn: () => api.post<CollectResult>(`/cashier/patients/${patient.patientId}/collect`, {
      invoiceIds: [...picked], billTests: [...pickedTests],
      payments: rows.filter((r) => validAmount(r.amount)).map((r) => ({ method: r.method, amount: r.amount.trim(), ...(r.method !== "CASH" ? { reference: r.reference.trim() } : {}) })),
    }, key),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["cashier-view"] }); await qc.invalidateQueries({ queryKey: ["invoices"] }); await qc.invalidateQueries({ queryKey: ["pharmacy-waiting"] }); },
  });
  if (pay.data) {
    return (
      <Modal title={`Payment taken: ${patient.patientName}`} onClose={onClose}>
        <div className="space-y-3">
          <Notice tone="success">Collected {money(pay.data.total)}. {Number(pay.data.stillDue) > 0 ? `Still to collect: ${money(pay.data.stillDue)}.` : "Nothing is left to collect."}</Notice>
          <ul className="divide-y divide-slate-100 text-sm">
            {pay.data.receipts.map((r) => (
              <li key={r.receiptId} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-medium">{r.invoiceNumber}</span><span className="text-slate-500">receipt {r.receiptNumber}</span><span className="ml-auto">{money(r.amount)}</span>
                <span className="text-xs text-slate-500">{r.invoiceStatus.replace("_", " ").toLowerCase()}</span>
                <PrintLink href={printUrl(`receipts/${r.receiptId}`)} className="text-xs text-brand-700 hover:underline">Print receipt</PrintLink>
              </li>
            ))}
          </ul>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Collect payment: ${patient.patientName}`} onClose={onClose} wide>
      <div className="space-y-3" data-testid="collect-total">
        <ul className="divide-y divide-slate-100 text-sm">
          {due.map((b) => (
            <li key={b.invoiceId} className="flex flex-wrap items-center gap-2 py-1.5">
              <input type="checkbox" aria-label={`Include ${b.invoiceNumber}`} checked={picked.has(b.invoiceId)} onChange={() => toggleBill(b.invoiceId)} />
              <span className="font-medium">{b.invoiceNumber}</span><Badge>{BILL_KIND[b.kind] ?? b.kind.toLowerCase()}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{b.lines.map((l) => l.description).join(", ")}</span>
              <span>{money(b.balanceDue)}</span>
            </li>
          ))}
          {testVisits.map((v) => (
            <li key={v.encounterId} className="flex flex-wrap items-center gap-2 py-1.5">
              <input type="checkbox" aria-label="Include the tests of this visit" checked={pickedTests.has(v.encounterId)} onChange={() => toggleTests(v.encounterId)} />
              <span className="font-medium">Tests, visit {new Date(v.visitDate).toLocaleDateString()}</span><Badge tone="amber">billed when you collect</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{v.billing.lines.filter((l) => !l.removed).map((l) => `${l.name}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`).join(", ")}</span>
              <span>{money(v.billing.total)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-slate-200 pt-2 text-sm"><span className="text-slate-600">Total to collect (medicines and tests)</span><span className="text-lg font-semibold">{money((total / 100).toFixed(2))}</span></div>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">How the patient pays</div>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label="Payment method" className="w-40" value={r.method} onChange={(e) => setRow(i, { method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_NAME[m]}</option>)}</Select>
              <Input aria-label="Amount" inputMode="decimal" className="w-32" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} />
              {r.method !== "CASH" && <Input aria-label="Reference" placeholder="Transaction id / last digits" className="w-56" value={r.reference} onChange={(e) => setRow(i, { reference: e.target.value })} />}
              {rows.length > 1 && <button aria-label="Remove this payment" className="text-slate-400 hover:text-red-700" onClick={() => { setEdited(true); setRows(rows.filter((_, j) => j !== i)); }}>✕</button>}
            </div>
          ))}
          {rows.length < 6 && <button className="text-sm text-brand-700 hover:underline" onClick={() => { setEdited(true); setRows([...rows, { method: "UPI", amount: Math.max(0, (total - entered) / 100).toFixed(2), reference: "" }]); }}>Add another way of paying</button>}
          <div className="text-sm text-slate-600">Entered {money((entered / 100).toFixed(2))}{entered > total ? <span className="text-red-700"> — more than the total</span> : entered < total ? <span> — {money(((total - entered) / 100).toFixed(2))} will stay to be collected</span> : null}</div>
        </div>
        <ErrorNote error={pay.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!canPay} loading={pay.isPending} onClick={() => pay.mutate()}>Collect {money((entered / 100).toFixed(2))}</Button></div>
      </div>
    </Modal>
  );
}

function Visit({ v, services, onDirty }: { v: VisitInfo; services: Service[]; onDirty: (encounterId: string, dirty: boolean) => void }) {
  const { money, dateTime } = useMe();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Line[] | null>(null);
  const [viewer, setViewer] = useState<{ pages: Page[]; start: number } | null>(null);
  const editing = draft !== null;
  const lines = draft ?? v.billing.lines;
  const start = () => { setDraft(v.billing.lines.map((l) => ({ ...l }))); onDirty(v.encounterId, true); };
  const stop = () => { setDraft(null); onDirty(v.encounterId, false); };
  const save = useMutation({
    mutationFn: () => api.put(`/test-orders/billing/${v.encounterId}`, {
      lines: lines.map((l) => ({
        ...(l.orderId ? { orderId: l.orderId } : l.id ? { lineId: l.id } : l.scanId ? { scanId: l.scanId } : {}),
        name: l.name.trim(), category: l.category, ...(l.serviceId ? { serviceId: l.serviceId } : {}), quantity: l.quantity, ...(l.price !== null && validAmount(l.price) ? { price: l.price.trim() } : {}), taxPercent: l.taxPercent.trim() || "0", removed: l.removed,
      })),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["cashier-view"] }); stop(); },
  });
  const noTests = useMutation({ mutationFn: (scanId: string) => api.post(`/test-orders/pictures/${scanId}/no-tests`), onSuccess: () => qc.invalidateQueries({ queryKey: ["cashier-view"] }) });
  const digitalMeds = v.medicines.filter((m) => m.source !== "HANDWRITTEN");
  const handMeds = v.medicines.filter((m) => m.source === "HANDWRITTEN");
  const isHand = (l: Line) => l.source === "HANDWRITTEN";
  const idx = (pred: (l: Line) => boolean) => lines.flatMap((l, i) => (pred(l) ? [i] : []));
  const digitalIdx = idx((l) => !isHand(l));
  const handIdx = idx(isHand);
  const unread = v.pictures.filter((p) => !p.testsRead && p.pharmacy !== "SENT_BACK");
  const allOk = lines.every(lineOk);
  const billedTests = v.tests.filter((x) => x.status !== "ORDERED");
  const liveTotal = lines.reduce((n, l) => n + lineCents(l), 0);
  const hasDigital = digitalMeds.length > 0 || digitalIdx.length > 0 || (v.pictures.length === 0 && handMeds.length === 0);
  const hasHand = v.pictures.length > 0 || handMeds.length > 0 || handIdx.length > 0;
  return (
    <div className="rounded border border-slate-200 p-3" data-testid="cashier-visit">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm text-slate-600">Visit {dateTime(v.visitDate)} · Dr {v.doctorName ?? "—"}</div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canEditTests(lines.length, unread.length, editing) && <Button variant="secondary" onClick={start}>Edit tests</Button>}
          {editing && <><Button variant="ghost" onClick={stop}>Cancel</Button><Button loading={save.isPending} disabled={!allOk} onClick={() => save.mutate()}>Save changes</Button></>}
        </div>
      </div>
      <ErrorNote error={save.error ?? noTests.error} />

      {hasDigital && (
        <Section title="Digital prescription">
          {digitalMeds.length > 0 ? <MedicineTable meds={digitalMeds} /> : <p className="text-sm text-slate-500">No medicines written on screen.</p>}
          <div className="mt-2 text-xs font-semibold text-slate-500">Lab tests and other investigations</div>
          {digitalIdx.length > 0 || editing
            ? <TestLines lines={lines} indexes={digitalIdx} editing={editing} services={services} scanId={null} onChange={setDraft} />
            : <p className="text-sm text-slate-500">No tests written on screen.</p>}
        </Section>
      )}

      {hasHand && (
        <Section title="Handwritten prescription">
          {v.pictures.map((p) => (
            <div key={p.scanId} className="mb-2">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>Medicines: {PHARMACY[p.pharmacy]}</span><span>·</span><span>Tests: {p.testsRead ? "read and billed" : "not read yet"}</span>
                {!p.testsRead && p.pharmacy !== "SENT_BACK" && <button className="ml-auto text-brand-700 hover:underline" onClick={() => noTests.mutate(p.scanId)}>No tests on this prescription</button>}
              </div>
              <div className="flex flex-wrap gap-2">
                {p.pages.map((pg, n) => (
                  <button key={pg.fileId} type="button" aria-label={`Open page ${pg.pageNo} to zoom`} onClick={() => setViewer({ pages: p.pages, start: n })} className="block rounded border border-slate-200 p-1 text-center text-xs text-brand-700 hover:bg-slate-50">
                    {pg.contentType.startsWith("image/") ? <img src={`/api/proxy/files/${pg.fileId}/content`} alt={`Handwritten prescription, page ${pg.pageNo}`} className="h-32 w-32 rounded object-contain" /> : null}
                    Page {pg.pageNo} · open and zoom
                  </button>
                ))}
              </div>
            </div>
          ))}
          {handMeds.length > 0 && <MedicineTable meds={handMeds} />}
          <div className="mt-2 text-xs font-semibold text-slate-500">Lab tests and other investigations{unread.length > 0 && !editing ? " (read them off the picture: press Edit tests, then Add a test)" : ""}</div>
          {handIdx.length > 0 || editing
            ? <TestLines lines={lines} indexes={handIdx} editing={editing} services={services} scanId={unread[0]?.scanId ?? null} onChange={setDraft} />
            : <p className="text-sm text-slate-500">No tests read from this prescription yet.{unread.length > 0 && <> <button type="button" className="font-medium text-brand-700 hover:underline" onClick={start}>Enter the tests from this prescription</button></>}</p>}
        </Section>
      )}

      {lines.length > 0 && (
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-slate-500">{editing ? "Total of these tests (calculated again by the server when billed)" : v.billing.unpriced > 0 ? "Some tests need a price: press Edit tests" : "Tests to bill"}</span>
          <span className="font-medium">{editing ? money((liveTotal / 100).toFixed(2)) : v.billing.unpriced > 0 ? "—" : money(v.billing.total)}</span>
        </div>
      )}

      {billedTests.length > 0 && (
        <Section title="Tests already dealt with">
          <ul className="divide-y divide-slate-100 text-sm">
            {billedTests.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 py-1">
                <Badge>{CATEGORY[x.category] ?? x.category.toLowerCase()}</Badge><span className="flex-1">{x.name} <span className="text-xs text-slate-500">({x.source === "HANDWRITTEN" ? "from the handwritten prescription" : x.source === "CASHIER" ? "added by the Cashier" : "digital"})</span></span>
                {x.status === "BILLED" ? <span className="text-xs text-slate-500">billed{x.invoiceNumber ? ` · ${x.invoiceNumber}` : ""}</span> : <span className="text-xs text-slate-400">taken off</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {v.bills.length > 0 && (
        <Section title="Bills">
          <ul className="divide-y divide-slate-100 text-sm">
            {v.bills.map((b) => (
              <li key={b.invoiceId} className="py-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="font-medium text-brand-700 hover:underline" href={`/billing/${b.invoiceId}`}>{b.invoiceNumber ?? "Bill"}</Link>
                  <Badge>{BILL_KIND[b.kind] ?? b.kind.toLowerCase()}</Badge>
                  <span className="text-slate-500">{b.status.replace("_", " ").toLowerCase()}</span>
                  <span className="ml-auto">{money(b.total)}</span>
                  {Number(b.balanceDue) > 0 ? <Link className="rounded bg-brand-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-brand-700" href={`/billing/${b.invoiceId}`}>Open {money(b.balanceDue)}</Link> : <span className="text-xs text-green-700">paid</span>}
                </div>
                {b.lines.length > 0 && <div className="text-xs text-slate-500">{b.lines.map((l) => `${l.description}${Number(l.quantity) > 1 ? ` × ${l.quantity}` : ""}`).join(", ")}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {viewer && <ImageViewer pages={viewer.pages} start={viewer.start} onClose={() => setViewer(null)} />}
    </div>
  );
}

/**
 * The Cashier's one place per patient (docs/test-orders.md): the doctor's digital and handwritten prescriptions side by side as separate sections, the medicines
 * with where the pharmacy stands, the tests (editable for billing), and the bills. One payment collects the medicines bill and the edited tests together.
 */
export function CashierPrescriptions() {
  const { money } = useMe();
  const [collecting, setCollecting] = useState<PatientCard | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const view = useQuery({ queryKey: ["cashier-view"], queryFn: () => api.get<{ patients: PatientCard[] }>("/cashier/prescriptions"), refetchInterval: 20_000 });
  const services = useQuery({ queryKey: ["services-all"], queryFn: () => api.page<Service>("/services", { pageSize: 100 }) });
  const list = services.data?.data ?? [];
  const patients = view.data?.patients ?? [];
  const onDirty = (id: string, d: boolean) => setDirty((s) => { const n = new Set(s); if (d) n.add(id); else n.delete(id); return n; });
  const collectable = (p: PatientCard): number => cents(p.toCollect) + p.visits.filter((v) => v.billing.lines.some((l) => !l.removed) && v.billing.unpriced === 0).reduce((n, v) => n + cents(v.billing.total), 0);
  return (
    <Card title={`Prescriptions for billing${patients.length ? ` (${patients.length} ${patients.length === 1 ? "patient" : "patients"})` : ""}`}>
      {view.isLoading ? <Spinner /> : patients.length === 0 ? <p className="text-sm text-slate-500">Nothing is waiting: no prescriptions, tests or bills to deal with.</p> : (
        <div className="space-y-4">
          {patients.map((p) => {
            const total = collectable(p);
            const unsaved = p.visits.some((v) => dirty.has(v.encounterId));
            return (
              <div key={p.patientId} className="rounded-lg border border-slate-300 p-3" data-testid="cashier-patient">
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="text-base font-semibold text-brand-700 hover:underline" href={`/patients/${p.patientId}`}>{p.patientName}</Link>
                  <span className="text-xs text-slate-500">{p.mrn}</span>
                  {p.testsToBill > 0 && <Badge tone="amber">{p.testsToBill} {p.testsToBill === 1 ? "test" : "tests"} to bill</Badge>}
                  {p.picturesToRead > 0 && <Badge tone="amber">{p.picturesToRead} handwritten to read</Badge>}
                  {p.medicinesWaiting > 0 && <Badge>{p.medicinesWaiting} with the pharmacy</Badge>}
                  {total > 0 && (
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-sm font-medium">To collect {money((total / 100).toFixed(2))}</span>
                      <Button disabled={unsaved} title={unsaved ? "Save your changes to the tests first" : undefined} onClick={() => setCollecting(p)}>Collect total {money((total / 100).toFixed(2))}</Button>
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-3">{p.visits.map((v) => <Visit key={v.encounterId} v={v} services={list} onDirty={onDirty} />)}</div>
              </div>
            );
          })}
        </div>
      )}
      <ErrorNote error={view.error} />
      {collecting && <CollectTotal patient={collecting} onClose={() => setCollecting(null)} />}
    </Card>
  );
}
