# Patient numbers beyond the MRN

## Purpose
A patient is one record with one MRN, but is also known by other numbers: the number from the hospital's previous system, an insurance or scheme card, and later their ABHA number. These are kept in a separate list (the `PatientIdentifier` table), not as columns on the patient, so new kinds can be added without changing the patient record. Search finds a patient by any of them.

## Kinds
| Kind | Who creates it | Shown as |
|---|---|---|
| `MRN` | the system, when the patient is registered (see `docs/numbering.md`); exactly one per patient; never edited or removed | Patient ID (MRN) |
| `LEGACY` | staff, or a data import (`docs/import.md`) | Old hospital number |
| `EXTERNAL` | staff; needs the issuer (for example the insurer or scheme) | Other ID |
| `ABHA` | the ABDM screen (`docs/abdm.md`), not here | ABHA |

**Aadhaar numbers are not stored** (an issuer that names Aadhaar or UIDAI is refused).

## On the screen
Patient page → **Patient numbers**. It lists the MRN and the other numbers (and those carried over from a merged duplicate, marked "from merged record …"). With `PATIENT_UPDATE` a person can **add** a number (kind, issued by, number) or **remove** one (a reason is required). A merged duplicate cannot be given new numbers.

## Rules
- Values are tidied: capital letters, single spaces, 2 to 40 characters of letters, digits, space and `. / _ -`. `wb  12/ab` and `WB 12/AB` are the same number.
- **A number belongs to one patient at a time** within the hospital (per kind). Adding one that is already in use is refused with the other patient's MRN (when the person may see it), because it often means the two records are the same person: check, and merge if so (`docs/patient-merge.md`). Another hospital may use the same text. Two people adding the same number to different patients at the same moment: exactly one succeeds (enforced by the database).
- **A number is never edited and never deleted.** One entered wrongly is *removed*: it is kept in the table with who removed it, when and why, no longer appears in lists or search, and the same text may then be recorded on the right patient. A removed number is final. The database refuses edits to a value or issuer, deleting a row, retiring an MRN, a removal without who and why, and changes to a removed row.
- When a duplicate is merged, its numbers still lead to the real patient: the real patient's list shows them and searching an old number finds the real patient.
- Reads need `PATIENT_READ`; adding and removing need `PATIENT_UPDATE`. A person restricted to certain departments only reaches the patients their scope allows, and does not see another patient's MRN in a clash message. Another hospital's patients and numbers are "not found".

## Audit
`PATIENT_IDENTIFIER_ADDED` (kind and issuer) and `PATIENT_IDENTIFIER_REMOVED` (kind and reason). The number itself is not written to the audit trail.

## API
`GET /patients/:id/identifiers`, `POST /patients/:id/identifiers` (`type` `LEGACY` or `EXTERNAL`, `value`, `issuer`), `POST /patients/:id/identifiers/:identifierId/remove` (`reason`). Migration `20261104170000_patient_identifier_retire` adds `createdById`, `removedAt`, `removedById`, `removalReason`, turns the old "unique value" rule into "unique among numbers not removed", and adds the database rules above.

## Known limitations
The registration form does not ask for an old hospital number or card (add it afterwards, or import it). There is no edit: correct a number by removing and adding. Scheme and insurer numbers are not validated against the insurer's format. Numbers carried over from a merged duplicate cannot be removed from the real patient's list (the duplicate stays as it was).

Tests: `modules/patients/patient-identifiers.spec.ts`, `modules/patients/patients.spec.ts` (search), `modules/patients/merge.spec.ts`.
