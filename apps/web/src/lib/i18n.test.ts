import { test } from "node:test";
import assert from "node:assert/strict";
import { BN } from "./locales/bn";
import { HI } from "./locales/hi";
import { localeFor, translate } from "./i18n";

test("English is the key: English returns the text unchanged, and unknown text falls back to English", () => {
  assert.equal(translate("en", "Save"), "Save");
  assert.equal(translate("bn", "A sentence nobody translated yet"), "A sentence nobody translated yet");
  assert.equal(translate("hi", "A sentence nobody translated yet"), "A sentence nobody translated yet");
});

test("Bengali and Hindi translate the core hospital vocabulary", () => {
  assert.equal(translate("bn", "Patients"), "রোগী");
  assert.equal(translate("hi", "Patients"), "मरीज़");
  assert.equal(translate("bn", "Discharge"), "ডিসচার্জ");
  assert.equal(translate("hi", "Prescription"), "पर्ची");
  assert.equal(translate("bn", "waiting"), "অপেক্ষায়", "status words are translated in lower case");
  assert.equal(translate("hi", "  Save  "), "सहेजें", "surrounding spaces are ignored");
});

test("both dictionaries cover the same strings, with no empty values and no stray placeholders", () => {
  const bn = new Set(Object.keys(BN));
  const hi = new Set(Object.keys(HI));
  assert.deepEqual([...bn].filter((k) => !hi.has(k)), [], "in Bengali but not Hindi");
  assert.deepEqual([...hi].filter((k) => !bn.has(k)), [], "in Hindi but not Bengali");
  for (const d of [BN, HI]) for (const [k, v] of Object.entries(d)) { assert.ok(v.trim().length > 0, `empty translation for ${k}`); assert.ok(!/[{}]/.test(v), `placeholder left in ${k}`); }
  assert.ok(bn.size > 500);
});

test("dates and money use the chosen language but always Latin digits, so amounts are never ambiguous", () => {
  for (const l of ["en", "bn", "hi"] as const) {
    assert.match(localeFor(l), /-u-nu-latn$/);
    assert.match(new Intl.NumberFormat(localeFor(l), { style: "currency", currency: "INR" }).format(1234.5), /1,234\.50/);
  }
});
test("labels are translated but data is shown exactly as entered", () => {
  // Interface words
  assert.equal(translate("bn", "Video consultations"), "ভিডিও পরামর্শ");
  assert.equal(translate("hi", "Advance payments"), "अग्रिम भुगतान");
  assert.equal(translate("bn", "pharmacy"), translate("bn", "Pharmacy"), "a lower-case badge finds the Capitalised entry");
  // Data: names, MRNs, bed codes, invoice numbers, free text are not in any dictionary, so they come back untouched
  for (const data of ["Rina Mukherjee", "DEMO-000061", "G1", "INV-2026-000008", "Paracetamol 500 mg", "Fever for 3 days"]) {
    for (const l of ["bn", "hi"] as const) assert.equal(translate(l, data), data, `${data} must not be translated`);
  }
});
