/** The documents checklist of an insurance claim (docs/claim-checklist.md): which required documents are attached, waived or still missing. No database here. */

export type ClaimKind = "CASHLESS" | "REIMBURSEMENT";
export interface RequiredDoc { id: string; label: string; claimType: ClaimKind | null }
export interface AttachedDoc { id: string; label: string }
export interface WaivedDoc { label: string; reason: string }
export type ItemState = "ATTACHED" | "WAIVED" | "MISSING";
export interface ChecklistItem { requirementId: string; label: string; state: ItemState; documentId?: string; waiverReason?: string }
export interface Checklist { items: ChecklistItem[]; missing: string[]; complete: boolean }

/** Names match whatever the capitals and extra spaces, so "Discharge  summary" and "discharge summary" are the same document. */
export const normLabel = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export function checklistOf(required: RequiredDoc[], attached: AttachedDoc[], waived: WaivedDoc[], type: ClaimKind): Checklist {
  const have = new Map<string, AttachedDoc>();
  for (const d of attached) if (!have.has(normLabel(d.label))) have.set(normLabel(d.label), d);
  const waivers = new Map(waived.map((w) => [normLabel(w.label), w]));
  const seen = new Set<string>();
  const items: ChecklistItem[] = [];
  for (const r of required) {
    if (r.claimType !== null && r.claimType !== type) continue;
    const key = normLabel(r.label);
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = have.get(key), w = waivers.get(key);
    if (doc) items.push({ requirementId: r.id, label: r.label, state: "ATTACHED", documentId: doc.id });
    else if (w) items.push({ requirementId: r.id, label: r.label, state: "WAIVED", waiverReason: w.reason });
    else items.push({ requirementId: r.id, label: r.label, state: "MISSING" });
  }
  const missing = items.filter((i) => i.state === "MISSING").map((i) => i.label);
  return { items, missing, complete: missing.length === 0 };
}
