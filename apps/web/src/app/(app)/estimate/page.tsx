"use client";
import { Gate } from "@/components/gate";
import { EstimatePanel } from "@/components/insurance-money";
import { PageHeader } from "@/components/ui";

/** Before admission: what each insurer pays and what the family pays (docs/insurance-money.md). */
export default function EstimatePage() {
  return (
    <Gate anyOf={["CLAIM_READ"]}>
      <PageHeader title="Estimate for the family" />
      <EstimatePanel />
    </Gate>
  );
}
