/** Problems with the file as a whole (not with one row). The message is safe to show to the user. */
export class CsvError extends Error {}

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * RFC 4180 reader: comma-separated, quoted values may contain commas, line breaks and doubled quotes (""), any of CRLF / LF / CR
 * ends a record, and the byte-order mark Excel adds to "CSV UTF-8" files is ignored. Completely empty lines are skipped.
 */
export function parseCsv(input: string): string[][] {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false; // something (even an empty quoted value) has been read for this record
  const endRow = () => {
    if (started || row.length > 0 || cell !== "") { row.push(cell); if (row.some((c) => c.trim() !== "")) rows.push(row); }
    row = []; cell = ""; started = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === "") { quoted = true; started = true; }
    else if (c === ",") { row.push(cell); cell = ""; started = true; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && s[i + 1] === "\n") i++; endRow(); }
    else cell += c;
  }
  if (quoted) throw new CsvError("A quoted value is never closed: check for a stray double quote (\")");
  endRow();
  return rows;
}

export interface Column { name: string; required?: boolean; description: string; example: string }
export interface TableRow { /** Spreadsheet row number: the header is row 1, so the first record is row 2. */ row: number; cells: Record<string, string | undefined>; tooManyCells: boolean }

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

/** Reads a CSV into rows keyed by column name. Header names match without regard to case, spaces, hyphens or underscores. */
export function readTable(text: string, columns: Column[], maxRows = MAX_IMPORT_ROWS): TableRow[] {
  const records = parseCsv(text);
  if (records.length === 0) throw new CsvError("The file is empty");
  const header = records[0] as string[];
  if (header.length === 1 && /[;\t|]/.test(header[0] as string)) throw new CsvError("Values must be separated by commas (this file seems to use semicolons, tabs or bars). Save it as \"CSV UTF-8 (comma delimited)\".");
  const byNorm = new Map(columns.map((c) => [norm(c.name), c.name]));
  const names: (string | null)[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const h of header) {
    const key = norm(h);
    const col = byNorm.get(key);
    if (!col) { names.push(null); if (key !== "") unknown.push(h.trim()); continue; }
    if (seen.has(col)) throw new CsvError(`The column "${col}" appears twice in the header`);
    seen.add(col); names.push(col);
  }
  if (unknown.length > 0) throw new CsvError(`Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.slice(0, 5).map((u) => `"${u.slice(0, 40)}"`).join(", ")}${unknown.length > 5 ? "…" : ""}. Download the template to see the columns this import accepts.`);
  const missing = columns.filter((c) => c.required && !seen.has(c.name)).map((c) => c.name);
  if (missing.length > 0) throw new CsvError(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  const data = records.slice(1);
  if (data.length === 0) throw new CsvError("The file has a header but no rows");
  if (data.length > maxRows) throw new CsvError(`A file can have at most ${maxRows} rows (this one has ${data.length}). Split it into smaller files.`);
  return data.map((cells, i) => {
    const out: Record<string, string | undefined> = {};
    names.forEach((n, j) => { if (n) { const v = (cells[j] ?? "").trim(); out[n] = v === "" ? undefined : v; } });
    const extra = cells.slice(names.length).some((c) => c.trim() !== "");
    return { row: i + 2, cells: out, tooManyCells: extra };
  });
}
