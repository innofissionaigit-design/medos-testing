"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td, useDebounced } from "./ui";

interface Med { id: string; brandName: string; genericName: string; strength: string | null }
interface Loc { id: string; name: string; status: string }
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const ask = (text: string) => { const v = window.prompt(text); return v && v.trim().length >= 5 ? v.trim() : null; };
const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { REQUESTED: "amber", PARTIALLY_ISSUED: "blue", ISSUED: "green", REJECTED: "red", CANCELLED: "gray", RAISED: "amber", CREDITED: "green", OPEN: "amber", SUBMITTED: "blue", APPROVED: "green" };

function MedPicker({ value, onPick }: { value: Med | null; onPick: (m: Med | null) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["med-pick-extra", term], queryFn: () => api.page<Med>("/medicines", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) return <div className="flex items-center gap-2 text-sm"><span className="font-medium">{value.brandName} {value.strength}</span><button className="text-xs text-slate-400 hover:text-red-700" onClick={() => onPick(null)}>change</button></div>;
  return (
    <div className="relative">
      <Input aria-label="Medicine" placeholder="Search a medicine" value={q} onChange={(e) => setQ(e.target.value)} />
      {(res.data?.data.length ?? 0) > 0 && <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-slate-200 bg-white text-sm shadow">{res.data?.data.map((m) => <li key={m.id}><button className="block w-full px-2 py-1 text-left hover:bg-slate-50" onClick={() => { onPick(m); setQ(""); }}>{m.brandName} {m.strength} <span className="text-xs text-slate-500">{m.genericName}</span></button></li>)}</ul>}
    </div>
  );
}

// ───────────────────────── store requests ─────────────────────────

interface ReqLine { id: string; medicineId: string; medicine: string; quantity: number; issuedQuantity: number; pendingQuantity: number }
interface Req { id: string; requestNumber: string; status: string; location: string; note: string | null; requestedAt: string; requestedById: string; requestedBy: string | null; closeReason: string | null; items: ReqLine[] }
interface Batch { id: string; medicineId: string; batchNo: string; expiryDate: string; quantity: number; status: string; expired: boolean }

function NewRequest({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const locs = useQuery({ queryKey: ["xtra-locations"], queryFn: () => api.get<Loc[]>("/pharmacy/locations") });
  const [loc, setLoc] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<{ med: Med | null; qty: string }[]>([{ med: null, qty: "" }]);
  const save = useMutation({ mutationFn: () => api.post("/procurement/stock-requests", { locationId: loc, ...(note.trim() ? { note: note.trim() } : {}), items: rows.map((r) => ({ medicineId: r.med!.id, quantity: Number(r.qty) })) }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["stock-requests"] }); onClose(); } });
  const ready = !!loc && rows.every((r) => r.med && Number(r.qty) > 0);
  return (
    <Modal title="Ask the main store for stock" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Needed in"><Select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Choose a store…</option>{locs.data?.filter((l) => l.status === "ACTIVE").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
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
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Send request</Button></div>
      </div>
    </Modal>
  );
}

function IssueRequest({ req, onClose }: { req: Req; onClose: () => void }) {
  const qc = useQueryClient();
  const [pick, setPick] = useState<Record<string, { batchId: string; qty: string }>>({});
  const [key] = useState(newKey);
  const lines = req.items.filter((i) => i.pendingQuantity > 0);
  const batches = useQuery({ queryKey: ["issue-batches", req.id], queryFn: async () => { const out: Record<string, Batch[]> = {}; for (const l of lines) out[l.medicineId] = (await api.page<Batch>("/pharmacy/batches", { medicineId: l.medicineId, pageSize: 50 })).data.filter((b) => b.quantity > 0 && b.status === "ACTIVE" && !b.expired); return out; } });
  const save = useMutation({
    mutationFn: () => api.post(`/procurement/stock-requests/${req.id}/issue`, { items: lines.filter((l) => pick[l.id]?.batchId && Number(pick[l.id]?.qty) > 0).map((l) => ({ requestItemId: l.id, batchId: pick[l.id]!.batchId, quantity: Number(pick[l.id]!.qty) })) }, key),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["stock-requests"] }); onClose(); },
  });
  const any = lines.some((l) => pick[l.id]?.batchId && Number(pick[l.id]?.qty) > 0);
  return (
    <Modal title={`Issue ${req.requestNumber} to ${req.location}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        {batches.isLoading ? <Spinner /> : lines.map((l) => (
          <div key={l.id} className="grid grid-cols-12 items-center gap-2">
            <div className="col-span-5"><b>{l.medicine}</b><div className="text-xs text-slate-500">asked {l.quantity}, {l.pendingQuantity} still to issue</div></div>
            <Select className="col-span-5" aria-label="Batch" value={pick[l.id]?.batchId ?? ""} onChange={(e) => setPick({ ...pick, [l.id]: { batchId: e.target.value, qty: pick[l.id]?.qty ?? String(l.pendingQuantity) } })}><option value="">Choose a batch…</option>{(batches.data?.[l.medicineId] ?? []).map((b) => <option key={b.id} value={b.id}>{b.batchNo} · exp {b.expiryDate} · {b.quantity} in stock</option>)}</Select>
            <Input className="col-span-2" aria-label="Quantity" inputMode="numeric" value={pick[l.id]?.qty ?? ""} onChange={(e) => setPick({ ...pick, [l.id]: { batchId: pick[l.id]?.batchId ?? "", qty: e.target.value.replace(/[^0-9]/g, "") } })} />
          </div>
        ))}
        <p className="text-xs text-slate-500">Choose the earliest-expiring batch first. Leave a line empty to issue it later.</p>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!any} loading={save.isPending} onClick={() => save.mutate()}>Issue the stock</Button></div>
      </div>
    </Modal>
  );
}

export function StoreRequestsTab() {
  const { can, dateTime, me } = useMe();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [issuing, setIssuing] = useState<Req | null>(null);
  const list = useQuery({ queryKey: ["stock-requests"], queryFn: () => api.get<{ items: Req[]; total: number }>("/procurement/stock-requests", { pageSize: 50 }), refetchInterval: 30_000 });
  const step = useMutation({ mutationFn: (a: { id: string; path: string; reason: string }) => api.post(`/procurement/stock-requests/${a.id}/${a.path}`, { reason: a.reason }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["stock-requests"] }); } });
  const fulfils = can("PHARMACY_ADJUST_STOCK");
  return (
    <>
      <Card title="Stock requests" actions={can("STORES_INDENT") ? <Button onClick={() => setAdding(true)}>Ask the store for stock</Button> : undefined}>
        <p className="mb-2 text-sm text-slate-600">A ward or the OT asks the main store for stock it needs. The store issues it batch by batch, in one go or several. (To buy stock, raise an indent.)</p>
        <ErrorNote error={step.error} />
        {list.isLoading ? <Spinner /> : (
          <Table head={["Request", "For", "Asked", "Items", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No stock requests." } : {})}>
            {list.data?.items.map((r) => (
              <tr key={r.id}>
                <Td><b>{r.requestNumber}</b>{r.note && <div className="text-xs text-slate-500">{r.note}</div>}</Td><Td>{r.location}</Td><Td>{dateTime(r.requestedAt)}<div className="text-xs text-slate-500">{r.requestedBy}</div></Td>
                <Td>{r.items.map((i) => <div key={i.id} className="text-sm">{i.medicine}: {i.issuedQuantity}/{i.quantity}</div>)}</Td>
                <Td><Badge tone={TONE[r.status] ?? "gray"}>{label(r.status)}</Badge>{r.closeReason && <div className="text-xs text-slate-500">{r.closeReason}</div>}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {fulfils && ["REQUESTED", "PARTIALLY_ISSUED"].includes(r.status) && <Button onClick={() => setIssuing(r)}>Issue</Button>}
                    {fulfils && r.status === "REQUESTED" && <Button variant="secondary" onClick={() => { const why = ask("Why is the request turned down? (at least 5 characters)"); if (why) step.mutate({ id: r.id, path: "reject", reason: why }); }}>Turn down</Button>}
                    {["REQUESTED", "PARTIALLY_ISSUED"].includes(r.status) && (fulfils || r.requestedById === me?.id) && <Button variant="ghost" onClick={() => { const why = ask("Why is the rest cancelled? (at least 5 characters)"); if (why) step.mutate({ id: r.id, path: "cancel", reason: why }); }}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && <NewRequest onClose={() => setAdding(false)} />}
      {issuing && <IssueRequest req={issuing} onClose={() => setIssuing(null)} />}
    </>
  );
}

// ───────────────────────── supplier payables and debit notes ─────────────────────────

interface Payable { purchaseId: string; purchaseNumber: string; supplier: string; supplierInvoiceNo: string; supplierInvoiceDate: string; purchaseOrder: string | null; matched: string; invoiceTotal: string; returned: string; credited: string; creditAsked: string; paid: string; balance: string }
interface Note { id: string; noteNumber: string; purchaseNumber: string; supplier: string; amount: string; reason: string; status: string; createdAt: string; creditReference: string | null }

function PayModal({ row, onClose }: { row: Payable; onClose: () => void }) {
  const { money } = useMe();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(row.balance);
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [key] = useState(newKey);
  const save = useMutation({ mutationFn: () => api.post(`/procurement/payables/${row.purchaseId}/payments`, { amount, method, ...(reference.trim() ? { reference: reference.trim() } : {}) }, key), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payables"] }); onClose(); } });
  return (
    <Modal title={`Pay ${row.supplier}: invoice ${row.supplierInvoiceNo}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Invoice {money(row.invoiceTotal)}{Number(row.returned) > 0 ? ` · returned ${money(row.returned)}` : ""}{Number(row.credited) > 0 ? ` · credit agreed ${money(row.credited)}` : ""}{Number(row.paid) > 0 ? ` · paid ${money(row.paid)}` : ""} · <b>owing {money(row.balance)}</b></p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Amount"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
          <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{["BANK_TRANSFER", "UPI", "CARD", "CASH", "OTHER"].map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
          <Field label={method === "CASH" ? "Reference (optional)" : "Reference (UTR, cheque no.)"}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!amount || (method !== "CASH" && reference.trim().length < 4)} loading={save.isPending} onClick={() => save.mutate()}>Record payment</Button></div>
      </div>
    </Modal>
  );
}

/** One payment for a supplier's whole statement: an amount, spread over their oldest invoices first (or the exact amount per invoice). */
function StatementModal({ suppliers, onClose }: { suppliers: { supplierId: string; supplier: string; invoices: number; owed: string }[]; onClose: () => void }) {
  const { money } = useMe();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.supplierId ?? "");
  const owed = suppliers.find((s) => s.supplierId === supplierId)?.owed ?? "0";
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [key] = useState(newKey);
  const save = useMutation({
    mutationFn: () => api.post<{ total: string; payments: { purchaseNumber: string; amount: string }[] }>("/procurement/payables/statement-payments", { supplierId, amount, method, ...(reference.trim() ? { reference: reference.trim() } : {}) }, key),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["payables"] }); void qc.invalidateQueries({ queryKey: ["cost-ledger"] }); },
  });
  return (
    <Modal title="Pay a supplier's statement" onClose={onClose}>
      <div className="space-y-3 text-sm">
        {save.data ? (
          <>
            <p className="text-green-700">Paid {money(save.data.total)} across {save.data.payments.length} invoice(s), oldest first.</p>
            <ul className="text-xs text-slate-600">{save.data.payments.map((p) => <li key={p.purchaseNumber}>{p.purchaseNumber}: {money(p.amount)}</li>)}</ul>
            <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </>
        ) : (
          <>
            <Field label="Supplier"><Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setAmount(""); }}>{suppliers.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.supplier} · owed {money(s.owed)}</option>)}</Select></Field>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label={`Amount (up to ${money(owed)})`}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
              <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{["BANK_TRANSFER", "UPI", "CARD", "CASH", "OTHER"].map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select></Field>
              <Field label={method === "CASH" ? "Reference (optional)" : "Reference (UTR, cheque no.)"}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            </div>
            <ErrorNote error={save.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!supplierId || !amount || (method !== "CASH" && reference.trim().length < 4)} loading={save.isPending} onClick={() => save.mutate()}>Pay</Button></div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function PayablesTab() {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const [show, setShow] = useState("OPEN");
  const [paying, setPaying] = useState<Payable | null>(null);
  const [statement, setStatement] = useState(false);
  const list = useQuery({ queryKey: ["payables", show], queryFn: () => api.get<{ items: Payable[]; owedToSuppliers: string; bySupplier: { supplierId: string; supplier: string; invoices: number; owed: string }[] }>("/procurement/payables", { show, pageSize: 50 }) });
  const notes = useQuery({ queryKey: ["debit-notes"], queryFn: () => api.get<Note[]>("/procurement/debit-notes", { pageSize: 50 }) });
  const credit = useMutation({ mutationFn: (a: { id: string; reference: string }) => api.post(`/procurement/debit-notes/${a.id}/credit`, { reference: a.reference }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["debit-notes"] }); void qc.invalidateQueries({ queryKey: ["payables"] }); } });
  return (
    <>
      <Card title={`Owed to suppliers: ${list.data ? money(list.data.owedToSuppliers) : "…"}`} actions={<div className="flex items-center gap-2">{can("SUPPLIER_PAY") && (list.data?.bySupplier.length ?? 0) > 0 && <Button variant="secondary" onClick={() => setStatement(true)}>Pay a statement</Button>}<Select aria-label="Show" className="w-44" value={show} onChange={(e) => setShow(e.target.value)}><option value="OPEN">Still owing</option><option value="ALL">All invoices</option></Select></div>}>
        <p className="mb-2 text-sm text-slate-600">Each goods receipt is the supplier's invoice, matched to its purchase order when received. What is owed is the invoice, less goods returned, less credit the supplier has agreed for rejected goods, less what has been paid.</p>
        {(list.data?.bySupplier.length ?? 0) > 0 && <p className="mb-2 text-xs text-slate-600">{list.data?.bySupplier.map((s) => `${s.supplier}: ${money(s.owed)}`).join(" · ")}</p>}
        {list.isLoading ? <Spinner /> : (
          <Table head={["Invoice", "Supplier", "Order match", "Invoice", "Credit / returns", "Paid", "Owing", ""]} {...(list.data?.items.length === 0 ? { empty: "Nothing is owing." } : {})}>
            {list.data?.items.map((r) => (
              <tr key={r.purchaseId}>
                <Td><b>{r.supplierInvoiceNo}</b><div className="text-xs text-slate-500">{r.purchaseNumber} · {r.supplierInvoiceDate}</div></Td><Td>{r.supplier}</Td>
                <Td><Badge tone={r.purchaseOrder ? "green" : "gray"}>{r.matched}</Badge></Td>
                <Td>{money(r.invoiceTotal)}</Td><Td>{money(String(Number(r.returned) + Number(r.credited)))}{Number(r.creditAsked) > 0 && <div className="text-xs text-amber-700">{money(r.creditAsked)} asked</div>}</Td><Td>{money(r.paid)}</Td><Td className="font-medium">{money(r.balance)}</Td>
                <Td>{can("SUPPLIER_PAY") && Number(r.balance) > 0 && <Button onClick={() => setPaying(r)}>Pay</Button>}<a className="ml-2 text-xs text-brand-700" href={printUrl(`goods-receipts/${r.purchaseId}`)} target="_blank" rel="noreferrer">Goods receipt</a></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Debit notes: credit asked of suppliers for rejected goods">
        <ErrorNote error={credit.error} />
        <Table head={["Note", "Supplier", "Invoice", "Amount", "Status", ""]} {...(notes.data?.length === 0 ? { empty: "No debit notes." } : {})}>
          {notes.data?.map((n) => (
            <tr key={n.id}><Td><b>{n.noteNumber}</b><div className="text-xs text-slate-500">{n.reason}</div></Td><Td>{n.supplier}</Td><Td>{n.purchaseNumber}</Td><Td>{money(n.amount)}</Td>
              <Td><Badge tone={TONE[n.status] ?? "gray"}>{label(n.status)}</Badge>{n.creditReference && <div className="text-xs text-slate-500">ref {n.creditReference}</div>}</Td>
              <Td>{n.status === "RAISED" && (can("SUPPLIER_PAY") || can("PHARMACY_PURCHASE")) && <Button variant="secondary" onClick={() => { const r = window.prompt("The supplier's credit note or reference number"); if (r && r.trim().length >= 3) credit.mutate({ id: n.id, reference: r.trim() }); }}>Supplier agreed the credit</Button>}<a className="ml-2 text-xs text-brand-700" href={printUrl(`debit-notes/${n.id}`)} target="_blank" rel="noreferrer">Print</a></Td></tr>
          ))}
        </Table>
      </Card>
      {paying && <PayModal row={paying} onClose={() => setPaying(null)} />}
      {statement && list.data && <StatementModal suppliers={list.data.bySupplier} onClose={() => setStatement(false)} />}
    </>
  );
}

// ───────────────────────── stock counts ─────────────────────────

interface CountLine { id: string; medicine: string; batchNo: string; expiryDate: string; systemQuantity: number; countedQuantity: number | null; difference: number | null; reason: string | null }
interface Count { id: string; countNumber: string; status: string; location: string; startedAt: string; startedById: string; startedBy: string | null; decidedBy: string | null; decisionNote: string | null; lines: number; counted: number; withDifference: number; valueOfDifferences: string; items: CountLine[] }

function CountModal({ count, onClose }: { count: Count; onClose: () => void }) {
  const { money } = useMe();
  const qc = useQueryClient();
  const open = count.status === "OPEN";
  const [vals, setVals] = useState<Record<string, { counted: string; reason: string }>>(() => Object.fromEntries(count.items.map((i) => [i.id, { counted: i.countedQuantity === null ? "" : String(i.countedQuantity), reason: i.reason ?? "" }])));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["stock-counts"] }); };
  const save = useMutation({
    mutationFn: () => api.put(`/procurement/stock-counts/${count.id}/counts`, { items: count.items.filter((i) => vals[i.id]?.counted !== "").map((i) => ({ itemId: i.id, countedQuantity: Number(vals[i.id]!.counted), ...(vals[i.id]!.reason.trim() ? { reason: vals[i.id]!.reason.trim() } : {}) })) }),
    onSuccess: refresh,
  });
  const submit = useMutation({ mutationFn: () => api.post(`/procurement/stock-counts/${count.id}/submit`, {}), onSuccess: () => { refresh(); onClose(); } });
  const need = count.items.filter((i) => vals[i.id]?.counted !== "" && Number(vals[i.id]?.counted) !== i.systemQuantity && (vals[i.id]?.reason.trim().length ?? 0) < 5).length;
  return (
    <Modal title={`${count.countNumber}: ${count.location}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">{open ? "Enter what you find on the shelf for each batch. Where it differs from the system, say why." : `${count.counted} of ${count.lines} batches counted; ${count.withDifference} differ (${money(count.valueOfDifferences)} at cost).`}</p>
        <Table head={["Medicine", "Batch", "System", "Counted", "Difference", "Why it differs"]}>
          {count.items.map((i) => {
            const v = vals[i.id] ?? { counted: "", reason: "" };
            const diff = v.counted === "" ? null : Number(v.counted) - i.systemQuantity;
            return (
              <tr key={i.id}><Td>{i.medicine}</Td><Td>{i.batchNo}<div className="text-xs text-slate-500">exp {i.expiryDate}</div></Td><Td>{i.systemQuantity}</Td>
                <Td>{open ? <Input className="w-20" aria-label={`Counted ${i.batchNo}`} inputMode="numeric" value={v.counted} onChange={(e) => setVals({ ...vals, [i.id]: { ...v, counted: e.target.value.replace(/[^0-9]/g, "") } })} /> : i.countedQuantity}</Td>
                <Td className={diff ? "font-medium text-amber-800" : ""}>{open ? (diff === null ? "" : diff > 0 ? `+${diff}` : diff) : i.difference}</Td>
                <Td>{open ? (diff ? <Input aria-label={`Reason ${i.batchNo}`} placeholder="At least 5 characters" value={v.reason} onChange={(e) => setVals({ ...vals, [i.id]: { ...v, reason: e.target.value } })} /> : null) : i.reason}</Td></tr>
            );
          })}
        </Table>
        <ErrorNote error={save.error ?? submit.error} />
        {open && <div className="flex justify-end gap-2"><Button variant="secondary" disabled={need > 0} loading={save.isPending} onClick={() => save.mutate()}>Save counts</Button><Button disabled={need > 0 || count.items.some((i) => vals[i.id]?.counted === "")} loading={submit.isPending} onClick={() => { save.mutate(undefined, { onSuccess: () => submit.mutate() }); }}>Save and submit</Button></div>}
      </div>
    </Modal>
  );
}

export function StockCountsTab() {
  const { can, dateTime, me } = useMe();
  const qc = useQueryClient();
  const [locId, setLocId] = useState("");
  const [open, setOpen] = useState<Count | null>(null);
  const list = useQuery({ queryKey: ["stock-counts"], queryFn: () => api.get<{ items: Count[]; total: number }>("/procurement/stock-counts", { pageSize: 50 }) });
  const locs = useQuery({ queryKey: ["xtra-locations"], queryFn: () => api.get<Loc[]>("/pharmacy/locations"), retry: false });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["stock-counts"] }); };
  const start = useMutation({ mutationFn: () => api.post<Count>("/procurement/stock-counts", locId ? { locationId: locId } : {}), onSuccess: (c) => { refresh(); setOpen(c); } });
  const step = useMutation({ mutationFn: (a: { id: string; path: string; body?: Record<string, unknown> }) => api.post(`/procurement/stock-counts/${a.id}/${a.path}`, a.body ?? {}), onSuccess: refresh });
  return (
    <>
      <Card title="Stock counts" actions={can("STOCK_COUNT") ? <div className="flex gap-2"><Select aria-label="Place to count" className="w-48" value={locId} onChange={(e) => setLocId(e.target.value)}><option value="">Main store</option>{locs.data?.filter((l) => l.status === "ACTIVE").map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select><Button loading={start.isPending} onClick={() => start.mutate()}>Start a count</Button></div> : undefined}>
        <p className="mb-2 text-sm text-slate-600">A physical count of one place. The counters enter what they find; someone else approves; each difference is then posted as a stock adjustment with its reason.</p>
        <ErrorNote error={start.error ?? step.error} />
        {list.isLoading ? <Spinner /> : (
          <Table head={["Count", "Place", "Started", "Progress", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No counts yet." } : {})}>
            {list.data?.items.map((c) => (
              <tr key={c.id}>
                <Td><b>{c.countNumber}</b></Td><Td>{c.location}</Td><Td>{dateTime(c.startedAt)}<div className="text-xs text-slate-500">{c.startedBy}</div></Td>
                <Td>{c.counted}/{c.lines} counted{c.withDifference > 0 ? ` · ${c.withDifference} differ` : ""}</Td>
                <Td><Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge>{c.decidedBy && <div className="text-xs text-slate-500">{c.decidedBy}{c.decisionNote ? ` · ${c.decisionNote}` : ""}</div>}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="secondary" onClick={() => setOpen(c)}>{c.status === "OPEN" && can("STOCK_COUNT") ? "Count" : "View"}</Button>
                    {c.status === "SUBMITTED" && can("STOCK_COUNT_APPROVE") && c.startedById !== me?.id && <Button loading={step.isPending} onClick={() => step.mutate({ id: c.id, path: "approve" })}>Approve and post</Button>}
                    {["OPEN", "SUBMITTED"].includes(c.status) && (can("STOCK_COUNT") || can("STOCK_COUNT_APPROVE")) && <Button variant="ghost" onClick={() => { const r = ask("Why is this count cancelled? (at least 5 characters)"); if (r) step.mutate({ id: c.id, path: "cancel", body: { reason: r } }); }}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open && <CountModal count={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ───────────────────────── cost ledger ─────────────────────────

interface Ledger { from: string; to: string; accounts: { account: string; name: string; opening: string; debit: string; credit: string; closing: string }[]; totalDebit: string; totalCredit: string; balanced: boolean; consumptionByCostCentre: { costCentre: string; cost: string }[] }
interface LedgerEntries { items: { id: string; date: string; narration: string; lines: { account: string; name: string; costCentre: string | null; debit: string; credit: string }[] }[]; total: number }

/** The cost ledger (docs/procurement.md): what each stock and supplier event posted, where the cost of stock used went, and proof that debits equal credits. */
export function CostLedgerTab() {
  const { money, can } = useMe();
  const qc = useQueryClient();
  const rec = useQuery({ queryKey: ["cost-ledger-rec"], queryFn: () => api.get<{ stockHeldAtCost: string; ledgerStock: string; difference: string; reconciled: boolean }>("/procurement/cost-ledger/reconciliation") });
  const pending = useQuery({ queryKey: ["cost-ledger-pending"], queryFn: () => api.get<Record<string, number>>("/procurement/cost-ledger/backfill"), enabled: can("SUPPLIER_PAY", "ADMIN_SETTINGS") });
  const owing = Object.values(pending.data ?? {}).reduce((a, b) => a + b, 0);
  const fill = useMutation({ mutationFn: async () => { for (let i = 0; i < 50; i++) { const r = await api.post<{ done: boolean }>("/procurement/cost-ledger/backfill"); if (r.done) break; } }, onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["cost-ledger"] }); await qc.invalidateQueries({ queryKey: ["cost-ledger-entries"] }); await qc.invalidateQueries({ queryKey: ["cost-ledger-rec"] }); await qc.invalidateQueries({ queryKey: ["cost-ledger-pending"] }); } });
  const [days, setDays] = useState("30");
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (Number(days) - 1) * 86_400_000).toISOString().slice(0, 10);
  const bal = useQuery({ queryKey: ["cost-ledger", days], queryFn: () => api.get<Ledger>("/procurement/cost-ledger", { from, to }) });
  const entries = useQuery({ queryKey: ["cost-ledger-entries", days], queryFn: () => api.get<LedgerEntries>("/procurement/cost-ledger/entries", { from, to, pageSize: 30 }) });
  return (
    <>
      <Card title="Cost ledger" actions={<Select aria-label="Period" className="w-40" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></Select>}>
        <p className="mb-2 text-sm text-slate-600">Every purchase, return, supplier credit, supplier payment, sale, ward issue, adjustment and use of stock is posted here as it happens, with debits equal to credits. It is a cost ledger, not full accounts: it has no revenue or patient billing.</p>
        {rec.data && <p className="mb-2 text-sm"><Badge tone={rec.data.reconciled ? "green" : "amber"}>{rec.data.reconciled ? "agrees with the stock" : "does not agree with the stock yet"}</Badge> Stock held at cost {money(rec.data.stockHeldAtCost)} · in the ledger {money(rec.data.ledgerStock)}{!rec.data.reconciled && ` · difference ${money(rec.data.difference)}`}</p>}
        {owing > 0 && can("SUPPLIER_PAY", "ADMIN_SETTINGS") && <div className="mb-2 flex items-center gap-2 rounded-md bg-amber-50 p-2 text-sm"><span>{owing} earlier event(s) are not in the ledger yet.</span><Button variant="secondary" loading={fill.isPending} onClick={() => fill.mutate()}>Post earlier history</Button></div>}
        <ErrorNote error={fill.error} />
        {bal.isLoading ? <Spinner /> : bal.data && (
          <>
            <Table head={["Account", "Opening", "Debits", "Credits", "Closing"]}>
              {bal.data.accounts.map((a) => <tr key={a.account}><Td>{a.name}</Td><Td>{money(a.opening)}</Td><Td>{money(a.debit)}</Td><Td>{money(a.credit)}</Td><Td><b>{money(a.closing)}</b></Td></tr>)}
              <tr><Td><b>Total</b></Td><Td /><Td><b>{money(bal.data.totalDebit)}</b></Td><Td><b>{money(bal.data.totalCredit)}</b></Td><Td><Badge tone={bal.data.balanced ? "green" : "red"}>{bal.data.balanced ? "balanced" : "does not balance"}</Badge></Td></tr>
            </Table>
            {bal.data.consumptionByCostCentre.length > 0 && <p className="mt-2 text-sm">Cost of stock used, by place: {bal.data.consumptionByCostCentre.map((c) => `${c.costCentre} ${money(c.cost)}`).join(" · ")}</p>}
          </>
        )}
      </Card>
      <Card title="Entries">
        {entries.isLoading ? <Spinner /> : (
          <Table head={["Date", "What", "Lines"]} {...(entries.data?.items.length === 0 ? { empty: "No entries in this period." } : {})}>
            {entries.data?.items.map((e) => (
              <tr key={e.id}><Td>{e.date}</Td><Td>{e.narration}</Td><Td><div className="text-xs">{e.lines.map((l, i) => <div key={i}>{l.name}{l.costCentre ? ` (${l.costCentre})` : ""}: {Number(l.debit) > 0 ? `debit ${money(l.debit)}` : `credit ${money(l.credit)}`}</div>)}</div></Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
