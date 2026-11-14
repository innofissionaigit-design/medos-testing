"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Field, Select } from "./ui";

interface Dept { id: string; name: string }
interface Doctor { id: string; displayName: string; specialty?: string | null; departmentId?: string | null }

/**
 * Choosing who a patient will see at the OPD: first the department, then a doctor of that department. The doctor list stays empty until a department is chosen,
 * and only shows that department's doctors, so a doctor cannot be picked from the whole hospital. Changing the department clears a doctor who does not belong to it.
 *
 * It renders two fields (Department, Doctor) for the parent's form. `value` is the chosen doctor's id ("" for none); when the doctor is already known (for example
 * when moving an appointment) the department starts as that doctor's department.
 */
export function DoctorPicker({ value, onChange }: { value: string; onChange: (doctorId: string) => void }) {
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api.get<Dept[]>("/departments") });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doctor[]>("/practitioners") });
  const [picked, setPicked] = useState<string | null>(null);
  const current = docs.data?.find((d) => d.id === value);
  const deptId = picked ?? current?.departmentId ?? "";
  // Only departments that have a doctor to choose.
  const departments = depts.data?.filter((d) => docs.data?.some((x) => x.departmentId === d.id)) ?? [];
  const doctors = deptId ? (docs.data?.filter((d) => d.departmentId === deptId) ?? []) : [];
  return (
    <>
      <Field label="Department">
        <Select aria-label="Department" value={deptId} onChange={(e) => { setPicked(e.target.value); if (current && current.departmentId !== e.target.value) onChange(""); }}>
          <option value="">Choose a department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label="Doctor">
        <Select aria-label="Doctor" value={value} disabled={!deptId} onChange={(e) => onChange(e.target.value)}>
          <option value="">{deptId ? "Choose a doctor…" : "Choose a department first"}</option>
          {doctors.map((d) => <option key={d.id} value={d.id}>{d.displayName}{d.specialty ? ` — ${d.specialty}` : ""}</option>)}
        </Select>
      </Field>
    </>
  );
}
