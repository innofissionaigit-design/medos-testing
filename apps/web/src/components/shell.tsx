"use client";
import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ageText, type AgeValue } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";
import { needsDesk, useDesk } from "@/lib/desk";
import { NAV, visibleNav } from "@/lib/nav";
import { NotificationBell } from "./notifications";
import { DeskChooser } from "./reception-desk";
import { useDebounced } from "./ui";

export interface PatientRow { id: string; mrn: string | null; firstName: string; lastName: string | null; gender: string; age: AgeValue; mobile: string | null }
export const patientName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/** Global patient search: MRN, mobile or name. Press "/" anywhere to focus it. */
function GlobalSearch() {
  const router = useRouter();
  const { t } = useI18n();
  const { can } = useMe();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const term = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["global-search", term], queryFn: () => api.page<PatientRow>("/patients", { q: term, pageSize: 8 }), enabled: term.length >= 2 && can("PATIENT_READ") });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  if (!can("PATIENT_READ")) return <div />;
  const rows = res.data?.data ?? [];
  const go = (id: string) => { setOpen(false); setQ(""); router.push(`/patients/${id}`); };
  return (
    <div className="relative w-full max-w-md">
      <input
        ref={ref} value={q} placeholder={t("Search patient by MRN, mobile or name") + "   ( / )"} aria-label="Search patients"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === "Enter" && rows[hi]) go(rows[hi]!.id);
          if (e.key === "Escape") { setOpen(false); ref.current?.blur(); }
        }}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      {open && term.length >= 2 && (
        <ul className="absolute z-40 mt-1 max-h-80 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg" role="listbox">
          {res.isLoading && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {!res.isLoading && rows.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No patients found</li>}
          {rows.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === hi} onMouseDown={() => go(p.id)} onMouseEnter={() => setHi(i)} className={clsx("cursor-pointer px-3 py-2 text-sm", i === hi && "bg-brand-50")}>
              <span className="font-medium">{patientName(p)}</span> <span className="text-slate-500">· {p.mrn} · {p.gender.toLowerCase()}{ageText(p.age) ? `, ${ageText(p.age)}` : ""}{p.mobile ? ` · ${p.mobile}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, features } = useMe();
  const { desk, choose } = useDesk();
  const router = useRouter();
  const { t } = useI18n();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const picksDesk = needsDesk(me.roles, features);
  const activeDesk = picksDesk ? (desk ?? null) : null;
  const nav = visibleNav(new Set(me.permissions), features, me.roles, activeDesk);
  // A screen that belongs to the other desk (for example the ward list at the OPD desk).
  const otherDesk = activeDesk ? NAV.find((n) => n.desk && n.desk !== activeDesk && path.startsWith(n.href)) : undefined;
  async function logout() {
    choose(null);
    await fetch("/api/session/logout", { method: "POST", credentials: "same-origin", headers: { "x-medos-csrf": "1" } });
    window.location.assign("/login");
  }
  async function switchFacility(facilityId: string) {
    await fetch("/api/session/switch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-medos-csrf": "1" }, body: JSON.stringify({ facilityId }) });
    window.location.assign("/dashboard");
  }
  if (picksDesk && desk === undefined) return <div className="p-6 text-slate-500">{t("Loading…")}</div>;
  if (picksDesk && desk === null) return <DeskChooser name={me.fullName} onChoose={(d) => { choose(d); router.push("/dashboard"); }} onSignOut={logout} />;
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-4 py-4"><div className="text-lg font-semibold text-brand-700">MedOS</div><div className="truncate text-xs text-slate-500">{me.tenant.name}</div></div>
        <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={clsx("block rounded-md px-3 py-2 text-sm", path.startsWith(n.href) ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700 hover:bg-slate-100")}>{t(n.label)}</Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <button className="rounded border border-slate-300 px-2 py-1 text-sm md:hidden" onClick={() => setMenu((m) => !m)} aria-label="Menu">☰</button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NotificationBell />
            {me.facilities.length > 1 ? (
              <select aria-label="Facility" value={me.facility?.id ?? ""} onChange={(e) => switchFacility(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                {me.facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            ) : <span className="hidden text-slate-500 sm:inline">{me.facility?.name}</span>}
            {activeDesk && <button type="button" onClick={() => { choose(null); router.push("/dashboard"); }} className="rounded border border-brand-200 bg-brand-50 px-2 py-1 text-brand-700 hover:bg-brand-100" title={t("Switch desk")}>{activeDesk} {t("desk")} · {t("Switch")}</button>}
            <Link href="/account" className="hidden text-slate-700 hover:underline sm:inline" title={t("My account")}>{me.fullName}</Link>
            <button onClick={logout} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50">{t("Sign out")}</button>
          </div>
        </header>
        {menu && (
          <nav className="border-b border-slate-200 bg-white p-2 md:hidden" aria-label="Mobile">
            {nav.map((n) => <Link key={n.href} onClick={() => setMenu(false)} href={n.href} className="block rounded px-3 py-2 text-sm hover:bg-slate-100">{t(n.label)}</Link>)}
          </nav>
        )}
        <main className="min-w-0 flex-1 p-4 md:p-6">
          {me.dataScope && me.dataScope.kind !== "ALL" && (
            <p className="mb-3 rounded border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-slate-700" data-testid="scope-note">
              {me.dataScope.kind === "DOCTOR" ? t("You see only your own patients, records and reports.") : `${t("You see only the data of your department:")} ${me.dataScope.departments.map((d) => d.name).join(", ")}`}
            </p>
          )}
          {otherDesk && activeDesk ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
              <p className="font-medium">{otherDesk.label} {t("belongs to the")} {activeDesk === "OPD" ? "IPD" : "OPD"} {t("desk")}.</p>
              <p className="mt-1 text-slate-700">{t("You are at the")} {activeDesk} {t("desk. Switch desk to open it.")}</p>
              <button type="button" className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50" onClick={() => { choose(null); router.push("/dashboard"); }}>{t("Switch desk")}</button>
            </div>
          ) : children}
        </main>
      </div>
    </div>
  );
}
