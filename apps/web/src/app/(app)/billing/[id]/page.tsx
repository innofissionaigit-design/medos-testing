"use client";
import Link from "next/link";
import { T } from "@/lib/i18n";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UseAdvanceButton } from "@/components/advance-extras";
import { DoctorShareCard } from "@/components/doctor-share";
import { Gate } from "@/components/gate";
import { Button, Card, ConfirmButton, ErrorNote, Field, Input, KV, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Invoice {
  id: string; invoiceNumber: string | null; status: string; kind: string; patientId: string; patientName: string; mrn: string | null; notes: string | null; issuedAt: string | null;
  subtotal: string; discountTotal: string; taxTotal: string; taxSplit?: boolean; roundOff?: string; roundsToRupee?: boolean; cgstTotal?: string | null; sgstTotal?: string | null; total: string; paidTotal: string; refundedTotal: string; creditedTotal: string; netReceived: string; balanceDue: string; refundable: string;
  version: number; encounterId?: string | null;
  lines: { lineNo: number; serviceId?: string | null; description: string; quantity: string; unitPrice: string; discountAmount: string; taxPercent: string; cgstAmount?: string | null; sgstAmount?: string | null; lineTotal: string }[];
  receipts: { id: string; receiptNumber: string; total: string; receivedAt: string; payments: { method: string; amount: string; reference: string | null }[] }[];
  refunds: { id: string; refundNumber: string; method: string; amount: string; reason: string; createdAt: string }[];
  creditNotes: { id: string; creditNoteNumber: string; amount: string; reason: string }[];
}
const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
type Tender = { method: string; amount: string; reference: string };

function PayModal({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [rows, setRows] = useState<Tender[]>([{ method: "CASH", amount: inv.balanceDue, reference: "" }]);
  const [key] = useState(newKey);
  const sum = rows.reduce((n, r) => n + Math.round(Number(r.amount || 0) * 100), 0);
  const due = Math.round(Number(inv.balanceDue) * 100);
  const pay = useMutation({
    mutationFn: () => api.post(`/invoices/${inv.id}/payments`, { payments: rows.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: r.amount, ...(r.reference ? { reference: r.reference } : {}) })) }, key),
    onSuccess: onDone,
  });
  return (
    <Modal title={`Take payment — due ${money(inv.balanceDue)}`} onClose={onClose}>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select aria-label="Mode" className="col-span-4" value={r.method} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>{METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}</Select>
            <Input aria-label="Amount" className="col-span-3" inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <Input aria-label="Reference" className="col-span-4" placeholder={r.method === "CASH" ? "—" : "Reference"} disabled={r.method === "CASH"} value={r.reference} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
            {rows.length > 1 && <button className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setRows([...rows, { method: "UPI", amount: String(Math.max(0, due - sum) / 100), reference: "" }])}>+ Split payment</Button>
          <span className={`text-sm ${sum === due ? "text-green-700" : "text-amber-700"}`}>Entered {money(sum / 100)}</span>
        </div>
        <ErrorNote error={pay.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={sum <= 0 || sum > due} loading={pay.isPending} onClick={() => pay.mutate()}>Receive payment</Button></div>
      </div>
    </Modal>
  );
}

function Adjust({ inv, kind, onClose, onDone }: { inv: Invoice; kind: "refund" | "credit-notes"; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [key] = useState(newKey);
  // Money other than cash is paid back through a bank, UPI or card transaction, which has a reference the server asks for.
  const needsReference = kind === "refund" && method !== "CASH";
  const tooMuch = kind === "refund" && Number(amount) > Number(inv.refundable);
  const m = useMutation({
    mutationFn: () => api.post(`/invoices/${inv.id}/${kind === "refund" ? "refunds" : "credit-notes"}`, { amount, reason, ...(kind === "refund" ? { method, ...(reference.trim() ? { reference: reference.trim() } : {}) } : {}) }, key),
    onSuccess: onDone,
  });
  return (
    <Modal title={kind === "refund" ? `Refund — up to ${money(inv.refundable)}` : "Credit note"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Amount"><Input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {kind === "refund" && <Field label="Refund by"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((x) => <option key={x} value={x}>{x.replace("_", " ").toLowerCase()}</option>)}</Select></Field>}
        {needsReference && <Field label="Reference" hint="The transaction number of the money paid back (at least 4 characters)."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
        {tooMuch && <Notice tone="warn">More than the {money(inv.refundable)} that can be refunded.</Notice>}
        <Field label="Reason" hint="At least 5 characters; recorded permanently."><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button>{kind === "refund"
          ? <ConfirmButton label="Issue refund" confirmLabel={`Yes, refund ${money(amount || 0)}`} variant="danger" disabled={!Number(amount) || tooMuch || reason.trim().length < 5 || (needsReference && reference.trim().length < 4)} loading={m.isPending} onConfirm={() => m.mutate()} />
          : <Button variant="danger" disabled={!Number(amount) || reason.trim().length < 5} loading={m.isPending} onClick={() => m.mutate()}>Issue credit note</Button>}</div>
      </div>
    </Modal>
  );
}

/** An approver (INVOICE_DISCOUNT) sets per-line discounts on a draft; the server recomputes totals and audits the reason. */
function DiscountModal({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [amounts, setAmounts] = useState<Record<number, string>>(() => Object.fromEntries(inv.lines.map((l) => [l.lineNo, l.discountAmount])));
  const [reason, setReason] = useState("");
  const changed = inv.lines.filter((l) => (amounts[l.lineNo] ?? "").trim() !== "" && Number(amounts[l.lineNo]) !== Number(l.discountAmount));
  const save = useMutation({
    mutationFn: () => api.post(`/invoices/${inv.id}/discount`, { version: inv.version, reason: reason.trim(), lines: changed.map((l) => ({ lineNo: l.lineNo, discountAmount: amounts[l.lineNo]!.trim() })) }),
    onSuccess: onDone,
  });
  return (
    <Modal title="Give a discount" onClose={onClose} wide>
      <div className="space-y-3">
        <Table head={["#", "Item", "Amount", "Discount"]}>
          {inv.lines.map((l) => (
            <tr key={l.lineNo}><Td>{l.lineNo}</Td><Td>{l.description}</Td><Td>{money((Number(l.quantity) * Number(l.unitPrice)).toFixed(2))}</Td>
              <Td><Input aria-label={`Discount for line ${l.lineNo}`} className="w-28" inputMode="decimal" value={amounts[l.lineNo] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.lineNo]: e.target.value })} /></Td></tr>
          ))}
        </Table>
        <Field label="Reason" hint="At least 5 characters; recorded in the audit trail."><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <p className="text-sm text-slate-500">The new total is calculated by the server. A discount cannot be more than the line amount.</p>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={changed.length === 0 || reason.trim().length < 5} loading={save.isPending} onClick={() => save.mutate()}>Apply discount</Button></div>
      </div>
    </Modal>
  );
}

interface EditLine { serviceId?: string | null; description: string; unitPrice: string; taxPercent: string; quantity: string }

/** Draft bills can be changed freely; once issued they are locked (credit note, refund or cancel instead). */
function EditDraft({ inv, onClose, onDone }: { inv: Invoice; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [lines, setLines] = useState<EditLine[]>(inv.lines.map((l) => ({ serviceId: l.serviceId ?? null, description: l.description, unitPrice: l.unitPrice, taxPercent: l.taxPercent, quantity: l.quantity })));
  const [notes, setNotes] = useState(inv.notes ?? "");
  const [q, setQ] = useState("");
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<{ id: string; name: string; price: string; taxPercent: string }>("/services", { pageSize: 100 }) });
  const matches = (services.data?.data ?? []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const save = useMutation({
    mutationFn: () => api.put(`/invoices/${inv.id}`, {
      version: inv.version, notes: notes.trim() === "" ? null : notes.trim(),
      lines: lines.map((l) => (l.serviceId ? { serviceId: l.serviceId, quantity: l.quantity } : { description: l.description, unitPrice: l.unitPrice, taxPercent: l.taxPercent || "0", quantity: l.quantity })),
    }),
    onSuccess: onDone,
  });
  const patch = (i: number, p: Partial<EditLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Modal title="Edit draft bill" onClose={onClose} wide>
      <div className="space-y-3">
        <Table head={["Item", "Qty", "Rate", "Tax %", ""]}>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>{l.serviceId ? l.description : <Input aria-label="Description" value={l.description} onChange={(e) => patch(i, { description: e.target.value })} />}</Td>
              <Td><Input aria-label="Quantity" className="w-20" inputMode="decimal" value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} /></Td>
              <Td>{l.serviceId ? money(l.unitPrice) : <Input aria-label="Rate" className="w-24" inputMode="decimal" value={l.unitPrice} onChange={(e) => patch(i, { unitPrice: e.target.value })} />}</Td>
              <Td>{l.serviceId ? l.taxPercent : <Input aria-label="Tax percent" className="w-16" inputMode="decimal" value={l.taxPercent} onChange={(e) => patch(i, { taxPercent: e.target.value })} />}</Td>
              <Td><button aria-label="Remove line" className="text-slate-400 hover:text-red-700" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></Td>
            </tr>
          ))}
        </Table>
        <Field label="Add a service"><Input placeholder="Search price list…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-1.5">
          {matches.map((s) => <button key={s.id} className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-brand-50" onClick={() => setLines([...lines, { serviceId: s.id, description: s.name, unitPrice: s.price, taxPercent: s.taxPercent, quantity: "1" }])}>{s.name} · {money(s.price)}</button>)}
          <button className="rounded border border-dashed border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setLines([...lines, { description: "", unitPrice: "", taxPercent: "0", quantity: "1" }])}>+ Other charge</button>
        </div>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={lines.length === 0 || lines.some((l) => !l.description || !l.unitPrice)} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></div>
      </div>
    </Modal>
  );
}
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const [modal, setModal] = useState<"pay" | "refund" | "credit-notes" | "edit" | "discount" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  // Set when the bill was just created from the patient's page (reception): offer the next step, the OPD visit.
  const [fromPatient, setFromPatient] = useState(false);
  useEffect(() => { setFromPatient(new URLSearchParams(window.location.search).get("from") === "patient"); }, []);
  const inv = useQuery({ queryKey: ["invoice", id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });
  const refresh = async () => { setModal(null); await qc.invalidateQueries({ queryKey: ["invoice", id] }); await qc.invalidateQueries({ queryKey: ["invoices"] }); await qc.invalidateQueries({ queryKey: ["doctor-share"] }); };
  const issue = useMutation({ mutationFn: () => api.post(`/invoices/${id}/issue`), onSuccess: refresh });
  // "Email receipt": queues the receipt email to the patient when they have an address and have agreed (docs/email.md); says why when it cannot.
  const emailReceipt = useMutation({ mutationFn: () => api.post<{ queued: boolean; reason?: string }>(`/invoices/${id}/email-receipt`) });
  const notEmailed: Record<string, string> = { DISABLED: "Email is switched off (Administration → Email).", NO_ADDRESS: "This patient has no email address on file.", NO_CONSENT: "This patient has not agreed to be emailed.", SUPPRESSED: "This address is on the do-not-email list.", DUPLICATE: "This receipt was already emailed." };
  const [refundRefs, setRefundRefs] = useState<Record<string, string>>({});
  // What has to be given back to cancel a paid bill: whatever each method received and has not yet returned.
  const giveBack = (): { method: string; amount: string }[] => {
    const by = new Map<string, number>();
    for (const r of inv.data?.receipts ?? []) for (const p of r.payments) by.set(p.method, (by.get(p.method) ?? 0) + Number(p.amount));
    for (const r of inv.data?.refunds ?? []) by.set(r.method, (by.get(r.method) ?? 0) - Number(r.amount));
    return [...by.entries()].filter(([, v]) => v > 0.004).map(([method, v]) => ({ method, amount: v.toFixed(2) }));
  };
  const owed = giveBack();
  const refsMissing = owed.some((o) => o.method !== "CASH" && (refundRefs[o.method] ?? "").trim().length < 4);
  const cancel = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/cancel`, {
      reason: cancelReason.trim(),
      ...(Number(inv.data?.netReceived ?? 0) > 0 ? { refunds: owed.map((o) => ({ method: o.method, amount: o.amount, ...(o.method !== "CASH" ? { reference: (refundRefs[o.method] ?? "").trim() } : {}) })) } : {}),
    }),
    onSuccess: refresh,
  });
  if (inv.isLoading) return <Spinner />;
  if (inv.error || !inv.data) return <ErrorNote error={inv.error ?? new Error("Bill not found")} />;
  const i = inv.data;
  const live = ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status);
  return (
    <Gate anyOf={["INVOICE_READ"]}>
      <PageHeader
        title={i.invoiceNumber ?? "Draft bill"} subtitle={`${i.patientName} · MRN ${i.mrn ?? "—"} · ${i.kind.toLowerCase()}${i.issuedAt ? ` · issued ${dateTime(i.issuedAt)}` : ""}`}
        actions={<>
          <StatusBadge value={i.status} />
          <Link className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`/patients/${i.patientId}`}>Patient</Link>
          {i.status === "DRAFT" && can("INVOICE_CREATE") && <Button variant="secondary" onClick={() => setModal("edit")}>Edit items</Button>}
          {i.status === "DRAFT" && can("INVOICE_DISCOUNT") && <Button variant="secondary" onClick={() => setModal("discount")}>Discount…</Button>}
          {i.status === "DRAFT" && can("INVOICE_ISSUE") && <Button loading={issue.isPending} onClick={() => issue.mutate()}>Issue bill</Button>}
          {["ISSUED", "PARTIALLY_PAID"].includes(i.status) && can("PAYMENT_CREATE") && <Button onClick={() => setModal("pay")}>Take payment</Button>}
          {["ISSUED", "PARTIALLY_PAID"].includes(i.status) && <UseAdvanceButton patientId={i.patientId} invoiceId={i.id} balanceDue={i.balanceDue} onDone={refresh} />}
          {i.status !== "DRAFT" && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`invoices/${i.id}`)} target="_blank" rel="noreferrer">Print bill</a>}
          {i.status !== "DRAFT" && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`invoices/${i.id}`)}?format=pdf&download=1`}>PDF</a>}
          {Number(i.netReceived) > 0 && can("INVOICE_READ") && <Button variant="secondary" loading={emailReceipt.isPending} onClick={() => emailReceipt.mutate()}>Email receipt</Button>}
        </>}
      />
      {fromPatient && (
        <Notice tone="success">
          <span className="mr-3">Bill created for {i.patientName}.</span>
          {can("APPOINTMENT_CREATE") && <Link className="mr-3 inline-block rounded-md bg-brand-600 px-3 py-1 text-sm font-medium text-white hover:bg-brand-700" href={`/patients/${i.patientId}?visit=1`}>Start OPD visit</Link>}
          <Link className="text-sm font-medium underline" href={`/patients/${i.patientId}`}>Back to patient</Link>
        </Notice>
      )}
      <ErrorNote error={issue.error ?? cancel.error ?? emailReceipt.error} />
      {emailReceipt.data && <Notice tone={emailReceipt.data.queued ? "success" : "warn"}>{emailReceipt.data.queued ? "The receipt email is queued and will be sent shortly." : (notEmailed[emailReceipt.data.reason ?? ""] ?? "The receipt email was not queued.")}</Notice>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Items" className="lg:col-span-2">
          <Table head={i.taxSplit ? ["#", "Item", "Qty", "Rate", "Tax", "CGST", "SGST", "Amount"] : ["#", "Item", "Qty", "Rate", "Tax", "Amount"]}>
            {i.lines.map((l) => <tr key={l.lineNo}><Td>{l.lineNo}</Td><Td>{l.description}</Td><Td>{l.quantity}</Td><Td>{money(l.unitPrice)}</Td><Td>{l.taxPercent}%</Td>{i.taxSplit && <><Td>{money(l.cgstAmount ?? "0")}</Td><Td>{money(l.sgstAmount ?? "0")}</Td></>}<Td>{money(l.lineTotal)}</Td></tr>)}
          </Table>
          {i.notes && <p className="mt-2 text-sm text-slate-600">{i.notes}</p>}
        </Card>
        <Card title="Totals">
          <dl className="grid grid-cols-2 gap-3">
            <KV label="Subtotal">{money(i.subtotal)}</KV><KV label="Discount">{money(i.discountTotal)}</KV>{i.taxSplit ? <><KV label="CGST">{money(i.cgstTotal ?? "0")}</KV><KV label="SGST">{money(i.sgstTotal ?? "0")}</KV></> : <KV label="Tax">{money(i.taxTotal)}</KV>}{i.roundsToRupee && <KV label="Round off">{money(i.roundOff ?? "0")}</KV>}<KV label="Total"><b>{money(i.total)}</b></KV>
            <KV label="Received">{money(i.netReceived)}</KV><KV label="Balance due"><b className={Number(i.balanceDue) > 0 ? "text-red-700" : "text-green-700"}>{money(i.balanceDue)}</b></KV>
          </dl>
          {live && (
            <div className="mt-4 flex flex-wrap gap-2">
              {Number(i.refundable) > 0 && can("PAYMENT_REFUND") && <Button variant="secondary" onClick={() => setModal("refund")}>Refund…</Button>}
              {can("INVOICE_ADJUST") && Number(i.total) - Number(i.creditedTotal) > 0 && <Button variant="secondary" onClick={() => setModal("credit-notes")}>Credit note…</Button>}
            </div>
          )}
          {live && can("PAYMENT_REFUND") && Number(i.refundable) <= 0 && Number(i.netReceived) > 0 && <p className="mt-3 text-xs text-slate-500"><T>Nothing to refund yet: the patient has paid exactly what the bill says. A refund becomes possible after the Manager issues a credit note that lowers the bill below what was paid.</T></p>}
          {live && can("INVOICE_CANCEL") && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              <Input placeholder="Reason to cancel this bill (min 5 characters)" aria-label="Cancel reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              {Number(i.netReceived) > 0 && (
                <div className="space-y-2 rounded-md bg-amber-50 p-3 text-sm">
                  <div className="font-medium">Cancelling gives back everything received: {money(i.netReceived)}</div>
                  {!can("PAYMENT_REFUND") && <div className="text-red-700">You also need permission to refund money to cancel a paid bill.</div>}
                  {owed.map((o) => (
                    <div key={o.method} className="flex flex-wrap items-center gap-2">
                      <span className="w-44">{money(o.amount)} by {o.method.replace("_", " ").toLowerCase()}</span>
                      {o.method !== "CASH" && <Input aria-label={`Reference for ${o.method}`} placeholder="Transaction reference (min 4)" className="w-56" value={refundRefs[o.method] ?? ""} onChange={(e) => setRefundRefs({ ...refundRefs, [o.method]: e.target.value })} />}
                    </div>
                  ))}
                </div>
              )}
              <ConfirmButton label="Cancel bill" confirmLabel="Yes, cancel this bill" loading={cancel.isPending} disabled={cancelReason.trim().length < 5 || (Number(i.netReceived) > 0 && (!can("PAYMENT_REFUND") || refsMissing))} onConfirm={() => cancel.mutate()} />
            </div>
          )}
        </Card>
        <Card title="Receipts" className="lg:col-span-3">
          {i.receipts.length === 0 && i.refunds.length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : (
            <Table head={["Receipt", "When", "Paid by", "Amount", ""]}>
              {i.receipts.map((r) => (
                <tr key={r.id}><Td>{r.receiptNumber}</Td><Td>{dateTime(r.receivedAt)}</Td><Td>{r.payments.map((p) => `${p.method.toLowerCase().replace("_", " ")} ${money(p.amount)}`).join(" + ")}</Td><Td>{money(r.total)}</Td>
                  <Td><a className="text-brand-700 hover:underline" href={printUrl(`receipts/${r.id}`)} target="_blank" rel="noreferrer">Print</a> · <a className="text-brand-700 hover:underline" href={`${printUrl(`receipts/${r.id}`)}?format=pdf&download=1`}>PDF</a></Td></tr>
              ))}
              {i.refunds.map((r) => <tr key={r.id} className="bg-red-50"><Td>{r.refundNumber}</Td><Td>{dateTime(r.createdAt)}</Td><Td>Refund · {r.method.toLowerCase()} · {r.reason}</Td><Td>−{money(r.amount)}</Td><Td /></tr>)}
              {i.creditNotes.map((c) => <tr key={c.id} className="bg-amber-50"><Td>{c.creditNoteNumber}</Td><Td /><Td>Credit note · {c.reason}</Td><Td>−{money(c.amount)}</Td><Td /></tr>)}
            </Table>
          )}
        </Card>
        {i.encounterId && ["OPD", "IPD"].includes(i.kind) && i.status !== "DRAFT" && can("EARNINGS_CONFIGURE", "REPORT_READ", "REPORT_FINANCE") && <DoctorShareCard encounterId={i.encounterId} />}
      </div>
      {i.status === "DRAFT" && <div className="mt-3"><Notice>This bill is a draft. Issue it to take payment; an issued bill cannot be edited, only credited or cancelled.</Notice></div>}
      {modal === "edit" && <EditDraft inv={i} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === "discount" && <DiscountModal inv={i} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === "pay" && <PayModal inv={i} onClose={() => setModal(null)} onDone={refresh} />}
      {(modal === "refund" || modal === "credit-notes") && <Adjust inv={i} kind={modal} onClose={() => setModal(null)} onDone={refresh} />}
    </Gate>
  );
}
