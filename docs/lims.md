# Laboratory (LIMS)

## Purpose
Runs the in-house laboratory: which tests exist and what they measure, taking samples, typing in results, pathologist verification, critical values, and the printed report. It sits on top of the existing test orders: a doctor advises a laboratory test, the cashier bills it, and only then does it reach the lab.

## Workflow
1. The pathologist sets up a test (Laboratory → Tests and ranges): specimen, turnaround and what is measured, with normal ranges (separate for men and women where needed) and critical limits. A test with no set-up still works as one typed result.
2. A billed laboratory test appears on the work list as "Waiting for sample". The technician (or a nurse at the ward) takes the sample. It gets an accession number (`LAB-{YEAR}-{SEQ}`) and a printable tube label. One live sample per test.
3. A rejected sample (with a reason) sends the test back to waiting; the next sample gets a new number.
4. The technician types the values and saves a draft. Two people saving at once cannot overwrite each other (version token).
5. The pathologist verifies. Every value is flagged against the range for that patient (normal, low, high, critical low, critical high). The report keeps the ranges as they were on the day.
6. A critical value alerts the doctor of the visit. It stays on the critical list until that doctor acknowledges it.
7. A verified report is never overwritten. The pathologist can amend it with a reason (5+ characters); every version is kept and the report prints as "AMENDED REPORT".

## Permissions
`LAB_READ`, `LAB_COLLECT`, `LAB_RESULT`, `LAB_VERIFY`, `LAB_MASTERS`. Roles: `LAB_TECHNICIAN` (read, collect, result), `PATHOLOGIST` (read, result, verify, masters). Doctors, nurses, managers and administrators get the read (and, for nurses, collect) permissions they need.

## Audit events
`LAB_TEST_CREATED`, `LAB_TEST_UPDATED`, `LAB_SAMPLE_COLLECTED`, `LAB_SAMPLE_REJECTED`, `LAB_RESULT_VERIFIED`, `LAB_RESULT_AMENDED`, `LAB_CRITICAL_RESULT`, `LAB_CRITICAL_ACKNOWLEDGED`, `DOCUMENT_PRINTED` (reports and labels).

## Database rules
Report versions are append-only and must follow one another without gaps; an amendment needs a reason. A result only moves forward and one version at a time. Samples and results cannot be deleted; a sample can only be rejected. A sample belongs to a billed laboratory test of the same patient. Test set-ups only exist for laboratory services.

## API
`GET/PUT /lab/tests`, `GET /lab/worklist`, `POST /lab/orders/:id/sample`, `POST /lab/samples/:id/reject`, `GET /lab/orders/:id/result`, `PUT /lab/results/:id/draft`, `POST /lab/results/:id/verify|amend|acknowledge`, `GET /lab/critical`, `GET /encounters/:id/lab-results`, `GET /print/lab-reports/:testOrderId`, `GET /print/lab-labels/:sampleId`.

## Known limitations
No analyser/instrument interface, no external-lab referral, no reagent stock, no result trends over time. Tests with several samples (for example culture and sensitivity) are one sample per test order for now.
