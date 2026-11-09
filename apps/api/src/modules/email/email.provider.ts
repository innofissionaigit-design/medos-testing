import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";

/** One email ready to send. `to` is a plain lower-case address; `reference` is our outbox id. */
export interface OutgoingEmail { reference: string; to: string; fromAddress: string; fromName: string; replyTo?: string | undefined; subject: string; text: string; html: string }
export interface EmailDelivery { providerMessageId: string }

/** A failure whose message is safe to keep and show to staff: no address, no subject, no body, no key. */
export class EmailError extends Error {}

/** Ids from the log-only provider carry this prefix, so the screen can say that nothing was actually sent. */
export const EMAIL_LOG_ONLY_PREFIX = "log-only:";

/** a***@example.org: enough to recognise, not enough to misuse. Used in logs and lists. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/**
 * How email leaves the server (docs/email.md). Implementations throw EmailError on failure so the worker can retry, and never log an address, a subject or a body.
 */
export interface EmailProvider {
  readonly name: string;
  /** False for the log-only default: nothing leaves the server. */
  readonly configured: boolean;
  send(email: OutgoingEmail): Promise<EmailDelivery>;
}

export const EMAIL_PROVIDER = Symbol("EMAIL_PROVIDER");

/** The default until a provider is connected: records that an email would have been sent and writes a log line. */
export class LogEmailProvider implements EmailProvider {
  readonly name = "log";
  readonly configured = false;
  async send(e: OutgoingEmail): Promise<EmailDelivery> {
    logJson("info", "email_logged_not_sent", { reference: e.reference, to: maskEmail(e.to) });
    return { providerMessageId: `${EMAIL_LOG_ONLY_PREFIX}${e.reference}` };
  }
}

export interface HttpEmailOptions { url: string; apiKey?: string | undefined; timeoutMs: number; production: boolean }

/**
 * Sends each email with one POST to the hospital's email service: JSON
 * `{ from: { email, name }, to: [{ email }], replyTo, subject, text, html, reference }` and `Authorization: Bearer <key>` when a key is set.
 * Any 2xx answer means accepted; the provider's id is taken from `id`, `messageId` or `data.id` when given. A service that wants another shape
 * (Amazon SES, SendGrid, a mail relay) needs a small adapter in front of it (docs/email.md). The address is checked like every outside address:
 * https in production and never a private network.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = "http";
  readonly configured = true;
  constructor(private readonly o: HttpEmailOptions) {}

  async send(e: OutgoingEmail): Promise<EmailDelivery> {
    let url: URL;
    try {
      url = assertOutboundUrl(this.o.url, this.o.production, "email provider");
      await assertResolvesPublic(url, this.o.production);
    } catch (err) {
      throw new EmailError(err instanceof Error ? err.message : "The email provider address cannot be used");
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({ from: { email: e.fromAddress, name: e.fromName }, to: [{ email: e.to }], ...(e.replyTo ? { replyTo: e.replyTo } : {}), subject: e.subject, text: e.text, html: e.html, reference: e.reference }),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logJson("warn", "email_request_failed", { reference: e.reference, reason: timedOut ? "timeout" : "unreachable" });
      throw new EmailError(timedOut ? "The email provider did not answer in time" : "The email provider could not be reached");
    }
    if (!res.ok) {
      logJson("warn", "email_response_not_ok", { reference: e.reference, status: res.status });
      throw new EmailError(`The email provider returned an error (HTTP ${res.status})`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const pick = (o: unknown): string | null => (o && typeof o === "object" ? ((o as Record<string, unknown>)["id"] ?? (o as Record<string, unknown>)["messageId"]) as string | null ?? null : null);
    const id = pick(body) ?? pick(body?.["data"]);
    return { providerMessageId: typeof id === "string" && id.length > 0 ? id.slice(0, 120) : `accepted:${e.reference}` };
  }
}

export function createEmailProvider(c: { NODE_ENV?: string; EMAIL_PROVIDER: "log" | "http"; EMAIL_API_URL?: string | undefined; EMAIL_API_KEY?: string | undefined; EMAIL_TIMEOUT_MS: number }): EmailProvider {
  if (c.EMAIL_PROVIDER === "http" && c.EMAIL_API_URL) return new HttpEmailProvider({ url: c.EMAIL_API_URL, apiKey: c.EMAIL_API_KEY, timeoutMs: c.EMAIL_TIMEOUT_MS, production: c.NODE_ENV === "production" });
  return new LogEmailProvider();
}
