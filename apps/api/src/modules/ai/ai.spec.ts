import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeDoctor, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { adviceMaterial, hasAdviceMaterial, historyMaterial, MAX_INPUT_CHARS, scrub, SYSTEM_ADVICE, SYSTEM_HISTORY, type PatientFacts, type VisitFacts } from "./ai.domain";

type User = { id: string; token: string };
type Mode = "ok" | "denied" | "error" | "empty";
interface Seen { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
const KEY = "sk-test-key-should-stay-hidden-1234";

function fakeProvider(): Promise<{ server: Server; port: number; mode: { current: Mode }; seen: Seen[] }> {
  const seen: Seen[] = [];
  const mode: { current: Mode } = { current: "ok" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; } catch { /* not json */ }
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const status = mode.current === "denied" ? 401 : mode.current === "error" ? 500 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      const text = mode.current === "empty" ? "  " : "- Earlier visit: fever, treated with paracetamol. The material says nothing else.";
      res.end(JSON.stringify((req.url ?? "").includes("/v1/messages") ? { content: [{ type: "text", text }], model: "fake-model-1" } : { text, model: "fake-http-1" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, mode, seen })));
}

describe("AI assistant: what is sent and how text is cleaned", () => {
  const patient: PatientFacts = { ageYears: 34, sex: "FEMALE", allergies: [{ allergen: "Penicillin", severity: "SEVERE", reaction: "Rash on Zubeida's arms" }], names: ["Zubeida Quraishi", "Anwar Quraishi"] };
  const visit = (over: Partial<VisitFacts> = {}): VisitFacts => ({ when: "2026-10-01", complaint: "Zubeida has fever, phone 98765 43210, mail z@example.org, record DEMO-000123", advice: "Rest", diagnoses: ["Viral fever"], medicines: [{ name: "Crocin 500 mg", dose: "1 tablet", frequency: "TDS", days: 3, food: "AFTER_FOOD", note: null }], ...over });

  it("takes out names, phone numbers, e-mail addresses, record numbers and long digit strings", () => {
    const out = scrub("Zubeida and Anwar Quraishi, call +91 98765 43210 or 9876543210, z@example.org, MRN DEMO-000123, Aadhaar 123456789012, BP 120/80", patient.names);
    for (const gone of ["Zubeida", "Anwar", "Quraishi", "98765", "9876543210", "z@example.org", "DEMO-000123", "123456789012"]) assert.ok(!out.includes(gone), `${gone} is gone`);
    assert.ok(out.includes("BP 120/80"), "clinical numbers stay");
    assert.ok(out.includes("[name]") && out.includes("[phone]") && out.includes("[email]") && out.includes("[number]"));
    assert.equal(scrub("Take Ann's medicine", ["Ann"]), "Take [name]'s medicine", "short names are cleaned too, whole words only");
    assert.equal(scrub("Annual check", ["Ann"]), "Annual check", "not part of another word");
  });

  it("the material has the age, sex and allergies, never a name, and is cut to the size limit by dropping the oldest visit", () => {
    const text = historyMaterial(patient, [visit(), visit({ when: "2026-09-01" })]);
    assert.ok(text.startsWith("Patient: 34 years, female. Known allergies: Penicillin (severe, Rash on [name]'s arms)."));
    for (const gone of ["Zubeida", "Quraishi", "9876", "z@example.org", "DEMO-000123"]) assert.ok(!text.includes(gone), gone);
    assert.ok(text.indexOf("Visit on 2026-10-01") < text.indexOf("Visit on 2026-09-01"), "newest first");
    const many = Array.from({ length: 40 }, (_, i) => visit({ when: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`, advice: "x".repeat(400) }));
    const big = historyMaterial(patient, many);
    assert.ok(big.length <= MAX_INPUT_CHARS, `${big.length} within the limit`);
    assert.ok(big.includes("Patient:"));
    assert.ok(adviceMaterial(patient, visit({ advice: "y".repeat(20_000) })).length <= MAX_INPUT_CHARS);
    assert.equal(historyMaterial({ ...patient, allergies: [], ageYears: null }, [visit()]).startsWith("Patient: age not recorded, female. No allergies recorded."), true);
    assert.equal(hasAdviceMaterial(visit({ diagnoses: [], medicines: [] })), false);
    assert.equal(hasAdviceMaterial(visit({ diagnoses: [] })), true);
  });

  it("every request tells the assistant not to diagnose or prescribe and to use only the material", () => {
    for (const s of [SYSTEM_HISTORY, SYSTEM_ADVICE]) {
      assert.match(s, /A doctor will read and edit everything/);
      assert.match(s, /Do not diagnose/);
      assert.match(s, /Do not suggest, add, stop or change any medicine, dose or test/);
      assert.match(s, /Use only what is in the material/);
      assert.match(s, /say it is missing instead of guessing/);
    }
  });
});

describe("AI assistant: connection, readiness, drafts and the doctor's review", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: User; let cashier: User; let bDoc: TestDoctor;
  let doc: TestDoctor; let doc2: TestDoctor;
  let fake: Awaited<ReturnType<typeof fakeProvider>>;
  const anthropicUrl = () => `http://127.0.0.1:${fake.port}/v1/messages`;
  const httpUrl = () => `http://127.0.0.1:${fake.port}/ask`;
  const config = (body: Record<string, unknown>, tok = a.admin.token) => t.api("put", "/ai/config", tok).send(body);
  const anthropic = (over: Record<string, unknown> = {}) => ({ kind: "ANTHROPIC", url: anthropicUrl(), model: "claude-test-model", apiKey: KEY, acknowledgeDataSharing: true, ...over });
  const flag = (value: boolean, tenant = a) => t.api("put", "/settings/AI_ASSISTANT_ENABLED", tenant.admin.token).send({ value });
  const ready = async () => { assert.equal((await flag(true)).status, 200); assert.equal((await config(anthropic())).status, 200); assert.equal((await t.api("post", "/ai/config/test", a.admin.token)).body.data.ok, true); };
  const draft = (enc: string, task: string, tok = doc.token) => t.api("post", `/encounters/${enc}/ai/drafts`, tok).send({ task });

  /** A patient with a signed earlier visit and a second, current visit with the doctor. */
  const patientWithHistory = async (first = "Zubeida", last = "Quraishi") => {
    const p = await registerPatient(t, rec.token, { firstName: `${first}${uniqueWord(3)}`, lastName: `${last}${uniqueWord(4)}` });
    const row = await t.prisma.patient.findFirstOrThrow({ where: { id: p.id } });
    const mobile = row.mobile!;
    const named = row.firstName;
    const v1 = await startVisit(t, rec.token, doc, p.id);
    await t.api("post", `/queue/${v1.queueId}/start`, doc.token);
    await t.api("put", `/encounters/${v1.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] });
    const n = await t.api("put", `/encounters/${v1.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: `${named} has fever for two days, call ${mobile}`, advice: "Drink plenty of fluids" } });
    await t.api("post", `/encounters/${v1.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v1.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
    await t.api("post", `/queue/${v1.queueId}/complete`, doc.token);
    // A second, current visit of the same doctor (made directly: the first visit's appointment still holds the walk-in slot).
    const enc = await t.prisma.encounter.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.id, encounterNumber: `AI-${uniqueWord(8)}`, type: "OPD", practitionerId: doc.practitionerId, departmentId: doc.departmentId, createdById: doc.userId } });
    const v2 = { encounterId: enc.id };
    return { patient: p, mobile, first: v1.encounterId, current: v2.encounterId, firstName: row.firstName, lastName: row.lastName! };
  };

  before(async () => {
    fake = await fakeProvider();
    t = await startApp();
    a = await t.makeTenant("ai-a"); b = await t.makeTenant("ai-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); cashier = await t.makeUser(a, ["CASHIER"]);
    doc = await makeDoctor(t, a); doc2 = await makeDoctor(t, a); bDoc = await makeDoctor(t, b);
  });
  after(async () => { await t.close(); fake.server.close(); });

  it("it is off to begin with, and says why; only administrators connect a provider; only doctors use it", async () => {
    const st = (await t.api("get", "/ai/status", doc.token)).body.data;
    assert.deepEqual([st.available, st.reason], [false, "The AI assistant is switched off for this hospital"]);
    for (const tok of [doc.token, rec.token, cashier.token]) {
      assert.equal((await t.api("get", "/ai/config", tok)).status, 403);
      assert.equal((await config(anthropic(), tok)).status, 403);
      assert.equal((await t.api("post", "/ai/config/test", tok)).status, 403);
      assert.equal((await t.api("delete", "/ai/config", tok)).status, 403);
    }
    for (const tok of [a.admin.token, rec.token, cashier.token]) assert.equal((await t.api("get", "/ai/status", tok)).status, 403, "only people who can use it");
    assert.equal((await t.api("get", "/ai/status")).status, 401);
    const mine = await patientWithHistory();
    const refused = await draft(mine.current, "HISTORY_SUMMARY");
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /switched off/);
    assert.equal(await t.prisma.aiDraft.count({ where: { tenantId: a.tenantId } }), 0);
  });

  it("it becomes available only when the setting is on, a provider is saved, the data sharing is confirmed and a test has passed", async () => {
    const reason = async () => (await t.api("get", "/ai/status", doc.token)).body.data as { available: boolean; reason: string | null };
    assert.equal((await flag(true)).status, 200);
    assert.match((await reason()).reason ?? "", /No AI provider is connected/);
    assert.equal((await config(anthropic({ acknowledgeDataSharing: false }))).status, 200);
    assert.match((await reason()).reason ?? "", /data sharing has not been confirmed/);
    assert.equal((await config({ kind: "ANTHROPIC", url: anthropicUrl(), model: "claude-test-model", acknowledgeDataSharing: true })).status, 200);
    assert.match((await reason()).reason ?? "", /not been tested/);
    assert.equal((await t.api("post", "/ai/config/test", a.admin.token)).body.data.ok, true);
    assert.deepEqual((await reason()).available, true);
    assert.equal((await flag(false)).status, 200);
    assert.match((await reason()).reason ?? "", /switched off/);
    assert.equal((await flag(true)).status, 200);
    assert.equal((await config(anthropic({ model: "claude-other-model", apiKey: undefined }))).status, 200);
    assert.equal((await reason()).available, false, "a different model has not been tested");
    assert.equal((await t.api("post", "/ai/config/test", a.admin.token)).body.data.ok, true);
    assert.equal((await reason()).available, true);
  });

  it("refuses a wrong setup, never gives the key back, and does not send a saved key to a different place", async () => {
    for (const bad of [{ kind: "HTTP" }, { kind: "ANTHROPIC", url: anthropicUrl() }, { kind: "OTHER", url: httpUrl() }, { kind: "HTTP", url: "http://ai.example.test/ask" }, { kind: "HTTP", url: "nonsense" }, { kind: "HTTP", url: httpUrl(), apiKey: "short" }, { kind: "HTTP", url: httpUrl(), extra: 1 }, { kind: "HTTP", url: httpUrl(), apiKey: KEY, clearKey: true }]) assert.equal((await config(bad)).status, 400, JSON.stringify(bad));
    const ok = await config(anthropic());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.hasKey, ok.body.data.keyLast4, ok.body.data.dataSharingConfirmed], [true, KEY.slice(-4), true]);
    assert.ok(!JSON.stringify(ok.body).includes(KEY) && !JSON.stringify((await t.api("get", "/ai/config", a.admin.token)).body).includes(KEY));
    const row = await t.prisma.aiConfig.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    assert.ok(row.apiKeyEnc && !row.apiKeyEnc.includes(KEY), "stored encrypted");
    const elsewhere = await config({ kind: "HTTP", url: httpUrl() });
    assert.equal(elsewhere.status, 400, "the saved key stays with the provider it was entered for");
    const moved = await config({ kind: "HTTP", url: httpUrl(), apiKey: KEY });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data.dataSharingConfirmed, false, "a new destination has to be confirmed again");
    assert.equal(moved.body.data.lastTest, null);
    assert.equal((await t.api("get", "/ai/config", b.admin.token)).body.data.connected, false, "another hospital has its own");
    assert.equal((await config(anthropic())).status, 200);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "AI_CONFIG_SAVED" } }));
  });

  it("the test reports a refused key, an error and an unreachable provider in plain words, and never repeats a reply", async () => {
    for (const [mode, text] of [["denied", /did not accept the key/], ["error", /HTTP 500/], ["empty", /gave no text/]] as [Mode, RegExp][]) {
      fake.mode.current = mode;
      const r = (await t.api("post", "/ai/config/test", a.admin.token)).body.data;
      assert.equal(r.ok, false, mode);
      assert.match(r.message, text, mode);
      assert.ok(!r.message.includes(KEY));
    }
    fake.mode.current = "ok";
    await config({ kind: "HTTP", url: "http://127.0.0.1:1/ask", apiKey: KEY });
    assert.match((await t.api("post", "/ai/config/test", a.admin.token)).body.data.message, /could not be reached/);
    await ready();
  });

  it("a history summary uses only the earlier signed visits, sends nothing that identifies the patient, and is kept as a draft that is not on the chart", async () => {
    await ready();
    const p = await patientWithHistory("Zubeida", "Quraishi");
    fake.seen.length = 0;
    const r = await draft(p.current, "HISTORY_SUMMARY");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.data.status, r.body.data.task], ["DRAFT", "HISTORY_SUMMARY"]);
    assert.match(r.body.data.text, /Earlier visit: fever/);
    assert.match(r.body.data.notice, /AI draft for the doctor to check/);
    const sent = fake.seen[fake.seen.length - 1]!;
    assert.equal(sent.path, "/v1/messages");
    assert.equal(sent.headers["x-api-key"], KEY);
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    assert.equal(sent.body["model"], "claude-test-model");
    const user = ((sent.body["messages"] as { content: string }[])[0]!).content;
    for (const gone of [p.firstName, p.lastName, p.mobile, "DEMO-"]) assert.ok(!user.includes(gone), `${gone} was not sent`);
    assert.ok(user.includes("Viral fever") && user.includes("Paracetamol 500 mg"), user);
    assert.match(String(sent.body["system"]), /Do not diagnose/);
    const row = await t.prisma.aiDraft.findFirstOrThrow({ where: { id: r.body.data.id } });
    assert.deepEqual([row.status, row.provider, row.model, row.inputChars > 50], ["DRAFT", `127.0.0.1:${fake.port}`, "fake-model-1", true]);
    const audit = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "AI_DRAFT_REQUESTED", entityId: r.body.data.id } });
    assert.ok(!JSON.stringify(audit.metadata).includes("Earlier visit"), "the audit log holds no clinical text");
    assert.equal(await t.prisma.clinicalDocument.count({ where: { encounterId: p.current } }), 0, "nothing was written to the chart");
    const noHistory = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, noHistory.id);
    const none = await draft(v.encounterId, "HISTORY_SUMMARY");
    assert.equal(none.status, 409);
    assert.match(none.body.error.message, /no earlier signed visits/);
  });

  it("advice is drafted from the visit as it stands; with nothing to go on it asks the doctor to add a diagnosis or prescription first", async () => {
    await ready();
    const p = await patientWithHistory("Farida", "Khatun");
    const empty = await draft(p.current, "VISIT_ADVICE");
    assert.equal(empty.status, 409);
    assert.match(empty.body.error.message, /Add a diagnosis or a prescription/);
    await t.api("post", `/encounters/${p.current}/diagnoses`, doc.token).send({ text: "Acute gastritis", type: "PROVISIONAL" });
    await t.api("put", `/encounters/${p.current}/prescription`, doc.token).send({ items: [{ genericName: "Pantoprazole", strength: "40 mg", dosage: "1 tablet", route: "ORAL", frequency: "OD", durationDays: 5, foodRelation: "EMPTY_STOMACH" }] });
    fake.seen.length = 0;
    const r = await draft(p.current, "VISIT_ADVICE");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const user = ((fake.seen[fake.seen.length - 1]!.body["messages"] as { content: string }[])[0]!).content;
    assert.ok(user.includes("Acute gastritis") && user.includes("Pantoprazole 40 mg") && !user.includes("Farida") && !user.includes("Khatun"), user);
    assert.match(String(fake.seen[fake.seen.length - 1]!.body["system"]), /patient in simple language/);
  });

  it("a doctor drafts only for their own visits; other roles and other hospitals cannot", async () => {
    await ready();
    const p = await patientWithHistory();
    assert.equal((await draft(p.current, "HISTORY_SUMMARY", doc2.token)).status, 404, "another doctor's patient");
    assert.equal((await draft(p.current, "HISTORY_SUMMARY", rec.token)).status, 403);
    assert.ok([404, 409].includes((await draft(p.current, "HISTORY_SUMMARY", bDoc.token)).status), "another hospital: refused (its own assistant is not on, and the visit is not theirs)");
    assert.equal((await draft(randomUUID(), "HISTORY_SUMMARY")).status, 404);
    assert.equal((await draft(p.current, "DIAGNOSE")).status, 400, "there is no task that diagnoses");
    assert.equal((await t.api("post", `/encounters/${p.current}/ai/drafts`, doc.token).send({ task: "VISIT_ADVICE", extra: 1 })).status, 400);
    assert.equal((await t.api("get", `/encounters/${p.current}/ai/drafts`, doc2.token)).status, 404);
  });

  it("a provider that fails gives a plain message and no draft; a generic HTTP service works too", async () => {
    await ready();
    const p = await patientWithHistory();
    const before = await t.prisma.aiDraft.count({ where: { tenantId: a.tenantId } });
    for (const [mode, text] of [["denied", /did not accept the key/], ["error", /HTTP 500/], ["empty", /gave no text/]] as [Mode, RegExp][]) {
      fake.mode.current = mode;
      const r = await draft(p.current, "HISTORY_SUMMARY");
      assert.equal(r.status, 502, mode);
      assert.match(r.body.error.message, text, mode);
    }
    fake.mode.current = "ok";
    assert.equal(await t.prisma.aiDraft.count({ where: { tenantId: a.tenantId } }), before, "no draft was kept");
    assert.equal((await config({ kind: "HTTP", url: httpUrl(), apiKey: KEY, acknowledgeDataSharing: true })).status, 200);
    assert.equal((await t.api("post", "/ai/config/test", a.admin.token)).body.data.ok, true);
    fake.seen.length = 0;
    const r = await draft(p.current, "HISTORY_SUMMARY");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sent = fake.seen[fake.seen.length - 1]!;
    assert.deepEqual([sent.path, sent.headers["authorization"], Object.keys(sent.body).sort()], ["/ask", `Bearer ${KEY}`, ["maxTokens", "system", "user"]]);
    assert.equal((await t.prisma.aiDraft.findFirstOrThrow({ where: { id: r.body.data.id } })).model, "fake-http-1");
  });

  it("the doctor's review is recorded once, only by the doctor who asked; the doctor sees only their own drafts", async () => {
    await ready();
    const p = await patientWithHistory();
    const d1 = (await draft(p.current, "HISTORY_SUMMARY")).body.data;
    const d2 = (await draft(p.current, "HISTORY_SUMMARY")).body.data;
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, doc2.token).send({ decision: "USED" })).status, 404, "another doctor's draft");
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, bDoc.token).send({ decision: "USED" })).status, 404);
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, rec.token).send({ decision: "USED" })).status, 403);
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, doc.token).send({ decision: "MAYBE" })).status, 400);
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, doc.token).send({ decision: "USED", edited: true })).status, 200);
    assert.equal((await t.api("post", `/ai/drafts/${d1.id}/review`, doc.token).send({ decision: "DISCARDED" })).status, 409, "already reviewed");
    assert.equal((await t.api("post", `/ai/drafts/${d2.id}/review`, doc.token).send({ decision: "DISCARDED" })).status, 200);
    const list = (await t.api("get", `/encounters/${p.current}/ai/drafts`, doc.token)).body.data as { id: string; status: string; edited: boolean }[];
    assert.deepEqual(list.map((x) => [x.id, x.status, x.edited]).sort(), [[d1.id, "USED", true], [d2.id, "DISCARDED", false]].sort());
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "AI_DRAFT_REVIEWED", entityId: d1.id } }));
  });

  it("DATABASE: what the AI wrote is never changed or deleted; a reviewed draft stays as it was", async () => {
    await ready();
    const p = await patientWithHistory();
    const d = (await draft(p.current, "HISTORY_SUMMARY")).body.data;
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AiDraft" SET "outputText" = 'changed' WHERE id = '${d.id}'::uuid`), /cannot be changed/);
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "AiDraft" WHERE id = '${d.id}'::uuid`), /cannot be deleted/);
    await t.api("post", `/ai/drafts/${d.id}/review`, doc.token).send({ decision: "USED" });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "AiDraft" SET status = 'DISCARDED' WHERE id = '${d.id}'::uuid`), /reviewed AI draft cannot change/);
  });

  it("a doctor can ask only so often an hour", async () => {
    await ready();
    const p = await patientWithHistory();
    const user = await t.prisma.user.findFirstOrThrow({ where: { id: doc.userId } });
    const seed = await t.prisma.aiDraft.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    const have = await t.prisma.aiDraft.count({ where: { tenantId: a.tenantId, requestedById: user.id, requestedAt: { gt: new Date(Date.now() - 3_600_000) } } });
    for (let i = have; i < 20; i++) await t.prisma.aiDraft.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: seed.patientId, encounterId: seed.encounterId, task: "HISTORY_SUMMARY", outputText: "seed", inputChars: 1, provider: "seed", requestedById: user.id } });
    const r = await draft(p.current, "HISTORY_SUMMARY");
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /20 times in the last hour/);
  });
});
