# Clinical-safety review brief

**Ask:** review the safety of the medication and clinical-record features and tell us what could harm a patient, how likely, and what to change. MedOS contains no decision support: it records what clinicians decide and warns on a few things; it does not recommend treatment (AI is out of scope for MLP-1).

## What exists today (verified in code and tests)

**Allergy matching** (`apps/api/src/modules/clinical/allergies.service.ts`, `findAllergyMatches`)
- Allergies are recorded per patient (allergen name, type, reaction, severity, status). An active allergy is matched against every prescribed and every *dispensed* item by name.
- Matching: names are normalised (Unicode NFKC, lower case, punctuation to spaces); an item matches an allergy when either name contains the other, minimum 3 characters. Deliberately generous (false alarms are accepted).
- It runs on generic name and brand name and matches **names only**: it does not know drug classes (a "penicillin" allergy does not flag "amoxicillin"), salts, or combination products unless the text contains the allergen string.
- Warnings are shown to the prescriber and again to the pharmacist, who must acknowledge them (`acknowledgeAllergyWarnings`) to dispense.

**Dose and frequency rules**
- Frequency is a fixed list (for example OD, BD, TDS, SOS) or `OTHER` with mandatory free text (database check constraint). Duration in days and total quantity are validated as positive numbers.
- **There is no dose-range check, maximum-daily-dose check, renal/hepatic/paediatric/pregnancy adjustment, duplicate-therapy check or drug-drug interaction check.** Dose is free text.

**Amendment workflow** (`consultations.service.ts`)
- A consultation is DRAFT until signed. A signed record cannot be edited; a correction is an *amendment* with a mandatory reason (10 to 500 characters), an expected-version check (stale amendments are refused), the previous version kept, and an audit event. Signed prescription items cannot be added to or silently changed (database triggers, tested).
- Prescriptions can be stopped with a reason; dispensing is recorded against the order item; medication administration (nursing) is recorded separately from the order and never inferred.

**Other safety-relevant behaviour**
- Expired batches are never dispensed; FEFO batch suggestion; stock cannot go negative under concurrency (tested).
- Administration statuses DUE, GIVEN, MISSED, HELD, REFUSED; overdue doses block discharge until recorded.

## Known gaps we want you to rule on

1. Is name-only allergy matching acceptable, or must class-level matching exist before any hospital uses it?
2. Which dose and interaction checks (if any) are mandatory for a hospital information system at this scale, and which can safely stay out?
3. Is "the pharmacist acknowledges the warning" a sufficient control, or should a documented override reason be required?
4. Amendment: is reason plus history enough? Should amending a *prescription* after dispensing alert the pharmacy and nursing?
5. Patient identification: duplicate detection never merges records automatically. Any wrong-patient hazards in the queue, prescription or dispensing screens?
6. Nursing: is the medication-chart workflow safe for high-alert medicines, and are overdue-dose alerts timely enough?
7. Downtime: what must clinicians do when the system is unavailable? (No downtime procedure exists yet.)

## How to inspect

- Tests: `apps/api/src/modules/clinical/clinical.spec.ts`, `pharmacy/pharmacy.spec.ts`, `nursing/nursing.spec.ts`, and the mandatory flows in `apps/api/src/e2e/` and `apps/web/e2e/`.
- Run the seeded staging app (synthetic data) and walk the OPD and IPD flows as doctor, nurse and pharmacist.

## Expected deliverable

A hazard log (hazard, cause, harm, severity, existing control, residual risk, required action), the list of changes required before go-live, and the scope you did not cover.
