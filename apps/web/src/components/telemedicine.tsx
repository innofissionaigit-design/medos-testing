"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Input, Notice, Spinner, Table, Td } from "./ui";

interface Row { id: string; patient: string; mrn: string | null; doctor: string; scheduledAt: string; status: string; consented: boolean; doctorJoined: boolean; patientJoined: boolean; canJoin: boolean; windowOpensAt: string }
const TONE: Record<string, "gray" | "blue" | "green" | "red"> = { SCHEDULED: "gray", IN_PROGRESS: "blue", COMPLETED: "green", CANCELLED: "red" };

/** The button on an appointment row that makes it a video consultation. */
export function MakeVideoButton({ appointmentId }: { appointmentId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const make = useMutation({ mutationFn: () => api.post("/teleconsults", { appointmentId }), onSuccess: () => { setDone(true); void qc.invalidateQueries({ queryKey: ["teleconsults"] }); } });
  if (!can("TELE_MANAGE")) return null;
  if (done) return <Badge tone="blue">video</Badge>;
  return <><Button variant="ghost" loading={make.isPending} onClick={() => make.mutate()}>Make video</Button>{make.error ? <span className="text-xs text-red-700">{make.error instanceof Error ? make.error.message : "Could not make it"}</span> : null}</>;
}

/** Video consultations: for the doctor, their own with a Join button inside the time window; for the front desk, everything with a way to cancel. */
export function VideoConsults() {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["teleconsults"], queryFn: () => api.get<{ items: Row[] }>("/teleconsults", { pageSize: 50 }), refetchInterval: 20_000 });
  const [reason, setReason] = useState<Record<string, string>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["teleconsults"] }); };
  const join = useMutation({ mutationFn: (id: string) => api.post<{ url: string; patientJoined: boolean }>(`/teleconsults/${id}/join`, {}, newKey()), onSuccess: (r) => { window.open(r.url, "_blank", "noopener,noreferrer"); refresh(); } });
  const end = useMutation({ mutationFn: (id: string) => api.post(`/teleconsults/${id}/end`, {}, newKey()), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/teleconsults/${id}/cancel`, { reason: reason[id]?.trim() }), onSuccess: refresh });
  return (
    <Card title="Video consultations">
      <Notice>A video consultation is a normal appointment with a link. The doctor can open the call from 15 minutes before the time; the patient joins from the patient app after agreeing to a video consultation. Write the notes and prescription on the visit as usual.</Notice>
      <ErrorNote error={join.error ?? end.error ?? cancel.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["When", "Patient", "Doctor", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No video consultations. Open Appointments and press Make video on a booked appointment." } : {})}>
          {list.data?.items.map((r) => (
            <tr key={r.id}>
              <Td>{dateTime(r.scheduledAt)}</Td><Td><span className="font-medium">{r.patient}</span> <span className="text-slate-500">· {r.mrn}</span></Td><Td>{r.doctor}</Td>
              <Td><Badge tone={TONE[r.status] ?? "gray"}>{r.status.replace("_", " ").toLowerCase()}</Badge><div className="text-xs text-slate-500">{r.patientJoined ? "patient is in the call" : r.consented ? "patient agreed" : r.status === "SCHEDULED" ? `opens ${dateTime(r.windowOpensAt)}` : ""}</div></Td>
              <Td className="whitespace-nowrap">
                {r.canJoin && <Button loading={join.isPending && join.variables === r.id} onClick={() => join.mutate(r.id)}>{r.doctorJoined ? "Rejoin call" : "Start call"}</Button>}
                {r.status === "IN_PROGRESS" && can("TELE_CONDUCT") && <> <Button variant="secondary" onClick={() => end.mutate(r.id)}>End call</Button></>}
                {r.status === "SCHEDULED" && can("TELE_MANAGE") && <span className="inline-flex items-center gap-1"><Input aria-label="Reason" className="w-40" placeholder="Reason to cancel" value={reason[r.id] ?? ""} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} /><Button variant="secondary" disabled={(reason[r.id]?.trim().length ?? 0) < 5} onClick={() => cancel.mutate(r.id)}>Cancel</Button></span>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
