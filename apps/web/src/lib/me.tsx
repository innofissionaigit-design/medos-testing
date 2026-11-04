"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { localeFor, useI18n } from "./i18n";

export interface Me {
  id: string; username: string; fullName: string; email: string | null;
  tenant: { id: string; name: string; code: string; timezone: string; currency: string };
  facility: { id: string; name: string; code: string; timezone: string } | null;
  facilities: { id: string; name: string; code: string }[];
  roles: string[]; permissions: string[];
  /** What clinical data this person may see: everything, only their own patients (doctor), or only their departments. */
  dataScope?: { kind: "ALL" | "DOCTOR" | "DEPARTMENT"; departments: { id: string; name: string }[] };
}
export type Features = { PHARMACY_ENABLED: boolean; IPD_ENABLED: boolean; NURSING_ENABLED: boolean };

interface Ctx {
  me: Me; features: Features; can: (...p: string[]) => boolean;
  money: (v: string | number | null | undefined) => string; dateTime: (v: string | Date | null | undefined) => string; date: (v: string | Date | null | undefined) => string;
}
const MeContext = createContext<Ctx | null>(null);

async function fetchMe(): Promise<Me> {
  const res = await fetch("/api/session/me", { credentials: "same-origin" });
  if (res.status === 401) { window.location.assign("/login"); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error("Could not load your session");
  return ((await res.json()) as { data: Me }).data;
}

export function MeProvider({ children }: { children: ReactNode }) {
  const { lang } = useI18n();
  const meQ = useQuery({ queryKey: ["me"], queryFn: fetchMe, staleTime: 60_000, retry: false });
  const featQ = useQuery({ queryKey: ["features"], queryFn: () => api.get<Features>("/settings/features"), staleTime: 60_000, enabled: !!meQ.data });
  const value = useMemo<Ctx | null>(() => {
    if (!meQ.data) return null;
    const me = meQ.data;
    const perms = new Set(me.permissions);
    const tz = me.facility?.timezone ?? me.tenant.timezone;
    const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : new Intl.NumberFormat(localeFor(lang), { style: "currency", currency: me.tenant.currency, minimumFractionDigits: 2 }).format(Number(v)));
    const dateTime = (v: string | Date | null | undefined) => (v ? new Intl.DateTimeFormat(localeFor(lang), { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(v)) : "—");
    const date = (v: string | Date | null | undefined) => (v ? new Intl.DateTimeFormat(localeFor(lang), { timeZone: tz, dateStyle: "medium" }).format(new Date(v)) : "—");
    return { me, features: featQ.data ?? { PHARMACY_ENABLED: true, IPD_ENABLED: true, NURSING_ENABLED: true }, can: (...p) => p.some((x) => perms.has(x)), money, dateTime, date };
  }, [meQ.data, featQ.data, lang]);
  if (meQ.isError) return <div className="p-8 text-red-700">Could not load your session. <a className="underline" href="/login">Sign in again</a></div>;
  if (!value) return <div className="p-8 text-slate-500">Loading…</div>;
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): Ctx {
  const c = useContext(MeContext);
  if (!c) throw new Error("useMe outside MeProvider");
  return c;
}
