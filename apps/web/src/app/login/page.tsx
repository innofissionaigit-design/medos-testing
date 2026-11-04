"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, Card, ErrorNote, Field, Input, Notice } from "@/components/ui";
import { LANGUAGES, useI18n } from "@/lib/i18n";

const schema = z.object({ tenantCode: z.string().trim().min(2, "Enter your hospital code"), identifier: z.string().trim().min(1, "Enter your username"), password: z.string().min(1, "Enter your password") });
type Form = z.infer<typeof schema>;
interface Facility { id: string; name: string; code: string }

export default function LoginPage() {
  const { lang, setLang, t } = useI18n();
  const { register, handleSubmit, formState: { errors, isSubmitting }, getValues } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { tenantCode: typeof window !== "undefined" ? (localStorage.getItem("medos.tenant") ?? "") : "" } });
  const [error, setError] = useState<unknown>(null);
  const [facilities, setFacilities] = useState<Facility[] | null>(null);

  async function submit(values: Form, facilityId?: string) {
    setError(null);
    const res = await fetch("/api/session/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-medos-csrf": "1" }, body: JSON.stringify({ ...values, ...(facilityId ? { facilityId } : {}) }) });
    const json = (await res.json().catch(() => ({}))) as { data?: { status: string; facilities?: Facility[] }; error?: { message: string } };
    if (!res.ok || !json.data) { setError(new Error(json.error?.message ?? "Could not sign in")); return; }
    if (json.data.status === "AUTHENTICATED") {
      try { localStorage.setItem("medos.tenant", values.tenantCode); } catch { /* storage unavailable */ }
      window.location.assign("/dashboard");
    } else setFacilities(json.data.facilities ?? []);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold text-brand-700">MedOS</h1>
        <p className="mb-4 text-center text-sm text-slate-500">{t("Sign in to your hospital")}</p>
        <div className="mb-3 flex justify-center gap-2" role="radiogroup" aria-label="Language">{LANGUAGES.map((l) => <button key={l.code} type="button" role="radio" aria-checked={lang === l.code} onClick={() => setLang(l.code)} className={`rounded px-2 py-0.5 text-xs ${lang === l.code ? "bg-brand-50 font-medium text-brand-700" : "text-slate-500 hover:underline"}`}>{l.native}</button>)}</div>
        <Card>
          {facilities ? (
            <div className="space-y-3">
              <Notice>Choose the facility you are working at today.</Notice>
              {facilities.map((f) => <Button key={f.id} variant="secondary" className="w-full" loading={isSubmitting} onClick={() => submit(getValues(), f.id)}>{f.name} ({f.code})</Button>)}
              <ErrorNote error={error} />
            </div>
          ) : (
            <form method="post" action="/login" onSubmit={handleSubmit((v) => submit(v))} className="space-y-3" noValidate>
              <Field label="Hospital code" error={errors.tenantCode?.message}><Input autoFocus autoComplete="organization" {...register("tenantCode")} /></Field>
              <Field label="Username or email" error={errors.identifier?.message}><Input autoComplete="username" {...register("identifier")} /></Field>
              <Field label="Password" error={errors.password?.message}><Input type="password" autoComplete="current-password" {...register("password")} /></Field>
              <ErrorNote error={error} />
              <Button type="submit" className="w-full" loading={isSubmitting}>Sign in</Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
