"use client";
import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { MeProvider } from "@/lib/me";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <MeProvider><Shell>{children}</Shell></MeProvider>;
}
