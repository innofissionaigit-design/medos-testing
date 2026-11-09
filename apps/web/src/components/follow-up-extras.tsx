"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, SlotPicker, todayIn } from "./pickers";
import { Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, StatusBadge, Table, Td } from "./ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

export interface ApptRow {
  id: string; startAt: string; status: string; type: string; practitionerId: string; practitionerName: string; departmentName: string | null;
  cancelReason: string | null; followUpOfVisit: { encounterNumber: string; startedAt: string } | null;
}
interface Doc { id: string; displayName: string }
interface Reminder { id: string; offsetMinutes: number; sendAt: string; status: string; attempts: number; lastError: string | null; sentAt: string | null; logOnly: boolean }

/** A booked follow-up reads as "scheduled"; every other status is the appointment's own (the API keeps one status machine). */
export const apptStatus = (a: { type: string; status: string }): string => (a.type === "FOLLOW_UP" && a.status === "BOOKED" ? "SCHEDULED" : a.status);

const typeLabel = (t: string) => ({ CONSULTATION: "Consultation", FOLLOW_UP: "Follow-up", PROCEDURE: "Procedure" } as Record<string, string>)[t] ?? t;

const beforeLabel = (minutes: number): string => {
  const d = Math.floor(minutes / 1440); const h = Math.floor((minutes % 1440) / 60); const m = minutes % 60;
  return [d ? `${d} d` : "", h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") + " before";
};

/** Consultation screen: the follow-ups this visit ordered, and (for the treating doctor) booking a new one in a free slot. */
export function FollowUpCard({ encounterId, practitionerId, afterDays, visitStatus }: { encounterId: string; practitionerId: string | null; afterDays?: number; visitStatus: string }) {
  const { me, can, dateTime } = useMe();
  const qc = useQueryClient();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const today = todayIn(tz);
  const list = useQuery({ queryKey: ["follow-ups", encounterId], queryFn: () => api.get<ApptRow[]>(`/encounters/${encounterId}/follow-ups`) });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState(practitionerId ?? "");
  const [day, setDay] = useState(addDays(today, afterDays && afterDays > 0 ? afterDays : 7));
  const [slot, setSlot] = useState("");
  const [notes, setNotes] = useState("");
  const book = useMutation({
    mutationFn: () => api.post(`/encounters/${encounterId}/follow-ups`, { startAt: slot, ...(doc !== practitionerId ? { practitionerId: doc } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: async () => { setOpen(false); setSlot(""); setNotes(""); await qc.invalidateQueries({ queryKey: ["follow-ups", encounterId] }); await qc.invalidateQueries({ queryKey: ["appointments"] }); },
  });
  const canSchedule = can("FOLLOWUP_SCHEDULE") && visitStatus !== "CANCELLED" && !!practitionerId;
  return (
    <Card title="Follow-up" actions={canSchedule && !open ? <Button variant="secondary" onClick={() => setOpen(true)}>Schedule follow-up</Button> : undefined}>
      {list.isLoading ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : list.data?.length === 0 ? <p className="text-sm text-slate-500">No follow-up scheduled from this visit.</p> : (
        <ul className="space-y-1.5 text-sm">
          {list.data?.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{dateTime(a.startAt)}</span><span className="text-slate-500">with {a.practitionerName}</span><StatusBadge value={apptStatus(a)} />
              {a.cancelReason && <span className="text-xs text-slate-500">({a.cancelReason})</span>}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="mt-3 grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
          <Field label="Doctor"><Select value={doc} onChange={(e) => { setDoc(e.target.value); setSlot(""); }}>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
          <Field label="Date"><Input type="date" min={today} value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
          <div className="sm:col-span-2"><div className="mb-1 text-sm font-medium text-slate-700">Time</div><SlotPicker practitionerId={doc} date={day} value={slot} onPick={setSlot} /></div>
          <div className="sm:col-span-2"><Field label="Note for the follow-up (optional)"><Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><ErrorNote error={book.error} /></div>
          <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button><Button disabled={!slot || !doc} loading={book.isPending} onClick={() => book.mutate()}>Book follow-up</Button></div>
        </div>
      )}
    </Card>
  );
}

/** Reminder history of one follow-up: planned, sent, skipped (e.g. moved or cancelled) or failed. */
export function RemindersModal({ appointmentId, patientName, onClose }: { appointmentId: string; patientName: string; onClose: () => void }) {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["reminders", appointmentId], queryFn: () => api.get<Reminder[]>(`/appointments/${appointmentId}/reminders`) });
  return (
    <Modal title={`Reminders — ${patientName}`} onClose={onClose} wide>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : (
        <div className="space-y-3">
          {q.data?.some((r) => r.logOnly) && <Notice tone="warn">No SMS gateway is configured, so reminders are recorded but not actually sent (see docs/follow-ups.md).</Notice>}
          <Table head={["Send at", "When", "Status", "Attempts", "Note"]} {...(q.data?.length === 0 ? { empty: "No reminders for this appointment." } : {})}>
            {q.data?.map((r) => (
              <tr key={r.id}>
                <Td>{dateTime(r.sendAt)}</Td><Td>{beforeLabel(r.offsetMinutes)}</Td>
                <Td><StatusBadge value={r.status} />{r.logOnly && <span className="ml-1 text-xs text-slate-500">log only</span>}</Td>
                <Td>{r.attempts}</Td><Td className="text-xs text-slate-500">{r.lastError ?? ""}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Modal>
  );
}

/** Patient page: every appointment at this facility, newest first, with follow-ups tied to the visit that ordered them. */
export function AppointmentHistoryCard({ patientId }: { patientId: string }) {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["patient-appointments", patientId], queryFn: () => api.page<ApptRow>(`/patients/${patientId}/appointments`, { pageSize: 25 }) });
  return (
    <Card title="Appointments">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : (
        <Table head={["When", "Type", "Doctor", "Status"]} {...(q.data?.data.length === 0 ? { empty: "No appointments yet." } : {})}>
          {q.data?.data.map((a) => (
            <tr key={a.id}>
              <Td>{dateTime(a.startAt)}</Td>
              <Td>{typeLabel(a.type)}{a.followUpOfVisit && <div className="text-xs text-slate-500">of visit {a.followUpOfVisit.encounterNumber}</div>}</Td>
              <Td>{a.practitionerName}<div className="text-xs text-slate-500">{a.departmentName}</div></Td>
              <Td><StatusBadge value={apptStatus(a)} />{a.cancelReason && <div className="text-xs text-slate-500">{a.cancelReason}</div>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
