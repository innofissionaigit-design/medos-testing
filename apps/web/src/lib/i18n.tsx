"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BN } from "./locales/bn";
import { HI } from "./locales/hi";

export const LANGUAGES = [
  { code: "en", label: "English", native: "English", locale: "en-IN" },
  { code: "bn", label: "Bengali", native: "বাংলা", locale: "bn-IN" },
  { code: "hi", label: "Hindi", native: "हिन्दी", locale: "hi-IN" },
] as const;
export type Lang = (typeof LANGUAGES)[number]["code"];

const DICTIONARIES: Record<Lang, Record<string, string>> = { en: {}, bn: BN, hi: HI };
const COOKIE = "medos_lang";

/**
 * English text is the key. A missing translation falls back to the English text, so the product never shows a blank or a raw key.
 * Strings are translated inside the shared UI components (buttons, headings, table heads, labels, tabs, badges), so pages stay readable.
 */
export function translate(lang: Lang, text: string): string {
  if (lang === "en") return text;
  const d = DICTIONARIES[lang];
  // Exact text first, then trimmed, lower-case and Capitalised forms, so a badge such as "pharmacy" finds the entry "Pharmacy".
  return d[text] ?? d[text.trim()] ?? d[text.toLowerCase()] ?? d[text.charAt(0).toUpperCase() + text.slice(1)] ?? text;
}

/** BCP-47 locale for dates; Latin digits are kept for money and identifiers so amounts are never ambiguous. */
export const localeFor = (lang: Lang): string => `${LANGUAGES.find((l) => l.code === lang)?.locale ?? "en-IN"}-u-nu-latn`;

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (text: string) => string }
const I18nContext = createContext<Ctx>({ lang: "en", setLang: () => undefined, t: (s) => s });

function readStored(): Lang {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([a-z]{2})`));
    const v = (m?.[1] ?? localStorage.getItem(COOKIE)) as Lang | null;
    return v && LANGUAGES.some((l) => l.code === v) ? v : "en";
  } catch { return "en"; }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => { setLangState(readStored()); }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { document.cookie = `${COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`; localStorage.setItem(COOKIE, l); } catch { /* storage unavailable: the choice lasts for this page view */ }
  }, []);
  const t = useCallback((text: string) => translate(lang, text), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = (): Ctx => useContext(I18nContext);
export const useT = (): ((text: string) => string) => useContext(I18nContext).t;

/** Translates plain text that sits outside the shared UI components: <T>No documents uploaded.</T>. Data (names, numbers) must never be wrapped. */
export function T({ children }: { children: string }): ReactNode { return useContext(I18nContext).t(children); }
