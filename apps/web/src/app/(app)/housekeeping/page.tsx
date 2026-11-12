"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { HousekeepingRequests } from "@/components/housekeeping-requests";
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Turnover { id: string; bed: string; ward: string; room: string; stage: "VACATED" | "CLEANING" | "READY"; autoReady: boolean; vacatedAt: string; cleaningStartedAt: string | null; cleaningStartedBy: string | null; readyAt: string | null; readyBy: string | null; minutesToReady: number | null }

/**
 * Housekeeping (docs/discharge-stages.md, bed turnover): the beds vacated by a discharge, oldest first: start cleaning, then mark ready, which makes the
 * bed available again. Beds only: housekeeping never sees who the patient was.
 */
export default function HousekeepingPage() {
  const { dateTime, can } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bed-turnovers"], queryFn: () => api.get<Turnover[]>("/bed-turnovers"), refetchInterval: 15_000, enabled: can("BED_HOUSEKEEPING") });
  const done = () => { void qc.invalidateQueries({ queryKey: ["bed-turnovers"] }); };
  const start = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/start`, {}), onSuccess: done });
  const ready = useMutation({ mutationFn: (id: string) => api.post(`/bed-turnovers/${id}/ready`, {}), onSuccess: done });
  const rows = q.data ?? [];
  const open = rows.filter((r) => r.stage !== "READY");
  const recent = rows.filter((r) => r.stage === "READY");
  const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))} min ago`;
  return (
    <Gate anyOf={["BED_HOUSEKEEPING", "HOUSEKEEPING_REQUEST", "HOUSEKEEPING_MANAGE"]} feature="IPD_ENABLED">
      <PageHeader title="Housekeeping" />
      <HousekeepingRequests />
      {can("BED_HOUSEKEEPING") && <>
      <Card title={`${t("Beds to turn around")} (${open.length})`}>
        {q.isLoading ? <Spinner /> : open.length === 0 ? <p className="text-sm text-slate-500"><T>No beds waiting. Every vacated bed is ready.</T></p> : (
          <Table head={["Bed", "Ward · room", "Vacated", "Stage", ""]}>
            {open.map((r) => (
              <tr key={r.id} data-testid="turnover-row">
                <Td><b>{r.bed}</b></Td>
                <Td>{r.ward} · {r.room}</Td>
                <Td>{dateTime(r.vacatedAt)} <span className="text-xs text-slate-500">({ago(r.vacatedAt)})</span></Td>
                <Td>{r.stage === "VACATED" ? <Badge tone="red">vacated</Badge> : <Badge tone="amber">cleaning</Badge>}{r.cleaningStartedBy && <div className="text-xs text-slate-500"><T>started by</T> {r.cleaningStartedBy}{r.cleaningStartedAt ? ` · ${dateTime(r.cleaningStartedAt)}` : ""}</div>}</Td>
                <Td>{r.stage === "VACATED"
                  ? <Button variant="secondary" loading={start.isPending && start.variables === r.id} onClick={() => start.mutate(r.id)}>Start cleaning</Button>
                  : <Button loading={ready.isPending && ready.variables === r.id} onClick={() => ready.mutate(r.id)}>Mark ready</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
        <ErrorNote error={start.error ?? ready.error} />
        <p className="mt-2 text-xs text-slate-500"><T>Vacated, cleaning, ready: start the cleaning when you begin, mark the bed ready when it can take the next patient. Ready makes the bed available.</T></p>
      </Card>
      {recent.length > 0 && (
        <Card title="Made ready in the last 24 hours">
          <Table head={["Bed", "Ward · room", "Ready", "Turnaround", "By"]}>
            {recent.map((r) => (
              <tr key={r.id}><Td><b>{r.bed}</b></Td><Td>{r.ward} · {r.room}</Td><Td>{r.readyAt ? dateTime(r.readyAt) : "—"}</Td><Td>{r.minutesToReady !== null ? `${r.minutesToReady} min` : "—"}</Td><Td>{r.autoReady ? "automatic" : r.readyBy ?? "—"}</Td></tr>
            ))}
          </Table>
        </Card>
      )}
      </>}
    </Gate>
  );
}
