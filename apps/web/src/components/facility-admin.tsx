"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Spinner } from "./ui";

interface Facility {
  id: string; name: string; code: string; address: string | null; city: string | null; district: string | null; state: string | null;
  postalCode: string | null; phone: string | null; email: string | null; gstin: string | null; status: "ACTIVE" | "INACTIVE";
}
const FIELDS = [
  ["name", "Name"], ["address", "Address"], ["city", "City"], ["district", "District"], ["state", "State"], ["postalCode", "PIN code"], ["phone", "Phone"], ["email", "Email"], ["gstin", "GSTIN"],
] as const;
type Form = Record<(typeof FIELDS)[number][0], string>;
const toForm = (f: Facility): Form => ({ name: f.name, address: f.address ?? "", city: f.city ?? "", district: f.district ?? "", state: f.state ?? "", postalCode: f.postalCode ?? "", phone: f.phone ?? "", email: f.email ?? "", gstin: f.gstin ?? "" });
/** Blank boxes mean "not given" (null); the server checks the formats. */
const toBody = (f: Form): Record<string, string | null> => Object.fromEntries(FIELDS.map(([k]) => [k, f[k].trim() === "" ? (k === "name" ? f[k].trim() : null) : f[k].trim()]));

/** The hospital's facilities: details, adding another one, and switching one off or on. Needs ADMIN_SETTINGS. */
export function FacilityCard() {
  const { me } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["facilities-admin"], queryFn: () => api.get<Facility[]>("/facilities") });
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [adding, setAdding] = useState({ code: "", name: "" });
  const done = async () => { await qc.invalidateQueries({ queryKey: ["facilities-admin"] }); await qc.invalidateQueries({ queryKey: ["facilities"] }); await qc.invalidateQueries({ queryKey: ["me"] }); };
  const save = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => api.patch(`/facilities/${x.id}`, x.body), onSuccess: async () => { setEditing(null); await done(); } });
  const add = useMutation({ mutationFn: () => api.post("/facilities", { code: adding.code.trim().toUpperCase(), name: adding.name.trim() }), onSuccess: async () => { setAdding({ code: "", name: "" }); await done(); } });
  if (list.isLoading) return <Card title="Facilities"><Spinner /></Card>;
  return (
    <Card title="Facilities">
      <ul className="divide-y divide-slate-100">
        {list.data?.map((f) => (
          <li key={f.id} className="py-2 text-sm">
            {editing === f.id && form ? (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ id: f.id, body: toBody(form) }); }}>
                <div className="grid gap-2 sm:grid-cols-3">
                  {FIELDS.map(([k, label]) => <Field key={k} label={label}><Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>)}
                </div>
                <p className="text-xs text-slate-500">The code ({f.code}) and time zone do not change. Leave a box empty to clear it. These details are the facility's record; what is printed on bills and prescriptions is set under "Print header" below.</p>
                <div className="flex gap-2"><Button type="submit" loading={save.isPending} disabled={form.name.trim().length < 2}>Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <b>{f.name}</b><Badge>{f.code}</Badge>
                <span className="text-slate-500">{[f.city, f.state, f.gstin ? `GSTIN ${f.gstin}` : null].filter(Boolean).join(" · ")}</span>
                {f.id === me.facility?.id && <Badge tone="blue">You are here</Badge>}
                {f.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}
                <span className="ml-auto flex gap-2">
                  <Button variant="ghost" onClick={() => { setEditing(f.id); setForm(toForm(f)); }}>Edit</Button>
                  {f.status === "ACTIVE"
                    ? f.id === me.facility?.id ? null : <ConfirmButton label="Switch off" confirmLabel="Switch facility off" onConfirm={() => save.mutate({ id: f.id, body: { status: "INACTIVE" } })} />
                    : <Button variant="secondary" onClick={() => save.mutate({ id: f.id, body: { status: "ACTIVE" } })}>Switch on</Button>}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2"><ErrorNote error={save.error} /></div>
      <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Input aria-label="New facility code" placeholder="Code, e.g. NORTH" value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value })} />
        <Input aria-label="New facility name" placeholder="Facility name" className="sm:col-span-2" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
        <Button type="submit" loading={add.isPending} disabled={!/^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/.test(adding.code.trim()) || adding.name.trim().length < 2}>Add facility</Button>
        <div className="col-span-2 sm:col-span-4"><ErrorNote error={add.error} /></div>
      </form>
      <div className="mt-2"><Notice>A new facility starts empty. To work in it, switch to it from the facility menu, then add its departments, doctors, wards and prices, and give staff access under Staff.</Notice></div>
    </Card>
  );
}

interface Dept { id: string; name: string; code: string; status: "ACTIVE" | "INACTIVE" }

/** Departments of this facility, switched-off ones included: rename, switch off and on. A department with working doctors cannot be switched off. */
export function DepartmentList() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["departments-admin"], queryFn: () => api.get<Dept[]>("/departments", { includeInactive: "true" }) });
  const done = async () => { await qc.invalidateQueries({ queryKey: ["departments-admin"] }); await qc.invalidateQueries({ queryKey: ["departments"] }); };
  const save = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => api.patch(`/departments/${x.id}`, x.body), onSuccess: done });
  const [names, setNames] = useState<Record<string, string>>({});
  if (list.isLoading) return <Card title="All departments"><Spinner /></Card>;
  return (
    <Card title="All departments">
      <ul className="divide-y divide-slate-100">
        {list.data?.map((d) => {
          const v = names[d.id] ?? d.name;
          const changed = v.trim() !== d.name && v.trim().length >= 2;
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Input aria-label={`Department name ${d.code}`} className="w-56" value={v} onChange={(e) => setNames({ ...names, [d.id]: e.target.value })} />
              {changed && <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate({ id: d.id, body: { name: v.trim() } }, { onSuccess: () => setNames(({ [d.id]: _gone, ...rest }) => rest) })}>Save</Button>}
              <Badge>{d.code}</Badge>
              {d.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}
              <span className="ml-auto">
                {d.status === "ACTIVE"
                  ? <ConfirmButton label="Switch off" confirmLabel="Switch department off" onConfirm={() => save.mutate({ id: d.id, body: { status: "INACTIVE" } })} />
                  : <Button variant="secondary" onClick={() => save.mutate({ id: d.id, body: { status: "ACTIVE" } })}>Switch on</Button>}
              </span>
            </li>
          );
        })}
        {list.data?.length === 0 && <li className="py-2 text-sm text-slate-500">None yet. Add one above.</li>}
      </ul>
      <div className="mt-2"><ErrorNote error={save.error} /></div>
    </Card>
  );
}
