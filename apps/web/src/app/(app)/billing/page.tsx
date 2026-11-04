"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { PatientPicker, type PickedPatient } from "@/components/pickers";
import { CashierPrescriptions } from "@/components/cashier-prescriptions";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface InvoiceRow { id: string; invoiceNumber: string | null; status: string; kind: string; patientName: string; mrn: string | null; total: string; balanceDue: string; createdAt: string }
interface Service { id: string; code: string; name: string; price: string; taxPercent: string; category: string }
interface Shift { id: string; openedAt: string; openingCash: string; expectedCash?: string; cashReceived?: string; cashRefunded?: string; receiptsTotal?: string }
type Line = { serviceId?: string; description: string; unitPrice: string; taxPercent: string; quantity: string };

/** `fromPatient`: opened from a patient's page, so the bill page offers the way back (and the OPD visit) afterwards. */
function NewBill({ initialPatient, fromPatient, onClose }: { initialPatient: PickedPatient | null; fromPatient: boolean; onClose: () => void }) {
  const router = useRouter();
  const { money, can } = useMe();
  const [patient, setPatient] = useState<PickedPatient | null>(initialPatient);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<Service>("/services", { pageSize: 100 }) });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/invoices", {
      patientId: patient!.id,
      lines: lines.map((l) => (l.serviceId ? { serviceId: l.serviceId, quantity: l.quantity } : { description: l.description, unitPrice: l.unitPrice, taxPercent: l.taxPercent || "0", quantity: l.quantity })),
    }),
    // From a patient's page (Reception): the bill is issued straight away, so the payment can be taken on the next screen.
    onSuccess: async (inv) => { if (fromPatient && can("INVOICE_ISSUE")) await api.post(`/invoices/${inv.id}/issue`).catch(() => undefined); router.push(fromPatient ? `/billing/${inv.id}?from=patient` : `/billing/${inv.id}`); },
  });
  const matches = (services.data?.data ?? []).filter((s) => !q || `${s.code} ${s.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const total = lines.reduce((n, l) => n + Number(l.unitPrice || 0) * Number(l.quantity || 0) * (1 + Number(l.taxPercent || 0) / 100), 0);
  return (
    <Modal title="New bill" onClose={onClose} wide>
      <div className="space-y-3">
        <Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus={!initialPatient} /></Field>
        <Field label="Add a service"><Input placeholder="Search price list…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-1.5">
          {matches.map((s) => <button key={s.id} className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-brand-50" onClick={() => setLines([...lines, { serviceId: s.id, description: s.name, unitPrice: s.price, taxPercent: s.taxPercent, quantity: "1" }])}>{s.name} · {money(s.price)}</button>)}
          <button className="rounded border border-dashed border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setLines([...lines, { description: "", unitPrice: "", taxPercent: "0", quantity: "1" }])}>+ Other charge</button>
        </div>
        {lines.length > 0 && (
          <Table head={["Item", "Qty", "Rate", "Tax %", ""]}>
            {lines.map((l, i) => (
              <tr key={i}>
                <Td>{l.serviceId ? l.description : <Input aria-label="Description" placeholder="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />}</Td>
                <Td><Input aria-label="Quantity" className="w-20" inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></Td>
                <Td>{l.serviceId ? money(l.unitPrice) : <Input aria-label="Rate" className="w-24" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />}</Td>
                <Td>{l.serviceId ? l.taxPercent : <Input aria-label="Tax percent" className="w-16" inputMode="decimal" value={l.taxPercent} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxPercent: e.target.value } : x)))} />}</Td>
                <Td><button aria-label="Remove line" className="text-slate-400 hover:text-red-700" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">Estimated total {money(total.toFixed(2))} — the final amount is calculated by the server.</span>
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || lines.length === 0 || lines.some((l) => !l.description || !l.unitPrice)} loading={create.isPending} onClick={() => create.mutate()}>Create bill</Button></div>
        </div>
        <ErrorNote error={create.error} />
      </div>
    </Modal>
  );
}

function ShiftCard() {
  const { money, dateTime, can } = useMe();
  const qc = useQueryClient();
  const cur = useQuery({ queryKey: ["shift"], queryFn: () => api.get<Shift | null>("/shifts/current"), enabled: can("CASHIER_SHIFT_MANAGE") });
  const [cash, setCash] = useState("");
  const [closing, setClosing] = useState(false);
  const [notes, setNotes] = useState("");
  // The result of the shift just closed, so the cashier sees expected vs counted after the card resets.
  const [closed, setClosed] = useState<{ expectedCash: string; actualCash: string; difference: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["shift"] });
  const open = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: cash || "0" }), onSuccess: () => { setCash(""); setClosed(null); void refresh(); } });
  const close = useMutation({
    mutationFn: () => api.post<{ expectedCash: string; actualCash: string; difference: string }>(`/shifts/${cur.data!.id}/close`, { actualCash: cash || "0", ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: (r) => { setClosed(r); setCash(""); setNotes(""); setClosing(false); void refresh(); },
  });
  const expected = Number(cur.data?.expectedCash ?? 0);
  const counted = cash.trim() === "" ? null : Number(cash);
  const differs = counted !== null && Math.round(counted * 100) !== Math.round(expected * 100);
  if (!can("CASHIER_SHIFT_MANAGE")) return null;
  return (
    <Card title="My cash shift">
      {cur.isLoading ? <Spinner /> : cur.data ? (
        <div className="space-y-2 text-sm">
          <div>Open since {dateTime(cur.data.openedAt)} · opening cash {money(cur.data.openingCash)}{cur.data.expectedCash ? ` · expected in drawer ${money(cur.data.expectedCash)}` : ""}</div>
          {closing ? (
            <div className="space-y-2">
              <div className="flex items-end gap-2"><Field label="Cash counted in drawer"><Input autoFocus inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></Field><Button loading={close.isPending} disabled={counted === null || (differs && notes.trim().length < 5)} onClick={() => close.mutate()}>Close shift</Button><Button variant="ghost" onClick={() => setClosing(false)}>Back</Button></div>
              {counted !== null && <div className={differs ? "text-amber-800" : "text-green-700"}>Expected {money(expected.toFixed(2))} · counted {money(counted.toFixed(2))}{differs ? ` · difference ${money((counted - expected).toFixed(2))}` : " · matches"}</div>}
              {differs && <Field label="Explain the difference" hint="Required when the counted cash does not match (at least 5 characters)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>}
            </div>
          ) : <Button variant="secondary" onClick={() => setClosing(true)}>Close shift…</Button>}
          <ErrorNote error={close.error} />
        </div>
      ) : (
        <div className="space-y-2">
          {closed && <Notice tone={Number(closed.difference) === 0 ? "success" : "warn"}>{`Shift closed. Expected ${money(closed.expectedCash)}, counted ${money(closed.actualCash)}, difference ${money(closed.difference)}.`}</Notice>}
          <Notice tone="info">No cash shift is open. One opens by itself with the first cash payment; open one here if you start with cash in the drawer.</Notice>
          <div className="flex items-end gap-2"><Field label="Opening cash"><Input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" /></Field><Button loading={open.isPending} onClick={() => open.mutate()}>Open shift</Button></div>
          <ErrorNote error={open.error} />
        </div>
      )}
    </Card>
  );
}

interface Unbilled { admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; charges: number; pendingTotal: string; items: { id: string; description: string; quantity: string; lineTotal: string }[] }

/** What admitted patients owe so far. These become a bill when the patient is discharged; this card is the cashier's early view. */
function UnbilledCard() {
  const { money } = useMe();
  const q = useQuery({ queryKey: ["unbilled-charges"], queryFn: () => api.get<Unbilled[]>("/charges/unbilled"), refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Card title="Admitted patients: charges not yet billed"><Spinner /></Card>;
  return (
    <Card title="Admitted patients: charges not yet billed">
      <Table head={["Patient", "Admission", "Charges", "Amount so far", ""]} {...(q.data?.length === 0 ? { empty: "No unbilled charges for admitted patients." } : {})}>
        {q.data?.flatMap((g) => [
          <tr key={g.admissionId} className="hover:bg-slate-50">
            <Td>{g.patientName}<div className="text-xs text-slate-500">{g.mrn}</div></Td><Td>{g.admissionNumber}</Td><Td>{g.charges}</Td><Td>{money(g.pendingTotal)}</Td>
            <Td><button className="text-sm text-brand-700 hover:underline" onClick={() => setOpen(open === g.admissionId ? null : g.admissionId)}>{open === g.admissionId ? "Hide" : "Details"}</button>{" · "}<Link className="text-sm text-brand-700 hover:underline" href={`/ipd/${g.admissionId}`}>Open admission</Link></Td>
          </tr>,
          ...(open === g.admissionId ? g.items.map((x) => <tr key={x.id} className="bg-slate-50 text-sm text-slate-600"><Td>{x.description}</Td><Td></Td><Td>{x.quantity}</Td><Td>{money(x.lineTotal)}</Td><Td></Td></tr>) : []),
        ])}
      </Table>
    </Card>
  );
}

function BillingInner() {
  const { can, money, date } = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [adding, setAdding] = useState(!!params.get("patient"));
  const [status, setStatus] = useState("");
  const [qNum, setQNum] = useState("");
  const [kind, setKind] = useState("");
  const pre = params.get("patient");
  // The pharmacy only bills; every payment is collected here, so waiting pharmacy bills are surfaced for the cashier.
  const waiting = useQuery({ queryKey: ["pharmacy-waiting"], queryFn: () => api.page<InvoiceRow>("/invoices", { kind: "PHARMACY", outstanding: "true", pageSize: 1 }), refetchInterval: 30_000, enabled: can("PAYMENT_CREATE") });
  const preP = useQuery({ queryKey: ["pre-patient", pre], queryFn: () => api.get<{ id: string; mrn: string | null; firstName: string; lastName: string | null }>(`/patients/${pre}`), enabled: !!pre });
  const list = useQuery({ queryKey: ["invoices", status, qNum, kind], queryFn: () => api.page<InvoiceRow>("/invoices", { ...(status === "OUTSTANDING" ? { outstanding: "true" } : status ? { status } : {}), ...(kind ? { kind } : {}), ...(qNum ? { q: qNum } : {}), pageSize: 50 }), refetchInterval: 15_000 });
  const waitingCount = waiting.data?.meta.total ?? 0;
  return (
    <Gate anyOf={["INVOICE_READ"]}>
      <PageHeader title="Billing" subtitle="Bills, payments and your cash shift" actions={can("INVOICE_CREATE") ? <Button onClick={() => setAdding(true)}>New bill</Button> : undefined} />
      {waitingCount > 0 && (
        <div className="mb-3"><Notice tone="warn">
          {waitingCount} pharmacy {waitingCount === 1 ? "bill is" : "bills are"} waiting for payment. The pharmacy does not take payment; collect it here.{" "}
          <button className="font-medium underline" onClick={() => { setKind("PHARMACY"); setStatus("OUTSTANDING"); }}>Show them</button>
        </Notice></div>
      )}
      {can("TEST_BILL") && <div className="mb-4"><CashierPrescriptions /></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Bills" actions={<>
            <Input placeholder="Bill number" aria-label="Bill number" className="w-36" value={qNum} onChange={(e) => setQNum(e.target.value)} />
            <Select aria-label="Bill type" className="w-36" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option><option value="OPD">OPD</option><option value="REGISTRATION">Registration</option><option value="PHARMACY">Pharmacy</option><option value="IPD">Admission</option><option value="OTHER">Other</option></Select>
            <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="OUTSTANDING">Outstanding</option><option value="DRAFT">Draft</option><option value="PAID">Paid</option><option value="CANCELLED">Cancelled</option></Select>
          </>}>
            {list.isLoading ? <Spinner /> : (
              <Table head={["Bill", "Patient", "Status", "Total", "Due", "Date"]} {...(list.data?.data.length === 0 ? { empty: "No bills found." } : {})}>
                {list.data?.data.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <Td><Link className="font-medium text-brand-700 hover:underline" href={`/billing/${i.id}`}>{i.invoiceNumber ?? "Draft"}</Link> <Badge>{i.kind.toLowerCase()}</Badge></Td>
                    <Td>{i.patientName}<div className="text-xs text-slate-500">{i.mrn}</div></Td><Td><StatusBadge value={i.status} /></Td><Td>{money(i.total)}</Td><Td>{money(i.balanceDue)}</Td><Td>{date(i.createdAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <div className="mt-4"><UnbilledCard /></div>
        </div>
        <ShiftCard />
      </div>
      {/* Opened from a patient's page: wait for that patient, so the form never opens empty and has to be searched again. */}
      {adding && (!pre || preP.data || preP.isError) && (
        <NewBill
          initialPatient={preP.data ? { id: preP.data.id, mrn: preP.data.mrn, name: [preP.data.firstName, preP.data.lastName].filter(Boolean).join(" ") } : null}
          fromPatient={!!preP.data}
          onClose={() => (preP.data ? router.push(`/patients/${preP.data.id}`) : setAdding(false))}
        />
      )}
    </Gate>
  );
}

export default function BillingPage() { return <Suspense fallback={<Spinner />}><BillingInner /></Suspense>; }
