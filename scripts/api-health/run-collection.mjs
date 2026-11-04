// Runs docs/postman/medos.postman_collection.json without Postman (a small stand-in for the pm object). For the real thing, import the collection into Postman. Run: node scripts/api-health/run-collection.mjs Read-only.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(process.env.API_HEALTH_OUT ?? tmpdir(), "postman-run.json");
const env = Object.fromEntries(readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const collection = JSON.parse(readFileSync(`${ROOT}/docs/postman/medos.postman_collection.json`, "utf8"));

/** A small stand-in for Postman's `pm` object, enough for the scripts in this collection. */
function makePm(vars, res, tests) {
  const expect = (v) => {
    const o = {
      to: {
        include: (x) => { if (!(Array.isArray(v) ? v.includes(x) : String(v).includes(x))) throw new Error(`expected ${JSON.stringify(v)} to include ${JSON.stringify(x)}`); return o; },
        eql: (x) => { if (JSON.stringify(v) !== JSON.stringify(x)) throw new Error("not equal"); return o; },
        be: { a: (t) => { if (typeof v !== t) throw new Error(`expected a ${t}`); return o; } },
        have: {},
      },
    };
    o.to.be.a.and = o; o.and = { not: { empty: undefined } };
    Object.defineProperty(o.and.not, "empty", { get() { if (v === "" || v == null) throw new Error("is empty"); return o; } });
    o.to.be.a = Object.assign((t) => { if (typeof v !== t) throw new Error(`expected a ${t}`); return o; }, { and: o.and });
    return o;
  };
  return {
    test: (name, fn) => { try { fn(); tests.push({ name, ok: true }); } catch (e) { tests.push({ name, ok: false, why: String(e.message).slice(0, 80) }); } },
    expect,
    response: {
      get code() { return res.status; },
      json: () => res.json ?? {},
      to: { have: { status: (n) => { if (res.status !== n) throw new Error(`status ${res.status}, expected ${n}`); } } },
    },
    collectionVariables: { get: (k) => vars[k], set: (k, v) => { vars[k] = v; } },
  };
}
const fill = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

async function run(items, vars, pathPrefix, out) {
  for (const it of items) {
    if (it.item) { await run(it.item, vars, `${pathPrefix}${it.name} / `, out); continue; }
    const r = it.request;
    if (it.name.startsWith("2b.") && !vars.facilityId) { out.push({ folder: pathPrefix.replace(/ \/ $/, ""), name: it.name, method: r.method, path: "/auth/login", status: null, tests: 0, failed: 0, skipped: true, why: "not needed: this hospital login did not ask to choose a facility" }); continue; }
    if (vars.accessToken && vars.rolesFor !== vars.accessToken) { try { const m = await (await fetch(`${base.baseUrl}/auth/me`, { headers: { authorization: `Bearer ${vars.accessToken}` } })).json(); vars.currentRoles = (m.data?.roles ?? []).join(","); vars.rolesFor = vars.accessToken; } catch { /* the test reports it */ } }
    const rawUrl = typeof r.url === "string" ? r.url : r.url.raw;
    const url = fill(rawUrl, vars);
    const headers = {};
    for (const h of r.header ?? []) headers[h.key] = fill(h.value, vars);
    const noauth = r.auth?.type === "noauth";
    if (!noauth && collection.auth?.type === "bearer") headers.authorization = `Bearer ${vars.accessToken}`;
    const body = r.body?.mode === "raw" ? fill(r.body.raw, vars) : undefined;
    let res;
    try {
      const f = await fetch(url, { method: r.method, headers, body, signal: AbortSignal.timeout(30_000) });
      const text = await f.text();
      let json = null; try { json = JSON.parse(text); } catch { /* none */ }
      res = { status: f.status, json };
    } catch (e) { res = { status: 0, json: null }; }
    const tests = [];
    const pm = makePm(vars, res, tests);
    for (const ev of it.event ?? []) if (ev.listen === "test") { try { new Function("pm", "console", ev.script.exec.join("\n"))(pm, { log() {} }); } catch (e) { tests.push({ name: "script", ok: false, why: String(e.message).slice(0, 80) }); } }
    out.push({ folder: pathPrefix.replace(/ \/ $/, ""), name: it.name, method: r.method, path: url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, ""), status: res.status, tests: tests.length, failed: tests.filter((t) => !t.ok).length, why: tests.filter((t) => !t.ok).map((t) => t.why).join("; ") });
    if (it.name === "8. Logout (revokes the refresh token)") await new Promise((x) => setTimeout(x, 50));
  }
}

const results = [];
const base = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]));
base.password = env.SEED_PASSWORD;
// Everyday folders as Reception.
{
  const vars = { ...base, identifier: "reception1" };
  const items = collection.item.filter((f) => f.name !== "Admin only");
  // Logout last, after the other folders.
  const auth = items.find((f) => f.name === "Authentication");
  const logout = auth.item.filter((i) => i.name.startsWith("8."));
  auth.item = auth.item.filter((i) => !i.name.startsWith("8."));
  await run(items, vars, "", results);
  await run(logout, vars, "Authentication / ", results);
}
// The role-aware folder as each role: Administrator (all 200), Cashier (reports 200, OCR 403), Reception (all 403).
for (const who of ["admin", "cashier1", "reception1"]) {
  const vars = { ...base, identifier: who };
  const login = collection.item.find((f) => f.name === "Authentication").item.find((i) => i.name.startsWith("2. Login"));
  const guarded = collection.item.find((f) => f.name === "Admin only");
  const tmp = [];
  await run([login], vars, `${who} sign-in / `, tmp);
  results.push(...tmp);
  const before = results.length;
  await run([guarded], vars, "", results);
  for (const r of results.slice(before)) r.name += ` (as ${who})`;
}
writeFileSync(OUT, JSON.stringify(results, null, 1));
let pass = 0, fail = 0;
let skipped = 0;
for (const r of results) { if (r.skipped) { skipped++; console.log(`SKIP  -   ${r.method.padEnd(4)} ${r.folder} / ${r.name}`); continue; } const ok = (r.status >= 200 && r.status < 300 || (r.status === 403 && r.folder === "Admin only")) && r.failed === 0; ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${String(r.status).padEnd(3)} ${r.method.padEnd(4)} ${r.folder} / ${r.name}${r.why ? "  [" + r.why + "]" : ""}`); }
console.log(`\ncollection run: ${pass} passed, ${fail} failed, ${skipped} skipped of ${results.length} requests`);

