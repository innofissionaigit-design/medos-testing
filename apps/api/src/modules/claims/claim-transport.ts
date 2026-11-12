import { createHash } from "node:crypto";
import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";

export interface ClaimMessage { kind: "ELIGIBILITY" | "CLAIM"; reference: string; payload: unknown }
export interface ClaimDelivery { channel: string; sent: boolean; httpStatus: number | null; externalRef: string | null; detail: string | null }
export const CLAIM_TRANSPORT = Symbol("CLAIM_TRANSPORT");

/** A failure whose message is safe to show to staff (no payload, no key). */
export class ClaimTransportError extends Error {}

export interface ClaimTransport { readonly name: string; send(m: ClaimMessage): Promise<ClaimDelivery> }

export const hashPayload = (payload: unknown): string => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/** No insurer channel is set up: the message is built and recorded, and nothing leaves the hospital. */
export class LogClaimTransport implements ClaimTransport {
  readonly name = "log";
  async send(m: ClaimMessage): Promise<ClaimDelivery> {
    logJson("info", "claim_message_not_sent", { kind: m.kind, reference: m.reference });
    return { channel: "log", sent: false, httpStatus: null, externalRef: null, detail: "No insurer channel is set up, so nothing was sent. Download the message and upload it to the insurer's portal" };
  }
}

export interface HttpClaimOptions { url: string; apiKey: string | undefined; timeoutMs: number; production: boolean }

/**
 * Posts the message (a FHIR Bundle as JSON, `application/fhir+json`) to the configured address, with `Authorization: Bearer <key>` when a key is set. Any 2xx answer means the insurer
 * received it; their reference is taken from `id`, `identifier` or `reference` in the answer when given. The insurer's decision is not read from the answer: it is entered by hand.
 */
export class HttpClaimTransport implements ClaimTransport {
  readonly name = "http";
  constructor(private readonly o: HttpClaimOptions) {}

  async send(m: ClaimMessage): Promise<ClaimDelivery> {
    let url: URL;
    try {
      url = assertOutboundUrl(this.o.url, this.o.production, "insurer channel");
      await assertResolvesPublic(url, this.o.production);
    } catch (e) {
      throw new ClaimTransportError(e instanceof Error ? e.message : "The insurer channel address cannot be used");
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: { "content-type": "application/fhir+json", accept: "application/json", "x-medos-reference": m.reference, "x-medos-kind": m.kind, ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify(m.payload),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      logJson("warn", "claim_request_failed", { reference: m.reference, reason: timedOut ? "timeout" : "unreachable" });
      throw new ClaimTransportError(timedOut ? "The insurer channel did not answer in time" : "The insurer channel could not be reached");
    }
    if (!res.ok) {
      logJson("warn", "claim_response_not_ok", { reference: m.reference, status: res.status });
      return { channel: "http", sent: false, httpStatus: res.status, externalRef: null, detail: `The insurer channel returned an error (HTTP ${res.status})` };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const pick = (o: unknown): string | null => {
      if (!o || typeof o !== "object") return null;
      const r = o as Record<string, unknown>;
      const v = r["id"] ?? r["reference"] ?? (Array.isArray(r["identifier"]) ? (r["identifier"][0] as Record<string, unknown> | undefined)?.["value"] : r["identifier"]);
      return typeof v === "string" && v.length > 0 ? v.slice(0, 120) : null;
    };
    return { channel: "http", sent: true, httpStatus: res.status, externalRef: pick(body) ?? pick(body?.["data"]), detail: null };
  }
}

export function createClaimTransport(c: { NODE_ENV?: string; CLAIM_TRANSPORT: "log" | "http"; CLAIM_API_URL?: string | undefined; CLAIM_API_KEY?: string | undefined; CLAIM_TIMEOUT_MS: number }): ClaimTransport {
  if (c.CLAIM_TRANSPORT === "http" && c.CLAIM_API_URL) return new HttpClaimTransport({ url: c.CLAIM_API_URL, apiKey: c.CLAIM_API_KEY, timeoutMs: c.CLAIM_TIMEOUT_MS, production: c.NODE_ENV === "production" });
  return new LogClaimTransport();
}
