import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDoctor, registerPatient, startApp, startVisit, type TestApp, type TestDoctor, type TestTenant } from "../../test/harness";

interface Entry { id: string; status: string; tokenDate: string }

/** A doctor can have only one open consultation. One left open on an earlier day used to be invisible in today's queue yet still blocked every start. */
describe("a consultation left open on an earlier day", () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;
  let rec: { id: string; token: string };
  let d1: TestDoctor;
  let d2: TestDoctor;
  // A queue entry's date cannot be changed (the database forbids it), so "an earlier day" is made by moving the facility's clock: 25 hours apart means the date always differs.
  const BEHIND = "Pacific/Pago_Pago";
  const AHEAD = "Pacific/Kiritimati";
  const zone = (tz: string) => t.prisma.facility.update({ where: { id: a.facilityId }, data: { timezone: tz } });
  const list = async (tok: string) => (await t.api("get", "/queue", tok)).body.data as Entry[];

  after(async () => { await zone("Asia/Kolkata"); });

  before(async () => {
    t = await startApp();
    a = await t.makeTenant("qed-a");
    b = await t.makeTenant("qed-b");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
    d1 = await makeDoctor(t, a);
    d2 = await makeDoctor(t, a);
  });
  after(async () => { await t.close(); });

  it("shows in the doctor's queue with its date, blocks starting another patient, and finishing it unblocks", async () => {
    await zone(BEHIND);
    const old = await startVisit(t, rec.token, d1, (await registerPatient(t, rec.token)).id);
    assert.equal((await t.api("post", `/queue/${old.queueId}/start`, d1.token)).status, 200);
    // That visit was started on an earlier day and never finished; today is a later date.
    await zone(AHEAD);
    const next = await startVisit(t, rec.token, d1, (await registerPatient(t, rec.token)).id);

    const blocked = await t.api("post", `/queue/${next.queueId}/start`, d1.token);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /already in consultation/);

    const mine = await list(d1.token);
    const stale = mine.find((e) => e.id === old.queueId);
    assert.ok(stale, "the open consultation from yesterday is listed, so the doctor can see what blocks them");
    assert.equal(stale.status, "IN_CONSULTATION");
    assert.ok(stale.tokenDate < (await t.api("get", "/queue", d1.token)).body.data.find((e: Entry) => e.id === next.queueId).tokenDate, "it carries an earlier date than today's patient");
    assert.ok(mine.some((e) => e.id === next.queueId), "and today's patient too");

    const done = await t.api("post", `/queue/${old.queueId}/complete`, d1.token);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await list(d1.token)).some((e) => e.id === old.queueId), false, "finished, so it is gone");
    assert.equal((await t.api("post", `/queue/${next.queueId}/start`, d1.token)).status, 200, "the doctor can start the next patient");
  });

  it("only earlier consultations that are still open are listed (not old waiting or finished ones), and only to those who may see them", async () => {
    await zone(BEHIND);
    const waiting = await startVisit(t, rec.token, d2, (await registerPatient(t, rec.token)).id);
    const open = await startVisit(t, rec.token, d2, (await registerPatient(t, rec.token)).id);
    assert.equal((await t.api("post", `/queue/${open.queueId}/start`, d2.token)).status, 200);
    await zone(AHEAD);
    const ids = (await list(rec.token)).map((e) => e.id);
    assert.ok(ids.includes(open.queueId), "an open consultation from yesterday is shown to the desk");
    assert.equal(ids.includes(waiting.queueId), false, "a patient who just waited yesterday is not");
    assert.equal((await list(d1.token)).some((e) => e.id === open.queueId), false, "another doctor does not see it");
    const bAdmin = await list(b.admin.token);
    assert.equal(bAdmin.some((e) => e.id === open.queueId), false, "another hospital does not see it");
  });
});
