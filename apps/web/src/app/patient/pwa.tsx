"use client";
import { useEffect, useState } from "react";

/** The browser's "install" event, which TypeScript does not know yet. */
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

const DISMISSED = "medos_patient_install_dismissed";
const remembered = () => { try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; } };
const remember = () => { try { localStorage.setItem(DISMISSED, "1"); } catch { /* private window: it will just ask again */ } };

/**
 * Makes the patient page installable: registers the small service worker (offline page only, nothing of the patient's is stored) and offers an install button where
 * the browser allows it. iPhones have no install event, so they get a one-line hint on how to add the page to the home screen. Hidden once installed or dismissed.
 */
export function PwaSupport() {
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/patient/sw.js", { scope: "/patient" }).catch(() => undefined);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone || remembered()) return;
    setHidden(false);
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
    setIosHint(ios);
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallEvent); };
    const onInstalled = () => { setPrompt(null); setHidden(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (hidden || (!prompt && !iosHint)) return null;
  const close = () => { remember(); setHidden(true); };
  return (
    <div role="region" aria-label="Install this app" className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-md items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
      <img src="/patient/icon-192.png" alt="" className="h-10 w-10 rounded-lg" />
      <div className="flex-1 text-sm">
        <div className="font-medium">Keep this on your phone</div>
        <div className="text-slate-600">{prompt ? "Add it to your home screen to open it like an app." : "Tap Share, then “Add to Home Screen”."}</div>
      </div>
      {prompt && <button className="rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white" onClick={() => { void prompt.prompt().then(() => prompt.userChoice).then((c) => { if (c.outcome === "accepted") setHidden(true); else close(); }); }}>Install</button>}
      <button aria-label="Not now" className="px-2 text-slate-500" onClick={close}>×</button>
    </div>
  );
}
