import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { endOfLocalDay, formatHm, localDateStr, localMinutes, localParts, parseHm, startOfLocalDay, zonedToUtc } from "./time";

const IST = "Asia/Kolkata";

describe("facility time helpers", () => {
  it("derives the facility-local calendar date across the UTC midnight boundary", () => {
    assert.equal(localDateStr(new Date("2026-03-10T18:29:59Z"), IST), "2026-03-10");
    assert.equal(localDateStr(new Date("2026-03-10T18:30:00Z"), IST), "2026-03-11");
  });

  it("returns weekday and wall-clock parts", () => {
    const p = localParts(new Date("2026-03-09T04:30:00Z"), IST); // Monday 10:00 IST
    assert.equal(p.weekday, 1);
    assert.equal(p.hour, 10);
    assert.equal(p.minute, 0);
    assert.equal(localMinutes(new Date("2026-03-09T04:30:00Z"), IST), 600);
  });

  it("converts local wall time to the right UTC instant", () => {
    assert.equal(zonedToUtc("2026-03-09", 600, IST).toISOString(), "2026-03-09T04:30:00.000Z");
    assert.equal(startOfLocalDay("2026-03-09", IST).toISOString(), "2026-03-08T18:30:00.000Z");
    assert.equal(endOfLocalDay("2026-03-09", IST).toISOString(), "2026-03-09T18:30:00.000Z");
  });

  it("handles zones with daylight saving time", () => {
    const ny = "America/New_York";
    assert.equal(zonedToUtc("2026-07-01", 540, ny).toISOString(), "2026-07-01T13:00:00.000Z");
    assert.equal(zonedToUtc("2026-01-15", 540, ny).toISOString(), "2026-01-15T14:00:00.000Z");
  });

  it("formats and parses HH:MM strictly", () => {
    assert.equal(formatHm(545), "09:05");
    assert.equal(parseHm("09:05"), 545);
    assert.equal(parseHm("24:00"), 1440);
    for (const bad of ["9:05", "25:00", "09:60", "", "ab:cd", "09:05:00"]) assert.equal(parseHm(bad), null, bad);
  });
});
