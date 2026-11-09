"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorNote, Field, Input, KV, Notice, PageHeader } from "@/components/ui";
import { MyPayslips } from "@/components/payroll";
import { MyLeave } from "@/components/attendance";
import { api } from "@/lib/api";
import { LANGUAGES, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/me";

export default function AccountPage() {
  const { me } = useMe();
  const { lang, setLang } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const mismatch = again.length > 0 && next !== again;
  const change = useMutation({
    mutationFn: () => api.post("/users/me/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setDone(true);
      // Changing the password signs the account out everywhere, so return to the sign-in screen.
      setTimeout(async () => { await fetch("/api/session/logout", { method: "POST", credentials: "same-origin", headers: { "x-medos-csrf": "1" } }); window.location.assign("/login"); }, 2200);
    },
  });
  return (
    <>
      <PageHeader title="My account" subtitle={`${me.fullName} · ${me.username}`} />
      <div className="grid max-w-3xl gap-4">
        <Card title="Language">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Language">
            {LANGUAGES.map((l) => (
              <button key={l.code} role="radio" aria-checked={lang === l.code} onClick={() => setLang(l.code)} className={`rounded-md border px-4 py-2 text-sm ${lang === l.code ? "border-brand-600 bg-brand-50 font-medium text-brand-700" : "border-slate-300 bg-white hover:bg-slate-50"}`}>{l.native}</button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Menus, headings, buttons and table headings are translated. Patient data and clinical notes are shown exactly as entered.</p>
        </Card>
        <Card title="Your details">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3"><KV label="Name">{me.fullName}</KV><KV label="Username">{me.username}</KV><KV label="Email">{me.email}</KV><KV label="Hospital">{me.tenant.name}</KV><KV label="Facility">{me.facility?.name}</KV><KV label="Roles">{me.roles.map((r) => r.toLowerCase()).join(", ")}</KV></dl>
        </Card>
        <MyPayslips />
        <MyLeave />
        <Card title="Change password">
          {done ? <Notice tone="success">Password changed. You are being signed out so you can sign in again.</Notice> : (
            <form className="max-w-sm space-y-3" onSubmit={(e) => { e.preventDefault(); if (!mismatch && next.length >= 10) change.mutate(); }}>
              <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
              <Field label="New password" hint="At least 10 characters, with letters and digits."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
              <Field label="Repeat new password" error={mismatch ? "The passwords do not match" : undefined}><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
              <ErrorNote error={change.error} />
              <Button type="submit" loading={change.isPending} disabled={!current || next.length < 10 || next !== again}>Change password</Button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
