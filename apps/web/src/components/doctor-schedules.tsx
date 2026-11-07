"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Card, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface Doc { id: string; displayName: string; specialty: string | null; scheduleSet: boolean }
interface Win { dayOfWeek: number; start: string; end: string; slotMinutes: number }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Read-only weekly schedule of every doctor, for staff who book appointments but may not change schedules (that stays with the administrator). */
export function DoctorSchedules() {
  const t = useT();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const schedules = useQueries({ queries: (docs.data ?? []).map((d) => ({ queryKey: ["schedule", d.id], queryFn: () => api.get<Win[]>(`/practitioners/${d.id}/schedule`) })) });
  return (
    <Card title="Doctors' weekly schedules">
      {docs.isLoading ? <Spinner /> : (docs.data ?? []).length === 0 ? <p className="text-sm text-slate-500">{t("No doctors yet.")}</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {(docs.data ?? []).map((d, i) => {
            const wins = schedules[i]?.data;
            return (
              <li key={d.id} className="py-2">
                <div className="font-medium">{d.displayName}{d.specialty ? <span className="font-normal text-slate-500"> · {d.specialty}</span> : null}</div>
                {schedules[i]?.isLoading ? <div className="text-xs text-slate-400">…</div> : !wins || wins.length === 0
                  ? <div className="text-xs text-slate-500">{t(d.scheduleSet ? "Not available on any day" : "No weekly schedule: bookable at any time")}</div>
                  : <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600">{DAYS.map((name, day) => {
                    const w = wins.filter((x) => x.dayOfWeek === day);
                    return w.length ? <span key={day}>{t(name)} {w.map((x) => `${x.start}–${x.end} (${x.slotMinutes} min)`).join(", ")}</span> : null;
                  })}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
