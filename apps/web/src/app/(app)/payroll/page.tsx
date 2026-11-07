"use client";
import { useState } from "react";
import { Gate } from "@/components/gate";
import { AttendanceSheet, LeaveManager } from "@/components/attendance";
import { PayrollEmployees, PayrollRuns } from "@/components/payroll";
import { PageHeader, Tabs } from "@/components/ui";

export default function PayrollPage() {
  const [tab, setTab] = useState<"runs" | "attendance" | "leave" | "employees">("runs");
  return (
    <Gate anyOf={["PAYROLL_READ"]}>
      <PageHeader title="Payroll" />
      <Tabs tabs={[{ id: "runs", label: "Monthly payroll" }, { id: "attendance", label: "Attendance" }, { id: "leave", label: "Leave" }, { id: "employees", label: "Employees and pay" }]} value={tab} onChange={setTab} />
      {tab === "runs" && <PayrollRuns />}
      {tab === "attendance" && <AttendanceSheet />}
      {tab === "leave" && <LeaveManager />}
      {tab === "employees" && <PayrollEmployees />}
    </Gate>
  );
}
