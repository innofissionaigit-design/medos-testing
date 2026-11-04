"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { PayrollEmployees, PayrollRuns } from "@/components/payroll";
import { PageHeader, Tabs } from "@/components/ui";

export default function PayrollPage() {
  const [tab, setTab] = useState<"runs" | "employees">("runs");
  return (
    <Gate anyOf={["PAYROLL_READ"]}>
      <PageHeader title="Payroll" />
      <Tabs tabs={[{ id: "runs", label: "Monthly payroll" }, { id: "employees", label: "Employees and pay" }]} value={tab} onChange={setTab} />
      {tab === "runs" && <PayrollRuns />}
      {tab === "employees" && <PayrollEmployees />}
    </Gate>
  );
}
