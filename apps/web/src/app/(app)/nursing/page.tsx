"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Badge, Card, PageHeader, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Row {
  admissionId: string; admissionNumber: string; patientName: string; mrn: string | null; gender: string; bed: string | null; ward: string | null; doctor: string;
  admittedAt: string; hasAllergies: boolean; pendingTasks: number; overdueTasks: number; tasks: { id: string; title: string; dueAt: string }[]; medicationDue: number; medicationOverdue: number; nextMedicationAt: string | null; vitalsDue: boolean;
}

export default function NursingPage() {
  const { dateTime } = useMe();
  const list = useQuery({ queryKey: ["worklist"], queryFn: () => api.get<Row[]>("/nursing/worklist"), refetchInterval: 30_000 });
  return (
    <Gate anyOf={["NURSING_READ"]} feature="NURSING_ENABLED">
      <PageHeader title="Ward worklist" subtitle={list.data ? `${list.data.length} admitted patient${list.data.length === 1 ? "" : "s"} · medication and tasks due` : "Admitted patients with medication and tasks due"} />
      <Card>
        {list.isLoading ? <Spinner /> : (
          <Table head={["Bed", "Patient", "Doctor", "Medication", "Tasks", "Alerts"]} {...(list.data?.length === 0 ? { empty: "No admitted patients." } : {})}>
            {list.data?.map((r) => (
              <tr key={r.admissionId} className="hover:bg-slate-50">
                <Td><b>{r.bed ?? "—"}</b><div className="text-xs text-slate-500">{r.ward}</div></Td>
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/ipd/${r.admissionId}`}>{r.patientName}</Link><div className="text-xs text-slate-500">{r.mrn} · {r.admissionNumber}</div></Td>
                <Td>{r.doctor}</Td>
                <Td>{r.medicationOverdue > 0 ? <Badge tone="red">{r.medicationOverdue} overdue</Badge> : r.medicationDue > 0 ? <Badge tone="amber">{r.medicationDue} due</Badge> : <span className="text-slate-500">none due</span>}</Td>
                <Td>{r.pendingTasks > 0 ? <span className="text-sm">{r.tasks.slice(0, 2).map((t) => `${t.title} (${dateTime(t.dueAt).split(", ").pop()})`).join("; ")}{r.overdueTasks > 0 ? <> <Badge tone="red">{r.overdueTasks} overdue</Badge></> : null}</span> : <span className="text-slate-500">—</span>}</Td>
                <Td>{r.hasAllergies ? <Badge tone="red">allergy on record</Badge> : null} {r.vitalsDue ? <Badge tone="amber">vitals due</Badge> : null}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Gate>
  );
}
