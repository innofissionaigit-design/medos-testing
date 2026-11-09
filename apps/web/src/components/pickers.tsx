"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { patientName, type PatientRow } from "./shell";
import { ErrorNote, Input, Spinner, useDebounced } from "./ui";

export interface PickedPatient { id: string; name: string; mrn: string | null }

/** Type-ahead patient selector (MRN, mobile or name). Calls onPick with the chosen patient. */
export function PatientPicker({ value, onPick, autoFocus }: { value: PickedPatient | null; onPick: (p: PickedPatient | null) => void; autoFocus?: boolean }) {
  const { can } = useMe();
  const t = useT();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["picker-patients", term], queryFn: () => api.page<PatientRow>("/patients", { q: term, pageSize: 6 }), enabled: term.length >= 2 && !value });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm">
        <span><span className="font-medium">{value.name}</span> <span className="text-slate-500">· {value.mrn}</span></span>
        <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { onPick(null); setQ(""); }}>change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input autoFocus={autoFocus} placeholder="Search patient by MRN, mobile or name" aria-label="Patient" value={q} onChange={(e) => setQ(e.target.value)} />
      {term.length >= 2 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {res.isLoading && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {res.data?.data.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">{t("No patients found")}{can("PATIENT_CREATE") && <> · <a className="text-brand-700 hover:underline" href="/patients?register=1" target="_blank" rel="noreferrer">{t("Register a new patient")}</a></>}</li>}
          {res.data?.data.map((p) => (
            <li key={p.id} className="cursor-pointer px-3 py-1.5 text-sm hover:bg-brand-50" onClick={() => onPick({ id: p.id, name: patientName(p), mrn: p.mrn })}>
              {patientName(p)} <span className="text-slate-500">· {p.mrn} · {p.mobile ?? "no mobile"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Today's date (YYYY-MM-DD) in a given time zone. */
export const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export const addDays = (ymd: string, days: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface Slot { startAt: string; endAt: string; available: boolean }

/** Free-time buttons for one doctor on one day (from /practitioners/:id/availability); taken and past slots are disabled. */
export function SlotPicker({ practitionerId, date, value, onPick }: { practitionerId: string; date: string; value: string; onPick: (startAt: string) => void }) {
  const { dateTime } = useMe();
  const slots = useQuery({ queryKey: ["slots", practitionerId, date], queryFn: () => api.get<Slot[]>(`/practitioners/${practitionerId}/availability`, { date }), enabled: !!practitionerId && !!date });
  if (!practitionerId) return <p className="text-sm text-slate-500">Choose a doctor to see free times.</p>;
  if (slots.isLoading) return <Spinner />;
  if (slots.error) return <ErrorNote error={slots.error} />;
  if (!slots.data?.length) return <p className="text-sm text-slate-500">This doctor does not see patients on that day.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {slots.data.map((s) => (
        <button key={s.startAt} type="button" disabled={!s.available} onClick={() => onPick(s.startAt)} className={`rounded border px-2 py-1 text-sm ${value === s.startAt ? "border-brand-600 bg-brand-600 text-white" : s.available ? "border-slate-300 hover:bg-brand-50" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 line-through"}`}>
          {dateTime(s.startAt).split(", ").pop()}
        </button>
      ))}
    </div>
  );
}

/** Available beds with readable labels, from the bed board (ward and room names are only on the board). */
export function useAvailableBeds() {
  return useQuery({
    queryKey: ["beds-available"],
    queryFn: async () => {
      const b = await api.get<{ wards: { name: string; rooms: { name: string; beds: { id: string; code: string; status: string; dailyRate: string }[] }[] }[] }>("/beds/board");
      return b.wards.flatMap((w) => w.rooms.flatMap((r) => r.beds.filter((x) => x.status === "AVAILABLE").map((x) => ({ id: x.id, label: `${w.name} · ${r.name} · ${x.code}`, dailyRate: x.dailyRate }))));
    },
  });
}