import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { emailConsentState } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { EMAIL_LOG_ONLY_PREFIX, EMAIL_PROVIDER, EmailError, maskEmail, type EmailProvider } from "./email.provider";
import { formatWhen, isTemplateKey, LANGUAGES, render, TEMPLATE_KEYS, TEMPLATES, templateProblem, toHtml, type EmailLanguage, type TemplateKey } from "./email.templates";

// ───────────────────────── input schemas ─────────────────────────

const address = z.string().trim().toLowerCase().max(254).regex(/^[^@\s]+@[^@\s]+[.][^@\s]+$/, "Enter a valid email address");
export const languageSchema = z.enum(LANGUAGES);
export const saveTemplateSchema = z.object({ subject: z.string().max(200), body: z.string().max(4000) }).strict();
export const previewSchema = z.object({ subject: z.string().max(200).optional(), body: z.string().max(4000).optional() }).strict();
export const testSchema = z.object({ to: address }).strict();
export const listOutboxSchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "CANCELLED", "SKIPPED"]).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const addSuppressionSchema = z.object({ address, note: z.string().trim().min(3).max(200).optional() }).strict();

export type NotQueuedReason = "DISABLED" | "NO_ADDRESS" | "NO_CONSENT" | "SUPPRESSED" | "DUPLICATE";
export interface QueueResult { queued: boolean; reason?: NotQueuedReason; id?: string }
type Outcome = "sent" | "skipped" | "retried" | "failed";

export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const TEST_PER_HOUR = 5;

export interface EnqueueInput {
  tenantId: string; facilityId: string; templateKey: TemplateKey;
  /** The patient it is about (their address and agreement are used), or a plain address for a test. */
  patientId?: string | undefined; toAddress?: string | undefined;
  vars: Record<string, string>;
  entityType?: string | undefined; entityId?: string | undefined; dedupeKey?: string | undefined; createdById?: string | undefined;
}

/**
 * Email (docs/email.md). Screens and workflows only QUEUE an email, inside their own transaction; a worker sends it later, so a slow or failing email provider
 * never slows down or breaks a booking or a payment. Before queueing, and again just before sending, the patient's agreement, the suppression list and the hospital's
 * on/off switch are checked.
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────────────────── queueing ─────────────────────────

  async enabled(db: Db | PrismaService, tenantId: string, facilityId: string): Promise<boolean> {
    return this.settings.get(db, tenantId, facilityId, "EMAIL_ENABLED");
  }

  async language(db: Db | PrismaService, tenantId: string, facilityId: string): Promise<EmailLanguage> {
    return this.settings.get(db, tenantId, facilityId, "EMAIL_LANGUAGE");
  }

  /** Queues one email if it may be sent. Never throws for "may not": it says why not. */
  async enqueue(db: Db, i: EnqueueInput): Promise<QueueResult> {
    if (!(await this.enabled(db, i.tenantId, i.facilityId))) return { queued: false, reason: "DISABLED" };
    let to = i.toAddress;
    if (!to && i.patientId) to = (await db.patient.findFirst({ where: { id: i.patientId, tenantId: i.tenantId }, select: { email: true } }))?.email ?? undefined;
    const parsed = to ? address.safeParse(to) : null;
    if (!parsed?.success) return { queued: false, reason: "NO_ADDRESS" };
    const toAddress = parsed.data;
    if (await db.emailSuppression.findFirst({ where: { tenantId: i.tenantId, address: toAddress }, select: { id: true } })) return { queued: false, reason: "SUPPRESSED" };
    if (i.patientId && i.templateKey !== "TEST" && !(await this.mayEmailPatient(db, i.tenantId, i.facilityId, i.patientId))) return { queued: false, reason: "NO_CONSENT" };

    const language = await this.language(db, i.tenantId, i.facilityId);
    const override = await db.emailTemplate.findFirst({ where: { tenantId: i.tenantId, templateKey: i.templateKey, language }, select: { subject: true, body: true } });
    const r = render(i.templateKey, language, i.vars, override);
    const id = randomUUID();
    const res = await db.emailOutbox.createMany({
      data: [{ id, tenantId: i.tenantId, facilityId: i.facilityId, templateKey: i.templateKey, language, patientId: i.patientId ?? null, toAddress, subject: r.subject, bodyText: r.text.slice(0, 8000), entityType: i.entityType ?? null, entityId: i.entityId ?? null, dedupeKey: i.dedupeKey ?? null, createdById: i.createdById ?? null }],
      skipDuplicates: true,
    });
    return res.count === 1 ? { queued: true, id } : { queued: false, reason: "DUPLICATE" };
  }

  /** Whether this patient may be emailed: withdrawn never; agreed yes; nothing on file follows the hospital's EMAIL_REQUIRE_CONSENT setting. */
  private async mayEmailPatient(db: Db | PrismaService, tenantId: string, facilityId: string, patientId: string): Promise<boolean> {
    const state = await emailConsentState(db, tenantId, patientId);
    if (state === "WITHDRAWN") return false;
    if (state === "GRANTED") return true;
    return !(await this.settings.get(db, tenantId, facilityId, "EMAIL_REQUIRE_CONSENT"));
  }

  /** An appointment was booked or cancelled: email the patient. Called inside the caller's transaction. */
  async appointmentEmail(db: Db, at: { tenantId: string; facilityId: string; userId?: string }, appointmentId: string, key: "APPOINTMENT_BOOKED" | "APPOINTMENT_CANCELLED"): Promise<QueueResult> {
    if (!(await this.enabled(db, at.tenantId, at.facilityId))) return { queued: false, reason: "DISABLED" };
    const a = await db.appointment.findFirst({
      where: { id: appointmentId, tenantId: at.tenantId },
      select: { startAt: true, patientId: true, patient: { select: { firstName: true } }, practitioner: { select: { displayName: true } }, facility: { select: { name: true, timezone: true } } },
    });
    if (!a) return { queued: false, reason: "NO_ADDRESS" };
    const language = await this.language(db, at.tenantId, at.facilityId);
    return this.enqueue(db, {
      tenantId: at.tenantId, facilityId: at.facilityId, templateKey: key, patientId: a.patientId, createdById: at.userId,
      vars: { name: a.patient.firstName, doctor: a.practitioner.displayName, when: formatWhen(a.startAt, a.facility.timezone, language), facility: a.facility.name },
      entityType: "Appointment", entityId: appointmentId, dedupeKey: `${key}:${appointmentId}`,
    });
  }

  /** A laboratory or radiology report was released: tell the patient that one is ready (never what it says). Called inside the caller's transaction. */
  async reportReadyEmail(db: Db, at: { tenantId: string; facilityId: string; userId?: string }, testOrderId: string, entityId: string, entityType: "LabResult" | "RadStudy"): Promise<QueueResult> {
    if (!(await this.enabled(db, at.tenantId, at.facilityId))) return { queued: false, reason: "DISABLED" };
    const o = await db.testOrder.findFirst({ where: { id: testOrderId, tenantId: at.tenantId }, select: { encounter: { select: { patientId: true, patient: { select: { firstName: true } }, facility: { select: { name: true } } } } } });
    if (!o) return { queued: false, reason: "NO_ADDRESS" };
    return this.enqueue(db, {
      tenantId: at.tenantId, facilityId: at.facilityId, templateKey: "REPORT_READY", patientId: o.encounter.patientId, createdById: at.userId,
      vars: { name: o.encounter.patient.firstName, facility: o.encounter.facility.name },
      entityType, entityId, dedupeKey: `REPORT_READY:${entityId}`,
    });
  }

  /** Staff press "Email receipt" on a bill that has been paid (wholly or in part). Pressing again for the same amount does nothing. */
  async emailReceipt(ctx: RequestContext, invoiceId: string): Promise<QueueResult> {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, invoiceNumber: true, paidTotal: true, refundedTotal: true, patientId: true, patient: { select: { firstName: true } }, facility: { select: { name: true } } } });
      if (!inv) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const net = inv.paidTotal.minus(inv.refundedTotal);
      if (net.lte(0) || !inv.invoiceNumber) throw new DomainError("INVALID_STATE", "Nothing has been paid on this bill yet", 409);
      const amount = `₹${net.toFixed(2)}`;
      const r = await this.enqueue(tx, {
        tenantId: ctx.tenantId, facilityId: ctx.facilityId, templateKey: "RECEIPT", patientId: inv.patientId, createdById: ctx.userId,
        vars: { name: inv.patient.firstName, invoiceNumber: inv.invoiceNumber, amount, facility: inv.facility.name },
        entityType: "Invoice", entityId: inv.id, dedupeKey: `RECEIPT:${inv.id}:${net.toFixed(2)}`,
      });
      if (r.queued) await this.audit.record(tx, actorOf(ctx), { action: "RECEIPT_EMAIL_QUEUED", entityType: "Invoice", entityId: inv.id, metadata: { emailId: r.id ?? null } });
      return r;
    });
  }

  // ───────────────────────── status, templates, test ─────────────────────────

  async status(ctx: RequestContext) {
    return {
      enabled: await this.enabled(this.prisma, ctx.tenantId, ctx.facilityId),
      provider: this.provider.name, providerConnected: this.provider.configured,
      senderAddress: this.config.EMAIL_FROM_ADDRESS ?? null,
      languages: LANGUAGES,
    };
  }

  async templates(ctx: RequestContext) {
    const rows = await this.prisma.emailTemplate.findMany({ where: { tenantId: ctx.tenantId }, select: { templateKey: true, language: true, subject: true, body: true, version: true, updatedAt: true } });
    return TEMPLATE_KEYS.map((key) => {
      const t = TEMPLATES[key];
      return {
        key, label: t.label, description: t.description, placeholders: Object.keys(t.vars),
        languages: LANGUAGES.map((language) => {
          const custom = rows.find((r) => r.templateKey === key && r.language === language);
          return { language, default: t.defaults[language], custom: custom ? { subject: custom.subject, body: custom.body, version: custom.version, updatedAt: custom.updatedAt } : null };
        }),
      };
    });
  }

  private checkKey(key: string): TemplateKey {
    if (!isTemplateKey(key)) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return key;
  }

  async saveTemplate(ctx: RequestContext, key: string, language: EmailLanguage, input: z.infer<typeof saveTemplateSchema>) {
    const k = this.checkKey(key);
    const problem = templateProblem(k, input.subject, input.body);
    if (problem) throw new DomainError("VALIDATION_FAILED", problem, 400);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.emailTemplate.findFirst({ where: { tenantId: ctx.tenantId, templateKey: k, language }, select: { id: true, version: true } });
      const row = existing
        ? await tx.emailTemplate.update({ where: { id: existing.id }, data: { subject: input.subject, body: input.body, version: { increment: 1 }, updatedById: ctx.userId, updatedAt: new Date() }, select: { version: true } })
        : await tx.emailTemplate.create({ data: { tenantId: ctx.tenantId, templateKey: k, language, subject: input.subject, body: input.body, updatedById: ctx.userId }, select: { version: true } });
      // The audit trail says which template and which edit, not its words.
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_TEMPLATE_SAVED", entityType: "EmailTemplate", metadata: { templateKey: k, language, version: row.version } });
      return { key: k, language, version: row.version };
    });
  }

  async resetTemplate(ctx: RequestContext, key: string, language: EmailLanguage): Promise<void> {
    const k = this.checkKey(key);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.emailTemplate.deleteMany({ where: { tenantId: ctx.tenantId, templateKey: k, language } });
      if (res.count === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_TEMPLATE_RESET", entityType: "EmailTemplate", metadata: { templateKey: k, language } });
    });
  }

  /** The wording with example values, so an administrator can see it before saving. Unsaved text may be given. */
  preview(key: string, language: EmailLanguage, input: z.infer<typeof previewSchema>) {
    const k = this.checkKey(key);
    const base = TEMPLATES[k].defaults[language];
    const subject = input.subject ?? base.subject;
    const body = input.body ?? base.body;
    const problem = templateProblem(k, subject, body);
    if (problem) throw new DomainError("VALIDATION_FAILED", problem, 400);
    return render(k, language, TEMPLATES[k].vars, { subject, body });
  }

  async sendTest(ctx: RequestContext, input: z.infer<typeof testSchema>): Promise<QueueResult> {
    return this.prisma.$transaction(async (tx) => {
      const recent = await tx.emailOutbox.count({ where: { tenantId: ctx.tenantId, templateKey: "TEST", createdById: ctx.userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
      if (recent >= TEST_PER_HOUR) throw new DomainError("RATE_LIMITED", "Too many test emails. Try again in an hour.", 429);
      const facility = await tx.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { name: true } });
      const r = await this.enqueue(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, templateKey: "TEST", toAddress: input.to, vars: { facility: facility.name }, createdById: ctx.userId });
      if (r.queued) await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_TEST_QUEUED", entityType: "EmailOutbox", entityId: r.id ?? null, metadata: {} });
      return r;
    });
  }

  // ───────────────────────── the delivery log ─────────────────────────

  async list(ctx: RequestContext, q: z.infer<typeof listOutboxSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.emailOutbox.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, templateKey: true, language: true, toAddress: true, subject: true, status: true, attempts: true, lastError: true, providerMessageId: true, sentAt: true, createdAt: true, entityType: true, entityId: true } }),
      this.prisma.emailOutbox.count({ where }),
    ]);
    // The address is masked in the list; the log is for "was it sent", not for collecting addresses.
    const items = rows.map(({ toAddress, providerMessageId, ...r }) => ({ ...r, to: maskEmail(toAddress), logOnly: providerMessageId?.startsWith(EMAIL_LOG_ONLY_PREFIX) ?? false }));
    return { items, total };
  }

  async retry(ctx: RequestContext, emailId: string) {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.emailOutbox.updateMany({ where: { id: emailId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["FAILED", "SKIPPED"] } }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
      if (res.count !== 1) await this.assertExists(tx, ctx, emailId, "Only a failed or skipped email can be tried again");
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_RETRIED", entityType: "EmailOutbox", entityId: emailId });
      return { id: emailId, status: "PENDING" as const };
    });
  }

  async cancel(ctx: RequestContext, emailId: string) {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.emailOutbox.updateMany({ where: { id: emailId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "PENDING" }, data: { status: "CANCELLED", lastError: "Cancelled by staff" } });
      if (res.count !== 1) await this.assertExists(tx, ctx, emailId, "Only an email that is still waiting can be cancelled");
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_CANCELLED", entityType: "EmailOutbox", entityId: emailId });
      return { id: emailId, status: "CANCELLED" as const };
    });
  }

  private async assertExists(tx: Db, ctx: RequestContext, emailId: string, wrongState: string): Promise<never> {
    const found = await tx.emailOutbox.findFirst({ where: { id: emailId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!found) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    throw new DomainError("INVALID_STATE", wrongState, 409);
  }

  // ───────────────────────── the suppression list ─────────────────────────

  async suppressions(ctx: RequestContext) {
    const rows = await this.prisma.emailSuppression.findMany({ where: { tenantId: ctx.tenantId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200, select: { id: true, address: true, reason: true, note: true, createdAt: true } });
    return rows.map((r) => ({ ...r, address: maskEmail(r.address) }));
  }

  async addSuppression(ctx: RequestContext, input: z.infer<typeof addSuppressionSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.emailSuppression.createMany({ data: [{ tenantId: ctx.tenantId, address: input.address, reason: "MANUAL", note: input.note ?? null, createdById: ctx.userId }], skipDuplicates: true });
      if (res.count !== 1) throw new DomainError("CONFLICT", "This address is already on the list", 409);
      // Anything still waiting for this address will not be sent.
      const held = await tx.emailOutbox.updateMany({ where: { tenantId: ctx.tenantId, toAddress: input.address, status: "PENDING" }, data: { status: "SKIPPED", lastError: "The address was added to the suppression list" } });
      const row = await tx.emailSuppression.findFirstOrThrow({ where: { tenantId: ctx.tenantId, address: input.address }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_SUPPRESSION_ADDED", entityType: "EmailSuppression", entityId: row.id, metadata: { skippedWaiting: held.count } });
      return { id: row.id };
    });
  }

  async removeSuppression(ctx: RequestContext, suppressionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.emailSuppression.deleteMany({ where: { id: suppressionId, tenantId: ctx.tenantId } });
      if (res.count !== 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await this.audit.record(tx, actorOf(ctx), { action: "EMAIL_SUPPRESSION_REMOVED", entityType: "EmailSuppression", entityId: suppressionId });
    });
  }

  // ───────────────────────── sending (the worker) ─────────────────────────

  /**
   * Sends every email due at `now`. Each is claimed with FOR UPDATE SKIP LOCKED in its own short transaction, so several API servers never send the same one, and it is
   * checked again just before sending: switched off, suppressed, or the patient has withdrawn means SKIPPED.
   */
  async runDue(now = new Date(), provider: EmailProvider = this.provider, limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("email worker: hospitals with emails due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_emails(${now}::timestamptz)::text AS tenant_id`);
    let done = 0;
    for (const { tenant_id: tenantId } of tenants) {
      while (done < limit) {
        const outcome = await tenantScope.run(tenantId, () => this.prisma.$transaction((tx) => this.deliverOne(tx, now, provider)));
        if (!outcome) break;
        counts[outcome]++;
        done++;
      }
    }
    return counts;
  }

  private async deliverOne(tx: Db, now: Date, provider: EmailProvider): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; facilityId: string; attempts: number }[]>`
      SELECT id, "tenantId", "facilityId", attempts FROM "EmailOutbox"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const e = await tx.emailOutbox.findFirstOrThrow({ where, select: { templateKey: true, patientId: true, toAddress: true, subject: true, bodyText: true } });
    const skip = async (reason: string): Promise<Outcome> => {
      await tx.emailOutbox.updateMany({ where, data: { status: "SKIPPED", lastError: reason } });
      logJson("info", "email_skipped", { emailId: r.id, reason });
      return "skipped";
    };
    if (!(await this.enabled(tx, r.tenantId, r.facilityId))) return skip("Email was switched off");
    if (await tx.emailSuppression.findFirst({ where: { tenantId: r.tenantId, address: e.toAddress }, select: { id: true } })) return skip("The address is on the suppression list");
    if (e.patientId && e.templateKey !== "TEST" && !(await this.mayEmailPatient(tx, r.tenantId, r.facilityId, e.patientId))) return skip("The patient has not agreed to email");

    const facility = await tx.facility.findFirstOrThrow({ where: { id: r.facilityId, tenantId: r.tenantId }, select: { name: true } });
    const [fromName, replyTo] = await Promise.all([this.settings.get(tx, r.tenantId, r.facilityId, "EMAIL_FROM_NAME"), this.settings.get(tx, r.tenantId, r.facilityId, "EMAIL_REPLY_TO")]);
    const attempts = r.attempts + 1;
    try {
      const d = await provider.send({
        reference: r.id, to: e.toAddress, fromAddress: this.config.EMAIL_FROM_ADDRESS ?? "no-reply@example.invalid", fromName: fromName || facility.name,
        replyTo: replyTo || undefined, subject: e.subject, text: e.bodyText, html: toHtml(e.bodyText),
      });
      await tx.emailOutbox.updateMany({ where, data: { status: "SENT", sentAt: now, attempts, providerMessageId: d.providerMessageId.slice(0, 200), lastError: null } });
      return "sent";
    } catch (err) {
      // Only an EmailError's message is safe to keep; anything else is described in general words.
      const lastError = (err instanceof EmailError ? err.message : "Unexpected error while sending").slice(0, 200);
      logJson("warn", "email_delivery_failed", { emailId: r.id, provider: provider.name, attempts, error: lastError });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.emailOutbox.updateMany({ where, data: { status: "FAILED", attempts, lastError } });
        return "failed";
      }
      await tx.emailOutbox.updateMany({ where, data: { attempts, lastError, nextAttemptAt: new Date(now.getTime() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)) } });
      return "retried";
    }
  }
}
