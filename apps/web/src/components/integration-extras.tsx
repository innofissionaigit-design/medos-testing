"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface Ability { key: string; label: string }
interface Client { allowedIps: string[]; id: string; name: string; keyPrefix: string; abilities: string[]; status: "ACTIVE" | "REVOKED"; expired: boolean; expiresAt: string | null; lastUsedAt: string | null; createdAt: string; revokedAt: string | null; revokeReason: string | null }
interface Created { client: Client; apiKey: string }

/** Administration → Integrations: keys for outside systems and bots that book appointments through the API (docs/integration-api.md). */
export function IntegrationsAdmin() {
  const { dateTime } = useMe();
  const qc = useQueryClient();
  const abilities = useQuery({ queryKey: ["integration-abilities"], queryFn: () => api.get<Ability[]>("/integrations/abilities") });
  const clients = useQuery({ queryKey: ["integration-clients"], queryFn: () => api.get<Client[]>("/integrations/clients") });
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [days, setDays] = useState("");
  const [ips, setIps] = useState("");
  const [editing, setEditing] = useState<{ client: Client; what: "addresses" | "webhook" } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Client | null>(null);
  const chosen = picked ?? abilities.data?.map((a) => a.key) ?? [];
  const create = useMutation({
    mutationFn: () => api.post<Created>("/integrations/clients", { name: name.trim(), abilities: chosen, ...(days ? { expiresInDays: Number(days) } : {}), ...(ips.trim() ? { allowedIps: ips.split(/[\s,;]+/).filter(Boolean) } : {}) }),
    onSuccess: async (c) => { setCreated(c); setCopied(false); setName(""); setIps(""); await qc.invalidateQueries({ queryKey: ["integration-clients"] }); },
  });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  const label = (k: string) => abilities.data?.find((a) => a.key === k)?.label.split(" (")[0] ?? k;
  return (
    <div className="space-y-4">
      <Notice>
        An integration is a key for another system or a voice bot to book appointments through the API. It can only do what you tick below; it can never see bills, other staff, settings or other patients’ records, and it can only change the bookings it made itself. The key is shown once, when you create it. Guide: <code>docs/integration-api.md</code>.
      </Notice>
      {created && (
        <Card title={`API key for “${created.client.name}”`}>
          <div className="space-y-2">
            <Notice tone="warn">Copy this key now. It is shown only once and cannot be recovered; if it is lost, revoke this integration and create a new one.</Notice>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-slate-100 px-2 py-1 text-sm" aria-label="API key">{created.apiKey}</code>
              <Button variant="secondary" onClick={() => void copy(created.apiKey)}>{copied ? "Copied" : "Copy"}</Button>
              <Button variant="ghost" onClick={() => setCreated(null)}>I have saved it</Button>
            </div>
            <p className="text-xs text-slate-500">Send it as <code>Authorization: Bearer &lt;key&gt;</code>. Keep it secret, like a password.</p>
          </div>
        </Card>
      )}
      <Card title="Add an integration">
        {abilities.isLoading ? <Spinner /> : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Name (for example Voice bot)"><Input aria-label="Integration name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Key valid for">
                <Select aria-label="Key validity" value={days} onChange={(e) => setDays(e.target.value)}><option value="">Until revoked</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></Select>
              </Field>
              <Field label="Only from these addresses (optional)"><Input aria-label="Allowed addresses" value={ips} placeholder="203.0.113.7, 198.51.100.0/24" onChange={(e) => setIps(e.target.value)} /></Field>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium text-slate-700">What it may do</legend>
              {abilities.data?.map((a) => (
                <label key={a.key} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={chosen.includes(a.key)} onChange={(e) => setPicked(e.target.checked ? [...chosen, a.key] : chosen.filter((x) => x !== a.key))} />
                  <span>{a.label}</span>
                </label>
              ))}
              <p className="text-xs text-slate-500">It can always see the doctors, their free times and the bookings it made.</p>
            </fieldset>
            <ErrorNote error={create.error} />
            <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2 || chosen.length === 0}>Create integration and key</Button>
          </form>
        )}
      </Card>
      <Card title="Integrations">
        {clients.isLoading ? <Spinner /> : (
          <Table head={["Name", "Can", "Key starts with", "Used from", "Last used", "Status", ""]} {...(clients.data?.length === 0 ? { empty: "No integrations yet." } : {})}>
            {clients.data?.map((c) => (
              <tr key={c.id}>
                <Td>{c.name}<div className="text-xs text-slate-500">created {dateTime(c.createdAt)}</div></Td>
                <Td><div className="text-xs">{c.abilities.map(label).join(" · ")}</div></Td>
                <Td><code>{c.keyPrefix}…</code></Td>
                <Td><div className="max-w-40 break-words text-xs">{c.allowedIps.length > 0 ? c.allowedIps.join(", ") : "anywhere"}</div></Td>
                <Td>{c.lastUsedAt ? dateTime(c.lastUsedAt) : "never"}</Td>
                <Td>
                  {c.status === "REVOKED" ? <Badge tone="gray">revoked</Badge> : c.expired ? <Badge tone="amber">expired</Badge> : <Badge tone="green">active</Badge>}
                  {c.expiresAt && c.status === "ACTIVE" && !c.expired && <div className="text-xs text-slate-500">until {dateTime(c.expiresAt)}</div>}
                  {c.revokeReason && <div className="text-xs text-slate-500">{c.revokeReason}</div>}
                </Td>
                <Td className="space-x-1 whitespace-nowrap">{c.status === "ACTIVE" && <><Button variant="ghost" onClick={() => setEditing({ client: c, what: "addresses" })}>Addresses…</Button><Button variant="ghost" onClick={() => setEditing({ client: c, what: "webhook" })}>Webhook…</Button><Button variant="ghost" onClick={() => setRevoking(c)}>Revoke…</Button></>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing?.what === "addresses" && <AddressesModal client={editing.client} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await qc.invalidateQueries({ queryKey: ["integration-clients"] }); }} />}
      {editing?.what === "webhook" && <WebhookModal client={editing.client} onClose={() => setEditing(null)} />}
      {revoking && <RevokeModal client={revoking} onClose={() => setRevoking(null)} onDone={async () => { setRevoking(null); await qc.invalidateQueries({ queryKey: ["integration-clients"] }); }} />}
    </div>
  );
}

function RevokeModal({ client, onClose, onDone }: { client: Client; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const revoke = useMutation({ mutationFn: () => api.post(`/integrations/clients/${client.id}/revoke`, { reason: reason.trim() }), onSuccess: onDone });
  return (
    <Modal title={`Revoke “${client.name}”?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">Its key stops working immediately. This cannot be undone; create a new integration to give access again.</p>
        <Field label="Reason (recorded)"><Input autoFocus value={reason} maxLength={240} onChange={(e) => setReason(e.target.value)} placeholder="At least 5 characters" /></Field>
        <ErrorNote error={revoke.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" disabled={reason.trim().length < 5} loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke key</Button></div>
      </div>
    </Modal>
  );
}

/** Where a key may be used from. Empty means from anywhere. */
function AddressesModal({ client, onClose, onDone }: { client: Client; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(client.allowedIps.join(", "));
  const save = useMutation({ mutationFn: () => api.put(`/integrations/clients/${client.id}/allowed-ips`, { allowedIps: text.split(/[\s,;]+/).filter(Boolean) }), onSuccess: onDone });
  return (
    <Modal title={`Where “${client.name}” may be used from`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">Type the addresses of the computers or servers the key may be used from, separated by commas. A range looks like <code>198.51.100.0/24</code>. Leave it empty to allow the key from anywhere. From any other address the key is refused, even though it is correct.</p>
        <Field label="Allowed addresses"><Input autoFocus aria-label="Allowed addresses" value={text} onChange={(e) => setText(e.target.value)} placeholder="Empty means from anywhere" /></Field>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
      </div>
    </Modal>
  );
}

interface WebhookView {
  webhook: { id: string; url: string; events: string[]; status: "ACTIVE" | "INACTIVE"; secretLast4: string } | null;
  canStoreSecret: boolean;
  deliveries: { id: string; event: string; status: "PENDING" | "DELIVERED" | "FAILED"; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string }[];
  secret?: string | null;
}
const EVENTS = [["appointment.booked", "An appointment is booked"], ["appointment.moved", "An appointment is moved"], ["appointment.cancelled", "An appointment is cancelled"]] as const;

/** Tell another system when one of the appointments its key made is booked, moved or cancelled (docs/integration-api.md). */
function WebhookModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const { dateTime } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["webhook", client.id], queryFn: () => api.get<WebhookView>(`/integrations/clients/${client.id}/webhook`) });
  const [url, setUrl] = useState<string | null>(null);
  const [events, setEvents] = useState<string[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const wh = q.data?.webhook ?? null;
  const shownUrl = url ?? wh?.url ?? "";
  const shownEvents = events ?? wh?.events ?? EVENTS.map((e) => e[0]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["webhook", client.id] }); };
  const save = useMutation({
    mutationFn: (status?: "ACTIVE" | "INACTIVE") => api.put<WebhookView>(`/integrations/clients/${client.id}/webhook`, { url: shownUrl.trim(), events: shownEvents, ...(status ? { status } : {}) }),
    onSuccess: (r) => { if (r.secret) setSecret(r.secret); setUrl(null); setEvents(null); refresh(); },
  });
  const rotate = useMutation({ mutationFn: () => api.post<{ secret: string }>(`/integrations/clients/${client.id}/webhook/rotate-secret`), onSuccess: (r) => { setSecret(r.secret); refresh(); } });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>(`/integrations/clients/${client.id}/webhook/test`), onSuccess: (r) => setTested(r.message) });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/integrations/clients/${client.id}/webhook/deliveries/${id}/retry`), onSuccess: refresh });
  return (
    <Modal title={`Webhook for “${client.name}”`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">MedOS sends a signed message to this address whenever an appointment that this integration made is booked, moved or cancelled, by anyone. The message carries identifiers, times and the status only, never patient details.</p>
        {!q.isLoading && q.data && !q.data.canStoreSecret && !wh && <Notice tone="warn">This server has no secrets encryption key, so a webhook cannot be created yet. Ask your administrator to set SECRETS_ENCRYPTION_KEY.</Notice>}
        {secret && (
          <Notice tone="warn">
            Signing secret (shown only now, copy it): <code className="break-all">{secret}</code>
            <div className="mt-1 text-xs">Check the signature of each message with it: <code>X-MedOS-Signature: t=…,v1=…</code> is the HMAC-SHA256 of <code>t.body</code>.</div>
          </Notice>
        )}
        <Field label="Address to send to"><Input aria-label="Webhook address" value={shownUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/medos-hook" /></Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-slate-700">Tell it when</legend>
          {EVENTS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shownEvents.includes(key)} onChange={(e) => setEvents(e.target.checked ? [...shownEvents, key] : shownEvents.filter((x) => x !== key))} />{label}</label>
          ))}
        </fieldset>
        <ErrorNote error={save.error ?? rotate.error ?? test.error ?? retry.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={save.isPending} disabled={shownUrl.trim().length < 8 || shownEvents.length === 0 || (!wh && !q.data?.canStoreSecret)} onClick={() => save.mutate(undefined)}>{wh ? "Save changes" : "Create webhook"}</Button>
          {wh && <Button variant="secondary" loading={test.isPending} onClick={() => { setTested(null); test.mutate(); }}>Send a test</Button>}
          {wh && <Button variant="ghost" loading={save.isPending} onClick={() => save.mutate(wh.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")}>{wh.status === "ACTIVE" ? "Switch off" : "Switch on"}</Button>}
          {wh && <Button variant="ghost" loading={rotate.isPending} onClick={() => rotate.mutate()}>New secret</Button>}
          {wh && <Badge tone={wh.status === "ACTIVE" ? "green" : "gray"}>{wh.status === "ACTIVE" ? "on" : "off"} · secret …{wh.secretLast4}</Badge>}
        </div>
        {tested && <Notice>{tested}</Notice>}
        {q.data && q.data.deliveries.length > 0 && (
          <Table head={["When", "Event", "Result", ""]}>
            {q.data.deliveries.map((d) => (
              <tr key={d.id}>
                <Td>{dateTime(d.createdAt)}</Td><Td>{d.event.replace("appointment.", "")}</Td>
                <Td>{d.status === "DELIVERED" ? "delivered" : d.status === "FAILED" ? `given up: ${d.lastError ?? "failed"}` : d.attempts > 0 ? `will retry (${d.attempts} tried)` : "waiting"}</Td>
                <Td>{d.status === "FAILED" && <Button variant="ghost" onClick={() => retry.mutate(d.id)}>Retry</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Modal>
  );
}
