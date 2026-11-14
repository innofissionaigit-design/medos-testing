"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CANCEL_REASONS, ReasonSelect } from "@/components/reason-select";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Notice, Spinner, Table, Td } from "./ui";

interface Row { id: string; patient: string; mrn: string | null; doctor: string; scheduledAt: string; status: string; consented: boolean; doctorJoined: boolean; patientJoined: boolean; patientWaiting: boolean; identityChecked: boolean; feeStatus: string; feeDue: string; canJoin: boolean; windowOpensAt: string }
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
  const list = useQuery({ queryKey: ["teleconsults"], queryFn: () => api.get<{ items: Row[] }>("/teleconsults", { pageSize: 50 }), refetchInterval: 5_000 });
  const [reason, setReason] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [method, setMethod] = useState("KNOWN_PATIENT");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["teleconsults"] }); };
  const join = useMutation({ mutationFn: (v: { id: string; identityMethod?: string }) => api.post<{ url: string; patientJoined: boolean }>(`/teleconsults/${v.id}/join`, v.identityMethod ? { identityMethod: v.identityMethod } : {}, newKey()), onSuccess: (r) => { setChecking(null); window.open(r.url, "_blank", "noopener,noreferrer"); refresh(); } });
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
              <Td><Badge tone={TONE[r.status] ?? "gray"}>{r.status.replace("_", " ").toLowerCase()}</Badge><div className="text-xs text-slate-500">{r.patientJoined ? "patient is in the call" : r.patientWaiting ? <span className="font-semibold text-green-800">patient is waiting</span> : r.consented ? "patient agreed" : r.status === "SCHEDULED" ? `opens ${dateTime(r.windowOpensAt)}` : ""}</div>{r.feeStatus === "PENDING" && r.status === "SCHEDULED" && <div className="text-xs text-amber-800">fee {r.feeDue} to pay</div>}{r.identityChecked && <div className="text-xs text-slate-500">identity checked</div>}</Td>
              <Td className="whitespace-nowrap">
                {r.canJoin && !r.doctorJoined && checking !== r.id && <Button onClick={() => { setChecking(r.id); setMethod("KNOWN_PATIENT"); }}>Start call</Button>}
                {r.canJoin && !r.doctorJoined && checking === r.id && (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <label className="text-xs text-slate-600" htmlFor={`idm-${r.id}`}>I have confirmed who the patient is:</label>
                    <select id={`idm-${r.id}`} className="rounded border border-slate-300 px-1 py-1 text-xs" value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="KNOWN_PATIENT">I know this patient</option><option value="PHOTO_ID_SHOWN">Photo ID shown on camera</option><option value="APP_SIGN_IN">Signed in to the patient app</option><option value="OTHER">Other</option>
                    </select>
                    <Button loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id, identityMethod: method })}>Confirm and start</Button>
                    <Button variant="ghost" onClick={() => setChecking(null)}>Back</Button>
                  </span>
                )}
                {r.canJoin && r.doctorJoined && <Button loading={join.isPending && join.variables?.id === r.id} onClick={() => join.mutate({ id: r.id })}>Rejoin call</Button>}
                {r.status === "IN_PROGRESS" && can("TELE_CONDUCT") && <> <Button variant="secondary" onClick={() => end.mutate(r.id)}>End call</Button></>}
                {r.status === "SCHEDULED" && can("TELE_MANAGE") && <span className="inline-flex items-center gap-1"><ReasonSelect reasons={CANCEL_REASONS.video} label="Reason to cancel" className="w-56 space-y-1" onChange={(v) => setReason((all) => ({ ...all, [r.id]: v }))} /><Button variant="secondary" disabled={(reason[r.id]?.trim().length ?? 0) < 5} onClick={() => cancel.mutate(r.id)}>Cancel</Button></span>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
