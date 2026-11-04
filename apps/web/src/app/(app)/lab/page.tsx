"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { LabCritical, LabTests, LabWorklist } from "@/components/lab";
import { PageHeader, Tabs } from "@/components/ui";

export default function LabPage() {
  const [tab, setTab] = useState<"work" | "critical" | "tests">("work");
  return (
    <Gate anyOf={["LAB_READ"]}>
      <PageHeader title="Laboratory" />
      <Tabs tabs={[{ id: "work", label: "Work list" }, { id: "critical", label: "Critical results" }, { id: "tests", label: "Tests and ranges" }]} value={tab} onChange={setTab} />
      {tab === "work" && <LabWorklist />}
      {tab === "critical" && <LabCritical />}
      {tab === "tests" && <LabTests />}
    </Gate>
  );
}
