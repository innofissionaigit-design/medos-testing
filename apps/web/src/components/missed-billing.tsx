"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea } from "./ui";

type Decision = "NOT_A_GAP" | "BILLED" | "WAIVED";
interface Item {
  key: string; type: string; label: string; at: string; detail: string; amount: string | null;
  link: { kind: "ADMISSION" | "VISIT" | "INVOICE" | "CLAIM" | "PATIENT"; id: string };
  patient: { id: string; name: string; mrn: string | null };
  review: { decision: Decision; reason: string; at: string } | null;
}
interface Summary { type: string; label: string; open: number; reviewed: number; openAmount: string; unpriced: number }
interface Report { note: string; from: string; to: string; openCount: number; possibleMissedIncome: string; unpricedOpen: number; summary: Summary[]; items: Item[] }

const CHOICES: { id: Decision; label: string; hint: string; min: number }[] = [
  { id: "NOT_A_GAP", label: "It is fine, nothing more to bill", hint: "For example a free follow-up visit, or a test the patient did not have done here.", min: 5 },
  { id: "BILLED", label: "It has been billed", hint: "Say where: the bill number, or that it was added to another bill.", min: 5 },
  { id: "WAIVED", label: "We chose not to bill it", hint: "The hospital gives this up on purpose. Say who agreed and why.", min: 10 },
];
const DECISION_TEXT: Record<Decision, string> = { NOT_A_GAP: "fine, nothing to bill", BILLED: "billed", WAIVED: "not billed on purpose" };
const DECISION_TONE = { NOT_A_GAP: "gray", BILLED: "green", WAIVED: "amber" } as const;

/** Where a person goes to look at the record a flag is about. */
function lookHref(l: Item["link"]): string {
  switch (l.kind) {
    case "ADMISSION": return `/ipd/${l.id}`;
    case "VISIT": return `/visits/${l.id}`;
    case "INVOICE": return `/billing/${l.id}`;
    case "CLAIM": return `/claims`;
    default: return `/patients/${l.id}`;
  }
}

const isoDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * "Done but not billed" (docs/missed-billing.md): what was done but cannot be found on a bill, as possible missed income. It only points: the billing person looks at each
 * flag and decides it is fine, has been billed, or is not going to be billed. The server works out the flags and every amount.
 */
export function MissedBilling() {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [type, setType] = useState("");
  const [status, setStatus] = useState<"OPEN" | "REVIEWED" | "ALL">("OPEN");
  const [deciding, setDeciding] = useState<Item | null>(null);
  const [choice, setChoice] = useState<Decision>("NOT_A_GAP");
  const [reason, setReason] = useState("");
  const query = { from, to, status, ...(type ? { type } : {}) };
  const rep = useQuery({ queryKey: ["missed-billing", query], queryFn: () => api.get<Report>("/billing/missed-income", query) });
  const save = useMutation({
    mutationFn: () => api.post("/billing/missed-income/reviews", { flagKey: deciding!.key, decision: choice, reason: reason.trim() }),
    onSuccess: async () => { setDeciding(null); setReason(""); setChoice("NOT_A_GAP"); await qc.invalidateQueries({ queryKey: ["missed-billing"] }); },
  });
  const need = CHOICES.find((c) => c.id === choice)!.min;
  const d = rep.data;
  const dateError = from > to ? "The start date is after the end date" : undefined;

  return (
    <>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From" error={dateError}><Input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="What was missed">
            <Select aria-label="What was missed" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All kinds</option>
              {d?.summary.map((s) => <option key={s.type} value={s.type}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="Show">
            <Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="OPEN">Still to look at</option><option value="REVIEWED">Already decided</option><option value="ALL">Everything</option>
            </Select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">At most 92 days at a time.</p>
      </Card>

      {rep.isLoading ? <Spinner /> : rep.error ? <ErrorNote error={rep.error} /> : d && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Flags to look at</div><div className="text-2xl font-semibold" data-testid="open-count">{d.openCount}</div></div>
            <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Possible missed income</div><div className="text-2xl font-semibold" data-testid="possible-income">{money(d.possibleMissedIncome)}</div>
              {d.unpricedOpen > 0 && <div className="text-xs text-slate-500">plus {d.unpricedOpen} flag{d.unpricedOpen === 1 ? "" : "s"} with no amount</div>}</div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">{d.note}</div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2" aria-label="By kind">
            {d.summary.filter((s) => s.open + s.reviewed > 0).map((s) => (
              <button key={s.type} type="button" onClick={() => setType(type === s.type ? "" : s.type)} className={`rounded-full border px-3 py-1 text-sm ${type === s.type ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-700"}`}>
                {s.label}: <b>{s.open}</b>{s.reviewed > 0 ? <span className="text-slate-400"> · {s.reviewed} decided</span> : null}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <Card>
              <Table head={["When", "Patient", "What", "Possible amount", ""]} {...(d.items.length === 0 ? { empty: status === "OPEN" ? "Nothing to look at in this period." : "Nothing to show." } : {})}>
                {d.items.map((i) => (
                  <tr key={i.key}>
                    <Td>{dateTime(i.at).split(",")[0]}</Td>
                    <Td><Link className="font-medium text-brand-700 hover:underline" href={`/patients/${i.patient.id}`}>{i.patient.name}</Link>{i.patient.mrn ? <span className="text-slate-500"> · {i.patient.mrn}</span> : null}</Td>
                    <Td>
                      <div className="font-medium">{i.label}</div>
                      <div className="text-xs text-slate-600">{i.detail}</div>
                      {i.review && <div className="mt-1 text-xs"><Badge tone={DECISION_TONE[i.review.decision]}>{DECISION_TEXT[i.review.decision]}</Badge> <span className="text-slate-600">{i.review.reason}</span></div>}
                    </Td>
                    <Td>{i.amount === null ? <span className="text-slate-400">not known</span> : money(i.amount)}</Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Link className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50" href={lookHref(i.link)}>Look</Link>
                        {!i.review && can("MISSED_BILLING_REVIEW") && <Button variant="secondary" onClick={() => { setDeciding(i); setChoice("NOT_A_GAP"); setReason(""); }}>Decide</Button>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      )}

      {deciding && (
        <Modal title="What did you find?" onClose={() => setDeciding(null)}>
          <div className="space-y-3 text-sm">
            <div><div className="font-medium">{deciding.label}</div><div className="text-slate-600">{deciding.patient.name}: {deciding.detail}</div></div>
            <fieldset className="space-y-2">
              {CHOICES.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 p-2">
                  <input type="radio" name="decision" className="mt-1" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                  <span><span className="font-medium">{c.label}</span><span className="block text-xs text-slate-500">{c.hint}</span></span>
                </label>
              ))}
            </fieldset>
            <Field label="Reason" hint={`At least ${need} characters. It is kept with your name and cannot be changed later.`}>
              <Textarea aria-label="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {choice === "WAIVED" && <Notice tone="warn">Choosing not to bill gives this income up. A manager can see who decided.</Notice>}
            <ErrorNote error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button>
              <Button loading={save.isPending} disabled={reason.trim().length < need} onClick={() => save.mutate()}>Save decision</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
