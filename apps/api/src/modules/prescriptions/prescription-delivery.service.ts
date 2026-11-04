import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { visitScope } from "../../common/data-scope";
import { logJson } from "../../common/logger";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { indianMobile, MESSAGE_PROVIDER, MessageError, type MessageChannel, type MessageProvider } from "./message.provider";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const mask = (m: string) => `${"•".repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`;
/** Minutes to wait after each failed attempt; the fourth failure gives up (staff can retry by hand). */
const BACKOFF_MINUTES = [1, 5, 30];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
type Outcome = "sent" | "retried" | "failed";

/**
 * Sending the patient their signed prescription (docs/prescriptions.md). A message with a private link goes to the patient's own mobile by WhatsApp or SMS through
 * the connected provider: automatically when the prescription is signed (if the hospital turned that on) or when staff press Send. The link is made when the message
 * is sent, only a hash of its secret is kept, and the message text and the full number are never stored. A patient who has withdrawn consent to messages is never sent one.
 */
@Injectable()
export class PrescriptionDeliveryService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private base(): string { return (this.config.PUBLIC_WEB_URL ?? this.config.CORS_ORIGINS.split(",")[0] ?? "http://localhost:3000").trim().replace(/\/+$/, ""); }

  /** What the screens need to say: whether anything real is connected, and what the hospital chose. */
  async config_(ctx: RequestContext) {
    const [autoSend, channel, days] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_AUTO_SEND"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_SEND_CHANNEL"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_LINK_DAYS"),
    ]);
    return { provider: this.provider.name, connected: this.provider.configured, autoSend, channel, linkDays: days };
  }

  /** Called inside the transaction that signs a prescription: queues the message when the hospital sends them automatically. Never fails the signing. */
  async queueAuto(tx: Db, ctx: RequestContext, encounterId: string): Promise<void> {
    try {
      if (!(await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_AUTO_SEND"))) return;
      const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, patient: { select: { mobile: true } } } });
      const mobile = indianMobile(enc?.patient.mobile);
      if (!enc || !mobile) return;
      const requireConsent = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "REMINDERS_REQUIRE_CONSENT");
      if (!remindersAllowed(await reminderConsentState(tx, ctx.tenantId, enc.patientId), requireConsent)) return;
      if (await tx.prescriptionDelivery.count({ where: { tenantId: ctx.tenantId, encounterId, trigger: "AUTO", status: { in: ["PENDING", "SENT"] } } }) > 0) return;
      const channel = await this.settings.get(tx, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_SEND_CHANNEL");
      await tx.prescriptionDelivery.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, patientId: enc.patientId, channel, toMask: mask(mobile), trigger: "AUTO", createdById: ctx.userId } });
    } catch (e) {
      // A problem with messaging must never stop a doctor signing a prescription.
      logJson("error", "prescription_delivery_queue_failed", { encounterId, errorName: e instanceof Error ? e.name : typeof e });
    }
  }

  /** Staff press Send: queue a message for this visit's prescription and try it at once. */
  async sendNow(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true, patientId: true, patient: { select: { mobile: true } } } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const signed = (await this.prisma.clinicalDocument.count({ where: { tenantId: ctx.tenantId, encounterId, kind: "CONSULTATION", status: { not: "DRAFT" } } }))
      + (await this.prisma.medicationOrder.count({ where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED", source: "DIGITAL" } }));
    if (signed === 0) throw new DomainError("INVALID_STATE", "Only a signed prescription can be sent to the patient", 409);
    const mobile = indianMobile(enc.patient.mobile);
    if (!mobile) throw new DomainError("INVALID_STATE", "This patient has no mobile number saved that a message can be sent to", 409);
    if (!remindersAllowed(await reminderConsentState(this.prisma, ctx.tenantId, enc.patientId), false)) throw new DomainError("INVALID_STATE", "This patient has asked not to be sent messages", 409);
    const channel = await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_SEND_CHANNEL");
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.prescriptionDelivery.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, patientId: enc.patientId, channel, toMask: mask(mobile), trigger: "MANUAL", createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SEND_REQUESTED", entityType: "PrescriptionDelivery", entityId: r.id, metadata: { encounterId, channel, to: mask(mobile) } });
      return r;
    });
    await this.deliverNow(row.id);
    return (await this.views(this.prisma, ctx, { id: row.id }))[0]!;
  }

  /** A failed message goes back in the queue and is tried again now. */
  async retry(ctx: RequestContext, deliveryId: string) {
    const res = await this.prisma.prescriptionDelivery.updateMany({ where: { id: deliveryId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "FAILED" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    if (res.count !== 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SEND_RETRIED", entityType: "PrescriptionDelivery", entityId: deliveryId }));
    await this.deliverNow(deliveryId);
    return (await this.views(this.prisma, ctx, { id: deliveryId }))[0]!;
  }

  async list(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.views(this.prisma, ctx, { encounterId });
  }

  private async views(db: Db | PrismaService, ctx: RequestContext, f: { id?: string; encounterId?: string }) {
    const rows = await db.prescriptionDelivery.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(f.id ? { id: f.id } : {}), ...(f.encounterId ? { encounterId: f.encounterId } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    const users = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, encounterId: r.encounterId, channel: r.channel, to: r.toMask, trigger: r.trigger, status: r.status, attempts: r.attempts, createdAt: r.createdAt, sentAt: r.sentAt,
      provider: r.providerName, sentForReal: r.status === "SENT" && !(r.providerMessageId ?? "").startsWith("log-only:"), error: r.lastError, by: users.get(r.createdById) ?? null,
    }));
  }

  // ───── sending ─────

  private async deliverNow(deliveryId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.deliverOne(tx, new Date(Date.now() + 5_000), deliveryId)); // a moment ahead: the database clock may run a few milliseconds ahead of this one
  }

  /** Sends what is due, hospital by hospital under each hospital's own scope. Safe on several servers: rows are claimed with SKIP LOCKED. */
  async runDue(now = new Date(), limit = 100): Promise<Record<Outcome, number>> {
    const counts: Record<Outcome, number> = { sent: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("prescription delivery worker: hospitals with messages due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_prescription_deliveries(${now}::timestamptz)::text AS tenant_id`);
    let done = 0;
    for (const { tenant_id: tenantId } of tenants) {
      while (done < limit) {
        const outcome = await tenantScope.run(tenantId, () => this.prisma.$transaction((tx) => this.deliverOne(tx, now)));
        if (!outcome) break;
        counts[outcome]++;
        done++;
      }
    }
    return counts;
  }

  private async deliverOne(tx: Db, now: Date, only?: string): Promise<Outcome | null> {
    const [r] = await tx.$queryRaw<{ id: string; tenantId: string; facilityId: string; encounterId: string; patientId: string; channel: string; attempts: number; shareId: string | null }[]>`
      SELECT id, "tenantId", "facilityId", "encounterId", "patientId", channel, attempts, "shareId" FROM "PrescriptionDelivery"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} AND (${only ?? null}::uuid IS NULL OR id = ${only ?? null}::uuid)
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!r) return null;
    const where = { id: r.id, tenantId: r.tenantId };
    const by = await this.sender(tx, r.id, r.tenantId);
    const fail = async (reason: string): Promise<Outcome> => {
      await tx.prescriptionDelivery.updateMany({ where, data: { status: "FAILED", lastError: reason, attempts: r.attempts + 1, providerName: this.provider.name } });
      logJson("info", "prescription_delivery_not_sent", { deliveryId: r.id, reason });
      return "failed";
    };
    const enc = await tx.encounter.findFirst({ where: { id: r.encounterId, tenantId: r.tenantId }, select: { id: true, patient: { select: { firstName: true, mobile: true } }, facility: { select: { name: true } } } });
    const mobile = indianMobile(enc?.patient.mobile);
    if (!enc || !mobile) return fail("The patient has no mobile number that a message can be sent to");
    // Consent is looked at again when sending: it may have been withdrawn since the message was queued.
    if (!remindersAllowed(await reminderConsentState(tx, r.tenantId, r.patientId), false)) return fail("The patient has asked not to be sent messages");
    const days = await this.settings.get(tx, r.tenantId, r.facilityId, "PRESCRIPTION_LINK_DAYS");
    // A new link for every attempt: the secret of an earlier one is not kept, so it cannot be sent again; the earlier link is withdrawn.
    if (r.shareId) await tx.prescriptionShare.updateMany({ where: { id: r.shareId, tenantId: r.tenantId, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now, revokedById: by } });
    const token = randomBytes(32).toString("base64url");
    const share = await tx.prescriptionShare.create({
      data: { tenantId: r.tenantId, facilityId: r.facilityId, encounterId: r.encounterId, patientId: r.patientId, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + days * 86_400_000), recipientMask: mask(mobile), createdById: by },
      select: { id: true },
    });
    await tx.prescriptionDelivery.updateMany({ where, data: { shareId: share.id } });
    const text = `Dear ${enc.patient.firstName}, your prescription from ${enc.facility.name} is ready: ${this.base()}/api/share/${token} (this link works for ${days} day${days === 1 ? "" : "s"}).`;
    const attempts = r.attempts + 1;
    try {
      const d = await this.provider.send({ channel: r.channel as MessageChannel, to: mobile, text, reference: r.id });
      await tx.prescriptionDelivery.updateMany({ where, data: { status: "SENT", attempts, sentAt: new Date(), providerName: this.provider.name, providerMessageId: d.providerMessageId, lastError: null } });
      await this.audit.record(tx, { tenantId: r.tenantId, facilityId: r.facilityId, userId: by }, { action: "PRESCRIPTION_SENT", entityType: "PrescriptionDelivery", entityId: r.id, metadata: { encounterId: r.encounterId, channel: r.channel, to: mask(mobile), provider: this.provider.name, shareId: share.id } });
      return "sent";
    } catch (e) {
      const reason = e instanceof MessageError ? e.message : "The message could not be sent";
      logJson("warn", "prescription_delivery_failed", { deliveryId: r.id, attempt: attempts, errorName: e instanceof Error ? e.name : typeof e });
      await tx.prescriptionShare.updateMany({ where: { id: share.id, tenantId: r.tenantId }, data: { status: "REVOKED", revokedAt: now, revokedById: by } });
      if (attempts >= MAX_ATTEMPTS) {
        await tx.prescriptionDelivery.updateMany({ where, data: { status: "FAILED", attempts, lastError: reason, providerName: this.provider.name } });
        return "failed";
      }
      await tx.prescriptionDelivery.updateMany({ where, data: { attempts, lastError: reason, providerName: this.provider.name, nextAttemptAt: new Date(now.getTime() + (BACKOFF_MINUTES[attempts - 1] ?? 30) * 60_000) } });
      return "retried";
    }
  }

  /** The person who asked for the message (the doctor who signed, or the staff member who pressed Send). */
  private async sender(tx: Db, deliveryId: string, tenantId: string): Promise<string> {
    return (await tx.prescriptionDelivery.findFirstOrThrow({ where: { id: deliveryId, tenantId }, select: { createdById: true } })).createdById;
  }
}
