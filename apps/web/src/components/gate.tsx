"use client";
import type { ReactNode } from "react";
import { Notice } from "./ui";
import { useMe } from "@/lib/me";

/** UX guard only: the API refuses forbidden calls regardless. Hides pages a user has no permission for. */
export function Gate({ anyOf, feature, children }: { anyOf: string[]; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED"; children: ReactNode }) {
  const { can, features } = useMe();
  if (feature && features[feature] === false) return <Notice tone="warn">This module is not enabled for your facility.</Notice>;
  if (!can(...anyOf)) return <Notice tone="warn">You do not have access to this page.</Notice>;
  return <>{children}</>;
}
