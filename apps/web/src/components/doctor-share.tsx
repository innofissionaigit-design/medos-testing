"use client";
import { useQuery } from "@tanstack/react-query";
import { Card, ErrorNote, KV, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

export type EarningsModel = "BOTH" | "COMMISSION" | "FIXED_VALUE";
export const MODEL_LABEL: Record<EarningsModel, string> = {
  BOTH: "Commission or fixed value, chosen for each doctor",
  COMMISSION: "Commission: a percentage of what is collected",
  FIXED_VALUE: "Fixed value: a set amount for each visit",
};

interface VisitShare {
  encounterId: string; visitNumber: string; doctor: string | null; model: EarningsModel;
  rule: { mode: "PERCENT" | "FIXED" | "MIXED"; percent: string | null; fixedAmount: string | null } | null;
  bills: { id: string; invoiceNumber: string | null; kind: string; status: string; total: string; paid: string; refunded: string }[];
  billed: string; paidFromDeposit: string; collected: string; doctorShare: string; hospitalNet: string;
  entries: { id: string; at: string; trigger: "PAYMENT" | "REFUND"; invoiceNumber: string | null; collected: string; doctorShare: string; hospitalShare: string }[];
}

const ruleText = (r: NonNullable<VisitShare["rule"]>, money: (v: string) => string): string => {
  const pct = `${Number(r.percent ?? 0)}%`;
  return r.mode === "PERCENT" ? `Commission ${pct}` : r.mode === "FIXED" ? `Fixed ${money(r.fixedAmount ?? "0")} for the visit` : `Fixed ${money(r.fixedAmount ?? "0")} plus ${pct}`;
};

/**
 * The doctor's share of one visit, on the bill: what was billed and collected (money used from the patient's advance included), what the doctor earns under the
 * hospital's commission or fixed-value rule, what the hospital keeps, and the ledger lines behind it. Shown only to people who may see earnings.
 */
export function DoctorShareCard({ encounterId }: { encounterId: string }) {
  const { money, dateTime } = useMe();
  const q = useQuery({ queryKey: ["doctor-share", encounterId], queryFn: () => api.get<VisitShare>(`/earnings/visits/${encounterId}`) });
  if (q.isLoading) return <Card title="Doctor share"><Spinner /></Card>;
  if (q.error || !q.data) return <Card title="Doctor share"><ErrorNote error={q.error ?? new Error("Not available")} /></Card>;
  const v = q.data;
  return (
    <Card title={`Doctor share${v.doctor ? ` · ${v.doctor}` : ""}`} className="lg:col-span-3">
      <p className="mb-3 text-sm text-slate-600">
        {v.rule ? `${ruleText(v.rule, money)}. ` : "No earnings rule applies to this visit yet, so the hospital keeps all of it. "}
        {MODEL_LABEL[v.model]}. The patient's bill does not change; this is how the money collected is shared.
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KV label="Billed (consultation and in-patient)">{money(v.billed)}</KV>
        <KV label="Collected">{money(v.collected)}</KV>
        <KV label="Paid from advance">{money(v.paidFromDeposit)}</KV>
        <KV label="Doctor gets"><b className="text-brand-700">{money(v.doctorShare)}</b></KV>
        <KV label="Hospital keeps"><b>{money(v.hospitalNet)}</b></KV>
      </dl>
      {v.entries.length > 0 && (
        <div className="mt-4">
          <Table head={["When", "Bill", "What happened", "Money", "Doctor", "Hospital"]}>
            {v.entries.map((e) => (
              <tr key={e.id}><Td>{dateTime(e.at)}</Td><Td>{e.invoiceNumber ?? "—"}</Td><Td>{e.trigger === "PAYMENT" ? "Payment received" : "Money given back"}</Td><Td>{money(e.collected)}</Td><Td>{money(e.doctorShare)}</Td><Td>{money(e.hospitalShare)}</Td></tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}
