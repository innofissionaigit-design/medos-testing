"use client";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

/**
 * Print options never take over the screen: every print link (an invoice, receipt, label, report, prescription...) opens its print page in a NEW browser tab
 * and leaves the current screen exactly as it is, so the person can print and carry on working. Every print option uses this, so they all behave the same.
 *
 * The click opens the tab with `window.open(url, "_blank")` (no window features, so the browser makes a normal tab, not a pop-up window). If the browser blocks
 * that, the link's own `target="_blank"` takes over. It is still a real link: right-click, middle-click and "open in new tab" work as usual.
 */
export function openInNewTab(url: string): boolean {
  if (typeof window === "undefined") return false;
  const w = window.open(url, "_blank");
  if (!w) return false;
  try { w.opener = null; } catch { /* a cross-origin window: nothing to do */ }
  return true;
}

export function PrintLink({ href, onClick, children, ...rest }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & { href: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    // Modified clicks (ctrl/cmd/shift/middle) already mean "new tab or window": the browser handles them itself.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (openInNewTab(href)) e.preventDefault();
  };
  return <a {...rest} href={href} target="_blank" rel="noopener noreferrer" onClick={click}>{children}</a>;
}
