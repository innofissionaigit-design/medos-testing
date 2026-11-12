import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { tenantScope } from "../../common/tenant-scope";
import { NumberingService } from "../numbering/numbering.service";
import { reminderConsentState, remindersAllowed } from "../privacy/consent";
import { SettingsService } from "../settings/settings.service";
import { REMINDER_PROVIDER, type ReminderProvider } from "../follow-ups/reminder.provider";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const LINK_DAYS = 14;
const notValid = () => new DomainError("NOT_FOUND", "This link is not valid or has expired", 404);

export const publicFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
  complaint: z.object({ category: z.string().trim().min(2).max(60), description: z.string().trim().min(10).max(2000) }).strict().optional(),
}).strict();
export const feedbackLinkSchema = z.object({ send: z.boolean().default(false) }).strict();

/**
 * The patient's own feedback form (docs/aftercare.md): a secret link, used once, that needs no sign-in. Staff make it (or the worker does after a review visit) and it can be
 * texted. Only the link's hash is stored; a wrong, expired or used link all look the same.
 */
@Injectable()
export class FeedbackLinkService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly numbering: NumberingService, private readonly settings: SettingsService,
    @Inject(REMINDER_PROVIDER) private readonly provider: ReminderProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** A staff member makes a link for a review task; `send` also texts it to the patient (when they have a number and agreed to messages). */
  async issueForStaff(ctx: RequestContext, taskId: string, input: z.infer<typeof feedbackLinkSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.aftercareTask.findFirst({ where: { id: taskId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
      if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const r = await this.issue(tx, { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, requestId: ctx.requestId }, taskId, input.send);
      await this.audit.record(tx, actorOf(ctx), { action: "FEEDBACK_LINK_ISSUED", entityType: "AftercareTask", entityId: taskId, metadata: { texted: r.sent } });
      return r;
    });
  }

  async issue(tx: Db, actor: { tenantId: string; facilityId: string; userId: string; requestId?: string | null }, taskId: string, send: boolean, baseUrl: string | undefined = this.config.PUBLIC_WEB_URL, provider: ReminderProvider = this.provider) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000);
    const req = await tx.feedbackRequest.create({ data: { tenantId: actor.tenantId, facilityId: actor.facilityId, taskId, tokenHash: sha256(token), expiresAt, createdById: actor.userId } });
    const path = `/feedback/${token}`;
    let sent = false, why: string | null = null;
    if (send) {
      const t = await tx.aftercareTask.findFirstOrThrow({ where: { id: taskId, tenantId: actor.tenantId }, select: { patientId: true, patient: { select: { mobile: true } }, facility: { select: { name: true } } } });
      if (!t.patient.mobile) why = "The patient has no mobile number";
      else if (!baseUrl) why = "The hospital's web address is not set, so the link cannot be texted";
      else if (!remindersAllowed(await reminderConsentState(tx, actor.tenantId, t.patientId), await this.settings.get(tx, actor.tenantId, actor.facilityId, "REMINDERS_REQUIRE_CONSENT"))) why = "The patient has not agreed to messages";
      else {
        try {
          await provider.send({ reminderId: req.id, appointmentId: taskId, to: t.patient.mobile, text: `Thank you for visiting ${t.facility.name}. Please tell us how we did: ${baseUrl.replace(/\/$/, "")}${path}` });
          await tx.feedbackRequest.update({ where: { tenantId_id: { tenantId: actor.tenantId, id: req.id } }, data: { sentAt: new Date() } });
          sent = true;
        } catch (e) { why = (e instanceof Error ? e.message : "The message could not be sent").slice(0, 200); }
      }
    }
    return { id: req.id, path, expiresAt, sent, notSentBecause: why };
  }

  /** What the patient sees before answering: which hospital is asking. */
  async info(token: string) {
    const hit = await this.resolve(token);
    return tenantScope.run(hit.tenantId, async () => {
      const r = await this.live(hit);
      const f = await this.prisma.facility.findFirstOrThrow({ where: { id: r.facilityId, tenantId: r.tenantId }, select: { name: true } });
      return { hospital: f.name, expiresAt: r.expiresAt };
    });
  }

  async submit(token: string, input: z.infer<typeof publicFeedbackSchema>, requestId: string) {
    const hit = await this.resolve(token);
    return tenantScope.run(hit.tenantId, () => this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "FeedbackRequest" WHERE id = ${hit.requestId}::uuid AND "tenantId" = ${hit.tenantId}::uuid AND "usedAt" IS NULL AND "expiresAt" > now() FOR UPDATE`;
      if (rows.length === 0) throw notValid();
      const r = await tx.feedbackRequest.findFirstOrThrow({ where: { id: hit.requestId, tenantId: hit.tenantId }, include: { task: { select: { patientId: true, admissionId: true } } } });
      const actor = { tenantId: r.tenantId, facilityId: r.facilityId, userId: r.createdById, requestId };
      const fb = await tx.patientFeedback.create({ data: { tenantId: r.tenantId, facilityId: r.facilityId, patientId: r.task.patientId, admissionId: r.task.admissionId, taskId: r.taskId, rating: input.rating, comment: input.comment || null, channel: "FORM", recordedById: r.createdById, viaLink: true } });
      await tx.feedbackRequest.update({ where: { tenantId_id: { tenantId: r.tenantId, id: r.id } }, data: { usedAt: new Date(), feedbackId: fb.id } });
      await this.audit.record(tx, actor, { action: "FEEDBACK_RECORDED", entityType: "PatientFeedback", entityId: fb.id, metadata: { rating: input.rating, channel: "FORM", viaLink: true } });
      let complaintNumber: string | null = null;
      if (input.complaint) {
        complaintNumber = await this.numbering.next(tx, r.tenantId, r.facilityId, "COMPLAINT");
        const hours = await this.settings.get(tx, r.tenantId, r.facilityId, "COMPLAINT_HOURS_MEDIUM");
        const created = new Date();
        const c = await tx.complaint.create({ data: { tenantId: r.tenantId, facilityId: r.facilityId, complaintNumber, createdAt: created, dueAt: new Date(created.getTime() + hours * 3_600_000), patientId: r.task.patientId, feedbackId: fb.id, taskId: r.taskId, category: input.complaint.category, severity: "MEDIUM", description: input.complaint.description, createdById: r.createdById } });
        await tx.complaintNote.create({ data: { tenantId: r.tenantId, complaintId: c.id, kind: "RAISED", note: "Raised by the patient through the feedback link", byId: r.createdById } });
        await this.audit.record(tx, actor, { action: "COMPLAINT_RAISED", entityType: "Complaint", entityId: c.id, metadata: { complaintNumber, category: input.complaint.category, severity: "MEDIUM", viaLink: true } });
      }
      return { thanks: true, complaintNumber };
    }));
  }

  private async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notValid();
    const found = await tenantScope.system("feedback link: find the hospital that issued it", () =>
      this.prisma.$queryRaw<{ tenant_id: string; request_id: string }[]>`SELECT tenant_id::text AS tenant_id, request_id::text AS request_id FROM medos_resolve_feedback_request(${sha256(token)})`);
    if (!found[0]) throw notValid();
    return { tenantId: found[0].tenant_id, requestId: found[0].request_id };
  }

  private async live(hit: { tenantId: string; requestId: string }) {
    const r = await this.prisma.feedbackRequest.findFirst({ where: { id: hit.requestId, tenantId: hit.tenantId } });
    if (!r || r.usedAt || r.expiresAt.getTime() <= Date.now()) throw notValid();
    return r;
  }
}
