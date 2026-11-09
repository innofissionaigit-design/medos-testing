import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, makeUserWithPermissions, patientBody, startApp, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

describe("registration fee: collected at Reception before the Patient ID is issued", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let rec2: { id: string; token: string };
  let cashier: { id: string; token: string };
  let manager: { id: string; token: string };
  let doc: TestDoctor;
  const idem = () => `k-${randomUUID().slice(0, 18)}`;
  const setting = (k: string, v: unknown, tok = a.admin.token) => t.api("put", `/settings/${k}`, tok).send({ value: v });
  const register = (body: Record<string, unknown>, tok = rec.token, key: string | undefined = idem()) => {
    const r = t.api("post", "/patients", tok);
    return (key ? r.set("Idempotency-Key", key) : r).send(body);
  };
  const cash = (n = "150.00") => ({ registration: { payments: [{ method: "CASH", amount: n }] } });
  const patientCount = (mobile: string) => t.prisma.patient.count({ where: { tenantId: a.tenantId, mobile } });
  const rows = (kind = "REGISTRATION") => t.prisma.invoice.count({ where: { tenantId: a.tenantId, kind: kind as "REGISTRATION" } });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("reg-a");
    b = await t.makeTenant("reg-b");
    // These tests check the strict rule (cash needs an open shift), which a hospital can choose; the default opens one automatically (cash-shift.spec.ts).
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", a.admin.token).send({ value: false })).status, 200);
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    rec2 = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    manager = await t.makeUser(a, ["MANAGER"]);
    doc = await makeDoctor(t, a);
    assert.equal((await t.api("post", "/shifts/open", rec.token).send({ openingCash: "0" })).status, 201);
  });
  after(async () => { await t.close(); });

  let legacyId = "";
  it("with no fee set up, registration works as before, and sending a payment is refused", async () => {
    const body = patientBody();
    const r = await register(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.registration, null);
    legacyId = r.body.data.id;
    assert.equal((await register(patientBody(), rec.token, idem()).then((x) => x.status)), 201);
    const withPay = await register({ ...patientBody(), ...cash() });
    assert.equal(withPay.status, 400, "nothing to pay when there is no fee");
    assert.equal(await rows(), 0);
    assert.deepEqual((await t.api("get", "/patients/registration-fee/config", rec.token)).body.data.enabled, false);
  });

  it("is set up by an administrator; Reception sees the fee and what it may do about it", async () => {
    assert.equal((await setting("REGISTRATION_FEE_ENABLED", true, rec.token)).status, 403);
    assert.equal((await setting("REGISTRATION_FEE_ENABLED", true)).status, 200);
    assert.equal((await setting("REGISTRATION_FEE_AMOUNT", "150")).status, 200);
    const c = (await t.api("get", "/patients/registration-fee/config", rec.token)).body.data;
    assert.deepEqual([c.enabled, c.amount, c.methods, c.canCollect, c.canExempt], [true, "150.00", ["CASH", "UPI", "CARD"], true, true]);
    assert.ok(c.exemptReasons.includes("Emergency"));
    assert.equal((await t.api("get", "/patients/registration-fee/config", doc.token)).status, 403);
    assert.equal((await t.api("get", "/patients/registration-fee/config")).status, 401);
  });

  it("the fee must be collected: without it, with the wrong amount, a method that is not allowed, or no open shift for cash, nothing is created", async () => {
    const body = patientBody();
    const need = await register(body);
    assert.equal(need.status, 409);
    assert.equal(need.body.error.code, "REGISTRATION_FEE_REQUIRED");
    assert.equal(need.body.error.details.amount, "150.00");
    assert.equal(await patientCount(body["mobile"] as string), 0, "no patient and so no Patient ID");
    const bad: [string, Record<string, unknown>, number][] = [
      ["too little", cash("100.00"), 400], ["too much", cash("200.00"), 400],
      ["bank transfer", { registration: { payments: [{ method: "BANK_TRANSFER", amount: "150.00", reference: "NEFT-0001" }] } }, 400],
      ["UPI without a reference", { registration: { payments: [{ method: "UPI", amount: "150.00" }] } }, 400],
      ["both payment and exemption", { registration: { payments: [{ method: "CASH", amount: "150.00" }], exemption: { reason: "Emergency" } } }, 400],
      ["neither", { registration: {} }, 400], ["unknown field", { registration: { payments: [{ method: "CASH", amount: "150.00", extra: 1 }] } }, 400],
      ["negative", cash("-150.00"), 400],
    ];
    for (const [label, o, status] of bad) assert.equal((await register({ ...body, ...o })).status, status, label);
    const noShift = await register({ ...body, ...cash() }, rec2.token);
    assert.equal(noShift.status, 409);
    assert.equal(noShift.body.error.code, "SHIFT_NOT_OPEN");
    assert.equal(await patientCount(body["mobile"] as string), 0, "a failed payment leaves no half-registered patient");
    assert.equal(await rows(), 0);
  });

  it("paying in cash issues the Patient ID and a receipt in one step", async () => {
    const body = patientBody();
    const r = await register({ ...body, ...cash() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const reg = r.body.data.registration;
    assert.deepEqual([reg.status, reg.amount, reg.methods], ["PAID", "150.00", ["CASH"]]);
    assert.ok(r.body.data.mrn && reg.receiptNumber && reg.invoiceNumber && reg.receiptId);
    const inv = await t.prisma.invoice.findFirstOrThrow({ where: { id: reg.invoiceId }, include: { receipts: { include: { payments: true } }, lines: true } });
    assert.deepEqual([inv.kind, inv.status, inv.patientId, inv.total.toFixed(2), inv.paidTotal.toFixed(2)], ["REGISTRATION", "PAID", r.body.data.id, "150.00", "150.00"]);
    assert.deepEqual([inv.receipts.length, inv.receipts[0]?.payments.length, inv.lines[0]?.sourceType], [1, 1, "REGISTRATION"]);
    const row = await t.prisma.patientRegistration.findFirstOrThrow({ where: { patientId: r.body.data.id } });
    assert.deepEqual([row.status, row.invoiceId, row.settledById], ["PAID", reg.invoiceId, rec.id]);
    const receipt = await t.api("get", `/print/receipts/${reg.receiptId}`, rec.token);
    assert.equal(receipt.status, 200, "the receipt prints");
    assert.match(receipt.text, /150\.00/);
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "REGISTRATION_FEE_PAID", entityId: row.id } });
    assert.deepEqual([(ev.metadata as Record<string, unknown>)["receiptNumber"], (ev.metadata as Record<string, unknown>)["amount"]], [reg.receiptNumber, "150.00"]);
    const view = (await t.api("get", `/patients/${r.body.data.id}/registration-fee`, rec.token)).body.data;
    assert.deepEqual([view.status, view.receiptNumber, view.methods], ["PAID", reg.receiptNumber, [{ method: "CASH", amount: "150.00" }]]);
  });

  it("UPI and card, and a split of them, are accepted", async () => {
    const upi = await register({ ...patientBody(), registration: { payments: [{ method: "UPI", amount: "150.00", reference: "UPI-REG-0001" }] } });
    assert.equal(upi.status, 201, JSON.stringify(upi.body));
    assert.deepEqual(upi.body.data.registration.methods, ["UPI"]);
    const split = await register({ ...patientBody(), registration: { payments: [{ method: "CARD", amount: "100.00", reference: "CARD-1234" }, { method: "CASH", amount: "50.00" }] } });
    assert.equal(split.status, 201, JSON.stringify(split.body));
    assert.deepEqual(split.body.data.registration.methods, ["CARD", "CASH"]);
  });

  it("a double submission is one registration and one payment, and an existing patient is never charged again", async () => {
    const body = patientBody();
    const key = idem();
    const first = await register({ ...body, ...cash() }, rec.token, key);
    const again = await register({ ...body, ...cash() }, rec.token, key);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200, "replayed");
    assert.equal(again.headers["idempotent-replayed"], "true");
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(await t.prisma.receipt.count({ where: { tenantId: a.tenantId, invoiceId: first.body.data.registration.invoiceId } }), 1);
    // Without a key the same person is recognised, so no second patient and no second fee.
    const before = await rows();
    const dup = await register({ ...body, ...cash() }, rec.token, idem());
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "DUPLICATE_PATIENT_SUSPECTED");
    assert.equal(await rows(), before);
    // The patient's fee cannot be paid a second time.
    const pay = await t.api("post", `/patients/${first.body.data.id}/registration-fee`, rec.token).send({ payments: [{ method: "CASH", amount: "150.00" }] });
    assert.equal(pay.status, 409);
    assert.match(pay.body.error.message, /already paid/);
    assert.equal(await rows(), before);
    // Someone registered before the fee existed has no fee to pay.
    assert.equal((await t.api("get", `/patients/${legacyId}/registration-fee`, rec.token)).body.data.status, "NOT_APPLICABLE");
    const legacyPay = await t.api("post", `/patients/${legacyId}/registration-fee`, rec.token).send({ payments: [{ method: "CASH", amount: "150.00" }] });
    assert.equal(legacyPay.status, 409);
    assert.match(legacyPay.body.error.message, /no registration fee/);
  });

  it("an authorised exemption registers the patient without the fee, with a listed reason, audited", async () => {
    const body = patientBody();
    const bad = await register({ ...body, registration: { exemption: { reason: "Because I said so" } } });
    assert.equal(bad.status, 400);
    assert.equal(await patientCount(body["mobile"] as string), 0);
    const ok = await register({ ...body, registration: { exemption: { reason: "emergency" } } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.data.registration.status, ok.body.data.registration.exemptionReason, Boolean(ok.body.data.mrn)], ["EXEMPTED", "Emergency", true]);
    const row = await t.prisma.patientRegistration.findFirstOrThrow({ where: { patientId: ok.body.data.id } });
    assert.deepEqual([row.status, row.invoiceId, row.exemptedById, row.exemptionReason], ["EXEMPTED", null, rec.id, "Emergency"]);
    assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "REGISTRATION_FEE_EXEMPTED", entityId: row.id } }));
    const noRight = await makeUserWithPermissions(t, a, ["PATIENT_CREATE", "PAYMENT_CREATE"]);
    const mobile = patientBody()["mobile"] as string;
    const denied = await register({ ...patientBody({ mobile }), registration: { exemption: { reason: "Emergency" } } }, noRight.token);
    assert.equal(denied.status, 403);
    assert.equal(await patientCount(mobile), 0);
    const noPay = await makeUserWithPermissions(t, a, ["PATIENT_CREATE", "REGISTRATION_FEE_EXEMPT"]);
    assert.equal((await register({ ...patientBody(), ...cash() }, noPay.token)).status, 403, "taking money needs the payment permission");
  });

  it("a fee left pending (a booking bot registered the patient) blocks check-in and admission until it is settled; an emergency is never held up", async () => {
    const made = await t.api("post", "/integrations/clients", a.admin.token).send({ name: "Voice bot", abilities: ["FIND_PATIENTS", "REGISTER_PATIENTS", "BOOK_APPOINTMENTS"] });
    const apiKey = made.body.data.apiKey as string;
    const b1 = patientBody();
    const reg = await t.api("post", "/booking/patients", apiKey).set("Idempotency-Key", idem()).send({ firstName: b1["firstName"], lastName: b1["lastName"], gender: "FEMALE", mobile: b1["mobile"], dateOfBirth: "1990-04-02" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const pid = reg.body.data.id as string;
    const view = (await t.api("get", `/patients/${pid}/registration-fee`, rec.token)).body.data;
    assert.deepEqual([view.status, view.amount], ["PENDING", "150.00"]);
    const walk = (priority = "NORMAL", tok = rec.token) => t.api("post", "/appointments/walk-in", tok).set("Idempotency-Key", idem()).send({ patientId: pid, practitionerId: doc.practitionerId, priority });
    const held = await walk();
    assert.equal(held.status, 409);
    assert.equal(held.body.error.code, "REGISTRATION_FEE_PENDING");
    assert.equal((await t.api("post", "/admissions", rec.token).set("Idempotency-Key", idem()).send({ patientId: pid, consultantId: doc.practitionerId, bedId: randomUUID() })).body.error.code, "REGISTRATION_FEE_PENDING");
    // Settling it: paid at Reception.
    const wrong = await t.api("post", `/patients/${pid}/registration-fee`, rec.token).send({ payments: [{ method: "CASH", amount: "10.00" }] });
    assert.equal(wrong.status, 400);
    const pay = await t.api("post", `/patients/${pid}/registration-fee`, rec.token).set("Idempotency-Key", idem()).send({ payments: [{ method: "UPI", amount: "150.00", reference: "UPI-PEND-01" }] });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.deepEqual([pay.body.data.status, pay.body.data.methods], ["PAID", ["UPI"]]);
    assert.ok(pay.body.data.receiptNumber);
    assert.equal((await walk()).status, 201, "checked in once the fee is paid");
    // Emergency: checked in while the fee is still pending.
    const b2 = patientBody();
    const reg2 = await t.api("post", "/booking/patients", apiKey).set("Idempotency-Key", idem()).send({ firstName: b2["firstName"], lastName: b2["lastName"], gender: "MALE", mobile: b2["mobile"], dateOfBirth: "1985-01-01" });
    const pid2 = reg2.body.data.id as string;
    const em = await t.api("post", "/appointments/walk-in", rec.token).set("Idempotency-Key", idem()).send({ patientId: pid2, practitionerId: doc.practitionerId, priority: "EMERGENCY" });
    assert.equal(em.status, 201, JSON.stringify(em.body));
    assert.equal((await t.api("get", `/patients/${pid2}/registration-fee`, rec.token)).body.data.status, "PENDING", "still to be settled afterwards");
    // Exempted by someone allowed to.
    const ex = await t.api("post", `/patients/${pid2}/registration-fee`, rec.token).send({ exemption: { reason: "Emergency" } });
    assert.equal(ex.status, 201);
    assert.equal((await t.api("post", `/patients/${pid2}/registration-fee`, rec.token).send({ exemption: { reason: "Emergency" } })).status, 409, "settled once");
  });

  it("four people paying the same pending fee at once: one receipt", async () => {
    const made = await t.api("post", "/integrations/clients", a.admin.token).send({ name: "Bot two", abilities: ["REGISTER_PATIENTS"] });
    const p = patientBody();
    const reg = await t.api("post", "/booking/patients", made.body.data.apiKey).set("Idempotency-Key", idem()).send({ firstName: p["firstName"], lastName: p["lastName"], gender: "FEMALE", mobile: p["mobile"], dateOfBirth: "1992-02-02" });
    const pid = reg.body.data.id as string;
    const before = await t.prisma.receipt.count({ where: { tenantId: a.tenantId } });
    const rs = await Promise.all(Array.from({ length: 4 }, () => t.api("post", `/patients/${pid}/registration-fee`, rec.token).set("Idempotency-Key", idem()).send({ payments: [{ method: "CASH", amount: "150.00" }] })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
    assert.equal(await t.prisma.receipt.count({ where: { tenantId: a.tenantId } }), before + 1);
    assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, patientId: pid, kind: "REGISTRATION" } }), 1);
  });

  it("the Cashier, Manager and Administrator see registrations, bills, amounts, methods and statuses at once; others do not", async () => {
    const asCashier = await t.api("get", "/reports/registrations", cashier.token);
    assert.equal(asCashier.status, 200, JSON.stringify(asCashier.body));
    const d = asCashier.body.data;
    const t0 = d.totals;
    assert.equal(t0.registrations, t0.paid + t0.exempted + t0.pending);
    assert.ok(t0.paid >= 5 && t0.exempted >= 1, JSON.stringify(t0));
    assert.equal(Number(t0.collected), t0.paid * 150, "every paid registration is 150.00");
    assert.deepEqual(d.byMethod.map((m: { method: string }) => m.method).sort(), ["CARD", "CASH", "UPI"]);
    const paidRow = d.rows.find((x: { status: string }) => x.status === "PAID");
    assert.ok(paidRow.patient && paidRow.mrn && paidRow.receiptNumber && paidRow.invoiceNumber && paidRow.paymentMethods && paidRow.registeredBy);
    const exRow = d.rows.find((x: { status: string }) => x.status === "EXEMPTED");
    assert.ok(exRow.exemptionReason && exRow.settledBy);
    for (const tok of [manager.token, a.admin.token]) assert.equal((await t.api("get", "/reports/registrations", tok)).status, 200);
    for (const tok of [rec.token, doc.token]) assert.equal((await t.api("get", "/reports/registrations", tok)).status, 403);
    assert.equal((await t.api("get", "/reports/registrations")).status, 401);
    // The bill is on the Cashier's billing list and in the day's collections.
    const bills = await t.api("get", "/invoices?kind=REGISTRATION&pageSize=100", cashier.token);
    assert.ok(bills.body.data.length >= t0.paid);
    assert.ok(bills.body.data.every((x: { kind: string }) => x.kind === "REGISTRATION"));
    const col = (await t.api("get", "/reports/collections", cashier.token)).body.data;
    assert.ok(Number(col.totals.net) >= t0.paid * 150, "registration money is part of the day's collections");
    // Another hospital sees none of it.
    const other = (await t.api("get", "/reports/registrations", b.admin.token)).body.data;
    assert.deepEqual([other.totals.registrations, other.rows.length], [0, 0]);
    assert.ok(d.stillDue.count >= 0);
  });

  it("the records cannot be rewritten: one row per patient, settled rows are final, nothing is deleted", async () => {
    const row = await t.prisma.patientRegistration.findFirstOrThrow({ where: { tenantId: a.tenantId, status: "PAID" } });
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientRegistration" SET status = 'EXEMPTED', "invoiceId" = NULL, "exemptionReason" = 'free', "exemptedById" = '${rec.id}'::uuid WHERE id = '${row.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`UPDATE "PatientRegistration" SET amount = 1 WHERE id = '${row.id}'::uuid`));
    await assert.rejects(t.prisma.$executeRawUnsafe(`DELETE FROM "PatientRegistration" WHERE id = '${row.id}'::uuid`));
    await assert.rejects(t.prisma.patientRegistration.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, patientId: row.patientId, amount: "150.00", createdById: rec.id } }), "a second fee for the same patient");
    // A later change of the fee never rewrites what was charged.
    assert.equal((await setting("REGISTRATION_FEE_AMOUNT", "200")).status, 200);
    assert.equal((await t.prisma.patientRegistration.findFirstOrThrow({ where: { id: row.id } })).amount.toFixed(2), "150.00");
    const next = await register({ ...patientBody(), ...cash("200.00") });
    assert.equal(next.status, 201);
    assert.equal(next.body.data.registration.amount, "200.00");
  });
});
