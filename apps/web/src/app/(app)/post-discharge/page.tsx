"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { RecordRetention } from "@/components/record-retention";
import { Badge, Card, PageHeader, Select, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { T, useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row { admissionId: string; admissionNumber: string; patient: string; mrn: string | null; dischargedAt: string; daysSinceDischarge: number | null; status: string; hisStatus: string; recordReady: boolean; recordComplete: boolean; recordFile: string | null; claim: { claimNumber: string; status: string; insurer: string; open: boolean } | null; receivables: { patient: string; insurer: string } }

/**
 * Post-discharge (docs/discharge-stages.md): discharged stays whose record, claim or money is still open, for the Medical Records Department,
 * the TPA desk and finance. Opening a row goes to the admission, where MRD signs the record off.
 */
export default function PostDischargePage() {
  const { money, dateTime, can } = useMe();
  const t = useT();
  const [show, setShow] = useState("OPEN");
  const q = useQuery({ queryKey: ["post-discharge", show], queryFn: () => api.get<{ items: Row[]; total: number; ageing: { bucket: string; patient: string; insurer: string; stays: number }[] }>("/post-discharge", { show }) });
  const rows = q.data?.items ?? [];
  return (
    <Gate anyOf={["MRD_RECORD_COMPLETE", "CLAIM_READ", "REPORT_FINANCE", "MRD_RETENTION"]} feature="IPD_ENABLED">
      <PageHeader title="Post-discharge" />
      {can("MRD_RETENTION") && <RecordRetention />}
      {q.data?.ageing && (
        <Card title="Money still owed, by days since discharge">
          <Table head={["Days since discharge", "Patients owe", "Insurers owe", "Stays"]}>
            {q.data.ageing.map((a) => (
              <tr key={a.bucket} data-testid="ageing-row"><Td>{a.bucket}</Td><Td>{a.patient === "0.00" ? "—" : money(a.patient)}</Td><Td>{a.insurer === "0.00" ? "—" : money(a.insurer)}</Td><Td>{a.stays}</Td></tr>
            ))}
          </Table>
        </Card>
      )}
      <Card title={`${t("Discharged stays")} (${q.data?.total ?? 0})`} actions={
        <Select aria-label="Show" className="w-56" value={show} onChange={(e) => setShow(e.target.value)}>
          <option value="OPEN">{t("Anything open")}</option><option value="RECORDS">{t("Records to complete")}</option><option value="CLAIMS">{t("Claims to follow")}</option><option value="RECEIVABLES">{t("Money still owed")}</option><option value="ALL">{t("All (last 90 days)")}</option>
        </Select>
      }>
        {q.isLoading ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-slate-500"><T>Nothing here.</T></p> : (
          <Table head={["Patient", "Discharged", "Records", "Record file", "Claim", "Patient owes", "Insurer owes", "Stage"]}>
            {rows.map((r) => (
              <tr key={r.admissionId} data-testid="post-discharge-row">
                <Td><Link className="text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patient}</Link><div className="text-xs text-slate-500">{r.mrn} · {r.admissionNumber}</div></Td>
                <Td>{dateTime(r.dischargedAt)}<div className="text-xs text-slate-500">{r.daysSinceDischarge ?? 0} <T>day(s) ago</T></div></Td>
                <Td>{r.recordComplete ? <Badge tone="green">complete</Badge> : r.recordReady ? <Badge tone="amber">ready to sign off</Badge> : <Badge tone="red">incomplete</Badge>}</Td>
                <Td><span className="text-xs">{r.recordFile ?? t("not received")}</span></Td>
                <Td>{r.claim ? <><span className="font-medium">{r.claim.claimNumber}</span> <Badge tone={r.claim.open ? "blue" : "gray"}>{r.claim.status.toLowerCase().replace(/_/g, " ")}</Badge><div className="text-xs text-slate-500">{r.claim.insurer}</div></> : <span className="text-slate-400"><T>none</T></span>}</Td>
                <Td>{r.receivables.patient === "0.00" ? <span className="text-slate-400">—</span> : money(r.receivables.patient)}</Td>
                <Td>{r.receivables.insurer === "0.00" ? <span className="text-slate-400">—</span> : money(r.receivables.insurer)}</Td>
                <Td><span className="text-xs"><T>{r.hisStatus}</T></span></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Gate>
  );
}
