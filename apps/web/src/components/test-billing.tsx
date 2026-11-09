"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Input, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

export interface Queue { visits: Visit[]; handwritten: Picture[] }
export interface Test { id: string; category: string; name: string; serviceId: string | null; priceListName: string | null; price: string | null; taxPercent: string | null }
export interface Visit { encounterId: string; patientId: string; patientName: string; mrn: string | null; doctorName: string | null; visitDate: string | null; tests: Test[]; estimatedTotal: string; testsWithoutPrice: number }
export interface Picture { scanId: string; encounterId: string; patientName: string; mrn: string | null; doctorName: string | null; uploadedAt: string; pages: { pageNo: number; fileId: string; fileName: string; contentType: string }[] }
export interface Service { id: string; code: string; name: string; price: string; taxPercent: string }
type Category = "LABORATORY" | "RADIOLOGY" | "CARDIOLOGY" | "PROCEDURE";
type Chosen = { serviceId: string; category: Category } | { name: string; price: string; taxPercent: string; category: Category };
const CATEGORY: Record<string, string> = { LABORATORY: "lab", RADIOLOGY: "imaging", CARDIOLOGY: "cardiology", PROCEDURE: "procedure" };

/** A price the Cashier types: digits with up to two decimals, more than zero (the server checks it again). */
const validPrice = (v: string): boolean => /^\d{1,8}(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;
const validTax = (v: string): boolean => v.trim() === "" || (/^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) && Number(v) <= 100);

function useBilled() {
  const qc = useQueryClient();
  const router = useRouter();
  return async (invoiceId: string) => { await qc.invalidateQueries({ queryKey: ["test-queue"] }); await qc.invalidateQueries({ queryKey: ["invoices"] }); router.push(`/billing/${invoiceId}`); };
}

export function VisitCard({ v, services, compact = false }: { v: Visit; services: Service[]; compact?: boolean }) {
  const { money, dateTime } = useMe();
  const qc = useQueryClient();
  const billed = useBilled();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [typedPrice, setTypedPrice] = useState<Record<string, string>>({});
  const [typedTax, setTypedTax] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const typedOk = (id: string) => validPrice(typedPrice[id] ?? "") && validTax(typedTax[id] ?? "");
  const missing = v.tests.filter((x) => !x.serviceId && !picked[x.id] && !typedOk(x.id));
  const bill = useMutation({
    mutationFn: () => api.post<{ invoiceId: string }>("/test-orders/bill", {
      encounterId: v.encounterId,
      orders: v.tests.map((x) => ({
        orderId: x.id,
        ...(!x.serviceId && picked[x.id] ? { serviceId: picked[x.id] } : {}),
        ...(!x.serviceId && !picked[x.id] && typedOk(x.id) ? { price: typedPrice[x.id]!.trim(), taxPercent: (typedTax[x.id] ?? "").trim() || "0" } : {}),
      })),
    }),
    onSuccess: (r) => billed(r.invoiceId),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.post(`/test-orders/${id}/cancel`, { reason }),
    onSuccess: async () => { setRemoving(null); setReason(""); await qc.invalidateQueries({ queryKey: ["test-queue"] }); },
  });
  return (
    <div className="rounded border border-slate-200 p-3" data-testid="test-visit">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        {!compact && <div><span className="font-medium">{v.patientName}</span> <span className="text-xs text-slate-500">{v.mrn}</span><div className="text-xs text-slate-500">Dr {v.doctorName ?? "—"}{v.visitDate ? ` · ${dateTime(v.visitDate)}` : ""}</div></div>}
        <div className="text-sm text-slate-600">{v.testsWithoutPrice === 0 ? <>Total with tax <span className="font-medium">{money(v.estimatedTotal)}</span></> : "Choose or type a price for the tests marked below"}</div>
      </div>
      <ul className="divide-y divide-slate-100">
        {v.tests.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <Badge>{CATEGORY[x.category] ?? x.category.toLowerCase()}</Badge>
            <span className="min-w-0 flex-1">{x.name}{x.priceListName && x.priceListName !== x.name ? <span className="text-xs text-slate-500"> (billed as {x.priceListName})</span> : null}</span>
            {x.serviceId ? <span>{money(x.price)}</span> : (
              <span className="flex flex-wrap items-center gap-1">
                <Select aria-label={`Price-list item for ${x.name}`} className="w-52" value={picked[x.id] ?? ""} disabled={!!typedPrice[x.id]} onChange={(e) => setPicked({ ...picked, [x.id]: e.target.value })}>
                  <option value="">Choose from the price list…</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price)}</option>)}
                </Select>
                <span className="text-xs text-slate-500">or type</span>
                <Input aria-label={`Price for ${x.name}`} placeholder="Price" inputMode="decimal" className="w-24" value={typedPrice[x.id] ?? ""} disabled={!!picked[x.id]} onChange={(e) => setTypedPrice({ ...typedPrice, [x.id]: e.target.value })} />
                <Input aria-label={`Tax percent for ${x.name}`} placeholder="Tax %" inputMode="decimal" className="w-16" value={typedTax[x.id] ?? ""} disabled={!!picked[x.id] || !typedPrice[x.id]} onChange={(e) => setTypedTax({ ...typedTax, [x.id]: e.target.value })} />
              </span>
            )}
            {removing === x.id ? (
              <span className="flex items-center gap-1">
                <Input aria-label="Reason" placeholder="Reason" className="w-44" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="secondary" disabled={reason.trim().length < 3} loading={remove.isPending} onClick={() => remove.mutate(x.id)}>Remove</Button>
                <button className="text-xs text-slate-500" onClick={() => setRemoving(null)}>Cancel</button>
              </span>
            ) : <button className="text-xs text-slate-500 hover:text-red-700" onClick={() => setRemoving(x.id)}>Not needed</button>}
          </li>
        ))}
      </ul>
      <ErrorNote error={bill.error ?? remove.error} />
      <div className="mt-2 flex justify-end"><Button loading={bill.isPending} disabled={missing.length > 0} onClick={() => bill.mutate()}>Bill {v.tests.length} {v.tests.length === 1 ? "test" : "tests"} and collect</Button></div>
    </div>
  );
}

export function PictureCard({ p, services, compact = false }: { p: Picture; services: Service[]; compact?: boolean }) {
  const { money, dateTime } = useMe();
  const qc = useQueryClient();
  const billed = useBilled();
  const [q, setQ] = useState("");
  const [price, setPrice] = useState("");
  const [tax, setTax] = useState("");
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const byId = new Map(services.map((s) => [s.id, s]));
  const text = q.trim();
  const matches = services.filter((s) => text && `${s.code} ${s.name}`.toLowerCase().includes(text.toLowerCase())).slice(0, 8);
  const canType = text.length >= 2 && validPrice(price) && validTax(tax);
  const addTyped = () => { setChosen([...chosen, { name: text, price: price.trim(), taxPercent: tax.trim() || "0", category: "LABORATORY" }]); setQ(""); setPrice(""); setTax(""); };
  const bill = useMutation({
    mutationFn: () => api.post<{ invoiceId: string }>("/test-orders/bill", { encounterId: p.encounterId, fromPicture: { scanId: p.scanId, tests: chosen } }),
    onSuccess: (r) => billed(r.invoiceId),
  });
  const none = useMutation({ mutationFn: () => api.post(`/test-orders/pictures/${p.scanId}/no-tests`), onSuccess: () => qc.invalidateQueries({ queryKey: ["test-queue"] }) });
  const label = (c: Chosen): string => ("serviceId" in c ? byId.get(c.serviceId)?.name ?? "" : c.name);
  const amount = (c: Chosen): number => { if ("serviceId" in c) { const s = byId.get(c.serviceId); return s ? Number(s.price) * (1 + Number(s.taxPercent) / 100) : 0; } return Number(c.price) * (1 + Number(c.taxPercent) / 100); };
  const total = chosen.reduce((n, c) => n + amount(c), 0);
  return (
    <div className="rounded border border-slate-200 p-3" data-testid="test-picture">
      {!compact && <div className="mb-2"><span className="font-medium">{p.patientName}</span> <span className="text-xs text-slate-500">{p.mrn}</span><div className="text-xs text-slate-500">Dr {p.doctorName ?? "—"} · handwritten prescription, {dateTime(p.uploadedAt)}</div></div>}
      {!compact && <div className="mb-2 flex flex-wrap gap-2">
        {p.pages.map((pg) => (
          <a key={pg.fileId} href={`/api/proxy/files/${pg.fileId}/content`} target="_blank" rel="noreferrer" className="block rounded border border-slate-200 p-1 text-center text-xs text-brand-700 hover:underline">
            {pg.contentType.startsWith("image/") ? <img src={`/api/proxy/files/${pg.fileId}/content`} alt={`Handwritten prescription, page ${pg.pageNo}`} className="h-40 w-40 rounded object-contain" /> : null}
            Page {pg.pageNo}
          </a>
        ))}
      </div>}
      <p className="mb-1 text-xs text-slate-500">Read the tests the doctor wrote. Type each test; pick it from the price list if it is there, or enter its price yourself. The medicines are dealt with by the pharmacy.</p>
      <Input aria-label="Test name" placeholder="Type the test, for example X-ray chest" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-500">On the price list:</span>
        {matches.map((s) => <button key={s.id} className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-brand-50" onClick={() => { setChosen([...chosen, { serviceId: s.id, category: "LABORATORY" }]); setQ(""); }}>{s.name} · {money(s.price)}</button>)}
      </div>}
      {text.length >= 2 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="typed-test">
          <span className="text-sm text-slate-600">Add “{text}” at a price you type:</span>
          <Input aria-label="Price" placeholder="Price" inputMode="decimal" className="w-24" value={price} onChange={(e) => setPrice(e.target.value)} />
          <Input aria-label="Tax percent" placeholder="Tax %" inputMode="decimal" className="w-16" value={tax} onChange={(e) => setTax(e.target.value)} />
          <Button variant="secondary" disabled={!canType} onClick={addTyped}>Add test</Button>
        </div>
      )}
      {chosen.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100">
          {chosen.map((c, i) => (
            <li key={i} className="flex items-center gap-2 py-1 text-sm">
              <span className="flex-1">{label(c)}{"price" in c ? <span className="text-xs text-slate-500"> · {money(c.price)}{Number(c.taxPercent) > 0 ? ` + ${c.taxPercent}% tax` : ""}</span> : null}</span>
              <Select aria-label="Kind of test" className="w-36" value={c.category} onChange={(e) => setChosen(chosen.map((x, j) => (j === i ? { ...x, category: e.target.value as Category } : x)))}>
                <option value="LABORATORY">Laboratory</option><option value="RADIOLOGY">Imaging</option><option value="CARDIOLOGY">Cardiology</option><option value="PROCEDURE">Procedure</option>
              </Select>
              <button aria-label="Remove test" className="text-slate-400 hover:text-red-700" onClick={() => setChosen(chosen.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={bill.error ?? none.error} />
      <div className="mt-2 flex items-center justify-between">
        <Button variant="ghost" loading={none.isPending} onClick={() => none.mutate()}>No tests on this prescription</Button>
        <Button loading={bill.isPending} disabled={chosen.length === 0} onClick={() => bill.mutate()}>Bill {chosen.length || ""} {chosen.length === 1 ? "test" : "tests"}{chosen.length ? ` · ${money(total.toFixed(2))}` : ""}</Button>
      </div>
    </div>
  );
}

/** The Cashier's list of tests the doctors advised: from signed prescriptions, and from handwritten pictures (docs/test-orders.md). */
export function TestsToBill() {
  const queue = useQuery({ queryKey: ["test-queue"], queryFn: () => api.get<Queue>("/test-orders/queue"), refetchInterval: 20_000 });
  const services = useQuery({ queryKey: ["services-all"], queryFn: () => api.page<Service>("/services", { pageSize: 100 }) });
  const list = services.data?.data ?? [];
  const count = (queue.data?.visits.length ?? 0) + (queue.data?.handwritten.length ?? 0);
  return (
    <Card title={`Tests the doctors advised${count ? ` (${count})` : ""}`}>
      {queue.isLoading ? <Spinner /> : count === 0 ? <p className="text-sm text-slate-500">No tests are waiting to be billed.</p> : (
        <div className="space-y-3">
          {queue.data?.visits.map((v) => <VisitCard key={v.encounterId} v={v} services={list} />)}
          {queue.data?.handwritten.map((p) => <PictureCard key={p.scanId} p={p} services={list} />)}
        </div>
      )}
      <ErrorNote error={queue.error} />
    </Card>
  );
}
