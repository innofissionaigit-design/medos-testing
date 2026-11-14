"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { WalkIn } from "@/components/walk-in";
import { Button, Card, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { Desk } from "@/lib/desk";
import { useMe } from "@/lib/me";

/** The question every receptionist is asked after signing in: which desk are they working at? (lib/desk.ts) */
export function DeskChooser({ name, onChoose, onSignOut }: { name: string; onChoose: (d: Desk) => void; onSignOut: () => void }) {
  const card = "flex-1 rounded-xl border-2 border-slate-200 bg-white p-6 text-left shadow-sm hover:border-brand-500 focus:border-brand-500 focus:outline-none";
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {name}</h1>
        <p className="mt-1 text-slate-600">Which desk are you working at?</p>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <button type="button" className={card} onClick={() => onChoose("OPD")} autoFocus>
          <div className="text-xl font-semibold text-brand-700">OPD</div>
          <p className="mt-1 text-sm text-slate-600">Outpatient desk: start a new visit, appointments, the OPD queue and OPD bills.</p>
        </button>
        <button type="button" className={card} onClick={() => onChoose("IPD")}>
          <div className="text-xl font-semibold text-brand-700">IPD</div>
          <p className="mt-1 text-sm text-slate-600">Inpatient desk: admissions, the wards, going home and inpatient bills.</p>
        </button>
      </div>
      <div><button type="button" className="text-sm text-slate-500 underline" onClick={onSignOut}>Sign out</button></div>
    </main>
  );
}

function Stat({ label, value, href }: { label: string; value: string | number | undefined; href: string }) {
  return (
    <Link href={href}>
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-500">
        <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{value ?? <span className="text-slate-300">…</span>}</div>
      </div>
    </Link>
  );
}

const linkClass = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50";

/** The OPD desk's dashboard: the one thing reception does most, "Start new visit", and what is waiting. */
function OpdDashboard() {
  const { can } = useMe();
  const [starting, setStarting] = useState(false);
  const today = new Date().toLocaleDateString("en-CA");
  const queue = useQuery({ queryKey: ["dash-queue"], queryFn: () => api.get<{ status: string }[]>("/queue"), enabled: can("QUEUE_READ"), refetchInterval: 20_000 });
  const booked = useQuery({ queryKey: ["dash-appts-today", today], queryFn: () => api.page<unknown>("/appointments", { date: today, pageSize: 1 }), enabled: can("APPOINTMENT_READ") });
  const waiting = queue.data?.filter((q) => q.status === "WAITING" || q.status === "CALLED").length;
  const inConsultation = queue.data?.filter((q) => q.status === "IN_CONSULTATION").length;
  return (
    <>
      <PageHeader title="OPD reception" subtitle="Outpatient desk" actions={can("APPOINTMENT_CREATE") ? <Button onClick={() => setStarting(true)}>Start new visit</Button> : undefined} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {can("QUEUE_READ") && <Stat label="Waiting in OPD" value={waiting} href="/queue" />}
        {can("QUEUE_READ") && <Stat label="With the doctor now" value={inConsultation} href="/queue" />}
        {can("APPOINTMENT_READ") && <Stat label="Appointments today" value={booked.data?.meta.total} href="/appointments" />}
      </div>
      <Card title="Go to" className="mt-4">
        <div className="flex flex-wrap gap-2">
          {can("PATIENT_READ") && <Link className={linkClass} href="/patients">Patients</Link>}
          {can("APPOINTMENT_READ") && <Link className={linkClass} href="/appointments">Appointments</Link>}
          {can("QUEUE_READ") && <Link className={linkClass} href="/queue">OPD queue</Link>}
          {can("INVOICE_READ") && <Link className={linkClass} href="/billing">Billing</Link>}
        </div>
      </Card>
      {starting && <WalkIn title="Start new visit" onClose={() => setStarting(false)} />}
    </>
  );
}

/** The IPD desk's dashboard: admissions and the ward. There is no "Start new visit" here: outpatient visits belong to the OPD desk. */
function IpdDashboard() {
  const { can } = useMe();
  const admitted = useQuery({ queryKey: ["dash-adm"], queryFn: () => api.page<unknown>("/admissions", { status: "ADMITTED", pageSize: 1 }), enabled: can("ADMISSION_READ") });
  return (
    <>
      <PageHeader title="IPD reception" subtitle="Inpatient desk" actions={can("ADMISSION_READ") ? <Link className={linkClass} href="/ipd">Admissions</Link> : undefined} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {can("ADMISSION_READ") && <Stat label="Admitted patients" value={admitted.data?.meta.total} href="/ipd" />}
      </div>
      <Card title="Go to" className="mt-4">
        <div className="flex flex-wrap gap-2">
          {can("ADMISSION_READ") && <Link className={linkClass} href="/ipd">Admissions</Link>}
          {can("ADMISSION_READ") && <Link className={linkClass} href="/discharge-board">Going home</Link>}
          {can("PATIENT_READ") && <Link className={linkClass} href="/patients">Patients</Link>}
          {can("INVOICE_READ") && <Link className={linkClass} href="/billing">Billing</Link>}
        </div>
      </Card>
    </>
  );
}

export function ReceptionDashboard({ desk }: { desk: Desk }) {
  return desk === "OPD" ? <OpdDashboard /> : <IpdDashboard />;
}
