/** Minimal escaped-HTML helpers. Every dynamic value goes through `esc`; templates never concatenate raw input. */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c));

/** Escaped text with line breaks preserved. */
export const multiline = (v: unknown): string => esc(v).replace(/\r?\n/g, "<br>");

export interface PrintHeader { hospitalName: string; tagline?: string; address?: string; phone?: string; email?: string; gstin?: string; logoDataUrl?: string }

export interface PageInput {
  title: string;
  header: PrintHeader;
  body: string;
  footer?: string;
  /** Shown as a banner (e.g. "DUPLICATE COPY", "CANCELLED"). */
  banner?: string;
  printedBy: string;
  printedAt: string;
}

const CSS = `
*{box-sizing:border-box}body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;padding:24px}
.hdr{display:flex;gap:14px;align-items:center;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
.hdr img{max-height:64px;max-width:120px}.hdr h1{margin:0;font-size:20px}.hdr p{margin:0;color:#444}
h2{font-size:16px;margin:10px 0}h3{font-size:13px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
td.n,th.n{text-align:right}.meta{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin-bottom:8px}
.banner{border:2px solid #b00;color:#b00;font-weight:bold;text-align:center;padding:4px;margin:8px 0}
.foot{margin-top:18px;border-top:1px solid #999;padding-top:6px;color:#444;font-size:11px}
.sig{margin-top:36px;text-align:right}@media print{body{padding:0}}
`;

export function page(p: PageInput): string {
  const h = p.header;
  const contact = [h.address, h.phone && `Ph: ${h.phone}`, h.email, h.gstin && `GSTIN: ${h.gstin}`].filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title)}</title><style>${CSS}</style></head><body>
<div class="hdr">${h.logoDataUrl ? `<img alt="" src="${esc(h.logoDataUrl)}">` : ""}<div><h1>${esc(h.hospitalName)}</h1>${h.tagline ? `<p>${esc(h.tagline)}</p>` : ""}${contact ? `<p>${contact}</p>` : ""}</div></div>
${p.banner ? `<div class="banner">${esc(p.banner)}</div>` : ""}
${p.body}
<div class="foot">${p.footer ? `<div>${multiline(p.footer)}</div>` : ""}<div>Printed by ${esc(p.printedBy)} on ${esc(p.printedAt)}</div></div>
</body></html>`;
}

export const kv = (rows: Array<[string, unknown]>): string =>
  `<div class="meta">${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}</div>`;

export const table = (head: Array<{ label: string; numeric?: boolean }>, rows: unknown[][]): string =>
  `<table><thead><tr>${head.map((h) => `<th${h.numeric ? ' class="n"' : ""}>${esc(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${head[i]?.numeric ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
