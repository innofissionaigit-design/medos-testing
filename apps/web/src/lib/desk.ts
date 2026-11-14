"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Reception works at one of two desks, chosen each time they sign in: the OPD desk (outpatient visits, appointments, the OPD queue and OPD bills) or the IPD desk
 * (admissions, the ward, going home and inpatient bills). The two desks have their own dashboard, menu and services. The choice lives in this browser tab only and
 * is forgotten when the person signs out, so the question is asked again at the next sign-in.
 */
export type Desk = "OPD" | "IPD";
const KEY = "medos_desk";
const EVENT = "medos-desk-changed";

/** Only the receptionist role chooses a desk (and only where inpatient care is switched on). Everyone else sees the whole menu for their role. */
export function needsDesk(roles: readonly string[], features: Record<string, boolean>): boolean {
  return roles.includes("RECEPTIONIST") && features["IPD_ENABLED"] !== false;
}

export function readDesk(): Desk | null {
  try { const v = sessionStorage.getItem(KEY); return v === "OPD" || v === "IPD" ? v : null; } catch { return null; }
}

export function writeDesk(desk: Desk | null): void {
  try { if (desk) sessionStorage.setItem(KEY, desk); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: the choice then lasts only until the page reloads */ }
  window.dispatchEvent(new Event(EVENT));
}

/** `desk` is `undefined` until the browser has been asked (so a screen does not flash the question to someone who already chose). */
export function useDesk(): { desk: Desk | null | undefined; choose: (d: Desk | null) => void } {
  const [desk, setDesk] = useState<Desk | null | undefined>(undefined);
  useEffect(() => {
    const sync = () => setDesk(readDesk());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const choose = useCallback((d: Desk | null) => writeDesk(d), []);
  return { desk, choose };
}
