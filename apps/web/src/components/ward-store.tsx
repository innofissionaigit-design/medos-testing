"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Button, Card, ErrorNote, Input, Notice, Select, Spinner, Table, Td } from "./ui";

interface Store { id: string; name: string; units: number; transfersOnTheWay: number }
interface StoreStock { location: { id: string; name: string }; units: number; items: { batchId: string; brandName: string; strength: string | null; batchNo: string; expiryDate: string; batchStatus: string; sellingPrice: string; quantity: number }[] }
interface Issue { id: string; at: string; location: string; medicine: string; batchNo: string; quantity: number; unitPrice: string; amount: string; remarks: string | null; by: string | null }
interface Incoming { id: string; transferNumber: string; at: string; from: { name: string }; to: { id: string | null; name: string }; items: { quantity: number; medicine: string; strength: string | null; batchNo: string }[] }

/**
 * The ward store for a nurse (docs/stock-transfers.md): stock sent to the ward can be confirmed as arrived, and medicines are taken from the ward store for the
 * patient in front of them. Each one is written to the store's ledger and charged to the patient's admission, so nothing leaves the shelf without a record.
 */
export function WardStoreCard({ admissionId, open }: { admissionId: string; open: boolean }) {
  const { can, dateTime, money } = useMe();
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ["ward-stores"], queryFn: () => api.get<Store[]>("/nursing/ward-stores"), enabled: can("NURSING_READ") });
  const [storeId, setStoreId] = useState("");
  const chosen = storeId || stores.data?.[0]?.id || "";
  const stock = useQuery({ queryKey: ["ward-store-stock", chosen], queryFn: () => api.get<StoreStock>(`/nursing/ward-stores/${chosen}/stock`), enabled: !!chosen });
  const issues = useQuery({ queryKey: ["ward-issues", admissionId], queryFn: () => api.get<Issue[]>(`/admissions/${admissionId}/ward-store-issues`), enabled: can("NURSING_READ") });
  const incoming = useQuery({ queryKey: ["ward-incoming"], queryFn: () => api.get<{ items: Incoming[] }>("/nursing/ward-stores/incoming"), enabled: can("NURSING_READ") });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const mayGive = can("NURSING_MEDICATION_ADMINISTER", "PHARMACY_DISPENSE") && open;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ward-store-stock"] }); void qc.invalidateQueries({ queryKey: ["ward-stores"] }); void qc.invalidateQueries({ queryKey: ["ward-issues", admissionId] });
    void qc.invalidateQueries({ queryKey: ["ward-incoming"] }); void qc.invalidateQueries({ queryKey: ["charges", admissionId] }); void qc.invalidateQueries({ queryKey: ["admission", admissionId] });
  };
  const give = useMutation({
    mutationFn: (i: StoreStock["items"][number]) => api.post<Issue>(`/admissions/${admissionId}/ward-store-issues`, { locationId: chosen, batchId: i.batchId, quantity: Number(qty[i.batchId]), ...(remarks.trim() ? { remarks: remarks.trim() } : {}) }, newKey()),
    onSuccess: (r) => { setDone(`${r.quantity} × ${r.medicine} taken from ${r.location} and charged to the patient: ${money(r.amount)}`); setQty({}); refresh(); },
  });
  const arrived = useMutation({ mutationFn: (t: Incoming) => api.post(`/pharmacy/transfers/${t.id}/receive`, {}, newKey()), onSuccess: refresh });
  if (!can("NURSING_READ")) return null;
  const waiting = incoming.data?.items ?? [];
  if ((stores.data?.length ?? 0) === 0 && waiting.length === 0 && (issues.data?.length ?? 0) === 0) return null;
  return (
    <div className="mt-4 space-y-4">
      {waiting.length > 0 && can("NURSING_MEDICATION_ADMINISTER") && (
        <Card title="Stock on its way to the ward">
          <ErrorNote error={arrived.error} />
          <Table head={["Number", "Sent", "From → To", "What", ""]}>
            {waiting.map((t) => (
              <tr key={t.id}><Td>{t.transferNumber}</Td><Td>{dateTime(t.at)}</Td><Td>{t.from.name} → {t.to.name}</Td><Td>{t.items.map((i) => `${i.quantity} × ${i.medicine} ${i.strength ?? ""} (batch ${i.batchNo})`).join("; ")}</Td>
                <Td><Button variant="secondary" loading={arrived.isPending && arrived.variables?.id === t.id} onClick={() => arrived.mutate(t)}>It has arrived</Button></Td></tr>
            ))}
          </Table>
        </Card>
      )}
      <Card title="Ward store">
        {(stores.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No ward store is set up. The pharmacy can add one under Pharmacy → Locations and transfers.</p> : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Take a medicine from the ward store for this patient. It is written off the store's stock and charged to the patient's bill at the price on the batch.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Ward store" className="w-64" value={chosen} onChange={(e) => { setStoreId(e.target.value); setQty({}); setDone(null); }}>{stores.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.units} units)</option>)}</Select>
              {mayGive && <Input className="min-w-60 flex-1" aria-label="Remarks" placeholder="Remarks (optional), e.g. night dose" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}
            </div>
            {!open && <Notice>This admission is closed, so medicines can no longer be taken for it.</Notice>}
            <ErrorNote error={give.error} />
            {done && <Notice tone="success">{done}</Notice>}
            {stock.isLoading ? <Spinner /> : (
              <Table head={["Medicine", "Batch", "Expires", "Price", "In store", ...(mayGive ? ["Take"] : [])]} {...(stock.data?.items.length === 0 ? { empty: "This store holds nothing right now." } : {})}>
                {stock.data?.items.map((i) => (
                  <tr key={i.batchId}>
                    <Td>{i.brandName} {i.strength}</Td><Td>{i.batchNo}{i.batchStatus === "BLOCKED" && <span className="ml-1 text-xs text-red-700">blocked</span>}</Td><Td>{i.expiryDate}</Td><Td>{money(i.sellingPrice)}</Td><Td>{i.quantity}</Td>
                    {mayGive && <Td className="whitespace-nowrap"><Input aria-label={`Quantity of ${i.brandName} batch ${i.batchNo}`} className="inline-block w-20" inputMode="numeric" placeholder="0" value={qty[i.batchId] ?? ""} onChange={(e) => { setQty({ ...qty, [i.batchId]: e.target.value.replace(/[^0-9]/g, "") }); setDone(null); }} />{" "}
                      <Button variant="secondary" disabled={!(Number(qty[i.batchId]) > 0) || Number(qty[i.batchId]) > i.quantity || i.batchStatus !== "ACTIVE"} loading={give.isPending && give.variables?.batchId === i.batchId} onClick={() => give.mutate(i)}>Take</Button></Td>}
                  </tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </Card>
      {(issues.data?.length ?? 0) > 0 && (
        <Card title="Medicines taken from ward stores for this patient">
          <Table head={["When", "Medicine", "Batch", "Quantity", "Charged", "By"]}>
            {issues.data?.map((i) => <tr key={i.id}><Td>{dateTime(i.at)}</Td><Td>{i.medicine}<div className="text-xs text-slate-500">{i.location}{i.remarks ? ` · ${i.remarks}` : ""}</div></Td><Td>{i.batchNo}</Td><Td>{i.quantity}</Td><Td>{money(i.amount)}</Td><Td>{i.by ?? "—"}</Td></tr>)}
          </Table>
        </Card>
      )}
    </div>
  );
}
