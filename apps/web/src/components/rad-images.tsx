"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "@/lib/api";
import { defaultWindow, parseDicom, toRgba, type DicomImage } from "@/lib/dicom";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Spinner } from "./ui";

interface ImageRow { id: string; fileName: string; contentType: string; sizeBytes: number; description: string | null; uploadedAt: string }

const MAX_BYTES = 10 * 1024 * 1024;
export const imageUrl = (id: string, download = false) => `/api/proxy/rad/images/${id}/content${download ? "?download=1" : ""}`;
const kind = (c: string) => (c === "application/dicom" ? "DICOM" : c === "image/png" ? "PNG" : "JPEG");
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A viewer for one image: zoom, pan, rotate, invert and brightness/contrast (window and level for a DICOM slice). It is for looking, not for diagnosing: no measurements. */
function Viewer({ image, onClose }: { image: ImageRow; onClose: () => void }) {
  const [state, setState] = useState<{ loading: true } | { loading: false; error: string } | { loading: false; error: null; blob: Blob; dicom: DicomImage | null; note: string | null }>({ loading: true });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotate, setRotate] = useState(0);
  const [invert, setInvert] = useState(false);
  const [center, setCenter] = useState(0);
  const [width, setWidth] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(imageUrl(image.id), { credentials: "same-origin" });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "The image could not be opened.");
        const blob = await res.blob();
        let dicom: DicomImage | null = null, note: string | null = null;
        if (image.contentType === "application/dicom") {
          const parsed = parseDicom(await blob.arrayBuffer());
          if (parsed.ok) { dicom = parsed.image; const w = defaultWindow(parsed.image); setCenter(w.center); setWidth(w.width); if (parsed.image.frames > 1) note = `This file has ${parsed.image.frames} frames; the first is shown.`; } else note = parsed.reason;
        }
        if (!cancelled) setState({ loading: false, error: null, blob, dicom, note });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: errorText(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [image.id, image.contentType]);

  const ready = !state.loading && state.error === null ? state : null;
  const dicom = ready?.dicom ?? null;
  const url = useMemo(() => (ready && !ready.dicom && image.contentType !== "application/dicom" ? URL.createObjectURL(ready.blob) : null), [ready, image.contentType]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  useEffect(() => {
    if (!dicom || !canvas.current) return;
    const c = canvas.current;
    c.width = dicom.cols; c.height = dicom.rows;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(toRgba(dicom, center, width, invert) as unknown as Uint8ClampedArray<ArrayBuffer>, dicom.cols, dicom.rows), 0, 0);
  }, [dicom, center, width, invert]);

  const transform = `translate(${pan.x}px, ${pan.y}px) rotate(${rotate}deg) scale(${zoom})`;
  const filter = dicom ? undefined : `brightness(${brightness}%) contrast(${contrast}%) ${invert ? "invert(1)" : ""}`;
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); setRotate(0); setInvert(false); setBrightness(100); setContrast(100); if (dicom) { const w = defaultWindow(dicom); setCenter(w.center); setWidth(w.width); } };
  const showable = !!url || !!dicom;

  return (
    <Modal title={`${image.fileName}${image.description ? `: ${image.description}` : ""}`} onClose={onClose} wide>
      {state.loading ? <Spinner /> : state.error !== null ? <Notice tone="error">{state.error}</Notice> : (
        <div className="space-y-3">
          {state.note && <Notice tone="warn">{state.note}</Notice>}
          {showable ? (
            <>
              <div
                className="relative flex h-[60vh] touch-none select-none items-center justify-center overflow-hidden rounded-md bg-black"
                onWheel={(e) => setZoom((z) => Math.min(8, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))}
                onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; }}
                onPointerMove={(e) => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); }}
                onPointerUp={() => { drag.current = null; }}
                role="img" aria-label={`Image ${image.fileName}`}
              >
                {dicom
                  ? <canvas ref={canvas} className="max-h-full max-w-full" style={{ transform, imageRendering: zoom > 2 ? "pixelated" : "auto" }} />
                  : <img src={url ?? undefined} alt={image.fileName} draggable={false} className="max-h-full max-w-full" style={{ transform, filter, imageRendering: zoom > 2 ? "pixelated" : "auto" }} />}
              </div>
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>Zoom in</Button>
                  <Button variant="secondary" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>Zoom out</Button>
                  <Button variant="secondary" onClick={() => setRotate((r) => (r + 90) % 360)}>Rotate</Button>
                  <Button variant="secondary" onClick={() => setInvert((v) => !v)}>Invert</Button>
                  <Button variant="secondary" onClick={reset}>Reset</Button>
                  <span className="text-slate-500">{Math.round(zoom * 100)}%</span>
                </div>
                {dicom ? (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2">Level <input aria-label="Window level" type="range" min={Math.floor(dicom.min)} max={Math.ceil(dicom.max)} value={center} onChange={(e) => setCenter(Number(e.target.value))} className="flex-1" /> <span className="w-14 text-right text-slate-500">{Math.round(center)}</span></label>
                    <label className="flex items-center gap-2">Window <input aria-label="Window width" type="range" min={1} max={Math.max(2, Math.ceil(dicom.max - dicom.min) * 2)} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="flex-1" /> <span className="w-14 text-right text-slate-500">{Math.round(width)}</span></label>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2">Brightness <input aria-label="Brightness" type="range" min={30} max={250} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} className="flex-1" /></label>
                    <label className="flex items-center gap-2">Contrast <input aria-label="Contrast" type="range" min={30} max={300} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} className="flex-1" /></label>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">Drag to move, scroll to zoom. This viewer is for looking at the image; it has no measurements. Diagnosis is made from the signed report and the original study.</p>
            </>
          ) : <Notice tone="info">This file cannot be shown here. Download it to open it in a DICOM viewer.</Notice>}
          <div><a className="text-sm text-brand-700 hover:underline" href={imageUrl(image.id, true)}>Download the original file</a></div>
        </div>
      )}
    </Modal>
  );
}

/** The images of one study: the radiographer adds and removes them (PNG, JPEG or a single DICOM slice, up to 10 MB each); everyone who may read the study can open them. */
export function RadImagesCard({ studyId, canManage }: { studyId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ImageRow | null>(null);
  const [removing, setRemoving] = useState<ImageRow | null>(null);
  const [reason, setReason] = useState("");
  const list = useQuery({ queryKey: ["rad-images", studyId], queryFn: () => api.get<ImageRow[]>(`/rad/studies/${studyId}/images`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["rad-images", studyId] });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const lower = file.name.toLowerCase();
      const type = file.type === "image/png" || file.type === "image/jpeg" ? file.type : lower.endsWith(".dcm") || file.type === "application/dicom" ? "application/dicom" : "";
      if (!type) throw new Error("Choose a PNG or JPEG image, or a DICOM (.dcm) file.");
      if (file.size > MAX_BYTES) throw new Error("The file is larger than 10 MB.");
      const q = new URLSearchParams({ filename: file.name, ...(description.trim().length >= 2 ? { description: description.trim() } : {}) });
      const res = await fetch(`/api/proxy/rad/studies/${studyId}/images?${q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": type, "x-medos-csrf": "1" }, body: file });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }; throw new Error(j.error?.message ?? "Upload failed"); }
    },
    onSuccess: async () => { setDescription(""); setError(null); if (input.current) input.current.value = ""; await refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({ mutationFn: () => api.post(`/rad/images/${removing!.id}/remove`, { reason: reason.trim() }), onSuccess: async () => { setRemoving(null); setReason(""); await refresh(); } });

  return (
    <Card title="Images">
      {list.isLoading ? <Spinner /> : (
        <div className="space-y-3">
          {(list.data?.length ?? 0) === 0 ? <p className="text-sm text-slate-500">No images attached to this study.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {list.data?.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div><button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen(i)}>{i.fileName}</button> <Badge tone="gray">{kind(i.contentType)}</Badge> <span className="text-xs text-slate-500">{size(i.sizeBytes)}{i.description ? ` · ${i.description}` : ""}</span></div>
                  <div className="flex gap-2"><Button variant="secondary" onClick={() => setOpen(i)}>View</Button>{canManage && <Button variant="secondary" onClick={() => { remove.reset(); setReason(""); setRemoving(i); }}>Remove</Button>}</div>
                </li>
              ))}
            </ul>
          )}
          {removing && (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <Notice tone="warn">Remove {removing.fileName}? It stops showing but stays on the record with your name and reason.</Notice>
              <Field label="Reason" hint="At least 5 characters"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <ErrorNote error={remove.error} />
              <div className="flex gap-2"><Button variant="danger" loading={remove.isPending} disabled={reason.trim().length < 5} onClick={() => remove.mutate()}>Remove image</Button><Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button></div>
            </div>
          )}
          {canManage && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <p className="text-sm font-medium">Add an image</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="What it shows (optional)" className="min-w-52 flex-1"><Input value={description} placeholder="e.g. PA view" onChange={(e) => setDescription(e.target.value)} /></Field>
                <input ref={input} type="file" aria-label="Choose an image" accept="image/png,image/jpeg,.dcm,application/dicom" className="text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setError(null); upload.mutate(f); } }} />
              </div>
              {upload.isPending && <p className="text-sm text-slate-500">Uploading…</p>}
              {error && <Notice tone="error">{error}</Notice>}
              <p className="text-xs text-slate-500">PNG, JPEG or one DICOM slice, up to 10 MB each, 20 per study. Whole CT or MRI series are not kept here.</p>
            </div>
          )}
        </div>
      )}
      {open && <Viewer image={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
