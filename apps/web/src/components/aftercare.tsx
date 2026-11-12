"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td } from "./ui";

const label = (s: string) => s.replace(/_/g, " ").toLowerCase();
const TONE: Record<string, "gray" | "blue" | "amber" | "green" | "red"> = { PENDING: "amber", BOOKED: "blue", COMPLETED: "green", CLOSED: "gray", OPEN: "amber", IN_PROGRESS: "blue", RESOLVED: "green", HIGH: "red", MEDIUM: "amber", LOW: "gray" };
const OUTCOMES: { id: string; label: string }[] = [
  { id: "NO_ANSWER", label: "No answer" }, { id: "CALL_AGAIN", label: "Asked to call again" }, { id: "WRONG_NUMBER", label: "Wrong number" },
  { id: "DECLINED", label: "Does not want a review" }, { id: "ALREADY_VISITED", label: "Has already been seen" },
];
const SHOW = [["DUE", "Calls due"], ["PENDING", "All pending"], ["BOOKED", "Booked"], ["DONE", "Seen"], ["CLOSED", "Closed"]] as const;

interface Task {
  id: string; patientId: string; patient: string; mrn: string | null; mobile: string | null; admissionNumber: string; dischargedAt: string | null; dueDate: string; daysOverdue: number; status: string; adviceNote: string | null;
  attempts: number; nextCallAt: string | null; claimedUntil: string | null; assignedTo: string | null; lastContact: { outcome: string; at: string } | null; appointment: { startAt: string; status: string; doctor: string } | null; closeReason: string | null;
}
interface Detail { id: string; patient: string; mobile: string | null; patientId: string; dueDate: string; adviceNote: string | null; status: string; reminderSentAt: string | null; reminderError: string | null; contacts: { outcome: string; note: string | null; durationSeconds: number | null; at: string; by: string | null }[] }
interface Doc { id: string; displayName: string }
interface Slot { startAt: string; endAt: string; available: boolean }

// ───────────────────────── call list ─────────────────────────

export function CallListTab() {
  const { dateTime } = useMe();
  const [show, setShow] = useState<(typeof SHOW)[number][0]>("DUE");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const qc0 = useQueryClient();
  const [empty, setEmpty] = useState(false);
  const takeNext = useMutation({ mutationFn: () => api.post<{ id: string } | null>("/aftercare/queue/next"), onSuccess: async (t) => { setEmpty(!t); await qc0.invalidateQueries({ queryKey: ["aftercare"] }); if (t) setOpen(t.id); } });
  const list = useQuery({ queryKey: ["aftercare", show, mine, q], queryFn: () => api.get<{ items: Task[]; total: number }>("/aftercare/tasks", { show, mine: mine ? "1" : "0", search: q.trim() || undefined, pageSize: 50 }) });
  return (
    <Card title="Review calls after discharge">
      <TargetsBar />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button loading={takeNext.isPending} onClick={() => takeNext.mutate()}>Take the next patient</Button>
        {SHOW.map(([id, text]) => <Button key={id} variant={show === id ? "primary" : "secondary"} onClick={() => setShow(id)}>{text}</Button>)}
        <label className="ml-2 flex items-center gap-1 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine</label>
        <Input className="ml-auto w-56" aria-label="Search" placeholder="Name, mobile or MRN" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {empty && <p className="mb-2 text-sm text-slate-600">No one is waiting for a call right now.</p>}
      <ErrorNote error={takeNext.error} />
      {list.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Stay", "Review due", "Calls", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: show === "DUE" ? "No one to call right now." : "Nothing here." } : {})}>
          {list.data?.items.map((r) => (
            <tr key={r.id}>
              <Td><div className="font-medium">{r.patient}</div><div className="text-xs text-slate-500">{r.mrn ?? ""} {r.mobile ? `· ${r.mobile}` : "· no mobile number"}</div></Td>
              <Td>{r.admissionNumber}<div className="text-xs text-slate-500">{r.adviceNote ?? ""}</div></Td>
              <Td>{r.dueDate}{r.status === "PENDING" && r.daysOverdue > 0 && <div className="text-xs text-red-700">{r.daysOverdue} day(s) late</div>}</Td>
              <Td>{r.claimedUntil && <div className="text-xs text-amber-700">on a call{r.assignedTo ? ` with ${r.assignedTo}` : ""}</div>}{r.attempts}{r.lastContact && <div className="text-xs text-slate-500">{label(r.lastContact.outcome)}, {dateTime(r.lastContact.at)}</div>}{r.nextCallAt && r.status === "PENDING" && <div className="text-xs text-amber-700">call {dateTime(r.nextCallAt)}</div>}</Td>
              <Td><Badge tone={TONE[r.status] ?? "gray"}>{r.status === "COMPLETED" ? "seen" : label(r.status)}</Badge>{r.appointment && <div className="text-xs text-slate-500">{dateTime(r.appointment.startAt)} · {r.appointment.doctor}</div>}{r.closeReason && <div className="text-xs text-slate-500">{r.closeReason}</div>}</Td>
              <Td><Button variant="ghost" onClick={() => setOpen(r.id)}>{r.status === "PENDING" ? "Call…" : "Open"}</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {open && <CallModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function CallModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const d = useQuery({ queryKey: ["aftercare-task", id], queryFn: () => api.get<Detail>(`/aftercare/tasks/${id}`) });
  const [mode, setMode] = useState<"call" | "book" | "feedback">("call");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["aftercare"] }); await qc.invalidateQueries({ queryKey: ["aftercare-summary"] }); await qc.invalidateQueries({ queryKey: ["aftercare-targets"] }); await qc.invalidateQueries({ queryKey: ["aftercare-task", id] }); };
  return (
    <Modal title={d.data ? `${d.data.patient}: review after discharge` : "Review after discharge"} onClose={onClose} wide>
      {d.isLoading || !d.data ? <Spinner /> : (
        <div className="space-y-3">
          <div className="text-sm text-slate-600">{d.data.mobile ?? "No mobile number on file"} · review due {d.data.dueDate}{d.data.adviceNote ? ` · ${d.data.adviceNote}` : ""}{d.data.reminderSentAt ? ` · text sent ${dateTime(d.data.reminderSentAt)}` : d.data.reminderError ? ` · text not sent: ${d.data.reminderError}` : ""}</div>
          {d.data.status === "PENDING" && <ScriptPanel taskId={id} />}
          {d.data.contacts.length > 0 && <ul className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">{d.data.contacts.map((c, i) => <li key={i}>{dateTime(c.at)}: {label(c.outcome)}{c.durationSeconds !== null ? `, ${Math.floor(c.durationSeconds / 60)}m ${c.durationSeconds % 60}s` : ""}{c.note ? `, ${c.note}` : ""}{c.by ? ` (${c.by})` : ""}</li>)}</ul>}
          {d.data.status === "PENDING" ? (
            <>
              <div className="flex gap-2"><Button variant={mode === "call" ? "primary" : "secondary"} onClick={() => setMode("call")}>Record a call</Button><Button variant={mode === "book" ? "primary" : "secondary"} onClick={() => setMode("book")}>Book the review</Button><Button variant={mode === "feedback" ? "primary" : "secondary"} onClick={() => setMode("feedback")}>Feedback or complaint</Button></div>
              {mode === "call" && <RecordCall id={id} mobile={d.data.mobile} onDone={async () => { await refresh(); onClose(); }} />}
              {mode === "book" && <BookReview id={id} dueDate={d.data.dueDate} onDone={async () => { await refresh(); onClose(); }} />}
              {mode === "feedback" && <FeedbackForm taskId={id} patientId={d.data.patientId} onDone={onClose} />}
            </>
          ) : (
            <>
              <p className="text-sm">This review is <b>{label(d.data.status)}</b>.</p>
              <FeedbackForm taskId={id} patientId={d.data.patientId} onDone={onClose} />
            </>
          )}
          <FeedbackLink id={id} />
        </div>
      )}
    </Modal>
  );
}

/** What to say on this call: the hospital's own wording (or the built-in one) with the patient, doctor, due date and hospital filled in. */
function ScriptPanel({ taskId }: { taskId: string }) {
  const [kind, setKind] = useState<string>("");
  const s = useQuery({ queryKey: ["aftercare-script", taskId, kind], queryFn: () => api.get<{ kind: string; title: string; text: string; kinds: { kind: string; title: string }[] }>(`/aftercare/tasks/${taskId}/script`, kind ? { kind } : {}) });
  if (!s.data) return null;
  return (
    <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2"><span className="font-medium">What to say</span>
        <Select aria-label="Script" className="w-56" value={s.data.kind} onChange={(e) => setKind(e.target.value)}>{s.data.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}</Select></div>
      <p>{s.data.text}</p>
    </div>
  );
}

/** Today's calls against the targets, for the caller; for managers, everyone's. */
export function TargetsBar() {
  const q = useQuery({ queryKey: ["aftercare-targets"], queryFn: () => api.get<{ callTarget: number; bookingTarget: number; mine: { calls: number; reached: number; bookings: number; callsPercent: number | null; bookingsPercent: number | null }; team: { userId: string; name: string | null; calls: number; reached: number; bookings: number }[] | null }>("/aftercare/targets"), refetchInterval: 60_000 });
  const d = q.data;
  if (!d) return null;
  const bar = (title: string, done: number, target: number, percent: number | null) => (
    <div className="flex-1 min-w-40"><div className="flex justify-between text-xs text-slate-600"><span>{title}</span><span>{done}{target > 0 ? ` of ${target}` : ""}</span></div>
      {percent !== null && <div className="mt-1 h-2 rounded bg-slate-100"><div className={`h-2 rounded ${percent >= 100 ? "bg-green-500" : "bg-brand-600"}`} style={{ width: `${percent}%` }} /></div>}</div>
  );
  return (
    <div className="mb-3 space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap gap-4">{bar("Your calls today", d.mine.calls, d.callTarget, d.mine.callsPercent)}{bar("Reviews you booked today", d.mine.bookings, d.bookingTarget, d.mine.bookingsPercent)}<div className="text-xs text-slate-600">{d.mine.reached} answered</div></div>
      {d.team && d.team.length > 0 && <p className="text-xs text-slate-600">Team today: {d.team.map((r) => `${r.name ?? "?"} ${r.calls} calls, ${r.bookings} booked`).join(" · ")}</p>}
    </div>
  );
}

/** Managers write the call scripts. {patient}, {doctor}, {due} and {hospital} are filled in on each call. */
export function ScriptsTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["aftercare-scripts"], queryFn: () => api.get<{ kind: string; title: string; body: string; isDefault: boolean; defaultBody: string }[]>("/aftercare/scripts") });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: (a: { kind: string; body: string }) => api.put(`/aftercare/scripts/${a.kind}`, { body: a.body }), onSuccess: async (_d, a) => { setEdit((e) => { const n = { ...e }; delete n[a.kind]; return n; }); await qc.invalidateQueries({ queryKey: ["aftercare-scripts"] }); } });
  const reset = useMutation({ mutationFn: (kind: string) => api.post(`/aftercare/scripts/${kind}/reset`), onSuccess: async (_d, kind) => { setEdit((e) => { const n = { ...e }; delete n[kind]; return n; }); await qc.invalidateQueries({ queryKey: ["aftercare-scripts"] }); } });
  return (
    <Card title="Call scripts">
      <p className="mb-3 text-sm text-slate-600">What callers say on each kind of call. You can use {"{patient}"}, {"{doctor}"}, {"{due}"} and {"{hospital}"}; they are filled in for each patient.</p>
      <ErrorNote error={save.error ?? reset.error} />
      {list.isLoading ? <Spinner /> : list.data?.map((s) => {
        const text = edit[s.kind] ?? s.body;
        return (
          <div key={s.kind} className="mb-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">{s.title}{s.isDefault && <Badge tone="gray">built-in</Badge>}</div>
            <textarea aria-label={s.title} className="w-full rounded-md border border-slate-300 p-2 text-sm" rows={3} maxLength={1500} value={text} onChange={(e) => setEdit({ ...edit, [s.kind]: e.target.value })} />
            <div className="flex gap-2"><Button disabled={text === s.body || text.trim().length < 10} loading={save.isPending} onClick={() => save.mutate({ kind: s.kind, body: text.trim() })}>Save</Button>{!s.isDefault && <Button variant="ghost" onClick={() => reset.mutate(s.kind)}>Use the built-in wording</Button>}</div>
          </div>
        );
      })}
    </Card>
  );
}

/** The call timer: starts when the staff member presses Call (which opens the phone or softphone on their device with the number), stops on End call. */
function CallTimer({ mobile, onSeconds }: { mobile: string | null; onSeconds: (s: number | null) => void }) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (tick.current) clearInterval(tick.current); }, []);
  const start = () => { const t = Date.now(); setStarted(t); setNow(t); onSeconds(null); tick.current = setInterval(() => setNow(Date.now()), 1000); if (mobile) window.location.href = `tel:${mobile.replace(/[^+\d]/g, "")}`; };
  const stop = () => { if (tick.current) clearInterval(tick.current); tick.current = null; if (started) onSeconds(Math.max(0, Math.round((Date.now() - started) / 1000))); setStarted(null); };
  const secs = started ? Math.round((now - started) / 1000) : 0;
  return started ? (
    <div className="flex items-center gap-3 rounded-md bg-green-50 p-2 text-sm"><span aria-live="polite">On the call: {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span><Button variant="secondary" onClick={stop}>End call</Button></div>
  ) : (
    <Button variant="secondary" disabled={!mobile} onClick={start}>{mobile ? `Call ${mobile}` : "No number to call"}</Button>
  );
}

function RecordCall({ id, mobile, onDone }: { id: string; mobile: string | null; onDone: () => Promise<void> }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [outcome, setOutcome] = useState("NO_ANSWER");
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const save = useMutation({ mutationFn: () => api.post(`/aftercare/tasks/${id}/contacts`, { outcome, ...(note.trim() ? { note: note.trim() } : {}), ...(next ? { nextCallAt: new Date(next).toISOString() } : {}), ...(seconds !== null ? { durationSeconds: seconds } : {}) }), onSuccess: onDone });
  return (
    <div className="space-y-2">
      <CallTimer mobile={mobile} onSeconds={setSeconds} />
      {seconds !== null && <p className="text-xs text-slate-500">Call length {Math.floor(seconds / 60)}m {seconds % 60}s will be saved with the outcome.</p>}
      <Field label="What happened"><Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>
      {["CALL_AGAIN", "NO_ANSWER"].includes(outcome) && <Field label={outcome === "CALL_AGAIN" ? "Call again at" : "Try again at (optional)"}><Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></Field>}
      <Field label={["DECLINED", "ALREADY_VISITED"].includes(outcome) ? "Why (needed, this closes the review)" : "Note (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorNote error={save.error} />
      <div className="flex justify-end"><Button loading={save.isPending} disabled={(outcome === "CALL_AGAIN" && !next) || (["DECLINED", "ALREADY_VISITED"].includes(outcome) && note.trim().length < 3)} onClick={() => save.mutate()}>Save the call</Button></div>
    </div>
  );
}

function BookReview({ id, dueDate, onDone }: { id: string; dueDate: string; onDone: () => Promise<void> }) {
  const { dateTime } = useMe();
  const docs = useQuery({ queryKey: ["practitioners"], queryFn: () => api.get<Doc[]>("/practitioners") });
  const today = new Date().toISOString().slice(0, 10);
  const [doc, setDoc] = useState("");
  const [day, setDay] = useState(dueDate < today ? today : dueDate);
  const [slot, setSlot] = useState("");
  const slots = useQuery({ queryKey: ["slots", doc, day], queryFn: () => api.get<Slot[]>(`/practitioners/${doc}/availability`, { date: day }), enabled: !!doc });
  const book = useMutation({ mutationFn: () => api.post(`/aftercare/tasks/${id}/book`, { practitionerId: doc, startAt: slot }), onSuccess: onDone });
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Doctor"><Select value={doc} onChange={(e) => { setDoc(e.target.value); setSlot(""); }}><option value="">Choose…</option>{docs.data?.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select></Field>
        <Field label="Day"><Input type="date" min={today} value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }} /></Field>
      </div>
      {doc && (slots.isLoading ? <Spinner /> : (
        <div className="flex flex-wrap gap-2">
          {(slots.data ?? []).filter((s) => s.available).map((s) => <Button key={s.startAt} variant={slot === s.startAt ? "primary" : "secondary"} onClick={() => setSlot(s.startAt)}>{dateTime(s.startAt).split(", ").pop()}</Button>)}
          {(slots.data ?? []).filter((s) => s.available).length === 0 && <p className="text-sm text-slate-500">No free time that day.</p>}
        </div>
      ))}
      <ErrorNote error={book.error} />
      <div className="flex justify-end"><Button loading={book.isPending} disabled={!doc || !slot} onClick={() => book.mutate()}>Book the review visit</Button></div>
    </div>
  );
}

// ───────────────────────── feedback and complaints ─────────────────────────

/** The patient's own feedback form: a link that works once and needs no sign-in, to read out, copy or text. */
function FeedbackLink({ id }: { id: string }) {
  const [res, setRes] = useState<{ path: string; sent: boolean; notSentBecause: string | null } | null>(null);
  const make = useMutation({ mutationFn: (send: boolean) => api.post<{ path: string; sent: boolean; notSentBecause: string | null }>(`/aftercare/tasks/${id}/feedback-link`, { send }), onSuccess: setRes });
  const url = res ? `${window.location.origin}${res.path}` : "";
  return (
    <div className="space-y-2 rounded-md border border-slate-100 p-3">
      <div className="text-sm font-medium">Let the patient fill in the feedback form themselves</div>
      {!res ? (
        <div className="flex gap-2"><Button variant="secondary" loading={make.isPending} onClick={() => make.mutate(true)}>Text the link to the patient</Button><Button variant="ghost" onClick={() => make.mutate(false)}>Just make a link</Button></div>
      ) : (
        <div className="space-y-1 text-sm">
          <p className={res.sent ? "text-green-700" : "text-amber-700"}>{res.sent ? "The link was texted to the patient." : res.notSentBecause ? `Not texted: ${res.notSentBecause}.` : "Link made."} It works once, for 14 days.</p>
          <div className="flex gap-2"><Input aria-label="Feedback link" readOnly value={url} onFocus={(e) => e.target.select()} /><Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(url)}>Copy</Button></div>
        </div>
      )}
      <ErrorNote error={make.error} />
    </div>
  );
}

function FeedbackForm({ taskId, patientId, onDone }: { taskId: string; patientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [complain, setComplain] = useState(false);
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("MEDIUM");
  const [text, setText] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      let feedbackId: string | undefined;
      if (rating > 0) feedbackId = (await api.post<{ id: string }>("/aftercare/feedback", { taskId, rating, channel: "PHONE", ...(comment.trim() ? { comment: comment.trim() } : {}) })).id;
      if (complain) await api.post("/complaints", { taskId, ...(feedbackId ? { feedbackId } : {}), category: category.trim(), severity, description: text.trim() });
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["feedback"] }); await qc.invalidateQueries({ queryKey: ["complaints"] }); onDone(); },
  });
  return (
    <div className="space-y-2 rounded-md border border-slate-100 p-3">
      <div className="text-sm font-medium">What the patient says about their care</div>
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => <Button key={n} variant={rating === n ? "primary" : "secondary"} aria-label={`${n} out of 5`} onClick={() => setRating(n)}>{n}</Button>)}<span className="self-center text-xs text-slate-500">1 poor · 5 excellent</span></div>
      <Input aria-label="Comment" placeholder="Their words (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={complain} onChange={(e) => setComplain(e.target.checked)} /> There is a complaint to follow up</label>
      {complain && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="About"><Input placeholder="Billing, waiting, cleanliness…" value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
          <Field label="How serious"><Select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></Select></Field>
          <Field label="What happened"><Input value={text} onChange={(e) => setText(e.target.value)} /></Field>
        </div>
      )}
      <ErrorNote error={save.error} />
      <div className="flex justify-end"><Button loading={save.isPending} disabled={(rating === 0 && !complain) || (complain && (category.trim().length < 2 || text.trim().length < 10))} onClick={() => save.mutate()}>Save</Button></div>
      <span className="hidden">{patientId}</span>
    </div>
  );
}

interface Fb { id: string; patient: string; rating: number; comment: string | null; channel: string; recordedAt: string; recordedBy: string | null; complaints: string[] }

export function FeedbackTab() {
  const { dateTime } = useMe();
  const [low, setLow] = useState(false);
  const q = useQuery({ queryKey: ["feedback", low], queryFn: () => api.get<{ items: Fb[] }>("/aftercare/feedback", { pageSize: 50, ...(low ? { maxRating: 2 } : {}) }) });
  return (
    <Card title="What patients say" actions={<label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Only low ratings</label>}>
      {q.isLoading ? <Spinner /> : (
        <Table head={["When", "Patient", "Rating", "Comment", "Complaint"]} {...(q.data?.items.length === 0 ? { empty: "No feedback yet." } : {})}>
          {q.data?.items.map((f) => (
            <tr key={f.id}><Td>{dateTime(f.recordedAt)}<div className="text-xs text-slate-500">{label(f.channel)} · {f.recordedBy}</div></Td><Td>{f.patient}</Td><Td><Badge tone={f.rating <= 2 ? "red" : f.rating === 3 ? "amber" : "green"}>{f.rating} / 5</Badge></Td><Td>{f.comment}</Td><Td>{f.complaints.join(", ")}</Td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

interface Complaint { id: string; complaintNumber: string; category: string; severity: string; status: string; ageDays: number; patient: string | null; owner: string | null; createdAt: string; dueAt: string; overdue: boolean; escalated: boolean }
interface ComplaintDetail extends Complaint { escalatedTo: string | null; escalationReason: string | null; description: string; resolution: string | null; notes: { kind: string; note: string; at: string; by: string | null }[]; mobile: string | null }

export function ComplaintsTab() {
  const { can, dateTime } = useMe();
  const [status, setStatus] = useState("ACTIVE");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["complaints", status], queryFn: () => api.get<{ items: Complaint[] }>("/complaints", status === "OVERDUE" ? { status: "ACTIVE", overdue: 1, pageSize: 50 } : { status, pageSize: 50 }) });
  return (
    <Card title="Complaints" actions={<Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Open and in progress</option><option value="OVERDUE">Past their deadline</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option><option value="ALL">All</option></Select>}>
      {q.isLoading ? <Spinner /> : (
        <Table head={["Number", "About", "Patient", "Severity", "Status", "Owner", ""]} {...(q.data?.items.length === 0 ? { empty: "No complaints here." } : {})}>
          {q.data?.items.map((c) => (
            <tr key={c.id}><Td>{c.complaintNumber}<div className="text-xs text-slate-500">{dateTime(c.createdAt)} · {c.ageDays} day(s)</div></Td><Td>{c.category}</Td><Td>{c.patient}</Td><Td><Badge tone={TONE[c.severity] ?? "gray"}>{label(c.severity)}</Badge></Td><Td><Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge>{c.overdue && <div><Badge tone="red">past deadline</Badge></div>}{c.escalated && <div><Badge tone="amber">escalated</Badge></div>}<div className="text-xs text-slate-500">due {dateTime(c.dueAt)}</div></Td><Td>{c.owner ?? "Not taken yet"}</Td><Td><Button variant="ghost" onClick={() => setOpen(c.id)}>{can("COMPLAINT_MANAGE") ? "Work on…" : "Open"}</Button></Td></tr>
          ))}
        </Table>
      )}
      {open && <ComplaintModal id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function ComplaintModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can, dateTime } = useMe();
  const d = useQuery({ queryKey: ["complaint", id], queryFn: () => api.get<ComplaintDetail>(`/complaints/${id}`) });
  const [text, setText] = useState("");
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) => api.post(`/complaints/${id}/${path}`, body ?? {}),
    onSuccess: async () => { setText(""); await qc.invalidateQueries({ queryKey: ["complaint", id] }); await qc.invalidateQueries({ queryKey: ["complaints"] }); },
  });
  const c = d.data;
  const manage = can("COMPLAINT_MANAGE");
  return (
    <Modal title={c ? `${c.complaintNumber}: ${c.category}` : "Complaint"} onClose={onClose} wide>
      {!c ? <Spinner /> : (
        <div className="space-y-3">
          <div className="text-sm"><Badge tone={TONE[c.status] ?? "gray"}>{label(c.status)}</Badge> <Badge tone={TONE[c.severity] ?? "gray"}>{label(c.severity)}</Badge> · {c.patient ?? "No patient named"}{c.mobile ? ` · ${c.mobile}` : ""} · owner {c.owner ?? "not taken yet"}{c.escalatedTo ? ` · escalated to ${c.escalatedTo}` : ""}{c.overdue ? " · past its deadline" : ""}</div>
          <p className="rounded-md bg-slate-50 p-2 text-sm">{c.description}</p>
          {c.resolution && <p className="rounded-md bg-green-50 p-2 text-sm"><b>Outcome:</b> {c.resolution}</p>}
          <ul className="space-y-1 text-xs text-slate-600">{c.notes.map((n, i) => <li key={i}>{dateTime(n.at)} · {n.by}: {n.note}</li>)}</ul>
          {manage && c.status !== "CLOSED" && (
            <div className="space-y-2">
              <Input aria-label="Note or outcome" placeholder={c.status === "RESOLVED" ? "Why it is being reopened, or a closing note" : "A note, or the outcome (at least 10 characters to resolve)"} value={text} onChange={(e) => setText(e.target.value)} />
              <ErrorNote error={act.error} />
              <div className="flex flex-wrap justify-end gap-2">
                {c.status === "OPEN" && <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: "start" })}>Take it up</Button>}
                {c.status !== "RESOLVED" && <Button variant="secondary" disabled={text.trim().length < 2} onClick={() => act.mutate({ path: "notes", body: { note: text.trim() } })}>Add a note</Button>}
                {c.status !== "RESOLVED" && <Button disabled={text.trim().length < 10} onClick={() => act.mutate({ path: "resolve", body: { resolution: text.trim() } })}>Resolve</Button>}
                {c.status !== "RESOLVED" && !c.escalatedTo && <Button variant="secondary" disabled={text.trim().length < 5} onClick={() => act.mutate({ path: "escalate", body: { reason: text.trim() } })}>Send up to a manager</Button>}
                {c.status === "RESOLVED" && <Button variant="secondary" disabled={text.trim().length < 5} onClick={() => act.mutate({ path: "reopen", body: { reason: text.trim() } })}>Reopen</Button>}
                {c.status === "RESOLVED" && <Button onClick={() => act.mutate({ path: "close", body: text.trim() ? { note: text.trim() } : {} })}>Patient told, close it</Button>}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

interface Summary { from: string; to: string; reviews: { due: number; pending: number; booked: number; completed: number; closed: number; reached: number }; feedback: { count: number; average: number | null }; complaints: { total: number; open: number; resolved: number; averageDaysToResolve: number | null } }

export function JourneySummary() {
  const q = useQuery({ queryKey: ["aftercare-summary"], queryFn: () => api.get<Summary>("/aftercare/summary") });
  const s = q.data;
  if (!s) return null;
  const cell = (title: string, value: string | number, sub?: string) => <div className="rounded-md border border-slate-100 p-2"><div className="text-xs text-slate-500">{title}</div><div className="text-lg font-semibold">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>;
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
      {cell("Reviews due", s.reviews.due, `${s.from} to ${s.to}`)}{cell("Reached", s.reviews.reached)}{cell("Booked", s.reviews.booked)}{cell("Seen", s.reviews.completed)}
      {cell("Average rating", s.feedback.average ?? "–", `${s.feedback.count} rating(s)`)}{cell("Complaints", s.complaints.total, `${s.complaints.open} open${s.complaints.averageDaysToResolve !== null ? `, ${s.complaints.averageDaysToResolve} days to resolve` : ""}`)}
    </div>
  );
}
