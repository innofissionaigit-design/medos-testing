# Patient merge (link design)

For the same person registered twice. Patient page → **Merge duplicate…** (permission `PATIENT_MERGE`, Administrator).

## Why a link and not a move

The database refuses, by design, to change the patient on a visit, invoice, allergy, vitals reading, diagnosis, note or prescription (triggers `*_guard`). Moving a duplicate's records onto the real patient would mean weakening those guards, which breaks the clinical and financial history rules (CLAUDE.md §9, §14, §18). So nothing moves:

- The duplicate keeps every record it has, its own MRN, and becomes `INACTIVE` with `mergedIntoId`, `mergedAt`, `mergedById`, `mergeReason`.
- The real patient's chart **reads both**: `chartPatientIds()` / `linkedPatientIds()` (`modules/patients/patient-links.ts`) give the ids whose records make up one chart.
- Merging is a one-way door: a database trigger refuses clearing the link. There is no undo.

## What the real patient's chart includes

Allergies (including the prescribing allergy check, the printed prescription and the nursing ward flag), diagnoses, vitals, visits, appointments, bills, admissions, dispenses, files, and reminder consent (the newest decision across the patient and its duplicates wins, so a withdrawal on the duplicate still stops reminders).

## Rules

- Duplicate and target in the same hospital; both `ACTIVE`; neither already merged; a patient is never merged into one that is itself merged. Merging a patient that already has duplicates linked re-points them, so a link is always one step.
- Blocked (`PATIENT_MERGE_BLOCKED`, with counts) while the duplicate has an admission, an open visit, an upcoming appointment or a queue entry: finish or cancel those first.
- `version` of the duplicate must match (`STALE_VERSION`); a reason of 5+ characters is required.
- Both rows are locked in id order, so two merges on the same pair cannot deadlock; exactly one wins.
- A merged duplicate cannot be edited and gets no new allergies, files, consents, visits, bills or admissions (`PATIENT_MERGED`, with the real patient's id). It is not offered in search; searching its old MRN finds the real patient. Its old records can still be corrected on the record they belong to.

## API and audit

`POST /api/v1/patients/:duplicateId/merge` `{ intoPatientId, version, reason }`. Patient responses carry `mergedInto` (on a duplicate) and `mergedFrom` (on the real patient). Audit: `PATIENT_MERGED` with both MRNs and the reason; no demographics or clinical content.

## Known limitations

Reports that count by patient id (for example "daily OPD count") count a duplicate and the real patient separately; nothing is double-counted because nothing moved. Duplicates are not shown side by side before merging; the person merging searches for the real patient. Later merging more than two records is done pair by pair. Tests: `merge.spec.ts`.
