"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Select } from "@/components/ui";
import { api, ApiError, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { PrintLink } from "@/components/print-link";

export interface FeeConfig { enabled: boolean; amount: string; methods: string[]; exemptReasons: string[]; canCollect: boolean; canExempt: boolean }
export interface FeeLine { method: string; amount: string; reference: string }
export interface FeeChoice { kind: "PAY" | "EXEMPT"; lines: FeeLine[]; reason: string }
export interface RegistrationResult { status: "PAID" | "EXEMPTED" | "PENDING"; amount: string; invoiceId?: string; invoiceNumber?: string | null; receiptId?: string; receiptNumber?: string; methods?: string[]; exemptionReason?: string }

const label = (m: string) => m.replace("_", " ").toLowerCase();
const cents = (v: string) => Math.round(Number(v || 0) * 100);

export const initialChoice = (c: FeeConfig): FeeChoice => ({ kind: c.canCollect ? "PAY" : "EXEMPT", lines: [{ method: "CASH", amount: c.amount, reference: "" }], reason: c.exemptReasons[0] ?? "" });

/** Why the fee cannot be taken yet, in plain words, or null when it can. The server checks everything again. */
export function feeProblem(c: FeeConfig, ch: FeeChoice): string | null {
  if (ch.kind === "EXEMPT") return ch.reason ? null : "Choose the reason for exempting the fee.";
  const sum = ch.lines.reduce((n, l) => n + cents(l.amount), 0);
  if (sum !== cents(c.amount)) return `The payments add up to ₹${(sum / 100).toFixed(2)}; the fee is ₹${c.amount}.`;
  if (ch.lines.some((l) => l.method !== "CASH" && l.reference.trim().length < 4)) return "Enter the transaction reference for UPI and card payments.";
  return null;
}

export const feePayload = (ch: FeeChoice) => (ch.kind === "EXEMPT"
  ? { exemption: { reason: ch.reason } }
  : { payments: ch.lines.filter((l) => cents(l.amount) > 0).map((l) => ({ method: l.method, amount: l.amount, ...(l.method !== "CASH" ? { reference: l.reference.trim() } : {}) })) });

/** The fee at the desk: collect it (cash, UPI or card, split allowed) or, for someone allowed to, exempt it with a listed reason. */
export function FeeSection({ config, value, onChange }: { config: FeeConfig; value: FeeChoice; onChange: (v: FeeChoice) => void }) {
  const { money } = useMe();
  const set = (i: number, p: Partial<FeeLine>) => onChange({ ...value, lines: value.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const sum = value.lines.reduce((n, l) => n + cents(l.amount), 0);
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-slate-700">Registration fee: {money(config.amount)}</span>
        <div className="flex gap-3">
          {config.canCollect && <label className="flex items-center gap-1"><input type="radio" checked={value.kind === "PAY"} onChange={() => onChange({ ...value, kind: "PAY" })} /> Collect</label>}
          {config.canExempt && <label className="flex items-center gap-1"><input type="radio" checked={value.kind === "EXEMPT"} onChange={() => onChange({ ...value, kind: "EXEMPT" })} /> Exempt</label>}
        </div>
      </div>
      {value.kind === "PAY" ? (
        <>
          {value.lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Select aria-label="Payment mode" className="col-span-4" value={l.method} onChange={(e) => set(i, { method: e.target.value })}>{config.methods.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select>
              <Input aria-label="Amount" className="col-span-3" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
              <Input aria-label="Reference" className="col-span-4" placeholder={l.method === "CASH" ? "—" : "Transaction reference"} disabled={l.method === "CASH"} value={l.reference} onChange={(e) => set(i, { reference: e.target.value })} />
              {value.lines.length > 1 && <button type="button" className="col-span-1 text-slate-400 hover:text-red-700" aria-label="Remove payment line" onClick={() => onChange({ ...value, lines: value.lines.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>Received ₹{(sum / 100).toFixed(2)} of ₹{config.amount}</span>
            {value.lines.length < 3 && <button type="button" className="text-brand-700 hover:underline" onClick={() => onChange({ ...value, lines: [...value.lines, { method: "UPI", amount: "", reference: "" }] })}>Split payment</button>}
          </div>
        </>
      ) : (
        <Field label="Reason (recorded and reported)"><Select aria-label="Exemption reason" value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })}>{config.exemptReasons.map((r) => <option key={r}>{r}</option>)}</Select></Field>
      )}
    </div>
  );
}

/** What a finished registration looks like: the Patient ID and the receipt, with the way to print it. */
export function RegistrationDone({ mrn, reg }: { mrn: string | null; reg: RegistrationResult | null }) {
  const { money } = useMe();
  return (
    <div className="space-y-2 text-sm">
      <Notice tone="success">Registered. Patient ID <b>{mrn ?? "—"}</b>.</Notice>
      {reg?.status === "PAID" && <p>Registration fee {money(reg.amount)} received ({reg.methods?.map(label).join(" + ")}). Receipt <b>{reg.receiptNumber}</b>, bill {reg.invoiceNumber}.</p>}
      {reg?.status === "EXEMPTED" && <p>Registration fee exempted: {reg.exemptionReason}.</p>}
      {reg?.status === "PENDING" && <p>Registration fee {money(reg.amount)} is still to be collected.</p>}
      {reg?.receiptId && <PrintLink href={printUrl(`receipts/${reg.receiptId}`)} className="inline-block rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">Print receipt</PrintLink>}
    </div>
  );
}

interface FeeView { status: "NOT_APPLICABLE" | "PENDING" | "PAID" | "EXEMPTED"; amount?: string; exemptionReason?: string | null; invoiceId?: string | null; invoiceNumber?: string | null; receiptId?: string | null; receiptNumber?: string | null; methods?: { method: string; amount: string }[]; settledAt?: string | null }

/** On the patient's page: the registration fee state, and for a fee still pending, the way to collect or exempt it. Nothing is shown for patients with no fee. */
export function RegistrationFeeCard({ patientId, onChange }: { patientId: string; onChange?: () => void }) {
  const { can, money, dateTime } = useMe();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ["reg-fee", patientId], queryFn: () => api.get<FeeView>(`/patients/${patientId}/registration-fee`), refetchInterval: 20_000 });
  const cfg = useQuery({ queryKey: ["reg-fee-config"], queryFn: () => api.get<FeeConfig>("/patients/registration-fee/config"), enabled: can("PATIENT_CREATE") });
  const [choice, setChoice] = useState<FeeChoice | null>(null);
  const [key] = useState(newKey);
  const pay = useMutation({
    mutationFn: (ch: FeeChoice) => api.post(`/patients/${patientId}/registration-fee`, feePayload(ch), key),
    onSuccess: async () => { setChoice(null); await qc.invalidateQueries({ queryKey: ["reg-fee", patientId] }); onChange?.(); },
  });
  const openShift = useMutation({ mutationFn: () => api.post("/shifts/open", { openingCash: "0" }), onSuccess: () => { if (choice) pay.mutate(choice); } });
  const v = view.data;
  if (!v || v.status === "NOT_APPLICABLE") return null;
  const ch = choice ?? (cfg.data ? initialChoice(cfg.data) : null);
  return (
    <Card title="Registration fee" actions={<Badge tone={v.status === "PAID" ? "green" : v.status === "PENDING" ? "amber" : "gray"}>{v.status === "PAID" ? "paid" : v.status === "PENDING" ? "to be collected" : "exempted"}</Badge>}>
      {v.status === "PAID" && (
        <div className="space-y-1 text-sm">
          <p>{money(v.amount ?? "0")} received{v.settledAt ? ` on ${dateTime(v.settledAt)}` : ""} ({v.methods?.map((m) => `${label(m.method)} ${money(m.amount)}`).join(" + ")}).</p>
          <p className="text-slate-600">Receipt {v.receiptNumber} · bill {v.invoiceNumber}</p>
          {v.receiptId && <PrintLink href={printUrl(`receipts/${v.receiptId}`)} className="inline-block rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">Print receipt</PrintLink>}
        </div>
      )}
      {v.status === "EXEMPTED" && <p className="text-sm">Fee of {money(v.amount ?? "0")} exempted: {v.exemptionReason}.</p>}
      {v.status === "PENDING" && (
        <div className="space-y-2">
          <Notice tone="warn">The registration fee of {money(v.amount ?? "0")} has not been collected. The patient cannot be checked in or admitted until it is paid or exempted (an emergency is never held up).</Notice>
          {can("PATIENT_CREATE") && cfg.data && ch && (
            <>
              <FeeSection config={cfg.data} value={ch} onChange={setChoice} />
              <ErrorNote error={pay.error instanceof ApiError && pay.error.code === "SHIFT_NOT_OPEN" ? null : pay.error ?? openShift.error} />
              {pay.error instanceof ApiError && pay.error.code === "SHIFT_NOT_OPEN" && <div className="space-y-1"><Notice tone="warn">Open your cash shift before taking cash.</Notice>{can("CASHIER_SHIFT_MANAGE") && <Button variant="secondary" loading={openShift.isPending} onClick={() => openShift.mutate()}>Open my cash shift (₹0 opening) and retry</Button>}</div>}
              {feeProblem(cfg.data, ch) && <p className="text-xs text-slate-500">{feeProblem(cfg.data, ch)}</p>}
              <Button loading={pay.isPending} disabled={feeProblem(cfg.data, ch) !== null} onClick={() => pay.mutate(ch)}>{ch.kind === "PAY" ? `Collect ${money(v.amount ?? "0")}` : "Exempt the fee"}</Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/** Administration → Settings: turn the registration fee on, set the amount, and the reasons that allow an exemption. */
export function RegistrationFeeSettings({ get, save, saving }: { get: (k: string) => { value: unknown } | undefined; save: (key: string, value: unknown) => void; saving: boolean }) {
  const enabled = get("REGISTRATION_FEE_ENABLED")?.value === true;
  const [amount, setAmount] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string | null>(null);
  const amountShown = amount ?? String(get("REGISTRATION_FEE_AMOUNT")?.value ?? "0.00");
  const reasonsShown = reasons ?? ((get("REGISTRATION_FEE_EXEMPT_REASONS")?.value as string[] | undefined) ?? []).join("\n");
  const list = reasonsShown.split("\n").map((x) => x.trim()).filter(Boolean);
  const reasonsOk = list.length >= 1 && list.length <= 20 && list.every((r) => r.length >= 3 && r.length <= 60) && new Set(list.map((r) => r.toLowerCase())).size === list.length;
  const amountOk = /^\d{1,8}(\.\d{1,2})?$/.test(amountShown.trim());
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"><span>Collect a one-time registration fee from every new patient at Reception, before the Patient ID is issued</span><input type="checkbox" aria-label="Registration fee on" checked={enabled} onChange={(e) => save("REGISTRATION_FEE_ENABLED", e.target.checked)} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (amountOk) save("REGISTRATION_FEE_AMOUNT", amountShown.trim()); }}>
          <Field label="Registration fee (₹)" className="flex-1"><Input aria-label="Registration fee amount" inputMode="decimal" value={amountShown} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!amountOk || amount === null}>Save</Button>
        </form>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (reasonsOk) save("REGISTRATION_FEE_EXEMPT_REASONS", list); }}>
          <Field label="Reasons for exempting the fee (one per line)"><textarea aria-label="Exemption reasons" rows={5} className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" value={reasonsShown} onChange={(e) => setReasons(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={saving} disabled={!reasonsOk || reasons === null}>Save reasons</Button>
        </form>
      </div>
      <p className="text-xs text-slate-500">Cash, UPI and card are accepted. Patients who are already registered are never charged again. Only staff with the exemption permission can register without the fee; every exemption needs one of these reasons and is audited and reported. A new amount applies to patients registered from now on.</p>
    </div>
  );
}
