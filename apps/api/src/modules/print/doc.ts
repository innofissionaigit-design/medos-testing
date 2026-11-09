import { esc, kv as htmlKv, multiline, page, table as htmlTable, type PrintHeader } from "./html";

/** A printable document as data. The same model renders to HTML (browser print) and to PDF, so the two can never disagree. */
export type Block =
  | { t: "title"; text: string }
  | { t: "heading"; text: string }
  | { t: "kv"; rows: [string, string | null | undefined][] }
  | { t: "table"; head: { label: string; numeric?: boolean }[]; rows: string[][] }
  | { t: "para"; text: string }
  | { t: "note"; text: string }
  | { t: "signature"; lines: string[] };

export interface Doc {
  /** Browser/PDF title. */
  title: string;
  /** Suggested file name without extension. */
  fileBase: string;
  header: PrintHeader;
  banner?: string | undefined;
  blocks: Block[];
  footer?: string | undefined;
  printedBy: string;
  printedAt: string;
}

export function toHtml(d: Doc): string {
  const body = d.blocks.map((b) => {
    switch (b.t) {
      case "title": return `<h2>${esc(b.text)}</h2>`;
      case "heading": return `<h3>${esc(b.text)}</h3>`;
      case "kv": return htmlKv(b.rows.map(([k, v]) => [k, v ?? ""] as [string, unknown]));
      case "table": return htmlTable(b.head, b.rows);
      case "para": return `<p>${multiline(b.text)}</p>`;
      case "note": return `<p><b>${esc(b.text)}</b></p>`;
      case "signature": return `<div class="sig">${b.lines.map(esc).join("<br>")}</div>`;
    }
  }).join("\n");
  return page({ title: d.title, header: d.header, body, footer: d.footer, banner: d.banner, printedBy: d.printedBy, printedAt: d.printedAt });
}
