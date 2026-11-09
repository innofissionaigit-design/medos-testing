"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { VitalsCard } from "@/components/ipd-extras";
import { Badge, Button, Card, ErrorNote, Modal, Field, Input, Notice, PageHeader, Spinner, StatusBadge, Table, Td } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Entry {
  id: string; tokenNumber: number; priority: "NORMAL" | "PRIORITY" | "EMERGENCY"; status: string; patientName: string; mrn: string | null; gender: string;
  practitionerName: string; departmentName: string | null; waitingMinutes: number | null; encounterId?: string | null; patientId?: string; tokenDate?: string;
}

const PRIORITY_TONE = { NORMAL: "gray", PRIORITY: "amber", EMERGENCY: "red" } as const;

export default function QueuePage() {
  const router = useRouter();
  const { can, me } = useMe();
  const qc = useQueryClient();
  const [doctor, setDoctor] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  // Nurses record the vitals of an OPD patient from here: they cannot open the doctor's visit page.
  const [vitalsFor, setVitalsFor] = useState<{ encounterId: string; patient: string } | null>(null);
  const [reason, setReason] = useState("");
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: me.facility?.timezone ?? me.tenant.timezone });
  const list = useQuery({ queryKey: ["queue", doctor], queryFn: () => api.get<Entry[]>("/queue", doctor ? { practitionerId: doctor } : undefined), refetchInterval: 15_000 });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string; userId: string | null }[]>("/practitioners") });
  // A doctor opens on their own patients; reception (QUEUE_MANAGE) keeps the all-doctors view. The filter can still be changed.
  const [defaulted, setDefaulted] = useState(false);
  useEffect(() => {
    if (defaulted || !docs.data) return;
    const mine = docs.data.find((d) => d.userId === me.id);
    if (mine && !can("QUEUE_MANAGE")) setDoctor(mine.id);
    setDefaulted(true);
  }, [defaulted, docs.data, me.id, can]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["queue"] });
  // Set when "Complete" is refused because the consultation or its prescription is still unsigned: signing happens on the visit page.
  const [signFirst, setSignFirst] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown; encounterId?: string | null }) => api.post<{ encounterId?: string | null }>(`/queue/${id}/${action}`, body),
    onMutate: () => setSignFirst(null),
    onSuccess: async (r, v) => { await refresh(); if (v.action === "start" && r?.encounterId) router.push(`/visits/${r.encounterId}`); },
    onError: (e, v) => { if (v.action === "complete" && v.encounterId && e instanceof ApiError && e.code === "INVALID_STATE") setSignFirst(v.encounterId); },
  });
  const callNext = useMutation({ mutationFn: () => api.post("/queue/call-next", doctor ? { practitionerId: doctor } : {}), onSuccess: refresh });
  const priority = useMutation({ mutationFn: ({ id, priority }: { id: string; priority: string }) => api.patch(`/queue/${id}/priority`, { priority }), onSuccess: refresh });
  const manage = can("QUEUE_MANAGE");
  const canPrioritise = can("QUEUE_PRIORITY");
  const clinician = can("CONSULTATION_CREATE");

  return (
    <Gate anyOf={["QUEUE_READ"]}>
      <PageHeader
        title="OPD queue" subtitle="Today’s patients, refreshed automatically"
        actions={<>
          <select aria-label="Filter by doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
            <option value="">All doctors</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
          </select>
          {(manage || clinician) && <Button loading={callNext.isPending} onClick={() => callNext.mutate()}>Call next patient</Button>}
        </>}
      />
      {signFirst && (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>This visit cannot be completed yet. Open the visit, click Sign consultation to send the prescription to the pharmacy, then complete the visit.</span>
            <Button onClick={() => router.push(`/visits/${signFirst}`)}>Open visit to sign</Button>
          </div>
        </Notice>
      )}
      {(list.data ?? []).some((e) => e.status === "IN_CONSULTATION" && e.tokenDate && e.tokenDate < todayStr) && (
        <Notice tone="warn">An earlier consultation is still open (marked with its date below). A doctor can only have one open consultation, so new patients cannot be started until it is completed: open the visit, sign it if needed, then press Complete.</Notice>
      )}
      <ErrorNote error={(signFirst ? null : act.error) ?? callNext.error ?? priority.error} />
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Token", "Patient", "Doctor", "Status", "Waiting", ""]} {...(list.data?.length === 0 ? { empty: "Nobody is in the queue." } : {})}>
            {list.data?.map((e) => {
              const waiting = e.status === "WAITING";
              const called = e.status === "CALLED";
              const inConsult = e.status === "IN_CONSULTATION";
              return (
                <tr key={e.id} className={e.priority === "EMERGENCY" ? "bg-red-50" : ""}>
                  <Td><span className="text-lg font-semibold">{e.tokenNumber}</span> {e.tokenDate && e.tokenDate < todayStr && <Badge tone="amber">from {e.tokenDate}</Badge>} {e.priority !== "NORMAL" && <Badge tone={PRIORITY_TONE[e.priority]}>{e.priority.toLowerCase()}</Badge>}</Td>
                  <Td>{e.patientId ? <Link className="font-medium text-brand-700 hover:underline" href={`/patients/${e.patientId}`}>{e.patientName}</Link> : <span className="font-medium">{e.patientName}</span>} <span className="text-slate-500">· {e.mrn}</span></Td>
                  <Td>{e.practitionerName}<div className="text-xs text-slate-500">{e.departmentName}</div></Td>
                  <Td><StatusBadge value={e.status} /></Td>
                  <Td>{e.waitingMinutes !== null ? `${e.waitingMinutes} min` : "—"}</Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {(waiting || called) && (manage || clinician) && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "call" })}>{called ? "Recall" : "Call"}</Button>}
                      {(waiting || called) && clinician && <Button onClick={() => act.mutate({ id: e.id, action: "start" })}>Start</Button>}
                      {inConsult && e.encounterId && can("CONSULTATION_READ") && <Button onClick={() => router.push(`/visits/${e.encounterId}`)}>Open visit</Button>}
                      {inConsult && clinician && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "complete", encounterId: e.encounterId })}>Complete</Button>}
                      {(waiting || called) && canPrioritise && (
                        <select aria-label={`Priority for ${e.patientName}`} value={e.priority} disabled={priority.isPending} onChange={(ev) => priority.mutate({ id: e.id, priority: ev.target.value })} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
                          <option value="NORMAL">Normal</option><option value="PRIORITY">Priority</option><option value="EMERGENCY">Emergency</option>
                        </select>
                      )}
                      {(waiting || called || inConsult) && e.encounterId && can("VITALS_CREATE") && !can("CONSULTATION_READ") && <Button variant="secondary" onClick={() => setVitalsFor({ encounterId: e.encounterId as string, patient: e.patientName })}>Record vitals</Button>}
                      {(waiting || called) && manage && <Button variant="ghost" onClick={() => act.mutate({ id: e.id, action: "skip" })}>Skip</Button>}
                      {e.status === "SKIPPED" && manage && <Button variant="secondary" onClick={() => act.mutate({ id: e.id, action: "requeue" })}>Requeue</Button>}
                      {(waiting || called || e.status === "SKIPPED") && manage && <Button variant="ghost" onClick={() => { setCancelId(e.id); setReason(""); }}>Cancel</Button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      {cancelId && (
        <Modal title="Cancel this visit?" onClose={() => setCancelId(null)}>
          <div className="space-y-3">
            <Field label="Reason"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. patient left" /></Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelId(null)}>Keep in queue</Button>
              <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => { act.mutate({ id: cancelId, action: "cancel", body: { reason: reason.trim() } }); setCancelId(null); }}>Cancel visit</Button>
            </div>
          </div>
        </Modal>
      )}
      {vitalsFor && (
        <Modal title={`Vitals: ${vitalsFor.patient}`} onClose={() => setVitalsFor(null)} wide>
          <VitalsCard encounterId={vitalsFor.encounterId} open />
        </Modal>
      )}
    </Gate>
  );
}
