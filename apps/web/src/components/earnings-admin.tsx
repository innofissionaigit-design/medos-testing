"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MODEL_LABEL, type EarningsModel } from "@/components/doctor-share";
import { Badge, Button, Card, ErrorNote, Field, Input, KV, Modal, Notice, Select, Spinner, Table, Td } from "@/components/ui";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

type Mode = "PERCENT" | "FIXED" | "MIXED";
interface Rule { id: string; practitionerId: string | null; doctor: string | null; mode: Mode; percent: string | null; fixedAmount: string | null; effectiveFrom: string; note: string | null; createdBy: string | null }
interface Doctor { id: string; displayName: string }
interface Ledger {
  from: string; to: string; model: EarningsModel; truncated: boolean;
  totals: { collected: string; doctorShare: string; hospitalShare: string };
  doctors: { practitionerId: string; doctor: string; collected: string; doctorShare: string; hospitalShare: string }[];
  entries: { id: string; at: string; trigger: "PAYMENT" | "REFUND"; doctor: string; visitNumber: string; invoiceNumber: string | null; billKind: string; collected: string; doctorShare: string; hospitalShare: string }[];
}

const MODES = [
  { id: "PERCENT", label: "Commission: a percentage of the amount collected" },
  { id: "FIXED", label: "Fixed value: a set amount for each consulted visit" },
  { id: "MIXED", label: "Fixed amount plus a percentage" },
] as const;
const MODELS: EarningsModel[] = ["COMMISSION", "FIXED_VALUE", "BOTH"];
/** The rule types the hospital's payment model allows for new rules. */
const allowedModes = (m: EarningsModel): Mode[] => (m === "COMMISSION" ? ["PERCENT"] : m === "FIXED_VALUE" ? ["FIXED"] : ["PERCENT", "FIXED", "MIXED"]);

/** Describes a rule the way staff would say it. */
export function describeRule(r: Pick<Rule, "mode" | "percent" | "fixedAmount">, money: (v: string) => string): string {
  const pct = `${Number(r.percent ?? 0)}%`;
  return r.mode === "PERCENT" ? `Doctor gets ${pct}, hospital keeps the rest` : r.mode === "FIXED" ? `Doctor gets ${money(r.fixedAmount ?? "0")} per consulted visit` : `Doctor gets ${money(r.fixedAmount ?? "0")} plus ${pct}`;
}

/** Whether the hospital pays doctors a commission or a fixed value, and what each doctor is paid. */
function PaymentModel({ model }: { model: EarningsModel | undefined }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (m: EarningsModel) => api.put("/earnings/model", { model: m }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["earnings-model"] }); void qc.invalidateQueries({ queryKey: ["earnings-ledger"] }); },
  });
  return (
    <Card title="How doctors are paid">
      <p className="mb-3 text-sm text-slate-600">
        Choose how this hospital pays doctors from the money collected: a commission, a fixed value for each visit, or either one for each doctor.
        The commission or fixed amount is posted to the doctor share ledger whenever money is received or given back, and shows on the bill and the final bill. It does not change what the patient pays.
      </p>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Payment model">
        {MODELS.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={model === m} disabled={!model || save.isPending} onClick={() => model !== m && save.mutate(m)}
            className={`rounded-md border px-3 py-2 text-left text-sm ${model === m ? "border-brand-600 bg-brand-50 font-medium text-brand-700" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
            {MODEL_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="mt-2"><ErrorNote error={save.error} /></div>
    </Card>
  );
}

/** Every line of the doctor share ledger for a few days: what was collected and how it was shared. */
function LedgerCard() {
  const { money, dateTime, me } = useMe();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: me.facility?.timezone ?? me.tenant.timezone });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ["earnings-ledger", from, to], queryFn: () => api.get<Ledger>(`/earnings/ledger?from=${from}&to=${to}`), enabled: !!from && !!to && to >= from });
  return (
    <Card title="Doctor share ledger">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="From"><Input type="date" aria-label="Ledger from" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" aria-label="Ledger to" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : !q.data ? null : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-3">
            <KV label="Collected">{money(q.data.totals.collected)}</KV>
            <KV label="Doctors get"><b className="text-brand-700">{money(q.data.totals.doctorShare)}</b></KV>
            <KV label="Hospital keeps"><b>{money(q.data.totals.hospitalShare)}</b></KV>
          </dl>
          {q.data.doctors.length > 0 && (
            <Table head={["Doctor", "Collected", "Doctor gets", "Hospital keeps"]}>
              {q.data.doctors.map((d) => <tr key={d.practitionerId}><Td>{d.doctor}</Td><Td>{money(d.collected)}</Td><Td>{money(d.doctorShare)}</Td><Td>{money(d.hospitalShare)}</Td></tr>)}
            </Table>
          )}
          {q.data.entries.length === 0 ? <p className="text-sm text-slate-500">Nothing was posted in these days. Lines appear when money is received or given back on a visit whose doctor has an earnings rule.</p> : (
            <Table head={["When", "Doctor", "Visit", "Bill", "What happened", "Money", "Doctor", "Hospital"]}>
              {q.data.entries.map((e) => (
                <tr key={e.id}><Td>{dateTime(e.at)}</Td><Td>{e.doctor}</Td><Td>{e.visitNumber}</Td><Td>{e.invoiceNumber ?? "—"}</Td><Td>{e.trigger === "PAYMENT" ? "Payment received" : "Money given back"}</Td><Td>{money(e.collected)}</Td><Td>{money(e.doctorShare)}</Td><Td>{money(e.hospitalShare)}</Td></tr>
              ))}
            </Table>
          )}
          {q.data.truncated && <p className="text-sm text-slate-500">Only the newest lines are shown. Choose fewer days to see the rest.</p>}
        </div>
      )}
    </Card>
  );
}

/** How each booking's money is split between the hospital and the doctor. Rules are added, never edited: older visits keep the rule that applied then. */
export function EarningsAdmin() {
  const qc = useQueryClient();
  const { money, me } = useMe();
  const model = useQuery({ queryKey: ["earnings-model"], queryFn: () => api.get<{ model: EarningsModel }>("/earnings/model") });
  const rules = useQuery({ queryKey: ["earnings-rules"], queryFn: () => api.get<Rule[]>("/earnings/rules") });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doctor[]>("/practitioners") });
  const blank = { practitionerId: "", mode: "PERCENT" as Mode, percent: "", fixedAmount: "", effectiveFrom: "", note: "" };
  const [f, setF] = useState(blank);
  const current = model.data?.model;
  const allowed = allowedModes(current ?? "BOTH");
  const mode: Mode = allowed.includes(f.mode) ? f.mode : (allowed[0] ?? "PERCENT");
  const needPercent = mode !== "FIXED";
  const needFixed = mode !== "PERCENT";
  const pct = Number(f.percent);
  const valid = (!needPercent || (f.percent !== "" && pct >= 0 && pct <= 100)) && (!needFixed || (f.fixedAmount !== "" && Number(f.fixedAmount) >= 0));
  const add = useMutation({
    mutationFn: () => api.post("/earnings/rules", {
      mode, ...(f.practitionerId ? { practitionerId: f.practitionerId } : {}), ...(needPercent ? { percent: pct } : {}), ...(needFixed ? { fixedAmount: f.fixedAmount } : {}),
      ...(f.effectiveFrom ? { effectiveFrom: f.effectiveFrom } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}),
    }),
    onSuccess: () => { setF(blank); void qc.invalidateQueries({ queryKey: ["earnings-rules"] }); },
  });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: me.facility?.timezone ?? me.tenant.timezone });
  const inForce = (r: Rule) => rules.data?.find((x) => x.practitionerId === r.practitionerId && x.effectiveFrom <= today)?.id === r.id;
  const mismatch = (r: Rule) => !allowed.includes(r.mode);
  const anyMismatch = !!rules.data?.some((r) => inForce(r) && mismatch(r));
  return (
    <div className="space-y-4">
      <PaymentModel model={current} />
      <Card title="Earnings split">
        <p className="mb-3 text-sm text-slate-600">
          Set the amount each doctor earns from the money collected. Set one default for every doctor, then add a rule for a doctor who is paid differently.
          Cancellation charges follow the percentage part only. A new rule applies from its start date; earlier visits keep the rule they had.
        </p>
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Applies to" className="sm:col-span-2"><Select aria-label="Applies to" value={f.practitionerId} onChange={(e) => setF({ ...f, practitionerId: e.target.value })}><option value="">Every doctor (default)</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</Select></Field>
          <Field label="How the doctor is paid" className="sm:col-span-2"><Select aria-label="Mode" value={mode} onChange={(e) => setF({ ...f, mode: e.target.value as Mode })}>{MODES.filter((m) => allowed.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
          {needPercent && <Field label="Commission %"><Input aria-label="Doctor percentage" inputMode="decimal" placeholder="e.g. 60" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>}
          {needFixed && <Field label="Fixed amount"><Input aria-label="Fixed amount" inputMode="decimal" placeholder="e.g. 300" value={f.fixedAmount} onChange={(e) => setF({ ...f, fixedAmount: e.target.value })} /></Field>}
          <Field label="Starts on"><Input type="date" aria-label="Starts on" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="Note (optional)" className="sm:col-span-3"><Input aria-label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <div className="flex items-end"><Button type="submit" loading={add.isPending} disabled={!valid}>Save rule</Button></div>
          <div className="col-span-2 sm:col-span-6"><ErrorNote error={add.error} /></div>
        </form>
      </Card>
      {anyMismatch && <Notice tone="warn">A rule in force was written for a different payment model than the one chosen above. It is still used for visits until you add a rule that fits the model.</Notice>}
      <Card title="Rules">
        {rules.isLoading ? <Spinner /> : !rules.data?.length ? <p className="text-sm text-slate-500">No rule yet. Until you add one, doctors are shown with no share and all money stays with the hospital.</p> : (
          <Table head={["Applies to", "Rule", "From", "Status", "Note", "Added by"]}>
            {rules.data.map((r) => (
              <tr key={r.id}><Td>{r.doctor ?? "Every doctor (default)"}</Td><Td>{describeRule(r, money)}</Td><Td>{r.effectiveFrom}</Td><Td>{inForce(r) ? (mismatch(r) ? "In force (other model)" : "In force") : r.effectiveFrom > today ? "Starts later" : "Replaced"}</Td><Td>{r.note ?? ""}</Td><Td>{r.createdBy ?? ""}</Td></tr>
            ))}
          </Table>
        )}
      </Card>
      <LedgerCard />
      <PayoutsCard />
    </div>
  );
}

interface Balances { defaultTdsPercent: string; totals: { earned: string; paid: string; owed: string }; doctors: { practitionerId: string; doctor: string; earned: string; paid: string; tdsDeducted: string; netPaid: string; owed: string }[] }
interface Voucher { id: string; payoutNumber: string; kind: "PAYMENT" | "REVERSAL"; doctor: string; practitionerId: string; gross: string; tdsPercent: string; tds: string; net: string; method: string; reference: string | null; note: string | null; paidAt: string; by: string | null; reversedBy: string | null; reverses: string | null }
interface Statement { doctor: string; from: string; to: string; opening: string; earned: string; paid: string; tdsDeducted: string; netPaid: string; closing: string; entries: { at: string; type: string; reference: string; amount: string; tds: string | null; net: string | null }[] }
const PAY_METHODS = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"];

/** Paying doctors what they have earned: what each is owed, vouchers with tax deducted at source, reversals, and a statement (docs/doctor-payouts.md). */
function PayoutsCard() {
  const { money, dateTime } = useMe();
  const qc = useQueryClient();
  const balances = useQuery({ queryKey: ["payout-balances"], queryFn: () => api.get<Balances>("/earnings/payouts/balances") });
  const vouchers = useQuery({ queryKey: ["payout-list"], queryFn: () => api.get<{ items: Voucher[] }>("/earnings/payouts?pageSize=25") });
  const [paying, setPaying] = useState<Balances["doctors"][number] | null>(null);
  const [reversing, setReversing] = useState<Voucher | null>(null);
  const [statement, setStatement] = useState<{ id: string; name: string } | null>(null);
  const done = () => { setPaying(null); setReversing(null); void qc.invalidateQueries({ queryKey: ["payout-balances"] }); void qc.invalidateQueries({ queryKey: ["payout-list"] }); };
  return (
    <Card title="Doctor payouts">
      <p className="mb-3 text-sm text-slate-600">What each doctor has earned from the money collected, what has been paid out, and what is still owed. Paying a doctor records a voucher with the tax deducted at source; a voucher made by mistake is undone with a reversal, never deleted. This records the payout; it does not move money.</p>
      {balances.isLoading ? <Spinner /> : balances.error ? <ErrorNote error={balances.error} /> : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-3"><KV label="Earned">{money(balances.data?.totals.earned ?? "0")}</KV><KV label="Paid out">{money(balances.data?.totals.paid ?? "0")}</KV><KV label="Still owed"><b>{money(balances.data?.totals.owed ?? "0")}</b></KV></dl>
          <Table head={["Doctor", "Earned", "Paid out", "Tax deducted", "Still owed", ""]} {...(balances.data?.doctors.length === 0 ? { empty: "Nothing earned yet. A doctor appears here once money is collected on a visit under an earnings rule." } : {})}>
            {balances.data?.doctors.map((d) => (
              <tr key={d.practitionerId}>
                <Td>{d.doctor}</Td><Td>{money(d.earned)}</Td><Td>{money(d.paid)}</Td><Td>{money(d.tdsDeducted)}</Td><Td><b>{money(d.owed)}</b></Td>
                <Td className="space-x-1 whitespace-nowrap"><Button variant="secondary" disabled={Number(d.owed) <= 0} onClick={() => setPaying(d)}>Pay…</Button><Button variant="ghost" onClick={() => setStatement({ id: d.practitionerId, name: d.doctor })}>Statement</Button></Td>
              </tr>
            ))}
          </Table>
        </>
      )}
      <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-700">Vouchers</h3>
      {vouchers.isLoading ? <Spinner /> : (
        <Table head={["Voucher", "Doctor", "When", "Share", "Tax", "Paid", "How", ""]} {...(vouchers.data?.items.length === 0 ? { empty: "No payouts yet." } : {})}>
          {vouchers.data?.items.map((v) => (
            <tr key={v.id} className={v.kind === "REVERSAL" ? "bg-amber-50" : ""}>
              <Td>{v.payoutNumber}{v.kind === "REVERSAL" && <div className="text-xs text-amber-800">reverses {v.reverses}</div>}{v.reversedBy && <div className="text-xs text-slate-500">reversed by {v.reversedBy}</div>}</Td>
              <Td>{v.doctor}</Td><Td>{dateTime(v.paidAt)}</Td><Td>{money(v.gross)}</Td><Td>{money(v.tds)} <span className="text-xs text-slate-500">({Number(v.tdsPercent)}%)</span></Td><Td>{money(v.net)}</Td>
              <Td>{v.method.replace("_", " ").toLowerCase()}{v.reference ? <div className="text-xs text-slate-500">{v.reference}</div> : null}</Td>
              <Td className="space-x-1 whitespace-nowrap"><PrintLink className="text-brand-700 hover:underline" href={printUrl(`doctor-payouts/${v.id}`)}>Print</PrintLink>{v.kind === "PAYMENT" && !v.reversedBy && <Button variant="ghost" onClick={() => setReversing(v)}>Reverse…</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
      {paying && <PayModal doctor={paying} defaultTds={balances.data?.defaultTdsPercent ?? "0"} onClose={() => setPaying(null)} onDone={done} />}
      {reversing && <ReverseModal voucher={reversing} onClose={() => setReversing(null)} onDone={done} />}
      {statement && <StatementModal doctor={statement} onClose={() => setStatement(null)} />}
    </Card>
  );
}

function PayModal({ doctor, defaultTds, onClose, onDone }: { doctor: Balances["doctors"][number]; defaultTds: string; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [amount, setAmount] = useState(doctor.owed);
  const [tds, setTds] = useState(String(Number(defaultTds)));
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [key] = useState(newKey);
  const gross = Number(amount) || 0;
  const tax = Math.round(gross * (Number(tds) || 0)) / 100;
  const pay = useMutation({
    mutationFn: () => api.post("/earnings/payouts", { practitionerId: doctor.practitionerId, amount, tdsPercent: Number(tds) || 0, method, ...(reference.trim() ? { reference: reference.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }, key),
    onSuccess: onDone,
  });
  const valid = gross > 0 && gross <= Number(doctor.owed) && (method === "CASH" || reference.trim().length >= 4);
  return (
    <Modal title={`Pay ${doctor.doctor}: owed ${money(doctor.owed)}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Share to pay"><Input autoFocus aria-label="Share to pay" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Tax deducted at source (%)"><Input aria-label="Tax percent" inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} /></Field>
          <Field label="Paid by"><Select aria-label="Paid by" value={method} onChange={(e) => setMethod(e.target.value)}>{PAY_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ").toLowerCase()}</option>)}</Select></Field>
          <Field label={method === "CASH" ? "Reference (optional)" : "Reference (transaction id)"}><Input aria-label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        </div>
        <Field label="Note (optional)"><Input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Notice>The doctor receives <b>{money(Math.max(0, gross - tax))}</b> after {money(tax)} tax deducted at source.</Notice>
        {gross > Number(doctor.owed) && <Notice tone="error">That is more than the {money(doctor.owed)} owed.</Notice>}
        <ErrorNote error={pay.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!valid} loading={pay.isPending} onClick={() => pay.mutate()}>Record payout</Button></div>
      </div>
    </Modal>
  );
}

function ReverseModal({ voucher, onClose, onDone }: { voucher: Voucher; onClose: () => void; onDone: () => void }) {
  const { money } = useMe();
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const reverse = useMutation({ mutationFn: () => api.post(`/earnings/payouts/${voucher.id}/reverse`, { reason: reason.trim() }, key), onSuccess: onDone });
  return (
    <Modal title={`Reverse ${voucher.payoutNumber}?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">A mirror voucher is added and the {money(voucher.gross)} goes back to what {voucher.doctor} is owed. The original voucher stays on record. This cannot be undone.</p>
        <Field label="Reason (recorded)"><Input autoFocus value={reason} maxLength={240} onChange={(e) => setReason(e.target.value)} placeholder="At least 5 characters" /></Field>
        <ErrorNote error={reverse.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={reverse.isPending} onClick={() => reverse.mutate()}>Reverse voucher</Button></div>
      </div>
    </Modal>
  );
}

function StatementModal({ doctor, onClose }: { doctor: { id: string; name: string }; onClose: () => void }) {
  const { money, dateTime, me } = useMe();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: me.facility?.timezone ?? me.tenant.timezone });
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ["payout-statement", doctor.id, from, to], queryFn: () => api.get<Statement>(`/earnings/statement?practitionerId=${doctor.id}&from=${from}&to=${to}`), enabled: !!from && !!to && to >= from });
  const label: Record<string, string> = { EARNED: "Earned", EARNED_REDUCED: "Earned (money given back)", PAID: "Paid out", PAYOUT_REVERSED: "Payout reversed" };
  return (
    <Modal title={`Statement: ${doctor.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2"><Field label="From"><Input type="date" aria-label="Statement from" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" aria-label="Statement to" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : q.data && (
          <>
            <dl className="grid grid-cols-3 gap-3"><KV label="Owed at the start">{money(q.data.opening)}</KV><KV label="Earned">{money(q.data.earned)}</KV><KV label="Paid out">{money(q.data.paid)}</KV><KV label="Tax deducted">{money(q.data.tdsDeducted)}</KV><KV label="Received by the doctor">{money(q.data.netPaid)}</KV><KV label="Owed at the end"><b>{money(q.data.closing)}</b></KV></dl>
            <Table head={["When", "What", "Reference", "Share", "Tax", "Received"]} {...(q.data.entries.length === 0 ? { empty: "Nothing in these days." } : {})}>
              {q.data.entries.map((e, i) => <tr key={i}><Td>{dateTime(e.at)}</Td><Td><Badge tone={e.type === "PAID" ? "blue" : e.type === "PAYOUT_REVERSED" ? "amber" : "gray"}>{label[e.type] ?? e.type}</Badge></Td><Td>{e.reference}</Td><Td>{money(e.amount)}</Td><Td>{e.tds ? money(e.tds) : ""}</Td><Td>{e.net ? money(e.net) : ""}</Td></tr>)}
            </Table>
          </>
        )}
      </div>
    </Modal>
  );
}
