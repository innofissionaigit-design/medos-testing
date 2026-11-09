/**
 * CSV export for reports. Cells that start with = + - @ (or a tab/CR) are prefixed with an apostrophe so a spreadsheet can never
 * run patient- or staff-supplied text as a formula ("CSV injection"). Numbers stay numbers: a leading "-" on a numeric value is kept.
 */
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const isPrim = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);
const humanize = (k: string): string => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Flattens a report payload: scalar fields first, then one section per list of rows (ids are left out). */
export function reportToCsv(title: string, data: Record<string, unknown>): string {
  const lines: string[] = [csvCell(title)];
  const scalars = Object.entries(data).filter(([, v]) => isPrim(v));
  for (const [k, v] of scalars) lines.push([humanize(k), v].map(csvCell).join(","));
  for (const [g, o] of Object.entries(data)) {
    if (o && !Array.isArray(o) && typeof o === "object") for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (isPrim(v)) lines.push([`${humanize(g)} ${humanize(k)}`, v].map(csvCell).join(","));
  }
  for (const [name, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as object).filter((c) => isPrim((rows[0] as Record<string, unknown>)[c]) && !/(^id$|Id$)/.test(c));
    lines.push("", csvCell(humanize(name)), cols.map((c) => csvCell(humanize(c))).join(","));
    for (const r of rows as Record<string, unknown>[]) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
