import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SecretsService } from "../../common/secrets";
import { assertOcrUrl, HttpOcrProvider, OCR_PROVIDER, OcrEmptyError, OcrError, type OcrProvider } from "./ocr.provider";

export const saveOcrConfigSchema = z.object({
  /** The OCR service address. */
  apiUrl: z.string().trim().min(8).max(500),
  /** Leave out to keep the saved key. Never returned by the API. */
  apiKey: z.string().min(8).max(500).optional(),
  clearKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
}).strict().refine((v) => !(v.apiKey && v.clearKey), { message: "Either enter a new key or remove the saved one", path: ["apiKey"] });

/** A 1x1 picture: enough to check that the service is reachable and accepts the key, and it carries no patient information. */
const TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/**
 * The OCR service connection of a facility (docs/prescriptions.md): where it is, its API key (encrypted, write-only), how long to wait, and a test.
 * Without a facility connection the server's OCR_* settings apply. Whether OCR is used is the PRESCRIPTION_OCR_ENABLED setting.
 */
@Injectable()
export class OcrConfigService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly secrets: SecretsService,
    @Inject(OCR_PROVIDER) private readonly server: OcrProvider, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get production(): boolean { return this.config.NODE_ENV === "production"; }
  private row(ctx: RequestContext) { return this.prisma.ocrConfig.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }); }

  /** The provider to use for this facility: its own connection if there is one, otherwise the server's default. */
  async provider(ctx: RequestContext): Promise<OcrProvider> {
    const r = await this.row(ctx);
    if (!r?.apiUrl) return this.server;
    return new HttpOcrProvider({ url: r.apiUrl, apiKey: r.apiKeyEnc ? this.secrets.decrypt(r.apiKeyEnc) : undefined, timeoutMs: r.timeoutMs, production: this.production });
  }

  async view(ctx: RequestContext) {
    const r = await this.row(ctx);
    const own = !!r?.apiUrl;
    return {
      source: own ? "FACILITY" : this.server.configured ? "SERVER" : "NONE",
      apiUrl: r?.apiUrl ?? null, hasKey: !!r?.apiKeyEnc, keyLast4: r?.keyLast4 ?? null, timeoutMs: r?.timeoutMs ?? this.config.OCR_TIMEOUT_MS,
      lastTest: r?.lastTestAt ? { at: r.lastTestAt, ok: r.lastTestOk === true, message: r.lastTestMessage } : null,
      serverDefaultConnected: this.server.configured, canStoreKey: this.secrets.available,
    };
  }

  async save(ctx: RequestContext, input: z.infer<typeof saveOcrConfigSchema>) {
    let url: URL;
    try { url = assertOcrUrl(input.apiUrl, this.production); } catch (e) {
      throw new DomainError("VALIDATION_FAILED", e instanceof Error ? e.message : "Invalid address", 400, [{ path: "apiUrl", message: e instanceof Error ? e.message : "Invalid address" }]);
    }
    if (input.apiKey) this.secrets.assertAvailable();
    const existing = await this.row(ctx);
    // A saved key must never be sent to a different place than the one it was entered for.
    if (existing?.apiKeyEnc && existing.apiUrl && new URL(existing.apiUrl).origin !== url.origin && !input.apiKey && !input.clearKey) {
      throw new DomainError("VALIDATION_FAILED", "You changed the address. Enter the API key again, or remove the saved key.", 400, [{ path: "apiKey", message: "Enter the API key again" }]);
    }
    const keyChanged = !!input.apiKey || (!!input.clearKey && !!existing?.apiKeyEnc);
    await this.prisma.$transaction(async (tx) => {
      const data = {
        apiUrl: url.toString(), timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? this.config.OCR_TIMEOUT_MS, updatedById: ctx.userId,
        ...(input.apiKey ? { apiKeyEnc: this.secrets.encrypt(input.apiKey), keyLast4: input.apiKey.slice(-4) } : input.clearKey ? { apiKeyEnc: null, keyLast4: null } : {}),
        // A changed address or key has not been tested yet.
        ...(existing?.apiUrl !== url.toString() || keyChanged ? { lastTestAt: null, lastTestOk: null, lastTestMessage: null } : {}),
      };
      await tx.ocrConfig.upsert({ where: { tenantId_facilityId: { tenantId: ctx.tenantId, facilityId: ctx.facilityId } }, create: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...data }, update: data });
      await this.audit.record(tx, actorOf(ctx), { action: "OCR_CONFIG_SAVED", entityType: "OcrConfig", entityId: ctx.facilityId, metadata: { host: url.host, keyChanged, keyRemoved: !!input.clearKey, timeoutMs: data.timeoutMs } });
    });
    return this.view(ctx);
  }

  /** Removes the facility's connection (and its saved key). The server default, if any, applies again. */
  async disconnect(ctx: RequestContext) {
    const existing = await this.row(ctx);
    if (!existing?.apiUrl) throw new DomainError("INVALID_STATE", "No OCR service is connected for this facility", 409);
    await this.prisma.$transaction(async (tx) => {
      await tx.ocrConfig.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, data: { apiUrl: null, apiKeyEnc: null, keyLast4: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null, updatedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "OCR_CONFIG_DISCONNECTED", entityType: "OcrConfig", entityId: ctx.facilityId, metadata: { host: new URL(existing.apiUrl as string).host } });
    });
    return this.view(ctx);
  }

  /** Sends a blank test picture to the service. Reachable and accepted counts as working, even if the service finds no text in a blank picture. */
  async test(ctx: RequestContext) {
    const provider = await this.provider(ctx);
    if (!provider.configured) throw new DomainError("INVALID_STATE", "No OCR service is connected yet", 409);
    let ok = true;
    let message = "The OCR service answered.";
    try {
      await provider.extract({ bytes: TEST_PNG, contentType: "image/png", fileName: "connection-test.png" });
    } catch (e) {
      if (e instanceof OcrEmptyError) message = "The OCR service is reachable and accepted the key (it found no text in the blank test picture, as expected).";
      else { ok = false; message = e instanceof OcrError ? e.message : "The OCR service could not be reached"; }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.ocrConfig.updateMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, apiUrl: { not: null } }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message } });
      await this.audit.record(tx, actorOf(ctx), { action: "OCR_CONFIG_TESTED", entityType: "OcrConfig", entityId: ctx.facilityId, metadata: { ok, source: provider === this.server ? "SERVER" : "FACILITY" } });
    });
    return { ok, message, ...(await this.view(ctx)) };
  }
}
