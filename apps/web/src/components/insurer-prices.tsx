"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td } from "./ui";

interface Rate { serviceId: string; code: string; name: string; standardPrice: string; price: string; status: string }
interface Pack { id: string; code: string; name: string; price: string; status: string; includesImplants?: boolean; includesConsumables?: boolean; exclusionNote?: string | null; inclusions?: string[]; exclusions?: string[] }
interface ServiceRow { id: string; name: string; price: string }

/** An insurer's price list (docs/claims.md): the rate it pays per service, and its fixed-price packages. */
export function InsurerPrices({ insurer, onClose }: { insurer: { id: string; name: string }; onClose: () => void }) {
  const { can, money } = useMe();
  const qc = useQueryClient();
  const manage = can("CLAIM_MASTERS");
  const rates = useQuery({ queryKey: ["insurer-rates", insurer.id], queryFn: () => api.get<Rate[]>(`/claims/insurers/${insurer.id}/rates`) });
  const packs = useQuery({ queryKey: ["insurer-packages", insurer.id], queryFn: () => api.get<Pack[]>(`/claims/insurers/${insurer.id}/packages`) });
  const services = useQuery({ queryKey: ["services"], queryFn: () => api.page<ServiceRow>("/services", { pageSize: 100 }), enabled: manage });
  const [rate, setRate] = useState({ serviceId: "", price: "" });
  const [pack, setPack] = useState({ code: "", name: "", price: "", includesImplants: true, includesConsumables: true, exclusionNote: "", inclusions: "", exclusions: "" });
  const words = (v: string) => v.split(",").map((x) => x.trim()).filter((x) => x.length > 1);
  const leavesOut = !pack.includesImplants || !pack.includesConsumables;
  const saveRate = useMutation({ mutationFn: (a: { serviceId: string; price: string; status?: string }) => api.put(`/claims/insurers/${insurer.id}/rates/${a.serviceId}`, { price: a.price, ...(a.status ? { status: a.status } : {}) }), onSuccess: () => { setRate({ serviceId: "", price: "" }); void qc.invalidateQueries({ queryKey: ["insurer-rates", insurer.id] }); } });
  const addPack = useMutation({ mutationFn: () => api.post(`/claims/insurers/${insurer.id}/packages`, { code: pack.code.trim(), name: pack.name.trim(), price: pack.price, includesImplants: pack.includesImplants, includesConsumables: pack.includesConsumables, inclusions: words(pack.inclusions), exclusions: words(pack.exclusions), ...(pack.exclusionNote.trim() ? { exclusionNote: pack.exclusionNote.trim() } : {}) }), onSuccess: () => { setPack({ code: "", name: "", price: "", includesImplants: true, includesConsumables: true, exclusionNote: "", inclusions: "", exclusions: "" }); void qc.invalidateQueries({ queryKey: ["insurer-packages", insurer.id] }); } });
  const togglePack = useMutation({ mutationFn: (p: Pack) => api.put(`/claims/insurers/${insurer.id}/packages/${p.id}`, { status: p.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["insurer-packages", insurer.id] }); } });

  return (
    <Modal title={`${insurer.name}: rates and packages`} onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="font-medium">Rate card</h3>
          <p className="text-slate-600">What this insurer pays per service. A bill line priced above it has the extra left to the patient when the claim is checked.</p>
          {manage && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Service"><Select value={rate.serviceId} onChange={(e) => setRate({ ...rate, serviceId: e.target.value })}><option value="">Choose a service</option>{services.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.price)}</option>)}</Select></Field>
              <Field label="Insurer's rate"><Input className="w-32" inputMode="decimal" value={rate.price} onChange={(e) => setRate({ ...rate, price: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Button disabled={!rate.serviceId || !rate.price} loading={saveRate.isPending} onClick={() => saveRate.mutate(rate)}>Save rate</Button>
            </div>
          )}
          {rates.isLoading ? <Spinner /> : (
            <Table head={["Service", "Our price", "Insurer's rate", "Status"]} {...(rates.data?.length === 0 ? { empty: "No rates yet. Every line is claimed at the hospital's price." } : {})}>
              {rates.data?.map((r) => <tr key={r.serviceId}><Td>{r.name}</Td><Td>{money(r.standardPrice)}</Td><Td className="font-medium">{money(r.price)}</Td><Td>{manage ? <Button variant="secondary" onClick={() => saveRate.mutate({ serviceId: r.serviceId, price: r.price, status: r.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}>{r.status === "ACTIVE" ? "Stop using" : "Use again"}</Button> : r.status.toLowerCase()}</Td></tr>)}
            </Table>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="font-medium">Packages</h3>
          <p className="text-slate-600">A package is a fixed price the insurer pays for a whole treatment. A claim under a package never asks the insurer for more than that price.</p>
          {manage && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Code"><Input className="w-28" value={pack.code} onChange={(e) => setPack({ ...pack, code: e.target.value })} /></Field>
              <Field label="Name"><Input className="w-64" value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })} /></Field>
              <Field label="Price"><Input className="w-32" inputMode="decimal" value={pack.price} onChange={(e) => setPack({ ...pack, price: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
              <Button disabled={!pack.code.trim() || pack.name.trim().length < 2 || !pack.price || (leavesOut && pack.exclusionNote.trim().length < 10)} loading={addPack.isPending} onClick={() => addPack.mutate()}>Add package</Button>
            </div>
          )}
          {manage && (
            <div className="space-y-2 rounded-md border border-slate-200 p-2">
              <p className="text-xs text-slate-600">Implants and consumables are inside the package price unless you say otherwise here. If the package leaves them out, say so openly: it is shown on every claim and estimate.</p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1"><input type="checkbox" checked={pack.includesImplants} onChange={(e) => setPack({ ...pack, includesImplants: e.target.checked })} /> Implants are included</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={pack.includesConsumables} onChange={(e) => setPack({ ...pack, includesConsumables: e.target.checked })} /> Consumables are included</label>
              </div>
              {leavesOut && <Field label="What the package leaves out (required)"><Input value={pack.exclusionNote} maxLength={300} onChange={(e) => setPack({ ...pack, exclusionNote: e.target.value })} /></Field>}
              <div className="flex flex-wrap gap-2">
                <Field label="Also included (comma separated)"><Input className="w-64" value={pack.inclusions} onChange={(e) => setPack({ ...pack, inclusions: e.target.value })} /></Field>
                <Field label="Also excluded (comma separated)"><Input className="w-64" value={pack.exclusions} onChange={(e) => setPack({ ...pack, exclusions: e.target.value })} /></Field>
              </div>
            </div>
          )}
          {packs.isLoading ? <Spinner /> : (
            <Table head={["Code", "Package", "Price", "Status"]} {...(packs.data?.length === 0 ? { empty: "No packages yet." } : {})}>
              {packs.data?.map((p) => <tr key={p.id}><Td>{p.code}</Td><Td>{p.name}</Td><Td className="font-medium">{money(p.price)}</Td><Td>{manage ? <Button variant="secondary" onClick={() => togglePack.mutate(p)}>{p.status === "ACTIVE" ? "Make inactive" : "Make active"}</Button> : <Badge tone="gray">{p.status.toLowerCase()}</Badge>}</Td></tr>)}
            </Table>
          )}
        </section>
        <ErrorNote error={saveRate.error ?? addPack.error ?? togglePack.error} />
      </div>
    </Modal>
  );
}
