#!/usr/bin/env node
// Lists the user-facing English strings the web UI passes to its translating components, and reports which are not yet translated.
//   node scripts/extract-ui-strings.mjs            (prints missing strings per language, exit 1 if any)
//   node scripts/extract-ui-strings.mjs --all      (prints every string)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src");
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== "locales") walk(p); } else if (/\.tsx$/.test(n)) files.push(p); } })(root);

const set = new Set();
const IGNORE = new Set(["MedOS", "Main", "Environment"]);
const add = (v) => { v = v.trim(); if (v.length >= 2 && !/[{}$`]/.test(v) && /[A-Za-z]/.test(v) && !IGNORE.has(v) && !/\b(?:bg|text|border)-[a-z]/.test(v)) set.add(v); };
const attr = /\b(?:title|label|subtitle|hint|placeholder|empty|confirmLabel)="([^"]{2,140})"/g;
const prop = /\b(?:label|title|empty|hint|placeholder|confirmLabel|error):\s*"([^"]{2,140})"/g;
const text = />\s*([A-Z][^<>{}"`$]{1,110}?)\s*<\/(?:Button|Badge|Notice|button|dt|h1|h2|h3|legend|option|th|a|Link|span|p|li|label|Td)>/g;
const arr = /head=\{\[([^\]]*)\]/g;
const call = /\b(?:t|tr)\("([^"]{2,140})"\)/g;
const tabs = /\{\s*id:\s*"[^"]+",\s*label:\s*"([^"]+)"/g;

for (const f of files) {
  const c = readFileSync(f, "utf8");
  for (const re of [attr, prop, text, call, tabs]) for (const m of c.matchAll(re)) add(m[1]);
  for (const m of c.matchAll(arr)) for (const s of m[1].matchAll(/"([^"]+)"/g)) add(s[1]);
}

// also: NAV labels and status values
const nav = readFileSync(join(root, "lib", "nav.ts"), "utf8");
for (const m of nav.matchAll(/label:\s*"([^"]+)"/g)) add(m[1]);
for (const s of ["waiting", "called", "in consultation", "completed", "cancelled", "paid", "issued", "partially paid", "draft", "signed", "given", "due", "missed", "held", "refused", "pending", "cleared", "available", "occupied", "cleaning", "reserved", "maintenance", "active", "inactive", "admitted", "discharged", "booked", "checked in", "no show", "refunded", "blocked", "normal", "priority", "emergency", "pharmacy", "opd", "ipd", "other", "cash", "upi", "card", "bank transfer", "overdue", "low", "expired", "partial", "current"]) add(s);

const all = [...set].sort((a, b) => a.localeCompare(b));
if (process.argv.includes("--all")) { console.log(all.join("\n")); process.exit(0); }

const { pathToFileURL } = await import("node:url");
async function dict(name) {
  const src = readFileSync(join(root, "lib", "locales", `${name}.ts`), "utf8");
  const keys = new Set([...src.matchAll(/^\s*"((?:[^"\\]|\\.)+)":/gm)].map((m) => JSON.parse(`"${m[1]}"`)));
  return keys;
}
let missing = 0;
for (const [name, label] of [["bn", "Bengali"], ["hi", "Hindi"]]) {
  const have = await dict(name);
  const miss = all.filter((s) => !have.has(s) && !have.has(s.toLowerCase()));
  missing += miss.length;
  console.log(`${label}: ${all.length - miss.length}/${all.length} translated`);
  if (miss.length && process.argv.includes("--list")) console.log(miss.map((s) => `  - ${s}`).join("\n"));
}
void pathToFileURL;
process.exit(missing ? 1 : 0);
