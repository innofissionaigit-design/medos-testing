import { logJson } from "../../common/logger";
import { assertOutboundUrl, assertResolvesPublic } from "../../common/outbound";

/** What is sent to the AI provider: instructions and the de-identified material. Nothing else about the patient. */
export interface AiRequest { system: string; user: string; maxTokens: number }
export interface AiReply { text: string; model: string | null }

/** A failure whose message is safe to show to staff (no key, no patient material, no provider reply). */
export class AiError extends Error {}

export interface AiProvider {
  readonly kind: "ANTHROPIC" | "HTTP";
  readonly host: string;
  complete(req: AiRequest): Promise<AiReply>;
}

export interface AiProviderOptions { url: string; apiKey?: string | undefined; model?: string | undefined; timeoutMs: number; production: boolean }

export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com/v1/messages";

async function post(o: AiProviderOptions, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let url: URL;
  try {
    url = assertOutboundUrl(o.url, o.production, "AI provider");
    await assertResolvesPublic(url, o.production);
  } catch (e) {
    throw new AiError(e instanceof Error ? e.message : "The AI provider address cannot be used");
  }
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(o.timeoutMs), headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    logJson("warn", "ai_request_failed", { host: url.host, reason: timedOut ? "timeout" : "unreachable" });
    throw new AiError(timedOut ? "The AI provider did not answer in time" : "The AI provider could not be reached");
  }
  if (res.status === 401 || res.status === 403) throw new AiError("The AI provider did not accept the key");
  if (res.status === 429) throw new AiError("The AI provider says there have been too many requests. Try again in a minute");
  if (!res.ok) { logJson("warn", "ai_response_not_ok", { host: url.host, status: res.status }); throw new AiError(`The AI provider returned an error (HTTP ${res.status})`); }
  return res.json().catch(() => { throw new AiError("The AI provider's answer could not be read"); });
}

/** The Anthropic Messages API (or a gateway that speaks it). */
export class AnthropicProvider implements AiProvider {
  readonly kind = "ANTHROPIC" as const;
  readonly host: string;
  constructor(private readonly o: AiProviderOptions) { this.host = new URL(o.url).host; }
  async complete(req: AiRequest): Promise<AiReply> {
    if (!this.o.apiKey || !this.o.model) throw new AiError("The AI provider is not fully set up");
    const json = (await post(this.o, { "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" }, { model: this.o.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content: req.user }] })) as { content?: { type?: string; text?: string }[]; model?: string };
    const text = (json.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    if (!text) throw new AiError("The AI provider gave no text");
    return { text, model: typeof json.model === "string" ? json.model : this.o.model };
  }
}

/**
 * Any other service: one POST with JSON `{ system, user, maxTokens }` (and `Authorization: Bearer <key>` when a key is set) that answers `{ text }`, optionally with `model`.
 * A service that wants another shape needs a small adapter in front of it.
 */
export class HttpAiProvider implements AiProvider {
  readonly kind = "HTTP" as const;
  readonly host: string;
  constructor(private readonly o: AiProviderOptions) { this.host = new URL(o.url).host; }
  async complete(req: AiRequest): Promise<AiReply> {
    const json = (await post(this.o, this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}, { system: req.system, user: req.user, maxTokens: req.maxTokens })) as { text?: unknown; model?: unknown };
    const text = typeof json.text === "string" ? json.text.trim() : "";
    if (!text) throw new AiError("The AI provider gave no text");
    return { text, model: typeof json.model === "string" ? json.model : null };
  }
}
