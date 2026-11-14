"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newKey, printUrl } from "@/lib/api";
import { useMe } from "@/lib/me";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, Table, Td, Textarea, useDebounced } from "./ui";
import { PrintLink } from "@/components/print-link";

interface WorkItem { testOrderId: string; test: string; state: string; accessionNumber: string | null; patient: string; mrn: string | null; visitNumber: string | null; critical: boolean }
interface Param { id: string; name: string; unit: string | null; type: string; rangeText: string; choices?: string[]; decimals?: number }
interface Value { parameterId: string; name: string; unit: string | null; value: string; flag: string; rangeText: string }
interface ResultView {
  testOrderId: string; test: string; patient: { name: string; gender: string; mrn: string | null };
  sample: { id: string; accessionNumber: string; specimen: string; status: string } | null;
  resultId: string | null; status: string | null; version: number | null; currentVersion: number; hasCritical: boolean; criticalAcknowledged: boolean;
  parameters: Param[]; draft: { values: { parameterId: string; value: string }[]; comment: string };
  reports: { version: number; kind: string; values: Value[]; reason: string | null; verifiedBy: string | null }[];
}
interface Critical { resultId: string; test: string; patient: string; mrn: string | null; doctor: string | null; visitNumber: string | null }
interface LabTest { serviceId: string; name: string; code: string; definition: { specimen: string; turnaroundHours: number | null; parameters: { id: string; name: string; unit: string | null; type: string; decimals: number; low?: string | null; high?: string | null }[] } | null }

const STATE_LABEL: Record<string, string> = { WAITING_SAMPLE: "Waiting for sample", SAMPLE_TAKEN: "Sample taken", REPORTED: "Reported" };
const FLAG_TONE: Record<string, "green" | "amber" | "red"> = { NORMAL: "green", LOW: "amber", HIGH: "amber", CRITICAL_LOW: "red", CRITICAL_HIGH: "red" };

/** Type in the values, save, and (for a pathologist) verify; a verified report can be printed or amended with a reason. */
function ResultModal({ testOrderId, onClose }: { testOrderId: string; onClose: () => void }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ["lab-result", testOrderId], queryFn: () => api.get<ResultView>(`/lab/orders/${testOrderId}/result`) });
  const [vals, setVals] = useState<Record<string, string> | null>(null);
  const [reason, setReason] = useState("");
  const [amending, setAmending] = useState(false);
  const data = r.data;
  const current = vals ?? Object.fromEntries((data?.draft.values ?? []).map((v) => [v.parameterId, v.value]));
  const refresh = () => { setVals(null); void qc.invalidateQueries({ queryKey: ["lab-result", testOrderId] }); void qc.invalidateQueries({ queryKey: ["lab-work"] }); void qc.invalidateQueries({ queryKey: ["lab-critical"] }); };
  const body = () => Object.entries(current).filter(([, v]) => v.trim() !== "").map(([parameterId, value]) => ({ parameterId, value }));
  const save = useMutation({ mutationFn: () => api.put<{ version: number }>(`/lab/results/${data!.resultId}/draft`, { version: data!.version, values: body() }), onSuccess: refresh });
  const verify = useMutation({
    mutationFn: async () => { const d = await api.put<{ version: number }>(`/lab/results/${data!.resultId}/draft`, { version: data!.version, values: body() }); return api.post(`/lab/results/${data!.resultId}/verify`, { version: d.version }, newKey()); },
    onSuccess: refresh,
  });
  const amend = useMutation({ mutationFn: () => api.post(`/lab/results/${data!.resultId}/amend`, { expectedVersion: data!.currentVersion, reason, values: body() }, newKey()), onSuccess: () => { setAmending(false); setReason(""); refresh(); } });
  const sample = useMutation({ mutationFn: () => api.post(`/lab/orders/${testOrderId}/sample`, {}, newKey()), onSuccess: refresh });
  const reported = data?.status === "VERIFIED";
  const latest = data?.reports[0];
  return (
    <Modal title={data ? `${data.test}: ${data.patient.name}` : "Lab result"} onClose={onClose} wide>
      {r.isLoading || !data ? <Spinner /> : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{data.patient.mrn} · {data.patient.gender.toLowerCase()} {data.sample ? `· sample ${data.sample.accessionNumber} (${data.sample.specimen})` : ""}</p>
          {(!data.sample || data.sample.status !== "COLLECTED") && !reported && (
            <div className="space-y-2">
              <Notice tone="warn">{data.sample?.status === "REJECTED" ? "The last sample was rejected. Take a new sample before entering results." : "No sample has been taken yet."}</Notice>
              <ErrorNote error={sample.error} />
              {can("LAB_COLLECT") && <Button loading={sample.isPending} onClick={() => sample.mutate()}>Take sample</Button>}
            </div>
          )}
          {data.hasCritical && <Notice tone="error">A critical value was reported{data.criticalAcknowledged ? " and the doctor has acknowledged it." : ": the doctor must acknowledge it."}</Notice>}
          {reported && latest && !amending ? (
            <Table head={["Test", "Result", "Unit", "Reference", "Flag"]}>
              {latest.values.map((v) => <tr key={v.parameterId}><Td>{v.name}</Td><Td className="font-medium">{v.value}</Td><Td>{v.unit ?? ""}</Td><Td>{v.rangeText}</Td><Td><Badge tone={FLAG_TONE[v.flag] ?? "gray"}>{v.flag.replace("_", " ").toLowerCase()}</Badge></Td></tr>)}
            </Table>
          ) : data.sample?.status === "COLLECTED" || amending ? (
            <Table head={["Test", "Result", "Unit", "Reference"]}>
              {data.parameters.map((p) => (
                <tr key={p.id}>
                  <Td>{p.name}</Td>
                  <Td>{p.type === "CHOICE" ? <Select aria-label={p.name} value={current[p.id] ?? ""} onChange={(e) => setVals({ ...current, [p.id]: e.target.value })}><option value="">—</option>{p.choices?.map((c) => <option key={c}>{c}</option>)}</Select>
                    : <Input aria-label={p.name} className="w-40" value={current[p.id] ?? ""} onChange={(e) => setVals({ ...current, [p.id]: e.target.value })} />}</Td>
                  <Td>{p.unit ?? ""}</Td><Td>{p.rangeText}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
          <ErrorNote error={save.error ?? verify.error ?? amend.error} />
          {data.reports.length > 1 && <p className="text-xs text-slate-500">This report was amended {data.reports.length - 1} time(s); earlier versions are kept. Latest reason: {data.reports[0]?.reason}</p>}
          <div className="flex flex-wrap gap-2">
            {!reported && data.sample?.status === "COLLECTED" && can("LAB_RESULT") && <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>Save draft</Button>}
            {!reported && data.sample?.status === "COLLECTED" && can("LAB_VERIFY") && <Button loading={verify.isPending} onClick={() => verify.mutate()}>Verify and release</Button>}
            {reported && can("LAB_VERIFY") && !amending && <Button variant="secondary" onClick={() => { setAmending(true); setVals(Object.fromEntries(latest!.values.map((v) => [v.parameterId, v.value]))); }}>Amend</Button>}
            {reported && <PrintLink className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`lab-reports/${testOrderId}`)}>Print report</PrintLink>}
            {data.sample && <PrintLink className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" href={printUrl(`lab-labels/${data.sample.id}`)}>Print sample label</PrintLink>}
          </div>
          {amending && (
            <div className="space-y-2">
              <Field label="Reason for the correction"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button disabled={reason.trim().length < 5} loading={amend.isPending} onClick={() => amend.mutate()}>Save amended report</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function LabWorklist() {
  const [state, setState] = useState("");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["lab-work", state, term], queryFn: () => api.get<{ items: WorkItem[] }>("/lab/worklist", { ...(state ? { state } : {}), ...(term.length >= 2 ? { q: term } : {}), pageSize: 50 }), refetchInterval: 20_000 });
  return (
    <Card title="Work list">
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Show" className="w-52" value={state} onChange={(e) => setState(e.target.value)}><option value="">All tests</option><option value="WAITING_SAMPLE">Waiting for sample</option><option value="SAMPLE_TAKEN">Sample taken</option><option value="REPORTED">Reported</option></Select>
        <Input aria-label="Search" className="min-w-60 flex-1" placeholder="Search name, MRN or sample number" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Patient", "Test", "Sample no.", "Status", ""]} {...(list.data?.items.length === 0 ? { empty: "No tests here." } : {})}>
          {list.data?.items.map((i) => (
            <tr key={i.testOrderId}>
              <Td><span className="font-medium">{i.patient}</span> <span className="text-slate-500">· {i.mrn}</span></Td><Td>{i.test}</Td><Td>{i.accessionNumber ?? "—"}</Td>
              <Td><Badge tone={i.state === "REPORTED" ? "green" : i.state === "SAMPLE_TAKEN" ? "blue" : "gray"}>{STATE_LABEL[i.state] ?? i.state}</Badge>{i.critical && <> <Badge tone="red">critical</Badge></>}</Td>
              <Td><Button variant="secondary" onClick={() => setOpen(i.testOrderId)}>{i.state === "WAITING_SAMPLE" ? "Take sample" : i.state === "REPORTED" ? "View" : "Enter results"}</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {open && <ResultModal testOrderId={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

export function LabCritical() {
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["lab-critical"], queryFn: () => api.get<Critical[]>("/lab/critical"), refetchInterval: 20_000 });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/lab/results/${id}/acknowledge`, {}, newKey()), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lab-critical"] }); } });
  return (
    <Card title="Critical results waiting for the doctor">
      <ErrorNote error={ack.error} />
      <Table head={["Patient", "Test", "Doctor", ""]} {...(list.data?.length === 0 ? { empty: "No critical results are waiting." } : {})}>
        {list.data?.map((c) => <tr key={c.resultId}><Td><span className="font-medium">{c.patient}</span> <span className="text-slate-500">· {c.mrn}</span></Td><Td>{c.test}</Td><Td>{c.doctor ?? "—"}</Td>
          <Td>{can("LAB_READ") && <Button variant="secondary" loading={ack.isPending && ack.variables === c.resultId} onClick={() => ack.mutate(c.resultId)}>Acknowledge</Button>}</Td></tr>)}
      </Table>
    </Card>
  );
}

export function LabTests() {
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["lab-tests"], queryFn: () => api.get<LabTest[]>("/lab/tests") });
  const [edit, setEdit] = useState<LabTest | null>(null);
  const [specimen, setSpecimen] = useState("");
  const [hours, setHours] = useState("");
  const [rows, setRows] = useState<{ name: string; unit: string; low: string; high: string }[]>([]);
  const start = (t: LabTest) => {
    setEdit(t); setSpecimen(t.definition?.specimen ?? "Blood"); setHours(t.definition?.turnaroundHours ? String(t.definition.turnaroundHours) : "");
    setRows(t.definition?.parameters.map((p) => ({ name: p.name, unit: p.unit ?? "", low: p.low ?? "", high: p.high ?? "" })) ?? [{ name: t.name, unit: "", low: "", high: "" }]);
  };
  const save = useMutation({
    mutationFn: () => api.put(`/lab/tests/${edit!.serviceId}`, {
      specimen, ...(hours ? { turnaroundHours: Number(hours) } : {}),
      parameters: rows.filter((r) => r.name.trim()).map((r) => {
        const numeric = r.low !== "" || r.high !== "";
        return { name: r.name.trim(), ...(r.unit ? { unit: r.unit } : {}), type: numeric ? "NUMERIC" : "TEXT", decimals: numeric ? 1 : 0, ...(r.low !== "" ? { low: Number(r.low) } : {}), ...(r.high !== "" ? { high: Number(r.high) } : {}) };
      }),
    }),
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ["lab-tests"] }); },
  });
  return (
    <Card title="Tests, specimens and normal ranges">
      {list.isLoading ? <Spinner /> : (
        <Table head={["Test", "Specimen", "Measures", ""]} {...(list.data?.length === 0 ? { empty: "Add investigations to the service catalogue first." } : {})}>
          {list.data?.map((t) => <tr key={t.serviceId}><Td>{t.name}</Td><Td>{t.definition?.specimen ?? "—"}</Td><Td>{t.definition ? t.definition.parameters.map((p) => p.name).join(", ") : <span className="text-slate-500">one typed result</span>}</Td>
            <Td>{can("LAB_MASTERS") && <Button variant="secondary" onClick={() => start(t)}>Set up</Button>}</Td></tr>)}
        </Table>
      )}
      {edit && (
        <Modal title={`Set up ${edit.name}`} onClose={() => setEdit(null)} wide>
          <div className="space-y-3">
            <div className="flex gap-2"><Field label="Specimen" className="flex-1"><Input value={specimen} onChange={(e) => setSpecimen(e.target.value)} /></Field><Field label="Report within (hours)"><Input className="w-32" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9]/g, ""))} /></Field></div>
            <Table head={["What is measured", "Unit", "Normal from", "Normal to"]}>
              {rows.map((r, i) => <tr key={i}>{(["name", "unit", "low", "high"] as const).map((k) => <Td key={k}><Input aria-label={`${k} ${i + 1}`} value={r[k]} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} /></Td>)}</tr>)}
            </Table>
            <Button variant="secondary" onClick={() => setRows([...rows, { name: "", unit: "", low: "", high: "" }])}>Add a line</Button>
            <ErrorNote error={save.error} />
            <div><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** The doctor's view of the laboratory tests of one visit: where each stands, the values once reported, and acknowledging a critical result. */
export function VisitLabResults({ encounterId }: { encounterId: string }) {
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["visit-lab", encounterId], queryFn: () => api.get<{ testOrderId: string; test: string; state: string; accessionNumber: string | null; resultId: string | null; critical: boolean; amended: boolean; report: { values: Value[] } | null }[]>(`/encounters/${encounterId}/lab-results`), enabled: can("LAB_READ"), refetchInterval: 30_000 });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/lab/results/${id}/acknowledge`, {}, newKey()), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["visit-lab", encounterId] }); } });
  if (!can("LAB_READ") || !q.data || q.data.length === 0) return null;
  return (
    <Card title="Laboratory results">
      <ErrorNote error={ack.error} />
      <div className="space-y-3">
        {q.data.map((o) => (
          <div key={o.testOrderId}>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{o.test}</span><Badge tone={o.state === "REPORTED" ? "green" : "gray"}>{STATE_LABEL[o.state] ?? o.state}</Badge>{o.amended && <Badge tone="amber">amended</Badge>}
              {o.critical && o.resultId && <Button variant="secondary" loading={ack.isPending} onClick={() => ack.mutate(o.resultId!)}>Critical: acknowledge</Button>}
              {o.state === "REPORTED" && <PrintLink className="text-brand-700" href={printUrl(`lab-reports/${o.testOrderId}`)}>Print report</PrintLink>}</div>
            {o.report && <Table head={["Test", "Result", "Reference", "Flag"]}>{o.report.values.map((v) => <tr key={v.parameterId}><Td>{v.name}</Td><Td className="font-medium">{v.value} {v.unit ?? ""}</Td><Td>{v.rangeText}</Td><Td><Badge tone={FLAG_TONE[v.flag] ?? "gray"}>{v.flag.replace("_", " ").toLowerCase()}</Badge></Td></tr>)}</Table>}
          </div>
        ))}
      </div>
    </Card>
  );
}
