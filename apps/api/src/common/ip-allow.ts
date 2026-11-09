import { BlockList, isIP } from "node:net";

/** An IPv4-mapped IPv6 address (::ffff:1.2.3.4), as Node reports many IPv4 clients, is the plain IPv4 address. */
const plain = (ip: string): string => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

export interface ParsedAllowList { ok: true; entries: string[] }
export interface BadAllowList { ok: false; message: string }

/**
 * Checks a list of addresses a key may be used from: single IPv4 or IPv6 addresses, or CIDR ranges such as 203.0.113.0/24. Returns them tidied (trimmed,
 * duplicates removed) or says which entry is wrong, in plain words.
 */
export function parseAllowList(raw: string[]): ParsedAllowList | BadAllowList {
  const entries: string[] = [];
  for (const r of raw) {
    const e = r.trim();
    if (!e) continue;
    const [addr, prefix, ...rest] = e.split("/");
    const fam = isIP(plain(addr ?? ""));
    if (rest.length > 0 || fam === 0) return { ok: false, message: `"${e}" is not an IP address or range` };
    if (prefix !== undefined) {
      const n = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || n < 0 || n > (fam === 4 ? 32 : 128)) return { ok: false, message: `"${e}" has a bad range size` };
    }
    const tidy = prefix === undefined ? plain(addr ?? "") : `${plain(addr ?? "")}/${prefix}`;
    if (!entries.includes(tidy)) entries.push(tidy);
  }
  return { ok: true, entries };
}

/** Whether a caller's address is on the list. An empty list means "from anywhere". */
export function ipAllowed(ip: string | undefined, list: string[]): boolean {
  if (list.length === 0) return true;
  const addr = plain(ip ?? "");
  const fam = isIP(addr);
  if (fam === 0) return false;
  const bl = new BlockList();
  for (const e of list) {
    const [a, prefix] = e.split("/");
    const f = isIP(a ?? "") === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) bl.addAddress(a ?? "", f); else bl.addSubnet(a ?? "", Number(prefix), f);
  }
  return bl.check(addr, fam === 4 ? "ipv4" : "ipv6");
}
