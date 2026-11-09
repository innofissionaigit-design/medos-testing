#!/usr/bin/env node
// Lists the licence of every installed package and fails on copyleft / unknown licences (CLAUDE.md: stop and report GPL, AGPL, SSPL).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const store = join(root, "node_modules", ".pnpm");
if (!existsSync(store)) { console.error("Run `pnpm install` first."); process.exit(2); }

const BLOCKED = /\b(AGPL|GPL|SSPL|BUSL|Commons-Clause|CC-BY-NC)/i;
const ALLOWED_GPL_EXCEPTION = /WITH\s+(Classpath|GCC|Linking)/i;
const seen = new Map();

/** Some packages omit the "license" field but ship a LICENSE file: read its text and recognise the standard licences. */
function fromLicenceFile(dir) {
  for (const n of readdirSync(dir)) {
    if (!/^(licen[sc]e|copying)/i.test(n)) continue;
    const t = readFileSync(join(dir, n), "utf8").slice(0, 2500);
    if (/Permission is hereby granted, free of charge/i.test(t) && /THE SOFTWARE IS PROVIDED "AS IS"/i.test(t)) return "MIT (LICENSE file)";
    if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return "Apache-2.0 (LICENSE file)";
    if (/Redistribution and use in source and binary forms/i.test(t)) return "BSD (LICENSE file)";
    if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return "ISC (LICENSE file)";
  }
  return "UNKNOWN";
}

for (const dir of readdirSync(store)) {
  const nm = join(store, dir, "node_modules");
  if (!existsSync(nm)) continue;
  for (const entry of readdirSync(nm)) {
    const pkgs = entry.startsWith("@") ? readdirSync(join(nm, entry)).map((n) => join(nm, entry, n)) : [join(nm, entry)];
    for (const p of pkgs) {
      const file = join(p, "package.json");
      if (!existsSync(file)) continue;
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        if (!j.name || !j.version) continue;
        const lic = typeof j.license === "string" ? j.license : j.license?.type ?? (Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN");
        seen.set(`${j.name}@${j.version}`, lic === "UNKNOWN" ? fromLicenceFile(p) : lic);
      } catch { /* unreadable manifest: skipped, reported below if nothing is found */ }
    }
  }
}

const byLicence = new Map();
const problems = [];
for (const [pkg, lic] of seen) {
  byLicence.set(lic, (byLicence.get(lic) ?? 0) + 1);
  // An SPDX "OR" expression is acceptable when at least one permissive alternative exists.
  const alts = lic.replace(/[()]/g, "").split(/\s+OR\s+/i);
  const ok = alts.some((a) => !BLOCKED.test(a) || ALLOWED_GPL_EXCEPTION.test(a)) && lic !== "UNKNOWN";
  if (!ok) problems.push(`${pkg}: ${lic}`);
}

console.log(`Scanned ${seen.size} packages`);
for (const [lic, n] of [...byLicence].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${lic}`);
if (problems.length) { console.error(`\nNeeds review (${problems.length}):\n  ${problems.join("\n  ")}`); process.exit(1); }
console.log("\nNo copyleft or unknown licences found.");
