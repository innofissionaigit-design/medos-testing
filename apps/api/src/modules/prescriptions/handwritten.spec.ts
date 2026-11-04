import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeClinicianWith, makeDoctor, makeUserWithPermissions, registerPatient, startApp, startVisit, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("handwritten prescription: upload after the consultation, doctor approval, pharmacy", () => {
  let t: TestApp;
  let a: TestTenant;
  let rec: { id: string; token: string };
  let pharm: { id: string; token: string };
  let b: TestTenant;
  let doc: TestDoctor;
  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const upload = (tok: string, enc: string) => t.api("post", `/encounters/${enc}/prescription-scans`, tok).query({ filename: "rx.png" }).set("Content-Type", "image/png").send(PNG);
  const lines = (tok: string, scan: string, items: unknown[]) => t.api("put", `/prescription-scans/${scan}/lines`, tok).send({ items });
  const approve = (tok: string, scan: string, body: Record<string, unknown> = {}) => t.api("post", `/prescription-scans/${scan}/approve`, tok).send(body);
  const ITEM = { genericName: "Cetirizine", strength: "10 mg", dosage: "1 tablet", route: "ORAL", frequency: "HS", durationDays: 5, foodRelation: "AFTER_FOOD", instructions: "Avoid driving" };

  /** A visit whose consultation is signed and completed, with its own digital prescription. */
  const completedVisit = async (withRx = true) => {
    const patient = await registerPatient(t, rec.token);
    const v = await startVisit(t, rec.token, doc, patient.id);
    await t.api("post", `/queue/${v.queueId}/start`, doc.token);
    if (withRx) assert.equal((await t.api("put", `/encounters/${v.encounterId}/prescription`, doc.token).send({ items: [{ genericName: "Paracetamol", strength: "500 mg", dosage: "1 tablet", route: "ORAL", frequency: "TDS", durationDays: 3 }] })).status, 200);
    const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, doc.token).send({ content: { chiefComplaint: "Fever for two days" } });
    await t.api("post", `/encounters/${v.encounterId}/diagnoses`, doc.token).send({ text: "Viral fever", type: "PROVISIONAL" });
    assert.equal((await t.api("post", `/encounters/${v.encounterId}/consultation/sign`, doc.token).send({ version: n.body.data.version })).status, 200);
    assert.equal((await t.api("post", `/queue/${v.queueId}/complete`, doc.token)).status, 200);
    return { patient, ...v };
  };

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("hw-a");
    b = await t.makeTenant("hw-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    pharm = await t.makeUser(a, ["PHARMACIST"]);
    doc = await makeDoctor(t, a);
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true })).status, 200);
  });
  after(async () => { await t.close(); });

  it("a doctor can upload the handwritten prescription after the consultation is signed and the visit is completed", async () => {
    const v = await completedVisit();
    const r = await upload(doc.token, v.encounterId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.approved, null);
    assert.deepEqual(r.body.data.lines, []);
  });

  it("with a handwritten picture uploaded the doctor can sign straight away; without one the complaint and a diagnosis are still required", async () => {
    // Each visit has its own doctor, so one open consultation never blocks another.
    const open = async () => {
      const d = await makeDoctor(t, a);
      const patient = await registerPatient(t, rec.token);
      const v = await startVisit(t, rec.token, d, patient.id);
      assert.equal((await t.api("post", `/queue/${v.queueId}/start`, d.token)).status, 200);
      const n = await t.api("put", `/encounters/${v.encounterId}/consultation`, d.token).send({ content: {} });
      assert.equal(n.status, 200, JSON.stringify(n.body));
      return { d, v, version: n.body.data.version as number };
    };
    const sign = (x: { d: TestDoctor; v: { encounterId: string } }, version: number) => t.api("post", `/encounters/${x.v.encounterId}/consultation/sign`, x.d.token).send({ version });
    // No picture: refused, and nothing is signed.
    const none = await open();
    const refused = await sign(none, none.version);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /chief complaint/);
    // Picture uploaded: signed at once with an empty note.
    const ok = await open();
    const scan = (await upload(ok.d.token, ok.v.encounterId)).body.data;
    const signed = await sign(ok, ok.version);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const stored = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: ok.v.encounterId, kind: "CONSULTATION" } });
    assert.deepEqual([stored.status, stored.currentVersion], ["SIGNED", 1]);
    assert.equal((await t.api("post", `/queue/${ok.v.queueId}/complete`, ok.d.token)).status, 200, "the visit can be completed");
    assert.ok((await t.api("get", "/pharmacy/handwritten", pharm.token)).body.data.some((x: { id: string }) => x.id === scan.id), "the pharmacy still has the picture");
    // A picture the pharmacy sent back no longer counts.
    const back = await open();
    const bad = (await upload(back.d.token, back.v.encounterId)).body.data;
    assert.equal((await t.api("post", `/pharmacy/handwritten/${bad.id}/reject`, pharm.token).send({ reason: "Page is blurred" })).status, 200);
    assert.equal((await sign(back, back.version)).status, 400);
  });

  it("nothing reaches the pharmacy until a doctor approves: text and saved lines are only drafts", async () => {
    const v = await completedVisit(false);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    assert.equal((await t.api("put", `/prescription-scans/${scan.id}/correction`, doc.token).send({ text: "Tab Cetirizine 10mg 0-0-1 x 5 days" })).status, 200);
    const saved = await lines(doc.token, scan.id, [ITEM]);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.lines[0].foodRelation, "AFTER_FOOD");
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 0, "no prescription exists yet");
    const q = await t.api("get", "/pharmacy/queue", pharm.token);
    assert.ok(!(q.body.data as { patientId: string }[]).some((o) => o.patientId === v.patient.id), "the pharmacy queue does not show it");
  });

  it("only a registered doctor with the right to sign can approve", async () => {
    const v = await completedVisit(false);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    await lines(doc.token, scan.id, [ITEM]);
    const scanOnly = await makeClinicianWith(t, a, ["CONSULTATION_READ", "PRESCRIPTION_SCAN"]);
    assert.equal((await approve(scanOnly.token, scan.id)).status, 403, "can upload and edit, but not sign");
    const noPractitioner = await makeUserWithPermissions(t, a, ["CONSULTATION_READ", "PRESCRIPTION_SCAN", "PRESCRIPTION_SIGN"]);
    const r = await approve(noPractitioner.token, scan.id);
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /registered practitioner/);
    assert.equal((await approve(rec.token, scan.id)).status, 403);
    assert.equal((await approve(pharm.token, scan.id)).status, 403);
    assert.equal((await t.api("post", `/prescription-scans/${scan.id}/approve`).send({})).status, 401);
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 0);
  });

  it("approval creates a signed prescription that the pharmacy dispenses, and freezes the scan", async () => {
    const v = await completedVisit();
    const signedDoc = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { encounterId: v.encounterId, kind: "CONSULTATION" } });
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    assert.equal((await approve(doc.token, scan.id)).status, 409, "needs saved lines");
    const med = (await t.api("post", "/medicines", pharm.token).send({ brandName: `Zyr${uniqueWord(5)}`, genericName: "Cetirizine", strength: "10 mg", dosageForm: "TABLET", gstPercent: 12, reorderLevel: 5 })).body.data as { id: string };
    const batch = await t.api("post", "/pharmacy/batches", pharm.token).set("Idempotency-Key", key()).send({ medicineId: med.id, batchNo: "HW1", expiryDate: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10), mrp: "10.00", purchasePrice: "6.00", sellingPrice: "9.50", quantity: 40 });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    assert.equal((await lines(doc.token, scan.id, [{ ...ITEM, quantity: 5 }])).status, 200);
    const ok = await approve(doc.token, scan.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const order = await t.prisma.medicationOrder.findFirstOrThrow({ where: { id: ok.body.data.approved.prescriptionId }, include: { items: true } });
    assert.deepEqual([order.source, order.status, order.signedById, order.encounterId, order.patientId], ["HANDWRITTEN", "SIGNED", doc.userId, v.encounterId, v.patient.id]);
    assert.ok(order.orderNumber);
    assert.deepEqual([order.items[0]?.genericName, order.items[0]?.foodRelation, order.items[0]?.instructions, order.items[0]?.durationDays, order.items[0]?.status], ["Cetirizine", "AFTER_FOOD", "Avoid driving", 5, "ACTIVE"]);
    const stored = await t.prisma.prescriptionScan.findFirstOrThrow({ where: { id: scan.id } });
    assert.equal(stored.medicationOrderId, order.id);
    assert.ok(stored.approvedById === doc.userId && stored.approvedAt);

    const q = await t.api("get", "/pharmacy/queue", pharm.token);
    const row = (q.body.data as { id: string; source: string; doctorName: string; items: { id: string }[] }[]).find((o) => o.id === order.id);
    assert.ok(row, "the pharmacy sees it");
    assert.equal(row.source, "HANDWRITTEN");
    const pages = (row as unknown as { handwrittenPages: { pageNo: number; fileId: string; contentType: string }[] }).handwrittenPages;
    assert.deepEqual(pages.map((x) => [x.pageNo, x.contentType]), [[1, "image/png"]], "the pharmacist is given the original handwritten page");
    const file = await t.api("get", `/files/${pages[0]?.fileId}/content`, pharm.token);
    assert.equal(file.status, 200, "and can open it");
    assert.equal((await t.api("get", `/files/${pages[0]?.fileId}/content`, (await t.makeUser(b, ["PHARMACIST"])).token)).status, 404, "another hospital cannot");
    const dis = await t.api("post", "/pharmacy/dispenses", pharm.token).set("Idempotency-Key", key()).send({ patientId: v.patient.id, medicationOrderId: order.id, items: [{ medicationOrderItemId: row.items[0]?.id, medicineId: med.id, quantity: 5 }] });
    assert.equal(dis.status, 201, JSON.stringify(dis.body));
    assert.equal(dis.body.data.dispense.invoice.status, "ISSUED", "billed, and paid at the cashier");
    assert.equal((await t.prisma.medicationOrderItem.findFirstOrThrow({ where: { id: row.items[0]?.id } })).dispensedQuantity, 5);

    // The visit's own digital prescription is untouched and is what prints.
    const digital = await t.prisma.medicationOrder.findFirstOrThrow({ where: { encounterId: v.encounterId, source: "DIGITAL" }, include: { items: true } });
    assert.deepEqual([digital.status, digital.items[0]?.genericName], ["SIGNED", "Paracetamol"]);
    const html = await t.api("get", `/print/prescriptions/${v.encounterId}`, doc.token);
    assert.equal(html.status, 200);
    assert.match(html.text, /Paracetamol/);
    assert.ok(!html.text.includes("Cetirizine"));
    const printScan = (await t.api("get", `/encounters/${v.encounterId}/prescription-scans`, doc.token)).body.data[0];
    assert.equal(printScan.approved.prescriptionNumber, order.orderNumber);

    // The signed consultation record itself was not touched by any of this.
    const after = await t.prisma.clinicalDocument.findFirstOrThrow({ where: { id: signedDoc.id } });
    assert.deepEqual([after.status, after.currentVersion, after.updatedAt.getTime()], [signedDoc.status, signedDoc.currentVersion, signedDoc.updatedAt.getTime()]);
    assert.equal(await t.prisma.clinicalDocumentVersion.count({ where: { documentId: signedDoc.id } }), 1);
    // Frozen: nothing can be edited and a second approval cannot make a second prescription.
    assert.equal((await approve(doc.token, scan.id)).status, 409);
    assert.equal((await lines(doc.token, scan.id, [ITEM])).status, 409);
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PrescriptionScan" SET "medicationOrderId" = NULL, "approvedAt" = NULL, "approvedById" = NULL WHERE id = '${scan.id}'::uuid`));
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId, source: "HANDWRITTEN" } }), 1);
    const actions = (await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: order.id }, select: { action: true, metadata: true } }));
    assert.ok(actions.some((e) => e.action === "PRESCRIPTION_SIGNED" && (e.metadata as Record<string, unknown>)["source"] === "HANDWRITTEN"));
  });

  it("amending the consultation does not touch an approved handwritten prescription", async () => {
    const v = await completedVisit();
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    await lines(doc.token, scan.id, [ITEM]);
    const ok = await approve(doc.token, scan.id);
    assert.equal(ok.status, 200);
    const hw = ok.body.data.approved.prescriptionId as string;
    const current = await t.api("get", `/encounters/${v.encounterId}/consultation`, doc.token);
    const amend = await t.api("post", `/encounters/${v.encounterId}/consultation/amend`, doc.token).send({
      expectedVersion: current.body.data.document.currentVersion, reason: "Dose corrected", content: { chiefComplaint: "Fever for two days" },
      prescription: { items: [{ genericName: "Paracetamol", strength: "650 mg", dosage: "1 tablet", route: "ORAL", frequency: "BD", durationDays: 3 }] },
    });
    assert.equal(amend.status, 200, JSON.stringify(amend.body));
    assert.equal((await t.prisma.medicationOrder.findFirstOrThrow({ where: { id: hw } })).status, "SIGNED", "still valid for the pharmacy");
    const digital = await t.prisma.medicationOrder.findMany({ where: { encounterId: v.encounterId, source: "DIGITAL" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(digital.map((o) => o.status), ["SUPERSEDED", "SIGNED"]);
  });

  it("a recorded allergy must be acknowledged before approval, exactly like any prescription", async () => {
    const v = await completedVisit(false);
    assert.equal((await t.api("post", `/patients/${v.patient.id}/allergies`, doc.token).send({ allergen: "Cetirizine", type: "DRUG", reaction: "Rash", severity: "SEVERE" })).status, 201);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    await lines(doc.token, scan.id, [ITEM]);
    const blocked = await approve(doc.token, scan.id);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "ALLERGY_CONFLICT");
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 0);
    assert.equal((await approve(doc.token, scan.id, { acknowledgeAllergyWarnings: true })).status, 200);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "PRESCRIPTION_ALLERGY_ACKNOWLEDGED" } }));
  });

  it("lines are validated: unknown medicines, bad numbers, unknown fields and too many lines are refused", async () => {
    const v = await completedVisit(false);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    for (const bad of [{ ...ITEM, durationDays: 0 }, { ...ITEM, frequency: "WEEKLY" }, { ...ITEM, genericName: "x" }, { ...ITEM, price: "1" }, { ...ITEM, frequency: "OTHER" }, { ...ITEM, foodRelation: "SOMETIME" }]) {
      assert.equal((await lines(doc.token, scan.id, [bad])).status, 400, JSON.stringify(bad));
    }
    assert.equal((await lines(doc.token, scan.id, Array.from({ length: 31 }, () => ITEM))).status, 400);
    assert.equal((await t.api("put", `/prescription-scans/${scan.id}/lines`, doc.token).send({ items: [ITEM], extra: 1 })).status, 400);
    assert.equal((await lines(doc.token, scan.id, [{ ...ITEM, medicineId: randomUUID() }])).status, 200, "a draft may hold anything");
    const r = await approve(doc.token, scan.id);
    assert.equal(r.status, 400, "but an unknown medicine cannot be approved");
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId } }), 0);
  });

  it("two approvals at once make exactly one prescription", async () => {
    const v = await completedVisit(false);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    await lines(doc.token, scan.id, [ITEM]);
    const rs = await Promise.all(Array.from({ length: 4 }, () => approve(doc.token, scan.id)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join());
    assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
    assert.equal(await t.prisma.medicationOrder.count({ where: { encounterId: v.encounterId, source: "HANDWRITTEN" } }), 1);
  });

  it("is off with the setting off: nothing can be saved or approved", async () => {
    const v = await completedVisit(false);
    const scan = (await upload(doc.token, v.encounterId)).body.data;
    await lines(doc.token, scan.id, [ITEM]);
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: false })).status, 200);
    assert.equal((await approve(doc.token, scan.id)).status, 403);
    assert.equal((await lines(doc.token, scan.id, [ITEM])).status, 403);
    assert.equal((await t.api("put", "/settings/PRESCRIPTION_UPLOAD_ENABLED", a.admin.token).send({ value: true })).status, 200);
  });
});
