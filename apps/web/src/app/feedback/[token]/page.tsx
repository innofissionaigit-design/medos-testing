"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The patient's own feedback form (docs/aftercare.md). Opens from the link in a text message, with no sign-in: how the care was (1 to 5), anything they want to say, and,
 * if something went wrong, what. It shows nothing about the patient. A link works once.
 */
type Phase = "loading" | "form" | "done" | "invalid";

export default function PatientFeedbackPage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [hospital, setHospital] = useState("");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [complain, setComplain] = useState(false);
  const [category, setCategory] = useState("");
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [number, setNumber] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/feedback/${token}`, { cache: "no-store" })
      .then(async (r) => { if (!live) return; if (!r.ok) { setPhase("invalid"); return; } setHospital(((await r.json()) as { data: { hospital: string } }).data.hospital); setPhase("form"); })
      .catch(() => live && setPhase("invalid"));
    return () => { live = false; };
  }, [token]);

  const send = async () => {
    setBusy(true); setError("");
    const body = { rating, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(complain ? { complaint: { category: category.trim(), description: what.trim() } } : {}) };
    const r = await fetch(`/api/feedback/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r) { setError("We could not send this. Please try again."); return; }
    if (r.status === 404) { setPhase("invalid"); return; }
    const out = (await r.json().catch(() => null)) as { data?: { complaintNumber: string | null }; error?: { message: string } } | null;
    if (!r.ok) { setError(out?.error?.message ?? "We could not send this. Please check what you wrote."); return; }
    setNumber(out?.data?.complaintNumber ?? null);
    setPhase("done");
  };

  const shell = (children: React.ReactNode) => <main className="mx-auto max-w-lg p-4"><div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{children}</div></main>;
  if (phase === "loading") return shell(<p className="text-sm text-slate-500">One moment…</p>);
  if (phase === "invalid") return shell(<><h1 className="text-lg font-semibold">This link is not valid</h1><p className="mt-2 text-sm text-slate-600">It may have been used already or have expired. If you would still like to tell us about your care, please call the hospital.</p></>);
  if (phase === "done") return shell(<><h1 className="text-lg font-semibold">Thank you</h1><p className="mt-2 text-sm text-slate-600">Your feedback has reached {hospital}.{number ? ` We have recorded your complaint as ${number} and someone will contact you.` : ""}</p></>);
  return shell(
    <div className="space-y-4">
      <div><h1 className="text-lg font-semibold">How was your care at {hospital}?</h1><p className="mt-1 text-sm text-slate-600">It takes a minute. Please do not write your medical details here.</p></div>
      <div role="radiogroup" aria-label="Rating" className="flex flex-wrap gap-2">
        {[[1, "Poor"], [2, "Fair"], [3, "Good"], [4, "Very good"], [5, "Excellent"]].map(([n, text]) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} onClick={() => setRating(n as number)} className={`rounded-md border px-3 py-2 text-sm ${rating === n ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>{n} · {text}</button>
        ))}
      </div>
      <label className="block text-sm">Anything you would like to tell us (optional)
        <textarea className="mt-1 w-full rounded-md border border-slate-300 p-2" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={complain} onChange={(e) => setComplain(e.target.checked)} /> Something went wrong and I would like someone to look into it</label>
      {complain && (
        <div className="space-y-2">
          <label className="block text-sm">What was it about?
            <input className="mt-1 w-full rounded-md border border-slate-300 p-2" placeholder="Billing, waiting time, cleanliness…" maxLength={60} value={category} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label className="block text-sm">What happened?
            <textarea className="mt-1 w-full rounded-md border border-slate-300 p-2" rows={3} maxLength={2000} value={what} onChange={(e) => setWhat(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="button" disabled={busy || rating === 0 || (complain && (category.trim().length < 2 || what.trim().length < 10))} onClick={() => void send()} className="w-full rounded-md bg-brand-600 px-4 py-2 text-white disabled:opacity-50">{busy ? "Sending…" : "Send"}</button>
    </div>,
  );
}
