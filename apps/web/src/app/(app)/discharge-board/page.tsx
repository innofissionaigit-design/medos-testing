"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { FlowReportView, InsurerBoard, MyWorkList, WaitingBoard } from "@/components/discharge-flow";
import { PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";

type Tab = "waiting" | "mine" | "insurer" | "report";

/**
 * Going home (docs/discharge-flow.md): everyone who has been told they may go and has not yet left, longest wait first, with what is holding each
 * one up; each person's own pending items; the insurers still to reply; and the management figures.
 */
export default function DischargeBoardPage() {
  const { can } = useMe();
  const [tab, setTab] = useState<Tab>("waiting");
  const tabs: { id: Tab; label: string }[] = [
    { id: "waiting", label: "Waiting to go home" }, { id: "mine", label: "My work" }, { id: "insurer", label: "Insurer replies" },
    ...(can("REPORT_READ", "REPORT_IPD") ? [{ id: "report" as const, label: "Report" }] : []),
  ];
  return (
    <Gate anyOf={["ADMISSION_READ"]} feature="IPD_ENABLED">
      <PageHeader title="Going home" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="mt-3 space-y-4">
        {tab === "waiting" && <WaitingBoard />}
        {tab === "mine" && <MyWorkList />}
        {tab === "insurer" && <InsurerBoard />}
        {tab === "report" && <FlowReportView />}
      </div>
    </Gate>
  );
}
