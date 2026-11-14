"use client";
import { Gate } from "@/components/gate";
import { MissedBilling } from "@/components/missed-billing";
import { PageHeader } from "@/components/ui";

/** Missed billing (docs/missed-billing.md): things done but not found on a bill, for the billing person to look at and decide on. */
export default function MissedBillingPage() {
  return (
    <Gate anyOf={["MISSED_BILLING_READ"]}>
      <PageHeader title="Missed billing" subtitle="Things that were done but are not on a bill. Look at each one and decide." />
      <MissedBilling />
    </Gate>
  );
}
