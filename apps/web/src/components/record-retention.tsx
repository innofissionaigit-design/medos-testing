"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Spinner, Table, Td } from "./ui";

interface Item { encounterId: string; encounterNumber: string; type: "OPD" | "IPD"; patient: string; mrn: string | null; endedAt: string; retentionEnds: string; state: "DUE" | "HELD" | "CLEARED" | "WITHIN"; review: { decision: string; retainUntil: string | null; note: string | null; at: string; by: string | null } | null }
interface Data { policy: { opdYears: number; ipdYears: number; minorsUntilAdult: boolean }; counts: { due: number; held: number; cleared: number }; hasMore: boolean; items: Item[] }
const TONE = { DUE: "red", HELD: "amber", CLEARED: "green", WITHIN: "gray" } as const;

/**
 * Medical-record retention (docs/record-retention.md): finished visits whose retention period is over. The Medical Records Department holds a record longer or clears it
 * for archiving; MedOS never deletes a record, it keeps these decisions.
 */
export function RecordRetention() {
  const { dateTime } = useMe();
  const qc = useQueryClient();
  const [show, setShow] = useState("DUE");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ decision: "HOLD", note: "", until: "" });
  const list = useQuery({ queryKey: ["record-retention", show, q], queryFn: () => api.get<Data>("/records/retention", { show, ...(q.trim().length >= 2 ? { q: q.trim() } : {}) }) });
  const review = useMutation({
    mutationFn: (encounterId: string) => api.post(`/records/retention/${encounterId}/review`, { decision: form.decision, note: form.note.trim(), ...(form.decision === "HOLD" && form.until ? { retainUntil: form.until } : {}) }, newKey()),
    onSuccess: () => { setOpen(null); setForm({ decision: "HOLD", note: "", until: "" }); void qc.invalidateQueries({ queryKey: ["record-retention"] }); },
  });
  const d = list.data;
  return (
    <Card title={`Records past their retention period${d ? ` (${d.counts.due} due)` : ""}`}>
      <p className="mb-2 text-sm text-slate-600">
        {d ? `Kept ${d.policy.opdYears} years for a visit and ${d.policy.ipdYears} years for an admission${d.policy.minorsUntilAdult ? ", and for a child until they are 18 plus that period" : ""}. ` : ""}
        When the period is over, hold a record longer (a legal case, research) or clear it for archiving. Nothing is deleted from MedOS.
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Show records" className="w-60" value={show} onChange={(e) => setShow(e.target.value)}>
          <option value="DUE">Due for a decision{d ? ` (${d.counts.due})` : ""}</option><option value="HELD">Held longer{d ? ` (${d.counts.held})` : ""}</option><option value="CLEARED">Cleared for archive{d ? ` (${d.counts.cleared})` : ""}</option><option value="ALL">All decided or due</option>
        </Select>
        <Input aria-label="Search records" className="min-w-60 flex-1" placeholder="Search name, MRN or visit number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Visit", "Ended", "Keep until", "Status", ""]} {...(d?.items.length === 0 ? { empty: "Nothing here." } : {})}>
          {d?.items.flatMap((r) => [
            <tr key={r.encounterId} data-testid="retention-row">
              <Td><b>{r.patient}</b><div className="text-xs text-slate-500">{r.mrn}</div></Td>
              <Td>{r.encounterNumber}<div className="text-xs text-slate-500">{r.type === "IPD" ? "admission" : "OPD visit"}</div></Td>
              <Td>{dateTime(r.endedAt)}</Td>
              <Td>{r.retentionEnds}</Td>
              <Td><Badge tone={TONE[r.state]}>{r.state === "DUE" ? "due" : r.state === "HELD" ? "held" : r.state === "CLEARED" ? "cleared for archive" : "within period"}</Badge>
                {r.review && <div className="text-xs text-slate-500">{r.review.decision === "HOLD" ? `hold${r.review.retainUntil ? ` until ${r.review.retainUntil}` : ", no end date"}` : "cleared"} · {r.review.by} · {r.review.note}</div>}</Td>
              <Td>{r.state !== "CLEARED" && <Button variant="secondary" onClick={() => setOpen(open === r.encounterId ? null : r.encounterId)}>Decide</Button>}</Td>
            </tr>,
            ...(open === r.encounterId ? [
              <tr key={`${r.encounterId}-form`}>
                <td className="bg-slate-50 px-3 py-2" colSpan={6}>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Decision"><Select value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value })}><option value="HOLD">Keep longer (hold)</option><option value="CLEAR_FOR_ARCHIVE" disabled={r.state === "WITHIN"}>Clear for archive</option></Select></Field>
                    {form.decision === "HOLD" && <Field label="Hold until (empty: no end date)"><Input type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} /></Field>}
                    <Field label="Why (at least 5 characters)"><Input className="w-80" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
                    <Button disabled={form.note.trim().length < 5} loading={review.isPending} onClick={() => review.mutate(r.encounterId)}>Record decision</Button>
                  </div>
                </td>
              </tr>,
            ] : []),
          ])}
        </Table>
      )}
      <ErrorNote error={review.error} />
    </Card>
  );
}
