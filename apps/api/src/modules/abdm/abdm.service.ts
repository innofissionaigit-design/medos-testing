import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SecretsService } from "../../common/secrets";

export const saveAbdmConfigSchema = z.object({
  environment: z.enum(["SANDBOX", "PRODUCTION"]),
  /** The gateway session address, exactly as ABDM's current documentation gives it for this environment. */
  sessionUrl: z.string().trim().min(12).max(500),
  clientId: z.string().trim().min(3).max(200),
  /** Leave out to keep the saved secret. Never returned by the API. */
  clientSecret: z.string().min(8).max(500).optional(),
  clearSecret: z.boolean().optional(),
  hfrId: z.string().trim().min(3).max(60).optional(),
}).strict().refine((v) => !(v.clientSecret && v.clearSecret), { message: "Either enter a new secret or remove the saved one", path: ["clientSecret"] });

/** An ABHA number is 14 digits; people write it with dashes or spaces. */
const abhaNumber = z.string().trim().transform((v) => v.replace(/[\s-]/g, "")).pipe(z.string().regex(/^\d{14}$/, "An ABHA number has 14 digits, for example 91-1234-5678-9012"));
export const recordAbhaSchema = z.object({
  abhaNumber,
  abhaAddress: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,}@(abdm|sbx)$/, "An ABHA address looks like name@abdm").optional(),
}).strict();
export const removeAbhaSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();

const dashed = (n: string) => `${n.slice(0, 2)}-${n.slice(2, 6)}-${n.slice(6, 10)}-${n.slice(10)}`;
const mask = (n: string) => `${n.slice(0, 2)}-••••-••••-${n.slice(10)}`;

/**
 * ABDM groundwork (docs/abdm.md). Two things are real here: staff can record a patient's ABHA number (and search by it), and the facility's gateway credentials
 * are kept encrypted with a connection test. Verifying an ABHA, linking care contexts and sharing records are not built: they need ABDM sandbox credentials
 * and the current ABDM specifications, and nothing is faked in their place. Every screen says an ABHA here is "recorded, not verified".
 */
@Injectable()
export class AbdmService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly secrets: SecretsService, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get production(): boolean { return this.config.NODE_ENV === "production"; }
  private row(ctx: RequestContext) { return this.prisma.abdmConfig.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }); }

  async view(ctx: RequestContext) {
    const r = await this.row(ctx);
    const tested = r?.lastTestOk === true;
    return {
      environment: r?.environment ?? "SANDBOX", sessionUrl: r?.sessionUrl ?? null, clientId: r?.clientId ?? null, hfrId: r?.hfrId ?? null, hasSecret: !!r?.clientSecretEnc, secretLast4: r?.secretLast4 ?? null,
      lastTest: r?.lastTestAt ? { at: r.lastTestAt, ok: r.lastTestOk === true, message: r.lastTestMessage } : null, canStoreSecret: this.secrets.available,
      capabilities: [
        { name: "Record a patient's ABHA number and find the patient by it", state: "AVAILABLE" },
        { name: "Keep the facility's ABDM credentials, encrypted", state: this.secrets.available ? "AVAILABLE" : "NEEDS_SERVER_KEY" },
        { name: "Test the connection to the ABDM gateway", state: r?.sessionUrl && r.clientId && r.clientSecretEnc ? (tested ? "TESTED_OK" : "NOT_TESTED") : "NOT_CONFIGURED" },
        { name: "Verify an ABHA with ABDM", state: "NOT_BUILT" },
        { name: "Link care contexts (visits) to an ABHA", state: "NOT_BUILT" },
        { name: "Consent requests and sharing of health records", state: "NOT_BUILT" },
      ],
    };
  }

  async save(ctx: RequestContext, input: z.infer<typeof saveAbdmConfigSchema>) {
    let url: URL;
    try { url = assertOutboundUrl(input.sessionUrl, this.production, "ABDM gateway"); } catch (e) {
      throw new DomainError("VALIDATION_FAILED", e instanceof Error ? e.message : "Invalid address", 400, [{ path: "sessionUrl", message: e instanceof Error ? e.message : "Invalid address" }]);
    }
    const loopback = !this.production && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) throw new DomainError("VALIDATION_FAILED", "The gateway address must start with https://", 400, [{ path: "sessionUrl", message: "Use https" }]);
    if (input.clientSecret) this.secrets.assertAvailable();
    const existing = await this.row(ctx);
    // A saved secret must never be sent to a different place than the one it was entered for.
    if (existing?.clientSecretEnc && existing.sessionUrl && new URL(existing.sessionUrl).origin !== url.origin && !input.clientSecret && !input.clearSecret) {
      throw new DomainError("VALIDATION_FAILED", "You changed the address. Enter the client secret again, or remove the saved one.", 400, [{ path: "clientSecret", message: "Enter the client secret again" }]);
    }
    const secretChanged = !!input.clientSecret || (!!input.clearSecret && !!existing?.clientSecretEnc);
    await this.prisma.$transaction(async (tx) => {
      const data = {
        environment: input.environment, sessionUrl: url.toString(), clientId: input.clientId, hfrId: input.hfrId ?? null, updatedById: ctx.userId,
        ...(input.clientSecret ? { clientSecretEnc: this.secrets.encrypt(input.clientSecret), secretLast4: input.clientSecret.slice(-4) } : input.clearSecret ? { clientSecretEnc: null, secretLast4: null } : {}),
        ...(existing?.sessionUrl !== url.toString() || existing?.clientId !== input.clientId || existing?.environment !== input.environment || secretChanged ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      };
      await tx.abdmConfig.upsert({ where: { tenantId_facilityId: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }, create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...data }, update: data });
      await this.audit.record(tx, actorOf(ctx), { action: "ABDM_CONFIG_SAVED", entityType: "AbdmConfig", entityId: ctx.facilityId, metadata: { environment: input.environment, host: url.host, secretChanged, secretRemoved: !!input.clearSecret } });
    });
    return this.view(ctx);
  }

  async disconnect(ctx: RequestContext) {
    const existing = await this.row(ctx);
    if (!existing?.sessionUrl) throw new DomainError("INVALID_STATE", "No ABDM connection is saved for this facility", 409);
    await this.prisma.$transaction(async (tx) => {
      await tx.abdmConfig.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, data: { sessionUrl: null, clientId: null, clientSecretEnc: null, secretLast4: null, hfrId: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null, updatedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "ABDM_CONFIG_DISCONNECTED", entityType: "AbdmConfig", entityId: ctx.facilityId, metadata: { host: new URL(existing.sessionUrl as string).host } });
    });
    return this.view(ctx);
  }

  /**
   * Asks the gateway for a session with the saved credentials. A reply that carries an access token means the address and credentials are accepted. The token is thrown
   * away: nothing else is done with ABDM. The message never contains the secret, the token or ABDM's reply.
   */
  async test(ctx: RequestContext) {
    const r = await this.row(ctx);
    if (!r?.sessionUrl || !r.clientId || !r.clientSecretEnc) throw new DomainError("INVALID_STATE", "Save the gateway address, client id and client secret first", 409);
    let ok = false;
    let message = "";
    try {
      const url = assertOutboundUrl(r.sessionUrl, this.production, "ABDM gateway");
      await assertResolvesPublic(url, this.production);
      const res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ clientId: r.clientId, clientSecret: this.secrets.decrypt(r.clientSecretEnc), grantType: "client_credentials" }),
      });
      const body = (await res.json().catch(() => null)) as { accessToken?: unknown } | null;
      if (res.ok && typeof body?.accessToken === "string" && body.accessToken.length > 10) { ok = true; message = "ABDM accepted the credentials and gave a session."; }
      else if (res.status === 400 || res.status === 401 || res.status === 403) message = "ABDM did not accept the client id and secret. Check them against what ABDM sent you.";
      else if (res.status === 404) message = "ABDM does not know this address. Check it against ABDM's current documentation.";
      else message = res.ok ? "ABDM answered, but not with a session. Check the address against ABDM's current documentation." : `ABDM returned an error (HTTP ${res.status}).`;
    } catch (e) {
      logJson("warn", "abdm_test_failed", { tenantId: ctx.tenantId, facilityId: ctx.facilityId, reason: e instanceof Error ? e.name : "unknown" });
      message = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "ABDM did not answer in time." : "ABDM could not be reached from the server.";
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.abdmConfig.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message } });
      await this.audit.record(tx, actorOf(ctx), { action: "ABDM_CONFIG_TESTED", entityType: "AbdmConfig", entityId: ctx.facilityId, metadata: { ok, environment: r.environment } });
    });
    return { ok, message, ...(await this.view(ctx)) };
  }

  // ───── ABHA numbers on the chart ─────

  private abhaView(l: { id: string; abhaNumber: string; abhaAddress: string | null; recordedAt: Date; removedAt: Date | null; removeReason: string | null }, full: boolean) {
    return { id: l.id, abhaNumber: full ? dashed(l.abhaNumber) : mask(l.abhaNumber), abhaAddress: l.abhaAddress, recordedAt: l.recordedAt, removedAt: l.removedAt, removeReason: l.removeReason, verified: false as const, status: "RECORDED_NOT_VERIFIED" as const };
  }

  async abha(ctx: RequestContext, patientId: string) {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.abhaLink.findMany({ where: { tenantId: ctx.tenantId, patientId }, orderBy: { recordedAt: "desc" }, take: 20 });
    return rows.map((l) => this.abhaView(l, !l.removedAt));
  }

  async record(ctx: RequestContext, patientId: string, input: z.infer<typeof recordAbhaSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId, mergedIntoId: null }, select: { id: true } });
      if (!p) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`abha:${ctx.tenantId}:${input.abhaNumber}`}, 0))`;
      if (await tx.abhaLink.count({ where: { tenantId: ctx.tenantId, patientId, removedAt: null } }) > 0) throw new DomainError("CONFLICT", "This patient already has an ABHA recorded. Remove it first if it is wrong", 409);
      const other = await tx.abhaLink.findFirst({ where: { tenantId: ctx.tenantId, abhaNumber: input.abhaNumber, removedAt: null }, select: { patient: { select: { identifiers: { where: { type: "MRN" }, select: { value: true } } } } } });
      if (other) throw new DomainError("CONFLICT", `This ABHA number is already recorded for another patient (MRN ${other.patient.identifiers[0]?.value ?? "unknown"}). They may be the same person`, 409);
      const l = await tx.abhaLink.create({ data: { tenantId: ctx.tenantId, patientId, abhaNumber: input.abhaNumber, abhaAddress: input.abhaAddress ?? null, recordedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "ABHA_RECORDED", entityType: "AbhaLink", entityId: l.id, metadata: { patientId, verified: false } });
      return this.abhaView(l, true);
    });
  }

  async remove(ctx: RequestContext, patientId: string, linkId: string, input: z.infer<typeof removeAbhaSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const l = await tx.abhaLink.findFirst({ where: { id: linkId, tenantId: ctx.tenantId, patientId } });
      if (!l) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const res = await tx.abhaLink.updateMany({ where: { id: linkId, tenantId: ctx.tenantId, removedAt: null }, data: { removedAt: new Date(), removedById: ctx.userId, removeReason: input.reason } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This ABHA record was already removed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "ABHA_REMOVED", entityType: "AbhaLink", entityId: linkId, metadata: { patientId, reason: input.reason } });
      return { id: linkId, removed: true as const };
    });
  }
}
