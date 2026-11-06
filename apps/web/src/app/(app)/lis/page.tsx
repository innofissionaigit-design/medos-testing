"use client";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Gate } from "@/components/gate";
import { Lis } from "@/components/lis";
import { LIS_PERMISSIONS } from "@/lib/lis-branches";
import { Spinner } from "@/components/ui";

/** LIS (Laboratory Information System): one module with Pathology and Radiology as branches, chosen in the address (?branch=pathology or ?branch=radiology). */
function LisInner() {
  const router = useRouter();
  const params = useSearchParams();
  return <Gate anyOf={LIS_PERMISSIONS}><Lis requested={params.get("branch")} onBranch={(b) => router.replace(`/lis?branch=${b}`)} /></Gate>;
}

export default function LisPage() { return <Suspense fallback={<Spinner />}><LisInner /></Suspense>; }
