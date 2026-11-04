"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Field, Input, Modal, Select } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";

const METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];
const label = (m: string) => m.replace("_", " ").toLowerCase();

export interface FeeInfo {
  bookingFee: string | null; feeStatus: "NOT_REQUIRED" | "PENDING" | "PAID" | "SKIPPED"; feeDue: string; feeSkip: { reason: string | null; note: string | null } | null;
  status?: string; cancelReason?: string | null;
  /** Booking-fee money still held for the patient, and the advance it sits in (to give back after a cancellation). */
  feeHeld?: { amount: string; depositId: string | null };
  /** Set when the hospital sends payment links: the deadline after which an unpaid booking is cancelled automatically. */
  paymentLink?: { status: string; dueBy: string; sendStatus: string; sentAt: string | null; placeholder: boolean } | null;
}

/** One line under the patient's name: the fee and where it stands. Nothing is shown when no fee applies. */
export function FeeLine({ a }: { a: FeeInfo }) {
  const { money, dateTime } = useMe();
  // An appointment cancelled because the fee was not paid in time says so, even though the fee line is otherwise settled.
  if (a.cancelReason === "Booking fee not paid in time") return <div className="mt-0.5 text-xs text-red-700">Cancelled automatically: the booking fee was not paid in time.</div>;
  if (a.status === "CANCELLED" && a.feeHeld && Number(a.feeHeld.amount) > 0) return <div className="mt-0.5 text-xs text-blue-800">Cancelled · booking fee {money(a.feeHeld.amount)} held for the patient, to give back</div>;
  if (a.feeStatus === "NOT_REQUIRED" || !a.bookingFee) return null;
  const tone = a.feeStatus === "PENDING" ? "amber" : a.feeStatus === "PAID" ? "green" : "gray";
  const link = a.paymentLink;
  return (
    <div className="mt-0.5 text-xs text-slate-600">
      <div className="flex flex-wrap items-center gap-1.5">
        Booking fee {money(a.bookingFee)}
        <Badge tone={tone}>{a.feeStatus === "PENDING" ? `${money(a.feeDue)} to pay` : a.feeStatus === "PAID" ? "paid" : "skipped"}</Badge>
        {a.feeSkip?.reason && <span>({a.feeSkip.reason})</span>}
      </div>
      {a.feeStatus === "PENDING" && link?.status === "PENDING" && (
        <div className="text-amber-800">
          Pay by {dateTime(link.dueBy)} or this appointment is cancelled automatically.
          {link.placeholder && <span className="text-slate-500"> WhatsApp link: placeholder, nothing is sent yet.</span>}
        </div>
      )}
    </div>
  );
}

export function TakeFeeModal({ appointmentId, due, patientName, onClose, onDone }: { appointmentId: string; due: string; patientName: string; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [rows, setRows] = useState([{ method: "CASH", amount: due, reference: "" }]);
  const [key] = useState(newKey);
  const sum = rows.reduce((n, r) => n + Math.round(Number(r.amount || 0) * 100), 0);
  const need = Math.round(Number(due) * 100);
  const take = useMutation({
    mutationFn: () => api.post(`/appointments/${appointmentId}/booking-fee`, { tenders: rows.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: r.amount, ...(r.reference ? { reference: r.reference } : {}) })) }, key),
    onSuccess: onDone,
  });
  return (
    <Modal title={`Booking fee — ${patientName}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">Fee to collect: <b>{money(due)}</b>. It is kept as the patient’s advance and can be set against the visit’s bill.</p>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select aria-label="Mode" className="col-span-4" value={r.method} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select>
            <Input aria-label="Amount" className="col-span-3" inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <Input aria-label="Reference" className="col-span-5" placeholder={r.method === "CASH" ? "—" : "Reference"} disabled={r.method === "CASH"} value={r.reference} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
          </div>
        ))}
        <ErrorNote error={take.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={sum < need} loading={take.isPending} onClick={() => take.mutate()}>Receive fee</Button></div>
      </div>
    </Modal>
  );
}

export function SkipFeeModal({ appointmentId, fee, patientName, onClose, onDone }: { appointmentId: string; fee: string; patientName: string; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["booking-fee-config"], queryFn: () => api.get<{ skipReasons: string[] }>("/booking-fee/config") });
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const skip = useMutation({
    mutationFn: () => api.post(`/appointments/${appointmentId}/booking-fee/skip`, { reason, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); onDone(); },
  });
  return (
    <Modal title={`Skip booking fee — ${patientName}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">The fee of <b>{money(fee)}</b> will not be collected for this appointment. This is recorded with your name and the reason, and cannot be undone.</p>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose a reason…</option>{cfg.data?.skipReasons.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
        </Field>
        <Field label="Note (optional)"><Input value={note} maxLength={240} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorNote error={skip.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Keep the fee</Button><Button variant="danger" disabled={!reason} loading={skip.isPending} onClick={() => skip.mutate()}>Skip fee</Button></div>
      </div>
    </Modal>
  );
}

/** Settings → booking fee: on/off, the amount, and the reasons staff can pick when skipping. */
export function BookingFeeSettings({ get, save, saving }: { get: (k: string) => { value: unknown } | undefined; save: (key: string, value: unknown) => void; saving: boolean }) {
  const enabled = get("BOOKING_FEE_ENABLED")?.value === true;
  const [amount, setAmount] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string | null>(null);
  const amountShown = amount ?? String(get("BOOKING_FEE_AMOUNT")?.value ?? "0.00");
  const reasonsShown = reasons ?? ((get("BOOKING_FEE_SKIP_REASONS")?.value as string[] | undefined) ?? []).join("\n");
  const list = reasonsShown.split("\n").map((s) => s.trim()).filter(Boolean);
  const reasonsOk = list.length >= 1 && list.length <= 20 && list.every((r) => r.length >= 3 && r.length <= 60) && new Set(list.map((r) => r.toLowerCase())).size === list.length;
  const amountOk = /^\d{1,8}(\.\d{1,2})?$/.test(amountShown.trim());
  const linkOn = get("BOOKING_PAYMENT_LINK_ENABLED")?.value === true;
  const [minutes, setMinutes] = useState<string | null>(null);
  const windowShown = minutes ?? String(get("BOOKING_PAYMENT_WINDOW_MINUTES")?.value ?? 60);
  const windowOk = /^\d{2,5}$/.test(windowShown.trim()) && Number(windowShown) >= 15 && Number(windowShown) <= 10_080;
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"><span>Ask for a booking fee when an appointment is booked</span><input type="checkbox" checked={enabled} onChange={(e) => save("BOOKING_FEE_ENABLED", e.target.checked)} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (amountOk) save("BOOKING_FEE_AMOUNT", amountShown.trim()); }}>
          <Field label="Fee amount (₹)" className="flex-1"><Input aria-label="Booking fee amount" inputMode="decimal" value={amountShown} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!amountOk || amount === null}>Save</Button>
        </form>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (reasonsOk) save("BOOKING_FEE_SKIP_REASONS", list); }}>
          <Field label="Reasons for skipping (one per line)"><textarea aria-label="Skip reasons" rows={5} className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" value={reasonsShown} onChange={(e) => setReasons(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!reasonsOk || reasons === null}>Save reasons</Button>
        </form>
      </div>
      <CancellationPolicy get={get} save={save} saving={saving} />
      <div className="space-y-2 rounded-md border border-slate-200 p-3">
        <label className="flex items-center justify-between text-sm"><span>Send a payment link on WhatsApp after booking, and cancel the appointment automatically if the fee is not paid in time</span><input type="checkbox" checked={linkOn} onChange={(e) => save("BOOKING_PAYMENT_LINK_ENABLED", e.target.checked)} /></label>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (windowOk) save("BOOKING_PAYMENT_WINDOW_MINUTES", Number(windowShown)); }}>
          <Field label="Minutes the patient has to pay (15 to 10080)" className="flex-1"><Input aria-label="Payment window minutes" inputMode="numeric" value={windowShown} onChange={(e) => setMinutes(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!windowOk || minutes === null}>Save</Button>
        </form>
        <p className="text-xs text-amber-800">Placeholder for now: the WhatsApp message is not actually sent and the link does not open a payment page. The automatic cancellation does work: staff can still collect the fee with “Take fee” before the deadline. If the patient has no mobile number, or has withdrawn consent for messages, there is no deadline.</p>
      </div>
      <p className="text-xs text-slate-500">Applies to appointments booked from now on; an appointment keeps the fee it was booked with. Follow-ups booked from a consultation and walk-ins have no booking fee. The patient cannot be checked in until the fee is paid or skipped. Only staff with the “skip booking fee” permission can skip; each skip is recorded and appears in Reports → Booking fees skipped.</p>
    </div>
  );
}

/** What happens to a paid booking fee when the booking is cancelled (docs/booking-fee.md). */
function CancellationPolicy({ get, save, saving }: { get: (k: string) => { value: unknown } | undefined; save: (key: string, value: unknown) => void; saving: boolean }) {
  const [hours, setHours] = useState<string | null>(null);
  const [percent, setPercent] = useState<string | null>(null);
  const hoursShown = hours ?? String(get("BOOKING_FEE_FREE_CANCEL_HOURS")?.value ?? 24);
  const percentShown = percent ?? String(get("BOOKING_FEE_CANCEL_CHARGE_PERCENT")?.value ?? 0);
  const hoursOk = /^\d{1,3}$/.test(hoursShown.trim()) && Number(hoursShown) <= 720;
  const percentOk = /^\d{1,3}$/.test(percentShown.trim()) && Number(percentShown) <= 100;
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="text-sm font-medium">When a paid booking is cancelled</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (hoursOk) save("BOOKING_FEE_FREE_CANCEL_HOURS", Number(hoursShown)); }}>
          <Field label="Free cancellation up to (hours before)" className="flex-1"><Input aria-label="Free cancellation hours" inputMode="numeric" value={hoursShown} onChange={(e) => setHours(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!hoursOk || hours === null}>Save</Button>
        </form>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (percentOk) save("BOOKING_FEE_CANCEL_CHARGE_PERCENT", Number(percentShown)); }}>
          <Field label="Cancellation charge after that (% of the fee)" className="flex-1"><Input aria-label="Cancellation charge percent" inputMode="numeric" value={percentShown} onChange={(e) => setPercent(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!percentOk || percent === null}>Save</Button>
        </form>
      </div>
      <p className="text-xs text-slate-500">A late cancellation creates a “cancellation charge” bill paid from the booking fee. The rest stays the patient’s money and the cashier gives it back; every step appears in the patient’s account statement.</p>
    </div>
  );
}
