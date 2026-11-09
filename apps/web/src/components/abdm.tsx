"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ConfirmButton, ErrorNote, Field, Input, Notice, Select, Spinner, Table, Td } from "./ui";

interface Capability { name: string; state: string }
interface Config { environment: string; sessionUrl: string | null; clientId: string | null; hfrId: string | null; hasSecret: boolean; secretLast4: string | null; canStoreSecret: boolean; lastTest: { at: string; ok: boolean; message: string | null } | null; capabilities: Capability[] }
interface Abha { id: string; abhaNumber: string; abhaAddress: string | null; recordedAt: string; removedAt: string | null; removeReason: string | null }

const STATE: Record<string, { label: string; tone: "green" | "amber" | "gray" | "red" }> = {
  AVAILABLE: { label: "available", tone: "green" }, TESTED_OK: { label: "tested, works", tone: "green" }, NOT_TESTED: { label: "not tested", tone: "amber" },
  NOT_CONFIGURED: { label: "not set up", tone: "gray" }, NEEDS_SERVER_KEY: { label: "needs a server key", tone: "red" }, NOT_BUILT: { label: "not built yet", tone: "gray" },
};

/** Administration → ABDM: the facility's gateway details (the secret is write-only), a connection test, and what is and is not built. */
export function AbdmAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["abdm-config"], queryFn: () => api.get<Config>("/abdm/config") });
  const [f, setF] = useState<{ environment: string; sessionUrl: string; clientId: string; clientSecret: string; hfrId: string } | null>(null);
  const c = q.data;
  const form = f ?? { environment: c?.environment ?? "SANDBOX", sessionUrl: c?.sessionUrl ?? "", clientId: c?.clientId ?? "", clientSecret: "", hfrId: c?.hfrId ?? "" };
  const refresh = () => { setF(null); void qc.invalidateQueries({ queryKey: ["abdm-config"] }); };
  const save = useMutation({ mutationFn: () => api.put("/abdm/config", { environment: form.environment, sessionUrl: form.sessionUrl.trim(), clientId: form.clientId.trim(), ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), ...(form.hfrId.trim() ? { hfrId: form.hfrId.trim() } : {}) }), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>("/abdm/config/test", {}), onSuccess: refresh });
  const off = useMutation({ mutationFn: () => api.del("/abdm/config"), onSuccess: refresh });
  if (!c) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card title="What is ready">
        <Table head={["Feature", "State"]}>
          {c.capabilities.map((x) => <tr key={x.name}><Td>{x.name}</Td><Td><Badge tone={STATE[x.state]?.tone ?? "gray"}>{STATE[x.state]?.label ?? x.state}</Badge></Td></tr>)}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Verifying an ABHA, linking visits and sharing records need ABDM sandbox credentials and ABDM's current specifications. They are not built, and nothing pretends otherwise.</p>
      </Card>
      <Card title="Connection to the ABDM gateway">
        {!c.canStoreSecret && <Notice tone="warn">The server has no encryption key set, so a client secret cannot be saved. Ask whoever runs the server to set SECRETS_ENCRYPTION_KEY.</Notice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment"><Select value={form.environment} onChange={(e) => setF({ ...form, environment: e.target.value })}><option value="SANDBOX">Sandbox (testing)</option><option value="PRODUCTION">Production</option></Select></Field>
          <Field label="Health Facility Registry id (optional)"><Input value={form.hfrId} onChange={(e) => setF({ ...form, hfrId: e.target.value })} /></Field>
          <Field label="Gateway session address (https)" className="sm:col-span-2"><Input value={form.sessionUrl} placeholder="Copy it from ABDM's current documentation" onChange={(e) => setF({ ...form, sessionUrl: e.target.value })} /></Field>
          <Field label="Client id"><Input value={form.clientId} onChange={(e) => setF({ ...form, clientId: e.target.value })} /></Field>
          <Field label={c.hasSecret ? `Client secret (saved, ends ${c.secretLast4}); leave empty to keep it` : "Client secret"}><Input type="password" autoComplete="off" value={form.clientSecret} onChange={(e) => setF({ ...form, clientSecret: e.target.value })} /></Field>
        </div>
        <ErrorNote error={save.error ?? test.error ?? off.error} />
        {c.lastTest && <Notice tone={c.lastTest.ok ? "success" : "error"}>{c.lastTest.message}</Notice>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={form.sessionUrl.trim().length < 12 || form.clientId.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
          <Button variant="secondary" disabled={!c.hasSecret || !c.sessionUrl} loading={test.isPending} onClick={() => test.mutate()}>Test the connection</Button>
          {c.sessionUrl && <ConfirmButton label="Disconnect" confirmLabel="Yes, remove the details" onConfirm={() => off.mutate()} />}
        </div>
      </Card>
    </div>
  );
}

/** On the patient's chart: the ABHA number staff have recorded. Always shown as recorded, not verified. */
export function AbhaCard({ patientId }: { patientId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["abha", patientId], queryFn: () => api.get<Abha[]>(`/patients/${patientId}/abha`) });
  const [number, setNumber] = useState("");
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState("");
  const refresh = () => { setNumber(""); setAddress(""); setReason(""); void qc.invalidateQueries({ queryKey: ["abha", patientId] }); };
  const add = useMutation({ mutationFn: () => api.post(`/patients/${patientId}/abha`, { abhaNumber: number, ...(address.trim() ? { abhaAddress: address.trim() } : {}) }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.post(`/patients/${patientId}/abha/${id}/remove`, { reason: reason.trim() }), onSuccess: refresh });
  const live = q.data?.find((x) => !x.removedAt);
  const past = q.data?.filter((x) => x.removedAt) ?? [];
  return (
    <Card title="ABHA (Ayushman Bharat Health Account)">
      {q.isLoading ? <Spinner /> : live ? (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{live.abhaNumber}</span>{live.abhaAddress && <span className="text-slate-600">{live.abhaAddress}</span>}<Badge tone="amber">recorded, not verified</Badge></div>
          {can("PATIENT_UPDATE") && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason, if it is wrong" className="min-w-52 flex-1"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button variant="secondary" disabled={reason.trim().length < 5} loading={remove.isPending} onClick={() => remove.mutate(live.id)}>Remove</Button>
            </div>
          )}
        </div>
      ) : can("PATIENT_UPDATE") ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Field label="ABHA number (14 digits)" className="min-w-52 flex-1"><Input inputMode="numeric" placeholder="91-1234-5678-9012" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
            <Field label="ABHA address (optional)" className="min-w-52 flex-1"><Input placeholder="name@abdm" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          </div>
          <Button disabled={number.replace(/\D/g, "").length !== 14} loading={add.isPending} onClick={() => add.mutate()}>Record ABHA</Button>
        </div>
      ) : <p className="text-sm text-slate-500">No ABHA recorded.</p>}
      <ErrorNote error={add.error ?? remove.error} />
      <p className="mt-2 text-xs text-slate-500">This is what the patient told us or showed us. It has not been checked with ABDM. You can find the patient by searching this number.</p>
      {past.length > 0 && <p className="mt-1 text-xs text-slate-500">Earlier, removed: {past.map((p) => `${p.abhaNumber} (${p.removeReason})`).join("; ")}</p>}
    </Card>
  );
}
