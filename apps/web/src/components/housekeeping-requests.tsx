"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Spinner, Table, Td } from "./ui";

interface Req {
  id: string; kind: string; priority: "ROUTINE" | "URGENT"; location: string; description: string | null; status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  requestedAt: string; requestedBy: string | null; startedAt: string | null; startedBy: string | null; doneAt: string | null; doneBy: string | null; doneNote: string | null;
  cancelReason: string | null; minutesToDone: number | null;
}
const KINDS: [string, string][] = [["CLEANING", "Cleaning"], ["MAINTENANCE", "Repair or maintenance"], ["WASTE", "Waste pick-up"], ["LINEN", "Linen"], ["OTHER", "Something else"]];
const TONE = { OPEN: "red", IN_PROGRESS: "amber", DONE: "green", CANCELLED: "gray" } as const;
const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;

/** Requests to housekeeping and maintenance for any area (docs/housekeeping.md). A request names a place and a job, never a patient. */
export function HousekeepingRequests() {
  const { can, dateTime } = useMe();
  const qc = useQueryClient();
  const manage = can("HOUSEKEEPING_MANAGE");
  const ask = can("HOUSEKEEPING_REQUEST");
  const list = useQuery({ queryKey: ["housekeeping-requests"], queryFn: () => api.get<Req[]>("/housekeeping/requests"), refetchInterval: 20_000 });
  const [form, setForm] = useState({ kind: "CLEANING", priority: "ROUTINE", location: "", description: "" });
  const done = () => { void qc.invalidateQueries({ queryKey: ["housekeeping-requests"] }); };
  const create = useMutation({ mutationFn: () => api.post("/housekeeping/requests", { kind: form.kind, priority: form.priority, location: form.location.trim(), ...(form.description.trim() ? { description: form.description.trim() } : {}) }, newKey()), onSuccess: () => { setForm({ ...form, location: "", description: "" }); done(); } });
  const start = useMutation({ mutationFn: (id: string) => api.post(`/housekeeping/requests/${id}/start`, {}), onSuccess: done });
  const finish = useMutation({ mutationFn: (id: string) => api.post(`/housekeeping/requests/${id}/done`, {}), onSuccess: done });
  const cancel = useMutation({ mutationFn: (a: { id: string; reason: string }) => api.post(`/housekeeping/requests/${a.id}/cancel`, { reason: a.reason }), onSuccess: done });
  const rows = list.data ?? [];
  const open = rows.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS");
  return (
    <Card title={`${manage ? "Cleaning and repair requests" : "My cleaning and repair requests"} (${open.length} open)`}>
      {ask && (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="What is needed"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Where"><Input className="w-56" placeholder="e.g. Ward A corridor" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option></Select></Field>
            <Field label="Details (optional)"><Input className="w-72" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Button disabled={form.location.trim().length < 2} loading={create.isPending} onClick={() => create.mutate()}>Send request</Button>
          </div>
          <p className="text-xs text-slate-500">Do not write a patient's name. Housekeeping sees places and jobs only.</p>
        </div>
      )}
      <ErrorNote error={create.error ?? start.error ?? finish.error ?? cancel.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["Job", "Where", "Asked", "Status", ""]} {...(rows.length === 0 ? { empty: "No requests." } : {})}>
          {rows.map((r) => (
            <tr key={r.id} data-testid="housekeeping-request">
              <Td><b>{kindLabel(r.kind)}</b> {r.priority === "URGENT" && <Badge tone="red">urgent</Badge>}{r.description && <div className="text-xs text-slate-500">{r.description}</div>}</Td>
              <Td>{r.location}</Td>
              <Td>{dateTime(r.requestedAt)}<div className="text-xs text-slate-500">{r.requestedBy}</div></Td>
              <Td><Badge tone={TONE[r.status]}>{r.status === "IN_PROGRESS" ? "in progress" : r.status.toLowerCase()}</Badge>
                {r.status === "DONE" && <div className="text-xs text-slate-500">{r.doneBy}{r.minutesToDone !== null ? ` · ${r.minutesToDone} min` : ""}{r.doneNote ? ` · ${r.doneNote}` : ""}</div>}
                {r.status === "IN_PROGRESS" && <div className="text-xs text-slate-500">{r.startedBy}</div>}
                {r.status === "CANCELLED" && <div className="text-xs text-slate-500">{r.cancelReason}</div>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {manage && r.status === "OPEN" && <Button variant="secondary" loading={start.isPending && start.variables === r.id} onClick={() => start.mutate(r.id)}>Start</Button>}
                  {manage && r.status === "IN_PROGRESS" && <Button loading={finish.isPending && finish.variables === r.id} onClick={() => finish.mutate(r.id)}>Done</Button>}
                  {(r.status === "OPEN" || r.status === "IN_PROGRESS") && (manage || ask) && <Button variant="secondary" onClick={() => { const why = window.prompt("Why is this request being cancelled? (at least 5 characters)"); if (why && why.trim().length >= 5) cancel.mutate({ id: r.id, reason: why.trim() }); }}>Cancel</Button>}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
