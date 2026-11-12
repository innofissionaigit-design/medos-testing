"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { ConsumptionTab, IndentsTab, OrdersTab, RequirementTab } from "@/components/procurement";
import { CostLedgerTab, PayablesTab, StockCountsTab, StoreRequestsTab } from "@/components/procurement-extras";
import { PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";

/** Procurement to consumption (docs/procurement.md): what is short, the indent and its approval, the purchase order, and what the OT and departments use. */
export default function ProcurementPage() {
  const { can } = useMe();
  const [tab, setTab] = useState<"requirement" | "indents" | "orders" | "requests" | "payables" | "counts" | "ledger" | "consumption">(can("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ") ? "requirement" : "consumption");
  const [start, setStart] = useState<{ med: { id: string; brandName: string; genericName: string; strength: string | null }; qty: string }[] | null>(null);
  const chain = can("STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ");
  return (
    <Gate anyOf={["STORES_INDENT", "PURCHASE_ORDER", "PURCHASE_APPROVE", "PURCHASE_READ", "STOCK_CONSUME", "STOCK_COUNT", "STOCK_COUNT_APPROVE", "SUPPLIER_PAY"]} feature="PHARMACY_ENABLED">
      <PageHeader title="Procurement" />
      <Tabs tabs={[...(chain ? [{ id: "requirement" as const, label: "Stock requirement" }, { id: "indents" as const, label: "Indents" }, { id: "orders" as const, label: "Purchase orders" }, { id: "requests" as const, label: "Store requests" }] : []), ...(can("SUPPLIER_PAY", "PURCHASE_READ") ? [{ id: "payables" as const, label: "Supplier payments" }] : []), ...(can("STOCK_COUNT", "STOCK_COUNT_APPROVE", "PURCHASE_READ") ? [{ id: "counts" as const, label: "Stock counts" }] : []), ...(can("REPORT_FINANCE", "PURCHASE_READ", "SUPPLIER_PAY") ? [{ id: "ledger" as const, label: "Cost ledger" }] : []), ...(can("STOCK_CONSUME", "PURCHASE_READ", "PHARMACY_READ") ? [{ id: "consumption" as const, label: "OT and department use" }] : [])]} value={tab} onChange={setTab} />
      {tab === "requirement" && chain && <RequirementTab onIndent={(lines) => { setStart(lines); setTab("indents"); }} />}
      {tab === "indents" && chain && <IndentsTab start={start} onStartUsed={() => setStart(null)} />}
      {tab === "orders" && chain && <OrdersTab />}
      {tab === "requests" && chain && <StoreRequestsTab />}
      {tab === "payables" && <PayablesTab />}
      {tab === "counts" && <StockCountsTab />}
      {tab === "ledger" && <CostLedgerTab />}
      {tab === "consumption" && <ConsumptionTab />}
    </Gate>
  );
}
