"use client";
import clsx from "clsx";
import { Children, cloneElement, forwardRef, isValidElement, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";

// ───── buttons ─────
type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300",
  ghost: "text-brand-700 hover:bg-brand-50 disabled:text-slate-400",
};
export function Button({ variant = "primary", loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const t = useT();
  return (
    <button type="button" {...p} disabled={p.disabled || loading} className={clsx("inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed", VARIANTS[variant], className)}>
      {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {typeof children === "string" ? t(children) : children}
    </button>
  );
}

/** Two-step button for high-risk actions (refund, cancel, discharge…): the first click asks, the second confirms. */
export function ConfirmButton({ label, confirmLabel = "Confirm", onConfirm, variant = "danger", loading, disabled }: { label: string; confirmLabel?: string; onConfirm: () => void; variant?: Variant; loading?: boolean; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (!asking) return; const t = setTimeout(() => setAsking(false), 6000); return () => clearTimeout(t); }, [asking]);
  if (!asking) return <Button variant={variant === "danger" ? "secondary" : variant} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="inline-flex gap-2">
      <Button variant={variant} loading={loading} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
    </span>
  );
}

// ───── form controls ─────
const control = "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, placeholder, ...p }, ref) { const t = useT(); return <input ref={ref} {...p} placeholder={placeholder ? t(placeholder) : placeholder} className={clsx(control, className)} />; });
/** Option labels are translated like every other label (only plain-text options; the values never change). */
function translateOptions(children: ReactNode, t: (s: string) => string): ReactNode {
  return Children.map(children, (c) => {
    if (isValidElement<{ children?: ReactNode }>(c) && c.type === "option" && typeof c.props.children === "string") return cloneElement(c, undefined, t(c.props.children));
    return c;
  });
}
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) { const t = useT(); return <select ref={ref} {...p} className={clsx(control, className)}>{translateOptions(children, t)}</select>; });
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, placeholder, ...p }, ref) { const t = useT(); return <textarea ref={ref} rows={3} {...p} placeholder={placeholder ? t(placeholder) : placeholder} className={clsx(control, className)} />; });

/** `as="div"` for composite controls (pickers with their own buttons): inside a <label>, a click would be re-dispatched to the first control. */
export function Field({ label, error, hint, children, className, as = "label" }: { label: string; error?: string | undefined; hint?: string; children: ReactNode; className?: string; as?: "label" | "div" }) {
  const Tag = as;
  const t = useT();
  return (
    <Tag className={clsx("block text-sm", className)}>
      <span className="mb-1 block font-medium text-slate-700">{t(label)}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600" role="alert">{t(error)}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{t(hint)}</span> : null}
    </Tag>
  );
}

// ───── layout ─────
export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const t = useT();
  return (
    <section className={clsx("rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{typeof title === "string" ? t(title) : title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  const t = useT();
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">{icon}<div><h1 className="text-xl font-semibold text-slate-900">{t(title)}</h1>{subtitle && <p className="text-sm text-slate-500">{typeof subtitle === "string" ? t(subtitle) : subtitle}</p>}</div></div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

const TONES = { gray: "bg-slate-100 text-slate-700", green: "bg-green-100 text-green-800", amber: "bg-amber-100 text-amber-800", red: "bg-red-100 text-red-800", blue: "bg-blue-100 text-blue-800", purple: "bg-purple-100 text-purple-800" } as const;
export function Badge({ tone = "gray", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  const t = useT();
  return <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone])}>{typeof children === "string" ? t(children) : children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  SCHEDULED: "blue", SENT: "green", FAILED: "red",
  PAID: "green", COMPLETED: "green", SIGNED: "green", GIVEN: "green", CLEARED: "green", AVAILABLE: "green", ACTIVE: "blue", ADMITTED: "blue", OCCUPIED: "blue", IN_CONSULTATION: "blue", ISSUED: "blue",
  PARTIALLY_PAID: "amber", WAITING: "amber", CALLED: "amber", DUE: "amber", PENDING: "amber", DRAFT: "gray", CLEANING: "amber", RESERVED: "purple",
  CANCELLED: "red", MISSED: "red", REFUNDED: "red", MAINTENANCE: "red", BLOCKED: "red", NO_SHOW: "red", AT_PHARMACY: "amber", DISPENSED: "green", REJECTED: "red",
};
export const StatusBadge = ({ value }: { value: string }) => <Badge tone={STATUS_TONE[value] ?? "gray"}>{value.replace(/_/g, " ").toLowerCase()}</Badge>;

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{typeof h === "string" ? t(h) : h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty && <p className="px-3 py-6 text-center text-sm text-slate-500">{t(empty)}</p>}
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={clsx("px-3 py-2 align-middle", className)}>{children}</td>;

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warn"; children: ReactNode }) {
  const t = useT();
  const c = { info: "border-blue-200 bg-blue-50 text-blue-900", error: "border-red-200 bg-red-50 text-red-900", success: "border-green-200 bg-green-50 text-green-900", warn: "border-amber-300 bg-amber-50 text-amber-900" }[tone];
  return <div role={tone === "error" ? "alert" : "status"} className={clsx("rounded-md border px-3 py-2 text-sm", c)}>{typeof children === "string" ? t(children) : children}</div>;
}
export const ErrorNote = ({ error }: { error: unknown }) => (error ? <Notice tone="error">{errorText(error)}</Notice> : null);

export function Spinner() { const t = useT(); return <div className="p-6 text-center text-sm text-slate-500">{t("Loading…")}</div>; }

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const tr = useT();
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx("w-full rounded-lg bg-white shadow-xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h2 className="font-semibold">{tr(title)}</h2><button aria-label="Close" className="text-slate-500 hover:text-slate-800" onClick={onClose}>✕</button></header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  const tr = useT();
  return (
    <div className="mb-3 flex gap-1 border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={clsx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", value === t.id ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}>{tr(t.label)}</button>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function KV({ label, children }: { label: string; children: ReactNode }) {
  const t = useT();
  return (
  <div><dt className="text-xs uppercase tracking-wide text-slate-500">{t(label)}</dt><dd className="text-sm text-slate-900">{children ?? "—"}</dd></div>
  );
}
