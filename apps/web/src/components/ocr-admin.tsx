"use client";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Field, Input, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";

interface OcrView {
  source: "FACILITY" | "SERVER" | "NONE"; apiUrl: string | null; hasKey: boolean; keyLast4: string | null; timeoutMs: number;
  lastTest: { at: string; ok: boolean; message: string | null } | null; serverDefaultConnected: boolean; canStoreKey: boolean;
}

/** Handwritten prescription upload, reading with OCR, and the connection to the OCR service. The key is write-only: it is never shown again after saving. */
export function PrescriptionUploadSettings({ flag }: { flag: (key: string, label: string) => ReactNode }) {
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const cfg = useQuery({ queryKey: ["ocr-config"], queryFn: () => api.get<OcrView>("/ocr/config") });
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [seconds, setSeconds] = useState<string | null>(null);
  const [removeKey, setRemoveKey] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; message: string } | null>(null);
  const v = cfg.data;
  const shownUrl = url ?? v?.apiUrl ?? "";
  const shownSeconds = seconds ?? String(Math.round((v?.timeoutMs ?? 20_000) / 1000));
  const secs = Number(shownSeconds);
  const valid = shownUrl.trim().length >= 8 && Number.isFinite(secs) && secs >= 1 && secs <= 60 && (key === "" || key.length >= 8);
  const refresh = () => qc.invalidateQueries({ queryKey: ["ocr-config"] });
  const save = useMutation({
    mutationFn: () => api.put<OcrView>("/ocr/config", { apiUrl: shownUrl.trim(), timeoutMs: Math.round(secs * 1000), ...(key ? { apiKey: key } : removeKey ? { clearKey: true } : {}) }),
    onSuccess: async () => { setKey(""); setUrl(null); setSeconds(null); setRemoveKey(false); setTestNote(null); await refresh(); },
  });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>("/ocr/config/test"), onSuccess: async (r) => { setTestNote({ ok: r.ok, message: r.message }); await refresh(); }, onError: () => setTestNote(null) });
  const disconnect = useMutation({ mutationFn: () => api.post("/ocr/config/disconnect"), onSuccess: async () => { setUrl(null); setKey(""); setTestNote(null); await refresh(); } });
  const dirty = url !== null || key !== "" || seconds !== null || removeKey;
  return (
    <Card title="Handwritten prescriptions and OCR" actions={v ? <Badge tone={v.source === "NONE" ? "gray" : "green"}>{v.source === "FACILITY" ? "service connected" : v.source === "SERVER" ? "server default service" : "no service connected"}</Badge> : undefined}>
      <div className="grid gap-2 sm:grid-cols-2">
        {flag("PRESCRIPTION_UPLOAD_ENABLED", "Doctors can upload a photo or PDF of a handwritten prescription after the consultation")}
        {flag("PRESCRIPTION_OCR_ENABLED", "Read uploaded prescriptions automatically with the OCR service")}
      </div>
      <p className="mt-2 text-xs text-slate-500">What the OCR service reads is only a draft. A doctor checks it, corrects the medicine details and approves it; only then does the prescription reach the pharmacy.</p>

      <h3 className="mt-4 text-sm font-semibold text-slate-700">OCR service</h3>
      {v && !v.canStoreKey && <div className="mt-2"><Notice tone="warn">This server has no encryption key for saved API keys (SECRETS_ENCRYPTION_KEY). You can connect a service that needs no key, but a key cannot be saved until your administrator sets it up.</Notice></div>}
      {v?.source === "SERVER" && <p className="mt-1 text-xs text-slate-500">A service is connected on the server itself and is being used. Saving an address here replaces it for this facility.</p>}
      <form className="mt-2 grid gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <Field label="Service address" className="sm:col-span-4"><Input aria-label="OCR service address" placeholder="https://ocr.example.com/read" value={shownUrl} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Wait up to (seconds)" className="sm:col-span-2"><Input aria-label="OCR timeout seconds" inputMode="numeric" value={shownSeconds} onChange={(e) => setSeconds(e.target.value)} /></Field>
        <Field label={v?.hasKey ? `API key (saved, ends in ${v.keyLast4 ?? "····"}; leave blank to keep)` : "API key (optional)"} className="sm:col-span-4">
          <Input aria-label="OCR API key" type="password" autoComplete="new-password" disabled={removeKey || (v ? !v.canStoreKey : false)} placeholder={v?.hasKey ? "••••••••••••" : "Paste the key from your OCR provider"} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <Button type="submit" loading={save.isPending} disabled={!valid || !dirty}>Save</Button>
          {v?.hasKey && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={removeKey} onChange={(e) => { setRemoveKey(e.target.checked); if (e.target.checked) setKey(""); }} /> Remove saved key</label>}
        </div>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" loading={test.isPending} disabled={!v || v.source === "NONE" || dirty} onClick={() => test.mutate()}>Test connection</Button>
        <Button variant="ghost" loading={disconnect.isPending} disabled={v?.source !== "FACILITY"} onClick={() => { if (window.confirm("Disconnect the OCR service? Uploaded prescriptions will then be typed in by the doctor.")) disconnect.mutate(); }}>Disconnect</Button>
        {dirty && v?.source !== "NONE" && <span className="text-xs text-slate-500">Save your changes before testing.</span>}
      </div>
      {testNote && <div className="mt-2"><Notice tone={testNote.ok ? "success" : "error"}>{testNote.message}</Notice></div>}
      {!testNote && v?.lastTest && <p className="mt-2 text-xs text-slate-500">Last test {dateTime(v.lastTest.at)}: {v.lastTest.ok ? "working" : "failed"}{v.lastTest.message ? `. ${v.lastTest.message}` : ""}</p>}
      <div className="mt-2"><ErrorNote error={save.error ?? test.error ?? disconnect.error} /></div>
      <p className="mt-2 text-xs text-slate-500">The prescription picture is sent to this service and contains patient information: connect only a provider you are allowed to share it with. The key is stored encrypted and is never shown again.</p>
    </Card>
  );
}
