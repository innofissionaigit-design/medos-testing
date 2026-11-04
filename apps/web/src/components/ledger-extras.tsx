"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Entry { at: string; kind: string; reference: string | null; description: string; debit: string; credit: string; balance: string; invoiceId: string | null }
interface Statement { entries: Entry[]; totals: { debit: string; credit: string; balance: string }; position: "PATIENT_OWES" | "HELD_FOR_PATIENT" | "SETTLED" }

/**
 * The patient's account statement (docs/patient-ledger.md): bills and money given back are debits, money received and charges taken back are credits,
 * with a running balance. Moving the patient's own advance onto a bill shows with zero amounts, because no money changes hands.
 */
export function LedgerCard({ patientId }: { patientId: string }) {
  const { can, money, dateTime } = useMe();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["ledger", patientId], queryFn: () => api.get<Statement>(`/patients/${patientId}/ledger`), enabled: can("INVOICE_READ") });
  if (!can("INVOICE_READ")) return null;
  const d = q.data;
  const balance = Number(d?.totals.balance ?? 0);
  const shown = d ? (all ? d.entries : d.entries.slice(-10)) : [];
  return (
    <Card title="Account statement (ledger)" actions={d && d.entries.length > 10 ? <Button variant="ghost" onClick={() => setAll(!all)}>{all ? "Show last 10" : `Show all ${d.entries.length}`}</Button> : undefined}>
      {q.isLoading ? <Spinner /> : !d || d.entries.length === 0 ? <p className="text-sm text-slate-500">No money movements yet.</p> : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            Balance <b>{money(Math.abs(balance).toFixed(2))}</b>
            <Badge tone={d.position === "PATIENT_OWES" ? "red" : d.position === "HELD_FOR_PATIENT" ? "blue" : "green"}>
              {d.position === "PATIENT_OWES" ? "patient owes" : d.position === "HELD_FOR_PATIENT" ? "held for the patient (advance)" : "settled"}
            </Badge>
            <span className="text-slate-500">Debits {money(d.totals.debit)} · Credits {money(d.totals.credit)}</span>
          </div>
          <Table head={["Date", "Reference", "Details", "Debit", "Credit", "Balance"]}>
            {shown.map((e, i) => (
              <tr key={`${e.reference}-${e.kind}-${i}`} className={e.debit === "0.00" && e.credit === "0.00" ? "text-slate-500" : undefined}>
                <Td>{dateTime(e.at)}</Td>
                <Td>{e.invoiceId ? <a className="text-brand-700 hover:underline" href={`/billing/${e.invoiceId}`}>{e.reference}</a> : e.reference}</Td>
                <Td>{e.description}</Td>
                <Td>{e.debit === "0.00" ? "" : money(e.debit)}</Td>
                <Td>{e.credit === "0.00" ? "" : money(e.credit)}</Td>
                <Td>{Number(e.balance) < 0 ? `${money(Math.abs(Number(e.balance)).toFixed(2))} held` : money(e.balance)}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  );
}
