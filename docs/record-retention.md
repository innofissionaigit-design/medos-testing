# Medical-record retention

## Purpose
A hospital keeps medical records for a set number of years and then decides what happens to them. MedOS tells the Medical Records Department (MRD) which finished visits have passed their retention period and records the decision made about each. **MedOS never deletes a record.** A decision to clear a record for archive is the hospital's authority to archive or destroy it under its own policy, outside MedOS.

## Rules
- **Retention period** (Settings, per facility): `MR_RETENTION_YEARS_OPD` (default 3 years, for a finished OPD visit) and `MR_RETENTION_YEARS_IPD` (default 5 years, for an admission), counted from the end of the visit. 1 to 100 years. **The defaults are a starting point, not legal advice**: check your state's rules and take legal advice, then set the hospital's own policy.
- **Children**: with `MR_RETENTION_MINORS_UNTIL_ADULT` on (default), the period of a child's record runs from their 18th birthday if that is later. This uses the date of birth on the patient record; a patient with no date of birth is treated as an adult.
- A visit is **due** once its period is over and no decision stands.

## Decisions
MRD records one of two decisions on a finished visit, with a reason (5 to 300 characters):
- **Hold** (keep longer): for a legal case, a complaint, research. With an end date (today or later), or without one (until a later decision). A hold can be placed on any finished visit. When a hold with an end date passes, the visit becomes due again.
- **Clear for archive**: allowed only once the retention period is over. It also ends a hold that had no end date. A record already cleared cannot be cleared again.

Each decision is kept with who and when, never edited or removed (checked by the database). The latest decision stands. The visit and its clinical record are not touched.

## Screen
**Post-discharge → Records past their retention period** (MRD and administrators): counts of due, held and cleared records, a search by name, MRN or visit number, and a Decide action on each row.

## Permissions
`MRD_RETENTION`: Medical Records and Administrator.

## Audit events
`RECORD_RETENTION_HOLD`, `RECORD_RETENTION_CLEARED`.

## API
`GET /records/retention?show=DUE|HELD|CLEARED|ALL&q=&page=&pageSize=` and `POST /records/retention/:encounterId/review` (`{ decision: HOLD|CLEAR_FOR_ARCHIVE, retainUntil?, note }`). Always for the signed-in user's own facility.

## Known limitations
The decision is recorded; MedOS does not export, archive or destroy anything. One period per visit type (not per department or diagnosis), and no special rules for medico-legal cases beyond a hold. Tests: `discharge/discharge.spec.ts` ("medical-record retention").
