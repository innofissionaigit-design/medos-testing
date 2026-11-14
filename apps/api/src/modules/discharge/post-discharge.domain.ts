import { Decimal } from "@medos/shared";
import { balanceDue, fmt } from "../billing/billing.domain";

/** What the post-discharge stage reads (docs/discharge-stages.md): the record, the claim and the final bill of one discharged stay. */
export interface PostDischargeInput {
  admissionStatus: string;
  dischargedAt: Date | null;
  summaryStatus: string | null;
  summaryVerified: boolean;
  verificationRequired: boolean;
  draftDocuments: number;
  exitStatus: string;
  recordCompletion: { completedAt: Date; byName: string | null; note: string | null } | null;
  codes?: { diagnosis: string; icd10: string; primary: boolean }[];
  fileMoves?: { action: string; location: string | null; issuedTo: string | null; at: Date; byName: string | null }[];
  suggestedDiagnoses?: { text: string; code?: string }[];
  claim: { claimNumber: string; status: string; insurer: string; approvedAmount: { toString(): string } | null; preauthApproved: { toString(): string } | null; settledAmount: { toString(): string } } | null;
  invoice: { invoiceNumber: string | null; status: string; total: { toString(): string }; paidTotal: { toString(): string }; refundedTotal: { toString(): string }; creditedTotal: { toString(): string } } | null;
  /** What the patient still owes on supplementary bills (late charges billed after the final bill). */
  supplementaryDue?: { toString(): string };
  now?: Date;
}

export const POST_DISCHARGE_STAGE = { stage: "Post-discharge", responsible: "MRD, claims, finance", description: "After the patient has gone: the Medical Records Department checks the record is complete (summary signed, no drafts left, departure recorded) and signs it off; the insurance claim is followed to settlement; and what the patient or the insurer still owes is tracked until it is paid." } as const;

/** Where the paper record may go next: received in MRD, filed, issued to someone, returned, filed again. */
export const NEXT_FILE_ACTIONS: Record<string, string[]> = { NONE: ["RECEIVED"], RECEIVED: ["FILED"], FILED: ["ISSUED"], ISSUED: ["RETURNED"], RETURNED: ["FILED"] };
const FILE_LABEL: Record<string, string> = { RECEIVED: "received in MRD", FILED: "filed", ISSUED: "issued", RETURNED: "returned to MRD" };

const LIVE_CLAIM = ["DRAFT", "PREAUTH_PENDING", "PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED"];
const AUTHORISED = ["PREAUTH_APPROVED", "SUBMITTED", "QUERY", "APPROVED"];
const D = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? 0);

/** The receivables of a discharged stay: what the patient still owes on the final bill, and what the insurer has authorised and not yet paid. */
export function receivables(i: Pick<PostDischargeInput, "claim" | "invoice" | "supplementaryDue">): { patient: Decimal; insurer: Decimal } {
  const inv = i.invoice;
  const due = inv && inv.status !== "CANCELLED" && inv.status !== "REFUNDED" ? balanceDue({ total: inv.total.toString(), paidTotal: inv.paidTotal.toString(), refundedTotal: inv.refundedTotal.toString(), creditedTotal: inv.creditedTotal.toString() }) : new Decimal(0);
  const c = i.claim;
  const authorised = c && AUTHORISED.includes(c.status) ? Decimal.max(0, D(c.approvedAmount ?? c.preauthApproved).minus(D(c.settledAmount))) : new Decimal(0);
  const insurer = Decimal.min(due, authorised);
  // Supplementary bills are the patient's own: the insurer's authorisation covers the final bill.
  return { patient: due.minus(insurer).plus(D(i.supplementaryDue)), insurer };
}

/** The post-discharge row: records (with the MRD sign-off), claims and receivables, and where the stay stands. */
export function postDischargeOf(i: PostDischargeInput) {
  const discharged = i.admissionStatus === "DISCHARGED";
  const summaryOk = (i.summaryStatus === "SIGNED" || i.summaryStatus === "AMENDED") && (!i.verificationRequired || i.summaryVerified);
  const departureOk = i.exitStatus === "CONFIRMED" || i.exitStatus === "NOT_APPLICABLE";
  const recordReady = summaryOk && i.draftDocuments === 0 && departureOk;
  const { patient, insurer } = receivables(i);
  const claimOpen = !!i.claim && LIVE_CLAIM.includes(i.claim.status);
  const owed = patient.gt(0) || insurer.gt(0);
  const status = !discharged ? (i.admissionStatus === "ADMITTED" ? "NOT_DUE" : "NOT_APPLICABLE")
    : !i.recordCompletion ? "RECORDS_PENDING" : claimOpen || owed ? "TRACKING" : "CLOSED";
  const hisStatus = status === "NOT_DUE" ? "Awaiting discharge" : status === "NOT_APPLICABLE" ? "Not applicable"
    : status === "RECORDS_PENDING" ? "Records not yet complete" : status === "TRACKING" ? "Records complete; claims and receivables tracked" : "Records complete; claims and receivables closed";
  const codes = i.codes ?? [];
  const moves = i.fileMoves ?? [];
  const file = moves.length ? moves[moves.length - 1]! : null;
  const fileText = (m: NonNullable<typeof file>) => `${FILE_LABEL[m.action] ?? m.action}${m.action === "FILED" && m.location ? ` at ${m.location}` : ""}${m.action === "ISSUED" && m.issuedTo ? ` to ${m.issuedTo}` : ""}`;
  const claimLabel = i.claim ? `Claim ${i.claim.claimNumber} with ${i.claim.insurer}: ${i.claim.status.toLowerCase().replace(/_/g, " ")}` : null;
  const checks = [
    { name: "Discharge summary", ok: summaryOk, detail: summaryOk ? (i.summaryVerified ? "Signed and verified" : "Signed") : !i.summaryStatus ? "Not written" : i.summaryStatus === "DRAFT" ? "Still a draft: the consultant has to sign it" : "Signed but not verified (this hospital requires verification)" },
    { name: "Clinical documents", ok: i.draftDocuments === 0, detail: i.draftDocuments === 0 ? "No drafts left open" : `${i.draftDocuments} draft document(s) still open` },
    { name: "Departure", ok: departureOk, detail: i.exitStatus === "CONFIRMED" ? "Actual departure recorded" : i.exitStatus === "NOT_APPLICABLE" ? "Not applicable" : "Departure not yet confirmed" },
    { name: "Medical records sign-off", ok: !!i.recordCompletion, detail: i.recordCompletion ? `Record complete${i.recordCompletion.byName ? `, signed off by ${i.recordCompletion.byName}` : ""}` : recordReady ? "Ready for the Medical Records Department to sign off" : "Waiting for the items above" },
    { name: "Diagnosis coding", ok: codes.length > 0, detail: codes.length ? codes.map((c) => `${c.icd10} ${c.diagnosis}${c.primary ? " (primary)" : ""}`).join(" · ") : "ICD-10 codes are added when MRD signs the record off" },
    { name: "Record file", ok: file?.action === "FILED", detail: file ? `${fileText(file)}${file.byName ? ` by ${file.byName}` : ""}` : "Paper record not yet received in MRD" },
    { name: "Claims", ok: !claimOpen, detail: !i.claim ? "No insurance claim for this stay" : `${claimLabel}${insurer.gt(0) ? ` · insurer still owes ${fmt(insurer)}` : ""}` },
    { name: "Receivables", ok: !owed, detail: !owed ? "Nothing receivable" : [patient.gt(0) ? `patient owes ${fmt(patient)}` : null, insurer.gt(0) ? `insurer owes ${fmt(insurer)}` : null].filter(Boolean).join(" · ") },
  ];
  const now = i.now ?? new Date();
  return {
    ...POST_DISCHARGE_STAGE, status, hisStatus, checks, recordReady,
    recordCompletedAt: i.recordCompletion?.completedAt ?? null, recordCompletedBy: i.recordCompletion?.byName ?? null, recordNote: i.recordCompletion?.note ?? null,
    codes, suggestedDiagnoses: i.suggestedDiagnoses ?? [],
    file: { current: file ? { ...file, label: fileText(file) } : null, history: moves.map((m) => ({ ...m, label: fileText(m) })), nextActions: discharged ? NEXT_FILE_ACTIONS[file?.action ?? "NONE"] ?? [] : [] },
    claim: i.claim ? { claimNumber: i.claim.claimNumber, status: i.claim.status, insurer: i.claim.insurer, open: claimOpen } : null,
    receivables: { patient: fmt(patient), insurer: fmt(insurer) },
    daysSinceDischarge: discharged && i.dischargedAt ? Math.floor((now.getTime() - i.dischargedAt.getTime()) / 86_400_000) : null,
  };
}
