"use client";
import { useState } from "react";
import { T } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td } from "@/components/ui";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
interface Advance {
  id: string; receiptNumber: string; receivedAt: string; note: string | null; amount: string; used: string; refunded: string; balance: string;
  tenders: { method: string; amount: string; reference: string | null }[];
}
interface AdvanceList { balance: string; items: Advance[] }
const label = (m: string) => m.replace("_", " ").toLowerCase();

/** What the patient has paid in advance and not yet used, with a way to take more or give some back. */
export function AdvanceCard({ patientId }: { patientId: string }) {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["advances", patientId], queryFn: () => api.get<AdvanceList>(`/patients/${patientId}/advances`), enabled: can("INVOICE_READ") });
  const [taking, setTaking] = useState(false);
  const [giving, setGiving] = useState<Advance | null>(null);
  const refresh = async () => { setTaking(false); setGiving(null); await qc.invalidateQueries({ queryKey: ["advances", patientId] }); };
  if (!can("INVOICE_READ")) return null;
  return (
    <Card title="Advance payments" actions={can("PAYMENT_CREATE") ? <Button variant="secondary" onClick={() => setTaking(true)}>Take an advance</Button> : undefined}>
      {q.isLoading ? <Spinner /> : !q.data || q.data.items.length === 0 ? <p className="text-sm text-slate-500"><T>No advance taken.</T></p> : (
        <>
          <p className="mb-2 text-sm">Available to use: <b>{money(q.data.balance)}</b></p>
          <Table head={["Receipt", "Date", "Paid in", "Left", ""]}>
            {q.data.items.map((a) => (
              <tr key={a.id}>
                <Td>{a.receiptNumber}</Td><Td>{dateTime(a.receivedAt)}</Td>
                <Td>{a.tenders.map((t) => `${label(t.method)} ${money(t.amount)}`).join(" + ")}</Td><Td>{money(a.balance)}</Td>
                <Td>
                  <a className="text-sm text-brand-700 hover:underline" href={printUrl(`advance-receipts/${a.id}`)} target="_blank" rel="noreferrer">Print receipt</a>
                  {can("PAYMENT_REFUND") && Number(a.balance) > 0 && <Button variant="ghost" onClick={() => setGiving(a)}>Give back…</Button>}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {taking && <TakeModal patientId={patientId} onClose={() => setTaking(false)} onDone={refresh} />}
      {giving && <GiveBackModal advance={giving} onClose={() => setGiving(null)} onDone={refresh} />}
    </Card>
  );
}

function TakeModal({ patientId, onClose, onDone }: { patientId: string; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [rows, setRows] = useState([{ method: "CASH", amount: "", reference: "" }]);
  const [note, setNote] = useState("");
  const [key] = useState(newKey);
  const sum = rows.reduce((n, r) => n + Math.round(Number(r.amount || 0) * 100), 0);
  const take = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/advances`, { tenders: rows.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: r.amount, ...(r.reference ? { reference: r.reference } : {}) })), ...(note.trim() ? { note: note.trim() } : {}) }, key),
    onSuccess: onDone,
  });
  return (
    <Modal title="Take an advance" onClose={onClose}>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select aria-label="Mode" className="col-span-4" value={r.method} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select>
            <Input aria-label="Amount" className="col-span-3" inputMode="decimal" placeholder="Amount" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <Input aria-label="Reference" className="col-span-4" placeholder={r.method === "CASH" ? "—" : "Reference"} disabled={r.method === "CASH"} value={r.reference} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
            {rows.length > 1 && <button className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>}
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setRows([...rows, { method: "UPI", amount: "", reference: "" }])}>+ Split payment</Button>
          <span className="text-sm text-slate-600">Total {money(sum / 100)}</span>
        </div>
        <Field label="Note (optional)"><Input value={note} maxLength={240} onChange={(e) => setNote(e.target.value)} placeholder="For example: planned surgery" /></Field>
        <p className="text-xs text-slate-500">This money stays the patient’s until it is used against a bill; the unused part can be given back.</p>
        <ErrorNote error={take.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={sum <= 0} loading={take.isPending} onClick={() => take.mutate()}>Receive advance</Button></div>
      </div>
    </Modal>
  );
}

export function GiveBackModal({ advance, onClose, onDone }: { advance: Advance; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [f, setF] = useState({ method: advance.tenders[0]?.method ?? "CASH", amount: advance.balance, reason: "", reference: "" });
  const [key] = useState(newKey);
  const give = useMutation({
    mutationFn: () => api.post(`/advances/${advance.id}/refunds`, { method: f.method, amount: f.amount, reason: f.reason.trim(), ...(f.reference ? { reference: f.reference } : {}) }, key),
    onSuccess: onDone,
  });
  return (
    <Modal title={`Give back — ${money(advance.balance)} left`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Select aria-label="Mode" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select>
          <Input aria-label="Amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <Input aria-label="Reference" placeholder={f.method === "CASH" ? "—" : "Reference"} disabled={f.method === "CASH"} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </div>
        <Field label="Reason"><Input value={f.reason} maxLength={240} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="At least 5 characters" /></Field>
        <ErrorNote error={give.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={f.reason.trim().length < 5 || Number(f.amount) <= 0} loading={give.isPending} onClick={() => give.mutate()}>Give back</Button></div>
      </div>
    </Modal>
  );
}

/** Give back part or all of one advance, loaded by its id (for example the booking fee of a cancelled appointment). */
export function GiveBackDeposit({ depositId, onClose, onDone }: { depositId: string; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ["advance", depositId], queryFn: () => api.get<Advance>(`/advances/${depositId}`) });
  if (!q.data) return null;
  return <GiveBackModal advance={q.data} onClose={onClose} onDone={onDone} />;
}

/** On an unpaid bill: pay some or all of it from the patient's advance. */
export function UseAdvanceButton({ patientId, invoiceId, balanceDue, onDone }: { patientId: string; invoiceId: string; balanceDue: string; onDone: () => void }) {
  const { can, money } = useMe();
  const q = useQuery({ queryKey: ["advances", patientId], queryFn: () => api.get<AdvanceList>(`/patients/${patientId}/advances`), enabled: can("INVOICE_READ") });
  const [open, setOpen] = useState(false);
  const available = Number(q.data?.balance ?? 0);
  const [amount, setAmount] = useState("");
  const [key] = useState(newKey);
  const max = Math.min(available, Number(balanceDue));
  const use = useMutation({ mutationFn: () => api.post(`/invoices/${invoiceId}/advances`, { amount: amount || max.toFixed(2) }, key), onSuccess: () => { setOpen(false); onDone(); } });
  if (!can("PAYMENT_CREATE") || available <= 0) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => { setAmount(max.toFixed(2)); setOpen(true); }}>Use advance ({money(q.data?.balance ?? "0")})</Button>
      {open && (
        <Modal title="Pay from advance" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <p className="text-sm">Available: <b>{money(q.data?.balance ?? "0")}</b> · Bill due: <b>{money(balanceDue)}</b></p>
            <Field label="Amount to use"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <ErrorNote error={use.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={Number(amount) <= 0 || Number(amount) > max} loading={use.isPending} onClick={() => use.mutate()}>Use advance</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}
