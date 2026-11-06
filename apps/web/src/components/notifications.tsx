"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Page } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useMe } from "@/lib/me";

interface Row { id: string; type: string; entityType: string; entityId: string | null; createdAt: string; readAt: string | null }

/** Where each kind of notification leads, and its fixed wording (English is the key for the Bengali and Hindi dictionaries). A notification carries no patient name. */
const KINDS: Record<string, { text: string; href: string; critical?: boolean }> = {
  CRITICAL_LAB_RESULT: { text: "A critical lab result is waiting", href: "/lis?branch=pathology", critical: true },
  CRITICAL_RAD_FINDING: { text: "A critical radiology finding is waiting", href: "/lis?branch=radiology", critical: true },
  QUEUE_PATIENT_ADDED: { text: "A patient joined your queue", href: "/queue" },
  PRESCRIPTION_AT_PHARMACY: { text: "A prescription is waiting at the pharmacy", href: "/pharmacy" },
  PHARMACY_BILL_WAITING: { text: "A pharmacy bill is waiting for payment", href: "/billing" },
  BOOKING_FROM_OUTSIDE: { text: "A booking came in from the patient app or another system", href: "/appointments" },
  BOOKING_AUTO_CANCELLED: { text: "A booking was cancelled because its fee was not paid", href: "/appointments" },
};
const kindOf = (type: string) => KINDS[type] ?? { text: "New notification", href: "/dashboard" };

/**
 * The bell in the top bar. The browser listens to a live stream that says "something changed" and then fetches; if the stream is not open
 * it asks every 20 seconds instead, so a dropped connection never means a missed notification.
 */
export function NotificationBell() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { dateTime } = useMe();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [alertRow, setAlertRow] = useState<Row | null>(null);
  const seen = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const unread = useQuery({ queryKey: ["notif-unread"], queryFn: () => api.get<{ unread: number }>("/notifications/unread-count"), refetchInterval: live ? 120_000 : 20_000 });
  const list = useQuery({ queryKey: ["notif-list"], queryFn: () => api.page<Row>("/notifications", { pageSize: 15 }), enabled: open, refetchInterval: open && !live ? 20_000 : false });
  const count = unread.data?.unread ?? 0;

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["notif-unread"] }); void qc.invalidateQueries({ queryKey: ["notif-list"] }); };
  const read = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api.post("/notifications/read-all"), onSuccess: refresh });

  // The live stream: it only nudges; the lists above are fetched from the table.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/proxy/notifications/stream");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // the browser reconnects by itself; meanwhile the 20-second polling covers it
    es.addEventListener("notify", (e) => {
      refresh();
      const latest = (JSON.parse((e as MessageEvent<string>).data) as { latestId?: string | null }).latestId ?? null;
      if (latest && latest !== seen.current) {
        const first = seen.current === null;
        seen.current = latest;
        // A critical result is shown straight away, not only as a number on the bell (not for what was already waiting when the page opened).
        if (!first) void api.page<Row>("/notifications", { pageSize: 3, unread: "true" }).then((p: Page<Row>) => { const c = p.data.find((r) => kindOf(r.type).critical); if (c) setAlertRow(c); }).catch(() => undefined);
      }
    });
    return () => es.close();
  }, []);

  useEffect(() => { document.title = count > 0 ? `(${count}) MedOS` : "MedOS"; }, [count]);
  useEffect(() => { if (!alertRow) return; const timer = setTimeout(() => setAlertRow(null), 12_000); return () => clearTimeout(timer); }, [alertRow]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const go = (r: Row): void => { if (!r.readAt) read.mutate(r.id); setOpen(false); router.push(kindOf(r.type).href); };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={t("Notifications")} aria-expanded={open} className="relative rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">
        <span aria-hidden>🔔</span>
        {count > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white" data-testid="notification-count">{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-2 top-14 z-40 rounded-md border border-slate-200 bg-white shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-1 sm:w-80" role="dialog" aria-label={t("Notifications")}>
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">{t("Notifications")}</span>
            {count > 0 && <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => readAll.mutate()}>{t("Mark all read")}</button>}
          </div>
          <ul className="max-h-96 divide-y divide-slate-100 overflow-auto">
            {list.isLoading && <li className="px-3 py-3 text-sm text-slate-500">{t("Loading…")}</li>}
            {list.data?.data.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">{t("Nothing new.")}</li>}
            {list.data?.data.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => go(r)} className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 ${r.readAt ? "text-slate-500" : "font-medium text-slate-900"}`}>
                  <span className={kindOf(r.type).critical && !r.readAt ? "text-red-700" : ""}>{t(kindOf(r.type).text)}</span>
                  <span className="mt-0.5 block text-xs font-normal text-slate-500">{dateTime(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {alertRow && (
        <div role="alert" className="fixed inset-x-2 top-14 z-50 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 shadow-lg sm:inset-x-auto sm:right-4 sm:w-80">
          <div className="font-semibold">{t(kindOf(alertRow.type).text)}</div>
          <div className="mt-2 flex gap-3">
            <Link href={kindOf(alertRow.type).href} className="font-medium underline" onClick={() => { read.mutate(alertRow.id); setAlertRow(null); }}>{t("Open")}</Link>
            <button type="button" className="text-red-800 hover:underline" onClick={() => setAlertRow(null)}>{t("Dismiss")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
