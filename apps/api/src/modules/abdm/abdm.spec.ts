import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };
type Mode = "ok" | "denied" | "missing" | "no-token" | "error";
const SECRET = "very-secret-gateway-value-42";

function fakeGateway(): Promise<{ server: Server; port: number; mode: { current: Mode }; seen: { body: Record<string, unknown>; url: string }[] }> {
  const seen: { body: Record<string, unknown>; url: string }[] = [];
  const mode: { current: Mode } = { current: "ok" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seen.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, url: req.url ?? "" }); } catch { /* not json */ }
      const status = mode.current === "denied" ? 401 : mode.current === "missing" ? 404 : mode.current === "error" ? 500 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(mode.current === "ok" ? { accessToken: "a-session-token-we-never-keep", expiresIn: 600 } : mode.current === "no-token" ? { hello: "world" } : { message: `rejected ${SECRET}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, mode, seen })));
}

describe("ABDM groundwork: the facility's gateway connection and ABHA numbers on the chart", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let nurse: User; let bRec: User;
  let gw: Awaited<ReturnType<typeof fakeGateway>>;
  const url = () => `http://127.0.0.1:${gw.port}/gateway/sessions`;
  const body = (over: Record<string, unknown> = {}) => ({ environment: "SANDBOX", sessionUrl: url(), clientId: "SBX_001234", clientSecret: SECRET, hfrId: "IN0410000001", ...over });
  const save = (b2: Record<string, unknown>, tok = a.admin.token) => t.api("put", "/abdm/config", tok).send(b2);
  const view = (tok = a.admin.token) => t.api("get", "/abdm/config", tok);
  let n = 0;
  const abhaNo = () => `9${String(Date.now()).slice(-8)}${String(++n).padStart(5, "0")}`;
  const dashed = (v: string) => `${v.slice(0, 2)}-${v.slice(2, 6)}-${v.slice(6, 10)}-${v.slice(10)}`;
  const record = (patientId: string, number: string, over: Record<string, unknown> = {}, tok = rec.token) => t.api("post", `/patients/${patientId}/abha`, tok).send({ abhaNumber: number, ...over });

  before(async () => {
    gw = await fakeGateway();
    t = await startApp();
    a = await t.makeTenant("abdm-a"); b = await t.makeTenant("abdm-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); nurse = await t.makeUser(a, ["NURSE"]); bRec = await t.makeUser(b, ["RECEPTIONIST"]);
  });
  after(async () => { await t.close(); gw.server.close(); });

  describe("the gateway connection", () => {
    it("only administrators of settings see or change it; it says plainly what is and is not built", async () => {
      for (const tok of [rec.token, nurse.token]) {
        assert.equal((await view(tok)).status, 403);
        assert.equal((await save(body(), tok)).status, 403);
        assert.equal((await t.api("post", "/abdm/config/test", tok)).status, 403);
        assert.equal((await t.api("delete", "/abdm/config", tok)).status, 403);
      }
      assert.equal((await t.api("get", "/abdm/config")).status, 401);
      const v = (await view()).body.data;
      const state = Object.fromEntries((v.capabilities as { name: string; state: string }[]).map((c) => [c.name, c.state]));
      assert.equal(state["Verify an ABHA with ABDM"], "NOT_BUILT");
      assert.equal(state["Link care contexts (visits) to an ABHA"], "NOT_BUILT");
      assert.equal(state["Consent requests and sharing of health records"], "NOT_BUILT");
      assert.equal(state["Test the connection to the ABDM gateway"], "NOT_CONFIGURED");
      assert.deepEqual([v.hasSecret, v.sessionUrl], [false, null]);
    });

    it("refuses a wrong address or details, and a secret is never given back", async () => {
      for (const bad of [{ sessionUrl: "http://gateway.example.test/sessions" }, { sessionUrl: "not a url" }, { sessionUrl: "ftp://x.example.test/s" }, { clientId: "x" }, { environment: "STAGING" }, { clientSecret: "short" }, { extra: 1 }, { clientSecret: SECRET, clearSecret: true }]) assert.equal((await save(body(bad))).status, 400, JSON.stringify(bad));
      assert.equal((await t.api("post", "/abdm/config/test", a.admin.token)).status, 409, "nothing saved yet");
      const ok = await save(body());
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.hasSecret, ok.body.data.secretLast4, ok.body.data.clientId, ok.body.data.environment], [true, SECRET.slice(-4), "SBX_001234", "SANDBOX"]);
      assert.ok(!JSON.stringify(ok.body).includes(SECRET) && !JSON.stringify((await view()).body).includes(SECRET), "the secret is write-only");
      const row = await t.prisma.abdmConfig.findFirstOrThrow({ where: { tenantId: a.tenantId } });
      assert.ok(row.clientSecretEnc && !row.clientSecretEnc.includes(SECRET), "stored encrypted");
      assert.equal((await view(b.admin.token)).body.data.hasSecret, false, "another hospital has its own, empty");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ABDM_CONFIG_SAVED" } }));
    });

    it("the test asks the gateway for a session with the saved credentials and keeps nothing but the answer", async () => {
      gw.seen.length = 0;
      const r = await t.api("post", "/abdm/config/test", a.admin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.ok, true);
      assert.deepEqual(gw.seen[0]?.body, { clientId: "SBX_001234", clientSecret: SECRET, grantType: "client_credentials" });
      assert.ok(!JSON.stringify(r.body).includes("a-session-token") && !JSON.stringify(r.body).includes(SECRET));
      const v = (await view()).body.data;
      assert.deepEqual([v.lastTest.ok, v.capabilities.find((c: { name: string }) => c.name.startsWith("Test the connection")).state], [true, "TESTED_OK"]);
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ABDM_CONFIG_TESTED" } }));
      const cases: [Mode, RegExp][] = [["denied", /did not accept the client id and secret/], ["missing", /does not know this address/], ["no-token", /not with a session/], ["error", /HTTP 500/]];
      for (const [mode, text] of cases) {
        gw.mode.current = mode;
        const bad = (await t.api("post", "/abdm/config/test", a.admin.token)).body.data;
        assert.equal(bad.ok, false, mode);
        assert.match(bad.message, text, mode);
        assert.ok(!bad.message.includes(SECRET), "the gateway's reply is never repeated");
      }
      gw.mode.current = "ok";
    });

    it("an unreachable gateway is reported; changing the address needs the secret again; changed details are untested; disconnect clears everything", async () => {
      const dead = await save({ environment: "SANDBOX", sessionUrl: "http://127.0.0.1:1/gateway/sessions", clientId: "SBX_001234" });
      assert.equal(dead.status, 400, "the saved secret is not sent to a new address unless it is entered again");
      assert.equal((await save(body({ sessionUrl: "http://127.0.0.1:1/gateway/sessions", clientSecret: SECRET }))).status, 200);
      const down = (await t.api("post", "/abdm/config/test", a.admin.token)).body.data;
      assert.deepEqual([down.ok, down.message], [false, "ABDM could not be reached from the server."]);
      assert.equal((await save(body({ clientSecret: SECRET }))).status, 200);
      assert.equal((await view()).body.data.lastTest, null, "changed details are untested");
      assert.equal((await save({ environment: "SANDBOX", sessionUrl: url(), clientId: "SBX_001234", hfrId: "IN0410000001" })).status, 200, "the secret can stay as it is");
      assert.equal((await view()).body.data.hasSecret, true);
      assert.equal((await save({ environment: "SANDBOX", sessionUrl: url(), clientId: "SBX_001234", clearSecret: true })).status, 200);
      assert.equal((await view()).body.data.hasSecret, false);
      assert.equal((await t.api("post", "/abdm/config/test", a.admin.token)).status, 409, "no secret to test with");
      assert.equal((await save(body())).status, 200);
      const gone = await t.api("delete", "/abdm/config", a.admin.token);
      assert.equal(gone.status, 200);
      assert.deepEqual([gone.body.data.sessionUrl, gone.body.data.clientId, gone.body.data.hasSecret], [null, null, false]);
      assert.equal((await t.api("delete", "/abdm/config", a.admin.token)).status, 409, "nothing left to disconnect");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ABDM_CONFIG_DISCONNECTED" } }));
    });
  });

  describe("ABHA numbers on the chart", () => {
    it("recorded as typed (with dashes or spaces), kept as 14 digits, shown as recorded and not verified", async () => {
      const p = await registerPatient(t, rec.token);
      const no = abhaNo();
      for (const bad of ["123", "1234567890123x", `${no}1`, "", "ab-cdef-ghij-klmn"]) assert.equal((await record(p.id, bad)).status, 400, bad);
      for (const bad of ["name", "name@gmail.com", "@abdm", "a@abdm"]) assert.equal((await record(p.id, no, { abhaAddress: bad })).status, 400, bad);
      assert.equal((await record(p.id, no, { extra: 1 })).status, 400);
      const ok = await record(p.id, dashed(no), { abhaAddress: "Meera.Das@abdm" });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.abhaNumber, ok.body.data.abhaAddress, ok.body.data.verified, ok.body.data.status], [dashed(no), "meera.das@abdm", false, "RECORDED_NOT_VERIFIED"]);
      assert.equal((await t.prisma.abhaLink.findFirstOrThrow({ where: { patientId: p.id } })).abhaNumber, no, "stored as digits");
      assert.equal((await record(p.id, abhaNo())).status, 409, "one at a time: remove the first");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ABHA_RECORDED", entityId: ok.body.data.id } }));
    });

    it("who may record: reception can, a nurse can only look; another hospital's patient is out of reach", async () => {
      const p = await registerPatient(t, rec.token);
      const no = abhaNo();
      assert.equal((await record(p.id, no, {}, nurse.token)).status, 403);
      assert.equal((await record(p.id, no, {}, bRec.token)).status, 404);
      assert.equal((await record(randomUUID(), no)).status, 404);
      assert.equal((await t.api("post", `/patients/${p.id}/abha`).send({ abhaNumber: no })).status, 401);
      assert.equal((await record(p.id, no)).status, 201);
      assert.equal((await t.api("get", `/patients/${p.id}/abha`, nurse.token)).status, 200);
      assert.equal((await t.api("get", `/patients/${p.id}/abha`, bRec.token)).status, 404);
    });

    it("the same number cannot sit on two live patients (the message names the other MRN, as it may be the same person)", async () => {
      const p1 = await registerPatient(t, rec.token);
      const p2 = await registerPatient(t, rec.token);
      const no = abhaNo();
      assert.equal((await record(p1.id, no)).status, 201);
      const dup = await record(p2.id, dashed(no));
      assert.equal(dup.status, 409);
      assert.ok(dup.body.error.message.includes(p1.mrn), "names the other patient's MRN");
      const p3 = await registerPatient(t, rec.token);
      const p4 = await registerPatient(t, rec.token);
      const race = abhaNo();
      const rs = await Promise.all([record(p3.id, race), record(p4.id, race)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], JSON.stringify(rs.map((r) => r.body)));
    });

    it("removing needs a reason and keeps the record; the number is free again; the patient is found by it only while it is live", async () => {
      const p1 = await registerPatient(t, rec.token);
      const p2 = await registerPatient(t, rec.token);
      const no = abhaNo();
      const made = (await record(p1.id, no)).body.data;
      const search = async (q: string) => ((await t.api("get", `/patients?q=${encodeURIComponent(q)}`, rec.token)).body.data as { id: string }[]).map((x) => x.id);
      assert.ok((await search(no)).includes(p1.id), "found by the number");
      assert.ok((await search(dashed(no).replace(/-/g, ""))).includes(p1.id));
      assert.equal((await t.api("post", `/patients/${p1.id}/abha/${made.id}/remove`, rec.token).send({ reason: "no" })).status, 400);
      assert.equal((await t.api("post", `/patients/${p1.id}/abha/${made.id}/remove`, nurse.token).send({ reason: "Entered for the wrong patient" })).status, 403);
      assert.equal((await t.api("post", `/patients/${p2.id}/abha/${made.id}/remove`, rec.token).send({ reason: "Entered for the wrong patient" })).status, 404, "another patient's record");
      assert.equal((await t.api("post", `/patients/${p1.id}/abha/${made.id}/remove`, bRec.token).send({ reason: "Entered for the wrong patient" })).status, 404);
      assert.equal((await t.api("post", `/patients/${p1.id}/abha/${made.id}/remove`, rec.token).send({ reason: "Entered for the wrong patient" })).status, 200);
      assert.equal((await t.api("post", `/patients/${p1.id}/abha/${made.id}/remove`, rec.token).send({ reason: "Trying to remove again" })).status, 409);
      assert.equal((await search(no)).includes(p1.id), false, "not found by a removed number");
      const history = (await t.api("get", `/patients/${p1.id}/abha`, rec.token)).body.data as { id: string; abhaNumber: string; removedAt: string | null; removeReason: string | null }[];
      assert.deepEqual([history.length, history[0]?.removeReason, history[0]?.abhaNumber.includes("•")], [1, "Entered for the wrong patient", true], "kept, with the number masked");
      assert.equal((await record(p2.id, no)).status, 201, "the number is free for the right patient");
      assert.ok((await search(no)).includes(p2.id));
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "ABHA_REMOVED", entityId: made.id } }));
    });

    it("DATABASE: an ABHA record is never deleted or rewritten; a removed one stays removed; the formats are checked", async () => {
      const p = await registerPatient(t, rec.token);
      const made = (await record(p.id, abhaNo())).body.data;
      await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "AbhaLink" WHERE id = '${made.id}'::uuid`), /cannot be deleted/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AbhaLink" SET "abhaNumber" = '12345678901234' WHERE id = '${made.id}'::uuid`), /cannot be changed/);
      await assert.rejects(t.prisma.$executeRawUnsafe(`INSERT INTO "AbhaLink" ("tenantId", "patientId", "abhaNumber", "recordedById") VALUES ('${a.tenantId}'::uuid, '${p.id}'::uuid, '12345', '${rec.id}'::uuid)`), /abha_link_values|check constraint/i);
      await t.api("post", `/patients/${p.id}/abha/${made.id}/remove`, rec.token).send({ reason: "Removed for the database check" });
      await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AbhaLink" SET "removedAt" = NULL, "removedById" = NULL, "removeReason" = NULL WHERE id = '${made.id}'::uuid`), /removed ABHA record cannot change/);
    });
  });
});
