"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Select, Spinner, Table, Td, useDebounced } from "./ui";

interface Service { id: string; code: string; name: string; category: string; price: string; taxPercent: string; sacCode: string | null; status: "ACTIVE" | "INACTIVE" }

const CATEGORIES: [string, string][] = [
  ["CONSULTATION", "Consultation"], ["ROOM_BED", "Room and bed"], ["PROCEDURE", "Procedure"], ["NURSING", "Nursing"],
  ["INJECTION_DRESSING", "Injection and dressing"], ["INVESTIGATION", "Investigation"], ["OTHER", "Other"],
];
const categoryLabel = (c: string) => CATEGORIES.find(([k]) => k === c)?.[1] ?? c;
const PAGE = 50;
const AMOUNT = /^\d{1,8}(\.\d{1,2})?$/;

interface Form { name: string; category: string; price: string; taxPercent: string; sacCode: string }
const toForm = (s: Service): Form => ({ name: s.name, category: s.category, price: s.price, taxPercent: s.taxPercent, sacCode: s.sacCode ?? "" });
const formError = (f: Form): string | null => {
  if (f.name.trim().length < 2) return "Enter the service name";
  if (!AMOUNT.test(f.price.trim())) return "Price must be an amount like 500 or 500.50";
  if (!AMOUNT.test(f.taxPercent.trim()) || Number(f.taxPercent) > 100) return "Tax must be a percentage from 0 to 100";
  if (f.sacCode.trim() && !/^\d{4,8}$/.test(f.sacCode.trim())) return "SAC/HSN code is 4 to 8 digits";
  return null;
};

/**
 * The service catalogue and prices of this facility. Administrators can add a service, change its name, category, price, tax and SAC/HSN code, and switch it off
 * (and on again). A service is never deleted: old invoices keep the name and price they were issued with, and a switched-off service just stops being offered on new ones.
 */
export function PriceList() {
  const qc = useQueryClient();
  const { money } = useMe();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [category, setCategory] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["services-admin", q, category, showOff, page],
    queryFn: () => api.page<Service>("/services", { pageSize: PAGE, page, ...(q ? { q } : {}), ...(category ? { category } : {}), ...(showOff ? { includeInactive: "true" } : {}) }),
    placeholderData: (prev) => prev,
  });
  const refresh = async () => { await Promise.all(["services-admin", "services", "services-all"].map((k) => qc.invalidateQueries({ queryKey: [k] }))); };

  const empty = { code: "", name: "", category: "CONSULTATION", price: "", taxPercent: "0", sacCode: "" };
  const [add, setAdd] = useState(empty);
  const addErr = add.code.trim() && add.name.trim() ? formError(add) : null;
  const create = useMutation({
    mutationFn: () => api.post("/services", { code: add.code.trim(), name: add.name.trim(), category: add.category, price: add.price.trim(), taxPercent: add.taxPercent.trim(), ...(add.sacCode.trim() ? { sacCode: add.sacCode.trim() } : {}) }),
    onSuccess: async () => { setAdd(empty); await refresh(); },
  });

  const [editing, setEditing] = useState<Service | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const save = useMutation({
    mutationFn: (x: { id: string; body: Record<string, unknown> }) => api.patch(`/services/${x.id}`, x.body),
    onSuccess: async () => { setEditing(null); await refresh(); },
  });
  const submitEdit = () => {
    if (!editing || !form) return;
    const body: Record<string, unknown> = {};
    if (form.name.trim() !== editing.name) body["name"] = form.name.trim();
    if (form.category !== editing.category) body["category"] = form.category;
    if (Number(form.price) !== Number(editing.price)) body["price"] = form.price.trim();
    if (Number(form.taxPercent) !== Number(editing.taxPercent)) body["taxPercent"] = form.taxPercent.trim();
    if (form.sacCode.trim() !== (editing.sacCode ?? "")) body["sacCode"] = form.sacCode.trim() || null;
    if (Object.keys(body).length === 0) { setEditing(null); return; }
    save.mutate({ id: editing.id, body });
  };
  const editErr = form ? formError(form) : null;
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-4">
      <Card title="Add a service">
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); if (!addErr) create.mutate(); }}>
          <Input placeholder="Code, e.g. CONS" aria-label="Code" value={add.code} onChange={(e) => setAdd({ ...add, code: e.target.value })} />
          <Input className="sm:col-span-2" placeholder="Service name" aria-label="Name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          <Select aria-label="Category" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })}>{CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select>
          <Input placeholder="Price" aria-label="Price" inputMode="decimal" value={add.price} onChange={(e) => setAdd({ ...add, price: e.target.value })} />
          <Input placeholder="Tax %" aria-label="Tax percent" inputMode="decimal" value={add.taxPercent} onChange={(e) => setAdd({ ...add, taxPercent: e.target.value })} />
          <Input placeholder="SAC/HSN (optional)" aria-label="SAC or HSN code" inputMode="numeric" className="sm:col-span-2" value={add.sacCode} onChange={(e) => setAdd({ ...add, sacCode: e.target.value })} />
          <Button type="submit" loading={create.isPending} disabled={!add.code.trim() || !add.name.trim() || !add.price.trim() || !!addErr}>Add</Button>
          <div className="col-span-2 sm:col-span-6">{addErr ? <Notice tone="warn">{addErr}</Notice> : <ErrorNote error={create.error} />}</div>
        </form>
      </Card>

      <Card title="Price list">
        <div className="mb-3 grid grid-cols-2 items-end gap-2 sm:grid-cols-4">
          <Field label="Search"><Input aria-label="Search services" placeholder="Name or code" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></Field>
          <Field label="Category"><Select aria-label="Filter by category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}><option value="">All</option>{CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select></Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={showOff} onChange={(e) => { setShowOff(e.target.checked); setPage(1); }} /> Show switched-off services</label>
          <span className="pb-2 text-sm text-slate-500">{total} service{total === 1 ? "" : "s"}</span>
        </div>
        <p className="mb-2 text-xs text-slate-500">Changing a price or tax applies to new invoices only. Invoices already issued keep the price they were issued with. A service is switched off, never deleted, so old bills stay complete.</p>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Code", "Service", "Category", "SAC/HSN", "Price", "Tax %", "", ""]} empty="No services match.">
            {rows.map((s) => editing?.id === s.id && form ? (
              <tr key={s.id} className="bg-slate-50">
                <Td>{s.code}</Td>
                <Td><Input aria-label={`Name of ${s.code}`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Td>
                <Td><Select aria-label={`Category of ${s.code}`} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select></Td>
                <Td><Input aria-label={`SAC or HSN of ${s.code}`} inputMode="numeric" className="w-24" value={form.sacCode} onChange={(e) => setForm({ ...form, sacCode: e.target.value })} /></Td>
                <Td><Input aria-label={`Price of ${s.code}`} inputMode="decimal" className="w-24" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Td>
                <Td><Input aria-label={`Tax percent of ${s.code}`} inputMode="decimal" className="w-20" value={form.taxPercent} onChange={(e) => setForm({ ...form, taxPercent: e.target.value })} /></Td>
                <Td />
                <Td>
                  <span className="flex gap-2">
                    <Button loading={save.isPending} disabled={!!editErr} onClick={submitEdit}>Save</Button>
                    <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </span>
                  {editErr && <div className="mt-1 text-xs text-amber-700">{editErr}</div>}
                </Td>
              </tr>
            ) : (
              <tr key={s.id} className={s.status === "INACTIVE" ? "text-slate-400" : ""}>
                <Td>{s.code}</Td><Td>{s.name}</Td><Td>{categoryLabel(s.category)}</Td><Td>{s.sacCode ?? "—"}</Td><Td>{money(s.price)}</Td><Td>{s.taxPercent}</Td>
                <Td>{s.status === "INACTIVE" && <Badge tone="red">Switched off</Badge>}</Td>
                <Td>
                  <span className="flex gap-2">
                    <Button variant="ghost" aria-label={`Edit ${s.code}`} onClick={() => { setEditing(s); setForm(toForm(s)); save.reset(); }}>Edit</Button>
                    {s.status === "ACTIVE"
                      ? <ConfirmButton label="Switch off" confirmLabel="Switch off service" onConfirm={() => save.mutate({ id: s.id, body: { status: "INACTIVE" } })} />
                      : <Button variant="secondary" onClick={() => save.mutate({ id: s.id, body: { status: "ACTIVE" } })}>Switch on</Button>}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="mt-2"><ErrorNote error={save.error} /></div>
        {pages > 1 && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page} of {pages}</span>
            <Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
