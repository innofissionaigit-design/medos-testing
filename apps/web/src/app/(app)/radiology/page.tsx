import { redirect } from "next/navigation";

/** Radiology is now a branch of LIS; the old address keeps working. */
export default function RadiologyRedirect() { redirect("/lis?branch=radiology"); }
