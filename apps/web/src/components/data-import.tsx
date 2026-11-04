"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, ErrorNote, Select, Spinner, Table, Td } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type Kind = "patients" | "medicines" | "opening-stock" | "services";
interface Description { kind: Kind; label: string; maxRows: number; maxMegabytes: number; columns: { name: string; required?: boolean; description: string; example: string }[]; notes: string[] }
interface RowResult { row: number; status: "CREATED" | "WOULD_CREATE" | "SKIPPED" | "ERROR"; message: string | null; ref: string | null }
interface Report { kind: Kind; dryRun: boolean; rows: number; created: number; wouldCreate: number; skipped: number; failed: number; results: RowResult[] }

const KINDS: { id: Kind; label: string }[] = [
  { id: "services", label: "Service price list" }, { id: "medicines", label: "Medicine list" }, { id: "opening-stock", label: "Opening stock (medicine batches)" }, { id: "patients", label: "Patients" },
];
const TONE = { CREATED: "green", WOULD_CREATE: "blue", SKIPPED: "amber", ERROR: "red" } as const;
const WORDS = { CREATED: "Imported", WOULD_CREATE: "Ready", SKIPPED: "Skipped", ERROR: "Problem" } as const;

/** Sends the file as the raw request body, the same way the patient file upload does. */
async function send(kind: Kind, file: File, dryRun: boolean, sharedMobile: boolean): Promise<Report> {
  const q = new URLSearchParams({ dryRun: String(dryRun), ...(kind === "patients" ? { sharedMobile: sharedMobile ? "import" : "skip" } : {}) });
  const res = await fetch(`/api/proxy/imports/${kind}?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "text/csv", "x-medos-csrf": "1" }, body: await file.arrayBuffer() });
  const json = (await res.json().catch(() => ({}))) as { data?: Report; error?: { code: string; message: string } };
  if (!res.ok || !json.data) throw new ApiError(res.status, json.error?.code ?? "ERROR", json.error?.message ?? "The file could not be read");
  return json.data;
}

export function DataImport() {
  const [kind, setKind] = useState<Kind>("services");
  const [file, setFile] = useState<File | null>(null);
  const [shared, setShared] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const desc = useQuery({ queryKey: ["import-desc", kind], queryFn: () => api.get<Description>(`/imports/${kind}`) });
  const run = useMutation({ mutationFn: (dryRun: boolean) => send(kind, file as File, dryRun, shared), onSuccess: setReport, onError: () => setReport(null) });

  const reset = () => { setFile(null); setReport(null); run.reset(); };
  const template = () => {
    const url = URL.createObjectURL(new Blob([`${desc.data?.columns.map((c) => c.name).join(",") ?? ""}\r\n`], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${kind}-template.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const preview = report?.dryRun === true;
  const shown = report?.results.filter((r) => r.status !== "WOULD_CREATE" && r.status !== "CREATED" || r.message).slice(0, 200) ?? [];

  return (
    <div className="space-y-4">
      <Card title="Import from a spreadsheet">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">What to import
            <Select aria-label="What to import" value={kind} onChange={(e) => { setKind(e.target.value as Kind); reset(); }}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select>
          </label>
          <label className="text-sm">CSV file
            <input aria-label="CSV file" type="file" accept=".csv,text/csv" className="mt-1 block w-full text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); run.reset(); }} />
          </label>
          <div className="flex items-end gap-2">
            <Button variant="secondary" onClick={template} disabled={!desc.data}>Download empty template</Button>
          </div>
        </div>
        {kind === "patients" && (
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => { setShared(e.target.checked); setReport(null); }} />Import patients who only share a mobile number with someone already registered (families)</label>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button loading={run.isPending && run.variables === true} disabled={!file || run.isPending} onClick={() => run.mutate(true)}>Check the file</Button>
          {preview && report.wouldCreate > 0 && (
            <Button variant="secondary" loading={run.isPending && run.variables === false} disabled={run.isPending} onClick={() => run.mutate(false)}>Import {report.wouldCreate} row{report.wouldCreate === 1 ? "" : "s"}</Button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">Checking the file saves nothing. Rows with problems are never imported; you can fix them and upload the file again, rows already imported are skipped.</p>
        <ErrorNote error={run.error} />
      </Card>

      {report && (
        <Card title={report.dryRun ? "Check result (nothing saved yet)" : "Import finished"}>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Badge tone="gray">{report.rows} rows</Badge>
            <Badge tone="green">{report.dryRun ? `${report.wouldCreate} ready` : `${report.created} imported`}</Badge>
            <Badge tone="amber">{report.skipped} skipped</Badge>
            <Badge tone="red">{report.failed} with problems</Badge>
          </div>
          {shown.length > 0 && (
            <Table head={["Row", "Result", "Details"]}>
              {shown.map((r) => <tr key={r.row}><Td>{r.row}</Td><Td><Badge tone={TONE[r.status]}>{WORDS[r.status]}</Badge></Td><Td>{[r.ref, r.message].filter(Boolean).join(" · ")}</Td></tr>)}
            </Table>
          )}
          {report.results.length > 200 && <p className="mt-2 text-xs text-slate-500">Showing the first 200 rows that need attention.</p>}
          {!report.dryRun && <div className="mt-3"><Button variant="secondary" onClick={reset}>Import another file</Button></div>}
        </Card>
      )}

      <Card title="Columns">
        {desc.isLoading ? <Spinner /> : desc.data && (
          <div className="space-y-2 text-sm">
            <ul className="list-disc space-y-1 pl-5 text-slate-600">{desc.data.notes.map((n) => <li key={n}>{n}</li>)}<li>Up to {desc.data.maxRows} rows and {desc.data.maxMegabytes} MB per file. Save from Excel as “CSV UTF-8 (comma delimited)”.</li></ul>
            <Table head={["Column", "Needed", "What to write", "Example"]}>
              {desc.data.columns.map((c) => <tr key={c.name}><Td><code>{c.name}</code></Td><Td>{c.required ? "Yes" : "No"}</Td><Td>{c.description}</Td><Td>{c.example}</Td></tr>)}
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
