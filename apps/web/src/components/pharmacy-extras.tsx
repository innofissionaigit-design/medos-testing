"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, useDebounced } from "./ui";

interface Med { id: string; brandName: string; genericName: string; strength: string | null }
interface Supplier { id: string; name: string; phone: string | null; email: string | null; gstin: string | null; address: string | null; status: string }

function MedPick({ value, onPick }: { value: Med | null; onPick: (m: Med | null) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["med-pick", term], queryFn: () => api.page<Med>("/medicines", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) return <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm"><span>{value.brandName} {value.strength}</span><button className="text-xs text-brand-700" onClick={() => onPick(null)}>change</button></div>;
  return (
    <div className="relative">
      <Input aria-label="Medicine" placeholder="Search medicine" value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && res.data && <ul className="absolute z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg">{res.data.data.map((m) => <li key={m.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onClick={() => onPick(m)}>{m.brandName} <span className="text-slate-500">· {m.genericName} {m.strength}</span></li>)}</ul>}
    </div>
  );
}

// ───────────────────────── suppliers ─────────────────────────

export function SuppliersTab() {
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["suppliers"], queryFn: () => api.get<Supplier[]>("/pharmacy/suppliers") });
  const [f, setF] = useState({ name: "", phone: "", email: "", gstin: "", address: "" });
  const add = useMutation({
    mutationFn: () => api.post("/pharmacy/suppliers", Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))),
    onSuccess: () => { setF({ name: "", phone: "", email: "", gstin: "", address: "" }); void qc.invalidateQueries({ queryKey: ["suppliers"] }); },
  });
  const toggle = useMutation({ mutationFn: (s: Supplier) => api.patch(`/pharmacy/suppliers/${s.id}`, { status: s.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }) });
  return (
    <div className="space-y-4">
      {can("PHARMACY_MASTERS") && (
        <Card title="Add a supplier">
          <form className="grid grid-cols-2 gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Input className="sm:col-span-2" placeholder="Supplier name" aria-label="Supplier name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Input placeholder="Phone" aria-label="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <Input placeholder="Email" aria-label="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <Input placeholder="GSTIN" aria-label="GSTIN" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} />
            <Button type="submit" loading={add.isPending} disabled={f.name.trim().length < 2}>Add</Button>
            <Input className="col-span-2 sm:col-span-6" placeholder="Address (optional)" aria-label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            <div className="col-span-2 sm:col-span-6"><ErrorNote error={add.error} /></div>
          </form>
        </Card>
      )}
      <Card title="Suppliers">
        {list.isLoading ? <Spinner /> : (
          <Table head={["Name", "Phone", "GSTIN", "Status", ""]} {...(list.data?.length === 0 ? { empty: "No suppliers yet." } : {})}>
            {list.data?.map((s) => (
              <tr key={s.id}><Td>{s.name}<div className="text-xs text-slate-500">{s.email} {s.address}</div></Td><Td>{s.phone ?? "—"}</Td><Td>{s.gstin ?? "—"}</Td><Td><Badge tone={s.status === "ACTIVE" ? "green" : "gray"}>{s.status.toLowerCase()}</Badge></Td>
                <Td>{can("PHARMACY_MASTERS") && <Button variant="ghost" onClick={() => toggle.mutate(s)}>{s.status === "ACTIVE" ? "Deactivate" : "Activate"}</Button>}</Td></tr>
            ))}
          </Table>
        )}
        <ErrorNote error={toggle.error} />
      </Card>
    </div>
  );
}

// ───────────────────────── purchases ─────────────────────────

interface PurchaseItem { id: string; medicineName: string; batchNo: string | null; expiryDate: string | null; quantity: number; returnedQuantity: number; purchasePrice: string }
interface Purchase { id: string; purchaseNumber: string; supplierName: string; supplierInvoiceNo: string; supplierInvoiceDate: string; status: string; total: string; receivedAt: string; items: PurchaseItem[]; returns: { returnNumber: string; total: string; reason: string }[] }
type PRow = { med: Med | null; batchNo: string; expiryDate: string; quantity: string; mrp: string; purchasePrice: string; sellingPrice: string };
const blankRow = (): PRow => ({ med: null, batchNo: "", expiryDate: "", quantity: "", mrp: "", purchasePrice: "", sellingPrice: "" });

function NewPurchase({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => api.get<Supplier[]>("/pharmacy/suppliers") });
  const [supplierId, setSupplierId] = useState("");
  const [invNo, setInvNo] = useState("");
  const [invDate, setInvDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<PRow[]>([blankRow()]);
  const [key] = useState(newKey);
  const patch = (i: number, p: Partial<PRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const ready = supplierId && invNo.trim() && rows.length > 0 && rows.every((r) => r.med && r.batchNo && r.expiryDate && Number(r.quantity) > 0 && r.mrp && r.purchasePrice && r.sellingPrice);
  const save = useMutation({
    mutationFn: () => api.post("/pharmacy/purchases", {
      supplierId, supplierInvoiceNo: invNo.trim(), supplierInvoiceDate: invDate,
      items: rows.map((r) => ({ medicineId: r.med!.id, batchNo: r.batchNo.trim(), expiryDate: r.expiryDate, quantity: Number(r.quantity), mrp: r.mrp, purchasePrice: r.purchasePrice, sellingPrice: r.sellingPrice })),
    }, key),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["purchases"] }); await qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); },
  });
  return (
    <Modal title="Receive a purchase" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose…</option>{suppliers.data?.filter((s) => s.status === "ACTIVE").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Supplier invoice no."><Input value={invNo} onChange={(e) => setInvNo(e.target.value)} /></Field>
          <Field label="Invoice date"><Input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} /></Field>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 items-start gap-2 rounded-md border border-slate-100 p-2">
            <div className="col-span-12 sm:col-span-4"><MedPick value={r.med} onPick={(m) => patch(i, { med: m })} /></div>
            <Input className="col-span-6 sm:col-span-2" aria-label="Batch number" placeholder="Batch no." value={r.batchNo} onChange={(e) => patch(i, { batchNo: e.target.value })} />
            <Input className="col-span-6 sm:col-span-2" aria-label="Expiry date" type="date" value={r.expiryDate} onChange={(e) => patch(i, { expiryDate: e.target.value })} />
            <Input className="col-span-3 sm:col-span-1" aria-label="Quantity" placeholder="Qty" inputMode="numeric" value={r.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} />
            <Input className="col-span-3 sm:col-span-1" aria-label="MRP" placeholder="MRP" inputMode="decimal" value={r.mrp} onChange={(e) => patch(i, { mrp: e.target.value })} />
            <Input className="col-span-3 sm:col-span-1" aria-label="Purchase price" placeholder="Cost" inputMode="decimal" value={r.purchasePrice} onChange={(e) => patch(i, { purchasePrice: e.target.value })} />
            <Input className="col-span-3 sm:col-span-1" aria-label="Selling price" placeholder="Sell" inputMode="decimal" value={r.sellingPrice} onChange={(e) => patch(i, { sellingPrice: e.target.value })} />
            {rows.length > 1 && <button className="col-span-12 text-left text-xs text-slate-400 hover:text-red-700" onClick={() => setRows(rows.filter((_, j) => j !== i))}>remove line</button>}
          </div>
        ))}
        <Button variant="ghost" onClick={() => setRows([...rows, blankRow()])}>+ Add line</Button>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Receive stock</Button></div>
      </div>
    </Modal>
  );
}

function ReturnToSupplier({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const items = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([purchaseItemId, v]) => ({ purchaseItemId, quantity: Number(v) }));
  const ret = useMutation({
    mutationFn: () => api.post(`/pharmacy/purchases/${purchase.id}/returns`, { reason: reason.trim(), items }, key),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["purchases"] }); await qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); },
  });
  return (
    <Modal title={`Return to supplier — ${purchase.purchaseNumber}`} onClose={onClose} wide>
      <div className="space-y-3">
        <Table head={["Medicine", "Batch", "Bought", "Already returned", "Return now"]}>
          {purchase.items.map((i) => (
            <tr key={i.id}><Td>{i.medicineName}</Td><Td>{i.batchNo}</Td><Td>{i.quantity}</Td><Td>{i.returnedQuantity}</Td>
              <Td><Input aria-label={`Return quantity for ${i.medicineName}`} className="w-24" inputMode="numeric" value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></Td></tr>
          ))}
        </Table>
        <Field label="Reason" hint="At least 5 characters; recorded permanently."><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={ret.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={items.length === 0 || reason.trim().length < 5} loading={ret.isPending} onClick={() => ret.mutate()}>Return stock</Button></div>
      </div>
    </Modal>
  );
}

export function PurchasesTab() {
  const { can, money, dateTime } = useMe();
  const [adding, setAdding] = useState(false);
  const [returning, setReturning] = useState<Purchase | null>(null);
  const list = useQuery({ queryKey: ["purchases"], queryFn: () => api.page<Purchase>("/pharmacy/purchases", { pageSize: 50 }) });
  return (
    <Card title="Purchases" actions={can("PHARMACY_PURCHASE") ? <Button onClick={() => setAdding(true)}>Receive purchase</Button> : undefined}>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Purchase", "Supplier", "Supplier invoice", "Total", "Received", ""]} {...(list.data?.data.length === 0 ? { empty: "No purchases recorded." } : {})}>
          {list.data?.data.map((p) => (
            <tr key={p.id}>
              <Td>{p.purchaseNumber}<div className="text-xs text-slate-500">{p.items.length} line(s){p.returns.length ? ` · ${p.returns.length} return(s)` : ""}</div></Td><Td>{p.supplierName}</Td><Td>{p.supplierInvoiceNo}<div className="text-xs text-slate-500">{p.supplierInvoiceDate}</div></Td>
              <Td>{money(p.total)}</Td><Td>{dateTime(p.receivedAt)}</Td><Td>{can("PHARMACY_PURCHASE") && <Button variant="ghost" onClick={() => setReturning(p)}>Return…</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
      {adding && <NewPurchase onClose={() => setAdding(false)} />}
      {returning && <ReturnToSupplier purchase={returning} onClose={() => setReturning(null)} />}
    </Card>
  );
}

// ───────────────────────── stock adjustment ─────────────────────────

export function AdjustModal({ batch, onClose }: { batch: { id: string; label: string; quantity: number }; onClose: () => void }) {
  const qc = useQueryClient();
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [kind, setKind] = useState<"ADJUSTMENT" | "DAMAGE">("ADJUSTMENT");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const save = useMutation({
    mutationFn: () => api.post("/pharmacy/stock/adjustments", { batchId: batch.id, direction, kind, quantity: Number(quantity), reason: reason.trim() }, key),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); },
  });
  return (
    <Modal title={`Adjust stock — ${batch.label}`} onClose={onClose}>
      <div className="space-y-3">
        <Notice tone="warn">On hand now: {batch.quantity}. Adjustments are recorded in the stock ledger with your name and reason and cannot be undone, only corrected by another adjustment.</Notice>
        <div className="grid grid-cols-3 gap-2">
          <Select aria-label="Type" value={kind} onChange={(e) => { const k = e.target.value as "ADJUSTMENT" | "DAMAGE"; setKind(k); if (k === "DAMAGE") setDirection("OUT"); }}><option value="ADJUSTMENT">Count correction</option><option value="DAMAGE">Damaged / expired</option></Select>
          <Select aria-label="Direction" value={direction} disabled={kind === "DAMAGE"} onChange={(e) => setDirection(e.target.value as "IN" | "OUT")}><option value="OUT">Remove stock</option><option value="IN">Add stock</option></Select>
          <Input aria-label="Quantity" placeholder="Quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <Field label="Reason" hint="At least 5 characters"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!Number(quantity) || reason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate()}>Record adjustment</Button></div>
      </div>
    </Modal>
  );
}

// ───────────────────────── sales and patient returns ─────────────────────────

interface SaleItem { id: string; medicineName: string; batchNo: string | null; quantity: number; returnedQuantity: number; unitPrice: string }
interface Sale { id: string; dispenseNumber: string; status: string; patientName: string; mrn: string | null; total: string; dispensedAt: string; invoiceId: string | null; items: SaleItem[] }

function ReturnFromPatient({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const items = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([dispenseItemId, v]) => ({ dispenseItemId, quantity: Number(v) }));
  const ret = useMutation({ mutationFn: () => api.post(`/pharmacy/dispenses/${sale.id}/returns`, { reason: reason.trim(), items }, key), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["sales"] }); await qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); } });
  return (
    <Modal title={`Patient return — ${sale.dispenseNumber}`} onClose={onClose} wide>
      <div className="space-y-3">
        <Notice>Returned stock goes back on the shelf and the value is credited on the pharmacy bill. Refunding money is a separate cashier action.</Notice>
        <Table head={["Medicine", "Batch", "Sold", "Returned", "Return now"]}>
          {sale.items.map((i) => (
            <tr key={i.id}><Td>{i.medicineName}</Td><Td>{i.batchNo}</Td><Td>{i.quantity}</Td><Td>{i.returnedQuantity}</Td>
              <Td><Input aria-label={`Return quantity for ${i.medicineName}`} className="w-24" inputMode="numeric" value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></Td></tr>
          ))}
        </Table>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={ret.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={items.length === 0 || reason.trim().length < 5} loading={ret.isPending} onClick={() => ret.mutate()}>Accept return</Button></div>
      </div>
    </Modal>
  );
}

export function SalesTab() {
  const { can, money, dateTime } = useMe();
  const [returning, setReturning] = useState<Sale | null>(null);
  const list = useQuery({ queryKey: ["sales"], queryFn: () => api.page<Sale>("/pharmacy/dispenses", { pageSize: 50 }) });
  return (
    <Card title="Recent sales">
      {list.isLoading ? <Spinner /> : (
        <Table head={["Sale", "Patient", "Total", "When", "Status", ""]} {...(list.data?.data.length === 0 ? { empty: "Nothing dispensed yet." } : {})}>
          {list.data?.data.map((s) => (
            <tr key={s.id}>
              <Td>{s.dispenseNumber}</Td><Td>{s.patientName}<div className="text-xs text-slate-500">{s.mrn}</div></Td><Td>{money(s.total)}</Td><Td>{dateTime(s.dispensedAt)}</Td>
              <Td><Badge tone={s.status === "COMPLETED" ? "green" : "amber"}>{s.status.replace("_", " ").toLowerCase()}</Badge></Td>
              <Td>{can("PHARMACY_DISPENSE") && s.status !== "RETURNED" && <Button variant="ghost" onClick={() => setReturning(s)}>Return…</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
      {returning && <ReturnFromPatient sale={returning} onClose={() => setReturning(null)} />}
    </Card>
  );
}

// ───────────────────────── medicine master ─────────────────────────

const FORMS = ["TABLET", "CAPSULE", "SYRUP", "INJECTION", "OINTMENT", "DROPS", "INHALER", "SACHET", "OTHER"] as const;
interface Medicine { id: string; brandName: string; genericName: string; strength: string | null; dosageForm: string; manufacturer: string | null; hsnCode: string | null; gstPercent: string; reorderLevel: number; status: string }
type MedForm = { brandName: string; genericName: string; strength: string; dosageForm: string; manufacturer: string; hsnCode: string; gstPercent: string; reorderLevel: string };
const emptyMed: MedForm = { brandName: "", genericName: "", strength: "", dosageForm: "TABLET", manufacturer: "", hsnCode: "", gstPercent: "", reorderLevel: "" };

function MedicineModal({ medicine, onClose }: { medicine: Medicine | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<MedForm>(() => (medicine
    ? { brandName: medicine.brandName, genericName: medicine.genericName, strength: medicine.strength ?? "", dosageForm: medicine.dosageForm, manufacturer: medicine.manufacturer ?? "", hsnCode: medicine.hsnCode ?? "", gstPercent: medicine.gstPercent, reorderLevel: String(medicine.reorderLevel) }
    : emptyMed));
  const set = (k: keyof MedForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => {
      // Blank optional fields are left out when adding and cleared when editing.
      const opt = (v: string) => (v.trim() ? v.trim() : medicine ? null : undefined);
      const body = {
        brandName: f.brandName.trim(), genericName: f.genericName.trim(), dosageForm: f.dosageForm,
        strength: opt(f.strength), manufacturer: opt(f.manufacturer), hsnCode: opt(f.hsnCode),
        ...(f.gstPercent.trim() ? { gstPercent: f.gstPercent.trim() } : {}),
        ...(f.reorderLevel.trim() ? { reorderLevel: Number(f.reorderLevel) } : {}),
      };
      const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      return medicine ? api.patch(`/medicines/${medicine.id}`, clean) : api.post("/medicines", clean);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["medicine-master"] }); await qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); onClose(); },
  });
  return (
    <Modal title={medicine ? `Edit medicine — ${medicine.brandName}` : "Add a medicine"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Brand name"><Input value={f.brandName} onChange={set("brandName")} /></Field>
        <Field label="Generic name"><Input value={f.genericName} onChange={set("genericName")} /></Field>
        <Field label="Strength" hint="e.g. 500 mg"><Input value={f.strength} onChange={set("strength")} /></Field>
        <Field label="Form"><Select value={f.dosageForm} onChange={set("dosageForm")}>{FORMS.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}</Select></Field>
        <Field label="Manufacturer"><Input value={f.manufacturer} onChange={set("manufacturer")} /></Field>
        <Field label="HSN code" hint="4-8 digits"><Input inputMode="numeric" value={f.hsnCode} onChange={set("hsnCode")} /></Field>
        <Field label="GST %"><Input inputMode="decimal" value={f.gstPercent} onChange={set("gstPercent")} /></Field>
        <Field label="Reorder level" hint="Flagged as low stock below this"><Input inputMode="numeric" value={f.reorderLevel} onChange={set("reorderLevel")} /></Field>
        <div className="col-span-2"><ErrorNote error={save.error} /></div>
        <div className="col-span-2 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={f.brandName.trim().length < 2 || f.genericName.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>{medicine ? "Save changes" : "Add medicine"}</Button></div>
      </div>
    </Modal>
  );
}

export function MedicinesTab() {
  const { can } = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<Medicine | "new" | null>(null);
  const term = useDebounced(q.trim(), 250);
  const list = useQuery({ queryKey: ["medicine-master", term, inactive], queryFn: () => api.page<Medicine>("/medicines", { ...(term.length >= 2 ? { q: term } : {}), includeInactive: inactive ? "true" : "false", pageSize: 100 }) });
  const toggle = useMutation({ mutationFn: (m: Medicine) => api.patch(`/medicines/${m.id}`, { status: m.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["medicine-master"] }) });
  const masters = can("PHARMACY_MASTERS");
  return (
    <Card title="Medicines" actions={<>
      <Input placeholder="Search medicine" aria-label="Search medicines" className="w-48" value={q} onChange={(e) => setQ(e.target.value)} />
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show inactive</label>
      {masters && <Button onClick={() => setEditing("new")}>Add medicine</Button>}
    </>}>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Medicine", "Form", "GST %", "Reorder at", "Status", ""]} {...(list.data?.data.length === 0 ? { empty: "No medicines found." } : {})}>
          {list.data?.data.map((m) => (
            <tr key={m.id}>
              <Td><span className="font-medium">{m.brandName}</span> <span className="text-slate-500">{m.strength}</span><div className="text-xs text-slate-500">{m.genericName}{m.manufacturer ? ` · ${m.manufacturer}` : ""}</div></Td>
              <Td>{m.dosageForm.toLowerCase()}</Td><Td>{m.gstPercent}</Td><Td>{m.reorderLevel}</Td>
              <Td><Badge tone={m.status === "ACTIVE" ? "green" : "gray"}>{m.status.toLowerCase()}</Badge></Td>
              <Td>{masters && <div className="flex justify-end gap-1"><Button variant="ghost" onClick={() => setEditing(m)}>Edit</Button><Button variant="ghost" onClick={() => toggle.mutate(m)}>{m.status === "ACTIVE" ? "Deactivate" : "Activate"}</Button></div>}</Td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorNote error={toggle.error} />
      {editing && <MedicineModal medicine={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ───────────────────────── batch stock history (ledger) ─────────────────────────

interface LedgerRow { seq: string; type: string; direction: "IN" | "OUT"; quantity: number; balanceAfter: number; reason: string | null; createdAt: string }
interface Ledger { batch: { batchNo: string }; reconciliation: { balance: number; ledgerNet: number; reconciles: boolean }; items: LedgerRow[] }
const MOVEMENT: Record<string, string> = { PURCHASE: "Purchase", SALE: "Sale", PATIENT_RETURN: "Patient return", PURCHASE_RETURN: "Return to supplier", ADJUSTMENT: "Adjustment", DAMAGE: "Damaged / expired", TRANSFER: "Transfer" };

export function LedgerModal({ batch, onClose }: { batch: { id: string; label: string }; onClose: () => void }) {
  const { dateTime } = useMe();
  const led = useQuery({ queryKey: ["batch-ledger", batch.id], queryFn: () => api.get<Ledger>(`/pharmacy/batches/${batch.id}/ledger`, { pageSize: 200 }) });
  const r = led.data?.reconciliation;
  return (
    <Modal title={`Stock history — ${batch.label}`} onClose={onClose} wide>
      {led.isLoading ? <Spinner /> : led.error ? <ErrorNote error={led.error} /> : led.data && r && (
        <div className="space-y-3">
          <Notice tone={r.reconciles ? "success" : "error"}>{r.reconciles ? `On hand ${r.balance}, which matches the history below.` : `On hand ${r.balance} does not match the history (${r.ledgerNet}). Report this to the administrator.`}</Notice>
          <Table head={["When", "Movement", "In", "Out", "Balance", "Reason"]} {...(led.data.items.length === 0 ? { empty: "No movements yet." } : {})}>
            {led.data.items.map((row) => (
              <tr key={row.seq}><Td>{dateTime(row.createdAt)}</Td><Td>{MOVEMENT[row.type] ?? row.type}<div className="text-xs text-slate-500">{row.type}</div></Td>
                <Td>{row.direction === "IN" ? row.quantity : ""}</Td><Td>{row.direction === "OUT" ? row.quantity : ""}</Td><Td>{row.balanceAfter}</Td><Td>{row.reason ?? "—"}</Td></tr>
            ))}
          </Table>
        </div>
      )}
    </Modal>
  );
}
