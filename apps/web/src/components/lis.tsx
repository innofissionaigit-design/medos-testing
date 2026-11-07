"use client";
import { useState } from "react";
import { LabCritical, LabTests, LabWorklist } from "@/components/lab";
import { RadCritical, RadWorklist } from "@/components/radiology";
import { Notice, PageHeader, Tabs } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { type Branch, lisBranches } from "@/lib/lis-branches";
import { useMe } from "@/lib/me";

export type { Branch };

function Pathology() {
  const { can } = useMe();
  // What each person sees follows their job: the tests and ranges list belongs to whoever maintains the test catalogue.
  const tabs = [
    { id: "work" as const, label: "Work list" },
    { id: "critical" as const, label: "Critical results" },
    ...(can("LAB_MASTERS") ? [{ id: "tests" as const, label: "Tests and ranges" }] : []),
  ];
  const [tab, setTab] = useState<"work" | "critical" | "tests">("work");
  return (
    <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "work" && <LabWorklist />}
      {tab === "critical" && <LabCritical />}
      {tab === "tests" && can("LAB_MASTERS") && <LabTests />}
    </>
  );
}

function Radiology() {
  const [tab, setTab] = useState<"work" | "critical">("work");
  return (
    <>
      <Tabs tabs={[{ id: "work", label: "Work list" }, { id: "critical", label: "Critical findings" }]} value={tab} onChange={setTab} />
      {tab === "work" && <RadWorklist />}
      {tab === "critical" && <RadCritical />}
    </>
  );
}

/** One module, two branches. A person with one branch sees only that branch; a person with both can switch. */
export function Lis({ requested, onBranch }: { requested: string | null; onBranch: (b: Branch) => void }) {
  const t = useT();
  const { can } = useMe();
  const { allowed, first } = lisBranches(can);
  if (allowed.length === 0) return <Notice tone="warn">You do not have access to this page.</Notice>;
  const branch: Branch = allowed.includes(requested as Branch) ? (requested as Branch) : first;
  return (
    <>
      <PageHeader title="LIS" subtitle={`${t("Laboratory Information System")} · ${t(branch === "pathology" ? "Pathology" : "Radiology")}`} />
      {allowed.length > 1 && (
        <Tabs tabs={allowed.map((b) => ({ id: b, label: b === "pathology" ? "Pathology" : "Radiology" }))} value={branch} onChange={onBranch} />
      )}
      {requested && !allowed.includes(requested as Branch) && ["pathology", "radiology"].includes(requested) && <Notice tone="warn">You do not have access to this branch.</Notice>}
      {branch === "pathology" ? <Pathology key="p" /> : <Radiology key="r" />}
    </>
  );
}
