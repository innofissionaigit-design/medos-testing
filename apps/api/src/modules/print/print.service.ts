import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScope, visitScope } from "../../common/data-scope";
import { chartPatientIds } from "../patients/patient-links";
import { AdvancesService } from "../billing/advances.service";
import type { ConsultationContent } from "../clinical/consultations.service";
import { InvoicesService } from "../billing/invoices.service";
import { PaymentsService } from "../billing/payments.service";
import { SummaryService, type SummaryContent } from "../discharge/summary.service";
import { PayoutsService } from "../earnings/payouts.service";
import { LabService } from "../lab/lab.service";
import { RadiologyService } from "../radiology/radiology.service";
import { ClaimsService } from "../claims/claims.service";
import { PayrollService } from "../payroll/payroll.service";
import { SettingsService } from "../settings/settings.service";
import { toHtml, type Block, type Doc } from "./doc";
import type { PrintHeader } from "./html";
import { FORM_TEXT, type FormLang } from "./admission-form-text";
import { toPdf } from "./pdf";

type DocType = "INVOICE" | "RECEIPT" | "ADVANCE_RECEIPT" | "PRESCRIPTION" | "DISCHARGE_SUMMARY" | "PATIENT_LABEL" | "ADMISSION_FORM" | "PAYOUT_VOUCHER" | "LAB_REPORT" | "LAB_LABEL" | "RAD_REPORT" | "CLAIM_FORM" | "PAYSLIP";
export type PrintFormat = "html" | "pdf";
export interface Rendered { contentType: string; body: string | Buffer; fileName: string }

const notFound = () => new DomainError("NOT_FOUND", "Resource not found", 404);
const fullName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const FREQ: Record<string, string> = { OD: "Once daily", BD: "Twice daily", TDS: "Three times daily", QID: "Four times daily", HS: "At bedtime", SOS: "If needed", STAT: "Immediately", OTHER: "As directed" };
const FOOD: Record<string, string> = { BEFORE_FOOD: "Before food", AFTER_FOOD: "After food", WITH_FOOD: "With food", EMPTY_STOMACH: "Empty stomach", ANY_TIME: "Any time" };
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

@Injectable()
export class PrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly advances: AdvancesService,
    private readonly summaries: SummaryService,
    private readonly payouts: PayoutsService,
    private readonly lab: LabService,
    private readonly rad: RadiologyService,
    private readonly claims: ClaimsService,
    private readonly payroll: PayrollService,
  ) {}

  private async env(ctx: RequestContext) {
    const [facility, header, footer, user] = await Promise.all([
      this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId } }),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRINT_HEADER"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRINT_FOOTER"),
      this.prisma.user.findFirst({ where: { id: ctx.userId, tenantId: ctx.tenantId }, select: { fullName: true } }),
    ]);
    const fallback: PrintHeader = {
      hospitalName: facility.name, address: [facility.address, facility.city, facility.state, facility.postalCode].filter(Boolean).join(", ") || undefined,
      phone: facility.phone ?? undefined, email: facility.email ?? undefined, gstin: facility.gstin ?? undefined,
    };
    const tz = facility.timezone;
    const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
    const fmtDay = new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "medium" });
    return {
      header: (header as PrintHeader | null) ?? fallback, footer: footer as Record<string, string | undefined>, printedBy: user?.fullName ?? "-",
      at: (d: Date | null | undefined) => (d ? fmt.format(d) : ""), day: (d: Date | null | undefined) => (d ? fmtDay.format(d) : ""), now: fmt.format(new Date()),
    };
  }

  /** Every print is audited (once per request, whatever the format); a second print of the same record is stamped as a duplicate. */
  private async finish(ctx: RequestContext, type: DocType, entityType: string, entityId: string, format: PrintFormat, build: (banner: string | undefined) => Doc, quiet = false): Promise<Rendered> {
    // A copy a patient opens from a shared link is not a print by staff: no audit entry of its own (the share records the opening) and no duplicate stamp.
    const doc = quiet ? build(undefined) : await this.prisma.$transaction(async (tx) => {
      const prior = await tx.auditEvent.count({ where: { tenantId: ctx.tenantId, action: "DOCUMENT_PRINTED", entityType, entityId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DOCUMENT_PRINTED", entityType, entityId, metadata: { documentType: type, format, copy: prior + 1 } });
      return build(prior > 0 ? "DUPLICATE COPY" : undefined);
    });
    return format === "pdf"
      ? { contentType: "application/pdf", body: await toPdf(doc), fileName: `${doc.fileBase}.pdf` }
      : { contentType: "text/html; charset=utf-8", body: toHtml(doc), fileName: `${doc.fileBase}.html` };
  }

  async invoice(ctx: RequestContext, invoiceId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const inv = await this.invoices.get(ctx, invoiceId);
    if (inv.status === "DRAFT") throw new DomainError("INVALID_STATE", "Issue the invoice before printing it", 409);
    const e = await this.env(ctx);
    return this.finish(ctx, "INVOICE", "Invoice", inv.id, format, (dup) => ({
      title: `Invoice ${inv.invoiceNumber}`, fileBase: `invoice-${slug(str(inv.invoiceNumber))}`, header: e.header, footer: e.footer.invoice, printedBy: e.printedBy, printedAt: e.now,
      banner: inv.status === "CANCELLED" ? "CANCELLED" : dup,
      blocks: [
        { t: "title", text: `Invoice ${str(inv.invoiceNumber)}` },
        { t: "kv", rows: [["Patient", inv.patientName], ["MRN", inv.mrn], ["Date", e.at(inv.issuedAt)], ["Status", inv.status]] },
        // The HSN/SAC column appears only when at least one line carries a code (nothing is invented for lines without one).
        { t: "table", head: [{ label: "#" }, { label: "Description" }, ...(inv.lines.some((l) => l.hsnSac) ? [{ label: "HSN/SAC" }] : []), { label: "Qty", numeric: true }, { label: "Rate", numeric: true }, { label: "Disc.", numeric: true }, { label: "Tax %", numeric: true }, { label: "Amount", numeric: true }],
          rows: inv.lines.map((l) => [str(l.lineNo), l.description, ...(inv.lines.some((x) => x.hsnSac) ? [l.hsnSac ?? ""] : []), l.quantity, l.unitPrice, l.discountAmount, l.taxPercent, l.lineTotal]) },
        { t: "table", head: [{ label: "Summary" }, { label: "INR", numeric: true }], rows: [["Subtotal", inv.subtotal], ["Discount", inv.discountTotal], ["Tax", inv.taxTotal], ["Total", inv.total], ["Paid", inv.paidTotal], ["Refunded", inv.refundedTotal], ["Credit notes", inv.creditedTotal], ["Balance due", inv.balanceDue]] },
        ...(inv.notes ? [{ t: "para", text: inv.notes } as Block] : []),
      ],
    }));
  }

  async receipt(ctx: RequestContext, receiptId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const r = await this.payments.getReceipt(ctx, receiptId);
    const e = await this.env(ctx);
    return this.finish(ctx, "RECEIPT", "Receipt", r.id, format, (banner) => ({
      title: `Receipt ${r.receiptNumber}`, fileBase: `receipt-${slug(r.receiptNumber)}`, header: e.header, footer: e.footer.receipt, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: `Receipt ${r.receiptNumber}` },
        { t: "kv", rows: [["Patient", r.patientName], ["MRN", r.mrn], ["Invoice", r.invoiceNumber], ["Date", e.at(r.receivedAt)], ["Received by", r.receivedBy]] },
        { t: "table", head: [{ label: "Mode" }, { label: "Reference" }, { label: "INR", numeric: true }], rows: [...r.payments.map((p) => [p.method, p.reference ?? "", p.amount]), ["Total", "", r.total]] },
      ],
    }));
  }

  /** Receipt for money taken in advance. It shows what was received; the balance line is the position when it is printed. */
  async advanceReceipt(ctx: RequestContext, depositId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const a = await this.advances.get(ctx, depositId);
    const e = await this.env(ctx);
    return this.finish(ctx, "ADVANCE_RECEIPT", "AdvanceDeposit", a.id, format, (banner) => ({
      title: `Advance receipt ${a.receiptNumber}`, fileBase: `advance-receipt-${slug(a.receiptNumber)}`, header: e.header, footer: e.footer.receipt, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: `Advance receipt ${a.receiptNumber}` },
        { t: "kv", rows: [["Patient", a.patientName], ["MRN", a.mrn], ["Date", e.at(a.receivedAt)], ["Received by", a.receivedBy], ...(a.note ? [["Note", a.note] as [string, string]] : [])] },
        { t: "table", head: [{ label: "Mode" }, { label: "Reference" }, { label: "INR", numeric: true }], rows: [...a.tenders.map((t) => [t.method, t.reference ?? "", t.amount]), ["Total received", "", a.amount]] },
        { t: "para", text: "This is an advance, not a payment for a bill. It is kept for you and set against your bill when it is raised; any part not used is returned to you." },
        { t: "table", head: [{ label: "Position when printed" }, { label: "INR", numeric: true }], rows: [["Received", a.amount], ["Used for bills", a.used], ["Returned from refunded bills", a.returned], ["Given back to you", a.refunded], ["Balance held", a.balance]] },
      ],
    }));
  }

  /** Prints the doctor's signed prescription for an OPD or IPD encounter. Drafts are never printable. */
  async prescription(ctx: RequestContext, encounterId: string, format: PrintFormat = "html", opts: { quiet?: boolean } = {}): Promise<Rendered> {
    const enc = await this.prisma.encounter.findFirst({
      where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] },
      include: { patient: { include: { identifiers: { where: { type: "MRN" } } } }, practitioner: { select: { displayName: true, specialty: true, registrationNo: true } } },
    });
    if (!enc) throw notFound();
    const order = await this.prisma.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED", source: "DIGITAL" }, include: { items: { orderBy: { lineNo: "asc" } } }, orderBy: { signedAt: "desc" } });
    // The signed consultation is what the prescription is printed from: its complaint, diagnosis, tests, advice and follow-up as they were signed.
    const doc = await this.prisma.clinicalDocument.findFirst({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION", status: { not: "DRAFT" } } });
    if (!order && !doc) throw new DomainError("INVALID_STATE", "There is no signed prescription to print", 409);
    const note = doc ? ((await this.prisma.clinicalDocumentVersion.findFirst({ where: { tenantId: ctx.tenantId, documentId: doc.id, version: doc.currentVersion } }))?.content ?? {}) as ConsultationContent : {};
    const diagnoses = doc ? await this.prisma.diagnosis.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "ACTIVE" }, orderBy: { recordedAt: "asc" }, select: { text: true, code: true, type: true } }) : [];
    const vitals = await this.prisma.observation.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "FINAL" }, orderBy: { recordedAt: "desc" }, select: { type: true, value: true, unit: true } });
    const latestVitals = [...new Map(vitals.map((v) => [v.type, v])).values()];
    const signedAt = order?.signedAt ?? doc?.signedAt ?? null;
    const signerId = order?.signedById ?? doc?.signedById ?? null;
    const signer = signerId ? await this.prisma.user.findFirst({ where: { id: signerId, tenantId: ctx.tenantId }, select: { fullName: true } }) : null;
    const rxNumber = order?.orderNumber ?? enc.encounterNumber;
    const paragraph = (title: string, text: string | undefined): Block[] => (text?.trim() ? [{ t: "heading", text: title } as Block, { t: "para", text: text } as Block] : []);
    const allergies = await this.prisma.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, enc.patientId)) ?? [enc.patientId] }, status: "ACTIVE" }, select: { allergen: true } });
    const e = await this.env(ctx);
    const p = enc.patient;
    const follow = note.followUp?.date ? e.day(new Date(`${note.followUp.date}T00:00:00Z`)) : note.followUp?.afterDays && signedAt ? e.day(new Date(signedAt.getTime() + note.followUp.afterDays * 86_400_000)) : null;
    return this.finish(ctx, "PRESCRIPTION", "MedicationOrder", order?.id ?? doc!.id, format, (banner) => ({
      title: `Prescription ${rxNumber}`, fileBase: `prescription-${slug(str(rxNumber))}`, header: e.header, footer: e.footer.prescription, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: `Prescription ${str(rxNumber)}` },
        { t: "kv", rows: [["Patient", fullName(p)], ["MRN", p.identifiers[0]?.value], ["Gender", p.gender], ["Age/DOB", p.dateOfBirth ? e.day(p.dateOfBirth) : p.estimatedAgeYears ? `~${p.estimatedAgeYears} y` : ""], ["Encounter", enc.encounterNumber], ["Date", e.at(signedAt)], ["Doctor", [enc.practitioner?.displayName ?? signer?.fullName, enc.practitioner?.specialty].filter(Boolean).join(", ")], ["Registration no.", enc.practitioner?.registrationNo]] },
        ...(allergies.length ? [{ t: "note", text: `Known allergies: ${allergies.map((a) => a.allergen).join(", ")}` } as Block] : []),
        ...(latestVitals.length ? [{ t: "para", text: `Vitals: ${latestVitals.map((v) => `${v.type.replace(/_/g, " ").toLowerCase()} ${new Decimal(v.value.toString()).toFixed(v.unit === "°C" || v.unit === "kg" ? 1 : 0)} ${v.unit}`).join(" · ")}` } as Block] : []),
        ...paragraph("Complaint", note.chiefComplaint), ...paragraph("History", note.historyOfPresentIllness), ...paragraph("Past history", note.pastHistory), ...paragraph("Examination", note.examination),
        ...(diagnoses.length ? [{ t: "heading", text: "Diagnosis" } as Block, { t: "table", head: [{ label: "Diagnosis" }, { label: "Code" }, { label: "Type" }], rows: diagnoses.map((d) => [d.text, d.code ?? "", d.type.toLowerCase()]) } as Block] : []),
        ...(order && order.items.length ? [{ t: "heading", text: "Medicines" } as Block, { t: "table", head: [{ label: "#" }, { label: "Medicine" }, { label: "Dose" }, { label: "Route" }, { label: "Frequency" }, { label: "Food" }, { label: "Days", numeric: true }, { label: "Instructions" }],
          rows: order.items.map((i) => [str(i.lineNo), [i.brandName ?? i.genericName, i.brandName ? `(${i.genericName})` : "", i.strength ?? ""].filter(Boolean).join(" ") + (i.status === "STOPPED" ? " [STOPPED]" : ""), i.dosage, i.route, i.frequency === "OTHER" && i.frequencyText ? i.frequencyText : FREQ[i.frequency] ?? i.frequency, i.foodRelation ? FOOD[i.foodRelation] ?? "" : "", str(i.durationDays), i.instructions ?? ""]) } as Block] : []),
        ...(note.investigationsAdvised?.length ? [{ t: "heading", text: "Laboratory investigations" } as Block, { t: "table", head: [{ label: "#" }, { label: "Test" }], rows: note.investigationsAdvised.map((t, n) => [str(n + 1), t]) } as Block] : []),
        ...(note.otherTestsAdvised?.length ? [{ t: "heading", text: "Radiology / imaging" } as Block, { t: "table", head: [{ label: "#" }, { label: "Test" }], rows: note.otherTestsAdvised.map((t, n) => [str(n + 1), t]) } as Block] : []),
        ...(note.cardiologyAdvised?.length ? [{ t: "heading", text: "Cardiology investigations" } as Block, { t: "table", head: [{ label: "#" }, { label: "Test" }], rows: note.cardiologyAdvised.map((t, n) => [str(n + 1), t]) } as Block] : []),
        ...(note.proceduresAdvised?.length ? [{ t: "heading", text: "Other diagnostic procedures" } as Block, { t: "table", head: [{ label: "#" }, { label: "Procedure" }], rows: note.proceduresAdvised.map((t, n) => [str(n + 1), t]) } as Block] : []),
        ...paragraph("Advice", note.advice), ...paragraph("Diet", note.dietAdvice), ...paragraph("Referral", note.referral),
        ...(follow || note.followUp?.notes ? [{ t: "para", text: `Follow-up: ${[follow ? `on or after ${follow}` : "", note.followUp?.notes ?? ""].filter(Boolean).join(". ")}` } as Block] : []),
        { t: "signature", lines: [signer?.fullName ?? "", `Signed ${e.at(signedAt)}`] },
      ],
    }), opts.quiet === true);
  }

  /** Only a signed (or amended) summary is printable; the printed text is the signed version. */
  async dischargeSummary(ctx: RequestContext, admissionId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const s = await this.summaries.get(ctx, admissionId);
    if (!s.document || s.document.status === "DRAFT") throw new DomainError("INVALID_STATE", "The discharge summary must be signed before printing", 409);
    const doc = s.document;
    const c = doc.content as SummaryContent;
    const a = s.admission;
    const e = await this.env(ctx);
    const section = (t: string, v: string | undefined): Block[] => (v ? [{ t: "heading", text: t }, { t: "para", text: v }] : []);
    return this.finish(ctx, "DISCHARGE_SUMMARY", "ClinicalDocument", doc.id, format, (banner) => ({
      title: "Discharge Summary", fileBase: `discharge-summary-${slug(a.admissionNumber)}`, header: e.header, footer: e.footer.dischargeSummary, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: "Discharge Summary" },
        { t: "kv", rows: [["Patient", a.patientName], ["MRN", a.mrn], ["Admission no.", a.admissionNumber], ["Admitted", e.at(a.admittedAt)], ["Discharged", e.at(a.dischargedAt)], ["Outcome", a.dischargeType], ["Consultant", a.consultant], ["Department", a.department]] },
        ...(c.finalDiagnoses.length ? [{ t: "heading", text: "Final diagnoses" } as Block, { t: "table", head: [{ label: "Diagnosis" }, { label: "Code" }], rows: c.finalDiagnoses.map((d) => [d.text, d.code ?? ""]) } as Block] : []),
        ...section("Hospital course", c.hospitalCourse),
        ...(c.procedures.length ? [{ t: "heading", text: "Procedures" } as Block, { t: "table", head: [{ label: "Procedure" }, { label: "Date" }, { label: "Notes" }], rows: c.procedures.map((p) => [p.name, p.date ?? "", p.notes ?? ""]) } as Block] : []),
        ...section("Investigations", c.investigationSummary), ...section("Condition at discharge", c.conditionAtDischarge),
        ...(c.dischargeMedications.length ? [{ t: "heading", text: "Discharge medications" } as Block, { t: "table", head: [{ label: "Medicine" }, { label: "Dose" }, { label: "Route" }, { label: "Frequency" }, { label: "Days", numeric: true }, { label: "Instructions" }],
          rows: c.dischargeMedications.map((m) => [[m.brandName ?? m.genericName, m.strength ?? ""].filter(Boolean).join(" "), m.dosage, m.route, FREQ[m.frequency] ?? m.frequency, str(m.durationDays), m.instructions ?? ""]) } as Block] : []),
        ...section("Advice", c.advice),
        ...(c.followUp ? [{ t: "heading", text: "Follow-up" } as Block, { t: "para", text: [c.followUp.date && `On ${c.followUp.date}`, c.followUp.afterDays && `After ${c.followUp.afterDays} days`, c.followUp.notes].filter(Boolean).join(" - ") } as Block] : []),
        { t: "signature", lines: [doc.signedByName ?? "", `Signed ${e.at(doc.signedAt)} - version ${doc.currentVersion}`] },
      ],
    }));
  }

  /**
   * The admission form (docs/admission-form.md): who is admitted, under whom and where, the contacts, the known allergies, the consent wording and the signature
   * lines. Printable for any admission that was not cancelled, at admission and later; the consent wording and footer are the hospital's own settings.
   */
  async admissionForm(ctx: RequestContext, admissionId: string, format: PrintFormat = "html", lang: FormLang = "en"): Promise<Rendered> {
    const adm = await this.prisma.admission.findFirst({
      where: { id: admissionId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [admissionScope(ctx)] },
      include: {
        patient: { include: { identifiers: { where: { type: "MRN" } } } },
        consultant: { select: { displayName: true, specialty: true } }, department: { select: { name: true } },
        assignments: { orderBy: { assignedAt: "desc" }, take: 1, select: { bed: { select: { code: true, ward: { select: { name: true } }, room: { select: { name: true } } } } } },
      },
    });
    if (!adm) throw notFound();
    if (adm.status === "CANCELLED") throw new DomainError("INVALID_STATE", "A cancelled admission has no admission form", 409);
    const p = adm.patient;
    const T = FORM_TEXT[lang];
    const consentKey = lang === "bn" ? "ADMISSION_CONSENT_TEXT_BN" : lang === "hi" ? "ADMISSION_CONSENT_TEXT_HI" : "ADMISSION_CONSENT_TEXT";
    const [e, consent, allergies] = await Promise.all([
      this.env(ctx),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, consentKey),
      this.prisma.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: (await chartPatientIds(this.prisma, ctx.tenantId, p.id)) ?? [p.id] }, status: "ACTIVE" }, select: { allergen: true } }),
    ]);
    const bed = adm.assignments[0]?.bed;
    const address = [p.addressLine, p.city, p.district, p.state, p.postalCode].filter(Boolean).join(", ");
    const guardian = [p.guardianName, p.guardianRelation && `(${p.guardianRelation})`, p.guardianMobile].filter(Boolean).join(" ");
    const emergency = [p.emergencyContactName, p.emergencyContactMobile].filter(Boolean).join(" ");
    const blank = "______________________________";
    return this.finish(ctx, "ADMISSION_FORM", "Admission", adm.id, format, (banner) => ({
      title: `${T.title} ${adm.admissionNumber}`, fileBase: `admission-form-${slug(adm.admissionNumber)}${lang === "en" ? "" : `-${lang}`}`, header: e.header, footer: e.footer.admissionForm, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: T.title },
        { t: "heading", text: T.admission },
        { t: "kv", rows: [[T.admissionNo, adm.admissionNumber], [T.admitted, e.at(adm.admittedAt)], [T.consultant, [adm.consultant.displayName, adm.consultant.specialty].filter(Boolean).join(", ")], [T.department, adm.department?.name], [T.wardBed, bed ? `${bed.ward.name}, ${bed.room.name}, ${bed.code}` : ""], [T.reason, adm.reason]] },
        { t: "heading", text: T.patient },
        { t: "kv", rows: [[T.name, fullName(p)], [T.mrn, p.identifiers[0]?.value], [T.gender, p.gender], [T.ageDob, p.dateOfBirth ? e.day(p.dateOfBirth) : p.estimatedAgeYears ? `~${p.estimatedAgeYears} y` : ""], [T.bloodGroup, p.bloodGroup], [T.mobile, p.mobile], [T.address, address]] },
        ...(guardian || emergency ? [{ t: "heading", text: T.contacts } as Block, { t: "kv", rows: [[T.guardian, guardian], [T.emergency, emergency]] } as Block] : []),
        ...(allergies.length ? [{ t: "note", text: `${T.allergies}: ${allergies.map((a) => a.allergen).join(", ")}` } as Block] : []),
        { t: "heading", text: T.consent },
        { t: "para", text: consent },
        { t: "signature", lines: [blank, T.patientSignature, `${T.nameRelationship}: ${blank}`, `${T.dateTime}: ${blank}`] },
        { t: "signature", lines: [blank, `${T.admittingDoctor}: ${adm.consultant.displayName}`, `${T.dateTime}: ${blank}`] },
      ],
    }));
  }

  /** The voucher given to a doctor for money paid out of their earned share (docs/doctor-payouts.md). A reversal prints as a reversal. */
  async payoutVoucher(ctx: RequestContext, payoutId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const v = await this.payouts.get(ctx, payoutId);
    const doctor = await this.prisma.practitioner.findFirst({ where: { id: v.practitionerId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { registrationNo: true, specialty: true } });
    const e = await this.env(ctx);
    const reversal = v.kind === "REVERSAL";
    return this.finish(ctx, "PAYOUT_VOUCHER", "DoctorPayout", v.id, format, (dup) => ({
      title: `Payout voucher ${v.payoutNumber}`, fileBase: `payout-voucher-${slug(v.payoutNumber)}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      banner: reversal ? `REVERSAL OF ${v.reverses ?? ""}`.trim() : dup,
      blocks: [
        { t: "title", text: `${reversal ? "Payout reversal" : "Doctor payout voucher"} ${v.payoutNumber}` },
        { t: "kv", rows: [["Doctor", v.doctor], ["Registration no.", doctor?.registrationNo], ["Date", e.at(v.paidAt)], ["Paid by", v.method.replace("_", " ").toLowerCase()], ["Reference", v.reference], ["Note", v.note]] },
        { t: "table", head: [{ label: "Amount" }, { label: "INR", numeric: true }], rows: [["Share paid", v.gross], [`Tax deducted at source (${v.tdsPercent}%)`, v.tds], [reversal ? "Net returned" : "Net received by the doctor", v.net]] },
        { t: "signature", lines: ["______________________________", reversal ? "Doctor: signature on return" : "Received by the doctor: signature", "Date: ______________________________"] },
        { t: "signature", lines: ["______________________________", `Paid by: ${v.by ?? e.printedBy}`] },
      ],
    }));
  }

  /** The laboratory report of one test (docs/lims.md): only a verified report prints, and it is the latest version, with the ranges and flags as they were when it was verified. */
  async labReport(ctx: RequestContext, testOrderId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const r = await this.lab.result(ctx, testOrderId, { scoped: true });
    const v = r.reports[0];
    if (!v) throw new DomainError("INVALID_STATE", "The report is not ready: it has not been verified yet", 409);
    const e = await this.env(ctx);
    const flagText: Record<string, string> = { NORMAL: "", LOW: "LOW", HIGH: "HIGH", CRITICAL_LOW: "CRITICAL LOW", CRITICAL_HIGH: "CRITICAL HIGH" };
    const amended = v.kind === "AMENDED";
    return this.finish(ctx, "LAB_REPORT", "LabResult", r.resultId ?? r.testOrderId, format, (dup) => ({
      title: `Laboratory report ${r.sample?.accessionNumber ?? ""}`.trim(), fileBase: `lab-report-${slug(r.sample?.accessionNumber ?? r.testOrderId.slice(0, 8))}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      banner: amended ? "AMENDED REPORT" : dup,
      blocks: [
        { t: "title", text: `Laboratory report: ${r.test}` },
        { t: "kv", rows: [["Patient", r.patient.name], ["MRN", r.patient.mrn], ["Gender", r.patient.gender], ["Visit", r.visitNumber], ["Sample no.", r.sample?.accessionNumber], ["Specimen", r.sample?.specimen], ["Collected", e.at(r.sample?.collectedAt)], ["Reported", e.at(v.verifiedAt)], ["Verified by", v.verifiedBy]] },
        ...(v.hasCritical ? [{ t: "note", text: "CRITICAL VALUE: the doctor has been alerted." } as Block] : []),
        { t: "table", head: [{ label: "Test" }, { label: "Result", numeric: true }, { label: "Unit" }, { label: "Reference" }, { label: "Flag" }], rows: v.values.map((x) => [x.name, x.value, x.unit ?? "", x.rangeText, flagText[x.flag] ?? x.flag]) },
        ...(v.comment ? [{ t: "para", text: `Comment: ${v.comment}` } as Block] : []),
        ...(amended ? [{ t: "para", text: `This report was amended (version ${v.version}). Reason: ${v.reason ?? ""}` } as Block] : []),
        { t: "signature", lines: [v.verifiedBy ?? "", `Verified ${e.at(v.verifiedAt)}`] },
      ],
    }));
  }

  /** The radiology report of one study (docs/radiology.md): only a signed report prints, and it is the latest version. */
  async radiologyReport(ctx: RequestContext, testOrderId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const r = await this.rad.study(ctx, testOrderId, { scoped: true });
    const v = r.reports[0];
    const st = r.study;
    if (!st || !v) throw new DomainError("INVALID_STATE", "The report is not ready: it has not been signed yet", 409);
    const e = await this.env(ctx);
    const amended = v.kind === "AMENDED";
    return this.finish(ctx, "RAD_REPORT", "RadStudy", st.id, format, (dup) => ({
      title: `Radiology report ${st.accessionNumber ?? ""}`.trim(), fileBase: `radiology-report-${slug(st.accessionNumber ?? r.testOrderId.slice(0, 8))}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      banner: amended ? "AMENDED REPORT" : dup,
      blocks: [
        { t: "title", text: `Radiology report: ${r.test}` },
        { t: "kv", rows: [["Patient", r.patient.name], ["MRN", r.patient.mrn], ["Gender", r.patient.gender], ["Visit", r.visitNumber], ["Study no.", st.accessionNumber], ["Modality", st.modality], ["Body part", st.bodyPart], ["Performed", e.at(st.performedAt)], ["Reported", e.at(v.signedAt)]] },
        ...(v.hasCritical ? [{ t: "note", text: "CRITICAL FINDING: the doctor has been alerted." } as Block] : []),
        { t: "para", text: `Findings: ${v.findings}` },
        { t: "para", text: `Impression: ${v.impression}` },
        ...(amended ? [{ t: "para", text: `This report was amended (version ${v.version}). Reason: ${v.reason ?? ""}` } as Block] : []),
        { t: "signature", lines: [v.signedBy ?? "", `Signed ${e.at(v.signedAt)}`] },
      ],
    }));
  }

  /** The claim form (docs/claims.md): what goes to the insurer with the invoice: patient, policy, amounts and the timeline so far. */
  async claimForm(ctx: RequestContext, claimId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const c = await this.claims.view(ctx, claimId);
    const e = await this.env(ctx);
    return this.finish(ctx, "CLAIM_FORM", "Claim", c.id, format, () => ({
      title: `Claim ${c.claimNumber}`, fileBase: `claim-${slug(c.claimNumber)}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      blocks: [
        { t: "title", text: `Insurance claim ${c.claimNumber}` },
        { t: "kv", rows: [["Patient", c.patient.name], ["MRN", c.patient.mrn], ["Insurer", c.policy.insurer.name], ["Policy no.", c.policy.policyNumber], ["Member id", c.policy.memberId], ["Policy holder", c.policy.holderName], ["Valid", `${c.policy.validFrom} to ${c.policy.validTo}`], ["Type", c.type], ["Status", c.status], ["Diagnosis", c.diagnosis], ["Invoice", c.invoice?.invoiceNumber ?? ""], ["Pre-authorised", c.preauthApproved ?? ""], ["Claimed", c.claimedAmount ?? ""], ["Approved", c.approvedAmount ?? ""], ["Received", c.settledAmount ?? ""]] },
        { t: "table", head: [{ label: "When" }, { label: "Step" }, { label: "Amount", numeric: true }, { label: "Note" }, { label: "By" }], rows: c.events.map((x) => [e.at(x.at), `${x.from ?? ""} ${x.from ? "→ " : ""}${x.to}`.trim(), x.amount ?? "", x.note ?? "", x.by ?? ""]) },
      ],
    }));
  }

  /** One payslip (docs/payroll.md): earnings, deductions and net pay. For payroll staff, or for the employee once the run is approved. */
  async payslip(ctx: RequestContext, slipId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const p = await this.payroll.payslip(ctx, slipId);
    const e = await this.env(ctx);
    return this.finish(ctx, "PAYSLIP", "Payslip", p.id, format, () => ({
      title: `Payslip ${p.month} ${p.employee.code}`, fileBase: `payslip-${slug(p.employee.code)}-${p.month}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      blocks: [
        { t: "title", text: `Payslip for ${p.month}` },
        { t: "kv", rows: [["Employee", p.employee.name], ["Employee code", p.employee.code], ["Designation", p.employee.designation], ["Department", p.employee.department], ["PAN", p.employee.pan], ["UAN", p.employee.uan], ["ESI no.", p.employee.esiNumber], ["Bank account", p.employee.bankAccount], ["Days in month", String(p.daysInMonth)], ["Days of loss of pay", p.lopDays]] },
        { t: "table", head: [{ label: "Earnings" }, { label: "Amount", numeric: true }, { label: "Deductions" }, { label: "Amount", numeric: true }], rows: [
          ["Basic", p.basic, "Provident fund", p.pfEmployee], ["House rent allowance", p.hra, "ESI", p.esiEmployee], ["Other allowance", p.otherAllowance, "Professional tax", p.professionalTax], ["Bonus", p.bonus, "Income tax (TDS)", p.tds],
          ["", "", "Other deductions", p.otherDeduction], ["Gross pay", p.gross, "Total deductions", p.totalDeductions],
        ] },
        { t: "kv", rows: [["Net pay", p.net], ["Status", p.runStatus === "PAID" && p.paidOn ? `Paid on ${p.paidOn}` : p.runStatus]] },
        ...(p.note ? [{ t: "para", text: `Note: ${p.note}` } as Block] : []),
      ],
    }));
  }

  /** The sticker for a sample tube: the accession number, who it is from, the test and the specimen. */
  async labLabel(ctx: RequestContext, sampleId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const s = await this.prisma.labSample.findFirst({
      where: { id: sampleId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounter: { AND: [visitScope(ctx)] } },
      select: { id: true, accessionNumber: true, specimen: true, collectedAt: true, status: true, testOrder: { select: { name: true } }, patient: { select: { firstName: true, lastName: true, gender: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } },
    });
    if (!s) throw notFound();
    const e = await this.env(ctx);
    return this.finish(ctx, "LAB_LABEL", "LabSample", s.id, format, () => ({
      title: `Sample label ${s.accessionNumber}`, fileBase: `lab-label-${slug(s.accessionNumber)}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      blocks: [
        { t: "title", text: s.accessionNumber },
        { t: "kv", rows: [["Patient", fullName(s.patient)], ["MRN", s.patient.identifiers[0]?.value], ["Gender", s.patient.gender], ["Test", s.testOrder.name], ["Specimen", s.specimen], ["Collected", e.at(s.collectedAt)]] },
      ],
    }));
  }

  async patientLabel(ctx: RequestContext, patientId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, include: { identifiers: { where: { type: "MRN" } } } });
    if (!p) throw notFound();
    const e = await this.env(ctx);
    return this.finish(ctx, "PATIENT_LABEL", "Patient", p.id, format, () => ({
      title: "Patient label", fileBase: `label-${slug(p.identifiers[0]?.value ?? p.id.slice(0, 8))}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      blocks: [
        { t: "title", text: fullName(p) },
        { t: "kv", rows: [["MRN", p.identifiers[0]?.value], ["Gender", p.gender], ["DOB", e.day(p.dateOfBirth)], ["Mobile", p.mobile], ["Blood group", p.bloodGroup]] },
      ],
    }));
  }
}
