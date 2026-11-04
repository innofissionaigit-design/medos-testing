import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../test/harness";

/**
 * Latency of a representative workload in whichever mode the suite is running (docs/rls.md): owner login with the tenant context
 * off, the emulated restricted role, or the real restricted login. It prints median and 95th percentile per operation as test
 * diagnostics ("# bench ...") and only asserts a generous ceiling, so it compares modes without being flaky.
 */
const mode = process.env["TEST_APP_DATABASE_URL"] ? "real restricted login, tenant context on"
  : process.env["DB_SESSION_ROLE"] ? "emulated restricted role, tenant context on"
  : process.env["DB_TENANT_CONTEXT"] === "on" ? "owner login, tenant context on" : "owner login, tenant context off (before)";

const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };

describe("benchmark: request latency", () => {
  let t: TestApp;
  let a: TestTenant;
  let token: string;
  let ids: string[];
  let names: string[];

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("bench");
    token = (await t.makeUser(a, ["RECEPTIONIST"])).token;
    ids = [];
    names = [];
    for (let i = 0; i < 25; i++) { const w = uniqueWord(8); names.push(w); ids.push((await registerPatient(t, token, { firstName: w })).id); }
  });
  after(async () => { await t.close(); });

  it(`workload (${mode})`, async (ctx) => {
    const run = async (label: string, n: number, call: (i: number) => Promise<{ status: number }>): Promise<void> => {
      for (let i = 0; i < 8; i++) await call(i); // warm-up, not counted
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = process.hrtime.bigint();
        const r = await call(i);
        times.push(ms(s));
        assert.ok(r.status < 300, `${label}: status ${r.status}`);
      }
      const med = pct(times, 50);
      const p95 = pct(times, 95);
      ctx.diagnostic(`bench | ${mode} | ${label.padEnd(26)} n=${String(n).padStart(3)} median=${med.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
      assert.ok(p95 < 3000, `${label}: p95 ${p95.toFixed(0)} ms is far over budget`);
    };
    await run("GET patient by id", 120, (i) => t.api("get", `/patients/${ids[i % ids.length]}`, token));
    await run("GET patient search (name)", 80, (i) => t.api("get", "/patients", token).query({ q: names[i % names.length]!.slice(0, 5) }));
    await run("GET me (session)", 80, () => t.api("get", "/auth/me", token));
    await run("POST register patient", 30, () => t.api("post", "/patients", token).send({ firstName: uniqueWord(8), lastName: uniqueWord(8), gender: "FEMALE", dateOfBirth: "1990-04-02", mobile: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}` }));

    const s = process.hrtime.bigint();
    const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => t.api("get", `/patients/${ids[i % ids.length]}`, token)));
    const wall = ms(s);
    assert.ok(burst.every((r) => r.status === 200));
    ctx.diagnostic(`bench | ${mode} | 60 concurrent GET patient    wall=${wall.toFixed(0)}ms`);
  });
});
