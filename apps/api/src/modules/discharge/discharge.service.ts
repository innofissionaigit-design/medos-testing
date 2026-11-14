import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope } from "../../common/data-scope";
import { balanceDue, fmt, refundable } from "../billing/billing.domain";
import { InvoicesService } from "../billing/invoices.service";
import { ClinicianService } from "../clinical/clinician.service";
import { EncountersService } from "../encounters/encounters.service";
import { AdmissionsService } from "../ipd/admissions.service";
import { chargeAmounts, ChargesService } from "../ipd/charges.service";
import { SettingsService } from "../settings/settings.service";
import { AftercareService } from "../aftercare/aftercare.service";
import { NEXT_FILE_ACTIONS, postDischargeOf } from "./post-discharge.domain";

export type Step = "MEDICALLY_FIT" | "NURSING" | "CHARGES_REVIEWED" | "PHARMACY" | "LAB_RADIOLOGY" | "OT_PROCEDURE" | "INSURANCE" | "BILLING" | "FINANCIAL_RELEASE";
const STEP_ORDER: Step[] = ["MEDICALLY_FIT", "NURSING", "CHARGES_REVIEWED", "PHARMACY", "LAB_RADIOLOGY", "OT_PROCEDURE", "INSURANCE", "BILLING", "FINANCIAL_RELEASE"];

export const clearSchema = z.object({ step: z.enum(["MEDICALLY_FIT", "NURSING", "CHARGES_REVIEWED", "PHARMACY"]), note: z.string().trim().min(3).max(300).optional() }).strict();
export const waiveSchema = z.object({ step: z.enum(["NURSING", "CHARGES_REVIEWED", "PHARMACY", "LAB_RADIOLOGY", "OT_PROCEDURE", "INSURANCE", "BILLING"]), reason: z.string().trim().min(10, "Explain why this step is being waived").max(300) }).strict();
/** An authorised billing / finance person releases the patient with money still outstanding (docs/discharge-stages.md). */
export const financialExceptionSchema = z.object({ reason: z.string().trim().min(10, "Explain why the patient may leave with money outstanding").max(240) }).strict();
/** The ward nurse or patient transport confirms when the patient actually left (docs/discharge-stages.md, physical exit). */
export const confirmDepartureSchema = z.object({
  departedAt: z.string().datetime({ offset: true }).optional(),
  mode: z.enum(["WALKED", "WHEELCHAIR", "STRETCHER", "AMBULANCE", "BODY_RELEASED"]),
  escortedBy: z.string().trim().min(2).max(120).optional(),
  note: z.string().trim().max(300).optional(),
}).strict();
/** The Medical Records Department confirms the record of a discharged stay is complete (docs/discharge-stages.md, post-discharge). */
const ICD10 = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
export const completeRecordsSchema = z.object({
  note: z.string().trim().max(300).optional(),
  // The final diagnoses coded in ICD-10 by the Medical Records Department; exactly one is the primary diagnosis.
  codes: z.array(z.object({ diagnosis: z.string().trim().min(2).max(300), icd10: z.string().trim().toUpperCase().regex(ICD10, "Enter an ICD-10 code such as K35.8"), primary: z.boolean().default(false) }).strict()).min(1, "Code at least one diagnosis").max(20)
    .refine((c) => c.filter((x) => x.primary).length <= 1, "Only one primary diagnosis")
    .refine((c) => new Set(c.map((x) => x.icd10)).size === c.length, "The same code twice"),
}).strict();
/** A movement of the paper record of a discharged stay (docs/discharge-stages.md, post-discharge). */
export const recordFileSchema = z.object({
  action: z.enum(["RECEIVED", "FILED", "ISSUED", "RETURNED"]),
  location: z.string().trim().min(2).max(120).optional(),
  issuedTo: z.string().trim().min(2).max(120).optional(),
  note: z.string().trim().max(300).optional(),
}).strict();
export const completeSchema = z.object({ type: z.enum(["ROUTINE", "LAMA", "REFERRED", "ABSCONDED", "DEATH"]).default("ROUTINE"), note: z.string().trim().max(300).optional() }).strict();

const OVERDUE_MIN = 30;

/** The discharge summary is not a clearance step: its state comes from the signed document, so it is reported next to the steps. */
export const SUMMARY_STAGE = { stage: "Summary preparation", responsible: "RMO / treating team", description: "The RMO or treating team writes the discharge summary (draft), the treating consultant signs it, and the RMO verifies the signed copy. An amendment needs a reason and has to be verified again." } as const;

/** Physical exit happens after the discharge is completed, so it is reported next to the steps rather than as a clearance that gates the discharge. */
export const TURNOVER_STAGE = { stage: "Bed turnover", responsible: "Housekeeping", description: "When the discharge vacates the bed, housekeeping starts cleaning it and marks it ready for the next patient: vacated, cleaning, ready. Housekeeping sees the bed, never the patient." } as const;
export const EXIT_STAGE = { stage: "Physical exit", responsible: "Ward nurse / transport", description: "After the doctor completes the discharge, the ward nurse or patient transport confirms when the patient actually left the ward, how (walked, wheelchair, stretcher, ambulance; for a death, the body released) and who escorted them." } as const;
const MODE_LABEL: Record<string, string> = { WALKED: "walked out", WHEELCHAIR: "by wheelchair", STRETCHER: "on a stretcher", AMBULANCE: "by ambulance", BODY_RELEASED: "body released" };

/** What each stage is called, who answers for it, and the words the HIS shows for it (docs/discharge-stages.md). */
export const STAGE_INFO: Record<Step, { stage: string; responsible: string; description: string; pending: string; cleared: string; waived: string }> = {
  MEDICALLY_FIT: { stage: "Discharge decision", responsible: "Treating doctor", description: "The treating doctor says the patient is clinically fit to go. Nothing else starts until this is recorded.", pending: "Awaiting doctor's decision", cleared: "Clinically fit / discharge advised", waived: "Clinically fit / discharge advised" },
  NURSING: { stage: "Nursing clearance", responsible: "Ward nurse / in-charge", description: "The ward nurse or in-charge confirms the medicines are recorded, the clinical documentation is up to date, and the patient is handed over.", pending: "Medication, clinical documentation or handover outstanding", cleared: "Medication, clinical documentation and handover complete", waived: "Nursing clearance waived" },
  CHARGES_REVIEWED: { stage: "Charges review", responsible: "Billing team", description: "Bed days and all other charges are posted and checked before the final bill.", pending: "Charges not yet reviewed", cleared: "All charges posted and reviewed", waived: "Charges review waived" },
  PHARMACY: { stage: "Pharmacy clearance", responsible: "Inpatient pharmacist", description: "The inpatient pharmacist confirms every medicine issued to the patient is accounted for, every return has its charge adjusted, and every credit that is due has been raised.", pending: "Issues, returns or eligible credits not yet reconciled", cleared: "Issues, returns and eligible credits reconciled", waived: "Pharmacy clearance waived" },
  LAB_RADIOLOGY: { stage: "Laboratory / radiology", responsible: "Relevant departments", description: "Every laboratory and radiology test ordered for the patient has been performed and reported (or taken off), and every one has been billed. It reconciles itself from the orders, results and reports.", pending: "Pending services or charges not yet reconciled", cleared: "Pending services and charges reconciled", waived: "Laboratory / radiology clearance waived" },
  OT_PROCEDURE: { stage: "OT / procedure", responsible: "OT / procedure coordinator", description: "Every procedure planned for the patient has been performed and finalised, with its implants and consumables recorded and charged. It reconciles itself from the procedure records.", pending: "Procedure, implants or consumables not yet finalised", cleared: "Procedure, implants and consumables finalised", waived: "OT / procedure clearance waived" },
  INSURANCE: { stage: "Insurance", responsible: "TPA desk + external payer", description: "For an insured patient, the TPA desk has attached the claim documents and the insurer's authorisation is tracked: the pre-authorisation is requested and answered, with any query from the insurer replied to. It reconciles itself from the claim linked to the admission. A self-pay patient needs nothing here.", pending: "Insurance documents or authorisation not yet complete", cleared: "Documentation submitted; authorisation tracked", waived: "Insurance clearance waived (self-pay)" },
  BILLING: { stage: "Final billing", responsible: "IP billing", description: "The final bill is issued; the patient's advance deposits are applied to it or refunded; credit notes leave nothing overpaid; and what the patient owes (the bill less the insurer's authorised share) is paid. It reconciles itself from the bill, the deposits, the credit notes and the claim.", pending: "Final bill, deposits, credits or patient liability not yet reconciled", cleared: "Final bill, deposits, credits and patient liability reconciled", waived: "Final billing waived" },
  FINANCIAL_RELEASE: { stage: "Financial release", responsible: "Authorised billing / finance", description: "The patient is released financially. It clears by itself once final billing is reconciled. If money is still outstanding, an authorised billing / finance person may release the patient as an exception, with a written reason; the outstanding amounts are recorded.", pending: "Financial release pending", cleared: "Cleared", waived: "Authorised exception" },
};

@Injectable()
export class DischargeService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly admissions: AdmissionsService, private readonly charges: ChargesService, private readonly invoices: InvoicesService,
    private readonly encounters: EncountersService, private readonly clinicians: ClinicianService, private readonly aftercare: AftercareService,
  ) {}

  // ───── status ─────

  /** Everything the discharge screen needs: each step, what blocks it, the bill, the summary, and whether discharge can complete. */
  async status(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.evaluate(this.prisma, ctx, adm);
  }

  private async evaluate(db: Db, ctx: RequestContext, adm: { id: string; status: string; encounterId: string; patientId: string; admittedAt: Date; finalInvoiceId: string | null; dischargedAt: Date | null; dischargeType: string | null }) {
    const required = new Set<Step>(["MEDICALLY_FIT", ...(await this.settings.get(db, ctx.tenantId, ctx.facilityId, "DISCHARGE_REQUIRED_STEPS")) as Step[]]);
    const requireSummary = await this.settings.get(db, ctx.tenantId, ctx.facilityId, "DISCHARGE_REQUIRE_SUMMARY");
    const now = Date.now();
    const [clearances, pendingTasks, overdueMar, pendingCharges, summary, invoice] = await Promise.all([
      db.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id } }),
      db.nursingTask.count({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "PENDING" } }),
      db.medicationAdministration.count({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "DUE", scheduledAt: { lt: new Date(now - OVERDUE_MIN * 60_000) }, item: { status: "ACTIVE" } } }),
      db.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "PENDING" } }),
      db.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, kind: "DISCHARGE_SUMMARY" }, select: { id: true, status: true, authorId: true, signedById: true, signedAt: true, currentVersion: true } }),
      adm.finalInvoiceId ? db.invoice.findFirst({ where: { id: adm.finalInvoiceId, tenantId: ctx.tenantId } }) : Promise.resolve(null),
    ]);
    const pendingTotal = pendingCharges.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
    const unfilled = await db.medicationOrderItem.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE", quantity: { not: null }, order: { encounterId: adm.encounterId, status: "SIGNED" } }, select: { quantity: true, dispensedQuantity: true } });
    const unresolvedRx = unfilled.filter((i) => i.quantity !== null && i.dispensedQuantity < i.quantity).length;
    const pharmacy = await this.reconcilePharmacy(db, ctx, adm, unresolvedRx);
    const lab = await this.reconcileLabRadiology(db, ctx, adm);
    const ot = await this.reconcileProcedures(db, ctx, adm);
    const ins = await this.reconcileInsurance(db, ctx, adm);

    const done = (s: Step) => clearances.find((c) => c.step === s);
    const invoiceDue = invoice ? balanceDue({ total: invoice.total, paidTotal: invoice.paidTotal, refundedTotal: invoice.refundedTotal, creditedTotal: invoice.creditedTotal }) : null;
    // Charges that arrived after the final bill wait as pending and are billed on supplementary bills; the final bill itself is never changed.
    const lateCharges = invoice ? pendingCharges : [];
    const lateTotal = lateCharges.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
    const supplementary = await db.supplementaryBill.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, orderBy: { sequence: "asc" }, select: { sequence: true, invoice: { select: { invoiceNumber: true, status: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true } } } });
    const lateBills = supplementary.map((b) => {
      const closedBill = b.invoice.status === "CANCELLED" || b.invoice.status === "REFUNDED";
      return { invoiceNumber: b.invoice.invoiceNumber, sequence: b.sequence, total: new Decimal(b.invoice.total.toString()), status: b.invoice.status,
        due: closedBill ? new Decimal(0) : balanceDue({ total: b.invoice.total, paidTotal: b.invoice.paidTotal, refundedTotal: b.invoice.refundedTotal, creditedTotal: b.invoice.creditedTotal }) };
    });
    const supplementaryDue = lateBills.reduce((a, b) => a.plus(b.due), new Decimal(0));
    const bill = await this.reconcileFinalBilling(db, ctx, adm, invoice, invoiceDue, pendingTotal, ins.payerOutstanding, { count: lateCharges.length, total: lateTotal, bills: lateBills });
    const settled = bill.settled;

    const blockers: Record<Step, string[]> = { MEDICALLY_FIT: [], NURSING: [], CHARGES_REVIEWED: [], PHARMACY: [], LAB_RADIOLOGY: [], OT_PROCEDURE: [], INSURANCE: [], BILLING: [], FINANCIAL_RELEASE: [] };
    if (pendingTasks > 0) blockers.NURSING.push(`${pendingTasks} nursing task(s) still pending`);
    if (overdueMar > 0) blockers.NURSING.push(`${overdueMar} overdue medication dose(s) not recorded`);
    if (unresolvedRx > 0) blockers.PHARMACY.push(`${unresolvedRx} prescribed medicine(s) not yet fully dispensed (confirm they are resolved)`);
    blockers.PHARMACY.push(...pharmacy.problems);
    blockers.LAB_RADIOLOGY.push(...lab.problems);
    blockers.OT_PROCEDURE.push(...ot.problems);
    blockers.INSURANCE.push(...ins.problems);
    blockers.BILLING.push(...bill.problems);
    const fitCleared = !!done("MEDICALLY_FIT");
    // Final billing is reconciled when it is cleared (or waived) or would clear by itself; financial release follows it.
    const billingDone = !!done("BILLING") || (bill.problems.length === 0 && (settled || (!invoice && pendingTotal.isZero() && fitCleared)));
    const exception = done("FINANCIAL_RELEASE");
    if (!billingDone) blockers.FINANCIAL_RELEASE.push("Final billing is not reconciled: settle it, or an authorised billing / finance person records an exception");

    // Verification belongs to one version of the summary; an amendment has none until it is verified again.
    const verification = summary && summary.status !== "DRAFT" ? await db.dischargeSummaryVerification.findFirst({ where: { tenantId: ctx.tenantId, documentId: summary.id, version: summary.currentVersion } }) : null;
    const requireVerified = await this.settings.get(db, ctx.tenantId, ctx.facilityId, "DISCHARGE_REQUIRE_VERIFIED_SUMMARY");
    const noteCount = await db.nursingNote.count({ where: { tenantId: ctx.tenantId, admissionId: adm.id, status: "ACTIVE" } });
    const departure = await db.admissionDeparture.findFirst({ where: { tenantId: ctx.tenantId, admissionId: adm.id } });
    const [recordCodes, fileMoves, signedSummary] = await Promise.all([
      db.medicalRecordCode.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, orderBy: [{ primary: "desc" }, { codedAt: "asc" }], select: { diagnosis: true, icd10: true, primary: true } }),
      db.medicalRecordFileMovement.findMany({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, orderBy: [{ at: "asc" }, { id: "asc" }], select: { action: true, location: true, issuedTo: true, at: true, byId: true } }),
      summary && summary.status !== "DRAFT" ? db.clinicalDocumentVersion.findFirst({ where: { tenantId: ctx.tenantId, documentId: summary.id, version: summary.currentVersion }, select: { content: true } }) : Promise.resolve(null),
    ]);
    const [draftDocuments, recordDone, lastClaim] = await Promise.all([
      db.clinicalDocument.count({ where: { tenantId: ctx.tenantId, encounterId: adm.encounterId, status: "DRAFT" } }),
      db.medicalRecordCompletion.findFirst({ where: { tenantId: ctx.tenantId, admissionId: adm.id } }),
      db.claim.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: adm.encounterId, tier: "PRIMARY" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { claimNumber: true, status: true, approvedAmount: true, preauthApproved: true, settledAmount: true, policy: { select: { insurer: { select: { name: true } } } } } }),
    ]);
    const heldBed = adm.status === "DISCHARGED" ? await db.bedAssignment.findFirst({ where: { tenantId: ctx.tenantId, admissionId: adm.id, releasedAt: null }, select: { bed: { select: { code: true, ward: { select: { name: true } } } } } }) : null;
    const turnover = await db.bedTurnover.findFirst({ where: { tenantId: ctx.tenantId, admissionId: adm.id }, include: { bed: { select: { code: true, ward: { select: { name: true } } } } } });
    const byIds = [...new Set([...clearances.map((c) => c.byId), ...(summary ? [summary.authorId, summary.signedById] : []), verification?.verifiedById, departure?.confirmedById, turnover?.cleaningStartedById, turnover?.readyById, recordDone?.completedById, ...fileMoves.map((m) => m.byId)].filter((x): x is string => !!x))];
    const names = new Map((byIds.length ? await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: byIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const steps = STEP_ORDER.map((step) => {
      const row = done(step);
      // Final billing reconciles itself: the bill is settled (or there is nothing to bill) and the deposits and credits leave nothing outstanding.
      const billingAuto = step === "BILLING" && !row && bill.problems.length === 0 && (settled || (!invoice && pendingTotal.isZero() && fitCleared));
      // Pharmacy clears itself once nothing is left to dispense, so dispensing in the pharmacy updates this checklist without a second step.
      // If something is still undispensed it stays pending and a pharmacist can still clear or waive it by hand.
      const pharmacyAuto = step === "PHARMACY" && !row && fitCleared && unresolvedRx === 0 && pharmacy.problems.length === 0;
      // Laboratory / radiology reconciles itself from the test orders, the verified lab results and the signed radiology reports; nobody clicks it.
      const labAuto = step === "LAB_RADIOLOGY" && !row && fitCleared && lab.problems.length === 0;
      // OT / procedure reconciles itself from the procedure records: it clears once every procedure is finalised (or there are none).
      const otAuto = step === "OT_PROCEDURE" && !row && fitCleared && ot.problems.length === 0;
      // Insurance reconciles itself from the claim linked to the admission: a self-pay patient has nothing to do, an insured one clears when the documents and the authorisation are in order.
      const insAuto = step === "INSURANCE" && !row && fitCleared && ins.problems.length === 0;
      // Financial release clears by itself once final billing is reconciled; otherwise only an authorised exception releases the patient.
      const releaseAuto = step === "FINANCIAL_RELEASE" && !row && fitCleared && billingDone;
      const auto = billingAuto || pharmacyAuto || labAuto || otAuto || insAuto || releaseAuto;
      const autoNote = releaseAuto ? "Nothing outstanding" : billingAuto ? "Settled automatically" : insAuto ? ins.note : otAuto ? (ot.summary.total === 0 ? "No procedures planned" : "Every procedure finalised") : labAuto ? (lab.summary.ordered === 0 ? "No laboratory or radiology tests ordered" : "Every test performed, reported and billed") : pharmacyAuto ? (unfilled.length > 0 ? "All prescribed medicines dispensed" : pharmacy.summary.issues.count > 0 ? "Everything issued is accounted for" : "Nothing to dispense") : null;
      const status = row ? row.status : auto ? "CLEARED" : "PENDING";
      const info = STAGE_INFO[step];
      return {
        step, required: required.has(step), status, by: row?.byId ?? null, byName: row ? names.get(row.byId) ?? null : null, at: row?.at ?? null, note: row?.note ?? autoNote,
        blockers: row || auto ? [] : blockers[step],
        // No Clear button for a stage that reconciles itself (billing, laboratory / radiology). A stage can be waived by a doctor unless it is the doctor's own decision or the bill.
        automatic: step === "BILLING" || step === "LAB_RADIOLOGY" || step === "OT_PROCEDURE" || step === "INSURANCE" || step === "FINANCIAL_RELEASE", waivable: step !== "MEDICALLY_FIT" && step !== "BILLING" && step !== "FINANCIAL_RELEASE",
        // The nursing stage is three promises, so show each one: the medicines, the documentation, and the handover (the nurse's own confirmation, with an optional note).
        // The pharmacy stage is also three promises: the issues, the returns and the credits (see reconcilePharmacy).
        reconciliation: step === "PHARMACY" ? pharmacy.summary : step === "LAB_RADIOLOGY" ? lab.summary : step === "OT_PROCEDURE" ? ot.summary : step === "INSURANCE" ? ins.summary : step === "BILLING" ? bill.summary : null,
        checks: step === "PHARMACY" ? pharmacy.checks : step === "LAB_RADIOLOGY" ? lab.checks : step === "OT_PROCEDURE" ? ot.checks : step === "INSURANCE" ? ins.checks : step === "BILLING" ? bill.checks : step === "FINANCIAL_RELEASE" ? [
          { name: "Final billing", ok: billingDone, detail: billingDone ? "Reconciled: nothing outstanding" : (bill.problems.join(" · ") || "Not reconciled") },
          { name: "Authorisation", ok: billingDone || !!exception, detail: exception ? `Exception authorised${row && names.get(row.byId) ? ` by ${names.get(row.byId)}` : ""}` : billingDone ? "Not needed" : "No exception authorised" },
        ] : step !== "NURSING" ? [] : [
          { name: "Medication", ok: overdueMar === 0, detail: overdueMar > 0 ? `${overdueMar} overdue dose(s) not recorded` : "All due doses are recorded" },
          { name: "Clinical documentation", ok: pendingTasks === 0, detail: pendingTasks > 0 ? `${pendingTasks} nursing task(s) still pending` : `No pending nursing tasks · ${noteCount} nursing note(s) on file` },
          { name: "Handover", ok: !!row, detail: row ? (row.note ? `Handover note: ${row.note}` : "Handover confirmed by the nurse") : "Confirmed when the nurse clears this stage (a handover note can be added)" },
        ],
        stage: info.stage, responsible: info.responsible, description: info.description,
        hisStatus: status === "WAIVED" ? info.waived : status === "CLEARED" ? (step === "INSURANCE" && !ins.summary.insured ? "Not applicable: self-pay patient" : info.cleared) : info.pending,
      };
    });
    const summaryOk = !requireSummary || summary?.status === "SIGNED" || summary?.status === "AMENDED";
    const completionBlockers: string[] = [];
    // An authorised financial-release exception lets the discharge go ahead while final billing still shows what is outstanding.
    for (const s of steps) if (s.required && s.status === "PENDING" && !(s.step === "BILLING" && exception)) completionBlockers.push(`${s.step.replace(/_/g, " ").toLowerCase()} not cleared`);
    if (!summaryOk) completionBlockers.push("discharge summary is not signed");
    else if (requireVerified && !verification) completionBlockers.push("discharge summary is not verified");
    const billingWaived = done("BILLING")?.status === "WAIVED";
    if (!invoice && pendingTotal.gt(0) && !billingWaived) completionBlockers.push("charges have not been billed");
    if (invoice && lateCharges.length > 0 && !billingWaived) completionBlockers.push("late charges have not been billed (generate a supplementary bill)");
    return {
      admissionId: adm.id, status: adm.status, dischargedAt: adm.dischargedAt, dischargeType: adm.dischargeType,
      requireSummary, summaryStatus: summary?.status ?? null, steps,
      summary: {
        stage: SUMMARY_STAGE.stage, responsible: SUMMARY_STAGE.responsible, description: SUMMARY_STAGE.description, required: requireSummary,
        status: verification ? "VERIFIED" : summary?.status ?? "NOT_STARTED",
        hisStatus: !summary ? "Not started" : summary.status === "DRAFT" ? "Draft" : verification ? (summary.status === "AMENDED" ? `Verified (amended, version ${summary.currentVersion})` : "Verified") : summary.status === "AMENDED" ? `Signed (amended, version ${summary.currentVersion})` : "Signed",
        preparedByName: summary ? names.get(summary.authorId) ?? null : null,
        signedByName: summary?.signedById ? names.get(summary.signedById) ?? null : null,
        signedAt: summary?.signedAt ?? null,
        verificationRequired: requireVerified,
        verifiedByName: verification ? names.get(verification.verifiedById) ?? null : null,
        verifiedAt: verification?.at ?? null,
        verificationNote: verification?.note ?? null,
      },
      exit: this.exitView(adm, departure, departure ? names.get(departure.confirmedById) ?? null : null),
      turnover: this.turnoverView(adm, turnover, names, heldBed ? `${heldBed.bed.ward.name} · ${heldBed.bed.code}` : null),
      postDischarge: postDischargeOf({
        admissionStatus: adm.status, dischargedAt: adm.dischargedAt, summaryStatus: summary?.status ?? null, summaryVerified: !!verification, verificationRequired: requireVerified as boolean,
        draftDocuments, exitStatus: this.exitView(adm, departure, null).status,
        codes: recordCodes, fileMoves: fileMoves.map((m) => ({ action: m.action, location: m.location, issuedTo: m.issuedTo, at: m.at, byName: names.get(m.byId) ?? null })),
        suggestedDiagnoses: ((signedSummary?.content as { finalDiagnoses?: { text: string; code?: string }[] } | null)?.finalDiagnoses ?? []).filter((d) => d && typeof d.text === "string"),
        recordCompletion: recordDone ? { completedAt: recordDone.completedAt, byName: names.get(recordDone.completedById) ?? null, note: recordDone.note } : null,
        claim: lastClaim ? { claimNumber: lastClaim.claimNumber, status: lastClaim.status, insurer: lastClaim.policy.insurer.name, approvedAmount: lastClaim.approvedAmount, preauthApproved: lastClaim.preauthApproved, settledAmount: lastClaim.settledAmount } : null,
        invoice, supplementaryDue,
      }),
      pendingCharges: { count: pendingCharges.length, total: fmt(pendingTotal) },
      finalInvoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, total: fmt(invoice.total), balanceDue: fmt(invoiceDue ?? 0) } : null,
      warnings: unresolvedRx > 0 ? [`${unresolvedRx} prescribed medicine(s) are not fully dispensed`] : [],
      canComplete: adm.status === "ADMITTED" && completionBlockers.length === 0, blockers: adm.status === "ADMITTED" ? completionBlockers : ["admission is already closed"],
    };
  }

  /**
   * What the relevant departments answer for, worked out from the records (docs/discharge-stages.md). Every laboratory and radiology test
   * ordered for the patient on the admission, or since they were admitted (not taken off), must be:
   *  - performed: a laboratory result is verified, or a radiology study is reported;
   *  - billed: the cashier has billed it (an unbilled test is a pending charge; "Not needed" takes it off).
   * A test that is billed but not yet resulted is a pending service; a test that is not yet billed is a pending charge.
   */
  private async reconcileLabRadiology(db: Db, ctx: RequestContext, adm: { encounterId: string; patientId: string; admittedAt: Date }) {
    const orders = await db.testOrder.findMany({
      // The admission's own visit, and any test the patient had ordered since being admitted (for example at an outpatient visit during the stay).
      where: { tenantId: ctx.tenantId, category: { in: ["LABORATORY", "RADIOLOGY"] }, status: { not: "CANCELLED" }, OR: [{ encounterId: adm.encounterId }, { patientId: adm.patientId, createdAt: { gte: adm.admittedAt } }] },
      select: { name: true, category: true, status: true, labResult: { select: { status: true } }, radStudy: { select: { status: true } } },
      orderBy: { createdAt: "asc" },
    });
    const isLab = (o: { category: string }): boolean => o.category === "LABORATORY";
    const performed = (o: (typeof orders)[number]): boolean => (isLab(o) ? o.labResult?.status === "VERIFIED" : o.radStudy?.status === "REPORTED");
    const lab = orders.filter(isLab); const rad = orders.filter((o) => !isLab(o));
    const unbilled = orders.filter((o) => o.status === "ORDERED");
    const pendingService = orders.filter((o) => o.status === "BILLED" && !performed(o));
    const problems = [
      ...pendingService.map((o) => `${o.name}: ${isLab(o) ? "laboratory result not yet verified" : "radiology study not yet reported"}`),
      ...unbilled.map((o) => `${o.name}: ordered but not yet billed (the cashier bills it, or marks it not needed)`),
    ];
    const waiting = (list: typeof orders): string => { const w = list.filter((o) => !performed(o)); return w.length ? ` · waiting: ${w.map((o) => o.name).join(", ")}` : ""; };
    const checks = [
      { name: "Laboratory", ok: lab.every(performed), detail: lab.length === 0 ? "No laboratory tests ordered" : `${lab.filter(performed).length} of ${lab.length} test(s) resulted${waiting(lab)}` },
      { name: "Radiology", ok: rad.every(performed), detail: rad.length === 0 ? "No radiology tests ordered" : `${rad.filter(performed).length} of ${rad.length} study(ies) reported${waiting(rad)}` },
      { name: "Charges", ok: unbilled.length === 0, detail: orders.length === 0 ? "Nothing to bill" : unbilled.length ? `${unbilled.length} test(s) not yet billed: ${unbilled.map((o) => o.name).join(", ")}` : `All ${orders.length} test(s) billed` },
    ];
    return {
      problems, checks,
      summary: {
        ordered: orders.length,
        laboratory: { ordered: lab.length, resulted: lab.filter(performed).length },
        radiology: { ordered: rad.length, reported: rad.filter(performed).length },
        charges: { billed: orders.length - unbilled.length, notBilled: unbilled.length },
        problems,
      },
    };
  }

  /**
   * What the OT / procedure coordinator answers for, worked out from the procedure records (docs/procedures.md). Every procedure planned for the admission
   * (not cancelled) must be performed and finalised; its implants and consumables must each have a live charge. A procedure still planned, or performed but not
   * finalised, keeps the stage pending.
   */
  private async reconcileProcedures(db: Db, ctx: RequestContext, adm: { id: string }) {
    const procs = await db.procedure.findMany({
      where: { tenantId: ctx.tenantId, admissionId: adm.id, status: { not: "CANCELLED" } }, orderBy: { plannedAt: "asc" },
      select: { name: true, status: true, chargeId: true, items: { where: { removedAt: null }, select: { kind: true, name: true, chargeId: true } } },
    });
    const ids = procs.flatMap((p) => [p.chargeId, ...p.items.map((i) => i.chargeId)]).filter((x): x is string => !!x);
    const live = new Set((ids.length ? await db.charge.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids }, status: { not: "VOIDED" } }, select: { id: true } }) : []).map((c) => c.id));
    const problems: string[] = [];
    for (const p of procs) {
      if (p.status === "PLANNED") problems.push(`${p.name}: planned but not yet performed`);
      else if (p.status === "PERFORMED") problems.push(`${p.name}: performed but not yet finalised`);
      if (p.chargeId && !live.has(p.chargeId)) problems.push(`${p.name}: its charge is missing or voided`);
      for (const i of p.items) if (!live.has(i.chargeId)) problems.push(`${p.name}: ${i.kind === "IMPLANT" ? "implant" : "consumable"} ${i.name} has no live charge`);
    }
    const finalised = procs.filter((p) => p.status === "FINALISED");
    const waiting = procs.filter((p) => p.status !== "FINALISED");
    const allItems = procs.flatMap((p) => p.items.map((i) => ({ ...i, done: p.status === "FINALISED" && live.has(i.chargeId) })));
    const part = (kind: "IMPLANT" | "CONSUMABLE", noun: string) => {
      const list = allItems.filter((i) => i.kind === kind);
      return { name: noun === "implant" ? "Implants" : "Consumables", ok: list.every((i) => i.done), detail: list.length === 0 ? `No ${noun}s recorded` : `${list.filter((i) => i.done).length} of ${list.length} ${noun}(s) recorded, charged and finalised` };
    };
    const checks = [
      { name: "Procedure", ok: waiting.length === 0, detail: procs.length === 0 ? "No procedures planned" : `${finalised.length} of ${procs.length} procedure(s) finalised${waiting.length ? ` · waiting: ${waiting.map((p) => p.name).join(", ")}` : ""}` },
      part("IMPLANT", "implant"), part("CONSUMABLE", "consumable"),
    ];
    return {
      problems, checks,
      summary: {
        total: procs.length, finalised: finalised.length, waiting: waiting.length,
        implants: allItems.filter((i) => i.kind === "IMPLANT").length, consumables: allItems.filter((i) => i.kind === "CONSUMABLE").length,
        problems,
      },
    };
  }

  /**
   * What IP billing answers for, worked out from the final bill, the patient's advance deposits, the credit notes and the claim (docs/discharge-stages.md):
   *  - final bill: issued (or there is nothing to bill);
   *  - deposits: advances taken since admission are applied to a bill or refunded, none left over;
   *  - credits: credit notes leave nothing overpaid (an overpayment is a refund that is due);
   *  - patient liability: the bill's balance, less what the insurer has authorised and not yet paid, is zero. The insurer's share is not the patient's debt;
   *    money the insurer has paid is already on the bill as a payment.
   * A cancelled or fully refunded bill is settled. Money is exact decimal throughout.
   */
  private async reconcileFinalBilling(
    db: Db, ctx: RequestContext, adm: { patientId: string; admittedAt: Date },
    invoice: { invoiceNumber: string | null; status: string; total: { toString(): string }; paidTotal: { toString(): string }; refundedTotal: { toString(): string }; creditedTotal: { toString(): string } } | null,
    invoiceDue: Decimal | null, pendingTotal: Decimal, payerOutstanding: Decimal,
    late: { count: number; total: Decimal; bills: { invoiceNumber: string | null; sequence: number; total: Decimal; due: Decimal; status: string }[] },
  ) {
    const num = (v: { toString(): string }): Decimal => new Decimal(v.toString());
    const sum = (rows: { amount: { toString(): string } }[]): Decimal => rows.reduce((a, r) => a.plus(num(r.amount)), new Decimal(0));
    const deposits = await db.advanceDeposit.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: adm.patientId, appointmentId: null, receivedAt: { gte: adm.admittedAt } },
      select: { amount: true, uses: { select: { amount: true } }, returns: { select: { amount: true } }, refunds: { select: { amount: true } } },
    });
    const received = sum(deposits); let applied = new Decimal(0); let refunded = new Decimal(0); let unapplied = new Decimal(0);
    for (const d of deposits) {
      const used = sum(d.uses).minus(sum(d.returns)); const back = sum(d.refunds);
      applied = applied.plus(used); refunded = refunded.plus(back);
      unapplied = unapplied.plus(Decimal.max(0, num(d.amount).minus(used).minus(back)));
    }
    const closed = invoice !== null && (invoice.status === "CANCELLED" || invoice.status === "REFUNDED");
    const due = invoiceDue ?? new Decimal(0);
    const payerShare = invoice && !closed ? Decimal.min(due, payerOutstanding) : new Decimal(0);
    const finalLiability = invoice && !closed ? due.minus(payerShare) : new Decimal(0);
    // Late charges are billed on supplementary bills; what is owed on them is the patient's own (the insurer's authorisation covers the final bill).
    const supplementaryDue = late.bills.reduce((a, b) => a.plus(b.due), new Decimal(0));
    const liability = finalLiability.plus(supplementaryDue);
    const settled = invoice !== null && (closed || finalLiability.isZero()) && supplementaryDue.isZero() && late.count === 0;
    const credited = invoice ? num(invoice.creditedTotal) : new Decimal(0);
    const overpaid = invoice && !closed ? refundable({ total: invoice.total.toString(), paidTotal: invoice.paidTotal.toString(), refundedTotal: invoice.refundedTotal.toString(), creditedTotal: invoice.creditedTotal.toString() }) : new Decimal(0);

    const problems: string[] = [];
    if (!invoice && pendingTotal.gt(0)) problems.push("Generate the final bill");
    if (invoice && late.count > 0) problems.push(`${late.count} late charge(s) worth ${fmt(late.total)} not yet billed: generate a supplementary bill`);
    if (invoice && liability.gt(0)) problems.push(`Payment pending: ${fmt(liability)} due from the patient${payerShare.gt(0) ? ` (the insurer's authorised ${fmt(payerShare)} is awaited separately)` : ""}`);
    if (unapplied.gt(0)) problems.push(`${fmt(unapplied)} of advance deposits not yet applied to the bill or refunded`);
    if (overpaid.gt(0)) problems.push(`The bill is overpaid by ${fmt(overpaid)} after credit notes: refund it to the patient`);

    const checks = [
      { name: "Final bill", ok: invoice !== null || pendingTotal.isZero(), detail: invoice ? `Bill ${invoice.invoiceNumber ?? ""} for ${fmt(num(invoice.total))} (${invoice.status.toLowerCase().replace(/_/g, " ")})` : pendingTotal.gt(0) ? `Not yet generated: ${fmt(pendingTotal)} of charges are not billed` : "No chargeable items" },
      { name: "Deposits", ok: unapplied.isZero(), detail: deposits.length === 0 ? "No advance deposits" : `${fmt(received)} taken · ${fmt(applied)} applied to bills · ${fmt(refunded)} refunded${unapplied.gt(0) ? ` · ${fmt(unapplied)} still unapplied` : ""}` },
      { name: "Credits", ok: overpaid.isZero(), detail: overpaid.gt(0) ? `Overpaid by ${fmt(overpaid)} after credit notes: refund due` : credited.gt(0) ? `Credit notes of ${fmt(credited)} are on the bill; nothing overpaid` : "No credit notes" },
      ...(late.count > 0 || late.bills.length > 0 ? [{ name: "Late charges", ok: late.count === 0 && supplementaryDue.isZero(), detail: late.count > 0 ? `${late.count} charge(s) worth ${fmt(late.total)} arrived after the final bill: generate a supplementary bill` : supplementaryDue.gt(0) ? `${late.bills.length} supplementary bill(s); ${fmt(supplementaryDue)} still due` : `${late.bills.length} supplementary bill(s), all paid` }] : []),
      { name: "Patient liability", ok: invoice ? liability.isZero() : pendingTotal.isZero(), detail: !invoice ? (pendingTotal.gt(0) ? "Waiting for the final bill" : "Nothing to pay") : closed ? "The bill is closed: nothing owed" : liability.gt(0) ? `Patient owes ${fmt(liability)}${payerShare.gt(0) ? ` · insurer's authorised share ${fmt(payerShare)} is awaited` : ""}` : payerShare.gt(0) ? `Patient has paid their share · insurer's authorised share ${fmt(payerShare)} is awaited` : "Paid in full" },
    ];
    return {
      settled, problems, checks,
      summary: {
        billTotal: invoice ? fmt(num(invoice.total)) : null, credited: fmt(credited), overpaid: fmt(overpaid),
        deposits: { received: fmt(received), applied: fmt(applied), refunded: fmt(refunded), unapplied: fmt(unapplied) },
        insurerShare: fmt(payerShare), patientLiability: fmt(liability), problems,
        lateCharges: { count: late.count, total: fmt(late.total) },
        supplementaryBills: late.bills.map((b) => ({ invoiceNumber: b.invoiceNumber, sequence: b.sequence, total: fmt(b.total), due: fmt(b.due), status: b.status })),
      },
    };
  }

  /**
   * What the TPA desk and the external payer answer for, worked out from the insurance claim linked to the admission's visit (docs/discharge-stages.md, docs/claims.md).
   *  - No live claim and no valid policy: a self-pay patient, nothing to do.
   *  - A valid policy but no claim: the claim has not been started (a doctor can waive the stage for a patient who chooses to pay).
   *  - A claim: its documents are attached and, for a cashless claim, the pre-authorisation has been requested and answered (an open insurer query is a problem).
   *    A reimbursement claim needs no authorisation; its documents are collected now and filed after the final bill. A rejected authorisation is tracked and the patient pays.
   * A claim that was closed is no longer live. MedOS records the claim; it does not send anything to the insurer (docs/claims.md).
   */
  private async reconcileInsurance(db: Db, ctx: RequestContext, adm: { encounterId: string; patientId: string }) {
    const day = new Date(new Date().toISOString().slice(0, 10));
    const [claim, policies] = await Promise.all([
      db.claim.findFirst({
        where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: adm.encounterId, tier: "PRIMARY", status: { not: "CLOSED" } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: { id: true, claimNumber: true, type: true, status: true, preauthRequested: true, preauthApproved: true, claimedAmount: true, approvedAmount: true, settledAmount: true, closeReason: true, policy: { select: { policyNumber: true, insurer: { select: { name: true } } } } },
      }),
      db.patientPolicy.count({ where: { tenantId: ctx.tenantId, patientId: adm.patientId, status: "ACTIVE", validFrom: { lte: day }, validTo: { gte: day }, insurer: { status: "ACTIVE" } } }),
    ]);
    const money = (v: { toString(): string } | null): string => (v === null ? "—" : fmt(new Decimal(v.toString())));
    if (!claim) {
      const insured = policies > 0;
      const problems = insured ? ["Insurance claim not started: open one for this admission, or waive this step if the patient pays themselves"] : [];
      return {
        problems, note: "Not insured (self-pay)", payerOutstanding: new Decimal(0),
        checks: [
          { name: "Documentation", ok: !insured, detail: insured ? "The patient has a valid policy but no claim is open for this admission" : "No insurance for this patient: nothing to submit" },
          { name: "Authorisation", ok: !insured, detail: insured ? "No authorisation is being tracked" : "No insurance for this patient: nothing to authorise" },
        ],
        summary: { insured, validPolicies: policies, claim: null, problems },
      };
    }
    const docs = await db.claimDocument.count({ where: { tenantId: ctx.tenantId, claimId: claim.id, status: "ACTIVE" } });
    // A top-up insurer's share is awaited separately too: it is not the patient's to pay (docs/insurance-money.md).
    const topups = await db.claim.findMany({ where: { tenantId: ctx.tenantId, primaryClaimId: claim.id, tier: "TOPUP", status: { in: ["SUBMITTED", "QUERY", "APPROVED"] } }, select: { approvedAmount: true, claimedAmount: true, settledAmount: true } });
    const topupOutstanding = topups.reduce((a, t) => a.plus(Decimal.max(0, new Decimal((t.approvedAmount ?? t.claimedAmount ?? 0).toString()).minus(t.settledAmount.toString()))), new Decimal(0));
    const cashless = claim.type === "CASHLESS";
    const rejected = claim.status === "REJECTED";
    const sent = claim.status !== "DRAFT"; // asked the insurer: pre-authorisation requested, or the claim submitted
    const docsOk = rejected || (docs > 0 && (!cashless || sent));
    const docsDetail = rejected ? "The insurer rejected the claim: no more documents are needed" : docs === 0 ? "No documents are attached to the claim yet"
      : cashless ? (sent ? `${docs} document(s) attached and sent for authorisation` : `${docs} document(s) attached, but nothing has been sent to the insurer yet (request the pre-authorisation)`)
        : `${docs} document(s) collected; the claim is filed after the final bill`;
    let authOk: boolean; let authDetail: string;
    if (rejected) { authOk = true; authDetail = `Rejected by the insurer${claim.closeReason ? `: ${claim.closeReason}` : ""}; the patient pays as self-pay`; }
    else if (!cashless) { authOk = true; authDetail = "Reimbursement claim: no pre-authorisation is needed"; }
    else if (claim.status === "DRAFT") { authOk = false; authDetail = "Pre-authorisation has not been requested"; }
    else if (claim.status === "PREAUTH_PENDING") { authOk = false; authDetail = `Waiting for the insurer's decision on ${money(claim.preauthRequested)}`; }
    else if (claim.status === "QUERY") { authOk = false; authDetail = "The insurer has raised a query that is not yet answered"; }
    else if (claim.approvedAmount !== null) { authOk = true; authDetail = `Claim approved by the insurer for ${money(claim.approvedAmount)}${claim.preauthApproved !== null ? ` (pre-authorised ${money(claim.preauthApproved)})` : ""}`; }
    else { authOk = true; authDetail = claim.preauthApproved !== null ? `Pre-authorisation approved for ${money(claim.preauthApproved)} (asked ${money(claim.preauthRequested)})` : "Claim submitted to the insurer"; }
    const problems = [...(docsOk ? [] : [`Claim ${claim.claimNumber}: ${docsDetail}`]), ...(authOk ? [] : [`Claim ${claim.claimNumber}: ${authDetail}`])];
    return {
      // What the insurer has authorised and not yet paid: it is not the patient's liability. A rejected claim has none; a payment received is already on the invoice.
      payerOutstanding: topupOutstanding.plus(rejected ? new Decimal(0) : Decimal.max(0, new Decimal((claim.approvedAmount ?? (claim.preauthApproved !== null && claim.claimedAmount !== null && claim.claimedAmount.lt(claim.preauthApproved) ? claim.claimedAmount : claim.preauthApproved) ?? 0).toString()).minus(claim.settledAmount.toString()))),
      problems, note: rejected ? "Insurer rejected the claim: self-pay" : `Claim ${claim.claimNumber} (${claim.status.toLowerCase().replace(/_/g, " ")})`,
      checks: [{ name: "Documentation", ok: docsOk, detail: docsDetail }, { name: "Authorisation", ok: authOk, detail: authDetail }],
      summary: {
        insured: true, validPolicies: policies,
        claim: { id: claim.id, claimNumber: claim.claimNumber, type: claim.type, status: claim.status, insurer: claim.policy.insurer.name, policyNumber: claim.policy.policyNumber, documents: docs, preauthRequested: claim.preauthRequested ? money(claim.preauthRequested) : null, preauthApproved: claim.preauthApproved ? money(claim.preauthApproved) : null },
        problems,
      },
    };
  }

  /**
   * What the inpatient pharmacist answers for, worked out from the records (docs/discharge-stages.md):
   *  - issues: every medicine handed to this patient since admission (dispensed to the admission, drawn from a ward store, sold at the
   *    counter), and the prescribed medicines still waiting to be dispensed;
   *  - returns: what came back, and that the unbilled charge was cut to match (issued less returned = billed);
   *  - credits: a return of a medicine that was already invoiced (a counter sale) must have credit notes covering its value.
   * Anything that does not add up is a problem. A problem stops the stage being cleared (it can still be waived, with a reason).
   */
  private async reconcilePharmacy(db: Db, ctx: RequestContext, adm: { id: string; patientId: string; admittedAt: Date }, unresolvedRx: number) {
    const T = ctx.tenantId;
    const num = (v: { toString(): string }) => new Decimal(v.toString());
    const charges = await db.charge.findMany({
      where: { tenantId: T, admissionId: adm.id, type: "MEDICINE", OR: [{ sourceKey: { startsWith: "DISPENSE_ITEM:" } }, { sourceKey: { startsWith: "WARDISSUE:" } }] },
      select: { id: true, status: true, quantity: true, unitPrice: true, sourceKey: true, invoiceId: true },
    });
    const live = charges.filter((c) => c.status !== "VOIDED");
    const itemOf = (c: { sourceKey: string | null }): string | undefined => (c.sourceKey?.startsWith("DISPENSE_ITEM:") ? c.sourceKey.split(":")[1] : undefined);
    const itemIds = [...new Set(charges.map(itemOf).filter((x): x is string => !!x))];
    const items = itemIds.length ? await db.dispenseItem.findMany({ where: { tenantId: T, id: { in: itemIds } }, select: { id: true, quantity: true, returnedQuantity: true, unitPrice: true, medicine: { select: { brandName: true } } } }) : [];

    const issueProblems: string[] = []; const returnProblems: string[] = []; const creditProblems: string[] = [];
    let issueCount = 0; let issueUnits = 0; let issueValue = new Decimal(0); let returnUnits = 0; let returnValue = new Decimal(0);
    let creditEligible = new Decimal(0); let creditRaised = new Decimal(0);
    let returnedAfterBilling = new Decimal(0); // value of medicines returned after they were already on the final bill: a credit note is due

    // Medicines dispensed to the admission. Unbilled charges must equal issued less returned. A unit returned after it was billed keeps its charge
    // on the bill and has a credit note instead, so billed units above "issued less returned" are credits that are due.
    for (const it of items) {
      issueCount++; issueUnits += it.quantity; issueValue = issueValue.plus(num(it.unitPrice).times(it.quantity));
      returnUnits += it.returnedQuantity; returnValue = returnValue.plus(num(it.unitPrice).times(it.returnedQuantity));
      const mine = live.filter((c) => itemOf(c) === it.id);
      const pendingQty = mine.filter((c) => c.status === "PENDING").reduce((a, c) => a + Number(c.quantity), 0);
      const liveQty = mine.reduce((a, c) => a + Number(c.quantity), 0);
      const expected = it.quantity - it.returnedQuantity;
      if (liveQty < expected || pendingQty > expected) (it.returnedQuantity > 0 ? returnProblems : issueProblems).push(`${it.medicine.brandName}: ${it.quantity} issued, ${it.returnedQuantity} returned, but ${liveQty} billed (should be ${expected})`);
      else if (liveQty > expected) returnedAfterBilling = returnedAfterBilling.plus(num(it.unitPrice).times(liveQty - expected));
    }
    if (!returnedAfterBilling.isZero()) {
      const invoiceIds = [...new Set(live.filter((c) => c.status === "BILLED" && c.invoiceId).map((c) => c.invoiceId as string))];
      const notes = invoiceIds.length ? await db.creditNote.findMany({ where: { tenantId: T, invoiceId: { in: invoiceIds }, reason: { startsWith: "Pharmacy return" } }, select: { amount: true } }) : [];
      const raised = notes.reduce((a, n) => a.plus(num(n.amount)), new Decimal(0));
      creditEligible = creditEligible.plus(returnedAfterBilling); creditRaised = creditRaised.plus(raised.gt(returnedAfterBilling) ? returnedAfterBilling : raised);
      if (raised.lt(returnedAfterBilling)) creditProblems.push(`Medicines returned after billing worth ${fmt(returnedAfterBilling)} but credit notes cover only ${fmt(raised)}`);
    }
    // Medicines drawn from a ward store for this patient: each must still have its charge.
    const ward = await db.stockLocationIssue.findMany({ where: { tenantId: T, admissionId: adm.id }, select: { id: true, quantity: true, chargeId: true, batch: { select: { medicine: { select: { brandName: true } } } } } });
    for (const w of ward) {
      issueCount++; issueUnits += w.quantity;
      // A charge re-posted by the pharmacist carries the issue's id in its key too, so match on that rather than on the original charge.
      const charge = charges.find((c) => c.sourceKey === `WARDISSUE:${w.id}`) ?? charges.find((c) => c.id === w.chargeId);
      if (charge) issueValue = issueValue.plus(num(charge.unitPrice).times(w.quantity));
      if (!live.some((c) => c.sourceKey?.startsWith(`WARDISSUE:${w.id}`))) issueProblems.push(`${w.batch.medicine.brandName}: ${w.quantity} unit(s) drawn from a ward store but the charge is missing or voided`);
    }
    // Medicines sold at the counter during this admission are invoiced on their own: a return needs credit notes for its value.
    const counter = await db.dispense.findMany({
      where: { tenantId: T, patientId: adm.patientId, invoiceId: { not: null }, dispensedAt: { gte: adm.admittedAt } },
      select: { dispenseNumber: true, items: { select: { quantity: true, returnedQuantity: true, unitPrice: true } }, invoice: { select: { creditedTotal: true } } },
    });
    for (const d of counter) {
      issueCount++;
      let eligible = new Decimal(0);
      for (const i of d.items) {
        issueUnits += i.quantity; issueValue = issueValue.plus(num(i.unitPrice).times(i.quantity));
        returnUnits += i.returnedQuantity; returnValue = returnValue.plus(num(i.unitPrice).times(i.returnedQuantity));
        eligible = eligible.plus(num(i.unitPrice).times(i.returnedQuantity));
      }
      if (eligible.isZero()) continue;
      const raised = d.invoice ? num(d.invoice.creditedTotal) : new Decimal(0);
      creditEligible = creditEligible.plus(eligible); creditRaised = creditRaised.plus(raised.gt(eligible) ? eligible : raised);
      if (raised.lt(eligible)) creditProblems.push(`${d.dispenseNumber}: returned medicines worth ${fmt(eligible)} but credit notes cover only ${fmt(raised)}`);
    }

    const issuesOk = issueProblems.length === 0 && unresolvedRx === 0;
    const checks = [
      { name: "Issues", ok: issuesOk, detail: [issueCount === 0 ? "Nothing issued to this patient" : `${issueCount} issue(s), ${issueUnits} unit(s), ${fmt(issueValue)}`, unresolvedRx > 0 ? `${unresolvedRx} prescribed medicine(s) not yet fully dispensed` : "", ...issueProblems].filter(Boolean).join(" · ") },
      { name: "Returns", ok: returnProblems.length === 0, detail: returnProblems.length ? returnProblems.join(" · ") : returnUnits === 0 ? "No returns" : `${returnUnits} unit(s) returned (${fmt(returnValue)}), charges adjusted to match` },
      { name: "Eligible credits", ok: creditProblems.length === 0, detail: creditProblems.length ? creditProblems.join(" · ") : creditEligible.isZero() ? "No credits due" : `${fmt(creditEligible)} due, credit notes raised ${fmt(creditRaised)}` },
    ];
    const problems = [...issueProblems, ...returnProblems, ...creditProblems];
    return {
      problems, checks,
      summary: {
        issues: { count: issueCount, units: issueUnits, value: fmt(issueValue), unresolvedPrescribed: unresolvedRx },
        returns: { units: returnUnits, value: fmt(returnValue) },
        credits: { eligible: fmt(creditEligible), raised: fmt(creditRaised) },
        problems,
      },
    };
  }

  // ───── clear / waive ─────

  async clear(ctx: RequestContext, admissionId: string, input: z.infer<typeof clearSchema>) {
    const perm = { MEDICALLY_FIT: "ADMISSION_DISCHARGE", NURSING: "NURSING_DOCUMENT", CHARGES_REVIEWED: "CHARGE_CREATE", PHARMACY: "PHARMACY_DISPENSE" } as const;
    if (!ctx.permissions.has(perm[input.step])) throw new DomainError("FORBIDDEN", "You do not have permission to clear this step", 403);
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (input.step === "MEDICALLY_FIT") await this.clinicians.requireActive(tx, ctx);
      const have = await tx.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId } });
      if (have.some((c) => c.step === input.step)) throw new DomainError("CONFLICT", "This step is already cleared", 409);
      if (input.step !== "MEDICALLY_FIT" && !have.some((c) => c.step === "MEDICALLY_FIT")) throw new DomainError("DISCHARGE_BLOCKED", "The doctor must mark the patient medically fit first", 409);
      if (adm.finalInvoiceId && input.step === "CHARGES_REVIEWED") throw new DomainError("DISCHARGE_BLOCKED", "The final bill has already been issued", 409);

      if (input.step === "NURSING") {
        const ev = await this.evaluate(tx, ctx, adm);
        const nb = ev.steps.find((s) => s.step === "NURSING")!.blockers;
        if (nb.length) throw new DomainError("DISCHARGE_BLOCKED", `Nursing clearance blocked: ${nb.join("; ")}`, 409, { blockers: nb });
      }
      if (input.step === "PHARMACY") {
        // Issues, returns and credits must add up before the pharmacist signs the stage off (a mismatch can still be waived, with a reason).
        const ev = await this.evaluate(tx, ctx, adm);
        const problems = ev.steps.find((s) => s.step === "PHARMACY")!.reconciliation?.problems ?? [];
        if (problems.length) throw new DomainError("DISCHARGE_BLOCKED", `Pharmacy clearance blocked: ${problems.join("; ")}`, 409, { blockers: problems });
      }
      if (input.step === "CHARGES_REVIEWED") await this.charges.postBedDays(ctx, admissionId, tx);
      await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: input.step, status: "CLEARED", note: input.note ?? null, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_STEP_CLEARED", entityType: "Admission", entityId: admissionId, metadata: { step: input.step } });
      return this.evaluate(tx, ctx, adm);
    });
  }

  async waive(ctx: RequestContext, admissionId: string, input: z.infer<typeof waiveSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      const have = await tx.dischargeClearance.findMany({ where: { tenantId: ctx.tenantId, admissionId } });
      if (have.some((c) => c.step === input.step)) throw new DomainError("CONFLICT", "This step is already cleared or waived", 409);
      if (!have.some((c) => c.step === "MEDICALLY_FIT")) throw new DomainError("DISCHARGE_BLOCKED", "The doctor must mark the patient medically fit first", 409);
      await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: input.step, status: "WAIVED", note: input.reason, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_STEP_WAIVED", entityType: "Admission", entityId: admissionId, metadata: { step: input.step, reason: input.reason } });
      return this.evaluate(tx, ctx, adm);
    });
  }

  // ───── repair: put back a missing medicine charge ─────

  /**
   * Puts back a medicine charge that is missing (voided at billing by mistake, for example) so the pharmacy stage reconciles on its own, without a waiver.
   * Only while the final bill has not been issued: once it is, the bill is never touched and a doctor can waive the stage instead.
   */
  async repostPharmacyCharges(ctx: RequestContext, admissionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued, so a charge cannot be re-posted. A doctor can waive the stage instead.", 409);
      const T = ctx.tenantId;
      const charges = await tx.charge.findMany({
        where: { tenantId: T, admissionId, type: "MEDICINE", OR: [{ sourceKey: { startsWith: "DISPENSE_ITEM:" } }, { sourceKey: { startsWith: "WARDISSUE:" } }] },
        select: { status: true, quantity: true, unitPrice: true, description: true, sourceKey: true }, orderBy: { chargedAt: "asc" },
      });
      const itemOf = (c: { sourceKey: string | null }): string | undefined => (c.sourceKey?.startsWith("DISPENSE_ITEM:") ? c.sourceKey.split(":")[1] : undefined);
      const itemIds = [...new Set(charges.map(itemOf).filter((x): x is string => !!x))];
      const items = itemIds.length ? await tx.dispenseItem.findMany({ where: { tenantId: T, id: { in: itemIds } }, select: { id: true, quantity: true, returnedQuantity: true, medicine: { select: { brandName: true } } } }) : [];
      const reposted: { medicine: string; quantity: number }[] = [];
      const post = (base: (typeof charges)[number], quantity: number, key: string) => tx.charge.create({
        data: { tenantId: T, facilityId: ctx.facilityId, patientId: adm.patientId, admissionId, type: "MEDICINE", description: base.description, quantity: String(quantity), unitPrice: new Decimal(base.unitPrice.toString()).toFixed(2), taxPercent: "0", sourceKey: key, chargedById: ctx.userId },
      });
      for (const it of items) {
        const mine = charges.filter((c) => itemOf(c) === it.id);
        const liveQty = mine.filter((c) => c.status !== "VOIDED").reduce((a, c) => a + Number(c.quantity), 0);
        const missing = it.quantity - it.returnedQuantity - liveQty;
        if (missing > 0) { await post(mine[0]!, missing, `DISPENSE_ITEM:${it.id}:F${mine.length + 1}`); reposted.push({ medicine: it.medicine.brandName, quantity: missing }); }
      }
      const ward = await tx.stockLocationIssue.findMany({ where: { tenantId: T, admissionId }, select: { id: true, quantity: true, batch: { select: { medicine: { select: { brandName: true } } } } } });
      for (const w of ward) {
        const mine = charges.filter((c) => c.sourceKey?.startsWith(`WARDISSUE:${w.id}`));
        if (mine.length > 0 && !mine.some((c) => c.status !== "VOIDED")) { await post(mine[0]!, w.quantity, `WARDISSUE:${w.id}:F${mine.length + 1}`); reposted.push({ medicine: w.batch.medicine.brandName, quantity: w.quantity }); }
      }
      if (reposted.length === 0) throw new DomainError("INVALID_STATE", "No medicine charge is missing", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PHARMACY_CHARGES_REPOSTED", entityType: "Admission", entityId: admissionId, metadata: { items: reposted.length, units: reposted.reduce((a, r) => a + r.quantity, 0) } });
      const fresh = await tx.admission.findFirstOrThrow({ where: { id: admissionId, tenantId: T } });
      return { reposted, status: await this.evaluate(tx, ctx, fresh) };
    });
  }

  // ───── final bill ─────

  /** Bills every pending charge (including bed days) on one invoice. The charges become BILLED and can never be billed again. */
  async finalInvoice(ctx: RequestContext, admissionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (adm.finalInvoiceId) throw new DomainError("CONFLICT", "The final bill has already been issued", 409);
      const ev = await this.evaluate(tx, ctx, adm);
      const preBilling = ev.steps.filter((s) => s.required && s.step !== "BILLING" && s.step !== "FINANCIAL_RELEASE" && s.status === "PENDING");
      if (preBilling.length) throw new DomainError("DISCHARGE_BLOCKED", `Clear these steps before billing: ${preBilling.map((s) => s.step.toLowerCase().replace(/_/g, " ")).join(", ")}`, 409);

      await this.charges.postBedDays(ctx, admissionId, tx);
      const pending = await tx.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING" }, orderBy: { chargedAt: "asc" } });
      const total = pending.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
      if (pending.length === 0 || !total.gt(0)) {
        const have = await tx.dischargeClearance.findFirst({ where: { tenantId: ctx.tenantId, admissionId, step: "BILLING" } });
        if (!have) await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: "BILLING", status: "CLEARED", note: "No chargeable items", byId: ctx.userId } });
        return { invoice: null, status: await this.evaluate(tx, ctx, adm) };
      }
      const sacById = new Map((await tx.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(pending.flatMap((c) => (c.serviceId ? [c.serviceId] : [])))] } }, select: { id: true, sacCode: true } })).map((s) => [s.id, s.sacCode]));
      const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: adm.patientId, encounterId: adm.encounterId, kind: "IPD", notes: `Final bill for admission ${adm.admissionNumber}`,
        lines: pending.map((c) => ({ description: c.description, quantity: new Decimal(c.quantity.toString()), unitPrice: new Decimal(c.unitPrice.toString()), taxPercent: new Decimal(c.taxPercent.toString()), sourceType: "CHARGE", sourceId: c.id, hsnSac: c.serviceId ? sacById.get(c.serviceId) ?? null : null })),
      });
      const billed = await tx.charge.updateMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING", id: { in: pending.map((c) => c.id) } }, data: { status: "BILLED", invoiceId: inv.id } });
      if (billed.count !== pending.length) throw new DomainError("INVALID_STATE", "Charges changed while billing; try again", 409);
      await tx.admission.updateMany({ where: { id: admissionId, tenantId: ctx.tenantId, status: "ADMITTED", finalInvoiceId: null }, data: { finalInvoiceId: inv.id, version: { increment: 1 } } });
      await this.audit.record(tx, actorOf(ctx), { action: "FINAL_INVOICE_CREATED", entityType: "Admission", entityId: admissionId, metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, charges: pending.length, total: fmt(inv.total) } });
      const fresh = await tx.admission.findFirstOrThrow({ where: { id: admissionId, tenantId: ctx.tenantId } });
      return { invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, total: fmt(inv.total) }, status: await this.evaluate(tx, ctx, fresh) };
    });
  }

  // ───── supplementary bill (late charges) ─────

  /**
   * Bills the charges that arrived after the final bill on their own small invoice. The final bill is never altered: each batch is a new issued invoice,
   * numbered 1, 2, 3 for the admission (docs/discharge-flow.md). Refused until the final bill exists, and when nothing late is waiting.
   */
  async supplementaryInvoice(ctx: RequestContext, admissionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      if (!adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "Generate the final bill first: a supplementary bill is only for charges that arrive after it", 409);
      const pending = await tx.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING" }, orderBy: [{ chargedAt: "asc" }, { id: "asc" }] });
      if (pending.length === 0) throw new DomainError("INVALID_STATE", "There are no late charges to bill", 409);
      const sacById = new Map((await tx.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(pending.flatMap((c) => (c.serviceId ? [c.serviceId] : [])))] } }, select: { id: true, sacCode: true } })).map((x) => [x.id, x.sacCode]));
      const sequence = (await tx.supplementaryBill.count({ where: { tenantId: ctx.tenantId, admissionId } })) + 1;
      const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: adm.patientId, encounterId: adm.encounterId, kind: "IPD", notes: `Supplementary bill ${sequence} for admission ${adm.admissionNumber}: charges after the final bill`,
        lines: pending.map((c) => ({ description: c.description, quantity: new Decimal(c.quantity.toString()), unitPrice: new Decimal(c.unitPrice.toString()), taxPercent: new Decimal(c.taxPercent.toString()), sourceType: "CHARGE", sourceId: c.id, hsnSac: c.serviceId ? sacById.get(c.serviceId) ?? null : null })),
      });
      const billed = await tx.charge.updateMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING", id: { in: pending.map((c) => c.id) } }, data: { status: "BILLED", invoiceId: inv.id } });
      if (billed.count !== pending.length) throw new DomainError("INVALID_STATE", "Charges changed while billing; try again", 409);
      await tx.supplementaryBill.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, invoiceId: inv.id, sequence, charges: pending.length, createdById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "SUPPLEMENTARY_INVOICE_CREATED", entityType: "Admission", entityId: admissionId, metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, sequence, charges: pending.length, total: fmt(inv.total) } });
      return { invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, total: fmt(inv.total), sequence }, status: await this.evaluate(tx, ctx, adm) };
    });
  }

  /**
   * The bill so far, during the stay: every charge waiting to be billed (and what it comes to), the bills already issued, and whether the final bill can be
   * generated yet. Nothing is posted or changed: it only reads. Bed days not yet posted are added when the final bill is generated.
   */
  async billPreview(ctx: RequestContext, admissionId: string) {
    const adm = await this.prisma.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } });
    if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const [st, pending, supplementary, invoice] = await Promise.all([
      this.evaluate(this.prisma, ctx, adm),
      this.prisma.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId, status: "PENDING" }, orderBy: [{ chargedAt: "asc" }, { id: "asc" }] }),
      this.prisma.supplementaryBill.findMany({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: { sequence: "asc" }, select: { sequence: true, invoice: { select: { id: true, invoiceNumber: true, status: true, total: true } } } }),
      adm.finalInvoiceId ? this.prisma.invoice.findFirst({ where: { id: adm.finalInvoiceId, tenantId: ctx.tenantId }, select: { id: true, invoiceNumber: true, status: true, total: true } }) : Promise.resolve(null),
    ]);
    const lines = pending.map((c) => ({ id: c.id, description: c.description, quantity: c.quantity.toString(), total: fmt(chargeAmounts(c).total), late: !!invoice }));
    const total = pending.reduce((a, c) => a.plus(chargeAmounts(c).total), new Decimal(0));
    const notReady = st.steps.filter((s) => s.required && s.step !== "BILLING" && s.step !== "FINANCIAL_RELEASE" && s.status === "PENDING").map((s) => ({ step: s.step, stage: s.stage, blockers: s.blockers }));
    return {
      admissionId, finalBill: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, total: fmt(invoice.total) } : null,
      // Before the final bill these are the charges it will carry; after it, they are late charges waiting for a supplementary bill.
      waiting: { kind: invoice ? "LATE" : "FINAL", count: lines.length, total: fmt(total), lines },
      supplementaryBills: supplementary.map((b) => ({ sequence: b.sequence, id: b.invoice.id, invoiceNumber: b.invoice.invoiceNumber, status: b.invoice.status, total: fmt(b.invoice.total) })),
      // "Not ready yet": the final bill is generated only when these are cleared, so it is right the first time.
      finalBillReady: !invoice && adm.status === "ADMITTED" && notReady.length === 0, notReady: invoice ? [] : notReady,
    };
  }

  // ───── complete ─────

  /** Completes the discharge: closes the admission and visit and releases the bed, all or nothing. */
  /** Physical exit: not due while admitted; pending once discharged until the departure is confirmed; not applicable when the patient absconded or the admission was cancelled. */
  private exitView(adm: { status: string; dischargedAt: Date | null; dischargeType: string | null }, d: { departedAt: Date; mode: string; escortedBy: string | null; note: string | null; confirmedAt: Date } | null, byName: string | null) {
    const absconded = adm.dischargeType === "ABSCONDED";
    const status = d ? "CONFIRMED" : adm.status === "ADMITTED" ? "NOT_DUE" : adm.status === "DISCHARGED" && !absconded ? "PENDING" : "NOT_APPLICABLE";
    const hisStatus = status === "CONFIRMED" ? "Actual departure confirmed" : status === "PENDING" ? "Departure not yet confirmed" : status === "NOT_DUE" ? "Awaiting discharge" : absconded ? "Not applicable: the patient absconded" : "Not applicable";
    return {
      ...EXIT_STAGE, status, hisStatus,
      departedAt: d?.departedAt ?? null, mode: d?.mode ?? null, modeLabel: d ? MODE_LABEL[d.mode] ?? d.mode : null, escortedBy: d?.escortedBy ?? null, note: d?.note ?? null,
      byName, at: d?.confirmedAt ?? null,
      minutesAfterDischarge: d && adm.dischargedAt ? Math.max(0, Math.round((d.departedAt.getTime() - adm.dischargedAt.getTime()) / 60_000)) : null,
    };
  }

  /**
   * Releases the admission's bed (to cleaning, or straight to available where the hospital skips cleaning) and opens its bed turnover at `at`.
   * Returns whether a bed was released (false when it already was).
   */
  private async vacateBed(tx: Db, ctx: RequestContext, admissionId: string, at: Date): Promise<boolean> {
    const bedStatus = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BED_AFTER_DISCHARGE");
    const bedId = await this.admissions.releaseBed(tx, ctx, admissionId, bedStatus as "CLEANING" | "AVAILABLE", at);
    if (!bedId) return false;
    const auto = bedStatus === "AVAILABLE";
    await tx.bedTurnover.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, bedId, admissionId, vacatedAt: at, autoReady: auto, ...(auto ? { cleaningStartedAt: at, readyAt: at } : {}) } });
    return true;
  }

  /** Bed turnover: not due while admitted; then vacated, cleaning, ready; not applicable when no bed was vacated by a discharge (a cancelled admission). */
  private turnoverView(adm: { status: string }, t: { vacatedAt: Date; cleaningStartedAt: Date | null; cleaningStartedById: string | null; readyAt: Date | null; readyById: string | null; autoReady: boolean; bed: { code: string; ward: { name: string } } } | null, names: Map<string, string>, heldBed: string | null = null) {
    const status = t ? (t.readyAt ? "READY" : t.cleaningStartedAt ? "CLEANING" : "VACATED") : adm.status === "ADMITTED" ? "NOT_DUE" : heldBed ? "AWAITING_DEPARTURE" : "NOT_APPLICABLE";
    const hisStatus = status === "READY" ? (t?.autoReady ? "Ready (no cleaning step at this hospital)" : "Ready for the next patient") : status === "CLEANING" ? "Cleaning in progress" : status === "VACATED" ? "Vacated: cleaning not started" : status === "NOT_DUE" ? "Awaiting discharge" : status === "AWAITING_DEPARTURE" ? "Bed kept until the patient leaves" : "Not applicable";
    return {
      ...TURNOVER_STAGE, status, hisStatus,
      bed: t ? `${t.bed.ward.name} · ${t.bed.code}` : heldBed,
      vacatedAt: t?.vacatedAt ?? null,
      cleaningStartedAt: t?.cleaningStartedAt ?? null, cleaningStartedBy: t?.cleaningStartedById ? names.get(t.cleaningStartedById) ?? null : null,
      readyAt: t?.readyAt ?? null, readyBy: t?.readyById ? names.get(t.readyById) ?? null : null,
      minutesToReady: t?.readyAt ? Math.round((t.readyAt.getTime() - t.vacatedAt.getTime()) / 60_000) : null,
    };
  }

  /**
   * Post-discharge (docs/discharge-stages.md): the Medical Records Department signs off the record of a discharged stay, once the record is ready:
   * the summary signed (and verified where the hospital requires it), no drafts left open, and the departure recorded. Once; audited.
   */
  async completeRecords(ctx: RequestContext, admissionId: string, input: z.infer<typeof completeRecordsSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${admissionId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      const adm = locked.length ? await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } }) : null;
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "DISCHARGED") throw new DomainError("INVALID_STATE", "The record is completed after the patient is discharged", 409);
      const ev = await this.evaluate(tx, ctx, adm);
      const p = ev.postDischarge;
      if (p.recordCompletedAt) throw new DomainError("CONFLICT", "The record has already been signed off", 409);
      if (!p.recordReady) {
        const missing = p.checks.filter((c) => !c.ok && ["Discharge summary", "Clinical documents", "Departure"].includes(c.name)).map((c) => `${c.name.toLowerCase()}: ${c.detail.toLowerCase()}`);
        throw new DomainError("INVALID_STATE", `The record is not complete yet (${missing.join("; ")})`, 409, { missing });
      }
      await tx.medicalRecordCompletion.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, completedById: ctx.userId, note: input.note ?? null } });
      // The coded diagnoses: the one marked primary, or else the first, is the primary diagnosis.
      const primaryAt = Math.max(0, input.codes.findIndex((c) => c.primary));
      await tx.medicalRecordCode.createMany({ data: input.codes.map((c, i) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, diagnosis: c.diagnosis, icd10: c.icd10, primary: i === primaryAt, codedById: ctx.userId })) });
      await this.audit.record(tx, actorOf(ctx), { action: "MEDICAL_RECORD_COMPLETED", entityType: "Admission", entityId: admissionId, metadata: { claimOpen: !!p.claim?.open, patientReceivable: p.receivables.patient, insurerReceivable: p.receivables.insurer, icd10: input.codes.map((c) => c.icd10) } });
    });
    return (await this.status(ctx, admissionId)).postDischarge;
  }

  /**
   * Moves the paper record of a discharged stay (docs/discharge-stages.md, post-discharge): received in MRD, filed (where), issued (to whom), returned.
   * Only in that order; append-only; audited.
   */
  async moveRecordFile(ctx: RequestContext, admissionId: string, input: z.infer<typeof recordFileSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${admissionId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      const adm = locked.length ? await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] }, select: { status: true } }) : null;
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "DISCHARGED") throw new DomainError("INVALID_STATE", "The record file is tracked after the patient is discharged", 409);
      const last = await tx.medicalRecordFileMovement.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, orderBy: [{ at: "desc" }, { id: "desc" }], select: { action: true } });
      const allowed = NEXT_FILE_ACTIONS[last?.action ?? "NONE"] ?? [];
      if (!allowed.includes(input.action)) throw new DomainError("INVALID_STATE", `The record file cannot be ${input.action.toLowerCase()} now (next: ${allowed.map((a) => a.toLowerCase()).join(" or ")})`, 409, { allowed });
      if (input.action === "FILED" && !input.location) throw new DomainError("VALIDATION_FAILED", "Say where the record is filed", 400, [{ path: "location", message: "Required" }]);
      if (input.action === "ISSUED" && !input.issuedTo) throw new DomainError("VALIDATION_FAILED", "Say who the record is issued to", 400, [{ path: "issuedTo", message: "Required" }]);
      await tx.medicalRecordFileMovement.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, action: input.action, location: input.action === "FILED" ? input.location ?? null : null, issuedTo: input.action === "ISSUED" ? input.issuedTo ?? null : null, note: input.note ?? null, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "MEDICAL_RECORD_FILE_MOVED", entityType: "Admission", entityId: admissionId, metadata: { action: input.action, ...(input.location ? { location: input.location } : {}), ...(input.issuedTo ? { issuedTo: input.issuedTo } : {}) } });
    });
    return (await this.status(ctx, admissionId)).postDischarge;
  }

  /**
   * Physical exit (docs/discharge-stages.md): the ward nurse or patient transport confirms that a discharged patient actually left, when, how and with whom.
   * Only after the doctor has completed the discharge, once, never for a patient who absconded; the time is not before the discharge and not in the future.
   * A death is recorded as the body released, and only a death. The record is never changed; it is audited.
   */
  async confirmDeparture(ctx: RequestContext, admissionId: string, input: z.infer<typeof confirmDepartureSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${admissionId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      const adm = locked.length ? await tx.admission.findFirst({ where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] } }) : null;
      if (!adm) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (adm.status !== "DISCHARGED" || !adm.dischargedAt) throw new DomainError("INVALID_STATE", "The doctor must complete the discharge before the departure is confirmed", 409);
      if (adm.dischargeType === "ABSCONDED") throw new DomainError("INVALID_STATE", "The patient absconded: there is no departure to confirm", 409);
      if (await tx.admissionDeparture.findFirst({ where: { tenantId: ctx.tenantId, admissionId }, select: { id: true } })) throw new DomainError("CONFLICT", "The departure has already been confirmed", 409);
      const death = adm.dischargeType === "DEATH";
      if (death !== (input.mode === "BODY_RELEASED")) throw new DomainError("VALIDATION_FAILED", death ? "For a death, record the body as released" : "Body released is only for a death", 400, [{ path: "mode", message: "Not valid for this discharge" }]);
      const now = new Date();
      const departedAt = input.departedAt ? new Date(input.departedAt) : now;
      if (departedAt < adm.dischargedAt) throw new DomainError("VALIDATION_FAILED", "The patient cannot leave before the discharge was completed", 400, [{ path: "departedAt", message: "Before the discharge" }]);
      if (departedAt.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("VALIDATION_FAILED", "The departure cannot be in the future", 400, [{ path: "departedAt", message: "In the future" }]);
      const d = await tx.admissionDeparture.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, departedAt, mode: input.mode, escortedBy: input.escortedBy ?? null, note: input.note ?? null, confirmedById: ctx.userId } });
      const minutes = Math.max(0, Math.round((departedAt.getTime() - adm.dischargedAt.getTime()) / 60_000));
      // The patient has left: the bed they kept until now is released for cleaning (if it was not released at discharge).
      const bedReleased = await this.vacateBed(tx, ctx, admissionId, departedAt);
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_DEPARTURE_CONFIRMED", entityType: "Admission", entityId: admissionId, metadata: { departedAt: departedAt.toISOString(), mode: input.mode, minutesAfterDischarge: minutes, bedReleased } });
      const by = await tx.user.findFirst({ where: { tenantId: ctx.tenantId, id: ctx.userId }, select: { fullName: true } });
      return this.exitView(adm, d, by?.fullName ?? null);
    });
  }

  /**
   * Financial release as an authorised exception (docs/discharge-stages.md): someone with DISCHARGE_FINANCIAL_EXCEPTION lets the patient leave although final
   * billing is not reconciled (money still owed, a deposit not yet returned, an overpayment not yet refunded). Only after the doctor's decision and the final
   * bill; never when nothing is outstanding (the stage then clears by itself). The outstanding amounts at that moment are kept with the reason and audited.
   * Final billing keeps showing what is outstanding; the bill itself is not changed.
   */
  async authoriseFinancialException(ctx: RequestContext, admissionId: string, input: z.infer<typeof financialExceptionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      const ev = await this.evaluate(tx, ctx, adm);
      const step = (k: string) => ev.steps.find((s) => s.step === k)!;
      if (step("MEDICALLY_FIT").status === "PENDING") throw new DomainError("DISCHARGE_BLOCKED", "The doctor must mark the patient medically fit first", 409);
      if (step("FINANCIAL_RELEASE").status !== "PENDING") throw new DomainError("CONFLICT", step("FINANCIAL_RELEASE").status === "WAIVED" ? "An exception has already been authorised" : "Nothing is outstanding: financial release has cleared by itself", 409);
      if (!adm.finalInvoiceId) throw new DomainError("DISCHARGE_BLOCKED", "Generate the final bill first: an exception is for money outstanding on it", 409);
      const r = step("BILLING").reconciliation as { patientLiability: string; insurerShare: string; overpaid: string; deposits: { unapplied: string } } | null;
      const outstanding = { patientLiability: r?.patientLiability ?? "0.00", unappliedDeposits: r?.deposits.unapplied ?? "0.00", overpaid: r?.overpaid ?? "0.00", insurerShare: r?.insurerShare ?? "0.00" };
      const note = `${input.reason} (outstanding at release: patient owes ${outstanding.patientLiability}; deposits unapplied ${outstanding.unappliedDeposits}; overpaid ${outstanding.overpaid})`;
      await tx.dischargeClearance.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, admissionId, step: "FINANCIAL_RELEASE", status: "WAIVED", note, byId: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DISCHARGE_FINANCIAL_EXCEPTION_AUTHORISED", entityType: "Admission", entityId: admissionId, metadata: { reason: input.reason, invoiceId: adm.finalInvoiceId, ...outstanding } });
      return this.evaluate(tx, ctx, adm);
    });
  }

  async complete(ctx: RequestContext, admissionId: string, input: z.infer<typeof completeSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const adm = await this.lockAdmission(tx, ctx, admissionId);
      await this.clinicians.requireActive(tx, ctx);
      const ev = await this.evaluate(tx, ctx, adm);
      if (!ev.canComplete) throw new DomainError("DISCHARGE_BLOCKED", `Discharge cannot be completed: ${ev.blockers.join("; ")}`, 409, { blockers: ev.blockers });
      const now = new Date();
      // The bed stays with the patient until they actually leave (physical exit); a patient who absconded has no departure, and a hospital may choose to
      // release beds at discharge (BED_RELEASE_AT). Either way the release opens the bed turnover.
      const releaseAt = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "BED_RELEASE_AT");
      const bedReleased = releaseAt === "DISCHARGE" || input.type === "ABSCONDED" ? await this.vacateBed(tx, ctx, admissionId, now) : false;
      const res = await tx.admission.updateMany({
        where: { id: admissionId, tenantId: ctx.tenantId, status: "ADMITTED" },
        data: { status: "DISCHARGED", dischargedAt: now, dischargeType: input.type, dischargeNote: input.note ?? null, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "The admission was changed by someone else", 409);
      await this.encounters.transition(tx, ctx, adm.encounterId, "COMPLETED");
      await this.aftercare.createForDischarge(tx, ctx, { id: adm.id, patientId: adm.patientId, encounterId: adm.encounterId }, input.type, now);
      await this.audit.record(tx, actorOf(ctx), { action: "ADMISSION_DISCHARGED", entityType: "Admission", entityId: admissionId, metadata: { type: input.type, bedReleased } });
      return this.admissions.view(tx, ctx, admissionId);
    });
  }

  // ───── internals ─────

  /** Row-locks the admission so clearances, billing and completion for one patient are serialised. */
  private async lockAdmission(tx: Db, ctx: RequestContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Admission" WHERE id = ${id}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const adm = await tx.admission.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
    if (adm.status !== "ADMITTED") throw new DomainError("INVALID_STATE", "This admission is already closed", 409);
    return adm;
  }
}
