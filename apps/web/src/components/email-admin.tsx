"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ConfirmButton, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, StatusBadge, Table, Td, Textarea } from "@/components/ui";
import { api, type Page } from "@/lib/api";
import { T } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Status { enabled: boolean; provider: string; providerConnected: boolean; senderAddress: string | null }
interface Setting { key: string; value: unknown }
interface Template { key: string; label: string; description: string; placeholders: string[]; languages: { language: "en" | "bn" | "hi"; default: { subject: string; body: string }; custom: { subject: string; body: string; version: number } | null }[] }
interface LogRow { id: string; templateKey: string; to: string; subject: string; status: string; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string; logOnly: boolean }
interface Suppression { id: string; address: string; reason: string; note: string | null; createdAt: string }
const LANGUAGE_NAME = { en: "English", bn: "Bengali", hi: "Hindi" } as const;

/** Administration → Email (docs/email.md): switch email on, set the sender and language, reword the emails, send a test, read the delivery log and keep a do-not-email list. */
export function EmailAdmin() {
  const { can } = useMe();
  const manage = can("EMAIL_MANAGE");
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["email-status"], queryFn: () => api.get<Status>("/email/status") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Setting[]>("/settings"), enabled: can("ADMIN_SETTINGS") });
  const val = (k: string) => settings.data?.find((s) => s.key === k)?.value;
  const put = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => api.put(`/settings/${key}`, { value }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["settings"] }); await qc.invalidateQueries({ queryKey: ["email-status"] }); },
  });
  const [fromName, setFromName] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  if (status.isLoading || settings.isLoading) return <Spinner />;
  const s = status.data;
  const flag = (k: string, label: string, hint?: string) => (
    <label key={k} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
      <span><T>{label}</T>{hint && <span className="block text-xs text-slate-500"><T>{hint}</T></span>}</span>
      <input type="checkbox" aria-label={label} className="mt-1" checked={val(k) === true} disabled={!can("ADMIN_SETTINGS") || put.isPending} onChange={(e) => put.mutate({ key: k, value: e.target.checked })} />
    </label>
  );
  return (
    <div className="space-y-4">
      <Card title="Email">
        {s && !s.providerConnected && <Notice tone="warn">No email service is connected to this server yet, so emails are only recorded in the delivery log and never leave it. Ask whoever runs the server to connect one (docs/email.md).</Notice>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {flag("EMAIL_ENABLED", "Send emails to patients", "Appointment booked or cancelled, a report is ready, and receipts you send from a bill.")}
          {flag("EMAIL_REQUIRE_CONSENT", "Only email patients who have agreed", "Off: email unless the patient has withdrawn. A patient who withdrew is never emailed.")}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Sender name" hint="Empty: the facility name.">
            <Input value={fromName ?? String(val("EMAIL_FROM_NAME") ?? "")} onChange={(e) => setFromName(e.target.value)} onBlur={() => { if (fromName !== null && fromName !== String(val("EMAIL_FROM_NAME") ?? "")) put.mutate({ key: "EMAIL_FROM_NAME", value: fromName }); }} />
          </Field>
          <Field label="Reply-to address" hint="Where a patient's reply goes. Empty: none.">
            <Input type="email" value={replyTo ?? String(val("EMAIL_REPLY_TO") ?? "")} onChange={(e) => setReplyTo(e.target.value)} onBlur={() => { if (replyTo !== null && replyTo !== String(val("EMAIL_REPLY_TO") ?? "")) put.mutate({ key: "EMAIL_REPLY_TO", value: replyTo }); }} />
          </Field>
          <Field label="Language of the emails">
            <Select aria-label="Language of the emails" value={String(val("EMAIL_LANGUAGE") ?? "en")} disabled={!can("ADMIN_SETTINGS")} onChange={(e) => put.mutate({ key: "EMAIL_LANGUAGE", value: e.target.value })}>
              <option value="en">English</option><option value="bn">Bengali</option><option value="hi">Hindi</option>
            </Select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-slate-500"><T>Sending address (set on the server):</T> {s?.senderAddress ?? "—"}</p>
        <ErrorNote error={put.error} />
      </Card>
      {manage && <TestEmail />}
      <Wording manage={manage} />
      <DeliveryLog manage={manage} />
      <DoNotEmail manage={manage} />
    </div>
  );
}

function TestEmail() {
  const qc = useQueryClient();
  const [to, setTo] = useState("");
  const send = useMutation({ mutationFn: () => api.post<{ queued: boolean; reason?: string }>("/email/test", { to }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["email-log"] }) });
  const why: Record<string, string> = { DISABLED: "Email is switched off. Turn on “Send emails to patients” first.", SUPPRESSED: "That address is on the do-not-email list.", NO_ADDRESS: "That is not a usable address." };
  return (
    <Card title="Send a test email">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <Field label="Send to" className="w-72"><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.org" /></Field>
        <Button type="submit" loading={send.isPending} disabled={!to.includes("@")}>Send test</Button>
      </form>
      {send.data && (send.data.queued ? <div className="mt-2"><Notice tone="success">Queued. It is sent within a minute; watch the delivery log below.</Notice></div> : <div className="mt-2"><Notice tone="warn">{why[send.data.reason ?? ""] ?? "It was not queued."}</Notice></div>)}
      <ErrorNote error={send.error} />
    </Card>
  );
}

function Wording({ manage }: { manage: boolean }) {
  const list = useQuery({ queryKey: ["email-templates"], queryFn: () => api.get<Template[]>("/email/templates") });
  const [editing, setEditing] = useState<{ t: Template; language: "en" | "bn" | "hi" } | null>(null);
  if (list.isLoading) return <Spinner />;
  return (
    <Card title="Wording of each email">
      <p className="mb-2 text-xs text-slate-500"><T>Each email has built-in wording in English, Bengali and Hindi. Change it for your hospital; “custom” marks the ones you changed. No email contains a medical result.</T></p>
      <Table head={["Email", "English", "Bengali", "Hindi"]}>
        {list.data?.map((t) => (
          <tr key={t.key}>
            <Td><div className="font-medium">{t.label}</div><div className="text-xs text-slate-500">{t.description}</div></Td>
            {t.languages.map((l) => (
              <Td key={l.language}>
                <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setEditing({ t, language: l.language })}><T>{manage ? "Edit" : "View"}</T>{l.custom ? <> (<T>custom</T>)</> : ""}</button>
              </Td>
            ))}
          </tr>
        ))}
      </Table>
      {editing && <TemplateEditor t={editing.t} language={editing.language} manage={manage} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TemplateEditor({ t, language, manage, onClose }: { t: Template; language: "en" | "bn" | "hi"; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const l = t.languages.find((x) => x.language === language)!;
  const start = l.custom ?? l.default;
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["email-templates"] }); };
  const preview = useMutation({ mutationFn: () => api.post<{ subject: string; text: string }>(`/email/templates/${t.key}/${language}/preview`, { subject, body }) });
  const save = useMutation({ mutationFn: () => api.put(`/email/templates/${t.key}/${language}`, { subject, body }), onSuccess: () => { refresh(); onClose(); } });
  const reset = useMutation({ mutationFn: () => api.del(`/email/templates/${t.key}/${language}`), onSuccess: () => { refresh(); onClose(); } });
  return (
    <Modal title={`${t.label} — ${LANGUAGE_NAME[language]}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-slate-500"><T>You can use:</T> {t.placeholders.map((p) => `{${p}}`).join("  ")}</p>
        <Field label="Subject"><Input value={subject} readOnly={!manage} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Text"><Textarea rows={9} value={body} readOnly={!manage} onChange={(e) => setBody(e.target.value)} /></Field>
        {preview.data && <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"><div className="font-medium">{preview.data.subject}</div><pre className="mt-2 whitespace-pre-wrap font-sans">{preview.data.text}</pre></div>}
        <ErrorNote error={preview.error ?? save.error ?? reset.error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" loading={preview.isPending} onClick={() => preview.mutate()}>Preview with an example</Button>
          {manage && l.custom && <ConfirmButton label="Use built-in wording" confirmLabel="Yes, go back to the built-in wording" variant="secondary" loading={reset.isPending} onConfirm={() => reset.mutate()} />}
          {manage && <Button loading={save.isPending} disabled={!subject.trim() || !body.trim()} onClick={() => save.mutate()}>Save wording</Button>}
        </div>
      </div>
    </Modal>
  );
}

function DeliveryLog({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ["email-log", status, page], queryFn: () => api.page<LogRow>("/email/outbox", { ...(status ? { status } : {}), page, pageSize: 15 }), refetchInterval: 20_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["email-log"] }); };
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/email/outbox/${id}/retry`), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/email/outbox/${id}/cancel`), onSuccess: refresh });
  const data: Page<LogRow> | undefined = log.data;
  return (
    <Card title="Delivery log" actions={<Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option><option value="PENDING">Waiting</option><option value="SENT">Sent</option><option value="FAILED">Failed</option><option value="SKIPPED">Skipped</option><option value="CANCELLED">Cancelled</option></Select>}>
      <Table head={["When", "Email", "To", "Status", "Tries", "Note", ""]} {...(data?.data.length === 0 ? { empty: "No emails yet." } : {})}>
        {data?.data.map((e) => (
          <tr key={e.id}>
            <Td>{dateTime(e.createdAt)}</Td><Td>{e.templateKey.toLowerCase().replace(/_/g, " ")}</Td><Td>{e.to}</Td>
            <Td><StatusBadge value={e.status} />{e.logOnly && e.status === "SENT" && <span className="ml-1 text-xs text-amber-700"><T>not really sent</T></span>}</Td>
            <Td>{e.attempts}</Td><Td className="max-w-xs text-xs text-slate-600">{e.lastError ?? ""}</Td>
            <Td className="whitespace-nowrap">
              {manage && (e.status === "FAILED" || e.status === "SKIPPED") && <Button variant="ghost" loading={retry.isPending && retry.variables === e.id} onClick={() => retry.mutate(e.id)}>Try again</Button>}
              {manage && e.status === "PENDING" && <Button variant="ghost" loading={cancel.isPending && cancel.variables === e.id} onClick={() => cancel.mutate(e.id)}>Cancel</Button>}
            </Td>
          </tr>
        ))}
      </Table>
      <ErrorNote error={log.error ?? retry.error ?? cancel.error} />
      {data && data.meta.total > data.meta.pageSize && (
        <div className="mt-2 flex items-center justify-end gap-2 text-sm">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span>{page} / {Math.ceil(data.meta.total / data.meta.pageSize)}</span>
          <Button variant="ghost" disabled={page * data.meta.pageSize >= data.meta.total} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </Card>
  );
}

function DoNotEmail({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const { date } = useMe();
  const list = useQuery({ queryKey: ["email-suppressions"], queryFn: () => api.get<Suppression[]>("/email/suppressions") });
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["email-suppressions"] }); };
  const add = useMutation({ mutationFn: () => api.post("/email/suppressions", { address, note }), onSuccess: () => { setAddress(""); setNote(""); refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/email/suppressions/${id}`), onSuccess: refresh });
  return (
    <Card title="Do not email">
      <p className="mb-2 text-xs text-slate-500"><T>Addresses on this list are never emailed, even by mistake. Emails already waiting for the address are skipped.</T></p>
      {manage && (
        <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Address" className="w-64"><Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          <Field label="Why (at least 3 characters)" className="w-64"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button type="submit" loading={add.isPending} disabled={!address.includes("@") || note.trim().length < 3}>Add</Button>
        </form>
      )}
      <Table head={["Address", "Reason", "Note", "Since", ""]} {...(list.data?.length === 0 ? { empty: "Nobody is on the list." } : {})}>
        {list.data?.map((r) => (
          <tr key={r.id}><Td>{r.address}</Td><Td>{r.reason.toLowerCase()}</Td><Td>{r.note ?? ""}</Td><Td>{date(r.createdAt)}</Td>
            <Td>{manage && <ConfirmButton label="Remove" confirmLabel="Yes, allow email again" variant="ghost" loading={remove.isPending && remove.variables === r.id} onConfirm={() => remove.mutate(r.id)} />}</Td></tr>
        ))}
      </Table>
      <ErrorNote error={add.error ?? remove.error} />
    </Card>
  );
}
