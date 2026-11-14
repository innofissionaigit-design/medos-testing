import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerPatient, startApp, uniqueWord, type TestApp, type TestTenant } from "../../test/harness";

type User = { id: string; token: string };

/** OPD and IPD services are kept apart: the OPD price list has no surgery, and an OPD bill cannot carry one. */
describe("services are OPD, IPD or both, and the two desks' bills keep to them", () => {
  let t: TestApp; let a: TestTenant; let b: TestTenant;
  let rec: User; let bRec: User;
  const svc = new Map<string, string>();

  const create = (code: string, name: string, category: string, extra: Record<string, unknown> = {}, tok = a.admin.token) =>
    t.api("post", "/services", tok).send({ code, name, category, price: "100.00", taxPercent: 0, ...extra });
  const list = async (scope?: "OPD" | "IPD", tok = rec.token) => ((await t.api("get", "/services", tok).query({ ...(scope ? { scope } : {}), pageSize: 200 })).body.data as { id: string; name: string; availableFor: string }[]);
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);
  const bill = (patientId: string, serviceId: string, kind?: string) => t.api("post", "/invoices", rec.token).send({ patientId, ...(kind ? { kind } : {}), lines: [{ serviceId, quantity: 1 }] });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("scope-a"); b = await t.makeTenant("scope-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]); bRec = await t.makeUser(b, ["RECEPTIONIST"]);
    const s = uniqueWord(4).toUpperCase();
    for (const [key, name, category, extra] of [
      ["consult", `Consultation ${s}`, "CONSULTATION", {}],
      ["ecg", `ECG ${s}`, "INVESTIGATION", {}],
      ["dressing", `Dressing ${s}`, "INJECTION_DRESSING", {}],
      ["surgery", `Appendectomy ${s}`, "PROCEDURE", {}],
      ["bed", `Ward bed ${s}`, "ROOM_BED", {}],
      ["nursing", `Nursing care ${s}`, "NURSING", {}],
      ["suture", `Minor suturing ${s}`, "PROCEDURE", { availableFor: "OPD" }],
      ["both", `Shared procedure ${s}`, "PROCEDURE", { availableFor: "BOTH" }],
    ] as [string, string, string, Record<string, unknown>][]) {
      const r = await create(`${key.toUpperCase()}${s}`, name, category, extra);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      svc.set(key, r.body.data.id);
    }
  });
  after(async () => { await t.close(); });

  it("a new service takes its desk from its category unless the administrator says otherwise", async () => {
    const all = await list();
    const of = (key: string) => all.find((x) => x.id === svc.get(key))?.availableFor;
    assert.deepEqual(["consult", "ecg", "dressing"].map(of), ["BOTH", "BOTH", "BOTH"]);
    assert.deepEqual(["surgery", "bed", "nursing"].map(of), ["IPD", "IPD", "IPD"], "surgery, room and nursing are inpatient services");
    assert.deepEqual([of("suture"), of("both")], ["OPD", "BOTH"], "set on purpose");
  });

  it("the OPD price list has no surgery or ward charges; the IPD list has no outpatient-only service", async () => {
    const opd = await list("OPD");
    for (const key of ["consult", "ecg", "dressing", "suture", "both"]) assert.ok(opd.some((x) => x.id === svc.get(key)), `OPD list should have ${key}`);
    for (const key of ["surgery", "bed", "nursing"]) assert.ok(!opd.some((x) => x.id === svc.get(key)), `OPD list must not have ${key}`);
    const ipd = await list("IPD");
    for (const key of ["surgery", "bed", "nursing", "consult", "both"]) assert.ok(ipd.some((x) => x.id === svc.get(key)), `IPD list should have ${key}`);
    assert.ok(!ipd.some((x) => x.id === svc.get("suture")), "an OPD-only service is not on the IPD list");
    assert.ok((await list()).length >= opd.length, "with no desk named, everything is listed");
    assert.equal((await t.api("get", "/services", rec.token).query({ scope: "ALL" })).status, 400, "only OPD or IPD");
  });

  it("an OPD bill refuses an inpatient service; an IPD bill refuses an outpatient-only one", async () => {
    const p = await registerPatient(t, rec.token);
    const refused = await bill(p.id, svc.get("surgery")!);
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.body), /inpatient \(IPD\) service/);
    assert.equal((await bill(p.id, svc.get("bed")!, "OPD")).status, 400);
    assert.equal((await bill(p.id, svc.get("consult")!)).status, 201, "a shared service is fine");
    assert.equal((await bill(p.id, svc.get("suture")!, "OPD")).status, 201);
    assert.equal((await bill(p.id, svc.get("surgery")!, "IPD")).status, 201, "surgery belongs on an IPD bill");
    const ipdRefused = await bill(p.id, svc.get("suture")!, "IPD");
    assert.equal(ipdRefused.status, 400);
    assert.match(JSON.stringify(ipdRefused.body), /outpatient \(OPD\) service/);
    // Other kinds of bill (pharmacy, other) are not held to a desk.
    assert.equal((await bill(p.id, svc.get("surgery")!, "OTHER")).status, 201);
  });

  it("a draft OPD bill cannot be edited to include an inpatient service", async () => {
    const p = await registerPatient(t, rec.token);
    const draft = await bill(p.id, svc.get("consult")!);
    assert.equal(draft.status, 201);
    const bad = await t.api("put", `/invoices/${draft.body.data.id}`, rec.token).send({ version: draft.body.data.version, lines: [{ serviceId: svc.get("surgery")!, quantity: 1 }] });
    assert.equal(bad.status, 400);
    const ok = await t.api("put", `/invoices/${draft.body.data.id}`, rec.token).send({ version: draft.body.data.version, lines: [{ serviceId: svc.get("ecg")!, quantity: 1 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("the administrator can move a service to another desk, and the bill rules follow", async () => {
    const p = await registerPatient(t, rec.token);
    assert.equal((await bill(p.id, svc.get("surgery")!)).status, 400);
    assert.equal((await t.api("patch", `/services/${svc.get("surgery")}`, rec.token).send({ availableFor: "BOTH" })).status, 403, "reception cannot change the price list");
    const moved = await t.api("patch", `/services/${svc.get("surgery")}`, a.admin.token).send({ availableFor: "BOTH" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.availableFor, "BOTH");
    assert.equal((await bill(p.id, svc.get("surgery")!)).status, 201);
    assert.equal((await t.api("patch", `/services/${svc.get("surgery")}`, a.admin.token).send({ availableFor: "everywhere" })).status, 400);
    assert.equal((await t.api("patch", `/services/${svc.get("surgery")}`, a.admin.token).send({ availableFor: "IPD" })).status, 200);
  });

  it("another hospital sees none of these services and cannot use them", async () => {
    assert.deepEqual(await list("OPD", bRec.token), []);
    const p = await registerPatient(t, bRec.token);
    const r = await t.api("post", "/invoices", bRec.token).send({ patientId: p.id, lines: [{ serviceId: svc.get("consult")!, quantity: 1 }] });
    assert.equal(r.status, 400, "an unknown service of another hospital");
    assert.deepEqual(names(await list("IPD", bRec.token)), []);
  });
});
