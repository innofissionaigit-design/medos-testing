"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Select, Spinner, Textarea } from "./ui";

interface Config { connected: boolean; kind: string | null; url: string | null; model: string | null; hasKey: boolean; keyLast4: string | null; dataSharingConfirmed: boolean; lastTest: { ok: boolean; message: string | null } | null; enabledSetting: boolean; ready: boolean; canStoreKey: boolean }
interface Draft { id: string; task: string; status: string; text: string; requestedAt: string; edited: boolean; notice: string }

const TASK: Record<string, string> = { HISTORY_SUMMARY: "Summary of earlier visits", VISIT_ADVICE: "Draft advice for this visit" };

/** Administration → AI: connect the hospital's own AI provider, confirm the data sharing, test it, and switch the assistant on for doctors. */
export function AiAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ai-config"], queryFn: () => api.get<Config>("/ai/config") });
  const c = q.data;
  const [f, setF] = useState<{ kind: string; url: string; model: string; apiKey: string; ack: boolean } | null>(null);
  const form = f ?? { kind: c?.kind ?? "ANTHROPIC", url: c?.url ?? "", model: c?.model ?? "", apiKey: "", ack: c?.dataSharingConfirmed ?? false };
  const refresh = () => { setF(null); void qc.invalidateQueries({ queryKey: ["ai-config"] }); };
  const save = useMutation({
    mutationFn: () => api.put("/ai/config", { kind: form.kind, ...(form.url.trim() ? { url: form.url.trim() } : {}), ...(form.kind === "ANTHROPIC" ? { model: form.model.trim() } : {}), ...(form.apiKey ? { apiKey: form.apiKey } : {}), acknowledgeDataSharing: form.ack }),
    onSuccess: refresh,
  });
  const test = useMutation({ mutationFn: () => api.post("/ai/config/test", {}), onSuccess: refresh });
  const off = useMutation({ mutationFn: () => api.del("/ai/config"), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (v: boolean) => api.put("/settings/AI_ASSISTANT_ENABLED", { value: v }), onSuccess: refresh });
  if (!c) return <Spinner />;
  const step = (ok: boolean, text: string) => <li className="flex items-center gap-2 text-sm"><Badge tone={ok ? "green" : "gray"}>{ok ? "done" : "to do"}</Badge>{text}</li>;
  return (
    <div className="space-y-4">
      <Card title="AI assistant for doctors">
        <Notice tone="warn">The assistant only drafts text for a doctor to check: a summary of earlier visits, or advice for a visit in simple language. It never diagnoses, never prescribes and never writes to the chart by itself. It is off until all four steps below are done. What it sends to your provider has names, phone numbers and record numbers removed, but is still health information: only use a provider your agreement allows.</Notice>
        <ul className="mt-3 space-y-1">
          {step(c.connected, "Connect your AI provider")}{step(c.dataSharingConfirmed, "Confirm that sending de-identified visit data to it is allowed")}
          {step(c.lastTest?.ok === true, "Test the connection")}{step(c.enabledSetting, "Switch the assistant on")}
        </ul>
        <div className="mt-3 flex items-center gap-3"><Badge tone={c.ready ? "green" : "gray"}>{c.ready ? "available to doctors" : "not available"}</Badge>
          <Button variant="secondary" disabled={!c.connected} loading={toggle.isPending} onClick={() => toggle.mutate(!c.enabledSetting)}>{c.enabledSetting ? "Switch off" : "Switch on"}</Button></div>
      </Card>
      <Card title="Provider">
        {!c.canStoreKey && <Notice tone="warn">The server has no encryption key set, so a key cannot be saved. Ask whoever runs the server to set SECRETS_ENCRYPTION_KEY.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider"><Select value={form.kind} onChange={(e) => setF({ ...form, kind: e.target.value })}><option value="ANTHROPIC">Anthropic (Claude)</option><option value="HTTP">Another service (simple JSON)</option></Select></Field>
          {form.kind === "ANTHROPIC" && <Field label="Model"><Input value={form.model} placeholder="the model name from your Anthropic account" onChange={(e) => setF({ ...form, model: e.target.value })} /></Field>}
          <Field label={form.kind === "HTTP" ? "Service address (https)" : "Gateway address (optional)"} className="sm:col-span-2"><Input value={form.url} placeholder={form.kind === "HTTP" ? "https://" : "Leave empty to use Anthropic directly"} onChange={(e) => setF({ ...form, url: e.target.value })} /></Field>
          <Field label={c.hasKey ? `Key (saved, ends ${c.keyLast4}); leave empty to keep it` : "Key"} className="sm:col-span-2"><Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setF({ ...form, apiKey: e.target.value })} /></Field>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.ack} onChange={(e) => setF({ ...form, ack: e.target.checked })} /><span>I confirm that our agreement with this provider allows us to send de-identified visit details (age, sex, allergies, diagnoses, medicines, complaints) to it for drafting.</span></label>
        <ErrorNote error={save.error ?? test.error ?? off.error ?? toggle.error} />
        {c.lastTest && <Notice tone={c.lastTest.ok ? "success" : "error"}>{c.lastTest.message}</Notice>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={form.kind === "HTTP" ? form.url.trim().length < 8 : form.model.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
          <Button variant="secondary" disabled={!c.connected} loading={test.isPending} onClick={() => test.mutate()}>Test the connection</Button>
          {c.connected && <ConfirmButton label="Disconnect" confirmLabel="Yes, remove the connection" onConfirm={() => off.mutate()} />}
        </div>
        <p className="mt-2 text-xs text-slate-500">Changing the provider or its address asks for the key, the confirmation and a new test again.</p>
      </Card>
    </div>
  );
}

/** On the visit page, for doctors: ask for a draft, edit it, and say what was done with it. Nothing is put on the chart: the doctor copies what they choose. */
export function AiAssist({ encounterId }: { encounterId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["ai-status"], queryFn: () => api.get<{ available: boolean; reason: string | null }>("/ai/status"), enabled: can("AI_USE"), staleTime: 60_000 });
  const drafts = useQuery({ queryKey: ["ai-drafts", encounterId], queryFn: () => api.get<Draft[]>(`/encounters/${encounterId}/ai/drafts`), enabled: can("AI_USE") && status.data?.available === true });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["ai-drafts", encounterId] }); };
  const ask = useMutation({ mutationFn: (task: string) => api.post(`/encounters/${encounterId}/ai/drafts`, { task }), onSuccess: refresh });
  const review = useMutation({ mutationFn: (a: { id: string; decision: "USED" | "DISCARDED"; edited?: boolean }) => api.post(`/ai/drafts/${a.id}/review`, { decision: a.decision, ...(a.edited ? { edited: true } : {}) }), onSuccess: refresh });
  if (!can("AI_USE") || !status.data?.available) return null;
  return (
    <Card title="AI assistant: drafts for you to check">
      <Notice>These are drafts, not advice. Read and change them before you use any of it. The assistant never diagnoses or prescribes, and nothing is added to the record unless you copy it into the note yourself.</Notice>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" loading={ask.isPending && ask.variables === "HISTORY_SUMMARY"} onClick={() => ask.mutate("HISTORY_SUMMARY")}>Summarise earlier visits</Button>
        <Button variant="secondary" loading={ask.isPending && ask.variables === "VISIT_ADVICE"} onClick={() => ask.mutate("VISIT_ADVICE")}>Draft advice for this visit</Button>
      </div>
      <ErrorNote error={ask.error ?? review.error} />
      <div className="mt-3 space-y-3">
        {drafts.data?.map((d) => {
          const text = edits[d.id] ?? d.text;
          return (
            <div key={d.id} className="rounded-md border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-slate-500"><span className="font-medium text-slate-700">{TASK[d.task] ?? d.task}</span><Badge tone={d.status === "DRAFT" ? "amber" : d.status === "USED" ? "green" : "gray"}>{d.status === "DRAFT" ? "AI draft" : d.status.toLowerCase()}</Badge></div>
              {d.status === "DRAFT" ? (
                <>
                  <Textarea rows={6} aria-label="AI draft" value={text} onChange={(e) => setEdits({ ...edits, [d.id]: e.target.value })} />
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => { void navigator.clipboard?.writeText(text); review.mutate({ id: d.id, decision: "USED", edited: text !== d.text }); }}>Copy and mark as used</Button>
                    <Button variant="secondary" onClick={() => review.mutate({ id: d.id, decision: "DISCARDED" })}>Discard</Button>
                  </div>
                </>
              ) : <p className="whitespace-pre-wrap text-sm text-slate-600">{d.text}</p>}
            </div>
          );
        })}
        {drafts.data?.length === 0 && <p className="text-sm text-slate-500">No drafts for this visit yet.</p>}
      </div>
    </Card>
  );
}
