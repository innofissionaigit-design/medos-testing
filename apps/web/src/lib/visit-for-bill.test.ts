import { test } from "node:test";
import assert from "node:assert/strict";
import { visitForBill, type BillableVisit } from "./visit-for-bill";

const TZ = "Asia/Kolkata";
const v = (id: string, over: Partial<BillableVisit> = {}): BillableVisit => ({ id, encounterNumber: `OPD-${id}`, type: "OPD", status: "ACTIVE", startedAt: "2026-11-07T06:19:00.000Z", practitionerName: "Dr. A", ...over });

test("a visit that started today is the one the bill goes to", () => {
  assert.equal(visitForBill([v("1")], "2026-11-07", TZ)?.id, "1");
});

test("a visit the doctor has already finished still counts (the Cashier often bills afterwards)", () => {
  assert.equal(visitForBill([v("1", { status: "COMPLETED" })], "2026-11-07", TZ)?.id, "1");
});

test("no visit today means no link: the bill stays a stand-alone bill", () => {
  assert.equal(visitForBill([], "2026-11-07", TZ), null);
  assert.equal(visitForBill([v("1", { startedAt: "2026-11-06T06:00:00.000Z" })], "2026-11-07", TZ), null, "yesterday's visit");
});

test("a cancelled visit and an in-patient stay are never chosen", () => {
  assert.equal(visitForBill([v("1", { status: "CANCELLED" })], "2026-11-07", TZ), null);
  assert.equal(visitForBill([v("1", { type: "IPD" })], "2026-11-07", TZ), null);
});

test("with several visits today the most recent one is chosen, whatever order they arrive in", () => {
  const early = v("early", { startedAt: "2026-11-07T04:00:00.000Z" });
  const late = v("late", { startedAt: "2026-11-07T09:30:00.000Z" });
  assert.equal(visitForBill([early, late], "2026-11-07", TZ)?.id, "late");
  assert.equal(visitForBill([late, early], "2026-11-07", TZ)?.id, "late");
});

test("'today' follows the hospital's time zone, not UTC", () => {
  // 00:30 on 7 Nov in India is still 6 Nov in UTC.
  const justAfterMidnight = v("1", { startedAt: "2026-11-06T19:00:00.000Z" });
  assert.equal(visitForBill([justAfterMidnight], "2026-11-07", TZ)?.id, "1");
  assert.equal(visitForBill([justAfterMidnight], "2026-11-06", TZ), null);
  assert.equal(visitForBill([justAfterMidnight], "2026-11-06", "UTC")?.id, "1");
});
