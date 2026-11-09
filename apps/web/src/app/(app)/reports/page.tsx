"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { todayIn } from "@/components/pickers";
import { Button, Card, ErrorNote, Input, KV, PageHeader, Select, Spinner, Table, Td } from "@/components/ui";
import { reportToCsv } from "@/lib/csv";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { REPORT_PERMISSIONS } from "@/lib/nav";

/** `perm` is the report's area: shown to holders of that permission or of REPORT_READ (the API applies the same rule). */
interface ReportDef { id: string; label: string; path: string; ranged: boolean; perm: "REPORT_OPD" | "REPORT_FINANCE" | "REPORT_IPD" | "REPORT_PHARMACY" | "REPORT_MY_PRACTICE"; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED"; extra?: Record<string, string> }
const REPORTS: ReportDef[] = [
  { id: "bookings-earnings", label: "Bookings and earnings by doctor", path: "bookings/by-doctor", ranged: true, perm: "REPORT_FINANCE" },
  { id: "my-bookings", label: "My bookings and earnings", path: "bookings/my", ranged: true, perm: "REPORT_MY_PRACTICE" },
  { id: "my-payouts", label: "My payout statement", path: "earnings/my-statement", ranged: true, perm: "REPORT_MY_PRACTICE" },
  { id: "opd-daily", label: "OPD visits per day", path: "opd/daily", ranged: true, perm: "REPORT_OPD" },
  { id: "opd-doctor", label: "OPD visits by doctor", path: "opd/by-doctor", ranged: true, perm: "REPORT_OPD" },
  { id: "opd-dept", label: "OPD visits by department", path: "opd/by-department", ranged: true, perm: "REPORT_OPD" },
  { id: "collections", label: "Collections and payment modes", path: "collections", ranged: true, perm: "REPORT_FINANCE" },
  { id: "registrations", label: "Patient registrations and fees", path: "registrations", ranged: true, perm: "REPORT_FINANCE" },
  { id: "fee-skips", label: "Booking fees skipped", path: "booking-fee-skips", ranged: true, perm: "REPORT_FINANCE" },
  { id: "shifts", label: "Cashier shifts", path: "cashier-shifts", ranged: true, perm: "REPORT_FINANCE" },
  { id: "outstanding", label: "Outstanding bills", path: "outstanding-invoices", ranged: false, perm: "REPORT_FINANCE" },
  { id: "cur-adm", label: "Current admissions", path: "ipd/current-admissions", ranged: false, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "adm-dis", label: "Admissions and discharges", path: "ipd/admissions-discharges", ranged: true, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "occupancy", label: "Bed occupancy", path: "ipd/bed-occupancy", ranged: false, perm: "REPORT_IPD", feature: "IPD_ENABLED" },
  { id: "sales", label: "Pharmacy sales", path: "pharmacy/sales", ranged: true, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "movement", label: "Stock movement", path: "pharmacy/stock-movement", ranged: true, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "stock", label: "Current pharmacy stock", path: "pharmacy/stock", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "low", label: "Low stock", path: "pharmacy/low-stock", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
  { id: "expiry", label: "Near-expiry stock", path: "pharmacy/near-expiry", ranged: false, perm: "REPORT_PHARMACY", feature: "PHARMACY_ENABLED" },
];

const humanize = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const isPrim = (v: unknown): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v);
const cell = (v: unknown): string => (v === null || v === undefined ? "—" : v instanceof Object ? "" : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(String(v)).toLocaleString("en-IN") : String(v));

/** Generic renderer: scalar fields become a summary, arrays of objects become tables. Reports are read-only views of server-computed data. */
function Render({ data }: { data: Record<string, unknown> }) {
  const scalars = Object.entries(data).filter(([, v]) => isPrim(v));
  const objects = Object.entries(data).filter(([, v]) => v && !Array.isArray(v) && typeof v === "object") as [string, Record<string, unknown>][];
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object") as [string, Record<string, unknown>[]][];
  const emptyArrays = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length === 0);
  return (
    <div className="space-y-4">
      {(scalars.length > 0 || objects.length > 0) && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {scalars.map(([k, v]) => <KV key={k} label={humanize(k)}>{cell(v)}</KV>)}
          {objects.flatMap(([g, o]) => Object.entries(o).filter(([, v]) => isPrim(v)).map(([k, v]) => <KV key={`${g}.${k}`} label={`${humanize(g)} · ${humanize(k)}`}>{cell(v)}</KV>))}
        </dl>
      )}
      {arrays.map(([name, rows]) => {
        const cols = Object.keys(rows[0] ?? {}).filter((c) => isPrim(rows[0]?.[c]) && !/(^id$|Id$)/.test(c));
        return (
          <div key={name}>
            <h2 className="mb-1 text-sm font-semibold text-slate-700">{humanize(name)}</h2>
            <Table head={cols.map(humanize)}>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <Td key={c}>{cell(r[c])}</Td>)}</tr>)}</Table>
          </div>
        );
      })}
      {arrays.length === 0 && emptyArrays.length > 0 && <p className="text-sm text-slate-500">No data for this selection.</p>}
    </div>
  );
}

function saveFile(title: string, base: string, data: Record<string, unknown>) {
  // The byte-order mark makes Excel read the file as UTF-8, so ₹ and Bengali/Hindi names are not garbled.
  const blob = new Blob(["\uFEFF", reportToCsv(title, data)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${base}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Number of table rows in a report, for the audit entry (the rows themselves are not sent). */
const rowCount = (data: Record<string, unknown>): number => Object.values(data).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);

export default function ReportsPage() {
  const { me, features, can } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const available = REPORTS.filter((r) => (!r.feature || features[r.feature]) && (r.perm === "REPORT_MY_PRACTICE" ? can("REPORT_MY_PRACTICE") : can("REPORT_READ", r.perm)));
  const [id, setId] = useState(available[0]?.id ?? "opd-daily");
  const [from, setFrom] = useState(todayIn(tz));
  const [to, setTo] = useState(todayIn(tz));
  const [days, setDays] = useState("90");
  const def = available.find((r) => r.id === id) ?? available[0];
  // The export is written to the audit trail first; if that fails the file is not saved, so no export goes unrecorded.
  const exportCsv = useMutation({
    mutationFn: async (d: { def: ReportDef; data: Record<string, unknown> }) => {
      await api.post("/reports/export-log", { report: d.def.id, ...(d.def.ranged ? { from, to } : {}), rows: rowCount(d.data) });
      saveFile(d.def.label, d.def.ranged ? `${d.def.id}_${from}_${to}` : d.def.id, d.data);
    },
  });
  const q = useQuery({
    queryKey: ["report", def?.id, from, to, days],
    queryFn: () => api.get<Record<string, unknown>>(`/reports/${def!.path}`, def!.ranged ? { from, to } : def!.id === "expiry" ? { withinDays: days } : undefined),
    enabled: !!def,
  });
  return (
    <Gate anyOf={REPORT_PERMISSIONS}>
      <PageHeader title="Reports" subtitle="Operational reports for your facility" />
      {!def ? <Card><p className="text-sm text-slate-500">No reports are available for your role at this facility.</p></Card> : (
        <Card actions={<>
          <Select aria-label="Report" className="w-64" value={def.id} onChange={(e) => setId(e.target.value)}>{available.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select>
          {def.ranged && <><Input type="date" aria-label="From" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" aria-label="To" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></>}
          {def.id === "expiry" && <Input aria-label="Days" className="w-24" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}
          <Button variant="secondary" disabled={!q.data} loading={exportCsv.isPending} onClick={() => exportCsv.mutate({ def, data: q.data! })}>Download CSV</Button>
        </>}>
          {exportCsv.error ? <ErrorNote error={exportCsv.error} /> : null}
          {q.isLoading ? <Spinner /> : q.error ? <ErrorNote error={q.error} /> : q.data ? <Render data={q.data} /> : null}
        </Card>
      )}
    </Gate>
  );
}
