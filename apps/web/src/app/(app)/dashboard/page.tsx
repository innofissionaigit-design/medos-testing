"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Badge, Card, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { localeFor, useI18n, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { visibleNav } from "@/lib/nav";

function Stat({ label, value, href }: { label: string; value: string | number | undefined; href?: string }) {
  const t = useT();
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-500">
      <div className="text-xs uppercase tracking-wide text-slate-500">{t(label)}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value ?? <span className="text-slate-300">…</span>}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

interface RegReport {
  totals: { registrations: number; paid: number; exempted: number; pending: number; collected: string; exemptedAmount: string; pendingAmount: string };
  byMethod: { method: string; amount: string }[]; stillDue: { count: number; amount: string };
  rows: { patientId: string; registeredAt: string; patient: string; mrn: string | null; fee: string; status: "PAID" | "EXEMPTED" | "PENDING"; paymentMethods: string | null; receiptNumber: string | null; registeredBy: string | null; exemptionReason: string | null }[];
}

export default function Dashboard() {
  const { me, can, features, money } = useMe();
  const { lang, t } = useI18n();
  const opd = useQuery({ queryKey: ["dash-opd"], queryFn: () => api.get<{ total: number }>("/reports/opd/daily"), enabled: can("REPORT_READ", "REPORT_OPD") });
  const col = useQuery({ queryKey: ["dash-col"], queryFn: () => api.get<{ totals: { net: string } }>("/reports/collections"), enabled: can("REPORT_READ", "REPORT_FINANCE") });
  const queue = useQuery({ queryKey: ["dash-queue"], queryFn: () => api.get<{ status: string }[]>("/queue"), enabled: can("QUEUE_READ"), refetchInterval: 20_000 });
  const adm = useQuery({ queryKey: ["dash-adm"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") && features.IPD_ENABLED });
  const outstanding = useQuery({ queryKey: ["dash-out"], queryFn: () => api.get<{ total: number; totalDue: string }>("/reports/outstanding-invoices", { pageSize: 1 }), enabled: can("REPORT_READ", "REPORT_FINANCE") });
  const low = useQuery({ queryKey: ["dash-low"], queryFn: () => api.get<{ rows: unknown[] }>("/reports/pharmacy/low-stock"), enabled: can("REPORT_READ", "REPORT_PHARMACY") && features.PHARMACY_ENABLED });
  // Registrations and their fees, live: refreshed every 15 seconds for the Cashier, Manager and Administrator.
  const reg = useQuery({ queryKey: ["dash-reg"], queryFn: () => api.get<RegReport>("/reports/registrations"), enabled: can("REPORT_READ", "REPORT_FINANCE"), refetchInterval: 15_000 });
  const nav = visibleNav(new Set(me.permissions), features, me.roles).filter((n) => n.href !== "/dashboard");
  const waiting = queue.data?.filter((q) => q.status === "WAITING" || q.status === "CALLED").length;

  return (
    <>
      <PageHeader title={`${t("Welcome,")} ${me.fullName}`} subtitle={`${me.facility?.name ?? ""} · ${new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "full", timeZone: me.facility?.timezone ?? me.tenant.timezone }).format(new Date())}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {can("QUEUE_READ") && <Stat label="Waiting in OPD" value={waiting} href="/queue" />}
        {can("REPORT_READ", "REPORT_OPD") && <Stat label="OPD visits today" value={opd.data?.total} href="/reports" />}
        {can("REPORT_READ", "REPORT_FINANCE") && <Stat label="Collected today" value={col.data ? money(col.data.totals.net) : undefined} href="/reports" />}
        {can("REPORT_READ", "REPORT_FINANCE") && <Stat label="Outstanding bills" value={outstanding.data ? `${outstanding.data.total} · ${money(outstanding.data.totalDue)}` : undefined} href="/billing" />}
        {can("ADMISSION_READ") && features.IPD_ENABLED && <Stat label="Admitted patients" value={adm.data?.meta.total} href="/ipd" />}
        {can("REPORT_READ", "REPORT_PHARMACY") && features.PHARMACY_ENABLED && <Stat label="Low-stock medicines" value={low.data?.rows.length} href="/pharmacy" />}
      </div>
      {can("REPORT_READ", "REPORT_FINANCE") && reg.data && (reg.data.rows.length > 0 || reg.data.stillDue.count > 0 || Number(reg.data.totals.collected) > 0) && (
        <Card title="Patient registrations today" className="mt-4" actions={<Link href="/reports" className="text-sm text-brand-700 hover:underline">Full report</Link>}>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Registered" value={reg.data.totals.registrations} />
            <Stat label="Fees collected" value={money(reg.data.totals.collected)} />
            <Stat label="Exempted" value={reg.data.totals.exempted} />
            <Stat label="Fee due" value={reg.data.stillDue.count} />
            <Stat label="By mode" value={reg.data.byMethod.map((m) => `${m.method.toLowerCase()} ${money(m.amount)}`).join(" · ") || "—"} />
          </div>
          <Table head={["Time", "Patient", "Patient ID", "Fee", "Status", "Paid by", "Receipt", "Registered by"]}>
            {reg.data.rows.slice(0, 8).map((r) => (
              <tr key={r.patientId}>
                <Td>{new Intl.DateTimeFormat(localeFor(lang), { timeStyle: "short", timeZone: me.facility?.timezone ?? me.tenant.timezone }).format(new Date(r.registeredAt))}</Td>
                <Td><Link href={`/patients/${r.patientId}`} className="text-brand-700 hover:underline">{r.patient}</Link></Td><Td>{r.mrn}</Td><Td>{money(r.fee)}</Td>
                <Td><Badge tone={r.status === "PAID" ? "green" : r.status === "PENDING" ? "amber" : "gray"}>{r.status === "PENDING" ? "due" : r.status.toLowerCase()}</Badge>{r.exemptionReason ? <span className="ml-1 text-xs text-slate-500">{r.exemptionReason}</span> : null}</Td>
                <Td>{r.paymentMethods ?? "—"}</Td><Td>{r.receiptNumber ?? "—"}</Td><Td>{r.registeredBy ?? ""}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Card title="Go to" className="mt-4">
        {nav.length === 0 ? <Spinner /> : <div className="flex flex-wrap gap-2">{nav.map((n) => <Link key={n.href} href={n.href} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-brand-50">{t(n.label)}</Link>)}</div>}
        <p className="mt-3 text-xs text-slate-500">{t("Tip: press")} <kbd className="rounded border px-1">/</kbd> {t("anywhere to search for a patient.")}</p>
      </Card>
    </>
  );
}
