"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { FollowUpTab, InsuranceReports, OverpaymentTab, OwedTab, PaymentTab, WriteOffTab } from "@/components/insurance-money";
import { PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";

type Tab = "owed" | "pay" | "follow" | "writeoff" | "over" | "reports";

/** Insurance money (docs/insurance-money.md): what insurers owe, the payments they make matched to claims, follow-ups, write-offs, overpayments and the reports. */
export default function InsuranceMoneyPage() {
  const { can } = useMe();
  const [tab, setTab] = useState<Tab>("owed");
  const tabs: { id: Tab; label: string }[] = [
    { id: "owed", label: "What insurers owe" },
    ...(can("CLAIM_SETTLE") ? [{ id: "pay" as const, label: "Record a payment" }] : []),
    { id: "follow", label: "Follow-ups" }, { id: "writeoff", label: "Write-offs" }, { id: "over", label: "Overpayments" },
    ...(can("REPORT_READ", "REPORT_FINANCE") ? [{ id: "reports" as const, label: "Reports" }] : []),
  ];
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <PageHeader title="Insurance money" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="mt-3 space-y-4">
        {tab === "owed" && <OwedTab />}
        {tab === "pay" && <PaymentTab />}
        {tab === "follow" && <FollowUpTab />}
        {tab === "writeoff" && <WriteOffTab />}
        {tab === "over" && <OverpaymentTab />}
        {tab === "reports" && <InsuranceReports />}
      </div>
    </Gate>
  );
}
