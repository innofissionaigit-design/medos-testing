"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { RadCritical, RadWorklist } from "@/components/radiology";
import { PageHeader, Tabs } from "@/components/ui";

export default function RadiologyPage() {
  const [tab, setTab] = useState<"work" | "critical">("work");
  return (
    <Gate anyOf={["RAD_READ"]}>
      <PageHeader title="Radiology" />
      <Tabs tabs={[{ id: "work", label: "Work list" }, { id: "critical", label: "Critical findings" }]} value={tab} onChange={setTab} />
      {tab === "work" && <RadWorklist />}
      {tab === "critical" && <RadCritical />}
    </Gate>
  );
}
