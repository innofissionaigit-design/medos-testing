import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { visitScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SecretsService } from "../../common/secrets";
import { SettingsService } from "../settings/settings.service";
import { AiError, AnthropicProvider, ANTHROPIC_DEFAULT_URL, HttpAiProvider, type AiProvider } from "./ai.provider";
import { adviceMaterial, DRAFT_NOTICE, hasAdviceMaterial, historyMaterial, MAX_TOKENS, SYSTEM_ADVICE, SYSTEM_HISTORY, tidyReply, type MedicineFacts, type PatientFacts, type VisitFacts } from "./ai.domain";

const HOURLY_LIMIT = 20;

export const saveAiConfigSchema = z.object({
  kind: z.enum(["ANTHROPIC", "HTTP"]),
  /** HTTP: the service address (required). ANTHROPIC: leave out to use the provider's own address, or give a gateway's. */
  url: z.string().trim().min(8).max(500).optional(),
  /** ANTHROPIC: the model to ask for. */
  model: z.string().trim().min(3).max(100).optional(),
  /** Leave out to keep the saved key. Never returned by the API. */
  apiKey: z.string().min(8).max(500).optional(),
  clearKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  /** The administrator confirms that sending de-identified visit data to this provider is allowed by the hospital's agreement with it. */
  acknowledgeDataSharing: z.boolean().optional(),
}).strict().refine((v) => !(v.apiKey && v.clearKey), { message: "Either enter a new key or remove the saved one", path: ["apiKey"] })
  .refine((v) => v.kind !== "HTTP" || !!v.url, { message: "Enter the address of the service", path: ["url"] })
  .refine((v) => v.kind !== "ANTHROPIC" || !!v.model, { message: "Enter the model to use", path: ["model"] });
export const draftSchema = z.object({ task: z.enum(["HISTORY_SUMMARY", "VISIT_ADVICE"]) }).strict();
export const reviewSchema = z.object({ decision: z.enum(["USED", "DISCARDED"]), edited: z.boolean().optional() }).strict();

const toAge = (dob: Date | null, est: number | null) => {
  if (!dob) return est;
  const now = new Date();
  let a = now.getUTCFullYear() - dob.getUTCFullYear();
  if (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())) a -= 1;
  return a;
};
const str = (o: unknown, k: string): string | null => (o && typeof o === "object" && typeof (o as Record<string, unknown>)[k] === "string" && ((o as Record<string, string>)[k] ?? "").trim() ? (o as Record<string, string>)[k]!.trim() : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The AI assistant (docs/ai-assistant.md): a drafting aid for the doctor treating the patient. It is off until the hospital connects its own provider, tests it and
 * confirms the data sharing, and until the setting is on. A request sends only de-identified text built here (never a name, number or record id), the reply is
 * kept as a draft that only the requesting doctor can review, and nothing is ever written to the chart by the assistant: the doctor copies what they choose.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get production(): boolean { return this.config.NODE_ENV === "production"; }
  private row(ctx: RequestContext) { return this.prisma.aiConfig.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }); }
  private destination(kind: string, url: string | null | undefined): string { return `${kind}:${new URL(url ?? ANTHROPIC_DEFAULT_URL).origin}`; }

  private providerOf(r: NonNullable<Awaited<ReturnType<AiService["row"]>>>): AiProvider {
    const apiKey = r.apiKeyEnc ? this.secrets.decrypt(r.apiKeyEnc) : undefined;
    if (r.kind === "HTTP") return new HttpAiProvider({ url: r.url as string, apiKey, timeoutMs: r.timeoutMs, production: this.production });
    return new AnthropicProvider({ url: r.url ?? ANTHROPIC_DEFAULT_URL, apiKey, model: r.model ?? undefined, timeoutMs: r.timeoutMs, production: this.production });
  }

  async view(ctx: RequestContext) {
    const r = await this.row(ctx);
    const enabled = !!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "AI_ASSISTANT_ENABLED"));
    return {
      connected: !!r, kind: r?.kind ?? null, url: r?.url ?? null, model: r?.model ?? null, hasKey: !!r?.apiKeyEnc, keyLast4: r?.keyLast4 ?? null, timeoutMs: r?.timeoutMs ?? 30_000,
      dataSharingConfirmed: !!r?.dataAckAt, dataSharingConfirmedAt: r?.dataAckAt ?? null, lastTest: r?.lastTestAt ? { at: r.lastTestAt, ok: r.lastTestOk === true, message: r.lastTestMessage } : null,
      enabledSetting: enabled, ready: enabled && this.ready(r), canStoreKey: this.secrets.available,
    };
  }

  private ready(r: Awaited<ReturnType<AiService["row"]>>): boolean {
    return !!r && r.lastTestOk === true && !!r.dataAckAt && (r.kind === "HTTP" || !!r.apiKeyEnc);
  }

  /** For the screens: whether the assistant can be used here, and why not when it cannot. */
  async status(ctx: RequestContext) {
    const r = await this.row(ctx);
    const enabled = !!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "AI_ASSISTANT_ENABLED"));
    const available = enabled && this.ready(r);
    return { available, reason: available ? null : !enabled ? "The AI assistant is switched off for this hospital" : !r ? "No AI provider is connected" : !r.dataAckAt ? "The data sharing has not been confirmed by an administrator" : "The AI provider has not been tested successfully" };
  }

  async save(ctx: RequestContext, input: z.infer<typeof saveAiConfigSchema>) {
    let url: URL | null = null;
    if (input.url) {
      try { url = new URL(input.url); } catch { throw new DomainError("VALIDATION_FAILED", "The address is not valid", 400, [{ path: "url", message: "Not a valid address" }]); }
      const loopback = !this.production && ["127.0.0.1", "localhost"].includes(url.hostname);
      if (url.protocol !== "https:" && !loopback) throw new DomainError("VALIDATION_FAILED", "The address must start with https://", 400, [{ path: "url", message: "Use https" }]);
    }
    if (input.apiKey) this.secrets.assertAvailable();
    const existing = await this.row(ctx);
    const dest = this.destination(input.kind, url?.toString());
    const moved = !existing || this.destination(existing.kind, existing.url) !== dest;
    // A saved key must never be sent to a different place than the one it was entered for.
    if (existing?.apiKeyEnc && moved && !input.apiKey && !input.clearKey) throw new DomainError("VALIDATION_FAILED", "You changed the provider or its address. Enter the key again, or remove the saved key.", 400, [{ path: "apiKey", message: "Enter the key again" }]);
    const keyChanged = !!input.apiKey || (!!input.clearKey && !!existing?.apiKeyEnc);
    const modelChanged = (existing?.model ?? null) !== (input.model ?? null);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const data = {
        kind: input.kind, url: url?.toString() ?? null, model: input.model ?? null, timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 30_000, updatedById: ctx.userId,
        ...(input.apiKey ? { apiKeyEnc: this.secrets.encrypt(input.apiKey), keyLast4: input.apiKey.slice(-4) } : input.clearKey ? { apiKeyEnc: null, keyLast4: null } : {}),
        // Another destination, key or model has not been tested and its data sharing has not been agreed to.
        ...(moved || keyChanged || modelChanged ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
        ...(moved ? { dataAckAt: null, dataAckById: null } : {}),
        ...(input.acknowledgeDataSharing === true && (moved || !existing?.dataAckAt) ? { dataAckAt: now, dataAckById: ctx.userId } : {}),
        ...(input.acknowledgeDataSharing === false ? { dataAckAt: null, dataAckById: null } : {}),
      };
      await tx.aiConfig.upsert({ where: { tenantId_facilityId: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }, create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...data }, update: data });
      await this.audit.record(tx, actorOf(ctx), { action: "AI_CONFIG_SAVED", entityType: "AiConfig", entityId: ctx.facilityId, metadata: { kind: input.kind, host: (url ?? new URL(ANTHROPIC_DEFAULT_URL)).host, keyChanged, moved, dataSharingConfirmed: input.acknowledgeDataSharing === true } });
    });
    return this.view(ctx);
  }

  async disconnect(ctx: RequestContext) {
    const existing = await this.row(ctx);
    if (!existing) throw new DomainError("INVALID_STATE", "No AI provider is connected for this facility", 409);
    await this.prisma.$transaction(async (tx) => {
      await tx.aiConfig.deleteMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      await this.audit.record(tx, actorOf(ctx), { action: "AI_CONFIG_DISCONNECTED", entityType: "AiConfig", entityId: ctx.facilityId, metadata: { kind: existing.kind } });
    });
    return this.view(ctx);
  }

  /** Asks the provider a question that has nothing to do with any patient. A reply counts as working. */
  async test(ctx: RequestContext) {
    const r = await this.row(ctx);
    if (!r) throw new DomainError("INVALID_STATE", "Connect an AI provider first", 409);
    let ok = true;
    let message = "The AI provider answered.";
    try { await this.providerOf(r).complete({ system: "Answer with one short word.", user: "Say OK.", maxTokens: 16 }); }
    catch (e) { ok = false; message = e instanceof AiError ? e.message : "The AI provider could not be reached"; }
    await this.prisma.$transaction(async (tx) => {
      await tx.aiConfig.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message } });
      await this.audit.record(tx, actorOf(ctx), { action: "AI_CONFIG_TESTED", entityType: "AiConfig", entityId: ctx.facilityId, metadata: { ok, kind: r.kind } });
    });
    return { ok, message, ...(await this.view(ctx)) };
  }

  // ───── drafts ─────

  private async facts(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { not: "CANCELLED" }, AND: [visitScope(ctx)] }, select: { id: true, patientId: true, patient: { select: { firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, guardianName: true, emergencyContactName: true } } } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const allergies = await this.prisma.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: enc.patientId, status: "ACTIVE" }, orderBy: { recordedAt: "asc" }, take: 20, select: { allergen: true, severity: true, reaction: true } });
    const p = enc.patient;
    const patient: PatientFacts = { ageYears: toAge(p.dateOfBirth, p.estimatedAgeYears), sex: p.gender, allergies, names: [p.firstName, p.lastName, p.guardianName, p.emergencyContactName].filter((x): x is string => !!x) };
    return { patientId: enc.patientId, patient };
  }

  private medicines(items: { genericName: string; brandName: string | null; strength: string | null; dosage: string; frequency: string; frequencyText: string | null; durationDays: number | null; foodRelation: string | null; instructions: string | null }[]): MedicineFacts[] {
    return items.map((i) => ({ name: [i.brandName ?? i.genericName, i.strength].filter(Boolean).join(" "), dose: i.dosage, frequency: i.frequencyText ?? i.frequency, days: i.durationDays, food: i.foodRelation, note: i.instructions }));
  }

  private readonly ITEM = { where: { status: "ACTIVE" as const }, orderBy: { lineNo: "asc" as const }, select: { genericName: true, brandName: true, strength: true, dosage: true, frequency: true, frequencyText: true, durationDays: true, foodRelation: true, instructions: true } };

  /** Earlier signed visits of this patient that this doctor may see: the signed note, the diagnoses and the signed prescription. */
  private async earlier(ctx: RequestContext, patientId: string, exceptEncounterId: string): Promise<VisitFacts[]> {
    const rows = await this.prisma.encounter.findMany({
      where: { tenantId: ctx.tenantId, patientId, type: "OPD", status: { not: "CANCELLED" }, id: { not: exceptEncounterId }, AND: [visitScope(ctx)], documents: { some: { kind: "CONSULTATION", status: { in: ["SIGNED", "AMENDED"] } } } },
      orderBy: { startedAt: "desc" }, take: 5,
      select: {
        startedAt: true, diagnoses: { where: { status: "ACTIVE", supersededAtVersion: null }, orderBy: { recordedAt: "asc" }, select: { text: true } },
        documents: { where: { kind: "CONSULTATION", status: { in: ["SIGNED", "AMENDED"] } }, select: { versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } } } },
        medicationOrders: { where: { status: "SIGNED" }, orderBy: { signedAt: "desc" }, take: 1, select: { items: this.ITEM } },
      },
    });
    return rows.map((e) => { const c = e.documents[0]?.versions[0]?.content; return { when: day(e.startedAt), complaint: str(c, "chiefComplaint"), advice: str(c, "advice"), diagnoses: e.diagnoses.map((d) => d.text), medicines: this.medicines(e.medicationOrders[0]?.items ?? []) }; });
  }

  /** The visit in front of the doctor, as it stands now: draft or signed. */
  private async current(ctx: RequestContext, encounterId: string): Promise<VisitFacts> {
    const e = await this.prisma.encounter.findFirstOrThrow({
      where: { id: encounterId, tenantId: ctx.tenantId },
      select: {
        startedAt: true, diagnoses: { where: { status: "ACTIVE", supersededAtVersion: null }, orderBy: { recordedAt: "asc" }, select: { text: true } },
        documents: { where: { kind: "CONSULTATION" }, select: { status: true, draft: true, versions: { orderBy: { version: "desc" }, take: 1, select: { content: true } } } },
        medicationOrders: { where: { status: { in: ["DRAFT", "SIGNED"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { items: this.ITEM } },
      },
    });
    const doc = e.documents[0];
    const content = doc ? (doc.status === "DRAFT" ? doc.draft : doc.versions[0]?.content) : null;
    const inner = content && typeof content === "object" && "content" in (content as object) ? (content as { content: unknown }).content : content;
    return { when: day(e.startedAt), complaint: str(inner, "chiefComplaint"), advice: str(inner, "advice"), diagnoses: e.diagnoses.map((d) => d.text), medicines: this.medicines(e.medicationOrders[0]?.items ?? []) };
  }

  async draft(ctx: RequestContext, encounterId: string, input: z.infer<typeof draftSchema>) {
    const st = await this.status(ctx);
    if (!st.available) throw new DomainError("INVALID_STATE", st.reason ?? "The AI assistant is not available", 409);
    const { patientId, patient } = await this.facts(ctx, encounterId);
    const since = new Date(Date.now() - 3_600_000);
    if (await this.prisma.aiDraft.count({ where: { tenantId: ctx.tenantId, requestedById: ctx.userId, requestedAt: { gt: since } } }) >= HOURLY_LIMIT) throw new DomainError("CONFLICT", `You have asked the assistant ${HOURLY_LIMIT} times in the last hour. Please try again later`, 429);
    let system: string; let user: string;
    if (input.task === "HISTORY_SUMMARY") {
      const visits = await this.earlier(ctx, patientId, encounterId);
      if (visits.length === 0) throw new DomainError("INVALID_STATE", "There are no earlier signed visits to summarise", 409);
      system = SYSTEM_HISTORY; user = historyMaterial(patient, visits);
    } else {
      const v = await this.current(ctx, encounterId);
      if (!hasAdviceMaterial(v)) throw new DomainError("INVALID_STATE", "Add a diagnosis or a prescription to this visit first", 409);
      system = SYSTEM_ADVICE; user = adviceMaterial(patient, v);
    }
    const r = (await this.row(ctx))!;
    const provider = this.providerOf(r);
    let text: string; let model: string | null;
    try { const out = await provider.complete({ system, user, maxTokens: MAX_TOKENS }); text = tidyReply(out.text); model = out.model; }
    catch (e) { throw new DomainError("SERVICE_UNAVAILABLE", e instanceof AiError ? e.message : "The AI provider could not be reached", 502); }
    if (!text) throw new DomainError("SERVICE_UNAVAILABLE", "The AI provider gave no text", 502);
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.aiDraft.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, encounterId, task: input.task, outputText: text, inputChars: user.length, provider: provider.host, model, requestedById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "AI_DRAFT_REQUESTED", entityType: "AiDraft", entityId: d.id, metadata: { task: input.task, encounterId, kind: provider.kind, host: provider.host, inputChars: user.length, outputChars: text.length } });
      return { id: d.id, task: input.task, status: "DRAFT" as const, text, notice: DRAFT_NOTICE };
    });
  }

  async list(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.aiDraft.findMany({ where: { tenantId: ctx.tenantId, encounterId, requestedById: ctx.userId }, orderBy: { requestedAt: "desc" }, take: 20 });
    return rows.map((d) => ({ id: d.id, task: d.task, status: d.status, text: d.outputText, requestedAt: d.requestedAt, reviewedAt: d.reviewedAt, edited: d.edited, notice: DRAFT_NOTICE }));
  }

  /** The doctor says what they did with it: used it (perhaps after editing) or threw it away. Only the doctor who asked can say. */
  async review(ctx: RequestContext, id: string, input: z.infer<typeof reviewSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.aiDraft.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, requestedById: ctx.userId }, select: { id: true, encounterId: true } });
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const res = await tx.aiDraft.updateMany({ where: { id, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: input.decision, reviewedAt: new Date(), edited: input.decision === "USED" && input.edited === true } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This draft has already been reviewed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "AI_DRAFT_REVIEWED", entityType: "AiDraft", entityId: id, metadata: { decision: input.decision, edited: input.edited === true, encounterId: d.encounterId } });
      return { id, status: input.decision };
    });
  }
}
