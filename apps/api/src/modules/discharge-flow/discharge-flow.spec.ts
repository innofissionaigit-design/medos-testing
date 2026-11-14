import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeDoctor, registerPatient, startApp, uniqueWord, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";
import { DischargeFlowJobsService } from "./discharge-flow-jobs.service";

let seq = 0;
const code = (p: string) => `${p}${(++seq).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4).toString(36).toUpperCase()}`.slice(0, 14);
const key = () => `k-${randomUUID().slice(0, 18)}`;
const COURSE = { hospitalCourse: "Admitted with fever and cough. Treated with IV antibiotics. Recovered well.", finalDiagnoses: [{ text: "Community-acquired pneumonia", code: "J18.9" }] };
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const plus = (min: number) => new Date(Date.now() + min * 60_000);

type U = { id: string; username: string; token: string };
interface World { tenant: TestTenant; rec: U; nurse: U; cashier: U; pharm: U; manager: U; administrator: U; officer: U; doc: TestDoctor }

/** The discharge flow (docs/discharge-flow.md): planned date, checklist and clock, who sees what, reasons, alerts, insurer clock, family sheet, report. */
describe("discharge flow: faster going home", () => {
  let t: TestApp;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  const world = async (label: string): Promise<World> => {
    const tenant = await t.makeTenant(label);
    return {
      tenant, rec: await t.makeUser(tenant, ["RECEPTIONIST"]), nurse: await t.makeUser(tenant, ["NURSE"]), cashier: await t.makeUser(tenant, ["CASHIER"]), pharm: await t.makeUser(tenant, ["PHARMACIST"]),
      manager: await t.makeUser(tenant, ["MANAGER"]), administrator: await t.makeUser(tenant, ["ADMINISTRATOR"]), officer: await t.makeUser(tenant, ["CLAIMS_OFFICER"]), doc: await makeDoctor(t, tenant),
    };
  };
  const admit = async (x: World) => {
    const ward = (await t.api("post", "/wards", x.tenant.admin.token).send({ name: `Ward ${uniqueWord(4)}`, code: code("W") })).body.data;
    const room = (await t.api("post", "/rooms", x.tenant.admin.token).send({ wardId: ward.id, name: "Room", code: code("R") })).body.data;
    const bed = (await t.api("post", "/beds", x.tenant.admin.token).send({ roomId: room.id, code: code("B"), dailyRate: "1000" })).body.data;
    const patient = await registerPatient(t, x.rec.token);
    const r = await t.api("post", "/admissions", x.rec.token).send({ patientId: patient.id, consultantId: x.doc.practitionerId, bedId: bed.id, reason: "Pneumonia needing IV antibiotics" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { patient, bed, adm: r.body.data as { id: string; encounterId: string; admissionNumber: string } };
  };
  const flow = async (tok: string, admId: string) => { const r = await t.api("get", `/admissions/${admId}/discharge-flow`, tok); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };
  const clear = (admId: string, step: string, tok: string) => t.api("post", `/admissions/${admId}/discharge/clear`, tok).send({ step });
  interface Item { stage: string; mine: boolean; reason: { code: string } | null }
  /** The checklist item of a stage; undefined when that stage is not pending. */
  const stage = (f: { items: Item[] }, s: string): Item | undefined => f.items.find((i) => i.stage === s);
  const must = (f: { items: Item[] }, s: string): Item => { const i = stage(f, s); assert.ok(i, `${s} should be on the checklist`); return i; };
  const notes = async (tok: string, type: string) => ((await t.api("get", "/notifications", tok).query({ pageSize: 100 })).body.data as { type: string; entityId: string }[]).filter((n) => n.type === type);
  const sign = async (x: World, admId: string) => {
    const d = await t.api("put", `/admissions/${admId}/discharge-summary`, x.doc.token).send({ content: COURSE });
    assert.equal((await t.api("post", `/admissions/${admId}/discharge-summary/sign`, x.doc.token).send({ version: d.body.data.version })).status, 200);
  };

  it("1-3: a planned date; no clock until the doctor says fit; a checklist with owner and deadline; each person sees their own work", async () => {
    const x = await world("flow-a");
    const { adm } = await admit(x);

    // 1. The doctor plans the going-home date; nobody else may; it cannot be before the admission.
    assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-plan`, x.nurse.token).send({ expectedDate: iso(2) })).status, 403);
    assert.equal((await t.api("put", `/admissions/${adm.id}/discharge-plan`, x.doc.token).send({ expectedDate: iso(-5) })).status, 400);
    const planned = await t.api("put", `/admissions/${adm.id}/discharge-plan`, x.doc.token).send({ expectedDate: iso(2), note: "Antibiotics end in 2 days" });
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    let f = await flow(x.nurse.token, adm.id);
    assert.equal(f.plan.expectedDate, iso(2));

    // The firm rule: a plan is not a decision. No clock, no checklist, nobody waiting, until the doctor says fit.
    assert.equal(f.fitToGo, null);
    assert.equal(f.clock.running, false);
    assert.equal(f.items.length, 0);
    assert.equal(await t.prisma.dischargeClearance.count({ where: { admissionId: adm.id } }), 0);
    const board0 = (await t.api("get", "/discharge-flow/board", x.doc.token)).body.data;
    assert.ok(!board0.waiting.some((w: { admissionId: string }) => w.admissionId === adm.id));
    // Only the doctor can say fit: the nurse, cashier, pharmacist and receptionist are all refused.
    for (const u of [x.nurse, x.cashier, x.pharm, x.rec]) assert.equal((await clear(adm.id, "MEDICALLY_FIT", u.token)).status, 403);

    // 2. The doctor says fit: the checklist appears, with who must do what.
    assert.equal((await clear(adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
    f = await flow(x.nurse.token, adm.id);
    assert.ok(f.fitToGo.at);
    assert.equal(f.clock.running, true);
    for (const s of ["NURSING", "CHARGES_REVIEWED", "SUMMARY", "EXIT"]) assert.ok(stage(f, s), `${s} is on the checklist`);

    // 3. Owner and deadline on every item: the deadline is the doctor's "fit" time plus the target (2 hours).
    for (const i of f.items) {
      assert.ok(i.owner, `${i.stage} has an owner`);
      assert.equal(new Date(i.deadline).getTime() - new Date(f.fitToGo.at).getTime(), 120 * 60_000, `${i.stage} deadline is 2 hours after fit`);
    }
    // Each person sees only their own pending work.
    assert.equal(must(f, "NURSING").mine, true);
    const asPharmacist = await flow(x.pharm.token, adm.id);
    assert.equal(must(asPharmacist, "NURSING").mine, false, "the pharmacist does not own the nursing step");
    assert.equal(must(asPharmacist, "SUMMARY").mine, false);
    const nurseWork = (await t.api("get", "/discharge-flow/my-work", x.nurse.token)).body.data.items as { stage: string; admissionId: string }[];
    assert.ok(nurseWork.some((i) => i.admissionId === adm.id && i.stage === "NURSING"));
    const pharmWork = (await t.api("get", "/discharge-flow/my-work", x.pharm.token)).body.data.items as { stage: string; admissionId: string }[];
    assert.ok(!pharmWork.some((i) => i.admissionId === adm.id && i.stage === "NURSING"), "the pharmacist is not shown the nurse's work");
    const cashierWork = (await t.api("get", "/discharge-flow/my-work", x.cashier.token)).body.data.items as { stage: string; admissionId: string }[];
    assert.ok(cashierWork.some((i) => i.admissionId === adm.id && i.stage === "CHARGES_REVIEWED"));
    assert.ok(!cashierWork.some((i) => i.admissionId === adm.id && i.stage === "NURSING"), "the cashier is not shown the nurse's work");

    // Clearing a stage takes it off the list.
    assert.equal((await clear(adm.id, "NURSING", x.nurse.token)).status, 200);
    assert.ok(!stage(await flow(x.doc.token, adm.id), "NURSING"));
  });

  it("6, 8, 12: the waiting board, reasons for delay, and the family's sheet in three languages", async () => {
    const x = await world("flow-b");
    const y = await world("flow-b2");
    const { adm } = await admit(x);
    assert.equal((await clear(adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
    const patientName = (await flow(x.nurse.token, adm.id)).patientName as string;
    assert.ok(patientName.length > 1);

    // 8. A reason only for a stage that is really stuck; the right team (or the doctor) gives it; "Other" needs words; the newest stands.
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.cashier.token).send({ stage: "NURSING", reason: "WAITING_FOR_DOCTOR" })).status, 403);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.nurse.token).send({ stage: "NURSING", reason: "OTHER" })).status, 400);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.nurse.token).send({ stage: "PHARMACY", reason: "WAITING_FOR_MEDICINES" })).status, 403, "the nurse does not own pharmacy");
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.pharm.token).send({ stage: "PHARMACY", reason: "WAITING_FOR_MEDICINES" })).status, 409, "pharmacy is not waiting for anything");
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.nurse.token).send({ stage: "NURSING", reason: "WAITING_FOR_DOCTOR" })).status, 200);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.cashier.token).send({ stage: "CHARGES_REVIEWED", reason: "FAMILY_ARRANGING_MONEY" })).status, 200);
    const again = await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.nurse.token).send({ stage: "NURSING", reason: "OTHER", note: "Waiting for a wheelchair" });
    assert.equal(again.status, 200);
    assert.equal(must(again.body.data, "NURSING").reason?.code, "OTHER");
    assert.equal(await t.prisma.dischargeDelay.count({ where: { admissionId: adm.id, stage: "NURSING" } }), 2, "both answers are kept");
    await assert.rejects(() => t.prisma.$executeRaw`UPDATE "DischargeDelay" SET "stage" = 'X' WHERE "admissionId" = ${adm.id}::uuid`, "reasons are append-only");

    // 6. The board lists the patient with what holds them up and for how long; another hospital sees nothing of it.
    const board = (await t.api("get", "/discharge-flow/board", x.doc.token)).body.data;
    const row = board.waiting.find((w: { admissionId: string }) => w.admissionId === adm.id);
    assert.ok(row, "the patient is on the board");
    assert.ok(row.bed, "with the bed");
    assert.ok(row.clock.elapsedMinutes >= 0);
    assert.equal(must(row, "CHARGES_REVIEWED").reason?.code, "FAMILY_ARRANGING_MONEY");
    assert.equal((await t.api("get", "/discharge-flow/board", y.doc.token)).body.data.waiting.some((w: { admissionId: string }) => w.admissionId === adm.id), false);
    assert.equal((await t.api("get", `/admissions/${adm.id}/discharge-flow`, y.doc.token)).status, 404);

    // 12. The family's sheet: what is pending, who handles it, and why; in English, Hindi and Bengali. No money, no free-text note.
    for (const lang of ["en", "hi", "bn"]) {
      const r = await t.api("get", `/admissions/${adm.id}/discharge-flow/family-sheet`, x.nurse.token).query({ lang });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const text = (r.body.data.lines as string[]).join("\n");
      assert.ok(text.includes(patientName), `${lang}: names the patient`);
      assert.ok(r.body.data.pending.length >= 2, `${lang}: lists what is pending`);
      assert.ok(!text.includes("wheelchair"), `${lang}: never shows the staff's free-text note`);
      assert.ok(!/₹|\d+\.\d{2}/.test(text), `${lang}: no amounts`);
    }
    assert.match((await t.api("get", `/admissions/${adm.id}/discharge-flow/family-sheet`, x.nurse.token).query({ lang: "hi" })).body.data.lines.join(" "), /[ऀ-ॿ]/);
    assert.match((await t.api("get", `/admissions/${adm.id}/discharge-flow/family-sheet`, x.nurse.token).query({ lang: "bn" })).body.data.lines.join(" "), /[ঀ-৿]/);
    assert.equal((await t.api("get", `/admissions/${adm.id}/discharge-flow/family-sheet`, x.nurse.token).query({ lang: "fr" })).status, 400);
  });

  it("4: reminder at 90 minutes, department head at 120, administrator after; each once; only the right people; never across hospitals", async () => {
    const x = await world("flow-c");
    const y = await world("flow-c2");
    const { adm } = await admit(x);
    const { adm: other } = await admit(y);
    assert.equal((await clear(adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
    assert.equal((await clear(other.id, "MEDICALLY_FIT", y.doc.token)).status, 200);
    const jobs = t.app.get(DischargeFlowJobsService);

    await jobs.runDue(plus(60), [x.tenant.tenantId, y.tenant.tenantId]);
    assert.equal((await notes(x.nurse.token, "DISCHARGE_REMINDER")).length, 0, "nothing at 60 minutes");

    await jobs.runDue(plus(95), [x.tenant.tenantId, y.tenant.tenantId]);
    assert.ok((await notes(x.nurse.token, "DISCHARGE_REMINDER")).some((n) => n.entityId === adm.id), "the nurse is reminded at 90 minutes");
    assert.ok((await notes(x.cashier.token, "DISCHARGE_REMINDER")).some((n) => n.entityId === adm.id), "and the cashier, whose charges review is pending");
    assert.equal((await notes(x.manager.token, "DISCHARGE_ESCALATION")).length, 0, "the department head is not told yet");

    await jobs.runDue(plus(125), [x.tenant.tenantId, y.tenant.tenantId]);
    assert.ok((await notes(x.manager.token, "DISCHARGE_ESCALATION")).some((n) => n.entityId === adm.id), "the department head is told at 120 minutes");
    assert.equal((await notes(x.administrator.token, "DISCHARGE_ESCALATION")).length, 0, "the administrator is not told yet");

    await jobs.runDue(plus(155), [x.tenant.tenantId, y.tenant.tenantId]);
    assert.ok((await notes(x.administrator.token, "DISCHARGE_ESCALATION")).some((n) => n.entityId === adm.id), "then the administrator");

    // Each level goes out once, however often the job runs.
    const sent = await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id } });
    const again = await jobs.runDue(plus(160), [x.tenant.tenantId, y.tenant.tenantId]);
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id } }), sent, "a second run sends nothing new");
    assert.ok(again.reminders + again.departmentEscalations + again.administratorEscalations >= 0);
    assert.equal((await notes(x.nurse.token, "DISCHARGE_REMINDER")).filter((n) => n.entityId === adm.id).length, 1);
    await assert.rejects(() => t.prisma.$executeRaw`DELETE FROM "DischargeAlert" WHERE "admissionId" = ${adm.id}::uuid`, "the alert ledger is append-only");

    // The other hospital's people were told about their own patient only.
    assert.ok(!(await notes(y.manager.token, "DISCHARGE_ESCALATION")).some((n) => n.entityId === adm.id));
    assert.ok(!(await notes(x.manager.token, "DISCHARGE_ESCALATION")).some((n) => n.entityId === other.id));
  });

  it("4, 9, 10, 11, 13: the clock stops when the patient leaves; the bed turns around; the report shows average, before noon and causes", async () => {
    const x = await world("flow-d");
    const { adm } = await admit(x);
    await t.api("put", `/admissions/${adm.id}/discharge-plan`, x.doc.token).send({ expectedDate: iso(0) });
    assert.equal((await clear(adm.id, "MEDICALLY_FIT", x.doc.token)).status, 200);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.nurse.token).send({ stage: "NURSING", reason: "WAITING_FOR_TRANSPORT" })).status, 200);
    for (const [step, tok] of [["NURSING", x.nurse.token], ["CHARGES_REVIEWED", x.cashier.token], ["PHARMACY", x.pharm.token]] as const) assert.equal((await clear(adm.id, step, tok)).status, 200);
    await sign(x, adm.id);

    // 9. "Not ready yet" before the final bill; ready only when everything is cleared; the preview reads without posting anything.
    const pv = (await t.api("get", `/admissions/${adm.id}/discharge/bill-preview`, x.doc.token)).body.data;
    assert.equal(pv.finalBill, null);
    assert.equal(pv.waiting.kind, "FINAL");
    assert.equal(pv.finalBillReady, true);
    const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, x.cashier.token);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const inv = (await t.api("get", `/invoices/${fb.body.data.invoice.id}`, x.cashier.token)).body.data;
    assert.equal((await t.api("post", `/invoices/${inv.id}/payments`, x.cashier.token).set("Idempotency-Key", key()).send({ payments: [{ method: "UPI", amount: inv.total, reference: "UPI-FLOW-01" }] })).status, 201);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/complete`, x.doc.token).send({})).status, 200);

    // Discharge alone does not stop the clock: the patient has not left yet.
    let f = await flow(x.nurse.token, adm.id);
    assert.equal(f.clock.running, true);
    assert.ok(stage(f, "EXIT"));
    assert.equal((await t.api("get", "/discharge-flow/board", x.doc.token)).body.data.waiting.some((w: { admissionId: string }) => w.admissionId === adm.id), true, "still on the board until they leave");

    // 11. The patient leaves: the clock stops, the board drops them, the bed goes to cleaning and its turnaround is measured.
    const dep = await t.api("post", `/admissions/${adm.id}/discharge/departure`, x.nurse.token).send({ mode: "WALKED" });
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
    f = await flow(x.nurse.token, adm.id);
    assert.equal(f.clock.running, false);
    assert.ok(f.clock.stoppedAt);
    assert.equal(f.items.length, 0);
    assert.equal((await t.api("get", "/discharge-flow/board", x.doc.token)).body.data.waiting.some((w: { admissionId: string }) => w.admissionId === adm.id), false);
    const turn = await t.prisma.bedTurnover.findFirstOrThrow({ where: { admissionId: adm.id } });
    assert.ok(turn.vacatedAt, "the bed was vacated when the patient left");
    assert.equal(turn.readyAt, null);
    const bed = await t.prisma.bedTurnover.findFirstOrThrow({ where: { admissionId: adm.id }, include: { bed: true } });
    assert.equal(bed.bed.status, "CLEANING");

    // 13. The report: average time, share within the target, share before noon, and what caused delays.
    const rep = await t.api("get", "/reports/ipd/discharge-flow", x.doc.token).query({ from: iso(-1), to: iso(1) });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    const r = rep.body.data;
    assert.equal(r.stays, 1);
    assert.equal(typeof r.averageMinutes, "number");
    assert.equal(r.withinTargetPercent, 100);
    assert.ok([0, 100].includes(r.beforeNoonPercent), "before noon is 0 or 100 for one stay");
    assert.ok(r.delaysByReason.some((d: { code: string; count: number }) => d.code === "WAITING_FOR_TRANSPORT" && d.count === 1));
    assert.ok(r.delaysByDepartment.some((d: { stage: string }) => d.stage === "NURSING"));
    assert.equal((await t.api("get", "/reports/ipd/discharge-flow", x.pharm.token).query({ from: iso(0), to: iso(0) })).status, 403, "the pharmacist has no IPD report access");
    assert.equal((await t.api("get", "/reports/ipd/discharge-flow", x.doc.token).query({ from: iso(-400), to: iso(0) })).status, 400, "the range is limited");
  });

  it("5: the insurer's clock starts when the insurance desk sends the final bill; alerts at 60 and 120 minutes; it does not hide the ward's clock", async () => {
    const x = await world("flow-e");
    const { adm, patient } = await admit(x);
    const insurer = (await t.api("post", "/claims/insurers", x.officer.token).send({ name: `TPA ${uniqueWord(6)}`, kind: "TPA" })).body.data as { id: string };
    const policy = (await t.api("post", `/patients/${patient.id}/policies`, x.officer.token).send({ insurerId: insurer.id, policyNumber: `POL-${uniqueWord(6)}`, validFrom: iso(-30), validTo: iso(300), sumInsured: "500000" })).body.data as { id: string };
    const claim = (await t.api("post", "/claims", x.officer.token).send({ patientId: patient.id, policyId: policy.id, type: "CASHLESS", encounterId: adm.encounterId })).body.data as { id: string };
    assert.equal((await t.api("post", `/claims/${claim.id}/preauth`, x.officer.token).send({ requestedAmount: "50000" })).status, 200);
    assert.equal((await t.api("post", `/claims/${claim.id}/preauth-decision`, x.officer.token).send({ decision: "APPROVE", amount: "50000" })).status, 200);

    // No bill yet: the insurer's clock cannot start.
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/insurer-bill-sent`, x.officer.token).send({})).status, 409);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/insurer-bill-sent`, x.cashier.token).send({})).status, 403, "only the insurance desk");

    for (const [step, tok] of [["MEDICALLY_FIT", x.doc.token], ["NURSING", x.nurse.token], ["CHARGES_REVIEWED", x.cashier.token], ["PHARMACY", x.pharm.token]] as const) assert.equal((await clear(adm.id, step, tok)).status, 200);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge/waive`, x.doc.token).send({ step: "INSURANCE", reason: "Documents are with the insurer's desk already" })).status, 200);
    await sign(x, adm.id);
    const fb = await t.api("post", `/admissions/${adm.id}/discharge/final-invoice`, x.cashier.token);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));

    // The desk sends the bill (an hour ago, as the desk records it): the insurer's clock runs, separately from the ward's.
    const sent = await t.api("post", `/admissions/${adm.id}/discharge-flow/insurer-bill-sent`, x.officer.token).send({});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/insurer-bill-sent`, x.officer.token).send({})).status, 409, "once only");
    let f = await flow(x.officer.token, adm.id);
    assert.ok(f.insurer, "the insurer has a clock of its own");
    assert.ok(f.insurer.elapsedMinutes < 5, "the insurer's clock starts now");
    assert.equal(f.insurer.state, "ON_TIME");
    assert.equal(f.insurer.answeredAt, null);
    assert.equal(f.insurer.mine, true);
    assert.equal(f.insurer.targetMinutes, 120);
    // The insurer's wait is not counted on the ward's clock, and a reason can be given for it.
    assert.ok(f.clock.elapsedMinutes < 10, "the ward's clock is its own");
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.officer.token).send({ stage: "INSURER_PAYMENT", reason: "WAITING_FOR_INSURANCE" })).status, 200);

    // Alerts for the insurer: reminder to the desk at 60, to the head at 120, to the administrator after.
    const jobs = t.app.get(DischargeFlowJobsService);
    await jobs.runDue(plus(30), [x.tenant.tenantId]);
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER" } }), 0, "nothing at 30 minutes");
    await jobs.runDue(plus(65), [x.tenant.tenantId]);
    assert.ok((await notes(x.officer.token, "DISCHARGE_REMINDER")).some((n) => n.entityId === adm.id), "the insurance desk is reminded at 60 minutes");
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER", level: "REMINDER" } }), 1);
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER", level: "ESCALATION_DEPARTMENT" } }), 0);
    await jobs.runDue(plus(125), [x.tenant.tenantId]);
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER", level: "ESCALATION_DEPARTMENT" } }), 1, "the head, past 120 minutes");
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER", level: "ESCALATION_ADMINISTRATOR" } }), 0);
    await jobs.runDue(plus(185), [x.tenant.tenantId]);
    assert.equal(await t.prisma.dischargeAlert.count({ where: { admissionId: adm.id, clock: "INSURER", level: "ESCALATION_ADMINISTRATOR" } }), 1, "then the administrator");

    // The board lists the insurer separately; once the insurer answers the clock stops.
    const ib = (await t.api("get", "/discharge-flow/board", x.doc.token)).body.data.insurerWaiting;
    assert.ok(ib.some((w: { admissionId: string }) => w.admissionId === adm.id));
    const inv = fb.body.data.invoice.id as string;
    assert.equal((await t.api("post", `/claims/${claim.id}/submit`, x.officer.token).send({ invoiceId: inv, claimedAmount: "100.00" })).status, 200);
    assert.equal((await t.api("post", `/claims/${claim.id}/decision`, x.officer.token).send({ decision: "APPROVE", approvedAmount: "100.00" })).status, 200);
    f = await flow(x.officer.token, adm.id);
    assert.ok(f.insurer.answeredAt, "the insurer has answered: its clock stops");
    assert.equal((await t.api("get", "/discharge-flow/board", x.doc.token)).body.data.insurerWaiting.some((w: { admissionId: string }) => w.admissionId === adm.id), false);
    assert.equal((await t.api("post", `/admissions/${adm.id}/discharge-flow/delay`, x.officer.token).send({ stage: "INSURER_PAYMENT", reason: "WAITING_FOR_INSURANCE" })).status, 409, "nothing is waiting any more");
  });
});
