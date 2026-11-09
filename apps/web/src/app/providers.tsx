"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
    },
  }));
  return <I18nProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></I18nProvider>;
}
