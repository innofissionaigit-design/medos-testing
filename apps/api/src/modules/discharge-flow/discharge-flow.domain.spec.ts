import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clockState, currentReasons, leftBeforeNoon, levelsReached, localHour, minutesBetween, summariseTurnaround } from "./discharge-flow.domain";

const ward = { reminderMinutes: 90, targetMinutes: 120 };
const insurer = { reminderMinutes: 60, targetMinutes: 120 };

describe("discharge flow clocks", () => {
  it("counts whole minutes and never goes negative", () => {
    assert.equal(minutesBetween(new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T11:30:59Z")), 90);
    assert.equal(minutesBetween(new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T09:00:00Z")), 0);
  });
  it("ward clock: on time, reminder at 90, overdue at 120", () => {
    assert.equal(clockState(89, ward), "ON_TIME");
    assert.equal(clockState(90, ward), "REMINDER_DUE");
    assert.equal(clockState(119, ward), "REMINDER_DUE");
    assert.equal(clockState(120, ward), "OVERDUE");
  });
  it("ward levels: reminder 90, department head 120, administrator 150", () => {
    assert.deepEqual(levelsReached(89, ward), []);
    assert.deepEqual(levelsReached(90, ward), ["REMINDER"]);
    assert.deepEqual(levelsReached(120, ward), ["REMINDER", "ESCALATION_DEPARTMENT"]);
    assert.deepEqual(levelsReached(149, ward), ["REMINDER", "ESCALATION_DEPARTMENT"]);
    assert.deepEqual(levelsReached(150, ward), ["REMINDER", "ESCALATION_DEPARTMENT", "ESCALATION_ADMINISTRATOR"]);
  });
  it("insurer levels: reminder 60, insurance desk head 120, administrator 180", () => {
    assert.deepEqual(levelsReached(59, insurer), []);
    assert.deepEqual(levelsReached(60, insurer), ["REMINDER"]);
    assert.deepEqual(levelsReached(120, insurer), ["REMINDER", "ESCALATION_DEPARTMENT"]);
    assert.deepEqual(levelsReached(180, insurer), ["REMINDER", "ESCALATION_DEPARTMENT", "ESCALATION_ADMINISTRATOR"]);
  });
  it("a reminder set at or above the target is pulled below it", () => {
    assert.equal(clockState(119, { reminderMinutes: 200, targetMinutes: 120 }), "REMINDER_DUE");
  });
});

describe("discharge flow management figures", () => {
  it("decides before noon in the hospital's own timezone", () => {
    // 05:30 UTC is 11:00 in India; 06:30 UTC is 12:00.
    assert.equal(localHour(new Date("2026-03-01T05:30:00Z"), "Asia/Kolkata"), 11);
    assert.equal(leftBeforeNoon(new Date("2026-03-01T05:30:00Z"), "Asia/Kolkata"), true);
    assert.equal(leftBeforeNoon(new Date("2026-03-01T06:30:00Z"), "Asia/Kolkata"), false);
    assert.equal(localHour(new Date("2026-03-01T18:30:00Z"), "Asia/Kolkata"), 0);
  });
  it("summarises average, share inside target and share before noon", () => {
    const s = summariseTurnaround([{ minutes: 60, beforeNoon: true }, { minutes: 120, beforeNoon: false }, { minutes: 300, beforeNoon: false }, { minutes: 20, beforeNoon: true }], 120);
    assert.equal(s.stays, 4);
    assert.equal(s.averageMinutes, 125);
    assert.equal(s.withinTarget, 3);
    assert.equal(s.withinTargetPercent, 75);
    assert.equal(s.beforeNoonPercent, 50);
  });
  it("has no figures for no stays", () => {
    const s = summariseTurnaround([], 120);
    assert.equal(s.averageMinutes, null);
    assert.equal(s.beforeNoonPercent, null);
  });
  it("the newest reason for a stage stands", () => {
    const m = currentReasons([
      { stage: "BILLING", reason: "FAMILY_ARRANGING_MONEY", at: new Date("2026-01-01T10:00:00Z") },
      { stage: "BILLING", reason: "WAITING_FOR_INSURANCE", at: new Date("2026-01-01T11:00:00Z") },
      { stage: "NURSING", reason: "OTHER", at: new Date("2026-01-01T09:00:00Z") },
    ]);
    assert.equal(m.get("BILLING")?.reason, "WAITING_FOR_INSURANCE");
    assert.equal(m.size, 2);
  });
});
