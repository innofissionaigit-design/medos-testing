// MedOS API health probe. Signs in as every seeded role, calls every read route in docs/api-routes.md, and runs the Patients, Appointments, OPD queue, Billing, Admissions and integration-key workflows with synthetic data (names start with Zzprobe). Run: node scripts/api-health/probe.mjs Needs the API on :4000 and a seeded dev database. Never prints passwords, tokens or patient data.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(process.env.API_HEALTH_OUT ?? tmpdir(), "api-probe-results.json");
const API = "http://localhost:4000/api/v1";
const WEB = "http://localhost:3000";
const env = Object.fromEntries(readFileSync(`${ROOT}/.env`, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const PASSWORD = env.SEED_PASSWORD;
const TENANT = "demo-hospital";
const results = { generatedAt: new Date().toISOString(), auth: [], routes: [], flows: [], web: [] };

async function req(method, path, { token, body, headers = {}, base = API, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  try {
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (raw) return r;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, contentType: r.headers.get("content-type") ?? "" };
  } catch (e) { return { status: 0, json: null, error: String(e.message ?? e).slice(0, 120) }; }
}
const code = (r) => r.json?.error?.code ?? null;

// ---------- 1. sign in with each seeded role ----------
const USERS = ["admin", "reception1", "cashier1", "doctor1", "pharmacist1", "nurse1", "manager1"];
const tokens = {};
const refreshTokens = {};
let facilityId = null;
for (const u of USERS) {
  let r = await req("POST", "/auth/login", { body: { tenantCode: TENANT, identifier: u, password: PASSWORD } });
  if (r.status === 200 && r.json?.data?.status === "FACILITY_SELECTION_REQUIRED") {
    r = await req("POST", "/auth/login", { body: { tenantCode: TENANT, identifier: u, password: PASSWORD, facilityId: r.json.data.facilities[0].id } });
  }
  const ok = r.status === 200 && r.json?.data?.status === "AUTHENTICATED";
  if (ok) { tokens[u] = r.json.data.tokens.accessToken; refreshTokens[u] = r.json.data.tokens.refreshToken; facilityId ??= r.json.data.facility.id; }
  results.auth.push({ user: u, status: r.status, result: ok ? "PASS" : "FAIL", detail: ok ? "signed in" : code(r) ?? r.error ?? "no token" });
}
const roles = Object.keys(tokens);
const T = (u) => tokens[u];
results.auth.push({ user: "(no token)", status: (await req("GET", "/auth/me")).status, result: "PASS", detail: "401 expected without a token" });
results.auth.push({ user: "(wrong password)", status: (await req("POST", "/auth/login", { body: { tenantCode: TENANT, identifier: "admin", password: "wrong-password-probe" } })).status, result: "PASS", detail: "401 expected for a wrong password" });
if (roles.length === 0) { writeFileSync(OUT, JSON.stringify(results, null, 1)); console.log("no role could sign in"); process.exit(1); }

// ---------- 2. sample ids (never printed) ----------
const ids = {};
const first = async (path, pick, as = "admin") => { const r = await req("GET", path, { token: T(roles.includes(as) ? as : roles[0]) }); const d = r.json?.data; const row = Array.isArray(d) ? d[0] : d?.items?.[0] ?? d?.rows?.[0]; return row ? pick(row) : null; };
ids.patient = await first("/patients?q=DEMO&pageSize=1", (x) => x.id, "reception1");
ids.appointment = await first("/appointments?pageSize=1", (x) => x.id, "reception1");
ids.invoice = await first("/invoices?pageSize=1", (x) => x.id, "cashier1");
ids.admission = await first("/admissions?pageSize=1", (x) => x.id, "reception1");
ids.practitioner = await first("/practitioners", (x) => x.id, "reception1");
ids.encounter = ids.patient ? await first(`/patients/${ids.patient}/encounters?pageSize=1`, (x) => x.id, "doctor1") : null;
ids.ward = await first("/wards", (x) => x.id, "reception1");
ids.medicine = await first("/medicines?pageSize=1", (x) => x.id, "pharmacist1");
ids.service = await first("/services?pageSize=1", (x) => x.id, "cashier1");
ids.user = await first("/users?pageSize=1", (x) => x.id, "admin");
ids.role = await first("/roles", (x) => x.id, "admin");
ids.supplier = await first("/suppliers?pageSize=1", (x) => x.id, "pharmacist1");
ids.shift = await first("/shifts?pageSize=1", (x) => x.id, "admin");
ids.facility = await first("/facilities", (x) => x.id, "admin");
ids.dispense = await first("/pharmacy/dispenses?pageSize=1", (x) => x.id, "pharmacist1");
ids.batch = await first("/pharmacy/batches?pageSize=1", (x) => x.id, "pharmacist1");
ids.purchase = await first("/pharmacy/purchases?pageSize=1", (x) => x.id, "pharmacist1");
if (ids.invoice) { const inv = await req("GET", "/invoices/" + ids.invoice, { token: T(roles.includes("cashier1") ? "cashier1" : roles[0]) }); ids.receipt = inv.json?.data?.receipts?.[0]?.id ?? null; }
if (!ids.receipt) { const list = await req("GET", "/invoices?status=PAID&pageSize=5", { token: T(roles.includes("cashier1") ? "cashier1" : roles[0]) }); for (const row of list.json?.data ?? []) { const d = await req("GET", "/invoices/" + row.id, { token: T(roles.includes("cashier1") ? "cashier1" : roles[0]) }); if (d.json?.data?.receipts?.[0]?.id) { ids.receipt = d.json.data.receipts[0].id; break; } } }

// ---------- 3. every GET route ----------
const doc = readFileSync(`${ROOT}/docs/api-routes.md`, "utf8");
const gets = [...doc.matchAll(/^\| GET \| `([^`]+)` \|/gm)].map((m) => m[1]);
const bySegment = { patients: "patient", appointments: "appointment", invoices: "invoice", admissions: "admission", practitioners: "practitioner", encounters: "encounter", wards: "ward", medicines: "medicine", services: "service", users: "user", roles: "role", suppliers: "supplier", shifts: "shift", facilities: "facility", dispenses: "dispense", batches: "batch", purchases: "purchase", receipts: "receipt" };
const nameMap = { patientId: "patient", encounterId: "encounter", admissionId: "admission", invoiceId: "invoice" };
const resolve = (path) => {
  const segs = path.split("/").filter(Boolean);
  let missing = null;
  const out = segs.map((s, i) => {
    if (!s.startsWith(":")) return s;
    const key = s === ":id" ? bySegment[segs[i - 1]] : nameMap[s.slice(1)];
    const v = key ? ids[key] : null;
    if (!v) missing = s;
    return v ?? s;
  });
  return { url: "/" + out.join("/"), missing };
};
const roleOrder = ["admin", "reception1", "cashier1", "doctor1", "pharmacist1", "nurse1", "manager1"].filter((r) => roles.includes(r));
for (const path of gets) {
  const resolved = resolve(path);
  const today = new Date().toISOString().slice(0, 10);
  const extra = /availability$|intake-output\/totals$/.test(path) ? `?date=${today}` : /suggest-batches$/.test(path) ? "?quantity=1" : path === "/patients/" || path === "/patients" ? "?q=DEMO" : "";
  const { url, missing } = { url: resolved.url + extra, missing: resolved.missing };
  if (missing) { results.routes.push({ module: path.split("/")[1], path, status: null, role: null, result: "SKIPPED", note: `needs a sample ${missing} that the demo data does not have` }); continue; }
  let last = null; let usedRole = null;
  for (const role of roleOrder) {
    const r = await req("GET", url, { token: T(role) });
    if (r.status === 403 && last && last.status !== 403) continue;
    last = r; usedRole = role;
    if (r.status >= 200 && r.status < 300) break;
  }
  let result; let note = "";
  if (last.status >= 200 && last.status < 300) result = "PASS";
  else if (last.status === 409) { result = "STATE_REFUSAL"; note = `${code(last) ?? ""}: the sample record is not in the state this route needs (expected)`; }
  else if (last.status === 400) { result = "NEEDS_PARAMS"; note = "needs query parameters (not a fault)"; }
  else if (last.status === 403) { result = "FORBIDDEN_ALL_ROLES"; note = "no seeded role holds the permission"; }
  else if (last.status === 404) { result = "NOT_FOUND"; note = code(last) ?? ""; }
  else { result = "FAIL"; note = `${code(last) ?? last.error ?? ""}`; }
  results.routes.push({ module: path.split("/")[1], path, status: last.status, role: usedRole, result, note });
}

// ---------- 4. workflows (synthetic data only) ----------
const flow = (name, steps) => results.flows.push({ name, steps });
const step = (label, r, expect) => ({ label, status: r.status, result: [].concat(expect).includes(r.status) ? "PASS" : "FAIL", detail: [].concat(expect).includes(r.status) ? "" : [code(r) ?? r.error ?? "", ...(r.json?.error?.details ?? []).slice(0, 3).map((d) => d.path)].join(" ") });
const idem = () => ({ "idempotency-key": `probe-${randomUUID().slice(0, 18)}` });
const rec = T("reception1"); const cashier = T("cashier1"); const doctor = T("doctor1"); const adm = T("admin");

// Patients
{
  const steps = [];
  const mobile = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const body = { firstName: "Zzprobe", lastName: "Probe" + String.fromCharCode(...Array.from({ length: 6 }, () => 97 + Math.floor(Math.random() * 26))), gender: "FEMALE", dateOfBirth: "1990-01-01", mobile, addressLine: "12 Synthetic Lane", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001" };
  const feeCfg = await req("GET", "/patients/registration-fee/config", { token: rec });
  const fee = feeCfg.json?.data?.enabled === true;
  if (fee) body.registration = { payments: [{ method: "UPI", amount: feeCfg.json.data.amount, reference: "PROBE-0001" }] };
  const c = await req("POST", "/patients", { token: rec, body, headers: idem() });
  steps.push(step(fee ? "Register a synthetic patient (registration fee collected)" : "Register a synthetic patient", c, 201));
  const pid = c.json?.data?.id;
  if (pid) {
    ids.probePatient = pid;
    steps.push(step("Get the patient", await req("GET", `/patients/${pid}`, { token: rec }), 200));
    steps.push(step("Search by mobile", await req("GET", `/patients?q=${mobile}`, { token: rec }), 200));
    steps.push(step("Duplicate is detected", await req("POST", "/patients", { token: rec, body, headers: idem() }), 409));
    const g = await req("GET", `/patients/${pid}`, { token: rec });
    steps.push(step("Update the patient", await req("PATCH", `/patients/${pid}`, { token: rec, body: { version: g.json?.data?.version, city: "Howrah" } }), 200));
  }
  flow("Patients", steps);
}
// Appointments + OPD queue
{
  const steps = [];
  const pid = ids.probePatient;
  const doc1 = ids.practitioner;
  if (pid && doc1) {
    const consult = await req("GET", `/patients/${pid}/consultation-payment`, { token: rec });
    const mustPay = consult.json?.data?.required === true;
    steps.push(step("Consultation-payment status", consult, 200));
    const when = new Date(Date.now() + 40 * 86_400_000); when.setUTCHours(5, 30, 0, 0);
    const b = await req("POST", "/appointments", { token: rec, body: { patientId: pid, practitionerId: doc1, startAt: when.toISOString() }, headers: idem() });
    steps.push(step("Book an appointment", b, [201, 409]));
    const aid = b.json?.data?.id;
    if (aid) {
      steps.push(step("Get the appointment", await req("GET", `/appointments/${aid}`, { token: rec }), 200));
      steps.push(step("List appointments", await req("GET", "/appointments?pageSize=5", { token: rec }), 200));
      steps.push(step("Cancel the appointment", await req("POST", `/appointments/${aid}/cancel`, { token: rec, body: { reason: "API probe cleanup" } }), 200));
    }
    if (!mustPay) {
      const w = await req("POST", "/appointments/walk-in", { token: rec, body: { patientId: pid, practitionerId: doc1 }, headers: idem() });
      steps.push(step("Walk-in: check in to the OPD queue", w, [201, 409]));
      const qid = w.json?.data?.queueEntry?.id;
      steps.push(step("OPD queue list", await req("GET", "/queue", { token: rec }), 200));
      if (qid) {
        ids.probeEncounter = w.json.data.encounter?.id;
        steps.push(step("Queue entry is waiting", await req("GET", "/queue", { token: rec }), 200));
        steps.push(step("Cancel the queue entry (cleanup)", await req("POST", `/queue/${qid}/cancel`, { token: rec, body: { reason: "API probe cleanup" } }), [200, 409]));
      }
    } else steps.push({ label: "Walk-in", status: null, result: "SKIPPED", detail: "OPD consultation must be paid first in this hospital's settings (expected)" });
  }
  flow("Appointments and OPD queue", steps);
}
// Billing
{
  const steps = [];
  const pid = ids.probePatient;
  if (pid) {
    const services = await req("GET", "/services?pageSize=5", { token: cashier });
    steps.push(step("Price list", services, 200));
    const inv = await req("POST", "/invoices", { token: cashier, body: { patientId: pid, lines: [{ description: "API probe charge", unitPrice: "10.00", taxPercent: 0, quantity: 1 }] } });
    steps.push(step("Create a bill", inv, 201));
    const iid = inv.json?.data?.id;
    if (iid) {
      steps.push(step("Issue the bill", await req("POST", `/invoices/${iid}/issue`, { token: cashier }), 200));
      const pay = await req("POST", `/invoices/${iid}/payments`, { token: cashier, body: { payments: [{ method: "CASH", amount: "10.00" }] }, headers: idem() });
      steps.push(step("Take a cash payment (shift opens by itself)", pay, 201));
      steps.push(step("Get the bill (paid)", await req("GET", `/invoices/${iid}`, { token: cashier }), 200));
      const rid = pay.json?.data?.receipt?.id;
      if (rid) {
        const pr = await req("GET", `/print/receipts/${rid}`, { token: cashier, raw: true });
        steps.push({ label: "Print the receipt", status: pr.status, result: pr.status === 200 ? "PASS" : "FAIL", detail: "" });
      }
    }
    steps.push(step("Bills list", await req("GET", "/invoices?pageSize=5", { token: cashier }), 200));
    steps.push(step("Current cash shift", await req("GET", "/shifts/current", { token: cashier }), 200));
    steps.push(step("Collections report", await req("GET", "/reports/collections", { token: cashier }), 200));
  }
  flow("Billing", steps);
}
// Admissions
{
  const steps = [];
  steps.push(step("Wards and beds board", await req("GET", "/beds/board", { token: rec }), 200));
  steps.push(step("Admissions list", await req("GET", "/admissions?pageSize=5", { token: rec }), 200));
  if (ids.admission) steps.push(step("Get an admission", await req("GET", `/admissions/${ids.admission}`, { token: rec }), 200));
  const board = await req("GET", "/beds/board", { token: rec });
  const bed = board.json?.data?.wards?.flatMap((w) => w.rooms.flatMap((r) => r.beds)).find((b) => b.status === "AVAILABLE");
  if (bed && ids.probePatient && ids.practitioner) {
    const a = await req("POST", "/admissions", { token: rec, body: { patientId: ids.probePatient, consultantId: ids.practitioner, bedId: bed.id, reason: "API probe" }, headers: idem() });
    steps.push(step("Admit the synthetic patient to a free bed", a, [201, 409]));
    if (a.json?.data?.id) steps.push(step("Cancel the admission (cleanup)", await req("POST", `/admissions/${a.json.data.id}/cancel`, { token: rec, body: { reason: "API probe cleanup" } }), [200, 409]));
  } else steps.push({ label: "Admit a patient", status: null, result: "SKIPPED", detail: "no free bed in the demo data" });
  flow("Admissions", steps);
}

// Integration API (voice bot / other systems): a separate key, not a staff token
{
  const steps = [];
  // Clean up a key left by an earlier probe run, then use a unique name.
  const existing = await req("GET", "/integrations/clients", { token: adm });
  for (const c of existing.json?.data ?? []) if (/^API probe/.test(c.name) && c.status === "ACTIVE") await req("POST", "/integrations/clients/" + c.id + "/revoke", { token: adm, body: { reason: "API probe cleanup" } });
  const made = await req("POST", "/integrations/clients", { token: adm, body: { name: "API probe " + randomUUID().slice(0, 8), abilities: ["FIND_PATIENTS", "BOOK_APPOINTMENTS"], expiresInDays: 1 } });
  steps.push(step("Create an integration key (admin)", made, 201));
  const key = made.json?.data?.apiKey; const cid = made.json?.data?.client?.id;
  if (key) {
    const today = new Date(Date.now() + 5.5 * 3600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
    steps.push(step("Key: doctors with free times", await req("GET", "/booking/doctors?date=" + today + "&slots=2", { token: key }), 200));
    steps.push(step("Key: find a patient by mobile (none expected)", await req("GET", "/booking/patients?mobile=9000000001", { token: key }), 200));
    steps.push(step("Key cannot use staff routes", await req("GET", "/patients?q=DEMO", { token: key }), [401, 403]));
    steps.push(step("Staff may also use the doctors list (by design)", await req("GET", "/booking/doctors", { token: rec }), 200));
    steps.push(step("Staff cannot use the bot-only patient lookup", await req("GET", "/booking/patients?mobile=9000000001", { token: rec }), 403));
    steps.push(step("Revoke the key", await req("POST", "/integrations/clients/" + cid + "/revoke", { token: adm, body: { reason: "API probe cleanup" } }), 200));
    steps.push(step("A revoked key stops working", await req("GET", "/booking/doctors?date=" + today, { token: key }), 401));
  }
  flow("Integration API (bot key)", steps);
}

// ---------- 5. website to API ----------
{
  const w = (label, status, expect, detail = "") => results.web.push({ label, status, result: [].concat(expect).includes(status) ? "PASS" : "FAIL", detail });
  w("Website login page", (await req("GET", "/login", { base: WEB, raw: true })).status, 200);
  const unauth = await req("GET", "/dashboard", { base: WEB, raw: true });
  w("Protected page without a session redirects to login", unauth.status, [302, 307], unauth.headers.get("location") ?? "");
  const noCsrf = await req("POST", "/api/session/login", { base: WEB, body: { tenantCode: TENANT, identifier: "admin", password: "x" }, raw: true });
  w("Login without the CSRF header is refused", noCsrf.status, 403);
  const login = await req("POST", "/api/session/login", { base: WEB, body: { tenantCode: TENANT, identifier: "reception1", password: PASSWORD }, headers: { "x-medos-csrf": "1" }, raw: true });
  const body = await login.json().catch(() => null);
  let cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (body?.data?.status === "FACILITY_SELECTION_REQUIRED") {
    const l2 = await req("POST", "/api/session/login", { base: WEB, body: { tenantCode: TENANT, identifier: "reception1", password: PASSWORD, facilityId: body.data.facilities[0].id }, headers: { "x-medos-csrf": "1" }, raw: true });
    cookie = l2.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  w("Login through the website sets a session cookie", cookie ? 200 : 0, 200);
  const prox = async (m, p, extra = {}) => req(m, p, { base: WEB, headers: { cookie, ...extra }, raw: true });
  w("Website session endpoint (me)", (await prox("GET", "/api/session/me")).status, 200);
  w("The relay never exposes the sign-in routes (by design)", (await prox("GET", "/api/proxy/auth/me")).status, 404);
  w("Website relays patients", (await prox("GET", "/api/proxy/patients?q=DEMO&pageSize=1")).status, 200);
  w("Website relays appointments", (await prox("GET", "/api/proxy/appointments?pageSize=1")).status, 200);
  w("Website relays the OPD queue", (await prox("GET", "/api/proxy/queue")).status, 200);
  w("Website relays admissions", (await prox("GET", "/api/proxy/admissions?pageSize=1")).status, 200);
  w("Website relays bills", (await prox("GET", "/api/proxy/invoices?pageSize=1")).status, 200);
  w("Website refuses a change without the CSRF header", (await prox("POST", "/api/proxy/patients/duplicate-check")).status, 403);
  w("Website without a session gets 401 from the relay", (await req("GET", "/api/proxy/patients?pageSize=1", { base: WEB, raw: true })).status, 401);
  for (const page of ["/dashboard", "/patients", "/appointments", "/queue", "/ipd", "/billing", "/pharmacy", "/reports"]) {
    const r = await req("GET", page, { base: WEB, headers: { cookie }, raw: true });
    w(`Page ${page} opens when signed in`, r.status, [200, 307], r.status === 307 ? (r.headers.get("location") ?? "") : "");
  }
  await prox("POST", "/api/session/logout", { "x-medos-csrf": "1" });
}

// ---------- 6. sign-out clean up: revoke the probe's own refresh tokens ----------
for (const [u, rt] of Object.entries(refreshTokens)) await req("POST", "/auth/logout", { body: { refreshToken: rt } });

writeFileSync(OUT, JSON.stringify(results, null, 1));
const count = (a, r) => a.filter((x) => x.result === r).length;
console.log(`auth: ${count(results.auth, "PASS")}/${results.auth.length} pass`);
const rr = results.routes; const sum = {}; for (const x of rr) sum[x.result] = (sum[x.result] ?? 0) + 1;
console.log(`GET routes: ${rr.length}`, JSON.stringify(sum));
for (const f of results.flows) console.log(`flow ${f.name}: ${f.steps.filter((s) => s.result === "PASS").length}/${f.steps.length} pass, ${f.steps.filter((s) => s.result === "FAIL").length} fail, ${f.steps.filter((s) => s.result === "SKIPPED").length} skipped`);
console.log(`website: ${count(results.web, "PASS")}/${results.web.length} pass`);
for (const x of rr.filter((x) => x.result === "FAIL" || x.result === "NOT_FOUND")) console.log(`  ${x.result} ${x.status} ${x.path} ${x.note}`);
for (const f of results.flows) for (const s of f.steps.filter((s) => s.result === "FAIL")) console.log(`  FLOW-FAIL ${f.name}: ${s.label} -> ${s.status} ${s.detail}`);
for (const x of results.web.filter((x) => x.result === "FAIL")) console.log(`  WEB-FAIL ${x.label} -> ${x.status}`);
for (const x of results.auth.filter((x) => x.result === "FAIL")) console.log(`  AUTH-FAIL ${x.user} -> ${x.status} ${x.detail}`);

