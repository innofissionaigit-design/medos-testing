"use client";
import Link from "next/link";
import { T } from "@/lib/i18n";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { CancelAdmission, DoseReasonModal, TasksCard, VitalsCard, WaiveButton } from "@/components/ipd-extras";
import { todayIn, useAvailableBeds } from "@/components/pickers";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, KV, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td, Textarea } from "@/components/ui";
import { blankItem, RxRows, toPayload, type RxItem } from "@/components/rx-editor";
import { AmendMedicine } from "@/components/prescription-extras";
import { WardStoreCard } from "@/components/ward-store";
import { api, ApiError, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Admission {
  id: string; admissionNumber: string; status: string; patientId: string; encounterId: string; patientName: string; mrn: string | null; consultantName: string; reason: string | null; admittedAt: string; dischargedAt: string | null; lengthOfStayDays: number;
  bed: { bedId: string; code: string; ward: string; room: string } | null;
  bedHistory: { id: string; bedCode: string; ward: string; room: string; assignedAt: string; releasedAt: string | null; reason: string | null; dailyRate: string }[];
}
interface Charge { id: string; type: string; description: string; quantity: string; unitPrice: string; taxPercent: string; status: string; chargedAt: string }
interface Note { id: string; note: string; createdAt: string; authorName?: string | null; status?: string; errorReason?: string | null; addenda?: Note[] }
interface IoRow { id: string; direction: string; category: string; amount: string; recordedAt: string; status: string; errorReason: string | null }
interface Mar { id: string; scheduledAt: string; status: string; unscheduled: boolean; overdue: boolean; drug: string; strength: string | null; dosage: string; route: string; frequency: string }
interface Step { step: string; required: boolean; status: string; blockers: string[]; automatic: boolean; note?: string | null }
interface Discharge { steps: Step[]; canComplete: boolean; blockers: string[]; finalInvoice: { id: string } | null; summaryStatus: string | null }
interface SummaryDoc { admission: { status: string }; document: { status: string; version: number; content: SummaryContent; signedByName: string | null } | null; suggested: { finalDiagnoses: { text: string; code?: string }[]; dischargeMedications: unknown[]; procedures: unknown[] } }
interface SummaryContent { hospitalCourse?: string; conditionAtDischarge?: string; advice?: string; investigationSummary?: string; finalDiagnoses?: { text: string; code?: string }[]; procedures?: unknown[]; dischargeMedications?: unknown[] }

function Transfer({ adm, onClose, onDone }: { adm: Admission; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const beds = useAvailableBeds();
  const [bed, setBed] = useState("");
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/transfer`, { toBedId: bed, reason }), onSuccess: onDone });
  return (
    <Modal title="Transfer to another bed" onClose={onClose}>
      <div className="space-y-3">
        <Field label="New bed"><Select value={bed} onChange={(e) => setBed(e.target.value)}><option value="">Choose…</option>{beds.data?.map((b) => <option key={b.id} value={b.id}>{b.label} — {money(b.dailyRate)}/day</option>)}</Select></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!bed || reason.trim().length < 3} loading={m.isPending} onClick={() => m.mutate()}>Transfer</Button></div>
      </div>
    </Modal>
  );
}

function Overview({ adm, refresh }: { adm: Admission; refresh: () => void }) {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const open = adm.status === "ADMITTED";
  const [transfer, setTransfer] = useState(false);
  const [c, setC] = useState({ description: "", unitPrice: "", quantity: "1", serviceId: "" });
  const charges = useQuery({ queryKey: ["charges", adm.id], queryFn: () => api.get<{ items: Charge[]; pendingTotal: string }>(`/admissions/${adm.id}/charges`) });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<{ id: string; name: string; price: string }>("/services", { pageSize: 100 }), enabled: can("CHARGE_CREATE") });
  const post = useMutation({
    mutationFn: () => api.post(`/admissions/${adm.id}/charges`, c.serviceId ? { type: "SERVICE", serviceId: c.serviceId, quantity: c.quantity } : { type: "SERVICE", description: c.description, unitPrice: c.unitPrice, taxPercent: 0, quantity: c.quantity }),
    onSuccess: () => { setC({ description: "", unitPrice: "", quantity: "1", serviceId: "" }); void qc.invalidateQueries({ queryKey: ["charges", adm.id] }); },
  });
  // One bed charge is posted per calendar day of the stay (the admission day included). Pressing the button again the same day posts nothing, so say so instead of looking broken.
  const bedDays = useMutation({ mutationFn: () => api.post<{ posted: number }>(`/admissions/${adm.id}/charges/bed-days`), onSuccess: () => qc.invalidateQueries({ queryKey: ["charges", adm.id] }) });
  const voidCharge = useMutation({ mutationFn: (id: string) => api.post(`/charges/${id}/void`, { reason: "Entered in error" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["charges", adm.id] }) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Bed history" actions={open && can("ADMISSION_TRANSFER") ? <Button variant="secondary" onClick={() => setTransfer(true)}>Transfer bed</Button> : undefined}>
        <Table head={["Ward · bed", "From", "To", "Rate/day"]}>
          {adm.bedHistory.map((b, i) => <tr key={b.id}><Td>{b.ward} · {b.bedCode}<div className="text-xs text-slate-500">{b.reason ? <>{i > 0 ? <><T>Moved here</T>: </> : null}{b.reason}</> : null}</div></Td><Td>{dateTime(b.assignedAt)}</Td><Td>{b.releasedAt ? dateTime(b.releasedAt) : <Badge tone="blue">current</Badge>}</Td><Td>{money(b.dailyRate)}</Td></tr>)}
        </Table>
      </Card>
      <Card title="Charges" actions={open && can("CHARGE_CREATE") ? <Button variant="secondary" loading={bedDays.isPending} onClick={() => bedDays.mutate()}>Post bed days</Button> : undefined}>
        <Table head={["Charge", "Qty", "Rate", "Status", ""]} {...(charges.data?.items.length === 0 ? { empty: "No charges posted yet." } : {})}>
          {charges.data?.items.map((x) => (
            <tr key={x.id} className={x.status === "VOIDED" ? "text-slate-400 line-through" : ""}><Td>{x.description}</Td><Td>{x.quantity}</Td><Td>{money(x.unitPrice)}</Td><Td><StatusBadge value={x.status} /></Td>
              <Td>{x.status === "PENDING" && open && can("CHARGE_CREATE") && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => voidCharge.mutate(x.id)}>void</button>}</Td></tr>
          ))}
        </Table>
        {bedDays.data && <div className="mt-3"><Notice tone={bedDays.data.posted > 0 ? "success" : "info"}>{bedDays.data.posted > 0 ? "Bed days added to the charges." : "Nothing to add: every day of the stay so far is already charged. A new day is charged from midnight, hospital time."}</Notice></div>}
        {open && can("CHARGE_CREATE") && (
          <form className="mt-3 grid grid-cols-12 gap-2" onSubmit={(e) => { e.preventDefault(); post.mutate(); }}>
            <Select aria-label="Service" className="col-span-12 sm:col-span-4" value={c.serviceId} onChange={(e) => setC({ ...c, serviceId: e.target.value })}><option value="">Other charge…</option>{services.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.price)}</option>)}</Select>
            {!c.serviceId && <><Input className="col-span-6 sm:col-span-4" placeholder="Description" aria-label="Description" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} /><Input className="col-span-3 sm:col-span-2" placeholder="Rate" aria-label="Rate" inputMode="decimal" value={c.unitPrice} onChange={(e) => setC({ ...c, unitPrice: e.target.value })} /></>}
            <Input className="col-span-3 sm:col-span-1" aria-label="Quantity" inputMode="decimal" value={c.quantity} onChange={(e) => setC({ ...c, quantity: e.target.value })} />
            <Button type="submit" className="col-span-12 sm:col-span-1" loading={post.isPending} disabled={!c.serviceId && (!c.description || !c.unitPrice)}>Add</Button>
            <div className="col-span-12"><ErrorNote error={post.error ?? voidCharge.error ?? bedDays.error} /></div>
          </form>
        )}
      </Card>
      {open && can("ADMISSION_CREATE") && <div className="lg:col-span-2"><CancelAdmission admissionId={adm.id} onDone={refresh} /></div>}
      {transfer && <Transfer adm={adm} onClose={() => setTransfer(false)} onDone={() => { setTransfer(false); refresh(); }} />}
    </div>
  );
}

interface OrderRow { id: string; orderNumber: string | null; status: string; signedAt?: string | null; items: (RxItem & { id: string; status: string })[] }
interface RxWarning { allergen: string; matchedItem: string; severity: string }

/** Inpatient medication orders. Signing here makes them visible to pharmacy and generates the nurse's medication chart. */
function Orders({ adm }: { adm: Admission }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const open = adm.status === "ADMITTED";
  const rx = useQuery({ queryKey: ["ipd-rx", adm.id], queryFn: () => api.get<{ orders: OrderRow[]; allergyWarnings: RxWarning[] }>(`/encounters/${adm.encounterId}/prescription`) });
  const draft = rx.data?.orders.find((o) => o.status === "DRAFT");
  const signedOrders = rx.data?.orders.filter((o) => o.status === "SIGNED") ?? [];
  const [items, setItems] = useState<RxItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ack, setAck] = useState<RxWarning[] | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  useEffect(() => { if (rx.data && !loaded) { setItems(draft?.items.map((i) => ({ ...i })) ?? []); setLoaded(true); } }, [rx.data, loaded, draft]);
  // Fetch the saved copy FIRST, then refill the rows from it: refilling from the copy loaded before the save would blank what was just typed.
  const resync = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["ipd-rx", adm.id] }), qc.invalidateQueries({ queryKey: ["mar", adm.id] })]); setLoaded(false); };
  const filled = () => items.filter((i) => i.genericName.trim()).map(toPayload);
  const save = useMutation({ mutationFn: () => api.put(`/encounters/${adm.encounterId}/prescription`, { items: filled() }), onSuccess: resync });
  const sign = useMutation({
    mutationFn: async (acknowledge: boolean) => { await api.put(`/encounters/${adm.encounterId}/prescription`, { items: filled() }); return api.post(`/encounters/${adm.encounterId}/prescription/sign`, acknowledge ? { acknowledgeAllergyWarnings: true } : {}); },
    onSuccess: () => { setAck(null); setAckChecked(false); setItems([]); resync(); },
    onError: (e) => { if (e instanceof ApiError && e.code === "ALLERGY_CONFLICT") setAck(((e.details as { allergyWarnings?: RxWarning[] } | undefined)?.allergyWarnings) ?? []); },
  });
  // Stopping is a clinical change, so the doctor confirms it and gives a reason that stays on the record.
  const [stopping, setStopping] = useState<{ id: string; name: string } | null>(null);
  const [stopReason, setStopReason] = useState("");
  const [changing, setChanging] = useState<(RxItem & { id: string }) | null>(null);
  const stop = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/medication-order-items/${v.id}/stop`, { reason: v.reason }), onSuccess: () => { setStopping(null); setStopReason(""); resync(); } });
  const canWrite = open && can("PRESCRIPTION_CREATE");
  if (rx.isLoading) return <Spinner />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Signed orders">
        {signedOrders.length === 0 ? <p className="text-sm text-slate-500">No signed medication orders yet.</p> : signedOrders.map((o) => (
          <div key={o.id} className="mb-3 last:mb-0"><div className="mb-1 text-xs text-slate-500">{o.orderNumber}</div>
            <Table head={["Medicine", "Dose", "Route", "Frequency", "Status", ""]}>
              {o.items.map((i) => (
                <tr key={i.id}><Td>{i.genericName} {i.strength}</Td><Td>{i.dosage}</Td><Td>{i.route}</Td><Td>{i.frequency}</Td><Td><StatusBadge value={i.status} /></Td>
                  <Td>{i.status === "ACTIVE" && canWrite && can("PRESCRIPTION_SIGN") && <button className="mr-2 text-xs text-slate-500 hover:text-brand-700" onClick={() => setChanging(i)}>change</button>}{i.status === "ACTIVE" && canWrite && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => { stop.reset(); setStopReason(""); setStopping({ id: i.id, name: [i.genericName, i.strength].filter(Boolean).join(" ") }); }}>stop</button>}</Td></tr>
              ))}
            </Table>
          </div>
        ))}
        {changing && <AmendMedicine item={changing} onClose={() => setChanging(null)} onDone={() => { setChanging(null); resync(); }} />}
        {stopping && (
          <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            <Notice tone="warn">Stop {stopping.name}? It stays on the record as stopped, with your name and reason. Nurses will no longer give it.</Notice>
            <Field label="Reason for stopping" hint="At least 3 characters"><Input autoFocus value={stopReason} onChange={(e) => setStopReason(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" loading={stop.isPending} disabled={stopReason.trim().length < 3} onClick={() => stop.mutate({ id: stopping.id, reason: stopReason.trim() })}>Stop medicine</Button>
              <Button variant="secondary" onClick={() => { setStopping(null); setStopReason(""); }}>Keep it</Button>
            </div>
          </div>
        )}
        <ErrorNote error={stop.error} />
      </Card>
      {canWrite && (
        <Card title="New order">
          {(rx.data?.allergyWarnings.length ?? 0) > 0 && <div className="mb-3"><Notice tone="warn">Allergy alert: {rx.data!.allergyWarnings.map((w) => `${w.matchedItem} matches ${w.allergen}`).join("; ")}</Notice></div>}
          <RxRows items={items} setItems={setItems} disabled={false} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button>
            <Button variant="secondary" loading={save.isPending} disabled={items.length === 0} onClick={() => save.mutate()}>Save draft</Button>
            {can("PRESCRIPTION_SIGN") && !ack && <ConfirmButton variant="primary" label="Sign orders" confirmLabel="Yes, sign" disabled={!items.some((i) => i.genericName.trim())} loading={sign.isPending} onConfirm={() => sign.mutate(false)} />}
          </div>
          {ack && (
            <div className="mt-3 space-y-2">
              <Notice tone="warn">{ack.map((w) => `${w.matchedItem} matches the recorded allergy to ${w.allergen}`).join("; ")}</Notice>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} /> I have reviewed the allergy warning and still want to sign.</label>
              <div className="flex gap-2"><Button disabled={!ackChecked} loading={sign.isPending} onClick={() => sign.mutate(true)}>Sign with acknowledged warning</Button><Button variant="ghost" onClick={() => setAck(null)}>Go back</Button></div>
            </div>
          )}
          <div className="mt-2"><ErrorNote error={save.error ?? (sign.error instanceof ApiError && sign.error.code === "ALLERGY_CONFLICT" ? null : sign.error)} /></div>
        </Card>
      )}
    </div>
  );
}
function Nursing({ adm }: { adm: Admission }) {
  const { me, can, dateTime } = useMe();
  const qc = useQueryClient();
  const open = adm.status === "ADMITTED";
  const [note, setNote] = useState("");
  const [reasonFor, setReasonFor] = useState<{ id: string; status: "MISSED" | "REFUSED" | "HELD" } | null>(null);
  const [io, setIo] = useState({ direction: "INTAKE", category: "ORAL", amount: "" });
  // One inline action at a time: an addendum to a note, or a reason for marking a note / I-O entry as entered in error.
  const [act, setAct] = useState<{ kind: "addendum" | "note-error" | "io-error"; id: string; text: string } | null>(null);
  const notes = useQuery({ queryKey: ["notes", adm.id], queryFn: () => api.get<Note[]>(`/admissions/${adm.id}/notes`, { includeErrors: "true" }) });
  const ioRows = useQuery({ queryKey: ["io-rows", adm.id], queryFn: () => api.get<IoRow[]>(`/admissions/${adm.id}/intake-output`) });
  const doAct = useMutation({
    mutationFn: (a: NonNullable<typeof act>) => a.kind === "addendum" ? api.post(`/nursing-notes/${a.id}/addendum`, { note: a.text.trim() })
      : a.kind === "note-error" ? api.post(`/nursing-notes/${a.id}/enter-in-error`, { reason: a.text.trim() })
      : api.post(`/intake-output/${a.id}/enter-in-error`, { reason: a.text.trim() }),
    onSuccess: async () => { setAct(null); await qc.invalidateQueries({ queryKey: ["notes", adm.id] }); await qc.invalidateQueries({ queryKey: ["io", adm.id] }); await qc.invalidateQueries({ queryKey: ["io-rows", adm.id] }); },
  });
  const actForm = (id: string, kind: "addendum" | "note-error" | "io-error") => act?.id === id && act.kind === kind && (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); doAct.mutate(act); }}>
      <Input autoFocus className="min-w-0 flex-1" aria-label={kind === "addendum" ? "Addendum" : "Reason"} placeholder={kind === "addendum" ? "Addendum (the original note stays as written)" : "Why is this entry wrong?"} value={act.text} onChange={(e) => setAct({ ...act, text: e.target.value })} />
      <Button type="submit" variant={kind === "addendum" ? "primary" : "danger"} loading={doAct.isPending} disabled={act.text.trim().length < 3}>{kind === "addendum" ? "Add addendum" : "Mark entered in error"}</Button>
      <Button variant="ghost" onClick={() => setAct(null)}>Cancel</Button>
      <div className="w-full"><ErrorNote error={doAct.error} /></div>
    </form>
  );
  const mar = useQuery({ queryKey: ["mar", adm.id], queryFn: () => api.get<Mar[]>(`/admissions/${adm.id}/mar`) });
  const totals = useQuery({ queryKey: ["io", adm.id], queryFn: () => api.get<{ daily: { intake: string; output: string; balance: string } }>(`/admissions/${adm.id}/intake-output/totals`, { date: todayIn(me.facility?.timezone ?? me.tenant.timezone) }) });
  const addNote = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/notes`, { note }), onSuccess: () => { setNote(""); void qc.invalidateQueries({ queryKey: ["notes", adm.id] }); } });
  const gen = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/mar/generate`, { hours: 24 }), onSuccess: () => qc.invalidateQueries({ queryKey: ["mar", adm.id] }) });
  const give = useMutation({ mutationFn: ({ id, status, remarks }: { id: string; status: string; remarks?: string }) => api.post(`/mar/${id}/administer`, { status, ...(remarks ? { remarks } : {}) }), onSuccess: async () => { setReasonFor(null); await qc.invalidateQueries({ queryKey: ["mar", adm.id] }); } });
  const addIo = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/intake-output`, { direction: io.direction, category: io.category, amount: Number(io.amount) }), onSuccess: () => { setIo({ ...io, amount: "" }); void qc.invalidateQueries({ queryKey: ["io", adm.id] }); void qc.invalidateQueries({ queryKey: ["io-rows", adm.id] }); } });
  const canDoc = open && can("NURSING_DOCUMENT");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Medication chart" actions={canDoc ? <Button variant="secondary" loading={gen.isPending} onClick={() => gen.mutate()}>Generate next 24 h</Button> : undefined}>
        <Table head={["Due", "Medicine", "Status", ""]} {...(mar.data?.length === 0 ? { empty: "No scheduled doses. Doses appear once the doctor has signed a prescription and the schedule is generated." } : {})}>
          {mar.data?.map((m) => (
            <tr key={m.id}><Td>{dateTime(m.scheduledAt)}</Td><Td>{m.drug} {m.strength}<div className="text-xs text-slate-500">{m.dosage} · {m.route} · {m.frequency}{m.overdue ? " · overdue" : ""}</div></Td><Td><StatusBadge value={m.status} /></Td>
              <Td>{m.status === "DUE" && open && can("NURSING_MEDICATION_ADMINISTER") && <div className="flex flex-wrap gap-1"><Button onClick={() => give.mutate({ id: m.id, status: "GIVEN" })}>Given</Button><Button variant="ghost" onClick={() => setReasonFor({ id: m.id, status: "HELD" })}>Hold</Button><Button variant="ghost" onClick={() => setReasonFor({ id: m.id, status: "REFUSED" })}>Refused</Button><Button variant="ghost" onClick={() => setReasonFor({ id: m.id, status: "MISSED" })}>Missed</Button></div>}</Td></tr>
          ))}
        </Table>
        <ErrorNote error={reasonFor ? null : (give.error ?? gen.error)} />
      </Card>
      {reasonFor && <DoseReasonModal status={reasonFor.status} onClose={() => setReasonFor(null)} error={give.error} busy={give.isPending} onSubmit={(remarks) => give.mutate({ id: reasonFor.id, status: reasonFor.status, remarks })} />}
      <div className="space-y-4">
        <VitalsCard encounterId={adm.encounterId} open={open} />
        <TasksCard admissionId={adm.id} open={open} />
        <Card title="Nursing notes">
          {canDoc && <form className="mb-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.trim().length >= 3) addNote.mutate(); }}><Textarea aria-label="Note" placeholder="Write a nursing note…" value={note} onChange={(e) => setNote(e.target.value)} /><div className="flex items-center gap-2"><Button type="submit" loading={addNote.isPending} disabled={note.trim().length < 3}>Add note</Button><ErrorNote error={addNote.error} /></div></form>}
          <ul className="space-y-2">
            {notes.data?.map((n) => {
              const wrong = n.status === "ENTERED_IN_ERROR";
              return (
                <li key={n.id} className="rounded border border-slate-100 p-2 text-sm">
                  <div className="text-xs text-slate-500">{dateTime(n.createdAt)}{n.authorName ? ` · ${n.authorName}` : ""}{wrong ? ` · entered in error: ${n.errorReason ?? ""}` : ""}</div>
                  <div className={wrong ? "text-slate-400 line-through" : ""}>{n.note}</div>
                  {n.addenda?.map((a) => (
                    <div key={a.id} className="mt-1 border-l-2 border-brand-100 pl-2"><div className="text-xs text-slate-500">Addendum · {dateTime(a.createdAt)}{a.authorName ? ` · ${a.authorName}` : ""}</div>{a.note}</div>
                  ))}
                  {canDoc && !wrong && !act && (
                    <div className="mt-1 flex gap-3 text-xs">
                      <button className="text-brand-700 hover:underline" onClick={() => setAct({ kind: "addendum", id: n.id, text: "" })}>add addendum</button>
                      <button className="text-slate-500 hover:text-red-700" onClick={() => setAct({ kind: "note-error", id: n.id, text: "" })}>entered in error</button>
                    </div>
                  )}
                  {actForm(n.id, "addendum")}{actForm(n.id, "note-error")}
                </li>
              );
            })}
            {notes.data?.length === 0 && <li className="text-sm text-slate-500">No notes yet.</li>}
          </ul>
        </Card>
        <Card title="Intake and output (today)">
          <p className="mb-2 text-sm">Intake <b>{totals.data?.daily.intake ?? 0}</b> ml · Output <b>{totals.data?.daily.output ?? 0}</b> ml · Balance <b>{totals.data?.daily.balance ?? 0}</b> ml</p>
          {canDoc && (
            <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); if (Number(io.amount) > 0) addIo.mutate(); }}>
              <Select aria-label="Direction" value={io.direction} onChange={(e) => setIo({ direction: e.target.value, category: e.target.value === "INTAKE" ? "ORAL" : "URINE", amount: io.amount })}><option value="INTAKE">Intake</option><option value="OUTPUT">Output</option></Select>
              <Select aria-label="Category" value={io.category} onChange={(e) => setIo({ ...io, category: e.target.value })}>{(io.direction === "INTAKE" ? ["ORAL", "IV", "OTHER_INTAKE"] : ["URINE", "DRAIN", "VOMIT", "OTHER_OUTPUT"]).map((c) => <option key={c}>{c}</option>)}</Select>
              <Input aria-label="Amount (ml)" placeholder="ml" inputMode="decimal" value={io.amount} onChange={(e) => setIo({ ...io, amount: e.target.value })} />
              <Button type="submit" loading={addIo.isPending}>Record</Button>
              <div className="col-span-4"><ErrorNote error={addIo.error} /></div>
            </form>
          )}
          {/* Every entry stays on record; a wrong one is struck through with its reason and left out of the totals. */}
          <Table head={["When", "Entry", "ml", ""]} {...(ioRows.data?.length === 0 ? { empty: "No entries yet." } : {})}>
            {ioRows.data?.slice(0, 30).map((r) => {
              const wrong = r.status === "ENTERED_IN_ERROR";
              return (
                <tr key={r.id} className={wrong ? "text-slate-400" : ""}>
                  <Td>{dateTime(r.recordedAt)}</Td>
                  <Td><span className={wrong ? "line-through" : ""}>{r.direction === "INTAKE" ? "Intake" : "Output"} · {r.category.toLowerCase().replace("_", " ")}</span>{wrong && <div className="text-xs">entered in error: {r.errorReason}</div>}{actForm(r.id, "io-error")}</Td>
                  <Td><span className={wrong ? "line-through" : ""}>{r.amount}</span></Td>
                  <Td>{canDoc && !wrong && !act && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => setAct({ kind: "io-error", id: r.id, text: "" })}>entered in error</button>}</Td>
                </tr>
              );
            })}
          </Table>
        </Card>
      </div>
    </div>
  );
}

function DischargePanel({ adm, refresh }: { adm: Admission; refresh: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const open = adm.status === "ADMITTED";
  // Pharmacy and billing clear themselves from work done on other screens, so keep the checklist fresh while it is open.
  const st = useQuery({ queryKey: ["discharge", adm.id], queryFn: () => api.get<Discharge>(`/admissions/${adm.id}/discharge`), refetchInterval: open ? 10_000 : false });
  const sum = useQuery({ queryKey: ["summary", adm.id], queryFn: () => api.get<SummaryDoc>(`/admissions/${adm.id}/discharge-summary`), enabled: can("CONSULTATION_READ") });
  const [content, setContent] = useState<SummaryContent>({});
  const [loaded, setLoaded] = useState(false);
  const [dtype, setDtype] = useState("ROUTINE");
  useEffect(() => {
    if (sum.data && !loaded) { setContent(sum.data.document?.content ?? { finalDiagnoses: sum.data.suggested.finalDiagnoses }); setLoaded(true); }
  }, [sum.data, loaded]);
  const reload = () => { void qc.invalidateQueries({ queryKey: ["discharge", adm.id] }); void qc.invalidateQueries({ queryKey: ["summary", adm.id] }); void qc.invalidateQueries({ queryKey: ["admission", adm.id] }); };
  const clear = useMutation({ mutationFn: (step: string) => api.post(`/admissions/${adm.id}/discharge/clear`, { step }), onSuccess: reload });
  const finalBill = useMutation({ mutationFn: () => api.post<{ invoice: { id: string } }>(`/admissions/${adm.id}/discharge/final-invoice`), onSuccess: reload });
  const complete = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/discharge/complete`, { type: dtype }), onSuccess: () => { reload(); refresh(); } });
  const save = useMutation({
    mutationFn: () => api.put<{ version: number }>(`/admissions/${adm.id}/discharge-summary`, { content: { ...content, finalDiagnoses: content.finalDiagnoses ?? [], procedures: content.procedures ?? [], dischargeMedications: content.dischargeMedications ?? [] }, ...(sum.data?.document ? { version: sum.data.document.version } : {}) }),
    onSuccess: () => { setLoaded(false); reload(); },
  });
  const signSummary = useMutation({
    mutationFn: async () => { const s = await save.mutateAsync(); return api.post(`/admissions/${adm.id}/discharge-summary/sign`, { version: s.version }); },
    onSuccess: () => { setLoaded(false); reload(); },
  });
  const stepPerm: Record<string, string> = { MEDICALLY_FIT: "ADMISSION_DISCHARGE", NURSING: "NURSING_DOCUMENT", CHARGES_REVIEWED: "CHARGE_CREATE", PHARMACY: "PHARMACY_DISPENSE" };
  const signed = sum.data?.document && sum.data.document.status !== "DRAFT";
  if (st.isLoading) return <Spinner />;
  const d = st.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Discharge checklist">
        {d?.steps.map((s) => (
          <div key={s.step} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
            <div><div className="text-sm font-medium">{s.step.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())} {!s.required && <span className="text-xs text-slate-400">(optional)</span>}</div>{s.blockers.map((b) => <div key={b} className="text-xs text-amber-700">⚠ {b}</div>)}{s.status === "CLEARED" && s.note && <div className="text-xs text-slate-500">{s.note}</div>}</div>
            <div className="flex items-center gap-2"><StatusBadge value={s.status} />{open && s.status === "PENDING" && !s.automatic && can(stepPerm[s.step] ?? "ADMISSION_DISCHARGE") && <Button variant="secondary" loading={clear.isPending} onClick={() => clear.mutate(s.step)}>Clear</Button>}{open && s.status === "PENDING" && !s.automatic && s.step !== "MEDICALLY_FIT" && can("ADMISSION_DISCHARGE") && <WaiveButton admissionId={adm.id} step={s.step} onDone={reload} />}</div>
          </div>
        ))}
        <ErrorNote error={clear.error} />
        {open && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
            {!d?.finalInvoice ? (can("IPD_FINAL_BILL") ? <Button variant="secondary" loading={finalBill.isPending} onClick={() => finalBill.mutate()}>Generate final bill</Button> : null) : <Link className="text-sm text-brand-700 hover:underline" href={`/billing/${d.finalInvoice.id}`}>Open final bill</Link>}
            <ErrorNote error={finalBill.error} />
            {d && !d.canComplete && d.blockers.length > 0 && <Notice tone="warn">Before discharge: {d.blockers.join("; ")}.</Notice>}
            {d?.canComplete && !can("ADMISSION_DISCHARGE") && <Notice tone="success">Everything is cleared and paid. The patient is still admitted, and the bed stays occupied, until a doctor presses “Discharge patient”. Ask the doctor to open this screen.</Notice>}
            {can("ADMISSION_DISCHARGE") && (
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Discharge type" className="w-44" value={dtype} onChange={(e) => setDtype(e.target.value)}>{["ROUTINE", "LAMA", "REFERRED", "ABSCONDED", "DEATH"].map((t) => <option key={t}>{t}</option>)}</Select>
                <ConfirmButton variant="primary" label="Discharge patient" confirmLabel="Yes, discharge and release the bed" disabled={!d?.canComplete} loading={complete.isPending} onConfirm={() => complete.mutate()} />
              </div>
            )}
            <ErrorNote error={complete.error} />
          </div>
        )}
        {!open && <p className="mt-3 text-sm text-slate-600">This admission is {adm.status.toLowerCase()}. {d?.finalInvoice && <Link className="text-brand-700 hover:underline" href={`/billing/${d.finalInvoice.id}`}>Final bill</Link>}</p>}
        {adm.status === "DISCHARGED" && money("0") && <p className="mt-2 space-x-3"><a className="text-sm text-brand-700 hover:underline" href={printUrl(`discharge-summaries/${adm.id}`)} target="_blank" rel="noreferrer">Print discharge summary</a><a className="text-sm text-brand-700 hover:underline" href={`${printUrl(`discharge-summaries/${adm.id}`)}?format=pdf&download=1`}>Download PDF</a></p>}
      </Card>
      {can("CONSULTATION_READ") && (
        <Card title="Discharge summary" actions={signed ? <Badge tone="green">signed by {sum.data?.document?.signedByName}</Badge> : undefined}>
          <div className="space-y-3">
            <Field label="Final diagnoses (one per line)"><Textarea disabled={!open || !!signed} value={(content.finalDiagnoses ?? []).map((x) => x.text).join("\n")} onChange={(e) => setContent({ ...content, finalDiagnoses: e.target.value.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ text })) })} /></Field>
            <Field label="Hospital course"><Textarea rows={5} disabled={!open || !!signed} value={content.hospitalCourse ?? ""} onChange={(e) => setContent({ ...content, hospitalCourse: e.target.value })} /></Field>
            <Field label="Condition at discharge"><Input disabled={!open || !!signed} value={content.conditionAtDischarge ?? ""} onChange={(e) => setContent({ ...content, conditionAtDischarge: e.target.value })} /></Field>
            <Field label="Advice"><Textarea disabled={!open || !!signed} value={content.advice ?? ""} onChange={(e) => setContent({ ...content, advice: e.target.value })} /></Field>
            {open && !signed && can("CONSULTATION_CREATE") && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>Save draft</Button>
                {can("CONSULTATION_SIGN") && <ConfirmButton variant="primary" label="Sign summary" confirmLabel="Yes, sign" loading={signSummary.isPending} onConfirm={() => signSummary.mutate()} />}
              </div>
            )}
            <ErrorNote error={save.error ?? signSummary.error} />
          </div>
        </Card>
      )}
    </div>
  );
}

export default function AdmissionPage() {
  const { id } = useParams<{ id: string }>();
  const { dateTime } = useMe();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "orders" | "nursing" | "discharge">("overview");
  const adm = useQuery({ queryKey: ["admission", id], queryFn: () => api.get<Admission>(`/admissions/${id}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["admission", id] }); void qc.invalidateQueries({ queryKey: ["board"] }); };
  if (adm.isLoading) return <Spinner />;
  if (adm.error || !adm.data) return <ErrorNote error={adm.error ?? new Error("Admission not found")} />;
  const a = adm.data;
  return (
    <Gate anyOf={["ADMISSION_READ"]} feature="IPD_ENABLED">
      <PageHeader
        title={a.patientName} subtitle={`${a.admissionNumber} · MRN ${a.mrn ?? "—"} · admitted ${dateTime(a.admittedAt)} · ${a.lengthOfStayDays} day(s) · ${a.consultantName}${a.bed ? ` · ${a.bed.ward} ${a.bed.code}` : ""}`}
        actions={<><StatusBadge value={a.status} /><Link href={`/patients/${a.patientId}`} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Patient record</Link>
          {a.status !== "CANCELLED" && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`admission-forms/${a.id}`)} target="_blank" rel="noreferrer">Print admission form</a>}
          {a.status !== "CANCELLED" && <a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`admission-forms/${a.id}`)}?format=pdf&download=1`}>PDF</a>}
          {a.status !== "CANCELLED" && <><a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`admission-forms/${a.id}`)}?lang=bn`} target="_blank" rel="noreferrer">বাংলা</a><a className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50" href={`${printUrl(`admission-forms/${a.id}`)}?lang=hi`} target="_blank" rel="noreferrer">हिन्दी</a></>}</>}
      />
      {a.reason && <div className="mb-3"><KV label="Reason for admission">{a.reason}</KV></div>}
      <Tabs tabs={[{ id: "overview", label: "Beds and charges" }, { id: "orders", label: "Medication orders" }, { id: "nursing", label: "Nursing and medication" }, { id: "discharge", label: "Discharge" }]} value={tab} onChange={setTab} />
      {tab === "overview" && <Overview adm={a} refresh={refresh} />}
      {tab === "orders" && <Orders adm={a} />}
      {tab === "nursing" && <><Nursing adm={a} /><WardStoreCard admissionId={a.id} open={a.status === "ADMITTED"} /></>}
      {tab === "discharge" && <DischargePanel adm={a} refresh={refresh} />}
    </Gate>
  );
}
