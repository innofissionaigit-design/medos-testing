"use client";
import { CANCEL_REASONS, ReasonSelect } from "@/components/reason-select";
import { DoctorPicker } from "@/components/doctor-picker";
import { WalkIn } from "@/components/walk-in";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apptStatus, RemindersModal } from "@/components/follow-up-extras";
import { Gate } from "@/components/gate";
import { PatientPicker, todayIn, type PickedPatient } from "@/components/pickers";
import { FeeLine, SkipFeeModal, TakeFeeModal, type FeeInfo } from "@/components/booking-fee-extras";
import { DuplicateBookingNotice, isDuplicateBooking } from "@/components/booking-guard";
import { GiveBackDeposit } from "@/components/advance-extras";
import { AppointmentRequestsCard } from "@/components/appointment-requests";
import { DoctorSchedules, filterDoctors } from "@/components/doctor-schedules";
import { MakeVideoButton } from "@/components/telemedicine";
import { Button, Card, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Appt extends FeeInfo { practitionerId: string; id: string; startAt: string; status: string; patientName: string; mrn: string | null; practitionerName: string; departmentName: string | null; type: string; patientId: string; version: number; followUpOfVisit: { encounterNumber: string } | null }
interface Slot { startAt: string; endAt: string; available: boolean }
interface Doc { id: string; displayName: string; departmentId?: string | null }

interface Booked { startAt: string; patientName: string; practitionerName: string }

/** The UTC moment of a wall-clock time ("2026-11-05", "09:40") in a time zone. */
function zonedToIso(day: string, hm: string, tz: string): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = hm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (shown - guess)).toISOString();
}

function Book({ date, onClose, onBooked }: { date: string; onClose: () => void; onBooked: (b: Booked) => void }) {
  const qc = useQueryClient();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [doc, setDoc] = useState("");
  const [day, setDay] = useState(date);
  const [slot, setSlot] = useState("");
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }), enabled: !!doc });
  const { dateTime, can, me } = useMe();
  // An exception: a time outside the doctor's free times, for people who hold APPOINTMENT_OVERBOOK. It needs a reason and is audited.
  const [exception, setException] = useState(false);
  const [exTime, setExTime] = useState("09:00");
  const [exMinutes, setExMinutes] = useState("15");
  const [exReason, setExReason] = useState("");
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  // One key for one exact request: if the answer is lost and the button is pressed again, the first booking is returned instead of a second attempt failing as "already booked".
  const keys = useRef(new Map<string, string>());
  const book = useMutation({
    mutationFn: (override?: string) => {
      const chosen = slots.data?.find((s) => s.startAt === slot);
      const minutes = chosen ? Math.round((new Date(chosen.endAt).getTime() - new Date(chosen.startAt).getTime()) / 60_000) : undefined;
      const body = exception
        ? { patientId: patient!.id, practitionerId: doc, startAt: zonedToIso(day, exTime, tz), durationMinutes: Number(exMinutes), overbook: { reason: exReason.trim() }, ...(override ? { duplicateOverride: { reason: override } } : {}) }
        : { patientId: patient!.id, practitionerId: doc, startAt: slot, ...(minutes ? { durationMinutes: minutes } : {}), ...(override ? { duplicateOverride: { reason: override } } : {}) };
      const sig = JSON.stringify(body);
      if (!keys.current.has(sig)) keys.current.set(sig, newKey());
      return api.post<Booked>("/appointments", body, keys.current.get(sig));
    },
    onSuccess: async (b) => { await qc.invalidateQueries({ queryKey: ["appointments"] }); onBooked(b); onClose(); },
    // Someone else may have just taken the time: show what is free now and make the person choose again.
    onError: async (e) => { if ((e as { code?: string }).code === "SLOT_UNAVAILABLE") { await qc.invalidateQueries({ queryKey: ["slots"] }); setSlot(""); } },
  });
  return (
    <Modal title="Book appointment" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field></div>
        <DoctorPicker value={doc} onChange={(id) => { setDoc(id); setSlot(""); }} />
        <Field label="Date"><Input type="date" value={day} min={date} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
        {can("APPOINTMENT_OVERBOOK") && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={exception} onChange={(e) => setException(e.target.checked)} /> Book outside the free times (exception, needs a reason)</label>
        )}
        {exception && (
          <div className="grid grid-cols-3 gap-2 sm:col-span-2">
            <Field label="Time"><Input type="time" aria-label="Exception time" value={exTime} onChange={(e) => setExTime(e.target.value)} /></Field>
            <Field label="Minutes"><Input inputMode="numeric" aria-label="Exception minutes" value={exMinutes} onChange={(e) => setExMinutes(e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="Why is this an exception?"><Input aria-label="Exception reason" placeholder="e.g. urgent referral" value={exReason} onChange={(e) => setExReason(e.target.value)} /></Field>
          </div>
        )}
        <div className={exception ? "hidden" : "sm:col-span-2"}>
          <div className="mb-1 text-sm font-medium text-slate-700">Time</div>
          {!doc ? <p className="text-sm text-slate-500">Choose a doctor to see free times.</p> : slots.isLoading ? <Spinner /> : slots.data?.length === 0 ? <p className="text-sm text-slate-500">This doctor does not see patients on that day.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {slots.data?.map((s) => (
                <button key={s.startAt} disabled={!s.available} onClick={() => setSlot(s.startAt)} className={`rounded border px-2 py-1 text-sm ${slot === s.startAt ? "border-brand-600 bg-brand-600 text-white" : s.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"}`}>
                  {dateTime(s.startAt).split(", ").pop()}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="sm:col-span-2">{isDuplicateBooking(book.error) ? <DuplicateBookingNotice error={book.error} pending={book.isPending} onOverride={(r) => book.mutate(r)} /> : <ErrorNote error={book.error} />}</div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc || (exception ? exReason.trim().length < 3 || !exTime || Number(exMinutes) < 5 : !slot)} loading={book.isPending} onClick={() => book.mutate(undefined)}>Book</Button></div>
      </div>
    </Modal>
  );
}

/** Move a booked appointment to another time (and optionally another doctor). The version guards against concurrent changes. */
function Reschedule({ appt, today, onClose, onMoved }: { appt: Appt; today: string; onClose: () => void; onMoved: (b: Booked) => void }) {
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const [doc, setDoc] = useState(appt.practitionerId);
  const [day, setDay] = useState(today);
  const [slot, setSlot] = useState("");
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }) });
  const move = useMutation({
    mutationFn: (override?: string) => api.patch<Booked>(`/appointments/${appt.id}`, { version: appt.version, startAt: slot, ...(doc !== appt.practitionerId ? { practitionerId: doc } : {}), ...(override ? { duplicateOverride: { reason: override } } : {}) }),
    onSuccess: async (b) => { await qc.invalidateQueries({ queryKey: ["appointments"] }); onMoved(b); onClose(); },
  });
  return (
    <Modal title={`Reschedule — ${appt.patientName}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <p className="text-sm text-slate-500 sm:col-span-2">Currently {dateTime(appt.startAt)} with {appt.practitionerName}.</p>
        <DoctorPicker value={doc} onChange={(id) => { setDoc(id); setSlot(""); }} />
        <Field label="Date"><Input type="date" min={today} value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
        <div className="sm:col-span-2">
          <div className="mb-1 text-sm font-medium text-slate-700">New time</div>
          {slots.isLoading ? <Spinner /> : slots.data?.length === 0 ? <p className="text-sm text-slate-500">No sessions on that day.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {slots.data?.map((s) => (
                <button key={s.startAt} disabled={!s.available} onClick={() => setSlot(s.startAt)} className={`rounded border px-2 py-1 text-sm ${slot === s.startAt ? "border-brand-600 bg-brand-600 text-white" : s.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"}`}>{dateTime(s.startAt).split(", ").pop()}</button>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500 sm:col-span-2">An appointment can be moved later (postponed) or earlier (preponed), but never to a date or time that has already passed. Past times are greyed out.</p>
        <div className="sm:col-span-2">{isDuplicateBooking(move.error) ? <DuplicateBookingNotice error={move.error} pending={move.isPending} onOverride={(r) => move.mutate(r)} /> : <ErrorNote error={move.error} />}</div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Keep as is</Button><Button disabled={!slot} loading={move.isPending} onClick={() => move.mutate(undefined)}>Move appointment</Button></div>
      </div>
    </Modal>
  );
}
export default function AppointmentsPage() {
  const { me, can, dateTime } = useMe();
  const qc = useQueryClient();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const [date, setDate] = useState(today);
  const [doctor, setDoctor] = useState("");
  const [dept, setDept] = useState("");
  const [modal, setModal] = useState<"book" | "walkin" | null>(null);
  const [cancel, setCancel] = useState<Appt | null>(null);
  const [moving, setMoving] = useState<Appt | null>(null);
  const [reason, setReason] = useState("");
  const [followUpsOnly, setFollowUpsOnly] = useState(false);
  const [reminders, setReminders] = useState<Appt | null>(null);
  const [takingFee, setTakingFee] = useState<Appt | null>(null);
  const [skippingFee, setSkippingFee] = useState<Appt | null>(null);
  const [givingBack, setGivingBack] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The list shows one day. After booking or moving, go to that day so the appointment is on screen, and say what happened.
  const showDay = (b: Booked, verb: string) => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(b.startAt));
    setDate(day);
    setDoctor("");
    setDept("");
    setFollowUpsOnly(false);
    setNotice(`${verb}: ${b.patientName} with ${b.practitionerName} on ${dateTime(b.startAt)}.${day !== today ? ` Showing ${day}.` : ""}`);
  };
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const list = useQuery({ queryKey: ["appointments", date, doctor, followUpsOnly], queryFn: () => api.page<Appt>("/appointments", { date, ...(doctor ? { practitionerId: doctor } : {}), ...(followUpsOnly ? { type: "FOLLOW_UP" } : {}), pageSize: 100 }) });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ id: string; name: string }[]>("/departments") });
  // Only departments that have a doctor; the doctor list follows the department, and the day's list follows both.
  const deptChoices = depts.data?.filter((d) => docs.data?.some((x) => x.departmentId === d.id)) ?? [];
  const doctorChoices = filterDoctors(docs.data ?? [], dept, "");
  const inDept = dept && !doctor ? new Set(doctorChoices.map((d) => d.id)) : null;
  const shownAppts = (list.data?.data ?? []).filter((a) => !inDept || inDept.has(a.practitionerId));
  const refresh = () => qc.invalidateQueries({ queryKey: ["appointments"] });
  const act = useMutation({ mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post(`/appointments/${id}/${action}`, body), onSuccess: async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["queue"] }); } });
  return (
    <Gate anyOf={["APPOINTMENT_READ"]}>
      <PageHeader
        title="Appointments"
        actions={<>
          {can("APPOINTMENT_CREATE") && <Button variant="secondary" onClick={() => setModal("walkin")}>Walk-in</Button>}
          {can("APPOINTMENT_CREATE") && <Button onClick={() => setModal("book")}>Book appointment</Button>}
        </>}
      />
      <div className="mb-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Department">
          <Select aria-label="Department filter" value={dept} onChange={(e) => { setDept(e.target.value); setDoctor(""); }}><option value="">All departments</option>{deptChoices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        </Field>
        <Field label="Doctor">
          <Select aria-label="Doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)}><option value="">{dept ? "All doctors in this department" : "All doctors"}</option>{doctorChoices.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select>
        </Field>
        <Field label="Date">
          <Input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Show">
          <Select aria-label="Appointment type" value={followUpsOnly ? "FOLLOW_UP" : ""} onChange={(e) => setFollowUpsOnly(e.target.value === "FOLLOW_UP")}><option value="">All appointments</option><option value="FOLLOW_UP">Follow-ups only</option></Select>
        </Field>
      </div>
      <AppointmentRequestsCard />
      <div className="mb-4 mt-4"><DoctorSchedules departmentId={dept} doctorId={doctor} /></div>
      <ErrorNote error={act.error} />
      {notice && <Notice tone="success"><span className="mr-3">{notice}</span><button className="text-sm underline" onClick={() => setNotice(null)}>Dismiss</button></Notice>}
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Time", "Patient", "Doctor", "Status", ""]} {...(shownAppts.length === 0 && !list.isLoading ? { empty: "No appointments on this day." } : {})}>
            {shownAppts.map((a) => (
              <tr key={a.id}>
                <Td>{dateTime(a.startAt).split(", ").pop()}</Td>
                <Td>
                  <span className="font-medium">{a.patientName}</span> <span className="text-slate-500">· {a.mrn}</span>
                  {a.type === "FOLLOW_UP" && <div className="text-xs text-brand-700">Follow-up{a.followUpOfVisit ? ` of visit ${a.followUpOfVisit.encounterNumber}` : ""}</div>}
                  <FeeLine a={a} />
                </Td>
                <Td>{a.practitionerName}<div className="text-xs text-slate-500">{a.departmentName}</div></Td>
                <Td><StatusBadge value={apptStatus(a)} /></Td>
                <Td>
                  <div className="flex justify-end gap-1.5">
                    {a.type === "FOLLOW_UP" && <Button variant="ghost" onClick={() => setReminders(a)}>Reminders</Button>}
                    {a.status === "BOOKED" && <MakeVideoButton appointmentId={a.id} />}
                    {a.status === "CANCELLED" && a.feeHeld?.depositId && Number(a.feeHeld.amount) > 0 && can("PAYMENT_REFUND") && <Button variant="secondary" onClick={() => setGivingBack(a.feeHeld?.depositId ?? null)}>Give back fee</Button>}
                    {a.status === "BOOKED" && a.feeStatus === "PENDING" && can("PAYMENT_CREATE") && <Button variant="secondary" onClick={() => setTakingFee(a)}>Take fee</Button>}
                    {a.status === "BOOKED" && a.feeStatus === "PENDING" && can("BOOKING_FEE_SKIP") && <Button variant="ghost" onClick={() => setSkippingFee(a)}>Skip fee…</Button>}
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE", "QUEUE_MANAGE") && <Button disabled={a.feeStatus === "PENDING"} title={a.feeStatus === "PENDING" ? "Collect or skip the booking fee first" : undefined} onClick={() => act.mutate({ id: a.id, action: "check-in" })}>Check in</Button>}
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE") && <Button variant="ghost" onClick={() => setMoving(a)}>Reschedule</Button>}
                    {a.status === "BOOKED" && can("APPOINTMENT_UPDATE") && <Button variant="ghost" onClick={() => act.mutate({ id: a.id, action: "no-show" })}>No-show</Button>}
                    {["BOOKED", "CHECKED_IN"].includes(a.status) && can("APPOINTMENT_CANCEL") && <Button variant="ghost" onClick={() => { setCancel(a); setReason(""); }}>Cancel</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {modal === "book" && <Book date={today} onClose={() => setModal(null)} onBooked={(b) => showDay(b, "Booked")} />}
      {modal === "walkin" && <WalkIn onClose={() => setModal(null)} />}
      {moving && <Reschedule appt={moving} today={today} onClose={() => setMoving(null)} onMoved={(b) => showDay(b, "Moved")} />}
      {givingBack && <GiveBackDeposit depositId={givingBack} onClose={() => setGivingBack(null)} onDone={() => { setGivingBack(null); void refresh(); }} />}
      {takingFee && <TakeFeeModal appointmentId={takingFee.id} due={takingFee.feeDue} patientName={takingFee.patientName} onClose={() => setTakingFee(null)} onDone={() => { setTakingFee(null); void refresh(); }} />}
      {skippingFee && <SkipFeeModal appointmentId={skippingFee.id} fee={skippingFee.bookingFee ?? "0"} patientName={skippingFee.patientName} onClose={() => setSkippingFee(null)} onDone={() => setSkippingFee(null)} />}
      {reminders && <RemindersModal appointmentId={reminders.id} patientName={reminders.patientName} onClose={() => setReminders(null)} />}
      {cancel && (
        <Modal title={`Cancel appointment for ${cancel.patientName}?`} onClose={() => setCancel(null)}>
          <div className="space-y-3">
            <Field label="Reason"><ReasonSelect reasons={CANCEL_REASONS.appointment} onChange={setReason} autoFocus /></Field>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCancel(null)}>Keep</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => { act.mutate({ id: cancel.id, action: "cancel", body: { reason: reason.trim() } }); setCancel(null); }}>Cancel appointment</Button></div>
          </div>
        </Modal>
      )}
    </Gate>
  );
}
