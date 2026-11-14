"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Card, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface Doc { id: string; displayName: string; specialty: string | null; departmentId?: string | null; scheduleSet: boolean }
interface Win { dayOfWeek: number; start: string; end: string; slotMinutes: number }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The doctors a department / doctor choice leaves: one doctor, else one department's doctors, else everyone. */
export function filterDoctors<T extends { id: string; departmentId?: string | null }>(docs: T[], departmentId: string, doctorId: string): T[] {
  if (doctorId) return docs.filter((d) => d.id === doctorId);
  if (departmentId) return docs.filter((d) => d.departmentId === departmentId);
  return docs;
}

/**
 * Read-only weekly schedule of the doctors chosen by the filters above it (department, then doctor), for staff who book appointments but may not change
 * schedules (that stays with the administrator). Each doctor appears once, with the department under the name and one cell per working day.
 */
export function DoctorSchedules({ departmentId = "", doctorId = "" }: { departmentId?: string; doctorId?: string }) {
  const t = useT();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ id: string; name: string }[]>("/departments") });
  const shown = filterDoctors(docs.data ?? [], departmentId, doctorId);
  const schedules = useQueries({ queries: shown.map((d) => ({ queryKey: ["schedule", d.id], queryFn: () => api.get<Win[]>(`/practitioners/${d.id}/schedule`) })) });
  const deptName = (id?: string | null) => depts.data?.find((x) => x.id === id)?.name ?? null;
  return (
    <Card title="Doctors' weekly schedules">
      {docs.isLoading ? <Spinner /> : shown.length === 0 ? <p className="text-sm text-slate-500">{t("No doctors yet.")}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">{t("Doctor")}</th>
                {DAYS.map((d) => <th key={d} className="px-2 py-2 font-medium">{t(d).slice(0, 3)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((d, i) => {
                const wins = schedules[i]?.data;
                const sub = deptName(d.departmentId) ?? d.specialty;
                const slots = wins ? [...new Set(wins.map((w) => w.slotMinutes))] : [];
                return (
                  <tr key={d.id} className="align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{d.displayName}</div>
                      {sub ? <div className="text-xs text-slate-500">{sub}</div> : null}
                      {slots.length === 1 ? <div className="text-xs text-slate-400">{slots[0]} {t("min slots")}</div> : null}
                    </td>
                    {schedules[i]?.isLoading ? <td colSpan={7} className="px-2 py-2 text-xs text-slate-400">…</td>
                      : !wins || wins.length === 0 ? <td colSpan={7} className="px-2 py-2 text-xs text-slate-500">{t(d.scheduleSet ? "Not available on any day" : "No weekly schedule: bookable at any time")}</td>
                        : DAYS.map((name, day) => {
                          const w = wins.filter((x) => x.dayOfWeek === day);
                          return (
                            <td key={name} className="px-2 py-2 text-xs text-slate-600">
                              {w.length ? w.map((x) => <div key={`${x.start}-${x.end}`}>{x.start}–{x.end}{slots.length > 1 ? ` (${x.slotMinutes} min)` : ""}</div>) : <span className="text-slate-300">–</span>}
                            </td>
                          );
                        })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
