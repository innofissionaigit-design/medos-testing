import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SettingsService } from "../settings/settings.service";

export const SCRIPT_KINDS = ["FIRST_CALL", "CALL_BACK", "BOOKING", "DECLINED", "FEEDBACK"] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];
const PLACEHOLDERS = ["patient", "doctor", "due", "hospital"] as const;

/** The wording used until a hospital writes its own. Plain and short; the caller reads it, they do not recite it. */
export const DEFAULT_SCRIPTS: Record<ScriptKind, { title: string; body: string }> = {
  FIRST_CALL: { title: "First call", body: "Hello, may I speak with {patient}? This is {hospital}. We are calling to ask how you are feeling after your stay with us. Your review visit with {doctor} is due around {due}. Would you like me to book a time for you? If you feel unwell now, please come to the hospital or call us straight away." },
  CALL_BACK: { title: "Call back", body: "Hello {patient}, this is {hospital}. You asked us to call you back about your review visit with {doctor}, which is due around {due}. Is this a good time? Shall I book it now?" },
  BOOKING: { title: "Booking the visit", body: "Let us choose a day and time with {doctor} that suits you. Please bring your discharge papers, reports and all medicines you are taking. Please say the date and time back to me so we are both sure. We will send a reminder before the visit." },
  DECLINED: { title: "If the patient does not want a review", body: "Thank you for telling us, {patient}. May I note why, so we can improve? If you feel unwell or have any worry later, please call {hospital}; we are happy to see you at any time." },
  FEEDBACK: { title: "Asking for feedback", body: "{patient}, may I ask how your care at {hospital} was, from 1 (poor) to 5 (excellent)? Is there anything we should do better? If something went wrong, I can have someone look into it and call you." },
};

export const scriptBodySchema = z.object({ body: z.string().trim().min(10).max(1500) }).strict()
  .refine((v) => [...v.body.matchAll(/\{([^}]*)\}/g)].every((m) => (PLACEHOLDERS as readonly string[]).includes(m[1]!)), { path: ["body"], message: `Only ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")} can be used between braces` });
export const scriptQuerySchema = z.object({ kind: z.enum(SCRIPT_KINDS).optional() }).strict();

const fill = (body: string, v: Record<(typeof PLACEHOLDERS)[number], string>) => body.replace(/\{(patient|doctor|due|hospital)\}/g, (_, k: (typeof PLACEHOLDERS)[number]) => v[k]);

/** What a caller says (docs/aftercare.md): built-in wording, or the hospital's own, with the patient, doctor, due date and hospital filled in. */
@Injectable()
export class AftercareScriptsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  async list(ctx: RequestContext) {
    const own = new Map((await this.prisma.aftercareScript.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } })).map((s) => [s.kind, s]));
    return SCRIPT_KINDS.map((kind) => ({ kind, title: DEFAULT_SCRIPTS[kind].title, body: own.get(kind)?.body ?? DEFAULT_SCRIPTS[kind].body, isDefault: !own.has(kind), defaultBody: DEFAULT_SCRIPTS[kind].body, updatedAt: own.get(kind)?.updatedAt ?? null }));
  }

  async save(ctx: RequestContext, kind: ScriptKind, input: z.infer<typeof scriptBodySchema>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.aftercareScript.upsert({
        where: { tenantId_facilityId_kind: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind } },
        create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind, body: input.body, updatedById: ctx.userId }, update: { body: input.body, updatedById: ctx.userId },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_SCRIPT_SAVED", entityType: "AftercareScript", entityId: null, metadata: { kind, length: input.body.length } });
    });
    return (await this.list(ctx)).find((s) => s.kind === kind)!;
  }

  async reset(ctx: RequestContext, kind: ScriptKind) {
    await this.prisma.$transaction(async (tx) => {
      await tx.aftercareScript.deleteMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind } });
      await this.audit.record(tx, actorOf(ctx), { action: "AFTERCARE_SCRIPT_RESET", entityType: "AftercareScript", entityId: null, metadata: { kind } });
    });
    return (await this.list(ctx)).find((s) => s.kind === kind)!;
  }

  /** The script for one patient's call: the first call, or a call-back once they have been called, unless a kind is asked for. */
  async forTask(ctx: RequestContext, taskId: string, q: z.infer<typeof scriptQuerySchema>) {
    const t = await this.prisma.aftercareTask.findFirst({
      where: { id: taskId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      select: { dueDate: true, attempts: true, patient: { select: { firstName: true } }, admission: { select: { consultant: { select: { displayName: true } } } }, facility: { select: { name: true } } },
    });
    if (!t) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const kind: ScriptKind = q.kind ?? (t.attempts > 0 ? "CALL_BACK" : "FIRST_CALL");
    const own = await this.prisma.aftercareScript.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, kind }, select: { body: true } });
    const due = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", timeZone: "UTC" }).format(t.dueDate);
    const text = fill(own?.body ?? DEFAULT_SCRIPTS[kind].body, { patient: t.patient.firstName, doctor: t.admission.consultant?.displayName ?? "your doctor", due, hospital: t.facility.name });
    return { kind, title: DEFAULT_SCRIPTS[kind].title, text, isDefault: !own, kinds: SCRIPT_KINDS.map((k) => ({ kind: k, title: DEFAULT_SCRIPTS[k].title })) };
  }

  /**
   * Today's calls against the targets (AFTERCARE_DAILY_CALL_TARGET, AFTERCARE_DAILY_BOOKING_TARGET; 0 = no target), in the hospital's own day: mine, and, for people who may
   * configure the call centre, everyone's. A call counts as reached when someone answered (anything but no answer or a wrong number).
   */
  async targets(ctx: RequestContext) {
    const fac = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const [callTarget, bookingTarget] = await Promise.all([this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "AFTERCARE_DAILY_CALL_TARGET"), this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "AFTERCARE_DAILY_BOOKING_TARGET")]);
    const rows = await this.prisma.$queryRaw<{ userId: string; calls: number; reached: number; bookings: number }[]>`
      SELECT c."byId"::text AS "userId", COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE c.outcome NOT IN ('NO_ANSWER', 'WRONG_NUMBER'))::int AS reached, COUNT(*) FILTER (WHERE c.outcome = 'BOOKED')::int AS bookings
      FROM "ContactAttempt" c JOIN "AftercareTask" t ON t.id = c."taskId" AND t."tenantId" = c."tenantId"
      WHERE c."tenantId" = ${ctx.tenantId}::uuid AND t."facilityId" = ${ctx.facilityId}::uuid AND (c.at AT TIME ZONE ${fac.timezone})::date = (now() AT TIME ZONE ${fac.timezone})::date
      GROUP BY c."byId"`;
    const mine = rows.find((r) => r.userId === ctx.userId) ?? { userId: ctx.userId, calls: 0, reached: 0, bookings: 0 };
    const view = (r: { calls: number; reached: number; bookings: number }) => ({
      calls: r.calls, reached: r.reached, bookings: r.bookings,
      callsPercent: callTarget > 0 ? Math.min(100, Math.round((r.calls / callTarget) * 100)) : null, bookingsPercent: bookingTarget > 0 ? Math.min(100, Math.round((r.bookings / bookingTarget) * 100)) : null,
    });
    const team = ctx.permissions.has("AFTERCARE_CONFIGURE")
      ? await (async () => {
          const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
          return rows.map((r) => ({ userId: r.userId, name: users.get(r.userId) ?? null, ...view(r) })).sort((a, b) => b.calls - a.calls);
        })()
      : null;
    return { callTarget, bookingTarget, mine: view(mine), team };
  }
}
