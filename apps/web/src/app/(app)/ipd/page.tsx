"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Gate } from "@/components/gate";
import { PatientPicker, useAvailableBeds, type PickedPatient } from "@/components/pickers";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td } from "@/components/ui";
import { api, newKey } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Bed { id: string; code: string; status: string; dailyRate: string; occupant: { admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; since: string; awaitingDeparture?: boolean } | null }
interface Board { wards: { id: string; name: string; rooms: { id: string; name: string; beds: Bed[] }[] }[]; summary: Record<string, number> }
interface AdmissionRow { id: string; admissionNumber: string; patientName: string; mrn: string | null; consultantName: string; reason: string | null; admittedAt: string; lengthOfStayDays: number; bed: { code: string; ward: string; room: string } | null; status: string }

const BED_STYLE: Record<string, string> = {
  AVAILABLE: "border-green-300 bg-green-50", OCCUPIED: "border-blue-300 bg-blue-50", CLEANING: "border-amber-300 bg-amber-50", RESERVED: "border-purple-300 bg-purple-50", MAINTENANCE: "border-slate-300 bg-slate-100 text-slate-500",
};

function Admit({ initial, onClose }: { initial: PickedPatient | null; onClose: () => void }) {
  const router = useRouter();
  const { money } = useMe();
  const [patient, setPatient] = useState<PickedPatient | null>(initial);
  const [doc, setDoc] = useState("");
  const [bed, setBed] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string }[]>("/practitioners") });
  const beds = useAvailableBeds();
  const m = useMutation({ mutationFn: () => api.post<{ id: string }>("/admissions", { patientId: patient!.id, consultantId: doc, bedId: bed, ...(reason ? { reason } : {}) }, key), onSuccess: (a) => router.push(`/ipd/${a.id}`) });
  return (
    <Modal title="Admit patient" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field as="div" label="Patient"><PatientPicker value={patient} onPick={setPatient} autoFocus={!initial} /></Field></div>
        <Field label="Consultant"><Select value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Choose…</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
        <Field label="Bed"><Select value={bed} onChange={(e) => setBed(e.target.value)}><option value="">Choose an available bed…</option>{beds.data?.map((b) => <option key={b.id} value={b.id}>{b.label} — {money(b.dailyRate)}/day</option>)}</Select></Field>
        <div className="sm:col-span-2"><Field label="Reason for admission"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
        <div className="sm:col-span-2"><ErrorNote error={m.error} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!patient || !doc || !bed} loading={m.isPending} onClick={() => m.mutate()}>Admit</Button></div>
      </div>
    </Modal>
  );
}

function IpdInner() {
  const { can, dateTime } = useMe();
  const t = useT();
  const qc = useQueryClient();
  const params = useSearchParams();
  const pre = params.get("admit");
  const [tab, setTab] = useState<"board" | "list">("board");
  const [admit, setAdmit] = useState(!!pre);
  const preP = useQuery({ queryKey: ["pre-patient", pre], queryFn: () => api.get<{ id: string; mrn: string | null; firstName: string; lastName: string | null }>(`/patients/${pre}`), enabled: !!pre });
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<Board>("/beds/board"), enabled: tab === "board", refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ["admissions"], queryFn: () => api.page<AdmissionRow>("/admissions", { status: "ADMITTED", pageSize: 100 }), enabled: tab === "list" });
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/beds/${id}/status`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }) });
  return (
    <Gate anyOf={["ADMISSION_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Admissions and beds" actions={can("ADMISSION_CREATE") ? <Button onClick={() => setAdmit(true)}>Admit patient</Button> : undefined} />
      <Tabs tabs={[{ id: "board", label: "Bed board" }, { id: "list", label: "Admitted patients" }]} value={tab} onChange={setTab} />
      {tab === "board" && (board.isLoading ? <Spinner /> : board.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">{Object.entries(board.data.summary).map(([k, v]) => <span key={k} className="rounded-full bg-white px-3 py-1 shadow-sm ring-1 ring-slate-200">{k === "total" ? t("Total") : t(k.toLowerCase())}: <b>{v}</b></span>)}</div>
          <ErrorNote error={setStatus.error} />
          {board.data.wards.map((w) => (
            <Card key={w.id} title={w.name}>
              {w.rooms.map((r) => (
                <div key={r.id} className="mb-3 last:mb-0">
                  <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">{r.name}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {r.beds.map((b) => (
                      <div key={b.id} className={clsx("rounded-md border p-2 text-sm", BED_STYLE[b.status])}>
                        <div className="flex items-center justify-between"><b>{b.code}</b><StatusBadge value={b.status} /></div>
                        {b.occupant ? <Link href={`/ipd/${b.occupant.admissionId}`} className="mt-1 block text-brand-700 hover:underline">{b.occupant.patientName}<div className="text-xs text-slate-600">{b.occupant.mrn} · {t("since")} {dateTime(b.occupant.since)}</div>{b.occupant.awaitingDeparture && <div className="mt-0.5"><Badge tone="amber">discharged, awaiting departure</Badge></div>}</Link> : null}
                        {b.status === "CLEANING" && can("NURSING_DOCUMENT", "ADMIN_MASTERS") && <button className="mt-1 text-xs text-brand-700 hover:underline" onClick={() => setStatus.mutate({ id: b.id, status: "AVAILABLE" })}>Mark clean</button>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          ))}
        </div>
      ))}
      {tab === "list" && (
        <Card>
          {list.isLoading ? <Spinner /> : (
            <Table head={["Patient", "Admission", "Bed", "Consultant", "Stay", "Reason"]} {...(list.data?.data.length === 0 ? { empty: "No patients are currently admitted." } : {})}>
              {list.data?.data.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${a.id}`}>{a.patientName}</Link><div className="text-xs text-slate-500">{a.mrn}</div></Td>
                  <Td>{a.admissionNumber}<div className="text-xs text-slate-500">{dateTime(a.admittedAt)}</div></Td><Td>{a.bed ? `${a.bed.ward} · ${a.bed.code}` : "—"}</Td><Td>{a.consultantName}</Td><Td>{a.lengthOfStayDays} d</Td><Td>{a.reason ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {admit && <Admit initial={preP.data ? { id: preP.data.id, mrn: preP.data.mrn, name: [preP.data.firstName, preP.data.lastName].filter(Boolean).join(" ") } : null} onClose={() => setAdmit(false)} />}
    </Gate>
  );
}

export default function IpdPage() { return <Suspense fallback={<Spinner />}><IpdInner /></Suspense>; }
