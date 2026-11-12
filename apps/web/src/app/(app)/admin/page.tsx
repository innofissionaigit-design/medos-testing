"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookingFeeSettings } from "@/components/booking-fee-extras";
import { PayrollSettings } from "@/components/payroll-settings";
import { DataImport } from "@/components/data-import";
import { IntegrationsAdmin } from "@/components/integration-extras";
import { PrivacyRequests } from "@/components/privacy-extras";
import { FooterCard, NumberingCard, RolesCard, ScheduleEditor, StaffAccess } from "@/components/admin-extras";
import { EarningsAdmin } from "@/components/earnings-admin";
import { DoctorList, WardStructure } from "@/components/ward-editor";
import { DepartmentList, FacilityCard } from "@/components/facility-admin";
import { PriceList } from "@/components/price-list";
import { AbdmAdmin } from "@/components/abdm";
import { AiAdmin } from "@/components/ai";
import { PrescriptionUploadSettings } from "@/components/ocr-admin";
import { RegistrationFeeSettings } from "@/components/registration-fee";
import { Gate } from "@/components/gate";
import { EmailAdmin } from "@/components/email-admin";
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

type Tab = "users" | "prices" | "wards" | "doctors" | "settings" | "privacy" | "import" | "integrations" | "earnings" | "abdm" | "ai" | "email";

interface User { id: string; username: string; fullName: string; status: string; locked?: boolean; roles: { id: string; name: string }[]; departments?: { id: string; name: string }[] }
interface Role { id: string; name: string }

function Users() {
  const qc = useQueryClient();
  const { me } = useMe();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.page<User>("/users", { pageSize: 100 }) });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  const [f, setF] = useState({ username: "", fullName: "", password: "", roleId: "" });
  const [access, setAccess] = useState<User | null>(null);
  const [showTemp, setShowTemp] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post("/users", { username: f.username, fullName: f.fullName, password: f.password, roleIds: [f.roleId], facilityIds: me.facility ? [me.facility.id] : [] }),
    onSuccess: () => { setF({ username: "", fullName: "", password: "", roleId: "" }); void qc.invalidateQueries({ queryKey: ["users"] }); },
  });
  const unlock = useMutation({ mutationFn: (u: User) => api.post(`/users/${u.id}/unlock`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }) });
  const toggle = useMutation({ mutationFn: (u: User) => api.patch(`/users/${u.id}`, { status: u.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }) });
  return (
    <div className="space-y-4">
      <Card title="Add a staff member">
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Input placeholder="Username" aria-label="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <Input placeholder="Full name" aria-label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          <Input type={showTemp ? "text" : "password"} placeholder="Temporary password" aria-label="Password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <Select aria-label="Role" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}><option value="">Role…</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name.toLowerCase()}</option>)}</Select>
          <Button type="submit" loading={create.isPending} disabled={!f.username || !f.fullName || !f.password || !f.roleId}>Add</Button>
          <div className="col-span-2 sm:col-span-5"><ErrorNote error={create.error} /></div>
        </form>
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={showTemp} onChange={(e) => setShowTemp(e.target.checked)} /> Show the password while typing, so you can read it out correctly</label>
        <p className="mt-1 text-xs text-slate-500">The password needs at least 10 characters with upper case, lower case and a digit. The new person is given access to your current facility.</p>
      </Card>
      <Card title="Staff">
        {users.isLoading ? <Spinner /> : (
          <Table head={["Name", "Username", "Roles", "Sees", "Status", ""]}>
            {users.data?.data.map((u) => (
              <tr key={u.id}><Td>{u.fullName}</Td><Td>{u.username}</Td><Td>{u.roles.map((r) => <Badge key={r.id}>{r.name.toLowerCase()}</Badge>)}</Td><Td>{u.departments && u.departments.length > 0 ? u.departments.map((d) => d.name).join(", ") : <span className="text-slate-500">all their role allows</span>}</Td><Td><StatusBadge value={u.status} />{u.locked && <> <Badge tone="amber">locked</Badge></>}</Td>
                <Td>{u.locked && <Button variant="ghost" loading={unlock.isPending} onClick={() => unlock.mutate(u)}>Unlock</Button>}<Button variant="ghost" onClick={() => setAccess(u)}>Access…</Button>{u.id !== me.id && <Button variant="ghost" onClick={() => toggle.mutate(u)}>{u.status === "ACTIVE" ? "Deactivate" : "Activate"}</Button>}</Td></tr>
            ))}
          </Table>
        )}
        <ErrorNote error={toggle.error} />
      </Card>
      <RolesCard />
      {access && <StaffAccess user={access} onClose={() => setAccess(null)} />}
    </div>
  );
}

function Wards() {
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<{ wards: { id: string; name: string; rooms: { id: string; name: string; beds: { id: string; code: string; status: string; dailyRate: string }[] }[] }[] }>("/beds/board") });
  const [ward, setWard] = useState({ name: "", code: "" });
  const [room, setRoom] = useState({ wardId: "", name: "", code: "" });
  const [bed, setBed] = useState({ roomId: "", code: "", dailyRate: "" });
  const refresh = () => Promise.all(["board", "wards-admin", "rooms-admin", "beds-admin"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const addWard = useMutation({ mutationFn: () => api.post("/wards", ward), onSuccess: () => { setWard({ name: "", code: "" }); void refresh(); } });
  const addRoom = useMutation({ mutationFn: () => api.post("/rooms", room), onSuccess: () => { setRoom({ ...room, name: "", code: "" }); void refresh(); } });
  const addBed = useMutation({ mutationFn: () => api.post("/beds", bed), onSuccess: () => { setBed({ ...bed, code: "" }); void refresh(); } });
  const rooms = board.data?.wards.flatMap((w) => w.rooms.map((r) => ({ id: r.id, label: `${w.name} · ${r.name}` }))) ?? [];
  return (
    <div className="space-y-4">
      <Card title="Add ward, room or bed">
        <div className="space-y-3">
          <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); addWard.mutate(); }}><Input placeholder="Ward name" aria-label="Ward name" value={ward.name} onChange={(e) => setWard({ ...ward, name: e.target.value })} /><Input placeholder="Code" aria-label="Ward code" value={ward.code} onChange={(e) => setWard({ ...ward, code: e.target.value })} /><Button type="submit" loading={addWard.isPending} disabled={!ward.name || !ward.code}>Add ward</Button><ErrorNote error={addWard.error} /></form>
          <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); addRoom.mutate(); }}><Select aria-label="Ward" value={room.wardId} onChange={(e) => setRoom({ ...room, wardId: e.target.value })}><option value="">Ward…</option>{board.data?.wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select><Input placeholder="Room name" aria-label="Room name" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} /><Input placeholder="Code" aria-label="Room code" value={room.code} onChange={(e) => setRoom({ ...room, code: e.target.value })} /><Button type="submit" loading={addRoom.isPending} disabled={!room.wardId || !room.name || !room.code}>Add room</Button><div className="col-span-4"><ErrorNote error={addRoom.error} /></div></form>
          <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); addBed.mutate(); }}><Select aria-label="Room" value={bed.roomId} onChange={(e) => setBed({ ...bed, roomId: e.target.value })}><option value="">Room…</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select><Input placeholder="Bed code" aria-label="Bed code" value={bed.code} onChange={(e) => setBed({ ...bed, code: e.target.value })} /><Input placeholder="Daily rate" aria-label="Daily rate" inputMode="decimal" value={bed.dailyRate} onChange={(e) => setBed({ ...bed, dailyRate: e.target.value })} /><Button type="submit" loading={addBed.isPending} disabled={!bed.roomId || !bed.code || !bed.dailyRate}>Add bed</Button><div className="col-span-4"><ErrorNote error={addBed.error} /></div></form>
        </div>
      </Card>
      <WardStructure />
    </div>
  );
}

function Doctors() {
  const qc = useQueryClient();
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ id: string; name: string }[]>("/departments") });
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<{ id: string; displayName: string; specialty: string | null; departmentName?: string | null }[]>("/practitioners") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.page<User>("/users", { pageSize: 100 }) });
  const [d, setD] = useState({ name: "", code: "" });
  const [p, setP] = useState({ userId: "", departmentId: "", displayName: "", specialty: "" });
  const addDept = useMutation({ mutationFn: () => api.post("/departments", d), onSuccess: () => { setD({ name: "", code: "" }); void qc.invalidateQueries({ queryKey: ["departments"] }); void qc.invalidateQueries({ queryKey: ["departments-admin"] }); } });
  const addDoc = useMutation({
    mutationFn: () => api.post("/practitioners", { userId: p.userId, departmentId: p.departmentId, displayName: p.displayName, ...(p.specialty ? { specialty: p.specialty } : {}) }),
    onSuccess: () => { setP({ userId: "", departmentId: "", displayName: "", specialty: "" }); void qc.invalidateQueries({ queryKey: ["practitioners"] }); void qc.invalidateQueries({ queryKey: ["practitioners-admin"] }); },
  });
  return (
    <div className="space-y-4">
      <Card title="Departments">
        <p className="mb-2 text-sm">{depts.data?.map((x) => x.name).join(" · ") || "None yet."}</p>
        <form className="grid grid-cols-4 gap-2" onSubmit={(e) => { e.preventDefault(); addDept.mutate(); }}><Input placeholder="Name" aria-label="Department name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /><Input placeholder="Code" aria-label="Department code" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} /><Button type="submit" loading={addDept.isPending} disabled={!d.name || !d.code}>Add department</Button><ErrorNote error={addDept.error} /></form>
      </Card>
      <Card title="Doctors">
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); addDoc.mutate(); }}>
          <Select aria-label="Staff login" value={p.userId} onChange={(e) => { const u = users.data?.data.find((x) => x.id === e.target.value); setP({ ...p, userId: e.target.value, displayName: p.displayName || (u ? `Dr. ${u.fullName.replace(/^Dr\.?\s*/i, "")}` : "") }); }}><option value="">Doctor’s login…</option>{users.data?.data.filter((u) => u.roles.some((r) => r.name === "DOCTOR")).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
          <Input placeholder="Name shown on prescriptions" aria-label="Display name" value={p.displayName} onChange={(e) => setP({ ...p, displayName: e.target.value })} />
          <Select aria-label="Department" value={p.departmentId} onChange={(e) => setP({ ...p, departmentId: e.target.value })}><option value="">Department…</option>{depts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          <Input placeholder="Specialty" aria-label="Specialty" value={p.specialty} onChange={(e) => setP({ ...p, specialty: e.target.value })} />
          <Button type="submit" loading={addDoc.isPending} disabled={!p.userId || !p.departmentId || !p.displayName}>Add doctor</Button>
          <div className="col-span-2 sm:col-span-5"><ErrorNote error={addDoc.error} /></div>
        </form>
      </Card>
      <DepartmentList />
      <DoctorList departments={depts.data ?? []} />
      <ScheduleEditor doctors={docs.data ?? []} />
    </div>
  );
}

interface Setting { key: string; description: string; value: unknown; isDefault: boolean }
function Settings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Setting[]>("/settings") });
  const put = useMutation({ mutationFn: ({ key, value }: { key: string; value: unknown }) => api.put(`/settings/${key}`, { value }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["settings"] }); await qc.invalidateQueries({ queryKey: ["features"] }); } });
  const [hdr, setHdr] = useState<Record<string, string> | null>(null);
  const [hoursText, setHoursText] = useState<string | null>(null);
  if (list.isLoading) return <Spinner />;
  const get = (k: string) => list.data?.find((s) => s.key === k);
  const current = (get("PRINT_HEADER")?.value as Record<string, string> | null) ?? null;
  const form = hdr ?? current ?? { hospitalName: "" };
  const flag = (k: string, label: string) => (
    <label key={k} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"><span>{label}</span><input type="checkbox" checked={get(k)?.value === true} onChange={(e) => put.mutate({ key: k, value: e.target.checked })} /></label>
  );
  // Reminder times are stored in minutes; staff think in hours ("24, 2" = a day before and two hours before).
  const hoursShown = hoursText ?? ((get("FOLLOWUP_REMINDER_OFFSETS_MINUTES")?.value as number[] | undefined) ?? [1440]).map((m) => String(m / 60)).join(", ");
  const minutes = hoursShown.split(",").map((s) => s.trim()).filter(Boolean).map((s) => Math.round(Number(s) * 60));
  const minutesOk = minutes.length >= 1 && minutes.length <= 5 && minutes.every((m) => Number.isInteger(m) && m >= 15 && m <= 10_080) && new Set(minutes).size === minutes.length;
  return (
    <div className="space-y-4">
      <FacilityCard />
      <Card title="Modules"><div className="grid gap-2 sm:grid-cols-3">{flag("PHARMACY_ENABLED", "Pharmacy")}{flag("IPD_ENABLED", "Admissions and beds")}{flag("NURSING_ENABLED", "Nursing")}</div></Card>
      <Card title="Discharge rules"><div className="grid gap-2 sm:grid-cols-2">{flag("DISCHARGE_REQUIRE_SUMMARY", "Require a signed discharge summary")}{flag("DISCHARGE_REQUIRE_VERIFIED_SUMMARY", "Also require a second doctor to verify it")}
        <div className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm"><span>Bed status after discharge</span><select aria-label="Bed after discharge" value={String(get("BED_AFTER_DISCHARGE")?.value ?? "CLEANING")} onChange={(e) => put.mutate({ key: "BED_AFTER_DISCHARGE", value: e.target.value })} className="rounded border border-slate-300 px-2 py-1"><option value="CLEANING">Needs cleaning</option><option value="AVAILABLE">Available</option></select></div></div></Card>
      <Card title="Follow-up reminders (SMS)">
        <div className="grid gap-2 sm:grid-cols-2">
          {flag("FOLLOWUP_REMINDERS_ENABLED", "Send reminders for follow-up appointments")}
          {flag("REMINDERS_REQUIRE_CONSENT", "Only remind patients who have agreed (otherwise remind unless the patient has withdrawn)")}
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (minutesOk) put.mutate({ key: "FOLLOWUP_REMINDER_OFFSETS_MINUTES", value: minutes }, { onSuccess: () => setHoursText(null) }); }}>
            <Field label="Hours before the appointment (comma-separated)" className="flex-1"><Input aria-label="Reminder hours" value={hoursShown} onChange={(e) => setHoursText(e.target.value)} /></Field>
            <Button type="submit" variant="secondary" loading={put.isPending} disabled={!minutesOk || hoursText === null}>Save</Button>
          </form>
        </div>
        <p className="mt-2 text-xs text-slate-500">Up to 5 reminders, each between 15 minutes (0.25) and 7 days (168) before. Changes apply to follow-ups booked or rescheduled from now on.</p>
      </Card>
      <PrescriptionUploadSettings flag={flag} />
      <Card title="Cash shifts"><div className="grid gap-2">{flag("CASH_AUTO_OPEN_SHIFT", "Open a cash shift automatically when cash is taken and the person has none open")}</div><p className="mt-2 text-xs text-slate-500">The shift starts with no opening cash and is closed and counted as usual at the end of the day. Turn this off to make staff open their shift first.</p></Card>
      <Card title="OPD visit payment"><div className="grid gap-2 sm:grid-cols-1">{flag("OPD_FEE_BEFORE_VISIT", "An OPD visit can start only after the OPD consultation bill is paid at Reception")}</div><p className="mt-2 text-xs text-slate-500">Reception creates the bill with the OPD consultation, takes the payment, then starts the visit. Follow-up visits, appointments that carry a booking fee and emergencies are not held up. One paid bill starts one visit.</p></Card>
      <Card title="Patient registration fee"><RegistrationFeeSettings get={get} save={(key, value) => put.mutate({ key, value })} saving={put.isPending} /></Card>
      <Card title="Appointment booking fee"><BookingFeeSettings get={get} save={(key, value) => put.mutate({ key, value })} saving={put.isPending} /></Card>
      <Card title="Invoices (GST split and rounding)"><div className="grid gap-2">{flag("INVOICE_TAX_SPLIT", "Show each invoice's tax as equal CGST and SGST halves")}{flag("INVOICE_ROUND_OFF", "Round each invoice total to the nearest whole rupee and show the round-off")}</div><p className="mt-2 text-xs text-slate-500">These apply to invoices created from now on; every invoice keeps the rule it was created with. Whether GST applies to your services, and whether to round bills, is for your accountant to decide.</p></Card>
      <Card title="Payroll"><PayrollSettings get={get} save={(key, value) => put.mutate({ key, value })} saving={put.isPending} /></Card>
      <Card title="Print header (shown on bills, receipts and prescriptions)">
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const v = Object.fromEntries(Object.entries(form).filter(([, x]) => x && String(x).trim())); put.mutate({ key: "PRINT_HEADER", value: v }); }}>
          {([["hospitalName", "Hospital name"], ["tagline", "Tagline"], ["address", "Address"], ["phone", "Phone"], ["email", "Email"], ["gstin", "GSTIN"]] as const).map(([k, label]) => <Field key={k} label={label}><Input value={form[k] ?? ""} onChange={(e) => setHdr({ ...form, [k]: e.target.value })} /></Field>)}
          <div className="sm:col-span-2"><Button type="submit" loading={put.isPending} disabled={!form["hospitalName"]}>Save header</Button></div>
        </form>
      </Card>
      <FooterCard value={(get("PRINT_FOOTER")?.value as Record<string, string> | null) ?? null} saving={put.isPending} onSave={(v) => put.mutate({ key: "PRINT_FOOTER", value: v })} />
      <ErrorNote error={put.error} />
      <NumberingCard />
    </div>
  );
}

export default function AdminPage() {
  const { can } = useMe();
  const tabs: { id: Tab; label: string; perm: string }[] = [
    { id: "users", label: "Staff", perm: "ADMIN_USERS" }, { id: "prices", label: "Price list", perm: "ADMIN_MASTERS" }, { id: "wards", label: "Wards and beds", perm: "ADMIN_MASTERS" },
    { id: "doctors", label: "Doctors and departments", perm: "ADMIN_MASTERS" }, { id: "settings", label: "Settings", perm: "ADMIN_SETTINGS" },
    { id: "privacy", label: "Privacy", perm: "PRIVACY_MANAGE" }, { id: "import", label: "Data import", perm: "DATA_IMPORT" }, { id: "integrations", label: "Integrations", perm: "ADMIN_INTEGRATIONS" },
    { id: "earnings", label: "Earnings split", perm: "EARNINGS_CONFIGURE" }, { id: "abdm", label: "ABDM", perm: "ADMIN_SETTINGS" }, { id: "ai", label: "AI assistant", perm: "AI_CONFIGURE" }, { id: "email", label: "Email", perm: "EMAIL_MANAGE" },
  ];
  const allowed = tabs.filter((t) => can(t.perm));
  const [tab, setTab] = useState<Tab>(allowed[0]?.id ?? "users");
  return (
    <Gate anyOf={["ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS", "PRIVACY_MANAGE", "DATA_IMPORT", "ADMIN_INTEGRATIONS", "EARNINGS_CONFIGURE", "AI_CONFIGURE", "EMAIL_MANAGE"]}>
      <PageHeader title="Administration" />
      <Tabs tabs={allowed} value={tab} onChange={setTab} />
      {tab === "users" && <Users />}{tab === "prices" && <PriceList />}{tab === "wards" && <Wards />}{tab === "doctors" && <Doctors />}{tab === "settings" && <Settings />}{tab === "privacy" && <PrivacyRequests />}{tab === "import" && <DataImport />}{tab === "integrations" && <IntegrationsAdmin />}{tab === "earnings" && <EarningsAdmin />}{tab === "abdm" && <AbdmAdmin />}{tab === "ai" && <AiAdmin />}{tab === "email" && <EmailAdmin />}
    </Gate>
  );
}
