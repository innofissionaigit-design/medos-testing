"use client";
import Link from "next/link";
import { T, useT } from "@/lib/i18n";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { ClaimModal } from "@/components/claims";
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
interface Step { step: string; required: boolean; status: string; blockers: string[]; automatic: boolean; note?: string | null; waivable?: boolean; reconciliation?: { problems: string[]; insured?: boolean; validPolicies?: number; claim?: InsuranceClaim | null } | null; stage?: string; responsible?: string; description?: string; hisStatus?: string; byName?: string | null; at?: string | null; checks?: { name: string; ok: boolean; detail: string }[] }
interface SummaryStage { stage: string; responsible: string; description: string; required: boolean; status: string; hisStatus: string; preparedByName: string | null; signedByName: string | null; signedAt: string | null; verificationRequired?: boolean; verifiedByName?: string | null; verifiedAt?: string | null; verificationNote?: string | null }
interface InsuranceClaim { id: string; claimNumber: string; type: string; status: string; insurer: string; policyNumber: string; documents: number; preauthRequested: string | null; preauthApproved: string | null }
interface ExitStage { stage: string; responsible: string; description: string; status: "NOT_DUE" | "PENDING" | "CONFIRMED" | "NOT_APPLICABLE"; hisStatus: string; departedAt: string | null; modeLabel: string | null; escortedBy: string | null; note: string | null; byName: string | null; at: string | null; minutesAfterDischarge: number | null }
interface TurnoverStage { stage: string; responsible: string; description: string; status: "NOT_DUE" | "AWAITING_DEPARTURE" | "VACATED" | "CLEANING" | "READY" | "NOT_APPLICABLE"; hisStatus: string; bed: string | null; vacatedAt: string | null; cleaningStartedAt: string | null; cleaningStartedBy: string | null; readyAt: string | null; readyBy: string | null; minutesToReady: number | null }
interface PostDischargeStage { stage: string; responsible: string; description: string; status: "NOT_DUE" | "NOT_APPLICABLE" | "RECORDS_PENDING" | "TRACKING" | "CLOSED"; hisStatus: string; checks: { name: string; ok: boolean; detail: string }[]; recordReady: boolean; recordCompletedAt: string | null; recordCompletedBy: string | null; daysSinceDischarge: number | null; suggestedDiagnoses?: { text: string; code?: string }[]; file?: { current: { label: string } | null; nextActions: string[] } }
interface Discharge { steps: Step[]; summary?: SummaryStage; exit?: ExitStage; turnover?: TurnoverStage; postDischarge?: PostDischargeStage; dischargeType?: string | null; canComplete: boolean; blockers: string[]; finalInvoice: { id: string } | null; summaryStatus: string | null }
interface SummaryDoc { admission: { status: string }; document: { status: string; version: number; currentVersion: number; content: SummaryContent; signedByName: string | null; verified?: boolean; verifiedByName?: string | null } | null; suggested: { finalDiagnoses: { text: string; code?: string }[]; dischargeMedications: unknown[]; procedures: unknown[] } }
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

interface AdmissionTest { id: string; name: string; category: string; state: string; reason: string | null }
const TEST_STATE: Record<string, { label: string; tone: "green" | "amber" | "gray" | "blue" }> = {
  TO_BE_BILLED: { label: "To be billed by the cashier", tone: "amber" },
  WAITING_FOR_RESULT: { label: "Billed · waiting for the result", tone: "blue" },
  WAITING_FOR_REPORT: { label: "Billed · waiting for the report", tone: "blue" },
  DONE: { label: "Done", tone: "green" },
  NOT_NEEDED: { label: "Not needed", tone: "gray" },
};

/** The laboratory and radiology tests of this stay, and a form for the treating doctor or the RMO to order one. The discharge stage "Laboratory / radiology" follows them. */
function TestsCard({ adm, open }: { adm: Admission; open: boolean }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const tests = useQuery({ queryKey: ["admission-tests", adm.id], queryFn: () => api.get<AdmissionTest[]>(`/admissions/${adm.id}/test-orders`), refetchInterval: open ? 10_000 : false });
  const [category, setCategory] = useState("LABORATORY");
  const [name, setName] = useState("");
  const order = useMutation({
    mutationFn: () => api.post(`/admissions/${adm.id}/test-orders`, { category, name: name.trim() }),
    onSuccess: () => { setName(""); void qc.invalidateQueries({ queryKey: ["admission-tests", adm.id] }); void qc.invalidateQueries({ queryKey: ["discharge", adm.id] }); },
  });
  const rows = tests.data ?? [];
  return (
    <Card title="Laboratory and radiology tests">
      {tests.isLoading ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">No laboratory or radiology tests for this stay.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="admission-tests">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-500"><th className="py-2 pr-3 font-medium">Test</th><th className="py-2 pr-3 font-medium">Kind</th><th className="py-2 font-medium">Where it stands</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium">{r.name}</td>
                  <td className="py-2 pr-3 text-slate-600">{r.category === "RADIOLOGY" ? "Radiology" : "Laboratory"}</td>
                  <td className="py-2"><Badge tone={TEST_STATE[r.state]?.tone ?? "gray"}>{TEST_STATE[r.state]?.label ?? r.state}</Badge>{r.reason && <span className="ml-2 text-xs text-slate-500">{r.reason}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && can("CONSULTATION_CREATE") && (
        <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) order.mutate(); }}>
          <Select aria-label="Kind of test" className="w-40" value={category} onChange={(e) => setCategory(e.target.value)}><option value="LABORATORY">Laboratory</option><option value="RADIOLOGY">Radiology</option></Select>
          <Input aria-label="Test name" className="min-w-[12rem] flex-1" placeholder="Test name, for example CBC (complete blood count)" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="secondary" loading={order.isPending} disabled={name.trim().length < 2}>Order test</Button>
        </form>
      )}
      <ErrorNote error={order.error} />
      {open && <p className="mt-2 text-xs text-slate-500">The cashier bills the test, the laboratory or radiology performs it, and the “Laboratory / radiology” stage clears when every test is billed and reported.</p>}
    </Card>
  );
}

interface ProcItem { id: string; kind: string; name: string; quantity: number; serialNo: string | null; amount: string | null; removed: boolean; removeReason: string | null }
interface Proc { id: string; name: string; status: string; scheduledAt: string | null; surgeonName: string | null; amount: string | null; performedByName: string | null; finalisedByName: string | null; finalisedAt: string | null; cancelReason: string | null; items: ProcItem[] }
interface PriceItem { id: string; name: string; price: string }
const PROC_TONE: Record<string, "green" | "amber" | "gray" | "blue"> = { PLANNED: "amber", PERFORMED: "blue", FINALISED: "green", CANCELLED: "gray" };

/** A small button that asks for a written reason (3 or more characters) before it acts. */
function ReasonButton({ label, title, onSubmit, error }: { label: string; title: string; onSubmit: (reason: string) => Promise<unknown>; error?: unknown }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>{label}</Button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Field label="Reason" hint="At least 3 characters. This is recorded."><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button>
              <Button variant="danger" disabled={reason.trim().length < 3} loading={busy} onClick={() => { setBusy(true); onSubmit(reason.trim()).then(() => { setOpen(false); setReason(""); }).catch(() => undefined).finally(() => setBusy(false)); }}>{label}</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** One procedure: where it stands, its implants and consumables, and what the OT / procedure coordinator can do next. */
function ProcedureBlock({ proc, open, prices, refresh }: { proc: Proc; open: boolean; prices: PriceItem[]; refresh: () => void }) {
  const { can } = useMe();
  const manage = open && can("PROCEDURE_MANAGE");
  const live = proc.status === "PLANNED" || proc.status === "PERFORMED";
  const [kind, setKind] = useState("IMPLANT");
  const [serviceId, setServiceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [serialNo, setSerialNo] = useState("");
  const done = { onSuccess: refresh };
  const perform = useMutation({ mutationFn: () => api.post(`/procedures/${proc.id}/perform`, {}), ...done });
  const finalise = useMutation({ mutationFn: () => api.post(`/procedures/${proc.id}/finalise`), ...done });
  const cancel = useMutation({ mutationFn: (reason: string) => api.post(`/procedures/${proc.id}/cancel`, { reason }), ...done });
  const remove = useMutation({ mutationFn: (v: { itemId: string; reason: string }) => api.post(`/procedures/${proc.id}/items/${v.itemId}/remove`, { reason: v.reason }), ...done });
  const addItem = useMutation({
    mutationFn: () => api.post(`/procedures/${proc.id}/items`, { kind, serviceId, quantity: Number(quantity), ...(kind === "IMPLANT" ? { serialNo: serialNo.trim() } : serialNo.trim() ? { serialNo: serialNo.trim() } : {}) }),
    onSuccess: () => { setServiceId(""); setSerialNo(""); setQuantity("1"); refresh(); },
  });
  const items = proc.items.filter((i) => !i.removed);
  return (
    <div className="rounded-md border border-slate-200 p-3" data-testid="procedure-block">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{proc.name}</span><Badge tone={PROC_TONE[proc.status] ?? "gray"}>{proc.status.toLowerCase()}</Badge>
        {proc.amount && <span className="text-xs text-slate-500">₹{proc.amount}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {manage && proc.status === "PLANNED" && <Button variant="secondary" loading={perform.isPending} onClick={() => perform.mutate()}>Mark performed</Button>}
          {manage && proc.status === "PERFORMED" && <ConfirmButton variant="primary" label="Finalise" confirmLabel="Yes, finalise (cannot be changed)" loading={finalise.isPending} onConfirm={() => finalise.mutate()} />}
          {open && can("PROCEDURE_PLAN") && proc.status === "PLANNED" && <ReasonButton label="Cancel procedure" title={`Cancel “${proc.name}”`} onSubmit={(r) => cancel.mutateAsync(r)} error={cancel.error} />}
        </span>
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {proc.surgeonName && <>Surgeon {proc.surgeonName} · </>}{proc.scheduledAt && <>Planned for {new Date(proc.scheduledAt).toLocaleString()} · </>}
        {proc.performedByName && <>Performed by {proc.performedByName} · </>}{proc.finalisedByName && <>Finalised by {proc.finalisedByName}{proc.finalisedAt ? ` · ${new Date(proc.finalisedAt).toLocaleString()}` : ""}</>}
        {proc.cancelReason && <>Cancelled: {proc.cancelReason}</>}
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm" data-testid="procedure-items">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2"><Badge tone={i.kind === "IMPLANT" ? "blue" : "gray"}>{i.kind.toLowerCase()}</Badge><span>{i.name} × {i.quantity}</span>{i.serialNo && <span className="text-xs text-slate-500">serial {i.serialNo}</span>}{i.amount && <span className="text-xs text-slate-500">₹{i.amount}</span>}
              {manage && live && <ReasonButton label="Remove" title={`Remove ${i.name}`} onSubmit={(r) => remove.mutateAsync({ itemId: i.id, reason: r })} error={remove.error} />}</li>
          ))}
        </ul>
      )}
      {manage && live && (
        <form className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2" onSubmit={(e) => { e.preventDefault(); if (serviceId) addItem.mutate(); }}>
          <Select aria-label="Implant or consumable" className="w-36" value={kind} onChange={(e) => setKind(e.target.value)}><option value="IMPLANT">Implant</option><option value="CONSUMABLE">Consumable</option></Select>
          <Select aria-label="Price-list item" className="min-w-[10rem] flex-1" value={serviceId} onChange={(e) => setServiceId(e.target.value)}><option value="">Choose from the price list…</option>{prices.map((p) => <option key={p.id} value={p.id}>{p.name} (₹{p.price})</option>)}</Select>
          <Input aria-label="Quantity" className="w-20" type="number" min={1} max={999} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <Input aria-label="Serial or lot number" className="w-44" placeholder={kind === "IMPLANT" ? "Serial / lot no. (required)" : "Lot no. (optional)"} value={serialNo} onChange={(e) => setSerialNo(e.target.value)} />
          <Button type="submit" variant="secondary" loading={addItem.isPending} disabled={!serviceId || Number(quantity) < 1 || (kind === "IMPLANT" && serialNo.trim().length < 2)}>Add</Button>
        </form>
      )}
      <ErrorNote error={perform.error ?? finalise.error ?? addItem.error} />
    </div>
  );
}

/** Procedures for this admission: the doctor or the RMO plans one, the OT / procedure coordinator performs it, records the implants and consumables and finalises it. */
function ProceduresCard({ adm, open }: { adm: Admission; open: boolean }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const procs = useQuery({ queryKey: ["procedures", adm.id], queryFn: () => api.get<Proc[]>(`/admissions/${adm.id}/procedures`), enabled: can("PROCEDURE_READ"), refetchInterval: open ? 10_000 : false });
  const prices = useQuery({ queryKey: ["price-list-all"], queryFn: () => api.page<PriceItem & { category: string }>("/services", { pageSize: 200 }), enabled: open && (can("PROCEDURE_PLAN") || can("PROCEDURE_MANAGE")) });
  const [planId, setPlanId] = useState("");
  const [planDate, setPlanDate] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["procedures", adm.id] }); void qc.invalidateQueries({ queryKey: ["discharge", adm.id] }); void qc.invalidateQueries({ queryKey: ["charges", adm.id] }); };
  const plan = useMutation({
    mutationFn: () => api.post(`/admissions/${adm.id}/procedures`, { serviceId: planId, ...(planDate ? { scheduledAt: new Date(planDate).toISOString() } : {}) }),
    onSuccess: () => { setPlanId(""); setPlanDate(""); refresh(); },
  });
  if (!can("PROCEDURE_READ")) return null;
  const all = prices.data?.data ?? [];
  const procedureList = all.filter((x) => x.category === "PROCEDURE");
  const rows = procs.data ?? [];
  return (
    <Card title="Procedures, implants and consumables">
      {procs.isLoading ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500">No procedures planned for this stay.</p> : (
        <div className="space-y-3">{rows.map((r) => <ProcedureBlock key={r.id} proc={r} open={open} prices={all} refresh={refresh} />)}</div>
      )}
      {open && can("PROCEDURE_PLAN") && (
        <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); if (planId) plan.mutate(); }}>
          <Select aria-label="Procedure" className="min-w-[12rem] flex-1" value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">Choose a procedure from the price list…</option>{procedureList.map((x) => <option key={x.id} value={x.id}>{x.name} (₹{x.price})</option>)}</Select>
          <Input aria-label="Planned date and time" className="w-52" type="datetime-local" value={planDate} onChange={(e) => setPlanDate(e.target.value)} />
          <Button type="submit" variant="secondary" loading={plan.isPending} disabled={!planId}>Plan procedure</Button>
        </form>
      )}
      <ErrorNote error={plan.error} />
      {open && <p className="mt-2 text-xs text-slate-500">The doctor plans the procedure; the OT / procedure coordinator marks it performed, records the implants and consumables used, and finalises it. The “OT / procedure” stage clears when every procedure is finalised.</p>}
    </Card>
  );
}

/**
 * Insurance for this admission (docs/claims.md): the TPA desk starts the claim from here, keeps its documents and the insurer's authorisation up to date in the claim window,
 * and the "Insurance" stage of the checklist reads the result. A self-pay patient sees nothing but a note.
 */
function InsuranceCard({ adm, open }: { adm: Admission; open: boolean }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["discharge", adm.id], queryFn: () => api.get<Discharge>(`/admissions/${adm.id}/discharge`), refetchInterval: open ? 10_000 : false });
  const step =st.data?.steps.find((s) => s.step === "INSURANCE");
  const claim = step?.reconciliation?.claim ?? null;
  const [modal, setModal] = useState<string | null>(null);
  const [policyId, setPolicyId] = useState("");
  const [type, setType] = useState("CASHLESS");
  const canStart = open && can("CLAIM_MANAGE") && !claim && (step?.reconciliation?.validPolicies ?? 0) > 0;
  const policies = useQuery({ queryKey: ["policies", adm.patientId], queryFn: () => api.get<{ id: string; policyNumber: string; validToday: boolean; insurer: { name: string } }[]>(`/patients/${adm.patientId}/policies`), enabled: canStart });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["discharge", adm.id] }); void qc.invalidateQueries({ queryKey: ["claims"] }); };
  const start = useMutation({ mutationFn: () => api.post<{ id: string }>("/claims", { patientId: adm.patientId, policyId, type, encounterId: adm.encounterId }), onSuccess: (r) => { setPolicyId(""); refresh(); setModal(r.id); } });
  if (!step || !step.reconciliation || (!step.reconciliation.insured && !claim)) return null;
  const valid = (policies.data ?? []).filter((p) => p.validToday);
  return (
    <Card title="Insurance" >
      <div data-testid="insurance-card" className="space-y-2 text-sm">
        {claim ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{claim.claimNumber}</span><StatusBadge value={claim.status} /><span className="text-slate-600">{claim.type === "CASHLESS" ? "Cashless" : "Reimbursement"} · {claim.insurer} · policy {claim.policyNumber}</span></div>
            <KV label="Documents attached">{claim.documents}</KV>
            {claim.type === "CASHLESS" && <KV label="Pre-authorisation">{claim.status === "REJECTED" ? `rejected by the insurer${claim.preauthRequested ? ` (₹${claim.preauthRequested} asked)` : ""}` : claim.preauthApproved ? `approved ₹${claim.preauthApproved}${claim.preauthRequested ? ` of ₹${claim.preauthRequested} asked` : ""}` : claim.preauthRequested ? `₹${claim.preauthRequested} asked, no decision yet` : "not requested"}</KV>}
            {can("CLAIM_READ") && <Button variant="secondary" onClick={() => setModal(claim.id)}>{can("CLAIM_MANAGE") ? "Open claim (documents and authorisation)" : "View claim"}</Button>}
          </>
        ) : (
          <>
            <p className="text-slate-600"><T>This patient has a valid insurance policy, but no claim is open for this admission yet.</T></p>
            {canStart && (
              <div className="flex flex-wrap items-end gap-2">
                <Select aria-label="Policy" className="min-w-[12rem] flex-1" value={policyId} onChange={(e) => setPolicyId(e.target.value)}><option value="">Choose the policy…</option>{valid.map((p) => <option key={p.id} value={p.id}>{p.insurer.name} · {p.policyNumber}</option>)}</Select>
                <Select aria-label="Kind of claim" className="w-40" value={type} onChange={(e) => setType(e.target.value)}><option value="CASHLESS">Cashless</option><option value="REIMBURSEMENT">Reimbursement</option></Select>
                <Button variant="secondary" loading={start.isPending} disabled={!policyId} onClick={() => start.mutate()}>Start insurance claim</Button>
              </div>
            )}
            {!canStart && open && <p className="text-xs text-slate-500">The TPA desk starts the claim. If the patient is paying themselves, a doctor can waive the “Insurance” stage with a reason.</p>}
          </>
        )}
        <ErrorNote error={start.error} />
        {open && claim && <p className="text-xs text-slate-500">The TPA desk attaches the documents and records the insurer’s authorisation in the claim. MedOS keeps the record; it does not send anything to the insurer.</p>}
      </div>
      {modal && <ClaimModal claimId={modal} onClose={() => { setModal(null); refresh(); }} />}
    </Card>
  );
}

/**
 * Financial release as an authorised exception (docs/discharge-stages.md): billing / finance lets the patient leave although final billing is not
 * reconciled. The reason is recorded with the amounts outstanding at that moment, and audited.
 */
function FinancialExceptionButton({ admissionId, onDone }: { admissionId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/admissions/${admissionId}/discharge/financial-exception`, { reason: reason.trim() }), onSuccess: () => { setOpen(false); setReason(""); onDone(); } });
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Authorise exception…</Button>
      {open && (
        <Modal title="Release the patient with money outstanding" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600"><T>Final billing is not reconciled. The patient may leave only if you, as authorised billing / finance, accept it. The amounts outstanding now are recorded with your reason. The bill is not changed and still has to be settled.</T></p>
            <Field label="Reason" hint="At least 10 characters. This is recorded permanently and audited."><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <ErrorNote error={m.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 10} loading={m.isPending} onClick={() => m.mutate()}>Authorise exception</Button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Physical exit: the ward nurse or patient transport confirms when the discharged patient actually left (empty time = now). */
function DepartureForm({ admissionId, death, onDone }: { admissionId: string; death: boolean; onDone: () => void }) {
  const [mode, setMode] = useState(death ? "BODY_RELEASED" : "WHEELCHAIR");
  const [when, setWhen] = useState("");
  const [escort, setEscort] = useState("");
  const t = useT();
  const m = useMutation({
    mutationFn: () => api.post(`/admissions/${admissionId}/discharge/departure`, { mode, ...(when ? { departedAt: new Date(when).toISOString() } : {}), ...(escort.trim() ? { escortedBy: escort.trim() } : {}) }),
    onSuccess: onDone,
  });
  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 p-2" data-testid="departure-form">
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="How the patient left" className="w-44" value={mode} onChange={(e) => setMode(e.target.value)}>
          {death ? <option value="BODY_RELEASED">{t("Body released")}</option> : <>
            <option value="WALKED">{t("Walked out")}</option><option value="WHEELCHAIR">{t("Wheelchair")}</option><option value="STRETCHER">{t("Stretcher")}</option><option value="AMBULANCE">{t("Ambulance")}</option>
          </>}
        </Select>
        <Input aria-label="Left at" type="datetime-local" className="w-52" value={when} onChange={(e) => setWhen(e.target.value)} />
        <Input aria-label="Escorted by" placeholder={t("Escorted by (optional)")} className="w-48" value={escort} onChange={(e) => setEscort(e.target.value)} />
      </div>
      <ErrorNote error={m.error} />
      <Button variant="secondary" loading={m.isPending} onClick={() => m.mutate()}>Confirm departure</Button>
      <p className="text-xs text-slate-500"><T>Leave the time empty for “now”. It cannot be before the discharge or in the future, and it cannot be changed afterwards. Confirming the departure frees the bed for cleaning.</T></p>
    </div>
  );
}

/**
 * Post-discharge: the Medical Records Department codes the final diagnoses in ICD-10 (pre-filled from the signed summary) and signs the record off
 * as complete. Only once the record is ready; the codes are kept with the sign-off and never changed.
 */
function RecordsCompleteButton({ admissionId, ready, suggested, onDone }: { admissionId: string; ready: boolean; suggested: { text: string; code?: string }[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ diagnosis: string; icd10: string }[]>([]);
  const [primary, setPrimary] = useState(0);
  const start = () => { setRows(suggested.length ? suggested.map((s) => ({ diagnosis: s.text, icd10: s.code ?? "" })) : [{ diagnosis: "", icd10: "" }]); setPrimary(0); setOpen(true); };
  const valid = rows.length > 0 && rows.every((r) => r.diagnosis.trim().length >= 2 && /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(r.icd10.trim().toUpperCase()));
  const m = useMutation({
    mutationFn: () => api.post(`/admissions/${admissionId}/discharge/records-complete`, { codes: rows.map((r, i) => ({ diagnosis: r.diagnosis.trim(), icd10: r.icd10.trim().toUpperCase(), primary: i === primary })) }),
    onSuccess: () => { setOpen(false); onDone(); },
  });
  return (
    <div className="mt-2">
      <Button variant="secondary" disabled={!ready} onClick={start}>Mark records complete…</Button>
      {!ready && <div className="text-xs text-slate-500"><T>Available when the summary is signed, no drafts are left and the departure is recorded.</T></div>}
      {open && (
        <Modal title="Code the diagnoses and complete the record" onClose={() => setOpen(false)}>
          <div className="space-y-3" data-testid="coding-form">
            <p className="text-sm text-slate-600"><T>Check each final diagnosis and its ICD-10 code (for example K35.8). Mark the primary diagnosis. The codes are kept with the record and cannot be changed afterwards.</T></p>
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input type="radio" aria-label={`Primary diagnosis ${i + 1}`} checked={primary === i} onChange={() => setPrimary(i)} />
                <Input aria-label={`Diagnosis ${i + 1}`} className="min-w-[14rem] flex-1" value={r.diagnosis} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, diagnosis: e.target.value } : x))} />
                <Input aria-label={`ICD-10 code ${i + 1}`} className="w-28" placeholder="ICD-10" value={r.icd10} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, icd10: e.target.value.toUpperCase() } : x))} />
                {rows.length > 1 && <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setPrimary(0); }}>remove</button>}
              </div>
            ))}
            <Button variant="ghost" onClick={() => setRows([...rows, { diagnosis: "", icd10: "" }])}>Add a diagnosis</Button>
            <ErrorNote error={m.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button><Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>Complete the record</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Post-discharge: where the paper record goes next (received in MRD, filed, issued, returned). Only the next allowed move is offered. */
function RecordFileControl({ admissionId, next, onDone }: { admissionId: string; next: string[]; onDone: () => void }) {
  const action = next[0]!;
  const [where, setWhere] = useState("");
  const t = useT();
  const label: Record<string, string> = { RECEIVED: "Receive the record file", FILED: "File it", ISSUED: "Issue it", RETURNED: "Mark it returned" };
  const m = useMutation({
    mutationFn: () => api.post(`/admissions/${admissionId}/discharge/record-file`, { action, ...(action === "FILED" ? { location: where.trim() } : {}), ...(action === "ISSUED" ? { issuedTo: where.trim() } : {}) }),
    onSuccess: () => { setWhere(""); onDone(); },
  });
  const needs = action === "FILED" || action === "ISSUED";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="record-file">
      {needs && <Input aria-label={action === "FILED" ? "Filed at" : "Issued to"} className="w-48" placeholder={t(action === "FILED" ? "Rack / shelf" : "Issued to (person, department)")} value={where} onChange={(e) => setWhere(e.target.value)} />}
      <Button variant="secondary" disabled={needs && where.trim().length < 2} loading={m.isPending} onClick={() => m.mutate()}>{label[action] ?? action}</Button>
      <ErrorNote error={m.error} />
    </div>
  );
}

function DischargePanel({ adm, refresh }: { adm: Admission; refresh: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const open = adm.status === "ADMITTED";
  // Pharmacy and billing clear themselves from work done on other screens, so keep the checklist fresh while it is open.
  const st = useQuery({ queryKey: ["discharge", adm.id], queryFn: () => api.get<Discharge>(`/admissions/${adm.id}/discharge`), refetchInterval: open ? 10_000 : false });
  // An authorised financial exception releases the patient while final billing still shows money outstanding: say so plainly.
  const releasedByException = !!st.data?.steps.some((x) => x.step === "FINANCIAL_RELEASE" && x.status === "WAIVED") && st.data?.steps.find((x) => x.step === "BILLING")?.status === "PENDING";
  const sum = useQuery({ queryKey: ["summary", adm.id], queryFn: () => api.get<SummaryDoc>(`/admissions/${adm.id}/discharge-summary`), enabled: can("CONSULTATION_READ") });
  const [content, setContent] = useState<SummaryContent>({});
  const [loaded, setLoaded] = useState(false);
  const [dtype, setDtype] = useState("ROUTINE");
  useEffect(() => {
    if (sum.data && !loaded) { setContent(sum.data.document?.content ?? { finalDiagnoses: sum.data.suggested.finalDiagnoses }); setLoaded(true); }
  }, [sum.data, loaded]);
  const reload = () => { void qc.invalidateQueries({ queryKey: ["discharge", adm.id] }); void qc.invalidateQueries({ queryKey: ["summary", adm.id] }); void qc.invalidateQueries({ queryKey: ["admission", adm.id] }); };
  /** Refresh everything, and only reload the form once the saved summary has actually arrived (otherwise the form is reset from the old copy and shows blank, and signing would then sign blank text). */
  const resyncSummary = async () => { await qc.invalidateQueries({ queryKey: ["summary", adm.id] }); setLoaded(false); reload(); };
  const [handoverNote, setHandoverNote] = useState("");
  const clear = useMutation({
    // The nurse's handover note travels with the nursing clearance (the server needs 3 or more characters, so shorter text is left out).
    mutationFn: (step: string) => api.post(`/admissions/${adm.id}/discharge/clear`, { step, ...(step === "NURSING" && handoverNote.trim().length >= 3 ? { note: handoverNote.trim() } : {}) }),
    onSuccess: () => { setHandoverNote(""); reload(); },
  });
  // The pharmacist puts back a medicine charge that went missing, so the stage reconciles without a waiver.
  const repost = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/discharge/pharmacy/repost-charges`), onSuccess: reload });
  const finalBill = useMutation({ mutationFn: () => api.post<{ invoice: { id: string } }>(`/admissions/${adm.id}/discharge/final-invoice`), onSuccess: reload });
  const complete = useMutation({ mutationFn: () => api.post(`/admissions/${adm.id}/discharge/complete`, { type: dtype }), onSuccess: () => { reload(); refresh(); } });
  const save = useMutation({
    mutationFn: () => api.put<{ version: number }>(`/admissions/${adm.id}/discharge-summary`, { content: { ...content, finalDiagnoses: content.finalDiagnoses ?? [], procedures: content.procedures ?? [], dischargeMedications: content.dischargeMedications ?? [] }, ...(sum.data?.document ? { version: sum.data.document.version } : {}) }),
    onSuccess: async () => { await resyncSummary(); },
  });
  // The RMO verifies the signed copy (the server refuses the person who signed it).
  const verifySummary = useMutation({
    mutationFn: () => api.post(`/admissions/${adm.id}/discharge-summary/verify`, { version: sum.data!.document!.currentVersion }),
    onSuccess: async () => { await resyncSummary(); },
  });
  const signSummary = useMutation({
    mutationFn: async () => { const s = await save.mutateAsync(); return api.post(`/admissions/${adm.id}/discharge-summary/sign`, { version: s.version }); },
    onSuccess: async () => { await resyncSummary(); },
  });
  const stepPerm: Record<string, string> = { MEDICALLY_FIT: "ADMISSION_DISCHARGE", NURSING: "NURSING_DOCUMENT", CHARGES_REVIEWED: "CHARGE_CREATE", PHARMACY: "PHARMACY_DISPENSE" };
  const signed = sum.data?.document && sum.data.document.status !== "DRAFT";
  if (st.isLoading) return <Spinner />;
  const d = st.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Discharge checklist">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="discharge-stages">
            <thead><tr className="border-b border-slate-200 text-xs uppercase text-slate-500"><th className="py-2 pr-3 font-medium"><T>Stage</T></th><th className="py-2 pr-3 font-medium"><T>Responsible person/team</T></th><th className="py-2 font-medium"><T>HIS status and clearance</T></th></tr></thead>
            <tbody>
              {d?.steps.flatMap((s) => [
                ...(s.step === "NURSING" && d.summary ? [(
                  <tr key="SUMMARY" data-testid="summary-stage" className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-3 font-medium"><T>{d.summary.stage}</T> {!d.summary.required && <span className="text-xs font-normal text-slate-400">(optional)</span>}<div className="mt-0.5 text-xs font-normal text-slate-500"><T>{d.summary.description}</T></div></td>
                    <td className="py-2 pr-3 text-slate-700"><T>{d.summary.responsible}</T></td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2"><StatusBadge value={d.summary.status} /><span><T>{d.summary.hisStatus}</T></span></div>
                      {d.summary.preparedByName && <div className="text-xs text-slate-500">Prepared by {d.summary.preparedByName}</div>}
                      {d.summary.signedByName && <div className="text-xs text-slate-500">Signed by {d.summary.signedByName}{d.summary.signedAt ? ` · ${new Date(d.summary.signedAt).toLocaleString()}` : ""}</div>}
                      {d.summary.verifiedByName && <div className="text-xs text-slate-500">Verified by {d.summary.verifiedByName}{d.summary.verifiedAt ? ` · ${new Date(d.summary.verifiedAt).toLocaleString()}` : ""}</div>}
                      {d.summary.verificationRequired && d.summary.status !== "VERIFIED" && <div className="text-xs text-amber-700">⚠ This hospital requires verification before discharge</div>}
                    </td>
                  </tr>
                )] : []),
                (
                <tr key={s.step} className="border-b border-slate-100 align-top last:border-0">
                  <td className="py-2 pr-3 font-medium"><T>{s.stage ?? s.step.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</T> {!s.required && <span className="text-xs font-normal text-slate-400">(optional)</span>}{s.description && <div className="mt-0.5 text-xs font-normal text-slate-500"><T>{s.description}</T></div>}</td>
                  <td className="py-2 pr-3 text-slate-700"><T>{s.responsible ?? "—"}</T></td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-2">{s.step === "FINANCIAL_RELEASE" && s.status === "WAIVED" ? <Badge tone="amber">exception</Badge> : <StatusBadge value={s.status} />}<span><T>{s.hisStatus ?? ""}</T></span>{open && s.status === "PENDING" && !s.automatic && can(stepPerm[s.step] ?? "ADMISSION_DISCHARGE") && <Button variant="secondary" loading={clear.isPending} onClick={() => clear.mutate(s.step)}>Clear</Button>}{open && s.status === "PENDING" && (s.waivable ?? (!s.automatic && s.step !== "MEDICALLY_FIT")) && can("ADMISSION_DISCHARGE") && <WaiveButton admissionId={adm.id} step={s.step} onDone={reload} />}{open && s.step === "FINANCIAL_RELEASE" && s.status === "PENDING" && can("DISCHARGE_FINANCIAL_EXCEPTION") && <FinancialExceptionButton admissionId={adm.id} onDone={reload} />}</div>
                    {s.checks && s.checks.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs" data-testid="nursing-checks">
                        {s.checks.map((c) => <li key={c.name} className={c.ok ? "text-emerald-700" : "text-amber-700"}>{c.ok ? "✓" : "○"} <span className="font-medium"><T>{c.name}</T>:</span> {c.detail}</li>)}
                      </ul>
                    )}
                    {open && s.step === "NURSING" && s.status === "PENDING" && can("NURSING_DOCUMENT") && (
                      <Input aria-label="Handover note" className="mt-2" placeholder="Handover note (optional)" maxLength={300} value={handoverNote} onChange={(e) => setHandoverNote(e.target.value)} />
                    )}
                    {open && s.step === "PHARMACY" && s.status === "PENDING" && (s.reconciliation?.problems.length ?? 0) > 0 && can("PHARMACY_DISPENSE") && (
                      <div className="mt-2"><Button variant="secondary" loading={repost.isPending} onClick={() => repost.mutate()}>Re-post missing charges</Button><ErrorNote error={repost.error} /></div>
                    )}
                    {s.status !== "PENDING" && (s.byName || s.at) && <div className="text-xs text-slate-500">{s.status === "WAIVED" ? (s.step === "FINANCIAL_RELEASE" ? "Exception authorised" : "Waived") : "Cleared"}{s.byName ? ` by ${s.byName}` : ""}{s.at ? ` · ${new Date(s.at).toLocaleString()}` : ""}</div>}
                    {s.status !== "PENDING" && s.note && <div className="text-xs text-slate-500">{s.note}</div>}
                    {s.blockers.map((b) => <div key={b} className="text-xs text-amber-700">⚠ {b}</div>)}
                  </td>
                </tr>
                ),
                ...(s.step === "FINANCIAL_RELEASE" && d.exit ? [(
                  <tr key="EXIT" data-testid="exit-stage" className="border-b border-slate-100 align-top last:border-0">
                    <td className="py-2 pr-3 font-medium"><T>{d.exit.stage}</T><div className="mt-0.5 text-xs font-normal text-slate-500"><T>{d.exit.description}</T></div></td>
                    <td className="py-2 pr-3 text-slate-700"><T>{d.exit.responsible}</T></td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={d.exit.status === "CONFIRMED" ? "green" : d.exit.status === "PENDING" ? "amber" : "gray"}>{d.exit.status === "CONFIRMED" ? "confirmed" : d.exit.status === "PENDING" ? "pending" : d.exit.status === "NOT_DUE" ? "not yet due" : "not applicable"}</Badge><span><T>{d.exit.hisStatus}</T></span></div>
                      {d.exit.departedAt && <div className="text-xs text-slate-600">Left {new Date(d.exit.departedAt).toLocaleString()} · {d.exit.modeLabel}{d.exit.escortedBy ? ` · escorted by ${d.exit.escortedBy}` : ""}{d.exit.minutesAfterDischarge !== null ? ` · ${d.exit.minutesAfterDischarge} min after discharge` : ""}</div>}
                      {d.exit.byName && <div className="text-xs text-slate-500">Confirmed by {d.exit.byName}{d.exit.at ? ` · ${new Date(d.exit.at).toLocaleString()}` : ""}</div>}
                      {d.exit.note && <div className="text-xs text-slate-500">{d.exit.note}</div>}
                      {d.exit.status === "PENDING" && can("DISCHARGE_DEPARTURE_CONFIRM") && <DepartureForm admissionId={adm.id} death={d.dischargeType === "DEATH"} onDone={reload} />}
                    </td>
                  </tr>
                )] : []),
                ...(s.step === "FINANCIAL_RELEASE" && d.turnover ? [(
                  <tr key="TURNOVER" data-testid="turnover-stage" className="border-b border-slate-100 align-top last:border-0">
                    <td className="py-2 pr-3 font-medium"><T>{d.turnover.stage}</T><div className="mt-0.5 text-xs font-normal text-slate-500"><T>{d.turnover.description}</T></div></td>
                    <td className="py-2 pr-3 text-slate-700"><T>{d.turnover.responsible}</T></td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={d.turnover.status === "READY" ? "green" : d.turnover.status === "CLEANING" ? "amber" : d.turnover.status === "VACATED" ? "red" : "gray"}>{d.turnover.status === "READY" ? "ready" : d.turnover.status === "CLEANING" ? "cleaning" : d.turnover.status === "VACATED" ? "vacated" : d.turnover.status === "NOT_DUE" ? "not yet due" : d.turnover.status === "AWAITING_DEPARTURE" ? "bed kept" : "not applicable"}</Badge><span><T>{d.turnover.hisStatus}</T></span></div>
                      {d.turnover.bed && <div className="text-xs text-slate-600">{d.turnover.bed}{d.turnover.vacatedAt ? ` · vacated ${new Date(d.turnover.vacatedAt).toLocaleString()}` : " · freed when the departure is confirmed"}</div>}
                      {d.turnover.cleaningStartedAt && d.turnover.cleaningStartedBy && <div className="text-xs text-slate-500">Cleaning started by {d.turnover.cleaningStartedBy} · {new Date(d.turnover.cleaningStartedAt).toLocaleString()}</div>}
                      {d.turnover.readyAt && <div className="text-xs text-slate-500">Ready{d.turnover.readyBy ? ` by ${d.turnover.readyBy}` : ""} · {new Date(d.turnover.readyAt).toLocaleString()}{d.turnover.minutesToReady !== null ? ` · ${d.turnover.minutesToReady} min after vacated` : ""}</div>}
                      {(d.turnover.status === "VACATED" || d.turnover.status === "CLEANING") && can("BED_HOUSEKEEPING") && <Link className="text-xs text-brand-700 hover:underline" href="/housekeeping">Open housekeeping</Link>}
                    </td>
                  </tr>
                )] : []),
                ...(s.step === "FINANCIAL_RELEASE" && d.postDischarge ? [(
                  <tr key="POST" data-testid="post-discharge-stage" className="border-b border-slate-100 align-top last:border-0">
                    <td className="py-2 pr-3 font-medium"><T>{d.postDischarge.stage}</T><div className="mt-0.5 text-xs font-normal text-slate-500"><T>{d.postDischarge.description}</T></div></td>
                    <td className="py-2 pr-3 text-slate-700"><T>{d.postDischarge.responsible}</T></td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2"><Badge tone={d.postDischarge.status === "CLOSED" ? "green" : d.postDischarge.status === "TRACKING" ? "blue" : d.postDischarge.status === "RECORDS_PENDING" ? "amber" : "gray"}>{d.postDischarge.status === "CLOSED" ? "closed" : d.postDischarge.status === "TRACKING" ? "tracking" : d.postDischarge.status === "RECORDS_PENDING" ? "records pending" : d.postDischarge.status === "NOT_DUE" ? "not yet due" : "not applicable"}</Badge><span><T>{d.postDischarge.hisStatus}</T></span></div>
                      {d.postDischarge.status !== "NOT_DUE" && d.postDischarge.status !== "NOT_APPLICABLE" && (
                        <ul className="mt-1 space-y-0.5 text-xs">{d.postDischarge.checks.map((c) => <li key={c.name} className={c.ok ? "text-emerald-700" : "text-amber-700"}>{c.ok ? "✓" : "○"} <span className="font-medium"><T>{c.name}</T>:</span> {c.detail}</li>)}</ul>
                      )}
                      {d.postDischarge.recordCompletedAt && <div className="text-xs text-slate-500">Record signed off{d.postDischarge.recordCompletedBy ? ` by ${d.postDischarge.recordCompletedBy}` : ""} · {new Date(d.postDischarge.recordCompletedAt).toLocaleString()}</div>}
                      {d.postDischarge.status === "RECORDS_PENDING" && can("MRD_RECORD_COMPLETE") && <RecordsCompleteButton admissionId={adm.id} ready={d.postDischarge.recordReady} suggested={d.postDischarge.suggestedDiagnoses ?? []} onDone={reload} />}
                      {(d.postDischarge.file?.nextActions.length ?? 0) > 0 && can("MRD_RECORD_COMPLETE") && <RecordFileControl admissionId={adm.id} next={d.postDischarge.file!.nextActions} onDone={reload} />}
                    </td>
                  </tr>
                )] : []),
              ])}
            </tbody>
          </table>
        </div>
        <ErrorNote error={clear.error} />
        {open && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
            {!d?.finalInvoice ? (can("IPD_FINAL_BILL") ? <Button variant="secondary" loading={finalBill.isPending} onClick={() => finalBill.mutate()}>Generate final bill</Button> : null) : <Link className="text-sm text-brand-700 hover:underline" href={`/billing/${d.finalInvoice.id}`}>Open final bill</Link>}
            <ErrorNote error={finalBill.error} />
            {d && !d.canComplete && d.blockers.length > 0 && <Notice tone="warn"><T>Before discharge</T>: {d.blockers.join("; ")}.</Notice>}
            {d?.canComplete && releasedByException && <Notice tone="warn"><T>Released by an authorised financial exception: the bill is still outstanding and has to be settled. The discharge can go ahead.</T></Notice>}
            {d?.canComplete && !releasedByException && !can("ADMISSION_DISCHARGE") && <Notice tone="success">Everything is cleared and paid. The patient is still admitted, and the bed stays occupied, until a doctor presses “Discharge patient”. Ask the doctor to open this screen.</Notice>}
            {can("ADMISSION_DISCHARGE") && (
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Discharge type" className="w-44" value={dtype} onChange={(e) => setDtype(e.target.value)}>{["ROUTINE", "LAMA", "REFERRED", "ABSCONDED", "DEATH"].map((t) => <option key={t}>{t}</option>)}</Select>
                <ConfirmButton variant="primary" label="Discharge patient" confirmLabel="Yes, discharge the patient" disabled={!d?.canComplete} loading={complete.isPending} onConfirm={() => complete.mutate()} />
              </div>
            )}
            <ErrorNote error={complete.error} />
          </div>
        )}
        {!open && <p className="mt-3 text-sm text-slate-600">This admission is {adm.status.toLowerCase()}. {d?.finalInvoice && <Link className="text-brand-700 hover:underline" href={`/billing/${d.finalInvoice.id}`}>Final bill</Link>}</p>}
        {adm.status === "DISCHARGED" && money("0") && <p className="mt-2 space-x-3"><a className="text-sm text-brand-700 hover:underline" href={printUrl(`discharge-summaries/${adm.id}`)} target="_blank" rel="noreferrer">Print discharge summary</a><a className="text-sm text-brand-700 hover:underline" href={`${printUrl(`discharge-summaries/${adm.id}`)}?format=pdf&download=1`}>Download PDF</a></p>}
      </Card>
      <TestsCard adm={adm} open={open} />
      <ProceduresCard adm={adm} open={open} />
      <InsuranceCard adm={adm} open={open} />
      {can("CONSULTATION_READ") && (
        <Card title="Discharge summary" actions={signed ? <span className="flex flex-wrap gap-1"><Badge tone="green">signed by {sum.data?.document?.signedByName}</Badge>{sum.data?.document?.verified && <Badge tone="green">verified by {sum.data.document.verifiedByName}</Badge>}</span> : undefined}>
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
            {open && signed && !sum.data?.document?.verified && can("CONSULTATION_VERIFY") && (
              <div className="flex flex-wrap items-center gap-2">
                <ConfirmButton variant="primary" label="Verify summary" confirmLabel="Yes, verify" loading={verifySummary.isPending} onConfirm={() => verifySummary.mutate()} />
                <span className="text-xs text-slate-500">Confirms the signed copy is complete and correct. The person who signed it cannot verify it.</span>
              </div>
            )}
            <ErrorNote error={save.error ?? signSummary.error ?? verifySummary.error} />
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
