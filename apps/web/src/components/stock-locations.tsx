"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, useDebounced } from "./ui";

interface Location { id: string; name: string; code: string; status: "ACTIVE" | "INACTIVE"; units: number; batches: number; transfersOnTheWay: number }
interface LocationStock { location: { id: string; name: string }; units: number; items: { batchId: string; brandName: string; strength: string | null; batchNo: string; expiryDate: string; batchStatus: string; quantity: number }[] }
interface Transfer { id: string; transferNumber: string; status: "RECEIVED" | "IN_TRANSIT" | "CANCELLED"; closedBy: string | null; closeNote: string | null; at: string; by: string | null; reason: string; units: number; from: { id: string | null; name: string }; to: { id: string | null; name: string }; items: { medicine: string; strength: string | null; batchNo: string; quantity: number }[] }
interface StockPage { items: { medicineId: string; brandName: string; strength: string | null; batches: { id: string; batchNo: string; expiryDate: string; quantity: number }[] }[] }
/** A batch that can be moved, with how many are in the place the stock comes from. */
interface Source { batchId: string; name: string; batchNo: string; expiryDate: string; available: number }

const MAIN = "main";

/** What a location holds right now. */
function StockModal({ locationId, onClose }: { locationId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["location-stock", locationId], queryFn: () => api.get<LocationStock>(`/pharmacy/locations/${locationId}/stock`) });
  return (
    <Modal title={q.data ? `${q.data.location.name}: ${q.data.units} unit${q.data.units === 1 ? "" : "s"}` : "Stock in this location"} onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : (
        <Table head={["Medicine", "Batch", "Expires", "Quantity"]} {...(q.data?.items.length === 0 ? { empty: "Nothing is held here. Move stock in from the main store." } : {})}>
          {q.data?.items.map((i) => <tr key={i.batchId}><Td>{i.brandName} {i.strength}</Td><Td>{i.batchNo}{i.batchStatus === "BLOCKED" && <span className="ml-1 text-xs text-red-700">blocked</span>}</Td><Td>{i.expiryDate}</Td><Td>{i.quantity}</Td></tr>)}
        </Table>
      )}
    </Modal>
  );
}

function Locations({ locations }: { locations: Location[] }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["stock-locations"] }); };
  const add = useMutation({ mutationFn: () => api.post("/pharmacy/locations", { name: name.trim() }), onSuccess: () => { setName(""); refresh(); } });
  const toggle = useMutation({ mutationFn: (l: Location) => api.put(`/pharmacy/locations/${l.id}`, { status: l.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: refresh });
  return (
    <Card title="Locations">
      <p className="mb-3 text-sm text-slate-600">A location is a place in the hospital that keeps its own medicines, such as a ward store or the operation theatre. The main store is the pharmacy counter's own stock and is not listed here.</p>
      {can("PHARMACY_MASTERS") && (
        <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) add.mutate(); }}>
          <Input className="max-w-xs" aria-label="Location name" placeholder="New location, e.g. Ward A store" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={add.isPending} disabled={name.trim().length < 2}>Add location</Button>
        </form>
      )}
      <ErrorNote error={add.error ?? toggle.error} />
      <Table head={["Location", "Code", "Units held", "Batches", "On the way", "Status", ""]} {...(locations.length === 0 ? { empty: "No locations yet." } : {})}>
        {locations.map((l) => (
          <tr key={l.id}>
            <Td>{l.name}</Td><Td>{l.code}</Td><Td>{l.units}</Td><Td>{l.batches}</Td><Td>{l.transfersOnTheWay > 0 ? `${l.transfersOnTheWay} transfer${l.transfersOnTheWay === 1 ? "" : "s"}` : "—"}</Td>
            <Td><Badge tone={l.status === "ACTIVE" ? "green" : "gray"}>{l.status === "ACTIVE" ? "In use" : "Not in use"}</Badge></Td>
            <Td className="space-x-1 whitespace-nowrap"><Button variant="ghost" onClick={() => setViewing(l.id)}>View stock</Button>{can("PHARMACY_MASTERS") && <Button variant="ghost" loading={toggle.isPending && toggle.variables?.id === l.id} onClick={() => toggle.mutate(l)}>{l.status === "ACTIVE" ? "Stop using" : "Use again"}</Button>}</Td>
          </tr>
        ))}
      </Table>
      {viewing && <StockModal locationId={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

/** Moves stock between the main store and a location, or between two locations, in one step. */
function MoveStock({ locations }: { locations: Location[] }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(MAIN);
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, Source>>({});
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newKey);
  const [done, setDone] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState(false);
  const term = useDebounced(search.trim(), 250);
  const fromMain = from === MAIN;

  const mainStock = useQuery({ queryKey: ["move-main", term], queryFn: () => api.page<StockPage["items"][number]>("/pharmacy/stock", { ...(term.length >= 2 ? { q: term } : {}), pageSize: 8 }), enabled: fromMain && term.length >= 2 });
  const locStock = useQuery({ queryKey: ["location-stock", from], queryFn: () => api.get<LocationStock>(`/pharmacy/locations/${from}/stock`), enabled: !fromMain });
  const sources: Source[] = fromMain
    ? (mainStock.data?.data ?? []).flatMap((m) => m.batches.map((b) => ({ batchId: b.id, name: `${m.brandName} ${m.strength ?? ""}`.trim(), batchNo: b.batchNo, expiryDate: b.expiryDate, available: b.quantity })))
    : (locStock.data?.items ?? []).filter((i) => !term || `${i.brandName} ${i.strength ?? ""}`.toLowerCase().includes(term.toLowerCase())).map((i) => ({ batchId: i.batchId, name: `${i.brandName} ${i.strength ?? ""}`.trim(), batchNo: i.batchNo, expiryDate: i.expiryDate, available: i.quantity }));

  const lines = Object.entries(qty).map(([batchId, v]) => ({ batchId, quantity: Math.floor(Number(v)), src: picked[batchId] })).filter((l) => l.src && Number(qty[l.batchId]) > 0);
  const tooMany = lines.some((l) => l.src && l.quantity > l.src.available);
  const valid = lines.length > 0 && !tooMany && reason.trim().length >= 3 && to !== "" && to !== from;
  const send = useMutation({
    mutationFn: () => api.post<Transfer>("/pharmacy/transfers", { fromLocationId: fromMain ? null : from, toLocationId: to === MAIN ? null : to, reason: reason.trim(), twoStep, items: lines.map((l) => ({ batchId: l.batchId, quantity: l.quantity })) }, key),
    onSuccess: (t) => {
      setDone(t.status === "IN_TRANSIT" ? `${t.transferNumber}: ${t.units} unit${t.units === 1 ? "" : "s"} sent from ${t.from.name} to ${t.to.name}. They count there once ${t.to.name} confirms they arrived.` : `${t.transferNumber}: ${t.units} unit${t.units === 1 ? "" : "s"} moved from ${t.from.name} to ${t.to.name}.`);
      setQty({}); setPicked({}); setReason(""); setKey(newKey());
      void qc.invalidateQueries({ queryKey: ["stock-locations"] }); void qc.invalidateQueries({ queryKey: ["stock-transfers"] }); void qc.invalidateQueries({ queryKey: ["location-stock"] });
      void qc.invalidateQueries({ queryKey: ["on-the-way"] }); void qc.invalidateQueries({ queryKey: ["move-main"] }); void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] });
    },
  });
  const places = [{ id: MAIN, name: "Main store" }, ...locations.filter((l) => l.status === "ACTIVE" || l.id === from).map((l) => ({ id: l.id, name: l.name }))];
  const setQuantity = (s: Source, v: string) => { setQty((q) => ({ ...q, [s.batchId]: v.replace(/[^0-9]/g, "") })); setPicked((p) => ({ ...p, [s.batchId]: s })); setDone(null); };

  return (
    <Card title="Move stock">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="From"><Select aria-label="From" value={from} onChange={(e) => { setFrom(e.target.value); setQty({}); setPicked({}); setSearch(""); if (to === e.target.value) setTo(""); }}>{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="To"><Select aria-label="To" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose where to…</option>{places.filter((p) => p.id !== from).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label={fromMain ? "Find a medicine" : "Filter what is held"} className="col-span-2"><Input aria-label="Find a medicine" placeholder={fromMain ? "Type at least 2 letters" : "Type to filter"} value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
      </div>
      <div className="mt-3">
        {(fromMain ? mainStock.isFetching : locStock.isFetching) && <Spinner />}
        {sources.length > 0 && (
          <Table head={["Medicine", "Batch", "Expires", "Available", "Move"]}>
            {sources.map((s) => (
              <tr key={s.batchId}>
                <Td>{s.name}</Td><Td>{s.batchNo}</Td><Td>{s.expiryDate}</Td><Td>{s.available}</Td>
                <Td><Input aria-label={`Quantity of ${s.name} batch ${s.batchNo}`} className="w-24" inputMode="numeric" placeholder="0" value={qty[s.batchId] ?? ""} onChange={(e) => setQuantity(s, e.target.value)} /></Td>
              </tr>
            ))}
          </Table>
        )}
        {fromMain && term.length < 2 && lines.length === 0 && <p className="text-sm text-slate-500">Search for a medicine to see its batches.</p>}
        {!fromMain && locStock.data && sources.length === 0 && <p className="text-sm text-slate-500">Nothing to move from here.</p>}
      </div>
      {lines.length > 0 && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="mb-1 font-medium">Ready to move</div>
          <ul>{lines.map((l) => <li key={l.batchId} className={l.src && l.quantity > l.src.available ? "text-red-700" : ""}>{l.quantity} × {l.src?.name} · batch {l.src?.batchNo}{l.src && l.quantity > l.src.available ? ` (only ${l.src.available} available)` : ""}</li>)}</ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Reason" className="min-w-64 flex-1"><Input aria-label="Reason" placeholder="e.g. Weekly stock for Ward A" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button loading={send.isPending} disabled={!valid} onClick={() => send.mutate()}>{twoStep ? "Send stock" : "Move stock"}</Button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={twoStep} onChange={(e) => setTwoStep(e.target.checked)} />Send in two steps: the stock leaves now and counts at the other place only when someone there confirms it arrived</label>
      <div className="mt-2"><ErrorNote error={send.error} /></div>
      {done && <div className="mt-2"><Notice tone="success">{done}</Notice></div>}
    </Card>
  );
}

function History() {
  const { dateTime } = useMe();
  const q = useQuery({ queryKey: ["stock-transfers"], queryFn: () => api.get<{ total: number; items: Transfer[] }>("/pharmacy/transfers?pageSize=25") });
  return (
    <Card title="Recent transfers">
      {q.isLoading ? <Spinner /> : (
        <Table head={["Number", "When", "From → To", "Units", "What", "By"]} {...(q.data?.items.length === 0 ? { empty: "No transfers yet." } : {})}>
          {q.data?.items.map((t) => (
            <tr key={t.id}>
              <Td>{t.transferNumber}{t.status !== "RECEIVED" && <div><Badge tone={t.status === "IN_TRANSIT" ? "amber" : "gray"}>{t.status === "IN_TRANSIT" ? "on the way" : "sent back"}</Badge></div>}</Td><Td>{dateTime(t.at)}</Td><Td>{t.from.name} → {t.to.name}</Td><Td>{t.units}</Td>
              <Td>{t.items.map((i) => `${i.quantity} × ${i.medicine} ${i.strength ?? ""} (batch ${i.batchNo})`).join("; ")}<div className="text-xs text-slate-500">{t.reason}{t.closeNote ? ` · ${t.closeNote}` : ""}</div></Td>
              <Td>{t.by ?? "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** Stock locations, moving stock between them and the main store, and the history of transfers (docs/stock-transfers.md). */
export function StockLocationsTab() {
  const { can } = useMe();
  const locations = useQuery({ queryKey: ["stock-locations"], queryFn: () => api.get<Location[]>("/pharmacy/locations") });
  return (
    <div className="space-y-4">
      {locations.isLoading ? <Spinner /> : locations.error ? <ErrorNote error={locations.error} /> : (
        <>
          <Locations locations={locations.data ?? []} />
          {can("PHARMACY_ADJUST_STOCK") ? <MoveStock locations={locations.data ?? []} /> : <Notice>Only pharmacy staff who may adjust stock can move it between places.</Notice>}
          <OnTheWay />
          <History />
        </>
      )}
    </div>
  );
}

/** Stock sent in two steps that has not been confirmed yet: the other place confirms it arrived, or it is sent back (docs/stock-transfers.md). */
export function OnTheWay() {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["on-the-way"], queryFn: () => api.get<{ items: Transfer[] }>("/pharmacy/transfers?status=IN_TRANSIT&pageSize=50"), enabled: can("PHARMACY_READ") });
  const [back, setBack] = useState<Transfer | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => { setBack(null); setReason(""); void qc.invalidateQueries({ queryKey: ["on-the-way"] }); void qc.invalidateQueries({ queryKey: ["stock-locations"] }); void qc.invalidateQueries({ queryKey: ["stock-transfers"] }); void qc.invalidateQueries({ queryKey: ["pharmacy-stock"] }); };
  const receive = useMutation({ mutationFn: (t: Transfer) => api.post(`/pharmacy/transfers/${t.id}/receive`, {}, newKey()), onSuccess: refresh });
  const sendBack = useMutation({ mutationFn: (t: Transfer) => api.post(`/pharmacy/transfers/${t.id}/send-back`, { reason: reason.trim() }, newKey()), onSuccess: refresh });
  const mayClose = can("PHARMACY_ADJUST_STOCK", "NURSING_MEDICATION_ADMINISTER");
  if (!q.data || q.data.items.length === 0) return null;
  return (
    <Card title="On the way">
      <p className="mb-3 text-sm text-slate-600">These transfers have left the sender but are not yet counted at the other place. When the stock arrives, confirm it; if it did not arrive or is refused, send it back and it returns to where it came from.</p>
      <ErrorNote error={receive.error ?? sendBack.error} />
      <Table head={["Number", "Sent", "From → To", "What", ""]}>
        {q.data.items.map((t) => (
          <tr key={t.id}>
            <Td>{t.transferNumber}</Td><Td>{dateTime(t.at)}<div className="text-xs text-slate-500">{t.by}</div></Td><Td>{t.from.name} → {t.to.name}</Td>
            <Td>{t.items.map((i) => `${i.quantity} × ${i.medicine} ${i.strength ?? ""} (batch ${i.batchNo})`).join("; ")}</Td>
            <Td className="space-x-1 whitespace-nowrap">{mayClose && <><Button variant="secondary" loading={receive.isPending && receive.variables?.id === t.id} onClick={() => receive.mutate(t)}>Arrived</Button><Button variant="ghost" onClick={() => setBack(t)}>Send back…</Button></>}</Td>
          </tr>
        ))}
      </Table>
      {back && (
        <Modal title={`Send ${back.transferNumber} back?`} onClose={() => setBack(null)}>
          <div className="space-y-3">
            <p className="text-sm">The {back.units} unit(s) return to {back.from.name}. This cannot be undone.</p>
            <Field label="Reason (recorded)"><Input autoFocus value={reason} maxLength={240} onChange={(e) => setReason(e.target.value)} placeholder="At least 3 characters" /></Field>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setBack(null)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={sendBack.isPending} onClick={() => sendBack.mutate(back)}>Send back</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
