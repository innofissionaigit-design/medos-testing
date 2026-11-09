import "reflect-metadata";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PERMISSIONS } from "@medos/shared";
import { CONTROLLERS } from "../app.module";
import { makeUserWithPermissions, registerPatient, startApp, type TestApp, type TestTenant } from "../test/harness";

const METHODS = ["get", "post", "put", "delete", "patch"] as const; // Nest RequestMethod enum order

interface RouteDef { method: (typeof METHODS)[number]; path: string; label: string }

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

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("security hardening", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let attacker: { id: string; token: string };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("sec-a");
    b = await t.makeTenant("sec-b");
    // A user in another hospital who holds every permission: only tenant scoping can stop them.
    attacker = await makeUserWithPermissions(t, b, [...PERMISSIONS]);
  });
  after(async () => { await t.close(); });

  it("object-id sweep: every route with an id parameter refuses unknown and foreign ids without 2xx or 5xx", async () => {
    const routes = routesWithParams();
    assert.ok(routes.length > 60, `route scan found only ${routes.length} id routes`);
    const bad: string[] = [];
    for (const r of routes) {
      for (const id of [randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
        const url = r.path.replace(/:[A-Za-z]+/g, id);
        const res = await t.api(r.method, url, attacker.token).send(r.method === "get" ? undefined : {});
        if (res.status < 400 || res.status >= 500) bad.push(`${r.label} id=${id} -> ${res.status}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it("a foreign tenant's all-powerful user cannot read or change a real record by id", async () => {
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const p = await registerPatient(t, rec.token);
    for (const [m, path, body] of [
      ["get", `/patients/${p.id}`, undefined], ["patch", `/patients/${p.id}`, { version: p.version, city: "Hijack" }], ["get", `/patients/${p.id}/allergies`, undefined],
      ["get", `/print/patient-labels/${p.id}`, undefined],
    ] as const) {
      const r = await t.api(m, path, attacker.token).send(body);
      assert.equal(r.status, 404, `${m} ${path}`);
    }
    const mine = await t.api("get", `/patients/${p.id}`, rec.token);
    assert.equal(mine.body.data.city === "Hijack", false);
  });

  it("sends hardened response headers and never advertises the framework", async () => {
    const r = await t.api("get", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-powered-by"], undefined);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.ok(r.headers["x-request-id"], "request id echoed");
    assert.ok(r.headers["strict-transport-security"], "HSTS present");
    assert.ok(r.headers["x-frame-options"] || /frame-ancestors/.test(r.headers["content-security-policy"] ?? ""), "clickjacking protection");
  });

  it("errors are structured, free of stack traces and internals, and body problems are client errors", async () => {
    const unknown = await t.api("get", "/no-such-route", a.admin.token);
    assert.equal(unknown.status, 404);
    assert.ok(unknown.body.error?.code);
    const malformed = await t.http().post("/api/v1/auth/login").set("Content-Type", "application/json").send('{"username": ');
    assert.equal(malformed.status, 400);
    assert.ok(malformed.body.error?.code);
    const huge = await t.http().post("/api/v1/auth/login").set("Content-Type", "application/json").send(JSON.stringify({ username: "x".repeat(2_000_000) }));
    assert.equal(huge.status, 413);
    for (const res of [unknown, malformed, huge]) {
      const text = JSON.stringify(res.body);
      assert.ok(!/stack|node_modules|prisma|postgres|SELECT |at \w+ \(/i.test(text), `leaky error body: ${text.slice(0, 200)}`);
    }
  });

  it("hostile input is rejected or inert: prototype pollution, SQL metacharacters, unknown fields", async () => {
    const pollute = await t.http().post("/api/v1/auth/login").set("Content-Type", "application/json").send('{"__proto__":{"isAdmin":true},"tenantCode":"x","username":"u","password":"p"}');
    assert.ok(pollute.status >= 400 && pollute.status < 500, `got ${pollute.status}`);
    assert.equal(({} as Record<string, unknown>)["isAdmin"], undefined, "Object.prototype must stay clean");
    for (const q of ["' OR 1=1 --", "'; DROP TABLE \"Patient\"; --", "%' UNION SELECT * FROM \"User\" --", "\\", "\u0000"]) {
      const r = await t.api("get", "/patients", a.admin.token).query({ q });
      assert.ok(r.status < 500, `search with ${JSON.stringify(q)} -> ${r.status}`);
    }
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    const r = await t.api("post", "/patients", rec.token).send({ firstName: "Asha", gender: "FEMALE", mobile: "9830012345", estimatedAgeYears: 30, tenantId: b.tenantId, registeredFacilityId: b.facilityId });
    assert.equal(r.status, 400, "client-supplied tenant or facility must be rejected");
  });

  it("forged, unsigned, tampered and foreign-secret tokens are all rejected", async () => {
    const real = a.admin.token;
    const [h, p] = real.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const forged = [
      `${b64({ alg: "none", typ: "JWT" })}.${p}.`,
      `${h}.${b64({ ...payload, sub: randomUUID() })}.${real.split(".")[2]}`,
      `${h}.${b64({ ...payload, tid: b.tenantId })}.${real.split(".")[2]}`,
      `${h}.${p}.${createHmac("sha256", "attacker-secret").update(`${h}.${p}`).digest("base64url")}`,
      "garbage", "a.b.c", "",
    ];
    for (const tok of forged) {
      const r = await t.api("get", "/settings/features").set("Authorization", `Bearer ${tok}`);
      assert.equal(r.status, 401, `token ${tok.slice(0, 30)}…`);
    }
    assert.equal((await t.api("get", "/settings/features").set("Authorization", real)).status, 401, "scheme required");
    assert.equal((await t.api("get", "/settings/features", real)).status, 200);
  });
});
