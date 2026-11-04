import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { readOcrResponse } from "./ocr.provider";
import { parsePrescriptionLines } from "./scan-parse";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HANDWRITING = "Tab Paracetamol 500mg 1-0-1 x 5 days\nCap Amoxicillin 250 mg TDS for 1 week\nDrink plenty of water";

type Mode = "ok" | "error" | "slow" | "garbage" | "empty";
interface Seen { auth: string | undefined; body: { fileName?: string; contentType?: string; contentBase64?: string } }

/** A stand-in OCR service that answers as told and records what it was sent. */
function fakeOcr(): Promise<{ server: Server; url: string; seen: Seen[]; mode: { current: Mode } }> {
  const seen: Seen[] = [];
  const mode: { current: Mode } = { current: "ok" };
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (mode.current === "error") return send(500, { message: "boom with secrets" });
      if (mode.current === "garbage") return send(200, { hello: "world" });
      if (mode.current === "empty") return send(200, { text: "   " });
      if (mode.current === "slow") return void setTimeout(() => send(200, { text: HANDWRITING }), 3000);
      return send(200, { text: HANDWRITING, confidence: 0.87 });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/read`, seen, mode })));
}

describe("reading handwriting: the text parser and the OCR answer shapes", () => {
  it("suggests medicine lines with strength, frequency and days, and ignores everything else", () => {
    const s = parsePrescriptionLines(HANDWRITING);
    assert.equal(s.length, 2);
    assert.deepEqual([s[0]?.name, s[0]?.strength, s[0]?.form, s[0]?.frequency, s[0]?.durationDays], ["Paracetamol", "500mg", "TABLET", "BD", 5]);
    assert.deepEqual([s[1]?.name, s[1]?.strength, s[1]?.form, s[1]?.frequency, s[1]?.durationDays], ["Amoxicillin", "250mg", "CAPSULE", "TDS", 7]);
  });
  it("reads 1-0-0, 0-0-1, 1-1-1-1 patterns and words", () => {
    const f = (t: string) => parsePrescriptionLines(t)[0]?.frequency;
    assert.equal(f("Tab Aspirin 75mg 1-0-0"), "OD");
    assert.equal(f("Tab Zolpidem 5mg 0-0-1"), "HS");
    assert.equal(f("Tab Drug 10mg 1-1-1-1"), "QID");
    assert.equal(f("Tab Drug 10mg 1-1-1"), "TDS");
    assert.equal(f("Tab Drug 10mg SOS"), "SOS");
    assert.equal(f("1) Syp Cough 5ml twice daily"), "BD");
  });
  it("reads dose, food timing and what is left as instructions", () => {
    const [a, b, c] = parsePrescriptionLines("Tab Pantoprazole 40mg 1-0-0 before food x 14 days\nSyp Cough Syrup 5ml twice daily after meals, shake well\nInj Ceftriaxone 1g BD x 3 days");
    assert.deepEqual([a?.name, a?.dosage, a?.foodRelation, a?.frequency, a?.durationDays, a?.route], ["Pantoprazole", "1 tablet", "BEFORE_FOOD", "OD", 14, "ORAL"]);
    assert.deepEqual([b?.name, b?.dosage, b?.foodRelation, b?.frequency, b?.instructions], ["Cough Syrup", "5 ml", "AFTER_FOOD", "BD", "shake well"]);
    assert.deepEqual([c?.form, c?.route, c?.dosage], ["INJECTION", "IM", "1 ampoule"]);
  });
  it("reads the quantity when the handwriting gives one, and does not confuse it with days or dose", () => {
    const [a, b, c, d] = parsePrescriptionLines("Tab Paracetamol 500mg 1-1-1 x 5 days qty 15\nCap Omeprazole 20mg OD #14\nTab Metformin 500mg BD (60 tabs)\nTab Zinc 50mg OD x 10 tabs");
    assert.deepEqual([a?.quantity, a?.durationDays, a?.dosage], [15, 5, "1 tablet"]);
    assert.deepEqual([b?.quantity, b?.name], [14, "Omeprazole"]);
    assert.equal(c?.quantity, 60);
    assert.equal(d?.quantity, 10);
    assert.equal(parsePrescriptionLines("Tab Cetirizine 10mg 0-0-1 x 5 days")[0]?.quantity, undefined);
  });
  it("never turns sentences or numbers into medicines", () => {
    assert.deepEqual(parsePrescriptionLines("Patient to rest.\nReview after 3 days\n12/10/2026\nBP 120/80"), []);
    assert.deepEqual(parsePrescriptionLines(""), []);
    assert.ok(parsePrescriptionLines("Tab X\n".repeat(200)).length <= 30);
  });
  it("understands the common OCR answers and nothing else", () => {
    assert.deepEqual(readOcrResponse({ text: "abc", confidence: 0.5 }), { text: "abc", confidence: 0.5 });
    assert.deepEqual(readOcrResponse({ text: "abc", confidence: 7 }), { text: "abc", confidence: null });
    assert.equal(readOcrResponse({ lines: ["a", { text: "b" }, 3] })?.text, "a\nb");
    assert.equal(readOcrResponse({ data: { text: "deep" } })?.text, "deep");
    assert.equal(readOcrResponse({ responses: [{ fullTextAnnotation: { text: "vision" } }] })?.text, "vision");
    assert.equal(readOcrResponse({ nothing: true }), null);
    assert.equal(readOcrResponse("text"), null);
    assert.equal(readOcrResponse(null), null);
  });
});

describe("handwritten prescriptions with an OCR service", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let ocr: Awaited<ReturnType<typeof fakeOcr>>;
  let rec: { id: string; token: string };
  let doc: TestDoctor;
  let bDoc: TestDoctor;
  let encounterId: string;
  let bEncounterId: string;
  const upload = (tok: string, enc: string, filename = "rx.png", type = "image/png", body: Buffer = PNG) => t.api("post", `/encounters/${enc}/prescription-scans`, tok).query({ filename }).set("Content-Type", type).send(body);
  const setting = (key: string, value: boolean, tok = a.admin.token) => t.api("put", `/settings/${key}`, tok).send({ value });

  before(async () => {
    ocr = await fakeOcr();
    process.env["OCR_PROVIDER"] = "http";
    process.env["OCR_API_URL"] = ocr.url;
    process.env["OCR_API_KEY"] = "test-ocr-key";
    process.env["OCR_TIMEOUT_MS"] = "1000";
    t = await startApp();
    a = await t.makeTenant("scan-a");
    b = await t.makeTenant("scan-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    bDoc = await makeDoctor(t, b);
    const brec = await t.makeUser(b, ["RECEPTIONIST"]);
    encounterId = (await startVisit(t, rec.token, doc, (await registerPatient(t, rec.token)).id)).encounterId;
    bEncounterId = (await startVisit(t, brec.token, bDoc, (await registerPatient(t, brec.token)).id)).encounterId;
  });
  after(async () => {
    await t.close();
    ocr.server.close();
    for (const k of ["OCR_PROVIDER", "OCR_API_URL", "OCR_API_KEY", "OCR_TIMEOUT_MS"]) delete process.env[k];
  });

  it("is off until the hospital switches it on", async () => {
    const c = await t.api("get", "/prescription-scans/config", doc.token);
    assert.deepEqual(c.body.data, { uploadEnabled: false, ocrEnabled: false, ocrConnected: true });
    const r = await upload(doc.token, encounterId);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "FEATURE_DISABLED");
    assert.equal(ocr.seen.length, 0, "nothing was sent anywhere");
    assert.equal((await setting("PRESCRIPTION_UPLOAD_ENABLED", true, doc.token)).status, 403, "a doctor cannot switch it on");
    assert.equal((await setting("PRESCRIPTION_UPLOAD_ENABLED", true)).status, 200);
  });

  it("uploading without reading: the image is kept and the doctor types the text", async () => {
    const r = await upload(doc.token, encounterId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "UPLOADED");
    assert.equal(r.body.data.text, null);
    assert.equal(ocr.seen.length, 0, "OCR is separate and still off, so the image went nowhere");
    assert.equal((await t.api("post", `/prescription-scans/${r.body.data.id}/approve`, doc.token).send({})).status, 409, "nothing to approve without saved lines");
    assert.equal((await t.api("post", `/prescription-scans/${r.body.data.id}/extract`, doc.token)).status, 403, "reading is not switched on");
    const typed = await t.api("put", `/prescription-scans/${r.body.data.id}/correction`, doc.token).send({ text: "Tab Cetirizine 10mg 0-0-1 x 5 days" });
    assert.equal(typed.status, 200);
    assert.equal(typed.body.data.text, "Tab Cetirizine 10mg 0-0-1 x 5 days");
    assert.equal(typed.body.data.ocr.text, null);
    assert.equal(typed.body.data.suggestions[0].frequency, "HS");
    const items = [{ genericName: "Cetirizine", strength: "10mg", dosage: "1 tablet", route: "ORAL", frequency: "HS", durationDays: 5 }];
    assert.equal((await t.api("put", `/prescription-scans/${r.body.data.id}/lines`, doc.token).send({ items })).status, 200);
    const ok = await t.api("post", `/prescription-scans/${r.body.data.id}/approve`, doc.token).send({});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.data.approved.prescriptionNumber);
  });

  it("with OCR on, the image is sent with the key and the text comes back as a draft", async () => {
    assert.equal((await setting("PRESCRIPTION_OCR_ENABLED", true)).status, 200);
    const r = await upload(doc.token, encounterId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.data;
    assert.deepEqual([d.status, d.ocr.provider, d.ocr.text, d.ocr.confidence, d.ocr.attempts, d.approved], ["OCR_DONE", "http", HANDWRITING, 0.87, 1, null]);
    assert.equal(d.suggestions.length, 2);
    const sent = ocr.seen.at(-1)!;
    assert.equal(sent.auth, "Bearer test-ocr-key");
    assert.deepEqual([sent.body.fileName, sent.body.contentType, Buffer.from(sent.body.contentBase64 ?? "", "base64").equals(PNG)], ["rx.png", "image/png", true]);
    assert.ok(!JSON.stringify(d).includes("test-ocr-key"));
    const file = await t.prisma.patientFile.findFirstOrThrow({ where: { id: d.file.id } });
    assert.equal(file.title, "Handwritten prescription");
    const done = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_SCAN_OCR_DONE", entityId: d.id } });
    assert.ok(!JSON.stringify(done.metadata).includes("Paracetamol"), "the text itself is not copied into the audit trail");
  });

  it("the OCR text is never overwritten: corrections and lines sit beside it, and nothing changes after approval", async () => {
    const d = (await upload(doc.token, encounterId)).body.data;
    assert.equal((await t.api("post", `/prescription-scans/${d.id}/extract`, doc.token)).status, 409, "already read");
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScan" SET "ocrText" = 'changed' WHERE id = '${d.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PrescriptionScan" WHERE id = '${d.id}'::uuid`));
    const fixed = await t.api("put", `/prescription-scans/${d.id}/correction`, doc.token).send({ text: "Tab Paracetamol 650mg 1-1-1 x 3 days" });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.data.ocr.text, HANDWRITING, "what OCR read is untouched");
    assert.equal(fixed.body.data.text, "Tab Paracetamol 650mg 1-1-1 x 3 days");
    assert.equal((await t.api("put", `/prescription-scans/${d.id}/correction`, doc.token).send({ text: "" })).status, 400);
    assert.equal((await t.api("put", `/prescription-scans/${d.id}/correction`, doc.token).send({ text: "x", other: 1 })).status, 400);
    const items = [{ genericName: "Paracetamol", strength: "650mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3, foodRelation: "AFTER_FOOD", instructions: "If fever" }];
    assert.equal((await t.api("put", `/prescription-scans/${d.id}/lines`, doc.token).send({ items })).status, 200);
    const approved = await t.api("post", `/prescription-scans/${d.id}/approve`, doc.token).send({});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(approved.body.data.approved.at && approved.body.data.approved.by);
    assert.equal((await t.api("post", `/prescription-scans/${d.id}/approve`, doc.token).send({})).status, 409, "already approved");
    assert.equal((await t.api("put", `/prescription-scans/${d.id}/correction`, doc.token).send({ text: "Tab Other 5mg OD" })).status, 409, "frozen after approval");
    assert.equal((await t.api("put", `/prescription-scans/${d.id}/lines`, doc.token).send({ items })).status, 409);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScan" SET lines = '[]'::jsonb WHERE id = '${d.id}'::uuid`));
    const actions = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: d.id }, select: { action: true } })).map((e) => e.action);
    for (const x of ["PRESCRIPTION_SCAN_UPLOADED", "PRESCRIPTION_SCAN_OCR_DONE", "PRESCRIPTION_SCAN_CORRECTED", "PRESCRIPTION_SCAN_LINES_SAVED", "PRESCRIPTION_SCAN_APPROVED"]) assert.ok(actions.includes(x), x);
  });

  it("when the OCR service fails, the upload still works and reading can be tried again", async () => {
    ocr.mode.current = "error";
    const r = await upload(doc.token, encounterId);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, "OCR_FAILED");
    assert.match(r.body.data.ocr.error, /HTTP 500/);
    assert.ok(!JSON.stringify(r.body).includes("secrets"), "the service's own message is not passed on");
    assert.equal((await t.api("post", `/prescription-scans/${r.body.data.id}/approve`, doc.token).send({})).status, 409);
    ocr.mode.current = "garbage";
    const again = await t.api("post", `/prescription-scans/${r.body.data.id}/extract`, doc.token);
    assert.equal(again.status, 200);
    assert.match(again.body.data.ocr.error, /format/);
    assert.equal(again.body.data.ocr.attempts, 2);
    ocr.mode.current = "empty";
    assert.match((await t.api("post", `/prescription-scans/${r.body.data.id}/extract`, doc.token)).body.data.ocr.error, /could not read any text/);
    ocr.mode.current = "ok";
    const good = await t.api("post", `/prescription-scans/${r.body.data.id}/extract`, doc.token);
    assert.deepEqual([good.body.data.status, good.body.data.ocr.attempts, good.body.data.ocr.error, good.body.data.ocr.text], ["OCR_DONE", 4, null, HANDWRITING]);
    const failed = await t.prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_SCAN_OCR_FAILED", entityId: r.body.data.id } });
    assert.equal(failed, 3);
  });

  it("a slow OCR service times out instead of hanging the upload", async () => {
    ocr.mode.current = "slow";
    const started = Date.now();
    const r = await upload(doc.token, encounterId);
    ocr.mode.current = "ok";
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, "OCR_FAILED");
    assert.match(r.body.data.ocr.error, /in time/);
    assert.ok(Date.now() - started < 2800, "gave up at the timeout");
  });

  it("lists the scans of a visit, newest first", async () => {
    const l = await t.api("get", `/encounters/${encounterId}/prescription-scans`, doc.token);
    assert.equal(l.status, 200);
    assert.ok(l.body.data.length >= 5);
    const times = (l.body.data as { uploadedAt: string }[]).map((x) => x.uploadedAt);
    assert.deepEqual([...times].sort().reverse(), times);
  });

  it("a prescription can have several pages: each is read, the text is the pages in order, and pages stop once it is approved", async () => {
    const first = (await upload(doc.token, encounterId)).body.data;
    const addPage = (tok: string, scanId: string, enc = encounterId, body: Buffer = PNG, type = "image/png") => t.api("post", `/encounters/${enc}/prescription-scans`, tok).query({ filename: "page.png", scanId }).set("Content-Type", type).send(body);
    ocr.seen.length = 0;
    const two = await addPage(doc.token, first.id);
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.deepEqual(two.body.data.pages.map((x: { pageNo: number; status: string }) => [x.pageNo, x.status]), [[1, "OCR_DONE"], [2, "OCR_DONE"]]);
    assert.equal(two.body.data.ocr.text, `${HANDWRITING}
${HANDWRITING}`, "the pages in order");
    assert.equal(ocr.seen.length, 1, "only the new page was sent");
    assert.equal(two.body.data.needsReading, false);
    assert.equal(two.body.data.suggestions.length, 4);
    assert.equal(two.body.data.id, first.id, "one prescription, not two");
    // A page the service cannot read does not lose the others and can be read again.
    ocr.mode.current = "error";
    const three = await addPage(doc.token, first.id);
    assert.equal(three.body.data.pages[2].status, "OCR_FAILED");
    assert.equal(three.body.data.needsReading, true);
    assert.equal(three.body.data.ocr.text, `${HANDWRITING}
${HANDWRITING}`);
    ocr.mode.current = "ok";
    ocr.seen.length = 0;
    const again = await t.api("post", `/prescription-scans/${first.id}/extract`, doc.token);
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.data.needsReading, ocr.seen.length], [false, 1], "only the unread page is read again");
    assert.equal((await t.api("post", `/prescription-scans/${first.id}/extract`, doc.token)).status, 409, "nothing left to read");
    // The doctor's own text covers all pages; a page added later is flagged.
    assert.equal((await t.api("put", `/prescription-scans/${first.id}/correction`, doc.token).send({ text: "Tab Zinc 50mg OD x 10 days" })).body.data.correctedStale, false);
    assert.equal((await addPage(doc.token, first.id)).body.data.correctedStale, true);
    for (let n = 5; n <= 10; n++) assert.equal((await addPage(doc.token, first.id)).status, 201, `page ${n}`);
    const full = await addPage(doc.token, first.id);
    assert.equal(full.status, 409, "ten pages at most");
    const listed = (await t.api("get", `/encounters/${encounterId}/prescription-scans`, doc.token)).body.data as { id: string; pages: unknown[] }[];
    assert.equal(listed.find((x) => x.id === first.id)?.pages.length, 10);
    // Not another visit's, another hospital's, or a fake file.
    assert.equal((await addPage(doc.token, first.id, bEncounterId)).status, 404);
    assert.ok([403, 404].includes((await addPage(bDoc.token, first.id)).status), "another hospital: refused (its own switch may be off) or not found");
    assert.equal((await addPage(doc.token, first.id, encounterId, Buffer.from("not a picture"))).status >= 400, true);
    assert.equal((await addPage(rec.token, first.id)).status, 403);
    // Pages and what they read cannot be rewritten or deleted.
    const page = await t.prisma.prescriptionScanPage.findFirstOrThrow({ where: { scanId: first.id, pageNo: 2 } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScanPage" SET "ocrText" = 'changed' WHERE id = '${page.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PrescriptionScanPage" WHERE id = '${page.id}'::uuid`));
    // After approval no page can be added.
    const items = [{ genericName: "Zinc", strength: "50mg", dosage: "1 tablet", route: "ORAL", frequency: "OD", durationDays: 10, quantity: 10 }];
    assert.equal((await t.api("put", `/prescription-scans/${first.id}/lines`, doc.token).send({ items })).status, 200);
    assert.equal((await t.api("post", `/prescription-scans/${first.id}/approve`, doc.token).send({})).status, 200);
    const other = (await upload(doc.token, encounterId)).body.data;
    assert.equal((await addPage(doc.token, first.id)).status, 409, "approved: upload it as a new prescription");
    assert.equal((await addPage(doc.token, other.id)).status, 201, "another, unapproved prescription still takes pages");
  });

  it("only files the system can store: pictures and PDFs", async () => {
    const txt = await t.api("post", `/encounters/${encounterId}/prescription-scans`, doc.token).query({ filename: "rx.txt" }).set("Content-Type", "text/plain").send("hello");
    assert.ok(txt.status >= 400 && txt.status < 500, String(txt.status));
    const lie = await upload(doc.token, encounterId, "rx.png", "image/png", Buffer.from("this is not a picture"));
    assert.ok(lie.status >= 400 && lie.status < 500, "the contents are checked, not just the label");
    assert.equal((await t.api("post", `/encounters/${encounterId}/prescription-scans`, doc.token).set("Content-Type", "image/png").send(PNG)).status, 400, "a file name is needed");
  });

  it("who may do what", async () => {
    assert.equal((await upload(rec.token, encounterId)).status, 403, "reception cannot attach clinical documents");
    assert.equal((await t.api("post", `/encounters/${encounterId}/prescription-scans`).set("Content-Type", "image/png").send(PNG)).status, 401);
    const reader = await makeUserWithPermissions(t, a, ["CONSULTATION_READ"]);
    assert.equal((await t.api("get", `/encounters/${encounterId}/prescription-scans`, reader.token)).status, 200, "may read");
    assert.equal((await upload(reader.token, encounterId)).status, 403, "but not add");
    assert.equal((await t.api("get", `/encounters/${encounterId}/prescription-scans`, rec.token)).status, 403);
    const scan = (await t.api("get", `/encounters/${encounterId}/prescription-scans`, doc.token)).body.data[0];
    for (const [m, p, body] of [["post", `/prescription-scans/${scan.id}/extract`, {}], ["put", `/prescription-scans/${scan.id}/correction`, { text: "x" }], ["post", `/prescription-scans/${scan.id}/approve`, {}], ["put", `/prescription-scans/${scan.id}/lines`, { items: [] }]] as const) {
      assert.equal((await t.api(m, p, reader.token).send(body)).status, 403, p);
      assert.equal((await t.api(m, p, rec.token).send(body)).status, 403, p);
    }
  });

  it("another hospital cannot see, read, correct or approve them, and cannot attach one to this hospital's visit", async () => {
    await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", b.admin.token).send({ value: true });
    const scan = (await t.api("get", `/encounters/${encounterId}/prescription-scans`, doc.token)).body.data[0];
    assert.equal((await upload(bDoc.token, encounterId)).status, 404);
    assert.equal((await t.api("get", `/encounters/${encounterId}/prescription-scans`, bDoc.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-scans/${scan.id}/extract`, bDoc.token)).status, 403, "their OCR is not on");
    await t.api("put", "/settings/PRESCRIPTION_OCR_ENABLED", b.admin.token).send({ value: true });
    assert.equal((await t.api("post", `/prescription-scans/${scan.id}/extract`, bDoc.token)).status, 404);
    assert.equal((await t.api("put", `/prescription-scans/${scan.id}/correction`, bDoc.token).send({ text: "hacked" })).status, 404);
    assert.equal((await t.api("post", `/prescription-scans/${scan.id}/approve`, bDoc.token).send({})).status, 404);
    const mine = await upload(bDoc.token, bEncounterId);
    assert.equal(mine.status, 201);
    assert.equal((await t.api("get", `/encounters/${bEncounterId}/prescription-scans`, doc.token)).status, 404);
    assert.equal((await t.api("post", `/prescription-scans/${mine.body.data.id}/approve`, doc.token).send({})).status, 404);
    assert.equal((await t.api("post", `/prescription-scans/not-a-uuid/approve`, doc.token).send({})).status, 404);
    assert.equal(((await t.api("get", "/prescription-scans/config", bDoc.token)).body.data as { ocrEnabled: boolean }).ocrEnabled, true);
  });
});

describe("handwritten prescriptions with no OCR service connected", () => {
  let t: TestApp;
  let a: TestTenant;
  let doc: TestDoctor;
  before(async () => {
    process.env["OCR_PROVIDER"] = "none";
    t = await startApp();
    a = await t.makeTenant("scan-n");
    const rec = await t.makeUser(a, ["RECEPTIONIST"]);
    doc = await makeDoctor(t, a);
    (doc as TestDoctor & { enc?: string }).enc = (await startVisit(t, rec.token, doc, (await registerPatient(t, rec.token)).id)).encounterId;
    await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true });
    await t.api("put", "/settings/PRESCRIPTION_OCR_ENABLED", a.admin.token).send({ value: true });
  });
  after(async () => { await t.close(); delete process.env["OCR_PROVIDER"]; });

  it("says so, keeps the image, and lets the doctor type the text", async () => {
    assert.equal(((await t.api("get", "/prescription-scans/config", doc.token)).body.data as { ocrConnected: boolean }).ocrConnected, false);
    const enc = (doc as TestDoctor & { enc?: string }).enc;
    const r = await t.api("post", `/encounters/${enc}/prescription-scans`, doc.token).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "OCR_NOT_CONFIGURED");
    assert.match(r.body.data.ocr.error, /No OCR service/);
    const typed = await t.api("put", `/prescription-scans/${r.body.data.id}/correction`, doc.token).send({ text: "Tab Metformin 500mg 1-0-1 x 30 days" });
    assert.equal(typed.body.data.suggestions[0].name, "Metformin");
    const items = [{ genericName: "Metformin", strength: "500mg", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 30 }];
    assert.equal((await t.api("put", `/prescription-scans/${r.body.data.id}/lines`, doc.token).send({ items })).status, 200);
    assert.equal((await t.api("post", `/prescription-scans/${r.body.data.id}/approve`, doc.token).send({})).status, 200);
  });
});
