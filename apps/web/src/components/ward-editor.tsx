"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Input, Notice, Select, Spinner } from "./ui";

interface Ward { id: string; name: string; code: string; status: "ACTIVE" | "INACTIVE" }
interface Room { id: string; wardId: string; name: string; code: string; status: "ACTIVE" | "INACTIVE" }
interface Bed { id: string; wardId: string; roomId: string; code: string; status: string; active: "ACTIVE" | "INACTIVE"; dailyRate: string }

const KEYS = [["wards-admin"], ["rooms-admin"], ["beds-admin"], ["board"]] as const;

/** A name that is saved only when it has really changed. */
function NameEdit({ value, label, onSave, busy }: { value: string; label: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(value);
  const changed = v.trim() !== value && v.trim().length >= 1;
  return (
    <span className="inline-flex items-center gap-1">
      <Input aria-label={label} className="w-44" value={v} onChange={(e) => setV(e.target.value)} />
      {changed && <Button variant="secondary" loading={busy} onClick={() => onSave(v.trim())}>Save</Button>}
    </span>
  );
}

function RateEdit({ value, label, onSave, busy }: { value: string; label: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(value);
  const changed = v.trim() !== value && /^\d+(\.\d{1,2})?$/.test(v.trim());
  return (
    <span className="inline-flex items-center gap-1">
      <Input aria-label={label} inputMode="decimal" className="w-24" value={v} onChange={(e) => setV(e.target.value)} />
      {changed && <Button variant="secondary" loading={busy} onClick={() => onSave(v.trim())}>Save rate</Button>}
    </span>
  );
}

/**
 * Wards, rooms and beds of this facility, switched-off ones included, so an administrator can rename them, change a bed's daily rate, switch things off and back on,
 * and put a bed in or out of maintenance. Occupied beds can't be retired and a ward or room with patients can't be switched off: the server explains why.
 */
export function WardStructure() {
  const { money } = useMe();
  const qc = useQueryClient();
  const wards = useQuery({ queryKey: ["wards-admin"], queryFn: () => api.get<Ward[]>("/wards", { includeInactive: "true" }) });
  const rooms = useQuery({ queryKey: ["rooms-admin"], queryFn: () => api.get<Room[]>("/rooms", { includeInactive: "true" }) });
  const beds = useQuery({ queryKey: ["beds-admin"], queryFn: () => api.get<Bed[]>("/beds", { includeInactive: "true" }) });
  const done = async () => { await Promise.all(KEYS.map((k) => qc.invalidateQueries({ queryKey: [...k] }))); };
  const patch = useMutation({ mutationFn: (x: { path: string; body: unknown }) => api.patch(x.path, x.body), onSuccess: done });
  const status = useMutation({ mutationFn: (x: { id: string; status: string }) => api.post(`/beds/${x.id}/status`, { status: x.status }), onSuccess: done });
  const busyPath = patch.isPending ? (patch.variables as { path: string }).path : "";
  const switchLabel = (on: boolean) => (on ? "Switch off" : "Switch on");

  if (wards.isLoading || rooms.isLoading || beds.isLoading) return <Card title="Wards, rooms and beds"><Spinner /></Card>;
  const manual = (b: Bed) => (b.status === "OCCUPIED" ? [] : ["AVAILABLE", "CLEANING", "MAINTENANCE"].filter((s) => s !== b.status));

  return (
    <Card title="Wards, rooms and beds">
      <p className="mb-3 text-xs text-slate-500">
        A bed can be used only while its ward and room are switched on. Switching off keeps the history. A bed with a patient can't be retired and a ward or room with patients in it can't be switched off.
      </p>
      <div className="space-y-4">
        {wards.data?.map((w) => (
          <div key={w.id} className="rounded border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <NameEdit value={w.name} label={`Ward name ${w.code}`} busy={busyPath === `/wards/${w.id}`} onSave={(name) => patch.mutate({ path: `/wards/${w.id}`, body: { name } })} />
              <Badge>{w.code}</Badge>
              {w.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}
              <span className="ml-auto">
                {w.status === "ACTIVE"
                  ? <ConfirmButton label={switchLabel(true)} confirmLabel="Switch ward off" onConfirm={() => patch.mutate({ path: `/wards/${w.id}`, body: { status: "INACTIVE" } })} />
                  : <Button variant="secondary" onClick={() => patch.mutate({ path: `/wards/${w.id}`, body: { status: "ACTIVE" } })}>{switchLabel(false)}</Button>}
              </span>
            </div>
            <div className="mt-2 space-y-2 pl-4">
              {rooms.data?.filter((r) => r.wardId === w.id).map((r) => (
                <div key={r.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <NameEdit value={r.name} label={`Room name ${r.code}`} busy={busyPath === `/rooms/${r.id}`} onSave={(name) => patch.mutate({ path: `/rooms/${r.id}`, body: { name } })} />
                    <Badge>{r.code}</Badge>
                    {r.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}
                    <span className="ml-auto">
                      {r.status === "ACTIVE"
                        ? <ConfirmButton label={switchLabel(true)} confirmLabel="Switch room off" onConfirm={() => patch.mutate({ path: `/rooms/${r.id}`, body: { status: "INACTIVE" } })} />
                        : <Button variant="secondary" onClick={() => patch.mutate({ path: `/rooms/${r.id}`, body: { status: "ACTIVE" } })}>{switchLabel(false)}</Button>}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-1 pl-4">
                    {beds.data?.filter((b) => b.roomId === r.id).map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <b className="w-20">{b.code}</b>
                        <RateEdit value={b.dailyRate} label={`Daily rate ${b.code}`} busy={busyPath === `/beds/${b.id}`} onSave={(dailyRate) => patch.mutate({ path: `/beds/${b.id}`, body: { dailyRate } })} />
                        <span className="text-xs text-slate-500">{money(b.dailyRate)} a day</span>
                        {b.active === "INACTIVE"
                          ? <Badge tone="red">Retired</Badge>
                          : b.status === "OCCUPIED"
                            ? <Badge tone="blue">Occupied</Badge>
                            : <Select aria-label={`Status of bed ${b.code}`} className="w-40" value={b.status} onChange={(e) => status.mutate({ id: b.id, status: e.target.value })}>
                              <option value={b.status}>{b.status.charAt(0) + b.status.slice(1).toLowerCase()}</option>
                              {manual(b).map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
                            </Select>}
                        <span className="ml-auto">
                          {b.active === "ACTIVE"
                            ? b.status === "OCCUPIED" || b.status === "RESERVED" ? null : <ConfirmButton label="Retire" confirmLabel="Retire bed" onConfirm={() => patch.mutate({ path: `/beds/${b.id}`, body: { active: "INACTIVE" } })} />
                            : <Button variant="secondary" onClick={() => patch.mutate({ path: `/beds/${b.id}`, body: { active: "ACTIVE" } })}>Bring back</Button>}
                        </span>
                      </li>
                    ))}
                    {beds.data?.filter((b) => b.roomId === r.id).length === 0 && <li className="text-xs text-slate-400">No beds yet.</li>}
                  </ul>
                </div>
              ))}
              {rooms.data?.filter((r) => r.wardId === w.id).length === 0 && <p className="text-xs text-slate-400">No rooms yet.</p>}
            </div>
          </div>
        ))}
        {wards.data?.length === 0 && <Notice>No wards yet. Add one above.</Notice>}
      </div>
      <div className="mt-3 space-y-2"><ErrorNote error={patch.error} /><ErrorNote error={status.error} /></div>
    </Card>
  );
}

interface Doctor { id: string; displayName: string; specialty: string | null; registrationNo: string | null; departmentId: string | null; status: "ACTIVE" | "INACTIVE"; scheduleSet: boolean; videoFee?: string | null }

/** Doctors of this facility, switched-off ones included: change their details, department and registration number, or switch them off and on. */
export function DoctorList({ departments }: { departments: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["practitioners-admin"], queryFn: () => api.get<Doctor[]>("/practitioners", { includeInactive: "true" }) });
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState({ displayName: "", specialty: "", registrationNo: "", departmentId: "", videoFee: "" });
  const [warn, setWarn] = useState<string | null>(null);
  const done = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["practitioners-admin"] }), qc.invalidateQueries({ queryKey: ["practitioners"] })]); };
  const save = useMutation({
    mutationFn: (x: { id: string; body: Record<string, unknown> }) => api.patch<{ upcomingBooked: number }>(`/practitioners/${x.id}`, x.body),
    onSuccess: async (r, x) => {
      setEditing(null);
      setWarn(x.body["status"] === "INACTIVE" && r.upcomingBooked > 0 ? `${r.upcomingBooked} booked visit${r.upcomingBooked === 1 ? " is" : "s are"} still waiting for this doctor. They are kept: move or cancel them from Appointments.` : null);
      await done();
    },
  });
  const begin = (d: Doctor) => { setEditing(d.id); setF({ displayName: d.displayName, specialty: d.specialty ?? "", registrationNo: d.registrationNo ?? "", departmentId: d.departmentId ?? "", videoFee: d.videoFee ?? "" }); };
  const deptName = (id: string | null) => departments.find((x) => x.id === id)?.name ?? "No department";
  if (list.isLoading) return <Card title="All doctors"><Spinner /></Card>;
  return (
    <Card title="All doctors">
      {warn && <div className="mb-2"><Notice tone="warn">{warn}</Notice></div>}
      <ul className="divide-y divide-slate-100">
        {list.data?.map((d) => (
          <li key={d.id} className="py-2 text-sm">
            {editing === d.id ? (
              <form className="grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ id: d.id, body: { displayName: f.displayName.trim(), specialty: f.specialty.trim() || null, registrationNo: f.registrationNo.trim() || null, departmentId: f.departmentId || null, videoFee: f.videoFee.trim() === "" ? null : f.videoFee.trim() } });
              }}>
                <Input aria-label="Display name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
                <Input aria-label="Specialty" placeholder="Specialty" value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} />
                <Input aria-label="Registration number" placeholder="Registration number" value={f.registrationNo} onChange={(e) => setF({ ...f, registrationNo: e.target.value })} />
                <Select aria-label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">No department</option>{departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
                <Input aria-label="Video consultation fee" placeholder="Video fee (empty: hospital default)" inputMode="decimal" value={f.videoFee} onChange={(e) => setF({ ...f, videoFee: e.target.value })} />
                <span className="flex gap-2"><Button type="submit" loading={save.isPending} disabled={f.displayName.trim().length < 2 || (f.videoFee.trim() !== "" && !/^\d{1,8}(\.\d{1,2})?$/.test(f.videoFee.trim()))}>Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></span>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <b>{d.displayName}</b>
                <span className="text-slate-500">{[d.specialty, deptName(d.departmentId), d.registrationNo].filter(Boolean).join(" · ")}</span>
                {d.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}
                {d.videoFee !== null && d.videoFee !== undefined && <Badge tone="blue">Video fee {d.videoFee}</Badge>}
                {!d.scheduleSet && d.status === "ACTIVE" && <Badge tone="amber">No weekly schedule: bookable at any time</Badge>}
                <span className="ml-auto flex gap-2">
                  <Button variant="ghost" onClick={() => begin(d)}>Edit</Button>
                  {d.status === "ACTIVE"
                    ? <ConfirmButton label="Switch off" confirmLabel="Switch doctor off" onConfirm={() => save.mutate({ id: d.id, body: { status: "INACTIVE" } })} />
                    : <Button variant="secondary" onClick={() => save.mutate({ id: d.id, body: { status: "ACTIVE" } })}>Switch on</Button>}
                </span>
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="py-2 text-sm text-slate-500">None yet.</li>}
      </ul>
      <div className="mt-2"><ErrorNote error={save.error} /></div>
    </Card>
  );
}
