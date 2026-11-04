import { isIP } from "node:net";
import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";
import { LOG_ONLY_PREFIX, maskMobile } from "../follow-ups/reminder.provider";

export type MessageChannel = "WHATSAPP" | "SMS";
/** One message to a patient. `to` is the patient's normalised 10-digit Indian mobile; `text` is the complete message; `reference` is our delivery id. */
export interface OutgoingMessage { channel: MessageChannel; to: string; text: string; reference: string }
export interface MessageDelivery { providerMessageId: string }

/** A failure whose message is safe to show to staff (no text of the message, no number, no key). */
export class MessageError extends Error {}

/**
 * How messages reach patients (docs/prescriptions.md). The provider is the hospital's approved WhatsApp or SMS service: nothing is sent until one is connected.
 * Implementations throw MessageError on failure so the worker can retry, and never log the message text or a full number.
 */
export interface MessageProvider {
  readonly name: string;
  /** False for the log-only default: nothing leaves the server. */
  readonly configured: boolean;
  send(message: OutgoingMessage): Promise<MessageDelivery>;
}

export const MESSAGE_PROVIDER = Symbol("MESSAGE_PROVIDER");

/** The default until a provider is connected: records that a message would have been sent and writes a log line. Ids carry LOG_ONLY_PREFIX so screens can say so. */
export class LogMessageProvider implements MessageProvider {
  readonly name = "log";
  readonly configured = false;
  async send(m: OutgoingMessage): Promise<MessageDelivery> {
    logJson("info", "message_logged_not_sent", { reference: m.reference, channel: m.channel, to: maskMobile(m.to) });
    return { providerMessageId: `${LOG_ONLY_PREFIX}${m.reference}` };
  }
}

export interface HttpMessageOptions { url: string; apiKey?: string | undefined; timeoutMs: number; production: boolean }

/**
 * Sends each message with one POST to the provider's address: JSON `{ channel, to, text, reference }` where `to` is the number with country code (91XXXXXXXXXX),
 * and `Authorization: Bearer <key>` when a key is set. Any 2xx answer means accepted; the provider's message id is taken from `id`, `messageId` or `data.id` when given.
 * A provider that wants another shape needs a small adapter in front of it (docs/prescriptions.md).
 */
export class HttpMessageProvider implements MessageProvider {
  readonly name = "http";
  readonly configured = true;
  constructor(private readonly o: HttpMessageOptions) {}

  async send(m: OutgoingMessage): Promise<MessageDelivery> {
    let url: URL;
    try {
      url = assertOutboundUrl(this.o.url, this.o.production, "message provider");
      await assertResolvesPublic(url, this.o.production);
    } catch (e) {
      throw new MessageError(e instanceof Error ? e.message : "The message provider address cannot be used");
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({ channel: m.channel, to: `91${m.to}`, text: m.text, reference: m.reference }),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      logJson("warn", "message_request_failed", { reference: m.reference, reason: timedOut ? "timeout" : "unreachable" });
      throw new MessageError(timedOut ? "The message provider did not answer in time" : "The message provider could not be reached");
    }
    if (!res.ok) {
      logJson("warn", "message_response_not_ok", { reference: m.reference, status: res.status });
      throw new MessageError(`The message provider returned an error (HTTP ${res.status})`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const pick = (o: unknown): string | null => (o && typeof o === "object" ? ((o as Record<string, unknown>)["id"] ?? (o as Record<string, unknown>)["messageId"]) as string | null ?? null : null);
    const id = pick(body) ?? pick(body?.["data"]);
    return { providerMessageId: typeof id === "string" && id.length > 0 ? id.slice(0, 120) : `accepted:${m.reference}` };
  }
}

/** The 10-digit Indian mobile number of a patient, or null when what is saved is not one. */
export function indianMobile(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) && isIP(ten) === 0 ? ten : null;
}

export function createMessageProvider(c: { NODE_ENV?: string; MESSAGE_PROVIDER: "log" | "http"; MESSAGE_API_URL?: string | undefined; MESSAGE_API_KEY?: string | undefined; MESSAGE_TIMEOUT_MS: number }): MessageProvider {
  if (c.MESSAGE_PROVIDER === "http" && c.MESSAGE_API_URL) return new HttpMessageProvider({ url: c.MESSAGE_API_URL, apiKey: c.MESSAGE_API_KEY, timeoutMs: c.MESSAGE_TIMEOUT_MS, production: c.NODE_ENV === "production" });
  return new LogMessageProvider();
}
