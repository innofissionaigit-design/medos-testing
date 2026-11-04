import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logJson } from "../../common/logger";

export interface OcrRequest { bytes: Buffer; contentType: string; fileName: string }
export interface OcrResult { text: string; confidence: number | null }

/** A failure that is safe to show to staff (no image, no text from the image, no secrets). */
export class OcrError extends Error {}
/** The service answered but found no text in the picture (so the connection itself works). */
export class OcrEmptyError extends OcrError {}

/** Loopback, private, link-local (including cloud metadata), carrier-grade NAT and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v6 = ip.toLowerCase();
  if (isIP(ip) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  const p = ip.split(".").map(Number);
  const [a = 0, b = 0] = p;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * The address an administrator may connect as the OCR service. The server calls it with the patient's prescription image, so in production it must be
 * an https address of a public host (never a name or number that reaches the hospital's own network or the cloud metadata service).
 */
export function assertOcrUrl(raw: string, production: boolean): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OcrError("Enter a full web address, for example https://ocr.example.com/read"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new OcrError("The address must start with https://");
  if (u.username || u.password) throw new OcrError("Do not put a user name or password in the address; use the API key field");
  if (production) {
    if (u.protocol !== "https:") throw new OcrError("In production the OCR address must use https://");
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (isIP(host) !== 0 && isPrivateAddress(host))) {
      throw new OcrError("The OCR address must be a public internet address");
    }
  }
  return u;
}

/**
 * Reads text from a picture or scan of a handwritten prescription (docs/prescriptions.md explains how to connect a real service).
 * Implementations throw OcrError on any failure and must never log the image or the text that was read.
 */
export interface OcrProvider {
  readonly name: string;
  /** False when no OCR service is connected: uploads are still stored, but nothing is read. */
  readonly configured: boolean;
  extract(request: OcrRequest): Promise<OcrResult>;
}

export const OCR_PROVIDER = Symbol("OCR_PROVIDER");

/** The default: no OCR service connected. */
export class NoOcrProvider implements OcrProvider {
  readonly name = "none";
  readonly configured = false;
  async extract(): Promise<OcrResult> { throw new OcrError("No OCR service is connected on this server"); }
}

export interface HttpOcrOptions { url: string; apiKey?: string | undefined; timeoutMs: number; production?: boolean | undefined }
const MAX_TEXT = 20_000;

/** The text out of the shapes OCR services commonly answer with. Returns null when none is recognised. */
export function readOcrResponse(body: unknown): OcrResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const conf = (v: unknown): number | null => (typeof v === "number" && v >= 0 && v <= 1 ? Math.round(v * 10_000) / 10_000 : null);
  const lines = (v: unknown): string | null => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).filter(Boolean).join("\n") : null);
  if (typeof b["text"] === "string") return { text: b["text"], confidence: conf(b["confidence"]) };
  const fromLines = lines(b["lines"]);
  if (fromLines) return { text: fromLines, confidence: conf(b["confidence"]) };
  if (b["data"] && typeof b["data"] === "object") return readOcrResponse(b["data"]);
  const responses = b["responses"]; // Google Cloud Vision: { responses: [{ fullTextAnnotation: { text } }] }
  if (Array.isArray(responses) && responses[0] && typeof responses[0] === "object") {
    const full = (responses[0] as { fullTextAnnotation?: { text?: unknown } }).fullTextAnnotation;
    if (full && typeof full.text === "string") return { text: full.text, confidence: null };
  }
  return null;
}

/**
 * Sends the image to an OCR service over HTTPS as JSON `{ fileName, contentType, contentBase64 }` with `Authorization: Bearer <key>`, and understands the
 * common answer shapes (see readOcrResponse). Anything else needs a small adapter in front of the service, described in docs/prescriptions.md.
 */
export class HttpOcrProvider implements OcrProvider {
  readonly name = "http";
  readonly configured = true;
  constructor(private readonly o: HttpOcrOptions) {}

  async extract(r: OcrRequest): Promise<OcrResult> {
    let res: Response;
    const production = this.o.production === true;
    const target = assertOcrUrl(this.o.url, production);
    if (production && isIP(target.hostname.replace(/^\[|\]$/g, "")) === 0) {
      // A public-looking name must not resolve to an internal address (checked on every call, since DNS can change).
      const addresses = await lookup(target.hostname, { all: true }).catch(() => []);
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new OcrError("The OCR address must be a public internet address");
    }
    try {
      res = await fetch(target, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({ fileName: r.fileName, contentType: r.contentType, contentBase64: r.bytes.toString("base64") }),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      logJson("warn", "ocr_request_failed", { reason: timedOut ? "timeout" : "unreachable" });
      throw new OcrError(timedOut ? "The OCR service did not answer in time" : "The OCR service could not be reached");
    }
    if (!res.ok) {
      logJson("warn", "ocr_response_not_ok", { status: res.status });
      throw new OcrError(`The OCR service returned an error (HTTP ${res.status})`);
    }
    const parsed = readOcrResponse(await res.json().catch(() => null));
    if (!parsed) throw new OcrError("The OCR service answered in a format this system does not understand");
    const text = parsed.text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT);
    if (!text) throw new OcrEmptyError("The OCR service could not read any text from this image");
    return { text, confidence: parsed.confidence };
  }
}

export function createOcrProvider(c: { NODE_ENV?: string; OCR_PROVIDER: "none" | "http"; OCR_API_URL?: string | undefined; OCR_API_KEY?: string | undefined; OCR_TIMEOUT_MS: number }): OcrProvider {
  if (c.OCR_PROVIDER === "http" && c.OCR_API_URL) return new HttpOcrProvider({ url: c.OCR_API_URL, apiKey: c.OCR_API_KEY, timeoutMs: c.OCR_TIMEOUT_MS, production: c.NODE_ENV === "production" });
  return new NoOcrProvider();
}
