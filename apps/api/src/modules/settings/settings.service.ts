import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { DEFAULT_CONSENT } from "../print/admission-form-text";
import { DEFAULT_RATES_SETTING } from "../payroll/payroll.domain";

/** Registry of supported settings: each key has a strict schema and a safe default. Unknown keys are rejected. */
export const SETTINGS = {
  PHARMACY_ENABLED: { schema: z.boolean(), default: true, description: "Pharmacy module" },
  IPD_ENABLED: { schema: z.boolean(), default: true, description: "In-patient (admission, beds, discharge) module" },
  NURSING_ENABLED: { schema: z.boolean(), default: true, description: "Nursing (worklist, MAR, intake/output) module" },
  DISCHARGE_REQUIRED_STEPS: {
    schema: z.array(z.enum(["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"])).max(4).refine((a) => new Set(a).size === a.length, "Duplicate step"),
    default: ["NURSING", "CHARGES_REVIEWED", "PHARMACY", "BILLING"] as string[],
    description: "Clearance steps required before discharge (medical fitness is always required)",
  },
  DISCHARGE_REQUIRE_SUMMARY: { schema: z.boolean(), default: true, description: "Require a signed discharge summary before discharge" },
  BED_AFTER_DISCHARGE: { schema: z.enum(["CLEANING", "AVAILABLE"]), default: "CLEANING", description: "Status of a bed once its patient is discharged" },
  PRINT_HEADER: { schema: z.object({ hospitalName: z.string().trim().min(2).max(120), tagline: z.string().trim().max(160).optional(), address: z.string().trim().max(300).optional(), phone: z.string().trim().max(40).optional(), email: z.string().trim().email().max(120).optional(), gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(), logoDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).max(300_000).optional() }).strict(), default: null as unknown, description: "Hospital identity printed on documents" },
  PRINT_FOOTER: { schema: z.object({ invoice: z.string().trim().max(400).optional(), receipt: z.string().trim().max(400).optional(), prescription: z.string().trim().max(400).optional(), dischargeSummary: z.string().trim().max(400).optional(), admissionForm: z.string().trim().max(400).optional() }).strict(), default: {} as unknown, description: "Footer text per document type" },
  ADMISSION_CONSENT_TEXT: { schema: z.string().trim().min(10).max(1500), default: DEFAULT_CONSENT.en, description: "The consent wording printed on the admission form, above the signature lines (docs/admission-form.md)" },
  ADMISSION_CONSENT_TEXT_BN: { schema: z.string().trim().min(10).max(1500), default: DEFAULT_CONSENT.bn, description: "The same wording in Bengali, for the form printed in Bengali. The built-in text is a starting point that a native speaker should review" },
  ADMISSION_CONSENT_TEXT_HI: { schema: z.string().trim().min(10).max(1500), default: DEFAULT_CONSENT.hi, description: "The same wording in Hindi, for the form printed in Hindi. The built-in text is a starting point that a native speaker should review" },
  FOLLOWUP_REMINDERS_ENABLED: { schema: z.boolean(), default: true, description: "Send reminders for follow-up appointments" },
  REMINDERS_REQUIRE_CONSENT: { schema: z.boolean(), default: false, description: "Send appointment reminders only to patients who have agreed (off: send unless the patient has withdrawn). A legal decision: see docs/reviews/pending-decisions.md" },
  CASH_AUTO_OPEN_SHIFT: { schema: z.boolean(), default: true, description: "When cash is taken or given back and the person has no open cash shift, open one automatically (with no opening cash) so the payment is never blocked. Turn it off to make staff open their shift first" },
  OPD_FEE_BEFORE_VISIT: { schema: z.boolean(), default: false, description: "An OPD visit can start only after the OPD consultation bill is paid: Reception creates the bill with the OPD consultation, takes the payment, then starts the visit. Follow-up visits, appointments that carry a booking fee and emergencies are not held up (docs/opd-payment.md)" },
  REGISTRATION_FEE_ENABLED: { schema: z.boolean(), default: false, description: "Collect a one-time registration fee from every new patient at Reception before the Patient ID is issued (docs/registration-fee.md)" },
  REGISTRATION_FEE_AMOUNT: { schema: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Enter an amount with at most 2 decimals"), default: "0.00", description: "Registration fee in rupees, for patients registered from now on (0 = no fee)" },
  REGISTRATION_FEE_EXEMPT_REASONS: {
    schema: z.array(z.string().trim().min(3).max(60)).min(1).max(20).refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "Duplicate reason"),
    default: ["Emergency", "Staff or family", "Free camp", "Referral", "Financial hardship"] as string[],
    description: "The reasons staff with permission can pick to register a patient without the registration fee",
  },
  BOOKING_FEE_ENABLED: { schema: z.boolean(), default: false, description: "Ask for a booking fee when an appointment is booked; the patient cannot be checked in until it is paid or skipped (docs/booking-fee.md)" },
  BOOKING_FEE_AMOUNT: { schema: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Enter an amount with at most 2 decimals"), default: "0.00", description: "Booking fee in rupees, for appointments booked from now on (0 = no fee)" },
  BOOKING_FEE_SKIP_REASONS: {
    schema: z.array(z.string().trim().min(3).max(60)).min(1).max(20).refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "Duplicate reason"),
    default: ["Emergency", "Staff or family", "Free camp", "Referral", "Financial hardship"] as string[],
    description: "The reasons staff with permission can pick to skip a booking fee",
  },
  BOOKING_FEE_FREE_CANCEL_HOURS: { schema: z.number().int().min(0).max(720), default: 24, description: "Cancelling at least this many hours before the appointment costs nothing; the whole booking fee can be given back (docs/booking-fee.md)" },
  BOOKING_FEE_CANCEL_CHARGE_PERCENT: { schema: z.number().int().min(0).max(100), default: 0, description: "Share of the booking fee kept as a cancellation charge when a paid booking is cancelled later than the free period (0 = always refundable)" },
  BOOKING_PAYMENT_LINK_ENABLED: { schema: z.boolean(), default: false, description: "Send a payment link on WhatsApp after a booking that carries a booking fee, and cancel the appointment automatically if it is not paid in time (WhatsApp sending is a placeholder for now: docs/booking-payment-link.md)" },
  BOOKING_PAYMENT_WINDOW_MINUTES: { schema: z.number().int().min(15).max(10_080), default: 60, description: "How long the patient has to pay after booking before the appointment is cancelled automatically (15 minutes to 7 days)" },
  EMAIL_ENABLED: { schema: z.boolean(), default: false, description: "Send appointment, receipt and report-ready emails to patients, and queue test emails (docs/email.md). Off: nothing is queued." },
  EMAIL_FROM_NAME: { schema: z.string().trim().max(80).refine((v) => !/[\r\n<>"]/.test(v), "Use plain text"), default: "", description: "The name patients see as the sender. Empty: the facility name." },
  EMAIL_REPLY_TO: { schema: z.string().trim().max(254).refine((v) => v === "" || /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(v), "Enter an email address or leave it empty"), default: "", description: "Where a patient's reply goes. Empty: no reply address." },
  EMAIL_REQUIRE_CONSENT: { schema: z.boolean(), default: true, description: "Email only patients who have agreed (the email consent on the patient record). Off: email unless the patient has withdrawn. A legal decision: see docs/reviews/pending-decisions.md." },
  EMAIL_LANGUAGE: { schema: z.enum(["en", "bn", "hi"]), default: "en", description: "The language emails are written in: English, Bengali or Hindi." },
  PRESCRIPTION_UPLOAD_ENABLED: { schema: z.boolean(), default: false, description: "Let doctors attach a photo or scan of a handwritten prescription to a visit (docs/prescriptions.md)" },
  PRESCRIPTION_OCR_ENABLED: { schema: z.boolean(), default: false, description: "Read uploaded handwritten prescriptions with the OCR service connected to the server. The image is sent to that service; the text it returns is a draft for the doctor to check (docs/prescriptions.md)" },
  EARNINGS_MODEL: { schema: z.enum(["BOTH", "COMMISSION", "FIXED_VALUE"]), default: "BOTH", description: "How doctors are paid from what is collected: a commission (percentage), a fixed value for each visit, or either one per doctor. New earnings rules must follow it (docs/earnings-and-reports.md)" },
  DOCTOR_PAYOUT_TDS_PERCENT: { schema: z.number().min(0).max(30).multipleOf(0.01), default: 0, description: "Tax deducted at source on doctor payouts, as a percentage of the share paid (0 = none). The administrator can change it for a single payout (docs/doctor-payouts.md)" },
  PRESCRIPTION_AUTO_SEND: { schema: z.boolean(), default: false, description: "When a prescription is signed, send the patient a link to it on their own mobile through the connected message provider (docs/prescriptions.md). Staff can also send it by hand" },
  PATIENT_PORTAL_ENABLED: { schema: z.boolean(), default: false, description: "Let patients sign in to the patient app with a code sent to their registered mobile number, to see their appointments, prescriptions, reports and bills, and to ask for an appointment (docs/patient-app.md). Off until the hospital has connected a message provider" },
  TELECONSULT_VIDEO_URL: { schema: z.string().trim().max(200).refine((v) => v === "" || (/^https:\/\//.test(v) && v.includes("{room}")), "Use an https address that contains {room}, for example https://video.example.org/{room}"), default: "", description: "The address of the hospital's video service, with {room} where the name of each consultation's room goes (docs/telemedicine.md). Video consultations cannot be made until it is set. The room name is random and different for every consultation" },
  AI_ASSISTANT_ENABLED: { schema: z.boolean(), default: false, description: "Let doctors ask the AI assistant for a draft summary of a patient's earlier visits or draft advice for a visit (docs/ai-assistant.md). Drafts are for the doctor to check and are never put on the chart by the assistant. Needs the hospital's own AI provider to be connected, tested and its data sharing confirmed under Administration, AI. Off by default" },
  PAYROLL_STATUTORY_RATES: {
    schema: z.object({
      pfWageCeiling: z.number().min(0).max(1_000_000), pfRate: z.number().min(0).max(1), esiGrossCeiling: z.number().min(0).max(1_000_000), esiEmployeeRate: z.number().min(0).max(1), esiEmployerRate: z.number().min(0).max(1),
      ptSlabs: z.array(z.object({ upTo: z.number().min(0).max(10_000_000), tax: z.number().min(0).max(100_000) }).strict()).max(10).refine((a) => a.every((x, i) => i === 0 || x.upTo > a[i - 1]!.upTo), "Each slab must end higher than the one before"),
      ptTop: z.number().min(0).max(100_000),
    }).strict(),
    default: DEFAULT_RATES_SETTING,
    description: "The rates payroll uses: provident fund (rate and wage ceiling), ESI (employee and employer rates, gross ceiling) and the professional tax slabs (monthly gross up to each amount pays that tax; ptTop applies above the last slab). The starting values are common Indian defaults that have not been checked against current law: the hospital's accountant must confirm them (docs/payroll.md). A change applies to payslips calculated afterwards",
  },
  INVOICE_TAX_SPLIT: { schema: z.boolean(), default: false, description: "Show and calculate each invoice's tax as two equal halves, CGST and SGST (each worked out and rounded on its own). Applies to invoices created from now on; every invoice keeps the rule it was created with. Whether and how GST applies to your services is for your accountant to decide (docs/gst-and-rounding.md)" },
  INVOICE_ROUND_OFF: { schema: z.boolean(), default: false, description: "Round each new invoice's total to the nearest whole rupee (50 paise and above rounds up) and show the difference as a round-off line. Applies to invoices created from now on; every invoice keeps the rule it was created with" },
  PAYROLL_WEEKLY_OFF_DAYS: { schema: z.array(z.number().int().min(0).max(6)).max(6).refine((a) => new Set(a).size === a.length, "Duplicate day"), default: [] as number[], description: "The weekly off days of staff, as day numbers (0 = Sunday, 1 = Monday ... 6 = Saturday). Those days are treated as a weekly off in attendance and are not charged as loss of pay; empty means no common weekly off" },
  PRESCRIPTION_SEND_CHANNEL: { schema: z.enum(["WHATSAPP", "SMS"]), default: "WHATSAPP", description: "How prescription links are sent to patients" },
  PRESCRIPTION_LINK_DAYS: { schema: z.number().int().min(1).max(30), default: 7, description: "How many days a prescription link sent to a patient stays valid" },
  FOLLOWUP_REMINDER_OFFSETS_MINUTES: {
    schema: z.array(z.number().int().min(15).max(10_080)).min(1).max(5).refine((a) => new Set(a).size === a.length, "Duplicate reminder time"),
    default: [1440] as number[],
    description: "When to remind before a follow-up, in minutes before it starts (1440 = 24 hours; 15 minutes to 7 days, up to 5 reminders)",
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const settingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);
export const putSettingSchema = z.object({ value: z.unknown() }).strict();

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get<K extends SettingKey>(db: Db | PrismaService, tenantId: string, facilityId: string, key: K): Promise<z.infer<(typeof SETTINGS)[K]["schema"]>> {
    const row = await db.setting.findUnique({ where: { tenantId_facilityId_key: { tenantId, facilityId, key } } });
    return (row ? row.value : SETTINGS[key].default) as z.infer<(typeof SETTINGS)[K]["schema"]>;
  }

  async isEnabled(tenantId: string, facilityId: string, key: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED"): Promise<boolean> {
    return this.get(this.prisma, tenantId, facilityId, key);
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.setting.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => ({ key, description: SETTINGS[key].description, value: byKey.get(key)?.value ?? SETTINGS[key].default, isDefault: !byKey.has(key), updatedAt: byKey.get(key)?.updatedAt ?? null }));
  }

  async put(ctx: RequestContext, key: SettingKey, raw: unknown) {
    const parsed = SETTINGS[key].schema.safeParse(raw);
    if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "Invalid value for this setting", 400, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { tenantId_facilityId_key: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key } } });
      const value = parsed.data as Prisma.InputJsonValue;
      await tx.setting.upsert({
        where: { tenantId_facilityId_key: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key } },
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, key, value, updatedById: ctx.userId },
        update: { value, updatedById: ctx.userId },
      });
      const isPrint = key.startsWith("PRINT_");
      await this.audit.record(tx, actorOf(ctx), { action: "SETTING_CHANGED", entityType: "Setting", entityId: key, metadata: isPrint ? { key } : { key, from: (before?.value ?? SETTINGS[key].default) as Prisma.InputJsonValue, to: value } });
      return { key, value: parsed.data };
    });
  }

  /** Feature flags for navigation: which modules this facility has switched on. */
  async features(ctx: RequestContext) {
    const [pharmacy, ipd, nursing] = await Promise.all([
      this.get(this.prisma, ctx.tenantId, ctx.facilityId, "PHARMACY_ENABLED"), this.get(this.prisma, ctx.tenantId, ctx.facilityId, "IPD_ENABLED"), this.get(this.prisma, ctx.tenantId, ctx.facilityId, "NURSING_ENABLED"),
    ]);
    return { PHARMACY_ENABLED: pharmacy, IPD_ENABLED: ipd, NURSING_ENABLED: nursing };
  }
}
