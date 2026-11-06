import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PERMISSIONS } from "@medos/shared";
import { CONTROLLERS } from "../app.module";
import { makeClinicianWith, startApp, type TestApp, type TestDoctor, type TestTenant } from "../test/harness";

/**
 * Tenant isolation, checked the hard way (docs/rls.md, user story 1.7). A user of a NEW hospital who holds every permission tries every route that takes an id in its
 * path, with REAL ids of records that belong to other hospitals (one or two from each table that has a tenantId, taken from whatever the test database holds).
 * Random ids would prove nothing: they get a 404 whether or not a route checks the hospital. For a write route the request must also get past input validation to
 * reach the lookup, so the test learns a valid body for each route from the validation errors (see learn()) and replays it against every foreign id.
 *
 * It asserts that no request succeeds or crashes, that every read route answers a foreign id with 404, and that every write route is actually driven to its lookup
 * (answered 404), except the few listed in NOT_DRIVEN, each with the reason and where it is covered instead.
 */

const METHODS = ["get", "post", "put", "delete", "patch"] as const; // Nest RequestMethod enum order
type Method = (typeof METHODS)[number];
interface RouteDef { method: Method; path: string; label: string }
type Json = Record<string, unknown>;

/** Every route of every controller that takes a parameter in its path. */
function routesWithParams(): RouteDef[] {
  const out: RouteDef[] = [];
  for (const C of CONTROLLERS) {
    const base = String(Reflect.getMetadata("path", C) ?? "");
    const proto = C.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === "constructor" || typeof handler !== "function") continue;
      const m = Reflect.getMetadata("method", handler) as number | undefined;
      if (m === undefined || METHODS[m] === undefined) continue;
      const sub = String(Reflect.getMetadata("path", handler) ?? "");
      const path = `/${[base, sub].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
      if (path.includes(":")) out.push({ method: METHODS[m]!, path, label: `${METHODS[m]!.toUpperCase()} ${path}` });
    }
  }
  return out;
}

/** Routes whose path parameter is not a record id (the kind of import). */
const notAnId = (r: RouteDef): boolean => r.path.includes(":kind");

/** Write routes this test cannot drive to their lookup with a generic body, and why. Each is covered by the module's own test of the same route. */
const NOT_DRIVEN: Record<string, string> = {
  "POST /patient-portal/teleconsults/:id/join": "patient app: signs in with a patient session, not a staff token (portal.spec.ts, telemedicine.spec.ts)",
  "POST /encounters/:id/ai/drafts": "the AI assistant needs a connected provider before it looks anything up (ai.spec.ts: another hospital's doctor is refused)",
  "POST /patient-portal/appointment-requests/:id/cancel": "patient app: signs in with a patient session, not a staff token (portal.spec.ts)",
  // Email wording is kept for the signed-in hospital by template name and language: there is no record id of another hospital to try (email.spec.ts: another hospital's wording is untouched).
  "PUT /email/templates/:key/:language": "keyed by template name and language inside the signed-in hospital, not by a record id (email.spec.ts)",
  "DELETE /email/templates/:key/:language": "keyed by template name and language inside the signed-in hospital, not by a record id (email.spec.ts)",
  "POST /email/templates/:key/:language/preview": "keyed by template name and language; it reads and writes no record (email.spec.ts)",
};

// ───── learning a valid body from the validation errors ─────

/** A starting body for routes whose rules (a configured reason, a union, "at least one field") the validation errors alone cannot lead to. Everything else is learned. */
const SEED: Record<string, Json> = {
  "POST /patients/:id/registration-fee": { exemption: { reason: "Sweep" } },
  "POST /appointments/:id/booking-fee/skip": { reason: "Sweep" },
  "POST /patients/:id/merge": { intoPatientId: randomUUID(), version: 1, reason: "Sweep value" },
  "PUT /invoices/:id": { version: 1, lines: [{ description: "Sweep line", unitPrice: "1.00", taxPercent: "0", quantity: "1" }] },
  "POST /admissions/:id/charges": { description: "Sweep charge", unitPrice: "1.00", taxPercent: "0", quantity: "1" },
  "PATCH /appointments/:id": { version: 1, durationMinutes: 15 },
  "PATCH /beds/:id": { dailyRate: "1.00" },
  "PATCH /medicines/:id": { status: "ACTIVE" },
  "PUT /policies/:id/copay": { copayPercent: "10", deductible: "1.00", deductibleUsed: "0.00" },
  "POST /cashier/patients/:patientId/collect": { invoiceIds: ["__ID__"], payments: [{ method: "CASH", amount: "1.00" }] },
  "POST /users/:id/reset-password": { password: "Sweepvalue12345" },
};
/** Fields to try, one by one, when a change route answers "no changes supplied" (a field the route does not know is removed again from the next answer). */
const CHANGE_FIELDS = ["name", "displayName", "title", "description", "notes", "label", "phone", "address", "fullName", "email", "specialty", "remarks", "code", "city", "contactPhone"];
const EMPTY_CHANGE = /No changes supplied|Nothing to change/;
/** Values tried, in turn, for a field that answers just "Invalid input" (a union or custom rule). */
const GUESSES: unknown[] = ["1.00", 1, "2026-11-02T10:00:00.000Z", "Sweep value", "2026-11-02"];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("sweep")]);
/** Routes that take a raw file as the body instead of JSON. */
const RAW: Record<string, { query: Record<string, string> }> = {
  "POST /patients/:id/files": { query: { kind: "DOCUMENT", filename: "a.png", title: "Sweep file" } },
  "POST /rad/studies/:id/images": { query: { filename: "a.png" } },
  "POST /claims/:id/documents": { query: { filename: "a.png", label: "Sweep file" } },
  "POST /encounters/:id/prescription-scans": { query: { filename: "a.png" } },
};

function getPath(o: Json, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) { if (cur === null || typeof cur !== "object") return undefined; cur = (cur as Json)[k]; }
  return cur;
}
function setPath(o: Json, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = o as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
function deletePath(o: Json, path: string): void {
  const parts = path.split(".");
  const parent = parts.length === 1 ? o : (getPath(o, parts.slice(0, -1).join(".")) as Json | undefined);
  if (parent && typeof parent === "object") delete parent[parts[parts.length - 1]!];
}

/** A value that answers one validation message (the wording of zod 4), or undefined when the message is not understood. */
function answer(message: string, path: string, foreignId: string, attempt: number): unknown {
  let m: RegExpExecArray | null;
  if (/Invalid ISO datetime/i.test(message)) return "2026-11-02T10:00:00.000Z";
  if (/Password must contain/i.test(message)) return "Sweepvalue12345";
  if (message === "Invalid input" && !/.d+$/.test(path)) return GUESSES[attempt % GUESSES.length];
  if ((m = /expected one of ((?:"[^"]*")(?:\|"[^"]*")*)/.exec(message))) return m[1]!.split("|")[0]!.replace(/^"|"$/g, "");
  if (/Invalid UUID|Invalid uuid|valid UUID/.test(message)) return foreignId;
  if (/Invalid email|valid email address/i.test(message)) return "sweep@example.com";
  if ((m = /expected (string|number|int|integer|boolean|array|object|date|bigint|record|nonoptional), received/.exec(message))) {
    return { string: "Sweep value", number: 1, int: 1, integer: 1, boolean: true, array: [], object: {}, record: {}, date: "2026-11-02", bigint: 1, nonoptional: "Sweep value" }[m[1] as "string"];
  }
  if ((m = /expected string to have >=(\d+) character/.exec(message))) return "Abcdefghij".repeat(Math.ceil(Number(m[1]) / 10)).slice(0, Math.max(3, Number(m[1])));
  if (/expected string to have <=\d+ character/.test(message)) return "Abc";
  if ((m = /expected number to be >=(-?\d+(?:\.\d+)?)/.exec(message))) return Number(m[1]);
  if ((m = /expected number to be >(-?\d+(?:\.\d+)?)/.exec(message))) return Number(m[1]) + 1;
  if ((m = /expected number to be <=(-?\d+(?:\.\d+)?)/.exec(message))) return Math.min(1, Number(m[1]));
  if ((m = /expected array to have >=(\d+) items/.exec(message))) return Array.from({ length: Number(m[1]) }, () => ({}));
  if (/Invalid input: expected int/.test(message)) return 1;
  if ((m = /(?:like|e\.g\.|for example) ([0-9A-Za-z][0-9A-Za-z:\-.]*)/.exec(message))) return m[1]!.replace(/\.$/, "");
  if (/digits only|Digits only/i.test(message)) return "123456789";
  if (/Invalid date|valid date/i.test(message)) return "2026-11-02";
  return undefined;
}

interface Probe { body: Json | undefined; query: Json; reached: boolean; last?: string }

/** Sends a first request with one foreign id and keeps filling in what the validation errors ask for, until the request gets past validation (or stops making progress). */
async function learn(t: TestApp, r: RouteDef, token: string, foreignId: string): Promise<Probe> {
  const body: Json = JSON.parse(JSON.stringify(SEED[r.label] ?? {}).split("__ID__").join(foreignId)) as Json;
  const query: Json = {};
  const asQuery = r.method === "get";
  const target = asQuery ? query : body;
  let lastDetails = "";
  const attempts = new Map<string, number>();
  let fieldTry = 0;
  for (let round = 0; round < 40; round++) {
    const url = r.path.replace(/:[A-Za-z]+/g, foreignId);
    const req = t.api(r.method, url, token).set("Idempotency-Key", randomUUID()).query(query as Record<string, string>);
    const res = r.method === "get" ? await req.send() : await req.send(body);
    const details = res.body?.error?.details as { path: string; message: string }[] | undefined;
    if (res.status !== 400 || !Array.isArray(details) || details.length === 0) return { body: asQuery ? undefined : body, query, reached: res.status === 404, last: `${res.status} ${res.body?.error?.code ?? ""} ${res.body?.error?.message ?? ""}` };
    let changed = false;
    lastDetails = JSON.stringify(details);
    for (const d of details) {
      if (/Unrecognized key/.test(d.message)) {
        const keys = [...d.message.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
        for (const k of keys) { deletePath(target, d.path ? `${d.path}.${k}` : k); changed = true; }
        continue;
      }
      const path = d.path;
      if (!path) {
        if (EMPTY_CHANGE.test(d.message) && fieldTry < CHANGE_FIELDS.length) { setPath(target, CHANGE_FIELDS[fieldTry++]!, "Sweep value"); changed = true; }
        continue;
      }
      const attempt = attempts.get(path) ?? 0;
      attempts.set(path, attempt + 1);
      const v = answer(d.message, path, foreignId, attempt);
      if (v === undefined) continue;
      const before = JSON.stringify(getPath(target, path));
      setPath(target, path, v);
      if (JSON.stringify(getPath(target, path)) !== before) changed = true;
    }
    if (!changed) break;
  }
  return { body: asQuery ? undefined : body, query, reached: false, last: `no progress ${lastDetails}` };
}

describe("tenant isolation: real records of other hospitals, on every route that takes an id", () => {
  let t: TestApp;
  let b: TestTenant;
  let attacker: TestDoctor;

  before(async () => {
    t = await startApp();
    b = await t.makeTenant("sweep-b");
    // A user of this hospital who holds every permission, so only tenant isolation can stop them.
    // (and a practitioner record, which clinical routes ask for), in a hospital where handwritten prescriptions and the fee reasons are set up.
    attacker = await makeClinicianWith(t, b, [...PERMISSIONS]);
    for (const [key, value] of [["PRESCRIPTION_UPLOAD_ENABLED", true], ["PRESCRIPTION_OCR_ENABLED", true], ["BOOKING_FEE_SKIP_REASONS", ["Sweep"]], ["REGISTRATION_FEE_EXEMPT_REASONS", ["Sweep"]]] as const) {
      const res = await t.api("put", `/settings/${key}`, b.admin.token).send({ value });
      assert.equal(res.status, 200, `${key}: ${JSON.stringify(res.body)}`);
    }
  });
  after(async () => { await t.close(); });

  /** One or two real ids from each table that belongs to some other hospital. */
  async function foreignIds(): Promise<{ table: string; id: string }[]> {
    const tables = await t.prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.columns i ON i.table_name = c.table_name AND i.table_schema = c.table_schema AND i.column_name = 'id' AND i.data_type = 'uuid'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' ORDER BY c.table_name`);
    const out: { table: string; id: string }[] = [];
    for (const { table_name } of tables) {
      const rows = await t.prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM "${table_name}" WHERE "tenantId" <> $1::uuid ORDER BY id LIMIT 2`, b.tenantId);
      for (const r of rows) out.push({ table: table_name, id: r.id });
    }
    return out;
  }

  it("no route reveals or changes another hospital's record; reads answer 404; writes reach their lookup and answer 404", async () => {
    const routes = routesWithParams().filter((r) => !notAnId(r));
    const ids = await foreignIds();
    assert.ok(routes.length > 200, `route scan found only ${routes.length} routes with ids`);
    assert.ok(ids.length > 40, `only ${ids.length} foreign records in the test database to try (run the full suite first)`);
    const probeId = ids[0]!.id;

    const problems: string[] = [];
    const notReached: string[] = [];
    let sent = 0;
    for (const r of routes) {
      const raw = RAW[r.label];
      const learned = raw ? { body: undefined, query: raw.query, reached: true } : await learn(t, r, attacker.token, probeId);
      let got404 = 0;
      for (let i = 0; i < ids.length; i += 4) {
        const batch = ids.slice(i, i + 4);
        const results = await Promise.all(batch.map(async (x) => {
          const url = r.path.replace(/:[A-Za-z]+/g, x.id);
          // The body names the foreign id wherever the route needs one, so a lookup by id in the body is tried too.
          const body = learned.body ? (JSON.parse(JSON.stringify(learned.body).split(probeId).join(x.id)) as Json) : undefined;
          let req = t.api(r.method, url, attacker.token).set("Idempotency-Key", randomUUID()).query(learned.query as Record<string, string>);
          if (raw) req = req.set("Content-Type", "image/png");
          const res = r.method === "get" ? await req.send() : await req.send(raw ? PNG : body);
          return { x, status: res.status, detail: res.status >= 500 ? `${res.body?.error?.code} ${JSON.stringify(learned.query)} ${url}` : "" };
        }));
        for (const res of results) {
          sent++;
          if (res.status === 404) got404++;
          if (res.status < 400 || res.status >= 500) problems.push(`${r.label} with a record of ${res.x.table} (${res.x.id}) -> ${res.status} ${res.detail}`);
          else if (r.method === "get" && res.status !== 404) problems.push(`${r.label} with a record of ${res.x.table} (${res.x.id}) -> ${res.status}, expected 404`);
        }
      }
      if (got404 === 0) { notReached.push(r.label); if (process.env["SWEEP_DEBUG"]) process.stdout.write(`STUCK ${r.label} :: ${learned.last} :: ${JSON.stringify(learned.body)}
`); }
    }
    process.stdout.write(`routes: ${routes.length}, foreign records: ${ids.length} (${new Set(ids.map((i) => i.table)).size} tables), requests: ${sent}\n`);
    const distinct = [...new Set(problems.map((p) => p.replace(/ with a record of .*? -> /, " -> ")))];
    assert.deepEqual(distinct, [], `${problems.length} problems`);
    const unexpected = notReached.filter((l) => !(l in NOT_DRIVEN));
    process.stdout.write(`not driven to the lookup: ${JSON.stringify(unexpected)}\n`);
    assert.deepEqual(unexpected, [], "these routes never got past input validation, so the test did not check them");
    const stale = Object.keys(NOT_DRIVEN).filter((l) => !notReached.includes(l));
    assert.deepEqual(stale, [], "listed in NOT_DRIVEN but now driven: remove them from the list");
  });

  it("bad input and unknown ids in the path are refused cleanly, never with a crash", async () => {
    const id = randomUUID();
    const totals = await t.api("get", `/admissions/${id}/intake-output/totals?date=garbage`, attacker.token);
    assert.equal(totals.status, 400, "an impossible date is a bad request, not a server error");
    for (const tail of ["schedule", "availability?date=2026-11-02"]) {
      const r = await t.api("get", `/practitioners/${id}/${tail}`, attacker.token);
      assert.deepEqual([r.status, r.body.error.code], [404, "NOT_FOUND"], tail);
    }
    const fee = await t.api("post", `/patients/${id}/registration-fee`, attacker.token).set("Idempotency-Key", randomUUID()).send({ exemption: { reason: "Sweep" } });
    assert.deepEqual([fee.status, fee.body.error.code], [404, "NOT_FOUND"]);
  });

  it("a foreign id in the path gets the same answer as an id that does not exist, so ids cannot be probed", async () => {
    const ids = await foreignIds();
    const real = ids.find((i) => i.table === "Patient")?.id ?? ids[0]!.id;
    const a = await t.api("get", `/patients/${real}`, attacker.token);
    const none = await t.api("get", `/patients/${randomUUID()}`, attacker.token);
    assert.deepEqual([a.status, a.body.error.code, a.body.error.message], [none.status, none.body.error.code, none.body.error.message]);
  });
});
