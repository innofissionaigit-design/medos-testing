"use client";
import { useState } from "react";
import { Input, Select } from "./ui";

/**
 * Standard cancellation reasons, so the same thing is always written the same way and can be counted. The words are what gets recorded with the cancellation.
 * "Other" is always last and asks for a few words of explanation.
 */
export const CANCEL_REASONS = {
  /** Taking a patient out of the OPD queue. */
  visit: ["Patient left without being seen", "Patient went to another hospital or doctor", "Patient will come on another day", "Doctor not available", "Registered by mistake", "Duplicate entry"],
  /** Cancelling a booked appointment. */
  appointment: ["Patient asked to cancel", "Patient could not be reached", "Doctor not available", "Booked by mistake", "Duplicate booking", "Patient is admitted or referred elsewhere"],
  /** Cancelling a bill. */
  bill: ["Wrong patient", "Wrong item or amount", "Duplicate bill", "Service was not provided", "Patient declined the service"],
  /** Cancelling an admission. */
  admission: ["Admitted by mistake", "Patient decided not to be admitted", "Referred to another hospital", "Bed not available", "Treatment not needed"],
  /** Cancelling a video consultation. */
  video: ["Patient asked to cancel", "Doctor not available", "Technical problem", "Booked by mistake", "Patient could not be reached"],
} as const;

const OTHER = "__other__";
export const OTHER_MIN = 5;

/** What is recorded for a choice: the standard wording, or, for "Other", what was typed. Empty until a usable reason has been given. */
export function reasonText(choice: string, other: string): string {
  if (choice === OTHER) return other.trim().length >= OTHER_MIN ? other.trim() : "";
  return choice;
}

/**
 * A drop-down of standard reasons, with "Other" for anything else (which then asks for a few words). `onChange` gets the reason to record, or "" while none has
 * been chosen yet (or "Other" has no explanation yet), so a parent can keep its confirm button disabled on an empty reason.
 */
export function ReasonSelect({ reasons, onChange, label = "Reason", className, autoFocus }: { reasons: readonly string[]; onChange: (reason: string) => void; label?: string; className?: string; autoFocus?: boolean }) {
  const [choice, setChoice] = useState("");
  const [other, setOther] = useState("");
  const pick = (c: string, o: string) => { setChoice(c); setOther(o); onChange(reasonText(c, o)); };
  return (
    <div className={className ?? "space-y-2"}>
      <Select aria-label={label} autoFocus={autoFocus} value={choice} onChange={(e) => pick(e.target.value, other)}>
        <option value="">Choose a reason…</option>
        {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        <option value={OTHER}>Other…</option>
      </Select>
      {choice === OTHER && <Input aria-label={`${label}: other`} placeholder={`Say what the reason is (at least ${OTHER_MIN} letters)`} value={other} onChange={(e) => pick(choice, e.target.value)} />}
    </div>
  );
}
