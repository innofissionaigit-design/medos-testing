import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ageYears, compareSeverity, currentAge, normalizeMobile, normalizeName, scoreDuplicate } from "./patient.domain";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("patient domain rules", () => {
  it("normalises names: case, punctuation, titles, spacing, unicode", () => {
    assert.equal(normalizeName("  Dr.  Anirban ", "SEN "), "anirban sen");
    assert.equal(normalizeName("Mrs", "Rina  Das"), "rina das");
    assert.equal(normalizeName("O'Neil-Smith", null), "o neil smith");
    assert.equal(normalizeName("মিতা", "দাস"), "মিতা দাস");
    assert.equal(normalizeName("Dr", ""), "dr", "a lone title is kept so the name is never empty");
  });

  it("normalises Indian mobile notations and rejects invalid numbers", () => {
    for (const ok of ["9830012345", "+91 98300 12345", "919830012345", "09830012345", "98300-12345", "(98300) 12345"]) {
      assert.equal(normalizeMobile(ok), "9830012345", ok);
    }
    for (const bad of ["1234567890", "98300123", "98300123456789", "abcdefghij", "", "5830012345", "+1 415 555 0100"]) {
      assert.equal(normalizeMobile(bad), null, bad);
    }
  });

  it("computes age on birthdays correctly (boundary and leap day)", () => {
    assert.equal(ageYears(d("2000-06-15"), d("2026-06-14")), 25);
    assert.equal(ageYears(d("2000-06-15"), d("2026-06-15")), 26);
    assert.equal(ageYears(d("2004-02-29"), d("2026-02-28")), 21);
    assert.equal(ageYears(d("2004-02-29"), d("2026-03-01")), 22);
    assert.equal(ageYears(d("2026-06-15"), d("2026-06-14")), 0, "never negative");
  });

  it("estimated ages advance with time since they were recorded", () => {
    const age = currentAge({ dateOfBirth: null, estimatedAgeYears: 40, ageRecordedOn: d("2024-01-01") }, d("2026-06-01"));
    assert.deepEqual(age, { years: 42, estimated: true });
    assert.deepEqual(currentAge({ dateOfBirth: d("2000-01-01"), estimatedAgeYears: null, ageRecordedOn: null }, d("2026-06-01")), { years: 26, estimated: false });
  });

  const probe = (o: Partial<Parameters<typeof scoreDuplicate>[0]> = {}) => ({
    mobile: "9830012345", gender: "FEMALE", dateOfBirth: d("1990-04-02"), age: { years: 36, estimated: false }, ...o,
  });
  const row = (o: Partial<Parameters<typeof scoreDuplicate>[1]> = {}) => ({
    mobile: "9830012345", gender: "FEMALE", dateOfBirth: d("1990-04-02"), age: { years: 36, estimated: false }, similarity: 0.9, ...o,
  });

  it("scores mobile + similar name as HIGH", () => {
    const r = scoreDuplicate(probe(), row({ dateOfBirth: null, age: { years: 50, estimated: true } }));
    assert.equal(r?.severity, "HIGH");
    assert.ok(r?.reasons.includes("MOBILE_AND_NAME"));
  });

  it("scores same mobile with a different name as LOW (families share phones)", () => {
    const r = scoreDuplicate(probe(), row({ similarity: 0.05, dateOfBirth: d("1960-01-01"), age: { years: 66, estimated: false } }));
    assert.equal(r?.severity, "LOW");
    assert.deepEqual(r?.reasons, ["SAME_MOBILE"]);
  });

  it("scores similar name + identical DOB as HIGH, even with a different mobile", () => {
    const r = scoreDuplicate(probe(), row({ mobile: "9000000000", similarity: 0.8 }));
    assert.equal(r?.severity, "HIGH");
    assert.deepEqual(r?.reasons, ["NAME_AND_DOB"]);
  });

  it("scores similar name + approximate age + compatible gender as MEDIUM, but not across genders or far ages", () => {
    const est = probe({ mobile: null, dateOfBirth: null, age: { years: 40, estimated: true } });
    assert.equal(scoreDuplicate(est, row({ mobile: "9000000000", dateOfBirth: d("1985-01-01"), age: { years: 41, estimated: false }, similarity: 0.8 }))?.severity, "MEDIUM");
    assert.equal(scoreDuplicate(est, row({ mobile: "9000000000", gender: "MALE", dateOfBirth: d("1985-01-01"), age: { years: 41, estimated: false }, similarity: 0.8 })), null);
    assert.equal(scoreDuplicate(est, row({ mobile: "9000000000", dateOfBirth: d("1960-01-01"), age: { years: 66, estimated: false }, similarity: 0.8 })), null);
  });

  it("does not flag different people with different DOBs, mobiles and names", () => {
    assert.equal(scoreDuplicate(probe(), row({ mobile: "9111111111", dateOfBirth: d("1975-05-05"), age: { years: 51, estimated: false }, similarity: 0.2 })), null);
    assert.equal(scoreDuplicate(probe({ mobile: null }), row({ mobile: null, dateOfBirth: d("1990-04-03"), similarity: 0.95 })), null, "exact name alone with a different DOB is not enough");
  });

  it("sorts severities HIGH, then MEDIUM, then LOW (comparator: negative = first argument first)", () => {
    assert.ok(compareSeverity("HIGH", "LOW") < 0);
    assert.ok(compareSeverity("LOW", "MEDIUM") > 0);
    assert.equal(compareSeverity("HIGH", "HIGH"), 0);
  });
});
