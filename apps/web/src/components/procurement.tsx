"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td, Textarea, useDebounced } from "./ui";
import { PrintLink } from "@/components/print-link";

interface Med { id: string; brandName: string; genericName: string; strength: string | null }
interface Need { medicineId: string; medicine: string; reorderLevel: number; onHand: number; onOrder: number; onIndent: number; suggestedQuantity: number }
interface IndentLine { id: string; medicineId: string; medicine: string; quantity: number; orderedQuantity: number; note: string | null }
interface Indent { id: string; indentNumber: string; status: string; forLocation: string; note: string | null; requestedAt: string; requestedById: string; requestedBy: string | null; decidedBy: string | null; decisionNote: string | null; items: IndentLine[]; orders: { id: string; poNumber: string; status: string }[]; approvalsRequired: number; estimatedValue: string | null; firstApprovedBy: string | null; awaitingSecondApproval: boolean }
interface OrderLine { id: string; medicineId: string; medicine: string; quantity: number; receivedQuantity: number; pendingQuantity: number; rate: string; gstPercent: string; lineTotal: string }
interface Order { id: string; poNumber: string; status: string; supplierId: string; supplier: string; indentNumber: string | null; expectedOn: string | null; total: string; createdBy: string | null; approvedBy: string | null; secondApprovedBy: string | null; approvalsNeeded: 0 | 1 | 2; items: OrderLine[]; receipts: { id: string; purchaseNumber: string }[]; closeReason: string | null }
interface Supplier { id: string; name: string; status: string }
interface Loc { id: string; name: string; status: string }
interface LocStock { items: { batchId: string; brandName: string; strength: string | null; batchNo: string; expiryDate: string; quantity: number }[] }
interface Consumed { id: string; at: string; location: string; medicine: string; batchNo: string; quantity: number; kind: string; procedure: string | null; reason: string | null; billedToPatient: boolean; totalCost: string; by: string | null }

const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { DRAFT: "gray", SUBMITTED: "amber", APPROVED: "blue", REJECTED: "red", ORDERED: "green", CANCELLED: "gray", ISSUED: "blue", PARTIALLY_RECEIVED: "amber", RECEIVED: "green", CLOSED: "gray" };
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

function MedPicker({ value, onPick }: { value: Med | null; onPick: (m: Med | null) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["med-pick-proc", term], queryFn: () => api.page<Med>("/medicines", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) return <div className="flex items-center gap-2 text-sm"><span className="font-medium">{value.brandName} {value.strength}</span><button className="text-xs text-slate-400 hover:text-red-700" onClick={() => onPick(null)}>change</button></div>;
  return (
    <div className="relative">
      <Input aria-label="Medicine" placeholder="Search a medicine" value={q} onChange={(e) => setQ(e.target.value)} />
      {(res.data?.data.length ?? 0) > 0 && <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow">{res.data?.data.map((m) => <li key={m.id}><button className="block w-full px-2 py-1 text-left hover:bg-slate-50" onClick={() => { onPick(m); setQ(""); }}>{m.brandName} {m.strength} <span className="text-xs text-slate-500">{m.genericName}</span></button></li>)}</ul>}
    </div>
  );
}

// ───────────────────────── stock requirement ─────────────────────────

export function RequirementTab({ onIndent }: { onIndent: (lines: { med: Med; qty: string }[]) => void }) {
  const { can } = useMe();
  const q = useQuery({ queryKey: ["procurement-requirement"], queryFn: () => api.get<{ items: Need[]; total: number }>("/procurement/requirement"), refetchInterval: 60_000 });
  const [picked, setPicked] = useState<string[]>([]);
  const items = q.data?.items ?? [];
  return (
    <Card title={`Stock requirement (${q.data?.total ?? 0})`} actions={can("STORES_INDENT") ? <Button disabled={picked.length === 0} onClick={() => onIndent(items.filter((i) => picked.includes(i.medicineId)).map((i) => ({ med: { id: i.medicineId, brandName: i.medicine, genericName: "", strength: null }, qty: String(i.suggestedQuantity) })))}>Raise an indent for the ticked items</Button> : undefined}>
      <p className="mb-2 text-sm text-slate-600">Medicines whose stock (main store and every location) has fallen to the reorder level, counting what is already on order or on an indent. The suggestion tops the position up to twice the reorder level.</p>
      {q.isLoading ? <Spinner /> : (
        <Table head={["", "Medicine", "On hand", "On order", "On indent", "Reorder level", "Suggest ordering"]} {...(items.length === 0 ? { empty: "Nothing is short." } : {})}>
          {items.map((i) => (
            <tr key={i.medicineId}><Td><input type="checkbox" aria-label={`Select ${i.medicine}`} checked={picked.includes(i.medicineId)} onChange={(e) => setPicked(e.target.checked ? [...picked, i.medicineId] : picked.filter((x) => x !== i.medicineId))} /></Td>
              <Td className="font-medium">{i.medicine}</Td><Td>{i.onHand}</Td><Td>{i.onOrder}</Td><Td>{i.onIndent}</Td><Td>{i.reorderLevel}</Td><Td className="font-semibold">{i.suggestedQuantity}</Td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// ───────────────────────── indents ─────────────────────────

function NewIndent({ start, onClose }: { start: { med: Med; qty: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<{ med: Med | null; qty: string }[]>(start.length ? start : [{ med: null, qty: "" }]);
  const [note, setNote] = useState("");
  const [forLoc, setForLoc] = useState("");
  const locs = useQuery({ queryKey: ["proc-locations"], queryFn: () => api.get<Loc[]>("/pharmacy/locations"), retry: false });
  const save = useMutation({
    mutationFn: () => api.post("/procurement/indents", { ...(forLoc ? { forLocationId: forLoc } : {}), ...(note.trim() ? { note: note.trim() } : {}), items: rows.map((r) => ({ medicineId: r.med!.id, quantity: Number(r.qty) })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["indents"] }); void qc.invalidateQueries({ queryKey: ["procurement-requirement"] }); onClose(); },
  });
  const ready = rows.length > 0 && rows.every((r) => r.med && Number(r.qty) > 0);
  return (
    <Modal title="Raise an indent" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Needed for"><Select value={forLoc} onChange={(e) => setForLoc(e.target.value)}><option value="">Main store</option>{locs.data?.filter((l) => l.status === "ACTIVE").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <div className="col-span-8"><MedPicker value={r.med} onPick={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, med: m } : x)))} /></div>
            <Input className="col-span-3" aria-label="Quantity" placeholder="Qty" inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^0-9]/g, "") } : x)))} />
            {rows.length > 1 && <button className="col-span-1 text-xs text-slate-400 hover:text-red-700" onClick={() => setRows(rows.filter((_, j) => j !== i))}>remove</button>}
          </div>
        ))}
        <Button variant="ghost" onClick={() => setRows([...rows, { med: null, qty: "" }])}>+ Add a medicine</Button>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Save as draft</Button></div>
      </div>
    </Modal>
  );
}

function NewOrder({ indent, onClose }: { indent: Indent | null; onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["proc-suppliers"], queryFn: () => api.get<Supplier[]>("/pharmacy/suppliers") });
  const [supplierId, setSupplierId] = useState("");
  const [expected, setExpected] = useState("");
  const [rows, setRows] = useState<{ med: Med | null; qty: string; rate: string; indentItemId?: string }[]>(indent ? indent.items.filter((i) => i.quantity > i.orderedQuantity).map((i) => ({ med: { id: i.medicineId, brandName: i.medicine, genericName: "", strength: null }, qty: String(i.quantity - i.orderedQuantity), rate: "", indentItemId: i.id })) : [{ med: null, qty: "", rate: "" }]);
  const save = useMutation({
    mutationFn: () => api.post("/procurement/orders", { supplierId, ...(indent ? { indentId: indent.id } : {}), ...(expected ? { expectedOn: expected } : {}), items: rows.map((r) => ({ medicineId: r.med!.id, quantity: Number(r.qty), rate: r.rate, ...(r.indentItemId ? { indentItemId: r.indentItemId } : {}) })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["orders"] }); void qc.invalidateQueries({ queryKey: ["indents"] }); void qc.invalidateQueries({ queryKey: ["procurement-requirement"] }); onClose(); },
  });
  const ready = !!supplierId && rows.length > 0 && rows.every((r) => r.med && Number(r.qty) > 0 && r.rate !== "");
  return (
    <Modal title={indent ? `Purchase order for ${indent.indentNumber}` : "New purchase order"} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose…</option>{suppliers.data?.filter((s) => s.status === "ACTIVE").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Expected on (optional)"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <div className="col-span-6">{indent ? <span className="text-sm font-medium">{r.med?.brandName}</span> : <MedPicker value={r.med} onPick={(m) => setRows(rows.map((x, j) => (j === i ? { ...x, med: m } : x)))} />}</div>
            <Input className="col-span-3" aria-label="Quantity" placeholder="Qty" inputMode="numeric" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^0-9]/g, "") } : x)))} />
            <Input className="col-span-3" aria-label="Rate" placeholder="Rate (₹)" inputMode="decimal" value={r.rate} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(/[^0-9.]/g, "") } : x)))} />
          </div>
        ))}
        {!indent && <Button variant="ghost" onClick={() => setRows([...rows, { med: null, qty: "", rate: "" }])}>+ Add a medicine</Button>}
        <p className="text-xs text-slate-500">The rate is the price per unit before GST. A delivery can later be received at no more than this rate.</p>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Create order</Button></div>
      </div>
    </Modal>
  );
}

export function IndentsTab({ start, onStartUsed }: { start: { med: Med; qty: string }[] | null; onStartUsed: () => void }) {
  const { can, dateTime, money } = useMe();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState<Indent | null>(null);
  const list = useQuery({ queryKey: ["indents", status], queryFn: () => api.get<{ items: Indent[]; total: number }>("/procurement/indents", { ...(status ? { status } : {}), pageSize: 50 }) });
  const done = () => { void qc.invalidateQueries({ queryKey: ["indents"] }); void qc.invalidateQueries({ queryKey: ["procurement-requirement"] }); };
  const step = useMutation({ mutationFn: (a: { id: string; path: string; body?: Record<string, unknown> }) => api.post(`/procurement/indents/${a.id}/${a.path}`, a.body ?? {}), onSuccess: done });
  const me = useMe().me;
  const ask = (text: string) => { const v = window.prompt(text); return v && v.trim().length >= 5 ? v.trim() : null; };
  return (
    <>
      <Card title="Indents" actions={<div className="flex gap-2"><Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "ORDERED", "CANCELLED"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>{can("STORES_INDENT") && <Button onClick={() => setAdding(true)}>Raise an indent</Button>}</div>}>
        <ErrorNote error={step.error} />
        {list.isLoading ? <Spinner /> : (
          <Table head={["Indent", "For", "Asked", "Items", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No indents." } : {})}>
            {list.data?.items.map((i) => (
              <tr key={i.id} data-testid="indent-row">
                <Td><b>{i.indentNumber}</b>{i.note && <div className="text-xs text-slate-500">{i.note}</div>}{i.estimatedValue && Number(i.estimatedValue) > 0 && <div className="text-xs text-slate-500">about {money(i.estimatedValue)}{i.approvalsRequired === 2 ? ` · needs two approvers${i.firstApprovedBy ? `, first: ${i.firstApprovedBy}` : ""}` : ""}</div>}</Td>
                <Td>{i.forLocation}</Td>
                <Td>{dateTime(i.requestedAt)}<div className="text-xs text-slate-500">{i.requestedBy}</div></Td>
                <Td>{i.items.map((x) => <div key={x.id} className="text-sm">{x.medicine} × {x.quantity}{x.orderedQuantity > 0 ? <span className="text-xs text-slate-500"> ({x.orderedQuantity} ordered)</span> : null}</div>)}</Td>
                <Td><Badge tone={TONE[i.status] ?? "gray"}>{label(i.status)}</Badge>{i.decidedBy && <div className="text-xs text-slate-500">{i.decidedBy}{i.decisionNote ? ` · ${i.decisionNote}` : ""}</div>}{i.orders.map((o) => <div key={o.id} className="text-xs text-slate-500">{o.poNumber}</div>)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {i.status === "DRAFT" && i.requestedById === me?.id && <Button variant="secondary" loading={step.isPending} onClick={() => step.mutate({ id: i.id, path: "submit" })}>Submit</Button>}
                    {i.status === "SUBMITTED" && can("PURCHASE_APPROVE") && i.requestedById !== me?.id && <><Button loading={step.isPending} disabled={i.awaitingSecondApproval && i.firstApprovedBy === me?.fullName} onClick={() => step.mutate({ id: i.id, path: "approve" })}>{i.approvalsRequired === 2 ? (i.awaitingSecondApproval ? "Second approval" : "First approval") : "Approve"}</Button><Button variant="secondary" onClick={() => { const r = ask("Why is this indent rejected? (at least 5 characters)"); if (r) step.mutate({ id: i.id, path: "reject", body: { reason: r } }); }}>Reject</Button></>}
                    {i.status === "APPROVED" && can("PURCHASE_ORDER") && <Button onClick={() => setOrdering(i)}>Make a purchase order</Button>}
                    {["DRAFT", "SUBMITTED", "APPROVED"].includes(i.status) && (i.requestedById === me?.id || can("PURCHASE_ORDER") || can("PURCHASE_APPROVE")) && <Button variant="ghost" onClick={() => { const r = ask("Why is this indent cancelled? (at least 5 characters)"); if (r) step.mutate({ id: i.id, path: "cancel", body: { reason: r } }); }}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {(adding || start) && <NewIndent start={start ?? []} onClose={() => { setAdding(false); onStartUsed(); }} />}
      {ordering && <NewOrder indent={ordering} onClose={() => setOrdering(null)} />}
    </>
  );
}

// ───────────────────────── purchase orders ─────────────────────────

export function OrdersTab() {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["orders"], queryFn: () => api.get<{ items: Order[]; total: number }>("/procurement/orders", { pageSize: 50 }) });
  const done = () => { void qc.invalidateQueries({ queryKey: ["orders"] }); void qc.invalidateQueries({ queryKey: ["indents"] }); void qc.invalidateQueries({ queryKey: ["open-orders"] }); };
  const step = useMutation({ mutationFn: (a: { id: string; path: string; body?: Record<string, unknown> }) => api.post(`/procurement/orders/${a.id}/${a.path}`, a.body ?? {}), onSuccess: done });
  const ask = (text: string) => { const v = window.prompt(text); return v && v.trim().length >= 5 ? v.trim() : null; };
  return (
    <>
      <Card title="Purchase orders" actions={can("PURCHASE_ORDER") ? <Button onClick={() => setAdding(true)}>New purchase order</Button> : undefined}>
        <p className="mb-2 text-sm text-slate-600">Goods are received against an issued order on the Pharmacy page (Purchases → Receive purchase), with the quantity and quality check.</p>
        <ErrorNote error={step.error} />
        {list.isLoading ? <Spinner /> : (
          <Table head={["Order", "Supplier", "Value", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No purchase orders." } : {})}>
            {list.data?.items.flatMap((o) => [
              <tr key={o.id} data-testid="order-row">
                <Td><button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen(open === o.id ? null : o.id)}>{o.poNumber}</button>{o.indentNumber && <div className="text-xs text-slate-500">from {o.indentNumber}</div>}</Td>
                <Td>{o.supplier}{o.expectedOn && <div className="text-xs text-slate-500">expected {o.expectedOn}</div>}</Td>
                <Td>{money(o.total)}</Td>
                <Td><Badge tone={TONE[o.status] ?? "gray"}>{label(o.status)}</Badge>{o.approvedBy && <div className="text-xs text-slate-500">approved by {o.approvedBy}{o.secondApprovedBy ? ` and ${o.secondApprovedBy}` : ""}</div>}{o.status === "DRAFT" && o.approvalsNeeded > 0 && <div className="text-xs text-amber-700">{o.approvalsNeeded === 2 ? (o.approvedBy ? "needs a second person to issue it" : "needs two approvals") : "needs an approver to issue it"}</div>}{o.closeReason && <div className="text-xs text-slate-500">{o.closeReason}</div>}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {o.status === "DRAFT" && o.approvalsNeeded === 2 && !o.approvedBy && can("PURCHASE_APPROVE") && <Button variant="secondary" loading={step.isPending} onClick={() => step.mutate({ id: o.id, path: "approve" })}>Approve</Button>}
                    {o.status === "DRAFT" && (can("PURCHASE_ORDER") || can("PURCHASE_APPROVE")) && <Button loading={step.isPending} onClick={() => step.mutate({ id: o.id, path: "issue" })}>Issue to supplier</Button>}
                    <PrintLink className="self-center text-xs text-brand-700" href={printUrl(`purchase-orders/${o.id}`)}>Print</PrintLink>
                    {["DRAFT", "ISSUED"].includes(o.status) && can("PURCHASE_ORDER") && o.receipts.length === 0 && <Button variant="ghost" onClick={() => { const r = ask("Why is this order cancelled? (at least 5 characters)"); if (r) step.mutate({ id: o.id, path: "cancel", body: { reason: r } }); }}>Cancel</Button>}
                    {["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status) && can("PURCHASE_ORDER") && <Button variant="ghost" onClick={() => { const r = ask("Why is this order closed before everything arrived? (at least 5 characters)"); if (r) step.mutate({ id: o.id, path: "close", body: { reason: r } }); }}>Close short</Button>}
                  </div>
                </Td>
              </tr>,
              ...(open === o.id ? [<tr key={`${o.id}-lines`}><td colSpan={5} className="bg-slate-50 px-3 py-2"><Table head={["Medicine", "Ordered", "Received", "Still expected", "Rate"]}>{o.items.map((x) => <tr key={x.id}><Td>{x.medicine}</Td><Td>{x.quantity}</Td><Td>{x.receivedQuantity}</Td><Td>{x.pendingQuantity}</Td><Td>{money(x.rate)}</Td></tr>)}</Table>{o.receipts.length > 0 && <p className="mt-1 text-xs text-slate-500">Goods receipts: {o.receipts.map((r) => r.purchaseNumber).join(", ")}</p>}</td></tr>] : []),
            ])}
          </Table>
        )}
      </Card>
      {adding && <NewOrder indent={null} onClose={() => setAdding(false)} />}
    </>
  );
}

// ───────────────────────── consumption ─────────────────────────

export function ConsumptionTab() {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const [loc, setLoc] = useState("");
  const [batch, setBatch] = useState("");
  const [kind, setKind] = useState<"PROCEDURE" | "DEPARTMENT_USE">("PROCEDURE");
  const [procedureId, setProcedureId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [bill, setBill] = useState(false);
  const locs = useQuery({ queryKey: ["proc-locations"], queryFn: () => api.get<Loc[]>("/pharmacy/locations"), retry: false });
  const stock = useQuery({ queryKey: ["proc-loc-stock", loc], queryFn: () => api.get<LocStock>(`/pharmacy/locations/${loc}/stock`), enabled: !!loc });
  const procs = useQuery({ queryKey: ["open-procedures"], queryFn: () => api.get<{ id: string; name: string; admissionNumber: string; status: string }[]>("/procurement/consumption/procedures"), enabled: can("STOCK_CONSUME") });
  const list = useQuery({ queryKey: ["consumption"], queryFn: () => api.get<Consumed[]>("/procurement/consumption", { pageSize: 50 }) });
  const [key, setKey] = useState(newKey);
  const save = useMutation({
    mutationFn: () => api.post("/procurement/consumption", { locationId: loc, batchId: batch, quantity: Number(qty), kind, ...(kind === "PROCEDURE" ? { procedureId, ...(bill ? { billToPatient: true } : {}) } : { reason: reason.trim() }) }, key),
    onSuccess: () => { setQty(""); setReason(""); setKey(newKey()); void qc.invalidateQueries({ queryKey: ["consumption"] }); void qc.invalidateQueries({ queryKey: ["proc-loc-stock", loc] }); },
  });
  const ready = !!loc && !!batch && Number(qty) > 0 && (kind === "PROCEDURE" ? !!procedureId : reason.trim().length >= 5);
  return (
    <Card title="Used in the OT and departments">
      <p className="mb-2 text-sm text-slate-600">Record stock used up from a location: for a patient's procedure, or a department's own use. The batch's purchase price is posted as the cost.</p>
      {can("STOCK_CONSUME") && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="From"><Select value={loc} onChange={(e) => { setLoc(e.target.value); setBatch(""); }}><option value="">Choose a store…</option>{locs.data?.filter((l) => l.status === "ACTIVE").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <Field label="Batch"><Select value={batch} onChange={(e) => setBatch(e.target.value)}><option value="">Choose…</option>{stock.data?.items.map((i) => <option key={i.batchId} value={i.batchId}>{i.brandName} {i.strength} · {i.batchNo} · {i.quantity} in stock</option>)}</Select></Field>
          <Field label="Quantity"><Input className="w-24" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))} /></Field>
          <Field label="Used for"><Select value={kind} onChange={(e) => setKind(e.target.value as "PROCEDURE" | "DEPARTMENT_USE")}><option value="PROCEDURE">A procedure</option><option value="DEPARTMENT_USE">The department's own use</option></Select></Field>
          {kind === "PROCEDURE" ? <Field label="Procedure"><Select value={procedureId} onChange={(e) => setProcedureId(e.target.value)}><option value="">Choose…</option>{procs.data?.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.admissionNumber}</option>)}</Select></Field> : <Field label="What for (at least 5 characters)"><Textarea rows={1} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          {kind === "PROCEDURE" && <label className="flex items-center gap-1 pb-2 text-sm"><input type="checkbox" checked={bill} onChange={(e) => setBill(e.target.checked)} />Bill the patient for it</label>}
          <Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Record use</Button>
        </div>
      )}
      <ErrorNote error={save.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["When", "Store", "Medicine", "Used for", "Cost", "By"]} {...(list.data?.length === 0 ? { empty: "Nothing recorded yet." } : {})}>
          {list.data?.map((c) => <tr key={c.id}><Td>{dateTime(c.at)}</Td><Td>{c.location}</Td><Td>{c.medicine}<div className="text-xs text-slate-500">batch {c.batchNo} × {c.quantity}</div></Td><Td>{c.procedure ?? c.reason}{c.billedToPatient && <div className="text-xs text-slate-500">billed to the patient</div>}</Td><Td className="font-medium">{money(c.totalCost)}</Td><Td>{c.by}</Td></tr>)}
        </Table>
      )}
    </Card>
  );
}
