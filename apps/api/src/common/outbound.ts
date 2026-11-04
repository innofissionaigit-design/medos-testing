import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainError } from "@medos/shared";
import { isPrivateAddress } from "../modules/prescriptions/ocr.provider";

/**
 * The address of an outside service the server will call (a webhook receiver, a message provider). In production it must be an https address of a public host,
 * never a name or number that reaches the hospital's own network or the cloud metadata service. In development http and local addresses are allowed so the
 * feature can be tried against a program on the same computer.
 */
export function assertOutboundUrl(raw: string, production: boolean, what: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new DomainError("VALIDATION_FAILED", `Enter a full web address for the ${what}, for example https://example.com/hook`, 400, [{ path: "url", message: "Not a web address" }]); }
  const bad = (message: string): never => { throw new DomainError("VALIDATION_FAILED", message, 400, [{ path: "url", message }]); };
  if (u.protocol !== "https:" && u.protocol !== "http:") bad("The address must start with https://");
  if (u.username || u.password) bad("Do not put a user name or password in the address");
  if (production) {
    if (u.protocol !== "https:") bad(`In production the ${what} address must use https://`);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (isIP(host) !== 0 && isPrivateAddress(host))) bad(`The ${what} address must be a public internet address`);
  }
  return u;
}

/** Checked again on every call, since DNS can change: a public-looking name must not resolve to an internal address. Throws a message that is safe to show staff. */
export async function assertResolvesPublic(url: URL, production: boolean): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!production || isIP(host) !== 0) return;
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new Error("The address must be a public internet address");
}
