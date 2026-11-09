"use client";
import { useState } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Match { appointmentId: string; startAt: string; doctor: string; mrn: string | null; patientName: string; rule: "SAME_DOCTOR" | "SAME_DEPARTMENT_SAME_DAY"; match: "SAME_PATIENT" | "LIKELY_SAME_PERSON" }

/** True when the server stopped a booking as a possible duplicate (docs/duplicate-booking.md). */
export const isDuplicateBooking = (e: unknown): e is ApiError => e instanceof ApiError && e.code === "DUPLICATE_BOOKING_SUSPECTED";

/**
 * Shown instead of the plain error when a booking looks like a duplicate: which bookings it clashes with and why, and, for staff allowed to,
 * a way to book anyway with a reason (recorded in the audit trail).
 */
export function DuplicateBookingNotice({ error, onOverride, pending }: { error: unknown; onOverride: (reason: string) => void; pending: boolean }) {
  const { can, dateTime } = useMe();
  const [reason, setReason] = useState("");
  if (!isDuplicateBooking(error)) return null;
  const matches = ((error.details as { matches?: Match[] } | undefined)?.matches ?? []);
  return (
    <div className="space-y-2">
      <Notice tone="warn">
        <div className="font-medium">{error.message}</div>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {matches.map((m) => (
            <li key={m.appointmentId}>
              {m.match === "SAME_PATIENT" ? "This patient" : `${m.patientName} (MRN ${m.mrn ?? "—"}), likely the same person`}
              {" · "}{m.doctor}{" · "}{dateTime(m.startAt)}
              {" · "}{m.rule === "SAME_DOCTOR" ? "same doctor" : "same department, same day"}
            </li>
          ))}
        </ul>
      </Notice>
      {can("DUPLICATE_OVERRIDE") ? (
        <div className="flex items-end gap-2">
          <Field label="Book anyway: reason" className="flex-1"><Input value={reason} maxLength={240} onChange={(e) => setReason(e.target.value)} placeholder="For example: a second procedure on another day" /></Field>
          <Button variant="secondary" loading={pending} disabled={reason.trim().length < 3} onClick={() => onOverride(reason.trim())}>Book anyway</Button>
        </div>
      ) : <p className="text-xs text-slate-500">Use the existing booking. Someone with permission to override duplicates can book anyway.</p>}
    </div>
  );
}
