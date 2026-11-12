"use client";
import { useState } from "react";
import { CallListTab, ComplaintsTab, FeedbackTab, JourneySummary, ScriptsTab } from "@/components/aftercare";
import { Gate } from "@/components/gate";
import { PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/me";

/** The post-discharge journey (docs/aftercare.md): review calls and booking, what patients say, and complaints followed to a resolution. */
export default function AftercarePage() {
  const { can } = useMe();
  const calls = can("AFTERCARE_MANAGE");
  const [tab, setTab] = useState<"calls" | "feedback" | "complaints" | "scripts">(calls ? "calls" : "complaints");
  return (
    <Gate anyOf={["AFTERCARE_MANAGE", "COMPLAINT_READ", "COMPLAINT_MANAGE"]}>
      <PageHeader title="After discharge" />
      {(calls || can("COMPLAINT_READ")) && can("AFTERCARE_MANAGE") && <JourneySummary />}
      <Tabs tabs={[...(calls ? [{ id: "calls" as const, label: "Review calls" }] : []), ...(calls || can("COMPLAINT_READ") ? [{ id: "feedback" as const, label: "Feedback" }] : []), ...(can("COMPLAINT_READ", "COMPLAINT_MANAGE") ? [{ id: "complaints" as const, label: "Complaints" }] : []), ...(can("AFTERCARE_CONFIGURE") ? [{ id: "scripts" as const, label: "Call scripts" }] : [])]} value={tab} onChange={setTab} />
      {tab === "calls" && calls && <CallListTab />}
      {tab === "feedback" && <FeedbackTab />}
      {tab === "complaints" && <ComplaintsTab />}
      {tab === "scripts" && can("AFTERCARE_CONFIGURE") && <ScriptsTab />}
    </Gate>
  );
}
