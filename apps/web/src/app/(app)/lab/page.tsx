import { redirect } from "next/navigation";

/** The laboratory is now the Pathology branch of LIS; the old address keeps working. */
export default function LabRedirect() { redirect("/lis?branch=pathology"); }
