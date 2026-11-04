"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gate } from "@/components/gate";
import { Button, Card, ErrorNote, Input, PageHeader, Select, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Event { id: string; action: string; entityType: string; entityId: string | null; actorUserId: string | null; actorName: string | null; actorUsername: string | null; requestId: string | null; createdAt: string; metadata: Record<string, unknown> }
interface Actor { id: string; fullName: string; username: string }

/** The UTC instant at which a calendar day (YYYY-MM-DD) starts in the given time zone. */
function dayStart(day: string, tz: string): Date {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return new Date(`${day}T00:00:00${m ? `${m[1]}:${m[2] ?? "00"}` : "Z"}`);
}
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export default function AuditPage() {
  const { dateTime, me } = useMe();
  const tz = me.facility?.timezone ?? me.tenant.timezone;
  const [action, setAction] = useState("");
  const [entityId, setEntityId] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const actors = useQuery({ queryKey: ["audit-actors"], queryFn: () => api.get<Actor[]>("/audit-events/actors") });
  const list = useQuery({
    queryKey: ["audit", action, entityId, actor, from, to, page],
    queryFn: () => api.page<Event>("/audit-events", {
      ...(action ? { action: action.toUpperCase() } : {}), ...(entityId ? { entityId } : {}), ...(actor ? { actorUserId: actor } : {}),
      // Whole days in the facility's time zone: from the start of "from" to the end of "to".
      ...(from ? { from: dayStart(from, tz).toISOString() } : {}), ...(to ? { to: new Date(dayStart(nextDay(to), tz).getTime() - 1).toISOString() } : {}),
      page, pageSize: 50,
    }),
  });
  const total = list.data?.meta.total ?? 0;
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  return (
    <Gate anyOf={["AUDIT_READ"]}>
      <PageHeader title="Audit trail" subtitle="Who did what, and when. Events cannot be edited or deleted." />
      <Card actions={<>
        <Select aria-label="User" className="w-48" value={actor} onChange={(e) => reset(setActor)(e.target.value)}>
          <option value="">All users</option>{actors.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}
        </Select>
        <Input placeholder="Action (e.g. PAYMENT_RECEIVED)" aria-label="Action" className="w-56" value={action} onChange={(e) => reset(setAction)(e.target.value)} />
        <Input type="date" aria-label="From date" className="w-36" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label="To date" className="w-36" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        <Input placeholder="Record id" aria-label="Record id" className="w-48" value={entityId} onChange={(e) => reset(setEntityId)(e.target.value)} />
      </>}>
        {list.isLoading ? <Spinner /> : <>
          <ErrorNote error={list.error} />
          <Table head={["When", "Action", "Record", "By", "Details"]} {...(list.data?.data.length === 0 ? { empty: "No events match." } : {})}>
            {list.data?.data.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{dateTime(e.createdAt)}</Td><Td><code className="text-xs">{e.action}</code></Td>
                <Td>{e.entityType}<div className="max-w-[12rem] truncate text-xs text-slate-500">{e.entityId}</div></Td>
                <Td>{e.actorUserId ? <>{e.actorName ?? "Unknown user"}<div className="text-xs text-slate-500">{e.actorUsername}</div></> : <span className="text-xs text-slate-500">system</span>}</Td>
                <Td><span className="text-xs text-slate-600">{Object.entries(e.metadata ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ")}</span></Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-500"><span>{total} events · newest first</span><span className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Next</Button></span></div>
        </>}
      </Card>
    </Gate>
  );
}
