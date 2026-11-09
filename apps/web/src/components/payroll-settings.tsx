"use client";
import { useState } from "react";
import { Button, Field, Input, Notice } from "./ui";

interface Rates { pfWageCeiling: number; pfRate: number; esiGrossCeiling: number; esiEmployeeRate: number; esiEmployerRate: number; ptSlabs: { upTo: number; tax: number }[]; ptTop: number }
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FALLBACK: Rates = { pfWageCeiling: 15000, pfRate: 0.12, esiGrossCeiling: 21000, esiEmployeeRate: 0.0075, esiEmployerRate: 0.0325, ptSlabs: [{ upTo: 10000, tax: 0 }, { upTo: 15000, tax: 110 }, { upTo: 25000, tax: 130 }, { upTo: 40000, tax: 150 }], ptTop: 200 };
const pct = (v: number) => String(Number((v * 100).toFixed(4)));
const slabsText = (s: Rates["ptSlabs"]) => s.map((x) => `${x.upTo}:${x.tax}`).join(", ");

/** Payroll settings in Administration → Settings: the weekly off days and the statutory rates (to be confirmed by the hospital's accountant). */
export function PayrollSettings({ get, save, saving }: { get: (key: string) => { value: unknown } | undefined; save: (key: string, value: unknown) => void; saving: boolean }) {
  const offs = (get("PAYROLL_WEEKLY_OFF_DAYS")?.value as number[] | undefined) ?? [];
  const rates = (get("PAYROLL_STATUTORY_RATES")?.value as Rates | undefined) ?? FALLBACK;
  const [f, setF] = useState<{ pfRate: string; pfWageCeiling: string; esiEmployeeRate: string; esiEmployerRate: string; esiGrossCeiling: string; ptSlabs: string; ptTop: string } | null>(null);
  const form = f ?? { pfRate: pct(rates.pfRate), pfWageCeiling: String(rates.pfWageCeiling), esiEmployeeRate: pct(rates.esiEmployeeRate), esiEmployerRate: pct(rates.esiEmployerRate), esiGrossCeiling: String(rates.esiGrossCeiling), ptSlabs: slabsText(rates.ptSlabs), ptTop: String(rates.ptTop) };
  const slabs = form.ptSlabs.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [u = "", t = ""] = s.split(":"); return { upTo: Number(u), tax: Number(t) }; });
  const slabsOk = slabs.every((x, i) => Number.isFinite(x.upTo) && Number.isFinite(x.tax) && x.upTo >= 0 && x.tax >= 0 && (i === 0 || x.upTo > slabs[i - 1]!.upTo)) && slabs.length <= 10;
  const nums = [form.pfRate, form.pfWageCeiling, form.esiEmployeeRate, form.esiEmployerRate, form.esiGrossCeiling, form.ptTop].every((v) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...form, [k]: e.target.value });
  const submit = () => save("PAYROLL_STATUTORY_RATES", {
    pfWageCeiling: Number(form.pfWageCeiling), pfRate: Number((Number(form.pfRate) / 100).toFixed(6)), esiGrossCeiling: Number(form.esiGrossCeiling),
    esiEmployeeRate: Number((Number(form.esiEmployeeRate) / 100).toFixed(6)), esiEmployerRate: Number((Number(form.esiEmployerRate) / 100).toFixed(6)), ptSlabs: slabs, ptTop: Number(form.ptTop),
  });
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-sm font-medium">Weekly off days</p>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={offs.includes(i)} disabled={saving} onChange={(e) => save("PAYROLL_WEEKLY_OFF_DAYS", e.target.checked ? [...offs, i].sort() : offs.filter((x) => x !== i))} />{d}</label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">These days need no attendance and are not charged as loss of pay. Public holidays are added under Payroll → Leave.</p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Statutory rates</p>
        <Notice tone="warn">These are common Indian defaults and have not been checked against current law. The hospital's accountant must confirm every figure before the first real payroll.</Notice>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Field label="Provident fund rate (%)"><Input inputMode="decimal" value={form.pfRate} onChange={set("pfRate")} /></Field>
          <Field label="Provident fund wage ceiling"><Input inputMode="decimal" value={form.pfWageCeiling} onChange={set("pfWageCeiling")} /></Field>
          <div />
          <Field label="ESI: employee share (%)"><Input inputMode="decimal" value={form.esiEmployeeRate} onChange={set("esiEmployeeRate")} /></Field>
          <Field label="ESI: employer share (%)"><Input inputMode="decimal" value={form.esiEmployerRate} onChange={set("esiEmployerRate")} /></Field>
          <Field label="ESI applies up to a monthly gross of"><Input inputMode="decimal" value={form.esiGrossCeiling} onChange={set("esiGrossCeiling")} /></Field>
          <Field label="Professional tax slabs (up to amount : tax)" className="sm:col-span-2" hint="For example 10000:0, 15000:110. The amounts must rise."><Input value={form.ptSlabs} onChange={set("ptSlabs")} /></Field>
          <Field label="Professional tax above the last slab"><Input inputMode="decimal" value={form.ptTop} onChange={set("ptTop")} /></Field>
        </div>
        <div className="mt-2"><Button loading={saving} disabled={!nums || !slabsOk || f === null} onClick={submit}>Save rates</Button></div>
        <p className="mt-1 text-xs text-slate-500">A change applies to payslips calculated or edited afterwards; payslips of an approved run never change.</p>
      </div>
    </div>
  );
}
