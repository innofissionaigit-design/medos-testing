"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DoctorPicker } from "@/components/doctor-picker";
import { DuplicateBookingNotice, isDuplicateBooking } from "@/components/booking-guard";
import { PatientPicker, type PickedPatient } from "@/components/pickers";
import { Button, ErrorNote, Field, Modal } from "@/components/ui";
import { api, newKey } from "@/lib/api";

/** Start a new OPD visit: pick the patient, then the department, then a doctor of that department, and add the patient to that doctor's queue. */
export function WalkIn({ onClose, title = "Walk-in patient", onDone }: { onClose: () => void; title?: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [doc, setDoc] = useState("");
  const [key] = useState(newKey);
  const go = useMutation({
    mutationFn: (override?: string) => api.post("/appointments/walk-in", { patientId: patient!.id, practitionerId: doc, ...(override ? { duplicateOverride: { reason: override } } : {}) }, key),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["appointments"] }); await qc.invalidateQueries({ queryKey: ["queue"] }); onDone?.(); onClose(); },
  });
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus /></Field>
        <DoctorPicker value={doc} onChange={setDoc} />
        {isDuplicateBooking(go.error) ? <DuplicateBookingNotice error={go.error} pending={go.isPending} onOverride={(r) => go.mutate(r)} /> : <ErrorNote error={go.error} />}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc} loading={go.isPending} onClick={() => go.mutate(undefined)}>Check in and add to queue</Button></div>
      </div>
    </Modal>
  );
}
