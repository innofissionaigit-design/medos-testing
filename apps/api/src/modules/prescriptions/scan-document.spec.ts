import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePrescriptionDocument, testKind } from "./scan-document";

const SAMPLE = `Name: Ramesh Kumar Das   Age: 45   Sex: M
Date: 31/10/2026
Dx: Type 2 diabetes mellitus, Hypertension
Rx
1) Tab Metformin 500mg 1-0-1 x 30 days
2) Tab Amlodipine 5mg 0-0-1
Inv: CBC, HbA1c, Urine R/E
X-ray chest PA
Advice: Walk 30 minutes daily. Avoid sugar and sweets
Diet: Low salt, low sugar diet
Refer: Dr. Sen, Cardiology
F/U after 2 weeks`;

describe("reading the parts of a prescription from OCR text", () => {
  const d = parsePrescriptionDocument(SAMPLE);

  it("reads who the paper says it is for", () => {
    assert.deepEqual(d.patient, { name: "Ramesh Kumar Das", age: 45, gender: "MALE" });
  });

  it("reads the diagnosis, one item each", () => {
    assert.deepEqual(d.diagnoses, ["Type 2 diabetes mellitus", "Hypertension"]);
  });

  it("reads the tests under the heading and the well-known ones named elsewhere, with their kind", () => {
    assert.deepEqual(d.tests.map((t) => [t.text, t.category]), [["CBC", "LABORATORY"], ["HbA1c", "LABORATORY"], ["Urine R/E", "LABORATORY"], ["X-ray chest PA", "RADIOLOGY"]]);
  });

  it("reads advice, diet, referral and follow-up, and leaves the medicines to the medicine reader", () => {
    assert.deepEqual(d.advice, ["Walk 30 minutes daily", "Avoid sugar and sweets"]);
    assert.deepEqual(d.diet, ["Low salt, low sugar diet"]);
    assert.equal(d.referral, "Dr. Sen, Cardiology");
    assert.equal(d.followUpDays, 14);
    assert.equal(JSON.stringify(d).includes("Metformin"), false, "medicine lines are not diagnoses, tests or advice");
  });

  it("copes with sections written across lines, a different order, and abbreviations", () => {
    const x = parsePrescriptionDocument("Diagnosis:\n- Viral fever\n- Acute pharyngitis\n\nTests advised:\n1. CBC\n2. ESR\n\nInstructions\nTake rest\nDrink plenty of fluids\n\nReview in 5 days\n32 yrs / F");
    assert.deepEqual(x.diagnoses, ["Viral fever", "Acute pharyngitis"]);
    assert.deepEqual(x.tests.map((t) => t.text), ["CBC", "ESR"]);
    assert.deepEqual(x.advice, ["Take rest", "Drink plenty of fluids"]);
    assert.equal(x.followUpDays, 5);
    assert.deepEqual(x.patient, { age: 32, gender: "FEMALE" });
  });

  it("gives nothing for text with nothing to read, and never throws on odd input", () => {
    for (const t of ["", "   \n\n", "random words with no structure", "Dx:", "Inv: , , ;", "Name:", "Age: 999", "\u0000\u0001 ??? ###"]) {
      const x = parsePrescriptionDocument(t);
      assert.ok(Array.isArray(x.diagnoses) && Array.isArray(x.tests) && Array.isArray(x.advice), JSON.stringify(t));
    }
    const none = parsePrescriptionDocument("random words with no structure");
    assert.deepEqual([none.diagnoses, none.tests, none.advice, none.diet], [[], [], [], []]);
    assert.equal(parsePrescriptionDocument("Age: 999").patient.age, undefined, "an impossible age is ignored");
  });

  it("does not read ordinary words as tests, and limits what it returns", () => {
    assert.deepEqual(parsePrescriptionDocument("Come back for a ct of tea\nct scan not needed").tests.map((t) => t.text), [], "lower-case ct is a word, not a scan");
    const many = parsePrescriptionDocument("Inv: " + Array.from({ length: 50 }, (_, i) => `Test number ${i}`).join(", "));
    assert.equal(many.tests.length, 20);
  });

  it("tells imaging, heart tests, procedures and laboratory tests apart", () => {
    assert.equal(testKind("Chest X-ray PA view"), "RADIOLOGY");
    assert.equal(testKind("USG abdomen"), "RADIOLOGY");
    assert.equal(testKind("ECG"), "CARDIOLOGY");
    assert.equal(testKind("2D Echo"), "CARDIOLOGY");
    assert.equal(testKind("Upper GI endoscopy"), "PROCEDURE");
    assert.equal(testKind("Complete blood count"), "LABORATORY");
  });
});
