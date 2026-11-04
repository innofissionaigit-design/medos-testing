import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { SecretsService } from "../../common/secrets";
import { tenantScope } from "../../common/tenant-scope";

export const WEBHOOK_EVENTS = ["appointment.booked", "appointment.moved", "appointment.cancelled"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const saveWebhookSchema = z.object({
  url: z.string().trim().min(8).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).refine((a) => new Set(a).size === a.length, "Duplicate event"),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).strict();

/** Minutes to wait after each failed attempt; after the last one the delivery is given up (and can be retried by hand). */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const TIMEOUT_MS = 8_000;

interface AppointmentFacts { id: string; facilityId: string; createdById: string; status: string; startAt: Date; endAt: Date; practitionerId: string; version: number; cancelReason?: string | null }

/**
 * Webhooks for integration keys (docs/integration-api.md): a key that books appointments can be told when one of its appointments is booked, moved or cancelled,
 * whoever did it. The payload carries identifiers, times and the status only, never patient details. Each request is signed with the endpoint's secret, which is
 * shown once and kept only encrypted. A delivery that fails is retried with growing waits and can be retried by hand.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly secrets: SecretsService, @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private get production(): boolean { return this.config.NODE_ENV === "production"; }
  private newSecret(): string { return `whsec_${randomBytes(32).toString("base64url")}`; }

  private async client(db: Db | PrismaService, ctx: RequestContext, clientId: string) {
    const c = await db.apiClient.findFirst({ where: { id: clientId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, name: true, status: true } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return c;
  }

  /** The endpoint (never its secret) and its recent deliveries. */
  async get(ctx: RequestContext, clientId: string) {
    await this.client(this.prisma, ctx, clientId);
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { tenantId: ctx.tenantId, clientId }, select: { id: true, url: true, events: true, status: true, secretLast4: true, createdAt: true, updatedAt: true } });
    if (!ep) return { webhook: null, deliveries: [], canStoreSecret: this.secrets.available };
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { tenantId: ctx.tenantId, endpointId: ep.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20,
      select: { id: true, event: true, appointmentId: true, status: true, attempts: true, nextAttemptAt: true, lastStatus: true, lastError: true, deliveredAt: true, createdAt: true },
    });
    return { webhook: ep, deliveries, canStoreSecret: this.secrets.available };
  }

  /** Creates or changes the endpoint. A new endpoint returns its signing secret, once. */
  async save(ctx: RequestContext, clientId: string, input: z.infer<typeof saveWebhookSchema>) {
    const c = await this.client(this.prisma, ctx, clientId);
    if (c.status !== "ACTIVE") throw new DomainError("INVALID_STATE", "This integration is revoked", 409);
    const url = assertOutboundUrl(input.url, this.production, "webhook").toString();
    const existing = await this.prisma.webhookEndpoint.findFirst({ where: { tenantId: ctx.tenantId, clientId }, select: { id: true } });
    let secret: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.webhookEndpoint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.id } }, data: { url, events: input.events, ...(input.status ? { status: input.status } : {}) } });
      } else {
        this.secrets.assertAvailable();
        secret = this.newSecret();
        await tx.webhookEndpoint.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, clientId, url, secretEnc: this.secrets.encrypt(secret), secretLast4: secret.slice(-4), events: input.events, status: input.status ?? "ACTIVE", createdById: ctx.userId } });
      }
      await this.audit.record(tx, actorOf(ctx), { action: existing ? "WEBHOOK_UPDATED" : "WEBHOOK_CREATED", entityType: "ApiClient", entityId: clientId, metadata: { host: new URL(url).host, events: input.events, ...(input.status ? { status: input.status } : {}) } });
    });
    return { ...(await this.get(ctx, clientId)), secret };
  }

  async rotateSecret(ctx: RequestContext, clientId: string) {
    await this.client(this.prisma, ctx, clientId);
    this.secrets.assertAvailable();
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { tenantId: ctx.tenantId, clientId }, select: { id: true } });
    if (!ep) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const secret = this.newSecret();
    await this.prisma.$transaction(async (tx) => {
      await tx.webhookEndpoint.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: ep.id } }, data: { secretEnc: this.secrets.encrypt(secret), secretLast4: secret.slice(-4) } });
      await this.audit.record(tx, actorOf(ctx), { action: "WEBHOOK_SECRET_ROTATED", entityType: "ApiClient", entityId: clientId });
    });
    return { secret };
  }

  /** Sends a test event now and reports what the receiver answered. */
  async test(ctx: RequestContext, clientId: string) {
    await this.client(this.prisma, ctx, clientId);
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { tenantId: ctx.tenantId, clientId }, select: { id: true, url: true, secretEnc: true } });
    if (!ep) throw new DomainError("INVALID_STATE", "No webhook is set up for this integration yet", 409);
    const payload = { id: randomUUID(), event: "ping", occurredAt: new Date().toISOString() };
    const r = await this.send(ep.url, this.secrets.decrypt(ep.secretEnc), payload, "ping");
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "WEBHOOK_TESTED", entityType: "ApiClient", entityId: clientId, metadata: { ok: r.ok, status: r.status ?? null } }));
    return { ok: r.ok, statusCode: r.status ?? null, message: r.ok ? "The receiver accepted the test event." : r.error ?? "The receiver did not accept the test event." };
  }

  /** A given-up delivery goes back in the queue to be tried again now. */
  async retry(ctx: RequestContext, clientId: string, deliveryId: string) {
    await this.client(this.prisma, ctx, clientId);
    const res = await this.prisma.webhookDelivery.updateMany({ where: { id: deliveryId, tenantId: ctx.tenantId, status: "FAILED", endpoint: { clientId } }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    if (res.count !== 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "WEBHOOK_DELIVERY_RETRIED", entityType: "ApiClient", entityId: clientId, metadata: { deliveryId } }));
    return { id: deliveryId, status: "PENDING" };
  }

  // ───── events ─────

  /**
   * Called inside the transaction that changed the appointment. If the appointment was made by an integration key that has an active endpoint listening for this
   * event, one delivery is queued in the same transaction, so a change is never lost and never announced for something that rolled back.
   */
  async enqueue(tx: Db, tenantId: string, a: AppointmentFacts, event: WebhookEvent): Promise<void> {
    const client = await tx.apiClient.findFirst({
      where: { tenantId, userId: a.createdById, status: "ACTIVE", webhook: { is: { status: "ACTIVE", events: { has: event } } } },
      select: { webhook: { select: { id: true } } },
    });
    if (!client?.webhook) return;
    const id = randomUUID();
    const payload = {
      id, event, occurredAt: new Date().toISOString(),
      appointment: { id: a.id, status: a.status, startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), practitionerId: a.practitionerId, version: a.version, ...(a.cancelReason ? { cancelReason: a.cancelReason } : {}) },
    };
    await tx.webhookDelivery.create({ data: { id, tenantId, endpointId: client.webhook.id, event, appointmentId: a.id, payload } });
  }

  // ───── delivery ─────

  /** One signed POST. Never follows redirects, never waits more than a few seconds, never reveals more than the receiver's status. */
  private async send(rawUrl: string, secret: string, payload: Record<string, unknown>, event: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    let url: URL;
    try {
      url = assertOutboundUrl(rawUrl, this.production, "webhook");
      await assertResolvesPublic(url, this.production);
    } catch (e) {
      return { ok: false, error: e instanceof DomainError ? e.message : e instanceof Error ? e.message : "The address cannot be used" };
    }
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    try {
      const res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", "user-agent": "MedOS-Webhooks/1", "x-medos-event": event, "x-medos-delivery": String(payload["id"] ?? ""), "x-medos-signature": `t=${t},v1=${signature}` },
        body,
      });
      return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `The receiver answered HTTP ${res.status}` };
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, error: timedOut ? "The receiver did not answer in time" : "The receiver could not be reached" };
    }
  }

  /** Delivers what is due, hospital by hospital under each hospital's own scope. Safe on several servers: rows are claimed with SKIP LOCKED. */
  async runDue(now = new Date(), limit = 100): Promise<{ delivered: number; retried: number; failed: number }> {
    const counts = { delivered: 0, retried: 0, failed: 0 };
    const tenants = await tenantScope.system("webhook worker: hospitals with deliveries due", () =>
      this.prisma.$queryRaw<{ tenant_id: string }[]>`SELECT medos_tenants_with_due_webhooks(${now}::timestamptz)::text AS tenant_id`);
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

  private async deliverOne(tx: Db, now: Date): Promise<"delivered" | "retried" | "failed" | null> {
    const [d] = await tx.$queryRaw<{ id: string; tenantId: string; endpointId: string; event: string; payload: Record<string, unknown>; attempts: number }[]>`
      SELECT id, "tenantId", "endpointId", event, payload, attempts FROM "WebhookDelivery"
      WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now} ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!d) return null;
    const where = { id: d.id, tenantId: d.tenantId };
    const ep = await tx.webhookEndpoint.findFirst({ where: { id: d.endpointId, tenantId: d.tenantId }, select: { url: true, secretEnc: true, status: true } });
    if (!ep || ep.status !== "ACTIVE") {
      await tx.webhookDelivery.updateMany({ where, data: { status: "FAILED", lastError: "The webhook is switched off" } });
      return "failed";
    }
    let secret: string;
    try { secret = this.secrets.decrypt(ep.secretEnc); } catch {
      await tx.webhookDelivery.updateMany({ where, data: { status: "FAILED", lastError: "The signing secret cannot be read. Rotate it." } });
      return "failed";
    }
    const r = await this.send(ep.url, secret, d.payload, d.event);
    const attempts = d.attempts + 1;
    if (r.ok) {
      await tx.webhookDelivery.updateMany({ where, data: { status: "DELIVERED", attempts, lastStatus: r.status ?? null, lastError: null, deliveredAt: new Date() } });
      return "delivered";
    }
    logJson("warn", "webhook_delivery_failed", { deliveryId: d.id, attempt: attempts, status: r.status ?? null });
    if (attempts >= MAX_ATTEMPTS) {
      await tx.webhookDelivery.updateMany({ where, data: { status: "FAILED", attempts, lastStatus: r.status ?? null, lastError: r.error ?? "Failed" } });
      return "failed";
    }
    await tx.webhookDelivery.updateMany({ where, data: { attempts, lastStatus: r.status ?? null, lastError: r.error ?? "Failed", nextAttemptAt: new Date(now.getTime() + (BACKOFF_MINUTES[attempts - 1] ?? 720) * 60_000) } });
    return "retried";
  }
}
