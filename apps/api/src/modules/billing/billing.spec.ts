import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "@medos/shared";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestTenant } from "../../test/harness";

describe("billing, payments, refunds and cashier shifts", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let cashier: { id: string; token: string };
  let manager: { id: string; token: string };
  let svc: { consult: string; dressing: string; inj: string };

  const key = () => `k-${randomUUID().slice(0, 18)}`;
  const mkService = async (tok: string, body: Record<string, unknown>) => {
    const r = await t.api("post", "/services", tok).send(body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.id as string;
  };
  const draft = async (patientId: string, lines: unknown[], extra: Record<string, unknown> = {}, tok = cashier.token) => {
    const r = await t.api("post", "/invoices", tok).send({ patientId, lines, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { id: string; version: number; total: string };
  };
  /** An issued invoice for exactly `total` (a manual line, no tax, no rounding noise). */
  const issued = async (total: string, patientId?: string) => {
    const p = patientId ?? (await registerPatient(t, rec.token)).id;
    const d = await draft(p, [{ description: "Procedure", unitPrice: total, taxPercent: 0, quantity: 1 }]);
    const r = await t.api("post", `/invoices/${d.id}/issue`, cashier.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: d.id, patientId: p, number: r.body.data.invoiceNumber as string };
  };
  const pay = (invoiceId: string, payments: unknown[], k = key(), tok = cashier.token) => t.api("post", `/invoices/${invoiceId}/payments`, tok).set("Idempotency-Key", k).send({ payments });
  const openShift = async (tok = cashier.token, cash = "1000") => {
    const r = await t.api("post", "/shifts/open", tok).send({ openingCash: cash });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.id as string;
  };
  const inv = async (id: string, tok = cashier.token) => (await t.api("get", `/invoices/${id}`, tok)).body.data;

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("bill-a");
    b = await t.makeTenant("bill-b");
    // These tests check the strict rule (cash needs an open shift), which a hospital can choose; the default opens one automatically (cash-shift.spec.ts).
    assert.equal((await t.api("put", "/settings/CASH_AUTO_OPEN_SHIFT", a.admin.token).send({ value: false })).status, 200);
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    cashier = await t.makeUser(a, ["CASHIER"]);
    manager = await t.makeUser(a, ["MANAGER"]);
    svc = {
      consult: await mkService(a.admin.token, { code: "CONS", name: "OPD Consultation", category: "CONSULTATION", price: "500.00", taxPercent: 0 }),
      dressing: await mkService(a.admin.token, { code: "DRESS", name: "Dressing (small)", category: "INJECTION_DRESSING", price: "133.33", taxPercent: "12" }),
      inj: await mkService(a.admin.token, { code: "INJ", name: "Injection charge", category: "INJECTION_DRESSING", price: "75", taxPercent: "5" }),
    };
  });
  after(async () => { await t.close(); });

  // ───────────────────────── service catalogue ─────────────────────────
  describe("service catalogue", () => {
    it("administrator maintains services with exact decimal prices; codes are normalised and unique per facility", async () => {
      const r = await t.api("post", "/services", a.admin.token).send({ code: "ecg", name: "ECG", category: "INVESTIGATION", price: 350.5, taxPercent: "0" });
      assert.equal(r.status, 201);
      assert.equal(r.body.data.code, "ECG");
      assert.equal(r.body.data.price, "350.50");
      assert.equal((await t.api("post", "/services", a.admin.token).send({ code: "ECG", name: "Dup", category: "OTHER", price: 1 })).status, 409);
      assert.equal((await t.api("post", "/services", b.admin.token).send({ code: "ECG", name: "ECG", category: "INVESTIGATION", price: 300 })).status, 201, "same code in another tenant");
    });

    it("rejects invalid prices, taxes and unknown fields", async () => {
      const base = { code: "BAD1", name: "Bad service", category: "OTHER", price: "10", taxPercent: 0 };
      for (const [label, o] of [
        ["negative price", { price: "-1" }], ["three decimals", { price: "1.234" }], ["text price", { price: "ten" }], ["exponent", { price: "1e3" }],
        ["huge", { price: "999999999999" }], ["tax over 100", { taxPercent: 101 }], ["negative tax", { taxPercent: -1 }], ["bad category", { category: "MAGIC" }],
        ["bad code", { code: "a b!" }], ["tenant injection", { tenantId: b.tenantId }], ["status injection", { status: "INACTIVE" }],
      ] as [string, Record<string, unknown>][]) {
        assert.equal((await t.api("post", "/services", a.admin.token).send({ ...base, ...o })).status, 400, label);
      }
      assert.equal((await t.api("post", "/services", a.admin.token).send({ ...base, price: 0 })).status, 201, "free services are allowed");
    });

    it("any signed-in user can read active services; only ADMIN_MASTERS can change them; inactive ones are hidden", async () => {
      const list = await t.api("get", "/services", rec.token);
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((s: { code: string }) => s.code === "CONS"));
      assert.equal((await t.api("post", "/services", rec.token).send({ code: "NOPE", name: "Nope", category: "OTHER", price: 1 })).status, 403);
      assert.equal((await t.api("post", "/services", cashier.token).send({ code: "NOPE", name: "Nope", category: "OTHER", price: 1 })).status, 403);
      assert.equal((await t.api("get", "/services")).status, 401);
      const s = await t.api("post", "/services", a.admin.token).send({ code: "OLDSVC", name: "Retired service", category: "OTHER", price: 10 });
      await t.api("patch", `/services/${s.body.data.id}`, a.admin.token).send({ status: "INACTIVE" });
      assert.ok(!(await t.api("get", "/services", rec.token).query({ includeInactive: "true" })).body.data.some((x: { code: string }) => x.code === "OLDSVC"));
      assert.ok((await t.api("get", "/services", a.admin.token).query({ includeInactive: "true" })).body.data.some((x: { code: string }) => x.code === "OLDSVC"));
      const search = await t.api("get", "/services", rec.token).query({ q: "dress" });
      assert.equal(search.body.data[0].code, "DRESS");
    });

    it("price changes are audited with before/after, and never alter existing invoices", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }]);
      const ch = await t.api("patch", `/services/${svc.consult}`, a.admin.token).send({ price: "600" });
      assert.equal(ch.status, 200);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "SERVICE_PRICE_CHANGED", entityId: svc.consult } });
      assert.deepEqual((evt.metadata as { price: string[] }).price, ["500.00", "600.00"]);
      assert.equal(evt.actorUserId, a.admin.id);
      assert.equal((await inv(d.id)).total, "500.00", "the draft kept the snapshot price");
      const next = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }]);
      assert.equal(next.total, "600.00");
      await t.api("patch", `/services/${svc.consult}`, a.admin.token).send({ price: "500" });
    });

    it("is isolated by tenant and facility", async () => {
      const bAdmin = b.admin.token;
      assert.equal((await t.api("patch", `/services/${svc.consult}`, bAdmin).send({ price: "1" })).status, 404);
      assert.ok(!(await t.api("get", "/services", bAdmin)).body.data.some((s: { id: string }) => s.id === svc.consult));
      const login2 = await t.login(a.code, "admin", undefined, a.facility2Id);
      const tok2 = login2.body.data.tokens.accessToken as string;
      assert.ok(!(await t.api("get", "/services", tok2)).body.data.some((s: { id: string }) => s.id === svc.consult), "facility 2 has its own catalogue");
      assert.equal((await t.api("patch", `/services/${svc.consult}`, tok2).send({ price: "1" })).status, 404);
    });
  });

  // ───────────────────────── invoices ─────────────────────────
  describe("invoices", () => {
    it("the server computes every total; line prices come from the catalogue", async () => {
      const p = await registerPatient(t, rec.token);
      const r = await t.api("post", "/invoices", cashier.token).send({
        patientId: p.id, lines: [{ serviceId: svc.dressing, quantity: 3 }, { serviceId: svc.consult, quantity: "1" }, { description: "Manual item", unitPrice: "10.10", taxPercent: 18, quantity: "2.5" }],
      });
      assert.equal(r.status, 201);
      const i = r.body.data;
      // 3 x 133.33 = 399.99 (+12% = 47.9988 -> 48.00); 500.00; 2.5 x 10.10 = 25.25 (+18% = 4.545 -> 4.55)
      assert.equal(i.subtotal, "925.24");
      assert.equal(i.taxTotal, "52.55");
      assert.equal(i.discountTotal, "0.00");
      assert.equal(i.total, "977.79");
      assert.equal(i.status, "DRAFT");
      assert.equal(i.invoiceNumber, null);
      assert.deepEqual(i.lines.map((l: { lineTotal: string }) => l.lineTotal), ["447.99", "500.00", "29.80"]);
      assert.equal(i.lines[0].description, "Dressing (small)");
      assert.equal(i.lines[0].unitPrice, "133.33");
      assert.equal(i.balanceDue, "0.00", "a draft owes nothing yet");
    });

    it("refuses client-supplied totals, tampered prices and invalid lines", async () => {
      const p = await registerPatient(t, rec.token);
      const ok = { serviceId: svc.consult, quantity: 1 };
      const bad: [string, Record<string, unknown>][] = [
        ["client total", { lines: [ok], total: "1.00" }],
        ["client subtotal", { lines: [ok], subtotal: "1.00" }],
        ["status injection", { lines: [ok], status: "PAID" }],
        ["number injection", { lines: [ok], invoiceNumber: "INV-1" }],
        ["paid injection", { lines: [ok], paidTotal: "500" }],
        ["price tamper on a catalogue line", { lines: [{ ...ok, unitPrice: "1.00" }] }],
        ["tax tamper on a catalogue line", { lines: [{ ...ok, taxPercent: 0 }] }],
        ["description tamper", { lines: [{ ...ok, description: "Free" }] }],
        ["service and manual fields mixed", { lines: [{ ...ok, description: "x", unitPrice: "1", taxPercent: 0 }] }],
        ["no lines", { lines: [] }],
        ["too many lines", { lines: Array.from({ length: 51 }, () => ok) }],
        ["zero quantity", { lines: [{ ...ok, quantity: 0 }] }],
        ["negative quantity", { lines: [{ ...ok, quantity: -1 }] }],
        ["four decimal quantity", { lines: [{ ...ok, quantity: "1.0001" }] }],
        ["unknown service", { lines: [{ serviceId: randomUUID(), quantity: 1 }] }],
        ["manual negative price", { lines: [{ description: "x1", unitPrice: "-5", taxPercent: 0, quantity: 1 }] }],
        ["manual float noise", { lines: [{ description: "x1", unitPrice: 0.30000000000000004, taxPercent: 0, quantity: 1 }] }],
        ["manual tax 150", { lines: [{ description: "x1", unitPrice: "5", taxPercent: 150, quantity: 1 }] }],
        ["bad kind", { lines: [ok], kind: "MAGIC" }],
      ];
      for (const [label, extra] of bad) {
        const r = await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, ...extra });
        assert.equal(r.status, 400, label);
      }
      assert.equal(await t.prisma.invoice.count({ where: { tenantId: a.tenantId, patientId: p.id } }), 0, "nothing was created");
      const inactive = await mkService(a.admin.token, { code: "INACT1", name: "Inactive soon", category: "OTHER", price: 5 });
      await t.api("patch", `/services/${inactive}`, a.admin.token).send({ status: "INACTIVE" });
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ serviceId: inactive, quantity: 1 }] })).status, 400);
      const bSvc = await mkService(b.admin.token, { code: "BSVC", name: "Other tenant svc", category: "OTHER", price: 5 });
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: [{ serviceId: bSvc, quantity: 1 }] })).status, 400, "another tenant's service");
    });

    it("discounts need INVOICE_DISCOUNT, cannot exceed the line, and are audited", async () => {
      const p = await registerPatient(t, rec.token);
      const withDiscount = [{ serviceId: svc.consult, quantity: 1, discountAmount: "50.00" }];
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, lines: withDiscount })).status, 403);
      assert.equal((await t.api("post", "/invoices", rec.token).send({ patientId: p.id, lines: withDiscount })).status, 403);
      const mgr = await t.api("post", "/invoices", manager.token).send({ patientId: p.id, lines: withDiscount });
      assert.equal(mgr.status, 403, "managers can discount but INVOICE_CREATE is a separate right");
      const discounter = await t.makeUser(a, ["RECEPTIONIST", "MANAGER"]);
      const ok = await t.api("post", "/invoices", discounter.token).send({ patientId: p.id, lines: withDiscount });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.data.discountTotal, "50.00");
      assert.equal(ok.body.data.total, "450.00");
      assert.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "INVOICE_DISCOUNT_APPLIED", entityId: ok.body.data.id, actorUserId: discounter.id } }));
      assert.equal((await t.api("post", "/invoices", discounter.token).send({ patientId: p.id, lines: [{ serviceId: svc.consult, quantity: 1, discountAmount: "500.01" }] })).status, 400);
      assert.equal((await t.api("post", "/invoices", discounter.token).send({ patientId: p.id, lines: [{ serviceId: svc.consult, quantity: 1, discountAmount: "-1" }] })).status, 400);
      const full = await t.api("post", "/invoices", discounter.token).send({ patientId: p.id, lines: [{ serviceId: svc.consult, quantity: 1, discountAmount: "500" }] });
      assert.equal(full.body.data.total, "0.00");
      assert.equal((await t.api("post", `/invoices/${full.body.data.id}/issue`, cashier.token)).status, 400, "a zero-value invoice cannot be issued");
    });

    it("a manager discounts a draft in place: totals recomputed server-side, reason required, before/after audited, issued invoices refused", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }, { serviceId: svc.inj, quantity: 2 }]);
      const lineIds = async () => (await t.prisma.invoiceLine.findMany({ where: { invoiceId: d.id }, orderBy: { lineNo: "asc" } })).map((l) => l.id);
      const before = await lineIds();
      const disc = (body: Record<string, unknown>, tok = manager.token) => t.api("post", `/invoices/${d.id}/discount`, tok).send(body);

      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 1, discountAmount: "100" }] }, cashier.token)).status, 403, "cashiers cannot discount");
      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 1, discountAmount: "100" }] }, rec.token)).status, 403);
      assert.equal((await disc({ version: d.version, lines: [{ lineNo: 1, discountAmount: "100" }] })).status, 400, "a reason is required");
      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 1, discountAmount: "500.01" }] })).status, 400, "cannot exceed the line");
      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 9, discountAmount: "10" }] })).status, 400, "unknown line");
      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 1, discountAmount: "100" }], total: "1" })).status, 400, "client totals are rejected");

      const ok = await disc({ version: d.version, reason: "Staff family concession", lines: [{ lineNo: 1, discountAmount: "100" }] });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.discountTotal, "100.00");
      // 500 - 100 + injection 2 x 75 + 5% tax (157.50) = 557.50
      assert.equal(ok.body.data.total, "557.50");
      assert.deepEqual(await lineIds(), before, "lines are updated in place, never rewritten");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "INVOICE_DISCOUNT_APPLIED", entityId: d.id, actorUserId: manager.id } });
      assert.deepEqual(evt.metadata, { reason: "Staff family concession", lines: [{ lineNo: 1, from: "0.00", to: "100.00" }], discount: "100.00", total: "557.50" });

      assert.equal((await disc({ version: d.version, reason: "Staff family", lines: [{ lineNo: 1, discountAmount: "50" }] })).status, 409, "a stale version is refused");
      assert.equal((await t.api("post", `/invoices/${d.id}/issue`, cashier.token)).status, 200);
      assert.equal((await disc({ version: d.version + 1, reason: "Too late now", lines: [{ lineNo: 1, discountAmount: "50" }] })).status, 409, "issued invoices are frozen");
      assert.equal((await t.api("post", `/invoices/${d.id}/discount`, b.admin.token).send({ version: 1, reason: "Other tenant", lines: [{ lineNo: 1, discountAmount: "1" }] })).status, 403, "other tenants are refused");
    });

    it("reception drafts, issues and takes payment (the OPD consultation is paid at the desk); nurses cannot bill; patients and visits must belong to the tenant", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }], {}, rec.token);
      assert.equal((await t.api("post", `/invoices/${d.id}/issue`, rec.token)).status, 200);
      const nurse = await t.makeUser(a, ["NURSE"]);
      assert.equal((await t.api("post", `/invoices/${d.id}/issue`, nurse.token)).status, 403);
      assert.equal((await t.api("post", "/invoices", nurse.token).send({ patientId: p.id, lines: [{ serviceId: svc.consult, quantity: 1 }] })).status, 403);
      assert.equal((await t.api("get", "/invoices", nurse.token)).status, 403);
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: randomUUID(), lines: [{ serviceId: svc.consult, quantity: 1 }] })).status, 404);
      const bRec = await t.makeUser(b, ["RECEPTIONIST"]);
      const bPatient = await registerPatient(t, bRec.token);
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: bPatient.id, lines: [{ serviceId: svc.consult, quantity: 1 }] })).status, 404);
      const doc = await makeDoctor(t, a);
      const visit = await startVisit(t, rec.token, doc, p.id);
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: p.id, encounterId: visit.encounterId, lines: [{ serviceId: svc.consult, quantity: 1 }] })).status, 201);
      const other = await registerPatient(t, rec.token);
      assert.equal((await t.api("post", "/invoices", cashier.token).send({ patientId: other.id, encounterId: visit.encounterId, lines: [{ serviceId: svc.consult, quantity: 1 }] })).status, 400, "visit belongs to a different patient");
    });

    it("drafts are editable with optimistic locking; totals are recomputed on every save", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }]);
      const r = await t.api("put", `/invoices/${d.id}`, cashier.token).send({ version: d.version, lines: [{ serviceId: svc.consult, quantity: 2 }, { serviceId: svc.inj, quantity: 1 }], notes: "Revised" });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.total, "1078.75");
      assert.equal(r.body.data.lines.length, 2);
      assert.equal(r.body.data.version, d.version + 1);
      const stale = await t.api("put", `/invoices/${d.id}`, cashier.token).send({ version: d.version, lines: [{ serviceId: svc.consult, quantity: 1 }] });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, "STALE_VERSION");
      assert.equal((await t.api("put", `/invoices/${d.id}`, cashier.token).send({ version: r.body.data.version, lines: [{ serviceId: svc.consult, quantity: 1 }], total: "1.00" })).status, 400);
    });

    it("issuing assigns a sequential number and freezes the invoice; it cannot be issued or edited again", async () => {
      const p = await registerPatient(t, rec.token);
      const d = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }]);
      const r = await t.api("post", `/invoices/${d.id}/issue`, cashier.token);
      assert.equal(r.status, 200);
      assert.match(r.body.data.invoiceNumber, /^INV-\d{4}-\d{6}$/);
      assert.equal(r.body.data.status, "ISSUED");
      assert.equal(r.body.data.balanceDue, "500.00");
      const again = await t.api("post", `/invoices/${d.id}/issue`, cashier.token);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "INVOICE_ALREADY_ISSUED");
      const edit = await t.api("put", `/invoices/${d.id}`, cashier.token).send({ version: r.body.data.version, lines: [{ serviceId: svc.consult, quantity: 1 }] });
      assert.equal(edit.status, 409);
      assert.equal(edit.body.error.code, "INVOICE_ALREADY_ISSUED");
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "INVOICE_ISSUED", entityId: d.id } });
      assert.equal(evt.actorUserId, cashier.id);
    });

    it("issuing is single-shot under a race, and numbers are unique and gap-free across 15 parallel issues", async () => {
      const p = await registerPatient(t, rec.token);
      const one = await draft(p.id, [{ serviceId: svc.consult, quantity: 1 }]);
      const rs = await Promise.all(Array.from({ length: 6 }, () => t.api("post", `/invoices/${one.id}/issue`, cashier.token)));
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));

      const drafts = await Promise.all(Array.from({ length: 15 }, async () => draft((await registerPatient(t, rec.token)).id, [{ serviceId: svc.inj, quantity: 1 }])));
      const out = await Promise.all(drafts.map((d) => t.api("post", `/invoices/${d.id}/issue`, cashier.token)));
      assert.ok(out.every((r) => r.status === 200));
      const nums = out.map((r) => Number((r.body.data.invoiceNumber as string).split("-").pop())).sort((x, y) => x - y);
      assert.equal(new Set(nums).size, 15);
      assert.equal(nums[14]! - nums[0]!, 14, "contiguous");
    });

    it("DATABASE: an issued invoice and its lines cannot be changed or deleted, even by raw SQL", async () => {
      const i = await issued("250.00");
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: i.id }, data: { total: 1, subtotal: 1 } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: i.id }, data: { invoiceNumber: "INV-HACK" } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: i.id }, data: { notes: "edited" } }), /cannot be changed/);
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: i.id }, data: { status: "DRAFT" } }), /Invalid invoice status transition/);
      await assert.rejects(() => t.prisma.invoice.delete({ where: { id: i.id } }), /append-only/);
      const line = await t.prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: i.id } });
      await assert.rejects(() => t.prisma.invoiceLine.update({ where: { id: line.id }, data: { unitPrice: 1 } }), /issued invoice cannot be added, changed or removed|Lines of an issued/);
      await assert.rejects(() => t.prisma.invoiceLine.delete({ where: { id: line.id } }), /Lines of an issued/);
      await assert.rejects(() => t.prisma.invoiceLine.create({ data: { tenantId: a.tenantId, invoiceId: i.id, lineNo: 9, description: "Sneaky", quantity: 1, unitPrice: 5, taxAmount: 0, lineTotal: 5 } }), /Lines of an issued/);
      assert.equal((await inv(i.id)).total, "250.00");
    });

    it("DATABASE: arithmetic and sign invariants hold even for raw inserts", async () => {
      const p = await registerPatient(t, rec.token);
      const base = { tenantId: a.tenantId, facilityId: a.facilityId, patientId: p.id, createdById: cashier.id };
      await assert.rejects(() => t.prisma.invoice.create({ data: { ...base, subtotal: 100, discountTotal: 0, taxTotal: 0, total: 99 } }), /invoice_total_formula|check/i);
      await assert.rejects(() => t.prisma.invoice.create({ data: { ...base, subtotal: -5, total: -5 } }), /invoice_amounts_nonneg|check/i);
      await assert.rejects(() => t.prisma.invoice.create({ data: { ...base, subtotal: 100, discountTotal: 150, total: -50 } }), /check/i);
      await assert.rejects(() => t.prisma.invoice.create({ data: { ...base, invoiceNumber: "INV-X", subtotal: 100, total: 100 } }), /invoice_draft_is_blank|check/i);
      await assert.rejects(() => t.prisma.invoice.create({ data: { ...base, facilityId: b.facilityId, subtotal: 1, total: 1 } }), /foreign key/i);
    });

    it("DATABASE: running totals must reconcile with receipts at commit (a forged paidTotal is rejected)", async () => {
      const i = await issued("300.00");
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: i.id }, data: { paidTotal: 300, status: "PAID" } }), /do not reconcile/);
      assert.equal((await inv(i.id)).paidTotal, "0.00");
      await assert.rejects(() => t.prisma.receipt.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, invoiceId: i.id, receiptNumber: "FAKE-1", total: 100, receivedById: cashier.id } }), /does not equal its payment lines|do not reconcile/);
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: i.id } }), 0);
    });

    it("lists and finds invoices by patient, status and number; reads are permission-gated and tenant/facility isolated", async () => {
      const i = await issued("120.00");
      const byNumber = await t.api("get", "/invoices", cashier.token).query({ q: i.number.toLowerCase() });
      assert.equal(byNumber.body.data[0].id, i.id);
      assert.equal((await t.api("get", "/invoices", cashier.token).query({ patientId: i.patientId, status: "ISSUED" })).body.meta.total, 1);
      assert.equal((await t.api("get", "/invoices", cashier.token).query({ status: "BOGUS" })).status, 400);
      assert.equal((await t.api("get", "/invoices", cashier.token).query({ pageSize: 1000 })).status, 400);
      const bCashier = await t.makeUser(b, ["CASHIER"]);
      assert.equal((await t.api("get", `/invoices/${i.id}`, bCashier.token)).status, 404);
      assert.equal((await t.api("get", `/invoices/${randomUUID()}`, bCashier.token)).status, 404);
      assert.equal((await t.api("get", "/invoices", bCashier.token).query({ q: i.number })).body.data.length, 0);
      const f2 = await t.makeUser(a, ["CASHIER"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/invoices/${i.id}`, f2.token)).status, 404);
      assert.equal((await t.api("post", `/invoices/${i.id}/issue`, f2.token)).status, 404);
      assert.equal((await t.api("get", "/invoices/not-a-uuid", cashier.token)).status, 404);
    });
  });

  // ───────────────────────── payments ─────────────────────────
  describe("payments and receipts", () => {
    it("cash needs an open shift; UPI does not; the receipt shows who took what", async () => {
      const own = await t.makeUser(a, ["CASHIER"]);
      const i = await issued("1200.00");
      const noShift = await pay(i.id, [{ method: "CASH", amount: "500" }], key(), own.token);
      assert.equal(noShift.status, 409);
      assert.equal(noShift.body.error.code, "SHIFT_NOT_OPEN");
      const upi = await pay(i.id, [{ method: "UPI", amount: "200", reference: "UPI123456" }], key(), own.token);
      assert.equal(upi.status, 201);
      assert.equal(upi.body.data.invoice.status, "PARTIALLY_PAID");
      await openShift(own.token);
      const cash = await pay(i.id, [{ method: "CASH", amount: "500" }], key(), own.token);
      assert.equal(cash.status, 201);
      assert.equal(cash.body.data.receipt.payments[0].method, "CASH");
      assert.equal(cash.body.data.receipt.receivedBy, (await t.prisma.user.findFirstOrThrow({ where: { id: own.id } })).fullName);
    });

    it("supports split payments on one receipt (₹500 cash + ₹700 UPI) and settles the invoice", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("1200.00");
      const r = await pay(i.id, [{ method: "CASH", amount: "500" }, { method: "UPI", amount: "700.00", reference: "UPI-TXN-998877" }]);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.data.receipt.receiptNumber, /^RCT-\d{4}-\d{6}$/);
      assert.equal(r.body.data.receipt.total, "1200.00");
      assert.deepEqual(r.body.data.receipt.payments.map((p: { method: string; amount: string }) => [p.method, p.amount]), [["CASH", "500.00"], ["UPI", "700.00"]]);
      assert.equal(r.body.data.invoice.status, "PAID");
      assert.equal(r.body.data.invoice.balanceDue, "0.00");
      assert.equal(r.body.data.invoice.receipts.length, 1);
      const rc = await t.api("get", `/receipts/${r.body.data.receipt.id}`, cashier.token);
      assert.equal(rc.status, 200);
      assert.equal(rc.body.data.invoiceNumber, i.number);
      assert.ok(rc.body.data.mrn);
    });

    it("tracks partial payments and balance; refuses overpayment and payments on settled invoices", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("1000.00");
      const p1 = await pay(i.id, [{ method: "CASH", amount: "400" }]);
      assert.equal(p1.body.data.invoice.status, "PARTIALLY_PAID");
      assert.equal(p1.body.data.invoice.balanceDue, "600.00");
      const over = await pay(i.id, [{ method: "CASH", amount: "600.01" }]);
      assert.equal(over.status, 409);
      assert.equal(over.body.error.code, "PAYMENT_EXCEEDS_BALANCE");
      assert.equal(over.body.error.details.balanceDue, "600.00");
      const splitOver = await pay(i.id, [{ method: "CASH", amount: "300" }, { method: "UPI", amount: "300.01", reference: "UPI777777" }]);
      assert.equal(splitOver.status, 409, "the combined tender is what counts");
      assert.equal((await inv(i.id)).paidTotal, "400.00", "rejected payments left no trace");
      assert.equal((await pay(i.id, [{ method: "CASH", amount: "600" }])).body.data.invoice.status, "PAID");
      const settled = await pay(i.id, [{ method: "CASH", amount: "1" }]);
      assert.equal(settled.status, 409);
      assert.equal(settled.body.error.code, "PAYMENT_EXCEEDS_BALANCE");
    });

    it("validates payment input: amounts, methods, references, unknown fields; drafts and cancelled invoices cannot be paid", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("500.00");
      const bad: [string, unknown[]][] = [
        ["zero", [{ method: "CASH", amount: "0" }]], ["negative", [{ method: "CASH", amount: "-5" }]], ["three decimals", [{ method: "CASH", amount: "1.001" }]],
        ["text", [{ method: "CASH", amount: "five" }]], ["unknown method", [{ method: "BITCOIN", amount: "5" }]], ["upi without reference", [{ method: "UPI", amount: "5" }]],
        ["short reference", [{ method: "CARD", amount: "5", reference: "12" }]], ["unknown field", [{ method: "CASH", amount: "5", invoiceId: i.id }]], ["empty", []],
        ["seven lines", Array.from({ length: 7 }, () => ({ method: "CASH", amount: "1" }))], ["float noise", [{ method: "CASH", amount: 0.30000000000000004 }]],
      ];
      for (const [label, payments] of bad) assert.equal((await pay(i.id, payments)).status, 400, label);
      assert.equal((await t.api("post", `/invoices/${i.id}/payments`, cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "CASH", amount: "5" }], total: "500" })).status, 400);
      const d = await draft((await registerPatient(t, rec.token)).id, [{ serviceId: svc.consult, quantity: 1 }]);
      assert.equal((await pay(d.id, [{ method: "CASH", amount: "5" }])).status, 409, "drafts cannot be paid");
      const c = await issued("100.00");
      await t.api("post", `/invoices/${c.id}/cancel`, manager.token).send({ reason: "Raised by mistake" });
      assert.equal((await pay(c.id, [{ method: "CASH", amount: "5" }])).status, 409);
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: { in: [d.id, c.id] } } }), 0);
    });

    it("is decimal-exact: ₹0.10 + ₹0.20 settles a ₹0.30 invoice with no residue", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("0.30");
      assert.equal((await pay(i.id, [{ method: "CASH", amount: "0.1" }])).body.data.invoice.balanceDue, "0.20");
      const r = await pay(i.id, [{ method: "CASH", amount: 0.2 }]);
      assert.equal(r.body.data.invoice.balanceDue, "0.00");
      assert.equal(r.body.data.invoice.status, "PAID");
    });

    it("an Idempotency-Key is mandatory; replays return the original receipt without charging twice", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("800.00");
      const noKey = await t.api("post", `/invoices/${i.id}/payments`, cashier.token).send({ payments: [{ method: "CASH", amount: "100" }] });
      assert.equal(noKey.status, 400);
      const k = key();
      const first = await pay(i.id, [{ method: "CASH", amount: "100" }], k);
      const replay = await pay(i.id, [{ method: "CASH", amount: "100" }], k);
      assert.equal(first.status, 201);
      assert.equal(replay.status, 200);
      assert.equal(replay.headers["idempotent-replayed"], "true");
      assert.equal(replay.body.data.receipt.receiptNumber, first.body.data.receipt.receiptNumber);
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: i.id } }), 1);
      assert.equal((await inv(i.id)).paidTotal, "100.00");
      const reuse = await pay(i.id, [{ method: "CASH", amount: "200" }], k);
      assert.equal(reuse.status, 422);
      assert.equal(reuse.body.error.code, "IDEMPOTENCY_KEY_REUSED");
      assert.equal((await t.api("post", `/invoices/${i.id}/payments`, cashier.token).set("Idempotency-Key", "x").send({ payments: [{ method: "CASH", amount: "1" }] })).status, 400);
      const otherInvoice = await issued("800.00");
      assert.equal((await pay(otherInvoice.id, [{ method: "CASH", amount: "100" }], k)).status, 201, "keys are scoped per invoice");
    });

    it("double-click: 10 simultaneous submissions with one key create exactly one receipt", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("500.00");
      const k = key();
      const rs = await Promise.all(Array.from({ length: 10 }, () => pay(i.id, [{ method: "CASH", amount: "500" }], k)));
      assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join());
      assert.equal(rs.filter((r) => r.status === 201).length, 1);
      assert.equal(new Set(rs.map((r) => r.body.data.receipt.receiptNumber)).size, 1);
      assert.equal(await t.prisma.receipt.count({ where: { invoiceId: i.id } }), 1);
      assert.equal((await inv(i.id)).paidTotal, "500.00");
    });

    it("concurrent payments (distinct keys) can never overpay: 12 x ₹100 against ₹500 yields exactly 5 receipts", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("500.00");
      const rs = await Promise.all(Array.from({ length: 12 }, () => pay(i.id, [{ method: "CASH", amount: "100" }])));
      assert.equal(rs.filter((r) => r.status === 201).length, 5);
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.error.code === "PAYMENT_EXCEEDS_BALANCE"));
      const final = await inv(i.id);
      assert.equal(final.paidTotal, "500.00");
      assert.equal(final.balanceDue, "0.00");
      assert.equal(final.status, "PAID");
      const numbers = (await t.prisma.receipt.findMany({ where: { invoiceId: i.id } })).map((r) => r.receiptNumber);
      assert.equal(new Set(numbers).size, 5);
    });

    it("receipt numbers are unique across many parallel payments on different invoices", async () => {
      await openShift().catch(() => undefined);
      const invoices = await Promise.all(Array.from({ length: 12 }, () => issued("50.00")));
      const rs = await Promise.all(invoices.map((i) => pay(i.id, [{ method: "CASH", amount: "50" }])));
      assert.ok(rs.every((r) => r.status === 201));
      const nums = rs.map((r) => Number((r.body.data.receipt.receiptNumber as string).split("-").pop()));
      assert.equal(new Set(nums).size, 12);
      assert.equal(Math.max(...nums) - Math.min(...nums), 11);
    });

    it("only PAYMENT_CREATE can take payments; receipts and invoices are tenant/facility isolated", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("200.00");
      // Reception can take payments (booking fees at the desk); a manager and a nurse cannot.
      for (const u of [manager, await t.makeUser(a, ["NURSE"])]) assert.equal((await pay(i.id, [{ method: "UPI", amount: "10", reference: "UPI000111" }], key(), u.token)).status, 403);
      assert.equal((await t.api("post", `/invoices/${i.id}/payments`).set("Idempotency-Key", key()).send({})).status, 401);
      const bCashier = await t.makeUser(b, ["CASHIER"]);
      assert.equal((await pay(i.id, [{ method: "UPI", amount: "10", reference: "UPI000222" }], key(), bCashier.token)).status, 404);
      const ok = await pay(i.id, [{ method: "UPI", amount: "10", reference: "UPI000333" }]);
      assert.equal((await t.api("get", `/receipts/${ok.body.data.receipt.id}`, bCashier.token)).status, 404);
      const f2 = await t.makeUser(a, ["CASHIER"], { facilityIds: [a.facility2Id] });
      assert.equal((await pay(i.id, [{ method: "UPI", amount: "10", reference: "UPI000444" }], key(), f2.token)).status, 404);
      assert.equal((await t.api("get", `/receipts/${ok.body.data.receipt.id}`, f2.token)).status, 404);
      assert.equal((await t.api("get", `/receipts/${randomUUID()}`, cashier.token)).status, 404);
    });

    it("DATABASE: receipts, payments, refunds and credit notes are append-only", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("100.00");
      const r = await pay(i.id, [{ method: "CASH", amount: "100" }]);
      const rc = await t.prisma.receipt.findFirstOrThrow({ where: { id: r.body.data.receipt.id }, include: { payments: true } });
      await assert.rejects(() => t.prisma.receipt.update({ where: { id: rc.id }, data: { total: 1 } }), /append-only/);
      await assert.rejects(() => t.prisma.receipt.delete({ where: { id: rc.id } }), /append-only/);
      await assert.rejects(() => t.prisma.payment.update({ where: { id: rc.payments[0]!.id }, data: { amount: 1 } }), /append-only/);
      await assert.rejects(() => t.prisma.payment.delete({ where: { id: rc.payments[0]!.id } }), /append-only/);
      await assert.rejects(() => t.prisma.payment.create({ data: { tenantId: a.tenantId, receiptId: rc.id, method: "CASH", amount: 0 } }), /payment_amount_positive|check/i);
    });

    it("audits each payment with the receipt, amount and methods but never the payment reference", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("90.00");
      const r = await pay(i.id, [{ method: "UPI", amount: "90", reference: "SECRETREF-4242" }]);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PAYMENT_RECEIVED", entityId: i.id } });
      assert.equal(evt.actorUserId, cashier.id);
      assert.equal((evt.metadata as { receiptNumber: string }).receiptNumber, r.body.data.receipt.receiptNumber);
      assert.ok(!JSON.stringify(evt.metadata).includes("SECRETREF"));
    });
  });

  // ───────────────────────── credit notes, refunds, cancellation ─────────────────────────
  describe("refunds, credit notes and cancellation", () => {
    const credit = (id: string, amountStr: string, reason = "Service not performed", k = key(), tok = manager.token) =>
      t.api("post", `/invoices/${id}/credit-notes`, tok).set("Idempotency-Key", k).send({ amount: amountStr, reason });
    const refund = (id: string, body: Record<string, unknown>, k = key(), tok = cashier.token) =>
      t.api("post", `/invoices/${id}/refunds`, tok).set("Idempotency-Key", k).send(body);

    it("a credit note reduces what is owed without touching the invoice lines; a refund returns the overpayment", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("1000.00");
      await pay(i.id, [{ method: "CASH", amount: "1000" }]);
      const before = (await inv(i.id)).lines;
      const cn = await credit(i.id, "200");
      assert.equal(cn.status, 201);
      assert.match(cn.body.data.creditNote.creditNoteNumber, /^CN-\d{4}-\d{6}$/);
      assert.equal(cn.body.data.invoice.total, "1000.00", "the invoice total is untouched");
      assert.equal(cn.body.data.invoice.creditedTotal, "200.00");
      assert.equal(cn.body.data.invoice.refundable, "200.00");
      assert.deepEqual(cn.body.data.invoice.lines, before);
      const rf = await refund(i.id, { method: "CASH", amount: "200", reason: "Overpayment after credit note" });
      assert.equal(rf.status, 201);
      assert.match(rf.body.data.refund.refundNumber, /^RF-\d{4}-\d{6}$/);
      assert.equal(rf.body.data.invoice.refundedTotal, "200.00");
      assert.equal(rf.body.data.invoice.netReceived, "800.00");
      assert.equal(rf.body.data.invoice.status, "PAID", "800 of the 800 now owed");
      assert.equal(rf.body.data.invoice.refundable, "0.00");
    });

    it("caps refunds at the refundable overpayment and by the original payment method", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("1000.00");
      await pay(i.id, [{ method: "CASH", amount: "400" }, { method: "UPI", amount: "600", reference: "UPI555555" }]);
      const none = await refund(i.id, { method: "CASH", amount: "1", reason: "Wants money back" });
      assert.equal(none.status, 409);
      assert.equal(none.body.error.code, "REFUND_EXCEEDS_PAID");
      assert.equal(none.body.error.details.refundable, "0.00");
      await credit(i.id, "500");
      const tooMuch = await refund(i.id, { method: "UPI", amount: "500.01", reason: "Over the overpayment", reference: "UPIREF0000" });
      assert.equal(tooMuch.status, 409);
      const wrongMethod = await refund(i.id, { method: "CARD", amount: "100", reason: "Never paid by card", reference: "CARD0001" });
      assert.equal(wrongMethod.status, 409);
      assert.match(wrongMethod.body.error.message, /received by card/);
      const cashTooMuch = await refund(i.id, { method: "CASH", amount: "450", reason: "More cash than taken" });
      assert.equal(cashTooMuch.status, 409, "only 400 came in as cash");
      assert.equal((await refund(i.id, { method: "UPI", amount: "300", reason: "Refund to the same UPI", reference: "UPIREF0001" })).status, 201);
      assert.equal((await refund(i.id, { method: "CASH", amount: "200", reason: "Rest as cash" })).status, 201);
      assert.equal((await refund(i.id, { method: "CASH", amount: "0.01", reason: "One paisa extra" })).status, 409);
      assert.equal((await inv(i.id)).refundedTotal, "500.00");
    });

    it("rejects invalid refund input and refunds on drafts or without a reason or key", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("100.00");
      await pay(i.id, [{ method: "CASH", amount: "100" }]);
      await credit(i.id, "50");
      for (const [label, body] of [
        ["no reason", { method: "CASH", amount: "10" }], ["short reason", { method: "CASH", amount: "10", reason: "no" }], ["zero", { method: "CASH", amount: "0", reason: "Zero refund" }],
        ["negative", { method: "CASH", amount: "-10", reason: "Negative refund" }], ["bad method", { method: "GOLD", amount: "10", reason: "Gold refund" }], ["upi no ref", { method: "UPI", amount: "10", reason: "Upi refund" }],
        ["unknown field", { method: "CASH", amount: "10", reason: "Extra field", invoiceId: "x" }],
      ] as [string, Record<string, unknown>][]) assert.equal((await refund(i.id, body)).status, 400, label);
      assert.equal((await t.api("post", `/invoices/${i.id}/refunds`, cashier.token).send({ method: "CASH", amount: "10", reason: "No idempotency key" })).status, 400);
      const d = await draft((await registerPatient(t, rec.token)).id, [{ serviceId: svc.consult, quantity: 1 }]);
      assert.equal((await refund(d.id, { method: "CASH", amount: "10", reason: "Refund a draft" })).status, 409);
    });

    it("repeated or double-submitted refunds can never exceed what is refundable", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("600.00");
      await pay(i.id, [{ method: "CASH", amount: "600" }]);
      await credit(i.id, "200");
      const k = key();
      const same = await Promise.all(Array.from({ length: 6 }, () => refund(i.id, { method: "CASH", amount: "200", reason: "Double clicked refund" }, k)));
      assert.ok(same.every((r) => [200, 201].includes(r.status)));
      assert.equal(same.filter((r) => r.status === 201).length, 1);
      assert.equal(await t.prisma.refund.count({ where: { invoiceId: i.id } }), 1);
      const again = await refund(i.id, { method: "CASH", amount: "200", reason: "Same refund new key" });
      assert.equal(again.status, 409, "a fresh key still cannot refund more than the overpayment");
      assert.equal(await t.prisma.refund.count({ where: { invoiceId: i.id } }), 1);
    });

    it("concurrent refunds race safely: only as many succeed as the overpayment allows", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("1000.00");
      await pay(i.id, [{ method: "CASH", amount: "1000" }]);
      await credit(i.id, "300");
      const rs = await Promise.all(Array.from({ length: 6 }, () => refund(i.id, { method: "CASH", amount: "100", reason: "Parallel refund attempt" })));
      assert.equal(rs.filter((r) => r.status === 201).length, 3);
      assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409));
      const f = await inv(i.id);
      assert.equal(f.refundedTotal, "300.00");
      assert.equal(f.refundable, "0.00");
    });

    it("credit notes: need INVOICE_ADJUST, a reason, an idempotency key; cannot zero the invoice; concurrent credits cannot exceed it", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("100.00");
      assert.equal((await credit(i.id, "10", "Courtesy adjustment", key(), cashier.token)).status, 403);
      assert.equal((await credit(i.id, "10", "Courtesy adjustment", key(), rec.token)).status, 403);
      assert.equal((await credit(i.id, "10", "no")).status, 400);
      assert.equal((await credit(i.id, "0", "Zero credit note")).status, 400);
      assert.equal((await t.api("post", `/invoices/${i.id}/credit-notes`, manager.token).send({ amount: "10", reason: "Missing key header" })).status, 400);
      const whole = await credit(i.id, "100", "Whole invoice credit");
      assert.equal(whole.status, 409);
      assert.equal(whole.body.error.code, "INVALID_AMOUNT");
      assert.equal(whole.body.error.details.maxCredit, "99.99");
      const rs = await Promise.all(Array.from({ length: 6 }, () => credit(i.id, "30", "Parallel credit attempt")));
      assert.equal(rs.filter((r) => r.status === 201).length, 3, "30+30+30=90 < 100; the fourth would leave 10 then 70... only 3 fit under the cap check");
      const f = await inv(i.id);
      assert.equal(f.creditedTotal, "90.00");
      assert.ok(new Decimal(f.creditedTotal).lt(f.total));
      const draftInv = await draft((await registerPatient(t, rec.token)).id, [{ serviceId: svc.consult, quantity: 1 }]);
      assert.equal((await credit(draftInv.id, "10", "Credit a draft invoice")).status, 409);
    });

    it("cancelling an unpaid invoice keeps it for the record; cancelling a paid one requires refunding exactly what was retained", async () => {
      await openShift().catch(() => undefined);
      const unpaid = await issued("150.00");
      assert.equal((await t.api("post", `/invoices/${unpaid.id}/cancel`, manager.token).send({ reason: "no" })).status, 400);
      assert.equal((await t.api("post", `/invoices/${unpaid.id}/cancel`, cashier.token).send({ reason: "Cashier has no right" })).status, 403);
      const c = await t.api("post", `/invoices/${unpaid.id}/cancel`, manager.token).send({ reason: "Patient declined the service" });
      assert.equal(c.status, 200);
      assert.equal(c.body.data.status, "CANCELLED");
      assert.equal(c.body.data.balanceDue, "0.00");
      assert.equal(c.body.data.lines.length, 1, "lines are preserved");
      assert.equal(c.body.data.invoiceNumber, unpaid.number, "the number is never reused");
      assert.equal((await t.api("post", `/invoices/${unpaid.id}/cancel`, manager.token).send({ reason: "Again again" })).status, 409);

      const paid = await issued("400.00");
      await pay(paid.id, [{ method: "CASH", amount: "250" }, { method: "UPI", amount: "150", reference: "UPI909090" }]);
      assert.equal((await t.api("post", `/invoices/${paid.id}/cancel`, manager.token).send({ reason: "Cancelled after payment" })).status, 403, "managers lack refund rights");
      const both = await t.makeUser(a, ["MANAGER", "CASHIER"]);
      await openShift(both.token);
      const noRefunds = await t.api("post", `/invoices/${paid.id}/cancel`, both.token).send({ reason: "Cancelled after payment" });
      assert.equal(noRefunds.status, 409);
      assert.equal(noRefunds.body.error.details.required, "400.00");
      const wrong = await t.api("post", `/invoices/${paid.id}/cancel`, both.token).send({ reason: "Cancelled after payment", refunds: [{ method: "CASH", amount: "250" }] });
      assert.equal(wrong.status, 409, "partial refund does not cancel");
      const mismatch = await t.api("post", `/invoices/${paid.id}/cancel`, both.token).send({ reason: "Cancelled after payment", refunds: [{ method: "CASH", amount: "400" }] });
      assert.equal(mismatch.status, 409, "400 cash was never taken in cash");
      const ok = await t.api("post", `/invoices/${paid.id}/cancel`, both.token).send({ reason: "Cancelled after payment", refunds: [{ method: "CASH", amount: "250" }, { method: "UPI", amount: "150", reference: "UPIREFUND9" }] });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.status, "REFUNDED");
      assert.equal(ok.body.data.netReceived, "0.00");
      assert.equal(ok.body.data.refundedTotal, "400.00");
      assert.equal(ok.body.data.refunds.length, 2);
      assert.ok(ok.body.data.refunds.every((r: { cancelsInvoice: boolean }) => r.cancelsInvoice));
      assert.equal((await pay(paid.id, [{ method: "CASH", amount: "1" }])).status, 409);
      await assert.rejects(() => t.prisma.invoice.update({ where: { id: paid.id }, data: { paidTotal: 999 } }), /cannot take further money|do not reconcile/);
      const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "INVOICE_CANCELLED", entityId: paid.id } });
      assert.equal(evt.actorUserId, both.id);
      assert.equal((evt.metadata as { reason: string }).reason, "Cancelled after payment");
    });

    it("drafts can be cancelled too (kept, numberless); refunds in cash need an open shift", async () => {
      const d = await draft((await registerPatient(t, rec.token)).id, [{ serviceId: svc.consult, quantity: 1 }]);
      const c = await t.api("post", `/invoices/${d.id}/cancel`, manager.token).send({ reason: "Created for wrong patient" });
      assert.equal(c.body.data.status, "CANCELLED");
      assert.equal(c.body.data.invoiceNumber, null);
      const own = await t.makeUser(a, ["CASHIER"]);
      await openShift(own.token);
      const i = await issued("100.00");
      await pay(i.id, [{ method: "CASH", amount: "100" }], key(), own.token);
      await credit(i.id, "40");
      await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" });
      const closed = await t.api("get", "/shifts/current", own.token);
      await t.api("post", `/shifts/${closed.body.data.id}/close`, own.token).send({ actualCash: "1100.00" });
      const noShift = await refund(i.id, { method: "CASH", amount: "40", reason: "Cash refund no shift" }, key(), own.token);
      assert.equal(noShift.status, 409);
      assert.equal(noShift.body.error.code, "SHIFT_NOT_OPEN");
    });

    it("every refund and credit note is attributable: who, why, when, against which invoice", async () => {
      await openShift().catch(() => undefined);
      const i = await issued("500.00");
      await pay(i.id, [{ method: "CASH", amount: "500" }]);
      await credit(i.id, "100", "Wrong rate applied");
      await refund(i.id, { method: "CASH", amount: "100", reason: "Rate correction refund" });
      const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, entityId: i.id, action: { in: ["CREDIT_NOTE_CREATED", "REFUND_CREATED"] } } });
      assert.equal(evts.length, 2);
      assert.deepEqual(evts.map((e) => e.actorUserId).sort(), [cashier.id, manager.id].sort());
      assert.ok(evts.every((e) => (e.metadata as { reason: string }).reason));
      const full = await inv(i.id);
      assert.equal(full.creditNotes[0].reason, "Wrong rate applied");
      assert.equal(full.refunds[0].reason, "Rate correction refund");
    });
  });

  // ───────────────────────── cashier shifts ─────────────────────────
  describe("cashier shifts", () => {
    it("opens one shift per cashier; closing reconciles opening cash + cash receipts - cash refunds, ignoring non-cash", async () => {
      const own = await t.makeUser(a, ["CASHIER"]);
      assert.equal((await t.api("get", "/shifts/current", own.token)).body.data, null);
      const open = await t.api("post", "/shifts/open", own.token).send({ openingCash: "2000.00" });
      assert.equal(open.status, 201);
      assert.equal(open.body.data.status, "OPEN");
      assert.equal((await t.api("post", "/shifts/open", own.token).send({ openingCash: "5" })).status, 409, "already open");
      const i = await issued("1500.00");
      await pay(i.id, [{ method: "CASH", amount: "600" }, { method: "UPI", amount: "400", reference: "UPI111222" }], key(), own.token);
      const j = await issued("800.00");
      await pay(j.id, [{ method: "CASH", amount: "800" }], key(), own.token);
      await t.api("post", `/invoices/${j.id}/credit-notes`, manager.token).set("Idempotency-Key", key()).send({ amount: "100", reason: "Billing correction" });
      await t.api("post", `/invoices/${j.id}/refunds`, own.token).set("Idempotency-Key", key()).send({ method: "CASH", amount: "100", reason: "Billing correction refund" });
      const live = (await t.api("get", "/shifts/current", own.token)).body.data;
      assert.equal(live.expectedCash, "3300.00", "2000 + 600 + 800 - 100");
      assert.equal(live.collectionsByMethod.CASH, "1400.00");
      assert.equal(live.collectionsByMethod.UPI, "400.00");
      assert.equal(live.refundsByMethod.CASH, "100.00");
      assert.equal(live.netCollections, "1700.00");
      assert.equal(live.receiptCount, 2);

      const short = await t.api("post", `/shifts/${live.id}/close`, own.token).send({ actualCash: "3250.00" });
      assert.equal(short.status, 400);
      assert.match(short.body.error.message, /differs from the expected 3300\.00 by -50\.00/);
      const closed = await t.api("post", `/shifts/${live.id}/close`, own.token).send({ actualCash: "3250.00", notes: "Counted short by fifty rupees" });
      assert.equal(closed.status, 200);
      assert.equal(closed.body.data.status, "CLOSED");
      assert.equal(closed.body.data.expectedCash, "3300.00");
      assert.equal(closed.body.data.difference, "-50.00");
      assert.equal((await t.api("post", `/shifts/${live.id}/close`, own.token).send({ actualCash: "3300", notes: "closing again" })).status, 409);
      assert.equal((await t.api("get", "/shifts/current", own.token)).body.data, null);
      assert.equal((await t.api("post", "/shifts/open", own.token).send({ openingCash: "0" })).status, 201, "a new shift can start after closing");
    });

    it("an exactly reconciled shift closes without notes; negative or malformed cash is rejected", async () => {
      const own = await t.makeUser(a, ["CASHIER"]);
      const s = await t.api("post", "/shifts/open", own.token).send({ openingCash: "500" });
      for (const bad of [{ openingCash: "-1" }, { openingCash: "1.234" }, { openingCash: "abc" }, { openingCash: "5", extra: 1 }]) {
        assert.equal((await t.api("post", "/shifts/open", own.token).send(bad)).status, 400);
      }
      assert.equal((await t.api("post", `/shifts/${s.body.data.id}/close`, own.token).send({ actualCash: "-5" })).status, 400);
      const ok = await t.api("post", `/shifts/${s.body.data.id}/close`, own.token).send({ actualCash: "500" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.difference, "0.00");
    });

    it("only the owner can close a shift; shifts are permission-gated and tenant/facility isolated", async () => {
      const own = await t.makeUser(a, ["CASHIER"]);
      const other = await t.makeUser(a, ["CASHIER"]);
      const s = (await t.api("post", "/shifts/open", own.token).send({ openingCash: "100" })).body.data;
      assert.equal((await t.api("post", `/shifts/${s.id}/close`, other.token).send({ actualCash: "100" })).status, 403);
      assert.equal((await t.api("get", `/shifts/${s.id}`, other.token)).status, 403, "cashiers see only their own shifts");
      assert.equal((await t.api("get", "/shifts", other.token)).body.data.length, 0);
      for (const u of [manager, await t.makeUser(a, ["NURSE"])]) assert.equal((await t.api("post", "/shifts/open", u.token).send({ openingCash: "1" })).status, 403);
      const bCashier = await t.makeUser(b, ["CASHIER"]);
      assert.equal((await t.api("get", `/shifts/${s.id}`, bCashier.token)).status, 404);
      assert.equal((await t.api("post", `/shifts/${s.id}/close`, bCashier.token).send({ actualCash: "100" })).status, 404);
      const f2 = await t.makeUser(a, ["CASHIER"], { facilityIds: [a.facility2Id] });
      assert.equal((await t.api("get", `/shifts/${s.id}`, f2.token)).status, 404);
      assert.equal((await t.api("get", `/shifts/${randomUUID()}`, own.token)).status, 404);
    });

    it("payments after a shift is closed are refused for cash until a new shift opens; the closed shift never changes", async () => {
      const own = await t.makeUser(a, ["CASHIER"]);
      const s = (await t.api("post", "/shifts/open", own.token).send({ openingCash: "0" })).body.data;
      const i = await issued("300.00");
      await pay(i.id, [{ method: "CASH", amount: "100" }], key(), own.token);
      await t.api("post", `/shifts/${s.id}/close`, own.token).send({ actualCash: "100" });
      assert.equal((await pay(i.id, [{ method: "CASH", amount: "100" }], key(), own.token)).body.error.code, "SHIFT_NOT_OPEN");
      assert.equal((await pay(i.id, [{ method: "UPI", amount: "100", reference: "UPI303030" }], key(), own.token)).status, 201, "non-cash still works, attached to no shift");
      const closed = await t.api("get", `/shifts/${s.id}`, own.token);
      assert.equal(closed.body.data.expectedCash, "100.00");
      await assert.rejects(() => t.prisma.cashierShift.update({ where: { id: s.id }, data: { actualCash: 9999, difference: 9899 } }), /closed cashier shift cannot be modified/);
      await assert.rejects(() => t.prisma.cashierShift.delete({ where: { id: s.id } }), /append-only/);
      await assert.rejects(() => t.prisma.cashierShift.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, cashierId: own.id, openingCash: 1 } }).then(() => t.prisma.cashierShift.create({ data: { tenantId: a.tenantId, facilityId: a.facilityId, cashierId: own.id, openingCash: 1 } })), /Unique|unique/);
    });

    it("a payment racing with shift close is either counted in the shift or refused: the books always agree", async () => {
      for (let round = 0; round < 3; round++) {
        const own = await t.makeUser(a, ["CASHIER"]);
        const s = (await t.api("post", "/shifts/open", own.token).send({ openingCash: "100" })).body.data;
        const invoices = await Promise.all(Array.from({ length: 5 }, () => issued("10.00")));
        const [closeRes, ...payRes] = await Promise.all([
          t.api("post", `/shifts/${s.id}/close`, own.token).send({ actualCash: "0", notes: "Racing close, counts are checked afterwards" }),
          ...invoices.map((i) => pay(i.id, [{ method: "CASH", amount: "10" }], key(), own.token)),
        ]);
        assert.equal(closeRes.status, 200);
        const shift = await t.prisma.cashierShift.findFirstOrThrow({ where: { id: s.id } });
        const counted = await t.prisma.payment.aggregate({ where: { method: "CASH", receipt: { shiftId: s.id } }, _sum: { amount: true } });
        const succeeded = payRes.filter((r) => r.status === 201).length;
        assert.equal(Number(shift.expectedCash), 100 + Number(counted._sum.amount ?? 0), "expected cash equals opening + every cash receipt attached to the shift");
        assert.equal(Number(counted._sum.amount ?? 0), succeeded * 10, "every successful payment (and only those) is attached to the shift");
        assert.ok(payRes.filter((r) => r.status !== 201).every((r) => r.body.error?.code === "SHIFT_NOT_OPEN"));
        const lateReceipts = await t.prisma.receipt.count({ where: { receivedById: own.id, shiftId: s.id, receivedAt: { gt: shift.closedAt! } } });
        assert.equal(lateReceipts, 0, "nothing was recorded against the shift after it closed");
      }
    });
  });

  // ───────────────────────── reconciliation ─────────────────────────
  it("financial reconciliation: after a mixed workload every invoice total equals the sum of its ledger rows", async () => {
    await openShift().catch(() => undefined);
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) ids.push((await issued((100 + n * 37.5).toFixed(2))).id);
    for (const [n, id] of ids.entries()) {
      const total = new Decimal(100 + n * 37.5);
      await pay(id, [{ method: "CASH", amount: total.div(2).toFixed(2) }]);
      if (n % 2 === 0) { await pay(id, [{ method: "UPI", amount: total.div(2).toFixed(2), reference: `UPI-R-${n}0000` }]); await t.api("post", `/invoices/${id}/credit-notes`, manager.token).set("Idempotency-Key", key()).send({ amount: "10", reason: "Reconciliation test credit" }); await t.api("post", `/invoices/${id}/refunds`, cashier.token).set("Idempotency-Key", key()).send({ method: "UPI", amount: "10", reason: "Reconciliation test refund", reference: "UPIREFUND1" }); }
    }
    for (const id of ids) {
      const row = await t.prisma.invoice.findFirstOrThrow({ where: { id } });
      const paid = await t.prisma.receipt.aggregate({ where: { invoiceId: id }, _sum: { total: true } });
      const tender = await t.prisma.payment.aggregate({ where: { receipt: { invoiceId: id } }, _sum: { amount: true } });
      const refunded = await t.prisma.refund.aggregate({ where: { invoiceId: id }, _sum: { amount: true } });
      const credited = await t.prisma.creditNote.aggregate({ where: { invoiceId: id }, _sum: { amount: true } });
      assert.equal(row.paidTotal.toFixed(2), new Decimal(paid._sum.total?.toString() ?? 0).toFixed(2));
      assert.equal(row.paidTotal.toFixed(2), new Decimal(tender._sum.amount?.toString() ?? 0).toFixed(2), "receipts equal their tender lines");
      assert.equal(row.refundedTotal.toFixed(2), new Decimal(refunded._sum.amount?.toString() ?? 0).toFixed(2));
      assert.equal(row.creditedTotal.toFixed(2), new Decimal(credited._sum.amount?.toString() ?? 0).toFixed(2));
      const lines = await t.prisma.invoiceLine.aggregate({ where: { invoiceId: id }, _sum: { lineTotal: true } });
      assert.equal(row.total.toFixed(2), new Decimal(lines._sum.lineTotal?.toString() ?? 0).toFixed(2), "invoice total equals the sum of its lines");
    }
  });

  it("the audit log carries tenant, facility, actor and request id for money events and holds no card/UPI references", async () => {
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: a.tenantId, action: { in: ["PAYMENT_RECEIVED", "REFUND_CREATED", "CREDIT_NOTE_CREATED", "INVOICE_ISSUED", "SHIFT_CLOSED"] } } });
    assert.ok(evts.length > 20);
    assert.ok(evts.every((e) => e.actorUserId && e.facilityId === a.facilityId && e.requestId));
    assert.ok(!JSON.stringify(evts.map((e) => e.metadata)).match(/UPI\d{5}|CARD0001/));
  });
});
