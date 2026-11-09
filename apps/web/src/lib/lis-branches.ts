export type Branch = "pathology" | "radiology";

/** Permissions that decide which LIS branches a person sees. The API applies the same rules; this only decides what is shown. */
export const LIS_PERMISSIONS = ["LAB_READ", "RAD_READ"];
const PATHOLOGY_WORK = ["LAB_COLLECT", "LAB_RESULT", "LAB_VERIFY", "LAB_MASTERS"];
const RADIOLOGY_WORK = ["RAD_PERFORM", "RAD_REPORT"];

/** The branches this person may open, and the one to show first: the branch they actually work in, else the first they may read. */
export function lisBranches(can: (...p: string[]) => boolean): { allowed: Branch[]; first: Branch } {
  const allowed: Branch[] = [];
  if (can("LAB_READ")) allowed.push("pathology");
  if (can("RAD_READ")) allowed.push("radiology");
  const first: Branch = can(...PATHOLOGY_WORK) || !can(...RADIOLOGY_WORK) ? (allowed.includes("pathology") ? "pathology" : "radiology") : "radiology";
  return { allowed, first };
}
