import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

interface World { tenant: TestTenant; rec: { id: string; token: string }; doc: TestDoctor; rmo: { id: string; token: string }; coord: { id: string; token: string }; nurse: { id: string; token: string }; cashier: { id: string; token: string } }
const code = (p: string) => `${p}${uniqueWord(5).toUpperCase()}`;

describe("procedures: planned by the doctor, performed and finalised by the OT / procedure coordinator", () => {
  let t: TestApp;
  const world = async (label: string): Promise<World> => {
    const tenant = await t.makeTenant(label);
    return {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), doc: await makeDoctor(t, tenant), rmo: await t.makeUser(tenant, ["RMO"]),
      coord: await t.makeUser(tenant, ["OT_COORDINATOR"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]),
    };
  };
  const svc = async (x: World, name: string, category: string, price: string, tax = "0") => (await t.api("post", "/services", x.tenant.admin.token).send({ code: code("S"), name, category, price, taxPercent: tax })).body.data as { id: string; name: string };
  const admit = async (x: World) => {
    const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, x.rec.token);
    const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Acute appendicitis" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, adm: r.body.data as { id: string; encounterId: string } };
  };
  const plan = (admId: string, tok: string, body: Record<string, unknown>) => t.api("post", `/admissions/${admId}/procedures`, tok).send(body);
  const list = async (admId: string, tok: string) => (await t.api("get", `/admissions/${admId}/procedures`, tok)).body.data as { id: string; name: string; status: string; amount: string | null; items: { id: string; kind: string; name: string; quantity: number; serialNo: string | null; removed: boolean }[] }[];

  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  it("plan, perform, record implants and consumables, finalise: each step charges the admission and the record then freezes", async () => {
    const x = await world("proc-flow");
    const appen = await svc(x, `Appendectomy ${uniqueWord(4)}`, "PROCEDURE", "15000");
    const plate = await svc(x, `Plate and screws ${uniqueWord(4)}`, "OTHER", "8500");
    const kit = await svc(x, `Consumables kit ${uniqueWord(4)}`, "OTHER", "1800");
    const consult = await svc(x, `Consultation ${uniqueWord(4)}`, "CONSULTATION", "500");
    const { adm } = await admit(x);

    // Planning: the doctor and the RMO may; a nurse, a cashier and a receptionist may not. The procedure must come from the price list.
    assert.equal((await plan(adm.id, x.nurse.token, { serviceId: appen.id })).status, 403);
    assert.equal((await plan(adm.id, x.cashier.token, { serviceId: appen.id })).status, 403);
    assert.equal((await plan(adm.id, x.rec.token, { serviceId: appen.id })).status, 403);
    assert.equal((await plan(adm.id, x.doc.token, { serviceId: consult.id })).status, 400, "only a procedure from the price list");
    assert.equal((await plan(adm.id, x.doc.token, { serviceId: "00000000-0000-4000-8000-000000000000" })).status, 400);
    assert.equal((await plan(adm.id, x.doc.token, { serviceId: appen.id, surgeonId: "00000000-0000-4000-8000-000000000000" })).status, 400, "the surgeon must be a real practitioner");
    assert.equal((await plan(adm.id, x.doc.token, { serviceId: appen.id, extra: true })).status, 400, "unknown fields are refused");
    const p = await plan(adm.id, x.doc.token, { serviceId: appen.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), surgeonId: x.doc.practitionerId, notes: "Laparoscopic" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const pid = p.body.data.id as string;
    assert.equal(p.body.data.status, "PLANNED");
    assert.equal((await plan(adm.id, x.rmo.token, { serviceId: appen.id })).status, 201, "the RMO may plan too");
    assert.equal((await t.api("get", `/admissions/${adm.id}/procedures`, x.nurse.token)).status, 200, "a nurse can see them");
    assert.equal((await t.api("get", `/admissions/${adm.id}/procedures`, x.cashier.token)).status, 403, "a cashier cannot");
    assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id } }), 0, "planning charges nothing");

    // Performing is the coordinator's: it posts the procedure's own charge.
    assert.equal((await t.api("post", `/procedures/${pid}/perform`, x.doc.token).send({})).status, 403, "the doctor cannot mark it performed");
    assert.equal((await t.api("post", `/procedures/${pid}/finalise`, x.coord.token)).status, 409, "perform it before finalising");
    const done = await t.api("post", `/procedures/${pid}/perform`, x.coord.token).send({});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const pc = await t.prisma.charge.findFirstOrThrow({ where: { admissionId: adm.id, sourceKey: `PROCEDURE:${pid}` } });
    assert.equal(pc.type, "PROCEDURE"); assert.equal(pc.status, "PENDING"); assert.equal(Number(pc.unitPrice), 15000); assert.equal(pc.serviceId, appen.id);
    assert.equal((await t.api("post", `/procedures/${pid}/perform`, x.coord.token).send({})).status, 409, "performed once");

    // Implants need a serial or lot number; consumables do not. Each is a price-list item and carries its charge.
    const item = (body: Record<string, unknown>, tok = x.coord.token) => t.api("post", `/procedures/${pid}/items`, tok).send(body);
    assert.equal((await item({ kind: "IMPLANT", serviceId: plate.id, quantity: 1 })).status, 400, "an implant without a serial number");
    assert.equal((await item({ kind: "IMPLANT", serviceId: plate.id, quantity: 0, serialNo: "SN-1" })).status, 400);
    assert.equal((await item({ kind: "IMPLANT", serviceId: "00000000-0000-4000-8000-000000000000", quantity: 1, serialNo: "SN-1" })).status, 400);
    assert.equal((await item({ kind: "IMPLANT", serviceId: plate.id, quantity: 1, serialNo: "SN-1" }, x.doc.token)).status, 403, "only the coordinator records items");
    const imp = await item({ kind: "IMPLANT", serviceId: plate.id, quantity: 1, serialNo: "SN-2026-0417" });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    const con = await item({ kind: "CONSUMABLE", serviceId: kit.id, quantity: 2 });
    assert.equal(con.status, 201, JSON.stringify(con.body));
    const ic = await t.prisma.charge.findFirstOrThrow({ where: { admissionId: adm.id, sourceKey: `PROCEDURE_ITEM:${imp.body.data.id}` } });
    assert.equal(ic.type, "SERVICE"); assert.equal(Number(ic.unitPrice), 8500); assert.match(ic.description, /Implant: .*\(SN-2026-0417\)/);
    const cc = await t.prisma.charge.findFirstOrThrow({ where: { admissionId: adm.id, sourceKey: `PROCEDURE_ITEM:${con.body.data.id}` } });
    assert.equal(Number(cc.quantity), 2); assert.equal(Number(cc.unitPrice), 1800);

    // An item recorded in error is removed with a reason: its charge is voided, the row stays.
    const wrong = await item({ kind: "CONSUMABLE", serviceId: kit.id, quantity: 1 });
    assert.equal((await t.api("post", `/procedures/${pid}/items/${wrong.body.data.id}/remove`, x.coord.token).send({ reason: "x" })).status, 400, "a reason is needed");
    assert.equal((await t.api("post", `/procedures/${pid}/items/${wrong.body.data.id}/remove`, x.coord.token).send({ reason: "Recorded twice by mistake" })).status, 200);
    assert.equal((await t.prisma.charge.findFirstOrThrow({ where: { sourceKey: `PROCEDURE_ITEM:${wrong.body.data.id}` } })).status, "VOIDED");
    assert.equal((await t.api("post", `/procedures/${pid}/items/${wrong.body.data.id}/remove`, x.coord.token).send({ reason: "Again" })).status, 409, "removed once");
    const view = (await list(adm.id, x.doc.token)).find((v) => v.id === pid)!;
    assert.equal(view.amount, "15000.00");
    assert.deepEqual(view.items.filter((i) => !i.removed).map((i) => [i.kind, i.quantity, i.serialNo]), [["IMPLANT", 1, "SN-2026-0417"], ["CONSUMABLE", 2, null]]);
    assert.equal(view.items.filter((i) => i.removed).length, 1);

    // Finalising is the coordinator's, and after it nothing can change: not through the API, and not in the database either.
    assert.equal((await t.api("post", `/procedures/${pid}/finalise`, x.doc.token)).status, 403);
    assert.equal((await t.api("post", `/procedures/${pid}/finalise`, x.coord.token)).status, 200);
    assert.equal((await list(adm.id, x.doc.token)).find((v) => v.id === pid)!.status, "FINALISED");
    assert.equal((await item({ kind: "CONSUMABLE", serviceId: kit.id, quantity: 1 })).status, 409, "no more items once finalised");
    assert.equal((await t.api("post", `/procedures/${pid}/items/${imp.body.data.id}/remove`, x.coord.token).send({ reason: "Too late to change" })).status, 409);
    assert.equal((await t.api("post", `/procedures/${pid}/finalise`, x.coord.token)).status, 409, "finalised once");
    assert.equal((await t.api("post", `/procedures/${pid}/cancel`, x.doc.token).send({ reason: "Changed my mind" })).status, 409, "a finalised procedure cannot be cancelled");
    await assert.rejects(() => t.prisma.procedure.update({ where: { id: pid }, data: { notes: "edited afterwards" } }), "the database refuses to change a finalised procedure");
    await assert.rejects(() => t.prisma.procedureItem.update({ where: { id: imp.body.data.id }, data: { serialNo: "CHANGED" } }), "nor its implants");
    await assert.rejects(() => t.prisma.procedureItem.create({ data: { tenantId: x.tenant.tenantId, procedureId: pid, kind: "CONSUMABLE", serviceId: kit.id, name: "Late", quantity: 1, chargeId: ic.id, recordedById: x.coord.id } }), "nor a new item");
    await assert.rejects(() => t.prisma.procedure.delete({ where: { id: pid } }), "nor delete it");

    // Everything is in the audit trail.
    for (const [action, n] of [["PROCEDURE_PLANNED", 2], ["PROCEDURE_PERFORMED", 1], ["PROCEDURE_ITEM_RECORDED", 3], ["PROCEDURE_ITEM_REMOVED", 1], ["PROCEDURE_FINALISED", 1]] as const) {
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: x.tenant.tenantId, action } }), n, action);
    }
  });

  it("a planned procedure can be cancelled with a reason, which takes anything recorded against it off the bill; a performed one cannot", async () => {
    const x = await world("proc-cancel");
    const appen = await svc(x, `Hernia repair ${uniqueWord(4)}`, "PROCEDURE", "18000"); const kit = await svc(x, `Kit ${uniqueWord(4)}`, "OTHER", "900");
    const { adm } = await admit(x);
    const a = (await plan(adm.id, x.doc.token, { serviceId: appen.id })).body.data.id as string;
    const it1 = await t.api("post", `/procedures/${a}/items`, x.coord.token).send({ kind: "CONSUMABLE", serviceId: kit.id, quantity: 3 });
    assert.equal(it1.status, 201, "items can be recorded while the procedure is only planned");
    assert.equal((await t.api("post", `/procedures/${a}/cancel`, x.nurse.token).send({ reason: "Patient refused" })).status, 403);
    assert.equal((await t.api("post", `/procedures/${a}/cancel`, x.doc.token).send({ reason: "no" })).status, 400, "a real reason");
    assert.equal((await t.api("post", `/procedures/${a}/cancel`, x.doc.token).send({ reason: "Patient refused the operation" })).status, 200);
    assert.equal((await t.prisma.charge.findFirstOrThrow({ where: { sourceKey: `PROCEDURE_ITEM:${it1.body.data.id}` } })).status, "VOIDED");
    const v = (await list(adm.id, x.doc.token)).find((p) => p.id === a)!;
    assert.equal(v.status, "CANCELLED"); assert.equal(v.items.every((i) => i.removed), true);
    assert.equal((await t.api("post", `/procedures/${a}/perform`, x.coord.token).send({})).status, 409, "a cancelled procedure cannot be performed");
    assert.equal((await t.api("post", `/procedures/${a}/cancel`, x.doc.token).send({ reason: "Cancel again" })).status, 409);

    const b = (await plan(adm.id, x.doc.token, { serviceId: appen.id })).body.data.id as string;
    assert.equal((await t.api("post", `/procedures/${b}/perform`, x.coord.token).send({})).status, 200);
    const refused = await t.api("post", `/procedures/${b}/cancel`, x.doc.token).send({ reason: "Changed my mind" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /performed procedure cannot be cancelled/);
  });

  it("two coordinators performing the same procedure at once charge it exactly once", async () => {
    const x = await world("proc-race");
    const coord2 = await t.makeUser(x.tenant, ["OT_COORDINATOR"]);
    const appen = await svc(x, `Procedure ${uniqueWord(4)}`, "PROCEDURE", "5000");
    const { adm } = await admit(x);
    const pid = (await plan(adm.id, x.doc.token, { serviceId: appen.id })).body.data.id as string;
    const rs = await Promise.all([x.coord, coord2, x.coord, coord2].map((u) => t.api("post", `/procedures/${pid}/perform`, u.token).send({})));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join());
    assert.equal(rs.filter((r) => r.status === 409).length, 3);
    assert.equal(await t.prisma.charge.count({ where: { admissionId: adm.id, sourceKey: `PROCEDURE:${pid}` } }), 1);
  });

  it("another hospital's procedure and another doctor's patient stay hidden; a closed admission and a finished bill take no changes", async () => {
    const x = await world("proc-scope"); const y = await world("proc-scope-b");
    const appen = await svc(x, `Procedure ${uniqueWord(4)}`, "PROCEDURE", "5000");
    const { adm } = await admit(x);
    const pid = (await plan(adm.id, x.doc.token, { serviceId: appen.id })).body.data.id as string;

    // Hospital B sees nothing of hospital A's.
    assert.equal((await t.api("get", `/admissions/${adm.id}/procedures`, y.coord.token)).status, 404);
    assert.equal((await t.api("post", `/procedures/${pid}/perform`, y.coord.token).send({})).status, 404);
    assert.equal((await t.api("post", `/procedures/${pid}/finalise`, y.coord.token)).status, 404);
    assert.equal((await t.api("post", `/procedures/${pid}/cancel`, y.doc.token).send({ reason: "Not yours to cancel" })).status, 404);
    // A doctor who is not treating this patient does not see the admission's procedures.
    const other = await makeDoctor(t, x.tenant);
    assert.equal((await t.api("get", `/admissions/${adm.id}/procedures`, other.token)).status, 404);
    assert.equal((await plan(adm.id, other.token, { serviceId: appen.id })).status, 404);

    // A closed admission takes no changes.
    await t.prisma.admission.update({ where: { id: adm.id }, data: { status: "DISCHARGED", dischargedAt: new Date(), dischargeType: "ROUTINE" } });
    assert.equal((await plan(adm.id, x.doc.token, { serviceId: appen.id })).status, 409);
    assert.equal((await t.api("post", `/procedures/${pid}/perform`, x.coord.token).send({})).status, 409);
  });
});
